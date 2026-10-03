"""读文件内容：已存进 Telegram 的从 Telegram 取；还在排队 / 正在传的从服务器临时文件取（刚传完就能预览）。"""
import asyncio
import re

from fastapi import HTTPException
from sqlalchemy import select

from ..models import UploadTask
from .upload_service import staging_path

_storage = None


def set_storage(storage):
    global _storage
    _storage = storage


def get_storage():
    if _storage is None:
        raise HTTPException(503, 'Telegram 存储未连接，请检查服务器配置和日志')
    return _storage


def storage_or_none():
    return _storage


def parse_range(header, total):
    """返回 (start, end, partial)；范围没法满足返回 None。多段 Range 当作要整个文件。"""
    m = re.fullmatch(r'bytes=(\d*)-(\d*)', (header or '').strip())
    if not m or not (m[1] or m[2]):
        return 0, total - 1, False
    if not m[1]:
        n = int(m[2])
        return (max(0, total - n), total - 1, True) if n > 0 else None
    start = int(m[1])
    end = min(int(m[2]), total - 1) if m[2] else total - 1
    if start >= total:
        return None
    if end < start:
        return 0, total - 1, False
    return start, end, True


def _staged(db, f):
    """还没进 Telegram、但分片已收齐的临时文件路径。"""
    t = db.scalar(select(UploadTask).where(UploadTask.file_id == f.id,
                                           UploadTask.status.in_(('queued', 'uploading', 'failed')))
                  .order_by(UploadTask.id.desc()))
    if t is None:
        return None
    p = staging_path(t.id)
    return p if p.exists() and p.stat().st_size == f.file_size else None


async def _read_local(path, start, end, block=512 * 1024):
    with open(path, 'rb') as fh:
        fh.seek(start)
        left = end - start + 1
        while left > 0:
            b = await asyncio.to_thread(fh.read, min(block, left))
            if not b:
                return
            left -= len(b)
            yield b


def byte_source(db, f):
    """返回 (start, end) -> 异步字节迭代器。"""
    if f.status == 'completed' and f.telegram_message_id is not None:
        storage = get_storage()
        return lambda start, end: storage.iter_range(f.telegram_chat_id, f.telegram_message_id, start, end)
    p = _staged(db, f)
    if p is not None:
        return lambda start, end: _read_local(p, start, end)
    raise HTTPException(409, '文件还没上传完成')
