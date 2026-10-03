from datetime import timedelta

from fastapi import APIRouter, Depends, HTTPException, Request
from fastapi.responses import FileResponse
from pydantic import BaseModel, Field
from sqlalchemy import func, select
from sqlalchemy.orm import Session

from ..config import get_settings
from ..database import get_db, utcnow
from ..models import File, Folder, SystemLog, UploadTask, User
from ..security import admin_user, hash_password
from ..services import backup_service, log_service
from ..services.storage_service import storage_or_none
from ..services.telegram_service import category_for
from .auth import client_ip, serialize_user

router = APIRouter(prefix='/api/admin', tags=['admin'])


class UserIn(BaseModel):
    username: str = Field(min_length=2, max_length=64, pattern=r'^[A-Za-z0-9_.@-]+$')
    password: str = Field(min_length=8, max_length=256)
    is_admin: bool = False


class UserPatch(BaseModel):
    password: str | None = Field(None, min_length=8, max_length=256)
    is_admin: bool | None = None
    disabled: bool | None = None


def _iso(dt):
    return dt.isoformat() + 'Z' if dt else None


@router.get('/stats')
def stats(admin: User = Depends(admin_user), db: Session = Depends(get_db)):
    live = (File.deleted_at.is_(None), File.status == 'completed')
    by_type = {}
    for mime, n, size in db.execute(select(File.mime_type, func.count(File.id), func.sum(File.file_size))
                                    .where(*live).group_by(File.mime_type)):
        c = by_type.setdefault(category_for(mime), {'count': 0, 'size': 0})
        c['count'] += n
        c['size'] += int(size or 0)
    tasks = dict(db.execute(select(UploadTask.status, func.count(UploadTask.id)).group_by(UploadTask.status)).all())
    since = utcnow() - timedelta(days=14)
    daily = {}
    for created, size in db.execute(select(File.created_at, File.file_size).where(File.created_at >= since)):
        k = created.strftime('%Y-%m-%d')
        d = daily.setdefault(k, {'date': k, 'count': 0, 'size': 0})
        d['count'] += 1
        d['size'] += size
    # Telegram 里实际占用（复制出来的记录共用一条消息，不重复算）
    sub = (select(File.telegram_chat_id, File.telegram_message_id, func.max(File.file_size).label('file_size'))
           .where(File.telegram_message_id.is_not(None))
           .group_by(File.telegram_chat_id, File.telegram_message_id).subquery())
    tg = db.execute(select(func.count(), func.coalesce(func.sum(sub.c.file_size), 0)).select_from(sub)).one()
    staging = sum(p.stat().st_size for p in get_settings().staging_dir.glob('*.part'))
    return {
        'users': db.scalar(select(func.count(User.id))),
        'files': db.scalar(select(func.count(File.id)).where(*live)),
        'total_size': int(db.scalar(select(func.coalesce(func.sum(File.file_size), 0)).where(*live)) or 0),
        'folders': db.scalar(select(func.count(Folder.id)).where(Folder.deleted_at.is_(None))),
        'trash': db.scalar(select(func.count(File.id)).where(File.deleted_at.is_not(None))),
        'telegram_messages': tg[0], 'telegram_size': int(tg[1] or 0),
        'staging_size': staging,
        'by_type': by_type, 'tasks': tasks,
        'daily': [daily[k] for k in sorted(daily)],
        'storage': {'backend': get_settings().storage_backend, 'connected': storage_or_none() is not None,
                    'chats': get_settings().all_chats()},
    }


@router.get('/users')
def users(admin: User = Depends(admin_user), db: Session = Depends(get_db)):
    out = []
    for u in db.scalars(select(User).order_by(User.id)):
        n, size = db.execute(select(func.count(File.id), func.coalesce(func.sum(File.file_size), 0))
                             .where(File.user_id == u.id, File.deleted_at.is_(None))).one()
        out.append({**serialize_user(u), 'disabled': u.disabled, 'created_at': _iso(u.created_at),
                    'last_login_at': _iso(u.last_login_at), 'files': n, 'size': int(size or 0)})
    return {'users': out}


@router.post('/users')
def create_user(body: UserIn, request: Request, admin: User = Depends(admin_user), db: Session = Depends(get_db)):
    if db.scalar(select(User.id).where(User.username == body.username)):
        raise HTTPException(409, '用户名已存在')
    u = User(username=body.username, password_hash=hash_password(body.password), is_admin=body.is_admin)
    db.add(u)
    db.commit()
    log_service.record('user_created', u.username, source='admin', user_id=admin.id, ip=client_ip(request))
    return serialize_user(u)


@router.patch('/users/{user_id}')
def patch_user(user_id: int, body: UserPatch, request: Request, admin: User = Depends(admin_user),
               db: Session = Depends(get_db)):
    u = db.get(User, user_id)
    if u is None:
        raise HTTPException(404, '用户不存在')
    if u.id == admin.id and (body.disabled or body.is_admin is False):
        raise HTTPException(400, '不能停用自己或取消自己的管理员身份')
    if body.password:
        u.password_hash = hash_password(body.password)
        u.token_version += 1
    if body.is_admin is not None:
        u.is_admin = body.is_admin
    if body.disabled is not None:
        u.disabled = body.disabled
        u.token_version += 1
    db.commit()
    log_service.record('user_updated', u.username, source='admin', user_id=admin.id, ip=client_ip(request))
    return serialize_user(u)


@router.get('/logs')
def logs(level: str = '', event: str = '', before_id: int | None = None, limit: int = 100,
         admin: User = Depends(admin_user), db: Session = Depends(get_db)):
    q = select(SystemLog).order_by(SystemLog.id.desc()).limit(min(max(limit, 1), 500))
    if level:
        q = q.where(SystemLog.level == level)
    if event:
        q = q.where(SystemLog.event == event)
    if before_id:
        q = q.where(SystemLog.id < before_id)
    names = {u.id: u.username for u in db.scalars(select(User))}
    return {'logs': [{'id': r.id, 'created_at': _iso(r.created_at), 'level': r.level, 'source': r.source,
                      'event': r.event, 'message': r.message, 'user': names.get(r.user_id), 'ip': r.ip}
                     for r in db.scalars(q)]}


@router.get('/tasks')
def all_tasks(status: str = '', admin: User = Depends(admin_user), db: Session = Depends(get_db)):
    q = select(UploadTask).order_by(UploadTask.id.desc()).limit(200)
    if status:
        q = q.where(UploadTask.status == status)
    names = {u.id: u.username for u in db.scalars(select(User))}
    return {'tasks': [{'id': t.id, 'user': names.get(t.user_id), 'filename': t.filename, 'file_size': t.file_size,
                       'status': t.status, 'progress': t.progress, 'retry_count': t.retry_count,
                       'error_message': t.error_message, 'created_at': _iso(t.created_at),
                       'completed_at': _iso(t.completed_at)} for t in db.scalars(q)]}


# ── 备份 ─────────────────────────────────────────────────────────


@router.get('/backups')
def backups(admin: User = Depends(admin_user)):
    return {'backups': backup_service.list_backups()}


@router.post('/backups')
async def make_backup(request: Request, to_telegram: bool = False, admin: User = Depends(admin_user),
                      db: Session = Depends(get_db)):
    path, data = backup_service.write_backup(db)
    out = {'name': path.name, 'size': path.stat().st_size, 'files': len(data['files']), 'telegram': None}
    if to_telegram:
        storage = storage_or_none()
        if storage is None:
            raise HTTPException(503, 'Telegram 存储未连接')
        ref = await backup_service.send_backup_to_telegram(storage, path)
        out['telegram'] = {'chat_id': ref.chat_id, 'message_id': ref.message_id}
    log_service.record('backup_created', f'{path.name}{"（已发到 Telegram）" if to_telegram else ""}',
                       source='admin', user_id=admin.id, ip=client_ip(request))
    return out


@router.get('/backups/{name}')
def download_backup(name: str, admin: User = Depends(admin_user)):
    if not name.startswith('backup-') or '/' in name or '..' in name:
        raise HTTPException(400, '文件名不对')
    p = get_settings().backup_dir / name
    if not p.exists():
        raise HTTPException(404, '备份不存在')
    return FileResponse(p, filename=name, media_type='application/gzip')


# ── 从 Telegram 重建索引 ─────────────────────────────────────────


@router.post('/rebuild')
def rebuild(request: Request, admin: User = Depends(admin_user)):
    storage = storage_or_none()
    if storage is None:
        raise HTTPException(503, 'Telegram 存储未连接')
    try:
        backup_service.rebuild_job.start(storage, admin.id)
    except RuntimeError as e:
        raise HTTPException(409, str(e)) from e
    log_service.record('rebuild_started', '从 Telegram 频道重建索引', source='admin', user_id=admin.id,
                       ip=client_ip(request))
    return backup_service.rebuild_job.state


@router.get('/rebuild')
def rebuild_status(admin: User = Depends(admin_user)):
    return backup_service.rebuild_job.state
