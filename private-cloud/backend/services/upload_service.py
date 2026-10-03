"""上传任务：网页只负责创建任务、把分片传上来；往 Telegram 传是 Worker 的事。

流程：create（查重 → 建文件记录 + 任务）→ 浏览器按分片 PUT（可断点续传）→ complete（分片收齐，进队列）
→ Worker 领取、校验 SHA-256、上传 Telegram、写回消息号。"""
import math
import mimetypes
import os

from fastapi import HTTPException
from sqlalchemy import func, select
from sqlalchemy.exc import IntegrityError

from ..config import get_settings
from ..database import utcnow
from ..models import File, UploadChunk, UploadTask
from . import file_service
from .hash_service import is_sha256

ACTIVE = ('pending', 'queued', 'uploading')


def staging_path(task_id):
    return get_settings().staging_dir / f'{task_id}.part'


def discard_task_staging(task_id):
    try:
        staging_path(task_id).unlink(missing_ok=True)
    except OSError:
        pass


def guess_mime(filename, given):
    given = (given or '').strip().lower()
    if given and given != 'application/octet-stream' and '/' in given and len(given) <= 127:
        return given
    guessed, _ = mimetypes.guess_type(filename)
    return guessed or 'application/octet-stream'


def _iso(dt):
    return dt.isoformat() + 'Z' if dt else None


def serialize_task(db, t, with_chunks=False):
    received = db.scalar(select(func.count(UploadChunk.id)).where(UploadChunk.task_id == t.id)) or 0
    d = {
        'id': t.id, 'file_id': t.file_id, 'filename': t.filename, 'file_size': t.file_size, 'status': t.status,
        'progress': t.progress, 'retry_count': t.retry_count, 'error_message': t.error_message,
        'chunk_size': t.chunk_size, 'total_chunks': t.total_chunks, 'received_chunks': received,
        'created_at': _iso(t.created_at), 'started_at': _iso(t.started_at), 'completed_at': _iso(t.completed_at),
    }
    if with_chunks:
        d['received'] = sorted(db.scalars(select(UploadChunk.idx).where(UploadChunk.task_id == t.id)))
    return d


def get_task(db, user, task_id):
    t = db.get(UploadTask, task_id)
    if t is None or t.user_id != user.id:
        raise HTTPException(404, '上传任务不存在')
    return t


def find_duplicate(db, user, sha256, size):
    """查重看 SHA-256 + 文件大小，不看文件名。优先返回正常的那份，其次正在传的，最后回收站里的。"""
    rows = list(db.scalars(select(File).where(File.user_id == user.id, File.sha256 == sha256, File.file_size == size,
                                              File.status.in_(('completed', 'pending', 'uploading')))))
    rank = {('completed', False): 0, ('uploading', False): 1, ('pending', False): 2}
    rows.sort(key=lambda f: rank.get((f.status, bool(f.deleted_at)), 3))
    return rows[0] if rows else None


def create_task(db, user, *, filename, size, mime, sha256, folder_id, force_link=False):
    s = get_settings()
    filename = file_service.clean_name(filename)
    sha256 = (sha256 or '').lower()
    if not is_sha256(sha256):
        raise HTTPException(400, 'SHA-256 格式不对')
    if size <= 0:
        raise HTTPException(400, '空文件不能上传（Telegram 不收 0 字节的文件）')
    if size > s.max_file_size:
        raise HTTPException(413, f'文件太大：单个文件最大 {s.max_file_size // (1024 * 1024)} MB')
    file_service.get_folder(db, user, folder_id)

    dup = find_duplicate(db, user, sha256, size)
    if dup is not None:
        if dup.status in ('pending', 'uploading') and not dup.deleted_at:
            task = db.scalar(select(UploadTask).where(UploadTask.file_id == dup.id, UploadTask.status.in_(ACTIVE))
                             .order_by(UploadTask.id.desc()))
            if task is not None:
                # 同一个文件正在传：直接接着传（刷新页面后的断点续传）
                return {'duplicate': False, 'resume': True, 'task': serialize_task(db, task, with_chunks=True)}
        elif dup.status == 'completed':
            if force_link and not dup.deleted_at:
                linked = file_service.link_existing(db, user, dup, folder_id, filename)
                return {'duplicate': True, 'linked': True, 'file': file_service.serialize_file(linked)}
            path = file_service.path_string(file_service.folder_path(db, user.id, dup.folder_id))
            return {'duplicate': True, 'in_trash': bool(dup.deleted_at),
                    'file': file_service.serialize_file(dup, path=path)}

    f = File(user_id=user.id, filename=file_service.free_file_name(db, user, folder_id, filename),
             original_filename=filename, file_size=size, mime_type=guess_mime(filename, mime), sha256=sha256,
             folder_id=folder_id, status='pending', upload_progress=0)
    db.add(f)
    db.flush()
    t = UploadTask(user_id=user.id, file_id=f.id, filename=f.filename, file_size=size, status='pending',
                   chunk_size=s.chunk_size, total_chunks=math.ceil(size / s.chunk_size))
    db.add(t)
    db.commit()
    p = staging_path(t.id)
    with open(p, 'wb') as fh:
        fh.truncate(size)
    return {'duplicate': False, 'resume': False, 'task': serialize_task(db, t, with_chunks=True)}


def expected_chunk_size(t, idx):
    if idx < t.total_chunks - 1:
        return t.chunk_size
    return t.file_size - t.chunk_size * (t.total_chunks - 1)


def write_chunk(db, user, task_id, idx, data):
    t = get_task(db, user, task_id)
    if t.status != 'pending':
        raise HTTPException(409, f'任务状态是 {t.status}，不再接收分片')
    if not 0 <= idx < t.total_chunks:
        raise HTTPException(400, '分片序号超出范围')
    if len(data) != expected_chunk_size(t, idx):
        raise HTTPException(400, f'分片大小不对：应为 {expected_chunk_size(t, idx)} 字节，收到 {len(data)}')
    p = staging_path(t.id)
    if not p.exists():
        raise HTTPException(410, '临时文件已被清理，请重新上传')
    fd = os.open(p, os.O_WRONLY)
    try:
        os.pwrite(fd, data, idx * t.chunk_size)
    finally:
        os.close(fd)
    db.add(UploadChunk(task_id=t.id, idx=idx, size=len(data)))
    try:
        db.commit()
    except IntegrityError:
        db.rollback()   # 重传同一个分片：内容已经覆盖写好了
    t = db.get(UploadTask, task_id)
    t.last_activity_at = utcnow()
    db.commit()
    return serialize_task(db, t)


def complete(db, user, task_id):
    t = get_task(db, user, task_id)
    if t.status in ('queued', 'uploading', 'completed'):
        return serialize_task(db, t)
    if t.status != 'pending':
        raise HTTPException(409, f'任务状态是 {t.status}')
    have = set(db.scalars(select(UploadChunk.idx).where(UploadChunk.task_id == t.id)))
    missing = [i for i in range(t.total_chunks) if i not in have]
    if missing:
        raise HTTPException(400, {'message': f'还缺 {len(missing)} 个分片', 'missing': missing[:100]})
    t.status = 'queued'
    t.progress = 0
    t.last_activity_at = utcnow()
    db.commit()
    return serialize_task(db, t)


def cancel(db, user, task_id):
    t = get_task(db, user, task_id)
    if t.status in ('completed', 'cancelled'):
        return serialize_task(db, t)
    t.status = 'cancelled'
    t.completed_at = utcnow()
    t.error_message = '已取消'
    if t.file_id is not None:
        f = db.get(File, t.file_id)
        if f is not None and f.status != 'completed':
            db.delete(f)
    db.commit()
    discard_task_staging(t.id)
    return serialize_task(db, t)


def retry(db, user, task_id):
    t = get_task(db, user, task_id)
    if t.status != 'failed':
        raise HTTPException(409, '只有失败的任务能重新上传')
    f = db.get(File, t.file_id) if t.file_id else None
    p = staging_path(t.id)
    if f is None or not p.exists() or p.stat().st_size != t.file_size:
        raise HTTPException(410, '临时文件已被清理，请重新选择文件上传')
    have = db.scalar(select(func.count(UploadChunk.id)).where(UploadChunk.task_id == t.id))
    t.status = 'queued' if have == t.total_chunks else 'pending'
    t.retry_count = 0
    t.error_message = None
    t.next_attempt_at = None
    t.progress = 0
    t.last_activity_at = utcnow()
    f.status = 'pending'
    f.upload_progress = 0
    db.commit()
    return serialize_task(db, t, with_chunks=True)


def list_tasks(db, user, limit=100):
    rows = db.scalars(select(UploadTask).where(UploadTask.user_id == user.id)
                      .order_by(UploadTask.id.desc()).limit(limit))
    return [serialize_task(db, t) for t in rows]


def clear_finished(db, user):
    """从任务列表里清掉已完成 / 已取消的。"""
    rows = db.scalars(select(UploadTask).where(UploadTask.user_id == user.id,
                                               UploadTask.status.in_(('completed', 'cancelled'))))
    n = 0
    for t in rows:
        db.delete(t)
        n += 1
    db.commit()
    return n
