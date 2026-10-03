"""上传 Worker：独立进程，从数据库领取排好队的任务，校验 SHA-256 后传到 Telegram 私有频道。

    python -m backend.workers.upload_worker

失败自动重试：第 1、2 次失败分别等 10 秒、60 秒再试，第 3 次失败标记 failed（次数由 MAX_RETRIES 定）。
可以同时跑多个 Worker：领任务用「status 还是 queued 才改成 uploading」的条件更新，不会两个人抢到同一个。
"""
import asyncio
import logging
import signal
import time
from datetime import timedelta

from sqlalchemy import select, update

from ..config import get_settings
from ..database import init_db, session_scope, utcnow
from ..models import File, Folder, UploadChunk, UploadTask
from ..services import log_service
from ..services.file_service import folder_path, path_string
from ..services.hash_service import sha256_file
from ..services.telegram_service import category_for, create_storage, make_caption
from ..services.upload_service import discard_task_staging, staging_path

log = logging.getLogger('cloud.worker')

BACKOFF = [10, 60, 300]
STALE_AFTER = timedelta(minutes=3)       # 心跳停了这么久 = 那个 Worker 死了
HOUSEKEEP_EVERY = 300


class Cancelled(Exception):
    pass


class Permanent(Exception):
    """重试也没用的错误（比如校验和对不上）。"""


def recover_stale():
    """Worker 崩溃时正在传的任务放回队列。"""
    cutoff = utcnow() - STALE_AFTER
    with session_scope() as db:
        rows = db.scalars(select(UploadTask).where(
            UploadTask.status == 'uploading',
            (UploadTask.heartbeat_at.is_(None)) | (UploadTask.heartbeat_at < cutoff)))
        n = 0
        for t in rows:
            t.status = 'queued'
            t.progress = 0
            n += 1
    if n:
        log_service.record('task_recovered', f'{n} 个中断的任务放回队列', source='worker', level='warning')


def housekeeping():
    s = get_settings()
    cutoff = utcnow() - timedelta(hours=s.staging_ttl_hours)
    with session_scope() as db:
        # 传到一半就没下文的任务：取消，删临时文件
        for t in db.scalars(select(UploadTask).where(UploadTask.status == 'pending',
                                                     UploadTask.last_activity_at < cutoff)):
            t.status = 'cancelled'
            t.error_message = '长时间没有继续上传，已自动取消'
            t.completed_at = utcnow()
            if t.file_id:
                f = db.get(File, t.file_id)
                if f is not None and f.status != 'completed':
                    db.delete(f)
            discard_task_staging(t.id)
        # 失败很久的任务：临时文件清掉（记录留着，「重新上传」会提示重新选文件）
        for t in db.scalars(select(UploadTask).where(UploadTask.status == 'failed', UploadTask.completed_at < cutoff)):
            discard_task_staging(t.id)
        # 没有对应任务的孤儿临时文件
        keep = set(db.scalars(select(UploadTask.id).where(UploadTask.status.in_(('pending', 'queued', 'uploading',
                                                                                 'failed')))))
    for p in s.staging_dir.glob('*.part'):
        try:
            if int(p.stem) not in keep:
                p.unlink(missing_ok=True)
        except ValueError:
            pass


def claim(limit):
    now = utcnow()
    with session_scope() as db:
        ids = list(db.scalars(select(UploadTask.id).where(
            UploadTask.status == 'queued',
            (UploadTask.next_attempt_at.is_(None)) | (UploadTask.next_attempt_at <= now))
            .order_by(UploadTask.id).limit(limit)))
        got = []
        for tid in ids:
            res = db.execute(update(UploadTask).where(UploadTask.id == tid, UploadTask.status == 'queued')
                             .values(status='uploading', started_at=now, heartbeat_at=now, progress=0))
            if res.rowcount == 1:
                got.append(tid)
        return got


class UploadWorker:
    def __init__(self, storage, settings=None):
        self.s = settings or get_settings()
        self.storage = storage
        self.running = set()
        self.stopping = False

    def _load(self, task_id):
        with session_scope() as db:
            t = db.get(UploadTask, task_id)
            f = db.get(File, t.file_id) if t and t.file_id else None
            if t is None or f is None:
                return None
            fmap = {x.id: x for x in db.scalars(select(Folder).where(Folder.user_id == f.user_id))}
            return {
                'task': t.id, 'file': f.id, 'filename': f.filename, 'original': f.original_filename,
                'size': f.file_size, 'mime': f.mime_type, 'sha256': f.sha256,
                'path': path_string(folder_path(db, f.user_id, f.folder_id, fmap)),
                'retry_count': t.retry_count,
            }

    def _set_progress(self, task_id, file_id, pct):
        with session_scope() as db:
            t = db.get(UploadTask, task_id)
            if t is None or t.status != 'uploading':
                return False
            t.progress = pct
            t.heartbeat_at = utcnow()
            f = db.get(File, file_id)
            if f is not None:
                f.status = 'uploading'
                f.upload_progress = pct
            return True

    async def process(self, task_id):
        info = await asyncio.to_thread(self._load, task_id)
        if info is None:
            await asyncio.to_thread(self._finish_cancelled, task_id, None)
            return
        path = staging_path(task_id)
        try:
            if not path.exists() or path.stat().st_size != info['size']:
                raise Permanent('服务器上的临时文件不见了或不完整，请重新上传')
            await asyncio.to_thread(self._set_progress, task_id, info['file'], 0)
            # 校验：浏览器算的 SHA-256 和服务器收到的内容要一致
            digest = await asyncio.to_thread(sha256_file, path)
            if digest != info['sha256']:
                raise Permanent('文件校验失败：服务器收到的内容和 SHA-256 对不上，请重新上传')

            last = {'t': 0.0, 'pct': -1}

            async def progress(sent, total):
                pct = int(sent * 100 / total) if total else 0
                pct = min(pct, 99)
                if pct == last['pct'] or time.monotonic() - last['t'] < 1:
                    return
                last['t'], last['pct'] = time.monotonic(), pct
                alive = await asyncio.to_thread(self._set_progress, task_id, info['file'], pct)
                if not alive:
                    raise Cancelled()

            chat = self.s.chat_for(category_for(info['mime']))
            caption = make_caption({'name': info['filename'], 'size': info['size'], 'sha256': info['sha256'],
                                    'mime': info['mime'], 'path': info['path']})
            ref = await self.storage.upload(path, chat_id=chat, filename=info['filename'], mime=info['mime'],
                                            caption=caption, progress=progress)
            if ref.size != info['size']:
                await self.storage.delete(ref.chat_id, [ref.message_id])
                raise RuntimeError(f'Telegram 收到的大小 {ref.size} 和原文件 {info["size"]} 不一致')
            kept = await asyncio.to_thread(self._finish_ok, task_id, info, ref)
            if not kept:
                # 传的过程中用户取消 / 删除了：Telegram 里那条也删掉
                await self.storage.delete(ref.chat_id, [ref.message_id])
        except Cancelled:
            await asyncio.to_thread(self._finish_cancelled, task_id, info)
        except Permanent as e:
            await asyncio.to_thread(self._finish_failed, task_id, info, str(e), True)
        except Exception as e:  # noqa: BLE001
            log.exception('upload task %s failed', task_id)
            await asyncio.to_thread(self._finish_failed, task_id, info, f'{type(e).__name__}: {e}', False)

    def _finish_ok(self, task_id, info, ref):
        with session_scope() as db:
            t = db.get(UploadTask, task_id)
            f = db.get(File, info['file'])
            if t is None or t.status != 'uploading' or f is None:
                return False
            f.telegram_chat_id = ref.chat_id
            f.telegram_message_id = ref.message_id
            f.telegram_file_id = ref.file_id
            f.status = 'completed'
            f.upload_progress = 100
            t.status = 'completed'
            t.progress = 100
            t.error_message = None
            t.completed_at = utcnow()
            db.query(UploadChunk).filter(UploadChunk.task_id == task_id).delete()
            uid = f.user_id
        discard_task_staging(task_id)
        log_service.record('upload_completed', f'{info["filename"]} → Telegram {ref.chat_id}/{ref.message_id}',
                           source='worker', user_id=uid)
        return True

    def _finish_cancelled(self, task_id, info):
        with session_scope() as db:
            t = db.get(UploadTask, task_id)
            if t is not None and t.status not in ('completed', 'cancelled'):
                t.status = 'cancelled'
                t.completed_at = utcnow()
                t.error_message = t.error_message or '已取消'
        discard_task_staging(task_id)

    def _finish_failed(self, task_id, info, message, permanent):
        with session_scope() as db:
            t = db.get(UploadTask, task_id)
            if t is None or t.status != 'uploading':
                return
            t.retry_count += 1
            t.error_message = message[:2000]
            f = db.get(File, t.file_id) if t.file_id else None
            if not permanent and t.retry_count < self.s.max_retries:
                delay = BACKOFF[min(t.retry_count - 1, len(BACKOFF) - 1)]
                t.status = 'queued'
                t.progress = 0
                t.next_attempt_at = utcnow() + timedelta(seconds=delay)
                if f is not None:
                    f.status = 'pending'
                    f.upload_progress = 0
                level, event = 'warning', 'upload_retry'
                text = f'{t.filename} 第 {t.retry_count} 次失败，{delay} 秒后重试：{message}'
            else:
                t.status = 'failed'
                t.completed_at = utcnow()
                if f is not None:
                    f.status = 'failed'
                level, event = 'error', 'upload_failed'
                text = f'{t.filename} 上传失败：{message}'
            uid = t.user_id
        log_service.record(event, text, level=level, source='worker', user_id=uid)

    async def tick(self):
        free = self.s.upload_concurrency - len(self.running)
        if free <= 0 or self.stopping:
            return 0
        ids = await asyncio.to_thread(claim, free)
        for tid in ids:
            task = asyncio.create_task(self.process(tid))
            self.running.add(task)
            task.add_done_callback(self.running.discard)
        return len(ids)

    async def run(self):
        await asyncio.to_thread(recover_stale)
        await asyncio.to_thread(housekeeping)
        last_house = time.monotonic()
        while not self.stopping:
            try:
                await self.tick()
                if time.monotonic() - last_house > HOUSEKEEP_EVERY:
                    await asyncio.to_thread(recover_stale)
                    await asyncio.to_thread(housekeeping)
                    last_house = time.monotonic()
            except Exception:  # noqa: BLE001
                log.exception('worker loop error')
            await asyncio.sleep(1.5)
        if self.running:
            await asyncio.wait(self.running, timeout=30)


async def main():
    logging.basicConfig(level=logging.INFO, format='%(asctime)s %(levelname)s %(name)s %(message)s')
    s = get_settings()
    init_db()
    storage = create_storage(s, role='worker')
    await storage.start()
    worker = UploadWorker(storage, s)
    loop = asyncio.get_running_loop()
    for sig in (signal.SIGINT, signal.SIGTERM):
        try:
            loop.add_signal_handler(sig, lambda: setattr(worker, 'stopping', True))
        except NotImplementedError:
            pass
    log_service.record('worker_started', f'storage={s.storage_backend} concurrency={s.upload_concurrency}',
                       source='worker')
    try:
        await worker.run()
    finally:
        await storage.stop()


if __name__ == '__main__':
    asyncio.run(main())
