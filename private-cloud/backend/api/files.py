from urllib.parse import quote

from fastapi import APIRouter, Depends, HTTPException, Request
from fastapi.responses import Response, StreamingResponse
from pydantic import BaseModel, Field
from sqlalchemy.orm import Session

from ..database import get_db
from ..models import User
from ..security import current_user
from ..services import file_service as fs
from ..services import log_service
from ..services.storage_service import byte_source, get_storage, parse_range, storage_or_none
from .auth import client_ip

router = APIRouter(prefix='/api', tags=['files'])

# 可以在网页里直接打开（inline）的类型；其余一律当附件下载，并用 CSP sandbox 禁止执行脚本，
# 防止有人上传一个 .html / .svg 在本站域名下跑脚本偷登录态
INLINE_PREFIXES = ('video/', 'audio/')
INLINE_TYPES = {'image/jpeg', 'image/png', 'image/gif', 'image/webp', 'image/avif', 'image/bmp', 'image/x-icon',
                'application/pdf', 'text/plain'}


class RenameIn(BaseModel):
    name: str = Field(max_length=300)


class MoveIn(BaseModel):
    target_folder_id: int | None = None


class BatchIn(BaseModel):
    action: str                     # delete | move | copy | restore | purge
    file_ids: list[int] = []
    folder_ids: list[int] = []
    target_folder_id: int | None = None


def content_disposition(kind, filename):
    ascii_name = filename.encode('ascii', 'ignore').decode().replace('"', '') or 'file'
    return f'{kind}; filename="{ascii_name}"; filename*=UTF-8\'\'{quote(filename)}'


@router.get('/files')
def list_files(folder_id: int | None = None, sort: str = 'name', order: str = 'asc',
               user: User = Depends(current_user), db: Session = Depends(get_db)):
    return fs.list_dir(db, user, folder_id, sort, order)


@router.get('/files/{file_id}')
def file_detail(file_id: int, user: User = Depends(current_user), db: Session = Depends(get_db)):
    f = fs.get_file(db, user, file_id, allow_deleted=True)
    return fs.serialize_file(f, path=fs.path_string(fs.folder_path(db, user.id, f.folder_id)))


@router.post('/files/{file_id}/rename')
def rename(file_id: int, body: RenameIn, user: User = Depends(current_user), db: Session = Depends(get_db)):
    return fs.serialize_file(fs.rename_file(db, user, file_id, body.name))


@router.post('/files/{file_id}/move')
def move(file_id: int, body: MoveIn, user: User = Depends(current_user), db: Session = Depends(get_db)):
    return fs.serialize_file(fs.move_file(db, user, file_id, body.target_folder_id))


@router.post('/files/{file_id}/copy')
def copy(file_id: int, body: MoveIn, user: User = Depends(current_user), db: Session = Depends(get_db)):
    return fs.serialize_file(fs.copy_file(db, user, file_id, body.target_folder_id))


@router.delete('/files/{file_id}')
def delete(file_id: int, user: User = Depends(current_user), db: Session = Depends(get_db)):
    """进回收站。还没传完的文件直接取消上传。"""
    fs.trash_file(db, user, file_id)
    return {'ok': True}


@router.post('/files/{file_id}/restore')
def restore(file_id: int, user: User = Depends(current_user), db: Session = Depends(get_db)):
    return fs.serialize_file(fs.restore_file(db, user, file_id))


# ── 回收站 ───────────────────────────────────────────────────────


@router.get('/trash')
def trash(user: User = Depends(current_user), db: Session = Depends(get_db)):
    return fs.list_trash(db, user)


async def _purge(db, user, files, folders, request):
    refs = fs.telegram_refs_to_delete(db, files)
    if refs:
        storage = storage_or_none()
        if storage is None:
            raise HTTPException(503, 'Telegram 存储未连接，暂时不能永久删除')
        try:
            for chat, ids in refs.items():
                await storage.delete(chat, ids)
        except Exception as e:  # noqa: BLE001
            log_service.record('telegram_delete_failed', str(e), level='error', user_id=user.id)
            raise HTTPException(502, f'删除 Telegram 消息失败：{e}') from e
    fs.apply_purge(db, files, folders)
    n = sum(len(v) for v in refs.values())
    log_service.record('purge', f'永久删除 {len(files)} 个文件、{len(folders)} 个文件夹，Telegram 消息 {n} 条',
                       user_id=user.id, ip=client_ip(request))
    return {'ok': True, 'files': len(files), 'folders': len(folders), 'telegram_messages': n}


@router.delete('/trash/files/{file_id}')
async def purge_file(file_id: int, request: Request, user: User = Depends(current_user), db: Session = Depends(get_db)):
    files, folders = fs.collect_purge(db, user, file_ids=[file_id])
    return await _purge(db, user, files, folders, request)


@router.delete('/trash/folders/{folder_id}')
async def purge_folder(folder_id: int, request: Request, user: User = Depends(current_user),
                       db: Session = Depends(get_db)):
    files, folders = fs.collect_purge(db, user, folder_ids=[folder_id])
    return await _purge(db, user, files, folders, request)


@router.delete('/trash')
async def empty_trash(request: Request, user: User = Depends(current_user), db: Session = Depends(get_db)):
    files, folders = fs.collect_empty_trash(db, user)
    return await _purge(db, user, files, folders, request)


# ── 批量 ─────────────────────────────────────────────────────────


@router.post('/batch')
async def batch(body: BatchIn, request: Request, user: User = Depends(current_user), db: Session = Depends(get_db)):
    if len(body.file_ids) + len(body.folder_ids) > 1000:
        raise HTTPException(400, '一次最多 1000 项')
    if body.action == 'purge':
        files, folders = fs.collect_purge(db, user, body.file_ids, body.folder_ids)
        return await _purge(db, user, files, folders, request)
    done, errors = 0, []
    ops = {
        'delete': (lambda i: fs.trash_file(db, user, i), lambda i: fs.trash_folder(db, user, i)),
        'restore': (lambda i: fs.restore_file(db, user, i), lambda i: fs.restore_folder(db, user, i)),
        'move': (lambda i: fs.move_file(db, user, i, body.target_folder_id),
                 lambda i: fs.move_folder(db, user, i, body.target_folder_id)),
        'copy': (lambda i: fs.copy_file(db, user, i, body.target_folder_id), None),
    }
    if body.action not in ops:
        raise HTTPException(400, '未知操作')
    on_file, on_folder = ops[body.action]
    for kind, ids, fn in (('file', body.file_ids, on_file), ('folder', body.folder_ids, on_folder)):
        for i in ids:
            if fn is None:
                errors.append({'type': kind, 'id': i, 'error': '文件夹不支持这个操作'})
                continue
            try:
                fn(i)
                done += 1
            except HTTPException as e:
                db.rollback()
                errors.append({'type': kind, 'id': i, 'error': e.detail})
    return {'ok': not errors, 'done': done, 'errors': errors}


# ── 下载 / 在线播放 ──────────────────────────────────────────────


def _file_response(request, db, user, file_id, disposition):
    f = fs.get_file(db, user, file_id)
    source = byte_source(db, f)
    total = f.file_size
    rng = parse_range(request.headers.get('range'), total)
    if rng is None:
        return Response(status_code=416, headers={'Content-Range': f'bytes */{total}'})
    start, end, partial = rng
    mime = (f.mime_type or 'application/octet-stream').lower()
    inline_ok = mime.startswith(INLINE_PREFIXES) or mime in INLINE_TYPES
    if disposition == 'inline' and not inline_ok:
        disposition = 'attachment'
    headers = {
        'Accept-Ranges': 'bytes',
        'Content-Length': str(end - start + 1),
        'Content-Disposition': content_disposition(disposition, f.filename),
        'Cache-Control': 'private, max-age=3600',
        'X-Content-Type-Options': 'nosniff',
        'ETag': f'"{f.sha256[:32]}"',
    }
    if mime != 'application/pdf':
        headers['Content-Security-Policy'] = "default-src 'none'; img-src 'self'; media-src 'self'; sandbox"
    if partial:
        headers['Content-Range'] = f'bytes {start}-{end}/{total}'
    return StreamingResponse(source(start, end), status_code=206 if partial else 200, media_type=mime,
                             headers=headers)


@router.get('/files/{file_id}/download')
def download(file_id: int, request: Request, user: User = Depends(current_user), db: Session = Depends(get_db)):
    return _file_response(request, db, user, file_id, 'attachment')


@router.get('/files/{file_id}/stream')
def stream(file_id: int, request: Request, user: User = Depends(current_user), db: Session = Depends(get_db)):
    """视频 / 音频 / 图片 / PDF 在线预览，支持 Range（拖进度条）。"""
    return _file_response(request, db, user, file_id, 'inline')


@router.get('/storage/status')
def storage_status(user: User = Depends(current_user)):
    try:
        get_storage()
        return {'connected': True}
    except HTTPException:
        return {'connected': False}
