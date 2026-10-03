"""数据库备份 / 恢复，以及「数据库丢了从 Telegram 频道重建索引」。"""
import asyncio
import gzip
import json
import logging
from datetime import datetime, timezone

from sqlalchemy import select

from ..config import get_settings
from ..database import session_scope, utcnow
from ..models import File, Folder, User
from .telegram_service import BACKUP_TAG

log = logging.getLogger('cloud.backup')

TABLES = [('users', User), ('folders', Folder), ('files', File)]


def _row(obj):
    out = {}
    for col in obj.__table__.columns:
        v = getattr(obj, col.name)
        out[col.name] = v.isoformat() if isinstance(v, datetime) else v
    return out


def export_data(db):
    data = {'format': 'private-cloud-backup', 'version': 1, 'created_at': utcnow().isoformat() + 'Z'}
    for name, model in TABLES:
        data[name] = [_row(o) for o in db.scalars(select(model).order_by(model.id))]
    return data


def write_backup(db):
    data = export_data(db)
    name = 'backup-' + utcnow().strftime('%Y%m%d-%H%M%S') + '.json.gz'
    path = get_settings().backup_dir / name
    with gzip.open(path, 'wt', encoding='utf-8') as fh:
        json.dump(data, fh, ensure_ascii=False)
    # 只留最近 20 份
    olds = sorted(get_settings().backup_dir.glob('backup-*.json.gz'))
    for p in olds[:-20]:
        p.unlink(missing_ok=True)
    return path, data


def list_backups():
    out = []
    for p in sorted(get_settings().backup_dir.glob('backup-*.json.gz'), reverse=True):
        st = p.stat()
        out.append({'name': p.name, 'size': st.st_size,
                    'created_at': datetime.fromtimestamp(st.st_mtime, timezone.utc).replace(tzinfo=None).isoformat() + 'Z'})
    return out


async def send_backup_to_telegram(storage, path):
    s = get_settings()
    caption = f'{BACKUP_TAG} {path.name}'
    ref = await storage.upload(path, chat_id=s.telegram_chat_id, filename=path.name, mime='application/gzip',
                               caption=caption)
    return ref


def _parse_dt(v):
    if not v:
        return None
    return datetime.fromisoformat(v.rstrip('Z'))


def restore_data(db, data):
    """把备份导进空数据库。已有数据时拒绝，避免覆盖。"""
    if data.get('format') != 'private-cloud-backup':
        raise ValueError('不是本系统的备份文件')
    if db.scalar(select(File.id).limit(1)) is not None or db.scalar(select(Folder.id).limit(1)) is not None:
        raise ValueError('数据库里已经有文件或文件夹，只能恢复到空数据库')
    for u in db.scalars(select(User)):
        db.delete(u)
    db.flush()
    for name, model in TABLES:
        cols = {c.name: c for c in model.__table__.columns}
        rows = data.get(name, [])
        parents = {}
        for r in rows:
            kw = {}
            for k, v in r.items():
                if k not in cols:
                    continue
                if v is not None and cols[k].type.python_type is datetime:
                    v = _parse_dt(v)
                kw[k] = v
            if model is Folder:
                parents[kw['id']] = kw.pop('parent_id', None)   # 先不挂父目录，全插完再补，避免外键顺序问题
            db.add(model(**kw))
        db.flush()
        if model is Folder:
            for fid, pid in parents.items():
                if pid is not None:
                    db.get(Folder, fid).parent_id = pid
            db.flush()
    db.commit()
    if db.bind.dialect.name == 'postgresql':
        # 显式写入了 id，PostgreSQL 的自增序列不会跟着走，要手动拨到最大值后面
        from sqlalchemy import text
        for name, _ in TABLES:
            db.execute(text(f"SELECT setval(pg_get_serial_sequence('{name}', 'id'), "
                            f"COALESCE((SELECT MAX(id) FROM {name}), 0) + 1, false)"))
        db.commit()
    return {name: len(data.get(name, [])) for name, _ in TABLES}


# ── 从 Telegram 重建索引 ─────────────────────────────────────────


class RebuildJob:
    """把频道从第 1 条消息扫到最新一条，带本系统元数据、数据库里又没有记录的文件补回来。"""

    def __init__(self):
        self.state = {'running': False}
        self.task = None

    def running(self):
        return self.task is not None and not self.task.done()

    def start(self, storage, user_id):
        if self.running():
            raise RuntimeError('已经在重建了')
        self.state = {'running': True, 'scanned': 0, 'found': 0, 'added': 0, 'skipped': 0, 'latest': None,
                      'error': None, 'started_at': utcnow().isoformat() + 'Z', 'finished_at': None}
        self.task = asyncio.create_task(self._run(storage, user_id))

    async def _run(self, storage, user_id):
        try:
            for chat in get_settings().all_chats():
                latest = await storage.latest_id(chat)
                self.state['latest'] = latest
                pos = 1
                while pos <= latest:
                    batch = await storage.scan(chat, pos, 100)
                    self.state['scanned'] = self.state.get('scanned', 0) + min(100, latest - pos + 1)
                    pos += 100
                    await asyncio.to_thread(self._apply, chat, batch, user_id)
                    await asyncio.sleep(0.5)   # 别把 Telegram 打得太急
        except Exception as e:  # noqa: BLE001
            log.exception('rebuild failed')
            self.state['error'] = str(e)
        finally:
            self.state['running'] = False
            self.state['finished_at'] = utcnow().isoformat() + 'Z'

    def _apply(self, chat, batch, user_id):
        from .file_service import free_file_name
        with session_scope() as db:
            user = db.get(User, user_id)
            for m in batch:
                if not m.meta or not m.meta.get('sha256'):
                    continue
                self.state['found'] += 1
                exists = db.scalar(select(File.id).where(File.telegram_chat_id == chat,
                                                         File.telegram_message_id == m.message_id).limit(1))
                if exists:
                    self.state['skipped'] += 1
                    continue
                folder_id = _ensure_path(db, user, m.meta.get('path') or '/')
                name = m.meta.get('name') or m.filename or f'file-{m.message_id}'
                db.add(File(user_id=user.id, filename=free_file_name(db, user, folder_id, name), original_filename=name,
                            file_size=m.size, mime_type=m.meta.get('mime') or m.mime or 'application/octet-stream',
                            sha256=m.meta['sha256'], telegram_chat_id=chat, telegram_message_id=m.message_id,
                            telegram_file_id=m.file_id, folder_id=folder_id, status='completed', upload_progress=100))
                db.flush()
                self.state['added'] += 1


def _ensure_path(db, user, path):
    parent = None
    for part in [p for p in path.split('/') if p]:
        q = select(Folder).where(Folder.user_id == user.id, Folder.name == part, Folder.deleted_at.is_(None),
                                 Folder.parent_id.is_(None) if parent is None else Folder.parent_id == parent)
        f = db.scalar(q.limit(1))
        if f is None:
            f = Folder(user_id=user.id, name=part, parent_id=parent)
            db.add(f)
            db.flush()
        parent = f.id
    return parent


rebuild_job = RebuildJob()
