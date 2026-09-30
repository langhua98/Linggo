"""小橘音乐 · 大文件流式服务（Hugging Face Space）

Telegram 官方 Bot API 只能下载 20 MB 以内的文件，机器人走 MTProto 却没有这个限制。小橘音乐的
Worker 遇到超过 20 MB 的歌，就把浏览器的 Range 请求转到这里（GET /stream/<消息号>）。这里用 Telethon
以机器人身份按消息号取到频道里的原文件，浏览器要哪一段，就从 Telegram 现取哪一段、边取边传：
不落盘，也不用等整首下完。另外 GET /thumb/<消息号> 给出音乐文件自带的专辑封面，Worker 取一次就存起来。

环境变量（在 Space 的 Settings → Variables and secrets 里设成 secret）：
  TG_API_ID / TG_API_HASH   my.telegram.org 申请的应用凭据
  TG_BOT_TOKEN              机器人 token（和 Worker 里的是同一个）
  TG_CHANNEL                频道用户名，xiaojumusic
  STREAMER_KEY              Worker 转发请求时带的密钥（X-Key 请求头）
"""

import hmac
import logging
import os
import re
import time
from contextlib import asynccontextmanager

from fastapi import FastAPI, HTTPException, Request
from fastapi.responses import Response, StreamingResponse
from telethon import TelegramClient
from telethon.errors import FileReferenceExpiredError
from telethon.sessions import StringSession

# MTProto 每次最多取 512 KB；起点按它对齐，Telegram 才接受
CHUNK = 512 * 1024
# 消息（连同里面的文件引用）缓存多久。引用在下载途中过期会报错，到时候再重取
MESSAGE_TTL = 30 * 60
# 同一次传输里最多重取几次消息
MAX_REFRESHES = 3

logging.basicConfig(level=logging.INFO, format='%(asctime)s %(levelname)s %(message)s')
log = logging.getLogger('streamer')


def parse_range(header, total):
    """返回 (start, end, partial)；范围没法满足返回 None。认不出的格式、多段 Range 当作要整个文件。"""
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


class Streamer:
    """下载和取消息的实现由外面注入，方便测试。"""

    def __init__(self, *, channel, fetch_message, iter_download, download_thumb=None, download_photo=None,
                 clock=time.monotonic):
        self.channel = channel
        self.fetch_message = fetch_message    # async (频道, 消息号) -> Telethon 消息或 None
        self.iter_download = iter_download    # (文件, offset=, request_size=, file_size=) -> 异步迭代的字节块
        self.download_thumb = download_thumb  # async (消息) -> 封面缩略图的 JPEG 字节或 None
        self.download_photo = download_photo  # async (消息) -> 图片帖里合适尺寸的 JPEG 字节
        self.scan = None                      # (upto, 图片帖消息号列表, 扫描时间)
        self.clock = clock
        self.cache = {}  # 消息号 -> (消息, 取到的时间)

    async def message(self, message_id, fresh=False):
        hit = self.cache.get(message_id)
        if hit and not fresh and self.clock() - hit[1] < MESSAGE_TTL:
            return hit[0]
        msg = await self.fetch_message(self.channel, message_id)
        if msg is None or getattr(msg, 'document', None) is None:
            self.cache.pop(message_id, None)
            return None
        if len(self.cache) > 200:
            self.cache.clear()
        self.cache[message_id] = (msg, self.clock())
        return msg

    async def thumbnail(self, message_id):
        """音乐文件自带的专辑封面（Telegram 生成的缩略图，最大那张，通常 320×320）；没有就返回 None。"""
        msg = await self.message(message_id)
        if msg is None or not getattr(msg.document, 'thumbs', None):
            return None
        return await self.download_thumb(msg)

    async def photo_ids(self, upto):
        """频道里 1..upto 号消息中哪些是图片帖。机器人不能翻历史，只能按消息号每 100 条批量取。结果缓存 10 分钟。"""
        if self.scan and self.scan[0] >= upto and self.clock() - self.scan[2] < 600:
            return self.scan[1]
        ids = []
        for first in range(1, upto + 1, 100):
            msgs = await self.fetch_message(self.channel, list(range(first, min(first + 100, upto + 1))))
            ids += [m.id for m in msgs if m is not None and getattr(m, 'photo', None)]
        self.scan = (upto, ids, self.clock())
        return ids

    async def photo(self, message_id):
        msg = await self.fetch_message(self.channel, message_id)
        if msg is None or not getattr(msg, 'photo', None):
            return None
        return await self.download_photo(msg)

    async def body(self, message_id, start, end):
        """边取边吐 [start, end] 这段字节。文件引用在途中过期就重取消息，从断开的地方接着传。"""
        pos = start
        refreshes = 0
        while pos <= end:
            msg = await self.message(message_id, fresh=refreshes > 0)
            if msg is None:
                raise RuntimeError(f'message {message_id} disappeared mid-stream')
            doc = msg.document
            aligned = pos - pos % CHUNK
            skip = pos - aligned
            stream = self.iter_download(doc, offset=aligned, request_size=CHUNK, file_size=doc.size)
            try:
                async for chunk in stream:
                    if skip:
                        if len(chunk) <= skip:
                            skip -= len(chunk)
                            continue
                        chunk, skip = chunk[skip:], 0
                    chunk = chunk[:end - pos + 1]
                    yield chunk
                    pos += len(chunk)
                    if pos > end:
                        return
                return  # 文件比预期短：到此为止，响应长度对不上，Worker 会发现
            except FileReferenceExpiredError:
                refreshes += 1
                if refreshes > MAX_REFRESHES:
                    raise
                log.info('message %s: file reference expired at byte %s, refetching', message_id, pos)
            finally:
                # 提前退出（传够了、出错、浏览器断开）时要主动关掉，Telethon 才会归还连到别的数据中心的连接
                close = getattr(stream, 'aclose', None) or getattr(stream, 'close', None)
                if close:
                    try:
                        await close()
                    except Exception:  # noqa: BLE001 — Telethon 没取过数据就关会报 AttributeError，不能盖住真正的错误
                        log.debug('closing download iterator failed', exc_info=True)


def make_client(env):
    # receive_updates=False：这个 MTProto 会话只调用、不订阅推送。机器人同时挂在官方 Bot API 上收
    # webhook，Telegram 给同一个机器人的推送可能只送到其中一个会话；这里要是订阅了，频道新帖的推送
    # 就可能被它接走，Worker 就漏登记新歌（自建 telegram-bot-api 要先 logOut 官方服务器也是这个原因）
    return TelegramClient(StringSession(), int(env['TG_API_ID']), env['TG_API_HASH'], receive_updates=False)


streamer = None


@asynccontextmanager
async def lifespan(app):
    global streamer
    env = os.environ
    client = make_client(env)
    await client.start(bot_token=env['TG_BOT_TOKEN'])
    log.info('logged in to Telegram as a bot')

    async def fetch_message(channel, message_id):
        return await client.get_messages(channel, ids=message_id)

    async def download_thumb(msg):
        # 传消息本身（不是 msg.document）：Telethon 才能在文件引用过期时自己重取消息
        return await client.download_media(msg, file=bytes, thumb=-1)

    async def download_photo(msg):
        # 取边长不超过 800 的最大一档（当封面够清楚，又不至于太大）；都超过就取最小的
        sizes = [s for s in msg.photo.sizes if getattr(s, 'w', 0) and getattr(s, 'h', 0)]
        fit = [s for s in sizes if max(s.w, s.h) <= 800]
        size = max(fit, key=lambda s: s.w * s.h) if fit else min(sizes, key=lambda s: s.w * s.h)
        return await client.download_media(msg, file=bytes, thumb=size)

    streamer = Streamer(channel=env.get('TG_CHANNEL', 'xiaojumusic'), fetch_message=fetch_message,
                        iter_download=client.iter_download, download_thumb=download_thumb, download_photo=download_photo)
    try:
        yield
    finally:
        await client.disconnect()


app = FastAPI(lifespan=lifespan, docs_url=None, redoc_url=None, openapi_url=None)


@app.get('/')
async def health():
    return {'ok': True}


def check_key(request):
    got = request.headers.get('x-key', '').encode()
    want = os.environ.get('STREAMER_KEY', '').encode()
    if not want or not hmac.compare_digest(got, want):
        raise HTTPException(403)


@app.get('/thumb/{message_id}')
async def thumb(message_id: int, request: Request):
    check_key(request)
    data = await streamer.thumbnail(message_id)
    if not data:
        raise HTTPException(404)
    return Response(content=data, media_type='image/jpeg')


@app.get('/photos')
async def photos(upto: int, request: Request):
    check_key(request)
    return {'photos': await streamer.photo_ids(max(1, min(upto, 100000)))}


@app.get('/photo/{message_id}')
async def photo(message_id: int, request: Request):
    check_key(request)
    data = await streamer.photo(message_id)
    if not data:
        raise HTTPException(404)
    return Response(content=data, media_type='image/jpeg')


@app.get('/stream/{message_id}')
async def stream(message_id: int, request: Request):
    check_key(request)
    msg = await streamer.message(message_id)
    if msg is None:
        raise HTTPException(404)
    size = msg.document.size
    rng = parse_range(request.headers.get('range'), size)
    if rng is None:
        return Response(status_code=416, headers={'Content-Range': f'bytes */{size}'})
    start, end, partial = rng
    headers = {'Accept-Ranges': 'bytes', 'Content-Length': str(end - start + 1)}
    if partial:
        headers['Content-Range'] = f'bytes {start}-{end}/{size}'
    return StreamingResponse(streamer.body(message_id, start, end), status_code=206 if partial else 200,
                             headers=headers, media_type='application/octet-stream')
