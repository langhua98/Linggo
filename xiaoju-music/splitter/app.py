"""小橘音乐 · 大文件切片服务（Hugging Face Space）

Telegram 官方 Bot API 只能下载 20 MB 以内的文件，机器人走 MTProto 却能下载 2 GB。
Worker 发现频道里有超过 20 MB 的音频，就 POST /split 派活过来：这里用 Telethon 以机器人身份
下载原文件，边下边切成 19 MB 的分片，用 Bot API 的 sendDocument 发到私有仓库频道，最后把分片
清单回调给 Worker（/admin/api/commit）登记。播放时 Worker 再把分片按 Range 拼回原文件。

环境变量（在 Space 的 Settings → Variables and secrets 里设成 secret）：
  TG_API_ID / TG_API_HASH   my.telegram.org 申请的应用凭据
  TG_BOT_TOKEN              机器人 token（和 Worker 里的是同一个）
  WORKER_URL                Worker 地址，如 https://xiaoju-music.langhua98.workers.dev
  ADMIN_KEY                 Worker 的管理密钥（回报进度、登记分片用）
  SPLITTER_KEY              Worker 派活时带的密钥（X-Key 请求头）
"""

import asyncio
import hmac
import logging
import os
from contextlib import asynccontextmanager

import httpx
from fastapi import FastAPI, HTTPException, Request

TG = 'https://api.telegram.org'
# Bot API 的下载上限；分片必须比它小
BOT_DOWNLOAD_LIMIT = 20 * 1024 * 1024
# MTProto 每次请求最多取 512 KB
REQUEST_SIZE = 512 * 1024

logging.basicConfig(level=logging.INFO, format='%(asctime)s %(levelname)s %(message)s')
log = logging.getLogger('splitter')


class JobError(Exception):
    """能直接给用户看的失败原因。"""


class Splitter:
    """一次只处理一首，排队的按先来后到。下载和上传的实现由外面注入，方便测试。"""

    def __init__(self, *, bot_token, worker_url, admin_key, http, fetch_message, iter_download, sleep=asyncio.sleep):
        self.bot_token = bot_token
        self.worker_url = worker_url.rstrip('/')
        self.auth = {'Authorization': 'Bearer ' + admin_key}
        self.http = http
        self.fetch_message = fetch_message  # async (频道用户名, 消息号) -> (文件大小, 文件对象) 或 None
        self.iter_download = iter_download  # (文件对象) -> 异步迭代的字节块
        self.sleep = sleep
        self.queue = asyncio.Queue()
        self.active = set()  # 排队中或正在处理的消息号

    def submit(self, job):
        """收下一个活；同一首已经在排队或处理中就不重复收，返回 False。"""
        job = {
            'track': int(job['track']),
            'size': int(job['size']),
            'part_size': int(job['part_size']),
            'storage': str(job['storage']),
            'channel': str(job['channel']),
        }
        if not 0 < job['part_size'] <= BOT_DOWNLOAD_LIMIT or job['size'] <= 0:
            raise ValueError('bad sizes')
        if job['track'] in self.active:
            return False
        self.active.add(job['track'])
        self.queue.put_nowait(job)
        return True

    async def run(self):
        while True:
            job = await self.queue.get()
            track = job['track']
            try:
                log.info('track %s: start, %s bytes', track, job['size'])
                await self.process(job)
                log.info('track %s: done', track)
            except Exception as e:  # noqa: BLE001 — 任何失败都要回报给 Worker，好让它按退避重试
                note = str(e) if isinstance(e, JobError) else f'{type(e).__name__}: {e}'
                note = self.clean(note)[:180]
                log.warning('track %s: failed: %s', track, note)
                await self.report(track, 'failed', note)
            finally:
                self.active.discard(track)
                self.queue.task_done()

    async def process(self, job):
        track, size, part_size = job['track'], job['size'], job['part_size']
        await self.report(track, 'processing', '正在下载原文件')
        found = await self.fetch_message(job['channel'], track)
        if not found:
            raise JobError('频道里找不到这条音频')
        real_size, document = found
        if real_size != size:
            raise JobError(f'文件大小对不上（频道里 {real_size}，登记的 {size}）')

        count = -(-size // part_size)
        parts = []
        buf = bytearray()
        # 边下边切：内存里最多留一片多一点
        async for chunk in self.iter_download(document):
            buf += chunk
            while len(buf) >= part_size:
                parts.append(await self.upload(job, len(parts), count, bytes(buf[:part_size])))
                del buf[:part_size]
                await self.report(track, 'processing', f'{len(parts)}/{count}')
        if buf:
            parts.append(await self.upload(job, len(parts), count, bytes(buf)))
        if len(parts) != count or sum(p['size'] for p in parts) != size:
            raise JobError('下载到的大小不对')
        await self.commit(track, size, parts)

    async def upload(self, job, index, count, data):
        track = job['track']
        form = {
            'chat_id': job['storage'],
            'caption': f'#t{track} {index + 1}/{count}',
            'disable_notification': 'true',
            'disable_content_type_detection': 'true',
        }
        files = {'document': (f't{track}-p{index + 1}of{count}.bin', data, 'application/octet-stream')}
        last = ''
        for attempt in range(6):
            try:
                r = await self.http.post(f'{TG}/bot{self.bot_token}/sendDocument', data=form, files=files, timeout=300)
                j = r.json()
            except (httpx.HTTPError, ValueError) as e:
                last = type(e).__name__
                await self.sleep(min(60, 2 ** attempt))
                continue
            if j.get('ok'):
                doc = j['result']['document']
                if doc.get('file_size') != len(data):
                    raise JobError('分片上传后大小不对')
                return {'file_id': doc['file_id'], 'size': doc['file_size']}
            wait = (j.get('parameters') or {}).get('retry_after')
            if wait:  # Telegram 限速：按它说的秒数等
                await self.sleep(int(wait) + 1)
                continue
            raise JobError('上传分片失败：' + str(j.get('description') or r.status_code))
        raise JobError('上传分片多次失败：' + last)

    async def report(self, track, status, note):
        try:
            await self.http.post(f'{self.worker_url}/admin/api/status',
                                 json={'track': track, 'status': status, 'note': note}, headers=self.auth, timeout=30)
        except httpx.HTTPError as e:
            log.warning('track %s: progress report failed: %s', track, type(e).__name__)  # 丢一次进度不要紧

    async def commit(self, track, size, parts):
        for attempt in range(5):
            try:
                r = await self.http.post(f'{self.worker_url}/admin/api/commit',
                                         json={'track': track, 'size': size, 'parts': parts}, headers=self.auth, timeout=60)
            except httpx.HTTPError:
                await self.sleep(2 ** attempt)
                continue
            if r.status_code == 200:
                return
            if r.status_code < 500:
                try:
                    reason = r.json().get('error')
                except ValueError:
                    reason = None
                raise JobError('Worker 拒绝登记分片：' + str(reason or r.status_code))
            await self.sleep(2 ** attempt)
        raise JobError('登记分片失败，Worker 一直没响应')

    def clean(self, text):
        return text.replace(self.bot_token, '***') if self.bot_token else text


splitter = None


@asynccontextmanager
async def lifespan(app):
    global splitter
    from telethon import TelegramClient
    from telethon.sessions import StringSession

    env = os.environ
    client = TelegramClient(StringSession(), int(env['TG_API_ID']), env['TG_API_HASH'])
    await client.start(bot_token=env['TG_BOT_TOKEN'])
    log.info('logged in to Telegram as a bot')

    async def fetch_message(channel, message_id):
        msg = await client.get_messages(channel, ids=message_id)
        if not msg or not msg.document:
            return None
        return msg.document.size, msg.document

    def iter_download(document):
        return client.iter_download(document, request_size=REQUEST_SIZE)

    async with httpx.AsyncClient() as http:
        splitter = Splitter(bot_token=env['TG_BOT_TOKEN'], worker_url=env['WORKER_URL'], admin_key=env['ADMIN_KEY'],
                            http=http, fetch_message=fetch_message, iter_download=iter_download)
        task = asyncio.create_task(splitter.run())
        try:
            yield
        finally:
            task.cancel()
            await client.disconnect()


app = FastAPI(lifespan=lifespan, docs_url=None, redoc_url=None, openapi_url=None)


@app.get('/')
async def health():
    return {'ok': True}


@app.post('/split')
async def split(request: Request):
    got = request.headers.get('x-key', '').encode()
    want = os.environ.get('SPLITTER_KEY', '').encode()
    if not want or not hmac.compare_digest(got, want):
        raise HTTPException(403)
    try:
        accepted = splitter.submit(await request.json())
    except (KeyError, TypeError, ValueError):
        raise HTTPException(400) from None
    return {'accepted': accepted}
