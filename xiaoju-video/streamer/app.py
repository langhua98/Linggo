"""小橘视频 · 流式服务（Hugging Face Space）

Worker 管登记、审核和网页；这里干 Worker 干不了的重活：

1. 云电脑（MediaCrawler，见 jobs.py）：扫码登录频道主的抖音（POST /douyin/login，二维码由机器人发给频道主）、
   抓他自己主页的全部作品或指定作品（POST /douyin/crawl），新的送 Worker 交审核机器人；
   不登录的分享页解析（POST /douyin/resolve）在海外机房拿不到作品数据，只作备用；
2. 转作品（POST /douyin/post）：审核通过的作品排进队列，一条条下载、ffmpeg 整理成网页能边下边播的 mp4，
   用频道主的账号发进视频频道（说明里带「#dy<作品号>」），每条转完 POST Worker 的 /streamer-done 报结果；
3. 大视频流（GET /stream/<消息号>）：Bot API 只能下 20 MB 以内的文件，更大的由这里走 MTProto 按 Range 现取现传；
   GET /thumb/<消息号> 给视频自带的封面。

要报给 Worker 的事（每条作品转完的结果、给频道主的话和截图、抓到的作品、抖音登录状态）都放进发件箱（outbox.py），
由 Worker 来取（GET /outbox，长轮询）：Hugging Face 的机房按域名挡掉了 *.workers.dev 和 api.telegram.org，这里主动找不到 Worker。
发件箱带启动号：Worker 看到启动号变了，就知道这里重启过、队列丢了，把之前交过来还没转完的作品再交一次。

环境变量（Space → Settings → Variables and secrets，都设成 secret）：
  TG_API_ID / TG_API_HASH   my.telegram.org 申请的应用凭据
  TG_BOT_TOKEN              小橘视频机器人 token（视频频道的管理员），取文件用
  TG_USER_SESSION           频道主账号的登录凭证（StringSession），发帖用
  VIDEO_CHANNEL_ID          视频频道的数字 id（-100 开头），或私有频道的邀请链接
  STREAMER_KEY              和 Worker 之间的密钥（X-Key 请求头）
  MC_DIR / MC_PY            MediaCrawler 的目录和它的 Python（Dockerfile 里装好，默认 /opt/MediaCrawler、/opt/mc-venv/bin/python）
"""

import asyncio
import hmac
import json
import logging
import os
import re
import shutil
import subprocess
import tempfile
import time
from contextlib import asynccontextmanager

import httpx
from fastapi import FastAPI, HTTPException, Request
from fastapi.responses import JSONResponse, Response, StreamingResponse

import jobs as jobs_mod
from douyin import DESKTOP_UA, Douyin, DouyinError
from outbox import Outbox

# MTProto 每次最多取 512 KB；起点按它对齐，Telegram 才接受
CHUNK = 512 * 1024
# 消息（连同里面的文件引用）缓存多久
MESSAGE_TTL = 30 * 60
MAX_REFRESHES = 3
# 普通账号发帖的说明最多 1024 字
CAPTION_LIMIT = 1024
# 单个视频最大多少（Telegram 普通账号上限 2 GB）
MAX_VIDEO = 2000 * 1024 * 1024
DOWNLOAD_TIMEOUT = 15 * 60

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


def caption_for(item):
    tag = f'#dy{item["aweme"]}'
    desc = (item.get('desc') or '').strip()
    room = CAPTION_LIMIT - len(tag) - 2
    if len(desc) > room:
        desc = desc[:room - 1] + '…'
    return f'{desc}\n\n{tag}' if desc else tag


# ── 大视频流 ──────────────────────────────────────────────────────

class Streamer:
    """取消息、下载的实现由外面注入，方便测试。"""

    def __init__(self, *, fetch_message, iter_download, download_thumb=None, clock=time.monotonic):
        self.fetch_message = fetch_message    # async (消息号) -> Telethon 消息或 None
        self.iter_download = iter_download    # (文件, offset=, request_size=, file_size=) -> 异步迭代的字节块
        self.download_thumb = download_thumb  # async (消息) -> JPEG 字节或 None
        self.clock = clock
        self.cache = {}

    async def message(self, message_id, fresh=False):
        hit = self.cache.get(message_id)
        if hit and not fresh and self.clock() - hit[1] < MESSAGE_TTL:
            return hit[0]
        msg = await self.fetch_message(message_id)
        if msg is None or getattr(msg, 'document', None) is None:
            self.cache.pop(message_id, None)
            return None
        if len(self.cache) > 200:
            self.cache.clear()
        self.cache[message_id] = (msg, self.clock())
        return msg

    async def thumbnail(self, message_id):
        msg = await self.message(message_id)
        if msg is None or not getattr(msg.document, 'thumbs', None):
            return None
        return await self.download_thumb(msg)

    async def body(self, message_id, start, end):
        """边取边吐 [start, end] 这段字节。文件引用在途中过期就重取消息，从断开的地方接着传。"""
        from telethon.errors import FileReferenceExpiredError
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
                return
            except FileReferenceExpiredError:
                refreshes += 1
                if refreshes > MAX_REFRESHES:
                    raise
                log.info('message %s: file reference expired at byte %s, refetching', message_id, pos)
            finally:
                close = getattr(stream, 'aclose', None) or getattr(stream, 'close', None)
                if close:
                    try:
                        await close()
                    except Exception:  # noqa: BLE001 — Telethon 没取过数据就关会报错，不能盖住真正的错误
                        log.debug('closing download iterator failed', exc_info=True)


# ── 转作品 ────────────────────────────────────────────────────────

class Poster:
    """审核通过的作品：一条条下载、整理、发进频道，再报给 Worker。外部依赖都注入，方便测试。"""

    def __init__(self, *, douyin, download, prepare, send_video, send_images, already_posted, report):
        self.douyin = douyin                  # Douyin：视频地址过期时按作品号重新取
        self.download = download              # async (地址, 存到哪) -> None；失败抛异常
        self.prepare = prepare                # async (原文件, 工作目录) -> {path, thumb, duration, width, height}
        self.send_video = send_video          # async (信息, 说明) -> 消息号
        self.send_images = send_images        # async ([图片路径], 说明) -> 第一条的消息号
        self.already_posted = already_posted  # async (作品号) -> 这次运行里已经发过的消息号或 None（防重复发）
        self.report = report                  # (dict) -> None：放进发件箱
        self.queue = []
        self.current = None
        self.wake = asyncio.Event()
        self.done = 0
        self.task = None

    def add(self, items):
        have = {i['aweme'] for i in self.queue}
        if self.current:
            have.add(self.current['aweme'])
        n = 0
        for item in items:
            if isinstance(item, dict) and re.fullmatch(r'\d{6,25}', str(item.get('aweme', ''))) and item['aweme'] not in have:
                self.queue.append(item)
                have.add(item['aweme'])
                n += 1
        self.wake.set()
        return n

    def status(self):
        return {'current': self.current and self.current['aweme'], 'queued': len(self.queue), 'done': self.done}

    def busy(self):
        return bool(self.queue or self.current)

    async def run(self):
        while True:
            if not self.queue:
                self.wake.clear()
                await self.wake.wait()
                continue
            self.current = item = self.queue.pop(0)
            try:
                msg = await self.post(item)
                result = {'aweme': item['aweme'], 'ok': True, 'message_id': msg}
                self.done += 1
            except Exception as e:  # noqa: BLE001 — 一条失败不影响后面的，原因报给 Worker
                log.warning('aweme %s failed: %s', item['aweme'], e)
                result = {'aweme': item['aweme'], 'ok': False, 'error': str(e)[:300] or type(e).__name__}
            self.current = None
            result['idle'] = not self.queue
            self.report(result)

    async def post(self, item):
        old = await self.already_posted(item['aweme'])
        if old:
            return old
        caption = caption_for(item)
        work = tempfile.mkdtemp(prefix='dy')
        try:
            if item.get('type') == 'images':
                urls = item.get('images') or []
                if not urls:
                    urls = (await self.douyin.by_id(item['aweme'], 'note')).get('images') or []
                if not urls:
                    raise DouyinError('图文作品里没有图片')
                paths = []
                for i, u in enumerate(urls):
                    p = os.path.join(work, f'{i:02d}.jpg')
                    await self.download(u, p)
                    paths.append(p)
                return await self.send_images(paths, caption)
            src = os.path.join(work, 'src.mp4')
            try:
                if not item.get('video_url'):
                    raise DouyinError('没有视频地址')
                await self.download(item['video_url'], src)
            except Exception as first:  # noqa: BLE001 — 地址多半过期了，按作品号重新取一次
                log.info('aweme %s: %s, refetching share page', item['aweme'], first)
                fresh = await self.douyin.by_id(item['aweme'])
                if fresh.get('type') == 'images':
                    return await self.post({**item, **fresh})
                await self.download(fresh['video_url'], src)
            info = await self.prepare(src, work)
            return await self.send_video(info, caption)
        finally:
            shutil.rmtree(work, ignore_errors=True)


async def http_download(http, url, path):
    """下载到文件；抖音的视频地址要带 Referer，不然 403"""
    headers = {'User-Agent': DESKTOP_UA, 'Referer': 'https://www.douyin.com/'}
    async with http.stream('GET', url, headers=headers, follow_redirects=True, timeout=DOWNLOAD_TIMEOUT) as r:
        if r.status_code != 200:
            raise DouyinError(f'下载回 {r.status_code}')
        size = 0
        with open(path, 'wb') as f:
            async for chunk in r.aiter_bytes(1 << 20):
                size += len(chunk)
                if size > MAX_VIDEO:
                    raise DouyinError('文件超过 2 GB')
                f.write(chunk)
        if size < 1024:
            raise DouyinError('下载到的文件太小，不像视频')


def run(cmd):
    p = subprocess.run(cmd, capture_output=True, text=True, timeout=DOWNLOAD_TIMEOUT)
    if p.returncode != 0:
        raise RuntimeError(f'{cmd[0]} 失败：{p.stderr.strip()[-300:]}')
    return p.stdout


def ffmpeg_prepare(src, work):
    """不重新编码，只把 moov 挪到文件头（网页才能边下边播）；再截一帧当封面、读出时长和尺寸"""
    out = os.path.join(work, 'video.mp4')
    run(['ffmpeg', '-v', 'error', '-y', '-i', src, '-map', '0', '-c', 'copy', '-movflags', '+faststart', out])
    probe = json.loads(run(['ffprobe', '-v', 'error', '-select_streams', 'v:0', '-show_entries',
                            'stream=width,height:format=duration', '-of', 'json', out]))
    stream = (probe.get('streams') or [{}])[0]
    duration = float((probe.get('format') or {}).get('duration') or 0)
    thumb = os.path.join(work, 'thumb.jpg')
    try:
        run(['ffmpeg', '-v', 'error', '-y', '-ss', str(min(1.0, duration / 2)), '-i', out, '-frames:v', '1',
             '-vf', 'scale=320:320:force_original_aspect_ratio=decrease', '-q:v', '4', thumb])
    except RuntimeError:
        thumb = None
    return {'path': out, 'thumb': thumb, 'duration': int(round(duration)),
            'width': int(stream.get('width') or 0), 'height': int(stream.get('height') or 0)}


# ── 组装 ──────────────────────────────────────────────────────────

streamer = None
poster = None
douyin = None
jobs = None
outbox = Outbox()
state = {'bot': False, 'user': False, 'channel': None, 'channel_id': None}


def check_key(request):
    got = request.headers.get('x-key', '').encode()
    want = os.environ.get('STREAMER_KEY', '').encode()
    if not want or not hmac.compare_digest(got, want):
        raise HTTPException(403)


@asynccontextmanager
async def lifespan(app):
    global streamer, poster, douyin, jobs
    from telethon import TelegramClient
    from telethon.sessions import StringSession
    from telethon.tl.types import DocumentAttributeVideo, PeerChannel

    env = os.environ
    http = httpx.AsyncClient(http2=False)
    douyin = Douyin(http)
    jobs = jobs_mod.Jobs(spawn=jobs_mod.spawn, emit=outbox.put,
                         mc_dir=env.get('MC_DIR', '/opt/MediaCrawler'), mc_py=env.get('MC_PY', '/opt/mc-venv/bin/python'))
    api_id, api_hash = int(env['TG_API_ID']), env['TG_API_HASH']
    # receive_updates=False：只调用、不订阅推送。机器人同时挂在官方 Bot API 上收 webhook，
    # 这里要是订阅了，频道新帖的推送可能被它接走，Worker 就漏登记新视频
    bot = TelegramClient(StringSession(), api_id, api_hash, receive_updates=False)
    await bot.start(bot_token=env['TG_BOT_TOKEN'])
    state['bot'] = True
    user = TelegramClient(StringSession(env['TG_USER_SESSION']), api_id, api_hash, receive_updates=False)
    await user.connect()
    if not await user.is_user_authorized():
        raise RuntimeError('TG_USER_SESSION is not valid')
    await user.get_dialogs()  # 把频道记进缓存，按数字 id 才找得到
    # VIDEO_CHANNEL_ID 可以是数字 id（-100 开头），也可以是私有频道的邀请链接（频道主账号已在频道里）
    ref = env['VIDEO_CHANNEL_ID'].strip()
    channel = await user.get_entity(PeerChannel(int(ref.removeprefix('-100'))) if re.fullmatch(r'-?\d+', ref) else ref)
    state.update(user=True, channel=getattr(channel, 'title', None), channel_id=int(f'-100{channel.id}'))
    log.info('logged in; channel %s', state['channel'])

    # 取文件优先用机器人（它是频道管理员）；它找不到频道就用频道主账号
    try:
        # 只取频道本身的信息确认机器人进得去，不读频道里的帖子
        bot_channel = await bot.get_entity(PeerChannel(channel.id))
        reader, reader_channel = bot, bot_channel
    except Exception:  # noqa: BLE001
        log.warning('bot cannot read the channel, streaming with the user session', exc_info=True)
        reader, reader_channel = user, channel

    async def fetch_message(message_id):
        return await reader.get_messages(reader_channel, ids=message_id)

    async def download_thumb(msg):
        return await reader.download_media(msg, file=bytes, thumb=-1)

    streamer = Streamer(fetch_message=fetch_message, iter_download=reader.iter_download, download_thumb=download_thumb)

    async def send_video(info, caption):
        sent = await user.send_file(
            channel, info['path'], caption=caption, thumb=info['thumb'], supports_streaming=True,
            attributes=[DocumentAttributeVideo(duration=info['duration'], w=info['width'], h=info['height'], supports_streaming=True)])
        return sent.id

    async def send_images(paths, caption):
        first = None
        for i in range(0, len(paths), 10):  # 一个相册最多 10 张
            sent = await user.send_file(channel, paths[i:i + 10], caption=caption if i == 0 else None)
            sent = sent if isinstance(sent, list) else [sent]
            first = first or sent[0].id
        return first

    # 防重复发只看这次运行里自己发过的（频道主要求：不去频道里搜、读帖子的标签）；
    # 重启以后靠 Worker 的作品状态防重：已转的不会再交过来
    posted = {}

    async def already_posted(aweme):
        return posted.get(aweme)

    async def prepare(src, work):
        return await asyncio.to_thread(ffmpeg_prepare, src, work)

    def report(body):
        if body.get('ok'):
            posted[body['aweme']] = body['message_id']
        outbox.put('done', **body)

    poster = Poster(douyin=douyin, download=lambda u, p: http_download(http, u, p), prepare=prepare,
                    send_video=send_video, send_images=send_images, already_posted=already_posted,
                    report=report)
    poster.task = asyncio.create_task(poster.run())

    try:
        yield
    finally:
        poster.task.cancel()
        await user.disconnect()
        await bot.disconnect()
        await http.aclose()


app = FastAPI(lifespan=lifespan, docs_url=None, redoc_url=None, openapi_url=None)


@app.get('/outbox')
async def outbox_get(request: Request, boot: str = '', after: int = 0, wait: int = 0):
    """Worker 来取要报的事：先扔掉它说处理过的（启动号对得上才扔），没事就最多等 wait 秒（长轮询）"""
    check_key(request)
    outbox.ack(boot, after)
    await outbox.wait(max(0, min(wait, 25)))
    return {'boot': outbox.boot, 'events': outbox.batch(),
            'busy': bool((jobs and jobs.current) or (poster and poster.busy()))}


@app.get('/')
async def health():
    return {'ok': True, **state, 'poster': poster.status() if poster else None, 'jobs': jobs.status() if jobs else None}


@app.get('/stream/{message_id}')
async def stream(message_id: int, request: Request):
    check_key(request)
    msg = await streamer.message(message_id)
    if msg is None:
        return JSONResponse({'detail': 'gone'}, status_code=404)
    size = msg.document.size
    rng = parse_range(request.headers.get('range'), size)
    if rng is None:
        return Response(status_code=416, headers={'Content-Range': f'bytes */{size}'})
    start, end, partial = rng
    headers = {'Accept-Ranges': 'bytes', 'Content-Length': str(end - start + 1)}
    if partial:
        headers['Content-Range'] = f'bytes {start}-{end}/{size}'
    return StreamingResponse(streamer.body(message_id, start, end), status_code=206 if partial else 200,
                             headers=headers, media_type=msg.document.mime_type or 'video/mp4')


@app.get('/thumb/{message_id}')
async def thumb(message_id: int, request: Request):
    check_key(request)
    data = await streamer.thumbnail(message_id)
    if not data:
        raise HTTPException(404)
    return Response(content=data, media_type='image/jpeg')


@app.post('/douyin/resolve')
async def resolve(request: Request):
    check_key(request)
    body = await request.json()
    try:
        item = await douyin.resolve(str(body.get('url', '')))
    except DouyinError as e:
        return JSONResponse({'error': str(e)}, status_code=400)
    except httpx.HTTPError as e:
        return JSONResponse({'error': f'连不上抖音：{type(e).__name__}'}, status_code=502)
    return {'item': item}


@app.post('/douyin/post')
async def post_items(request: Request):
    check_key(request)
    body = await request.json()
    items = body.get('items') if isinstance(body, dict) else None
    if not isinstance(items, list):
        raise HTTPException(400)
    return {'ok': True, 'added': poster.add(items), **poster.status()}


@app.get('/douyin/status')
async def post_status(request: Request):
    check_key(request)
    return poster.status()


# ── 云电脑（MediaCrawler）：都要 X-Key，由 Worker 转过来 ──────────────────────

def busy(e):
    return JSONResponse({'busy': str(e)}, status_code=409)


@app.post('/douyin/login')
async def douyin_login(request: Request):
    check_key(request)
    body = await request.json()
    try:
        jobs.login(int(body['chat_id']))
    except jobs_mod.Busy as e:
        return busy(e)
    except (KeyError, TypeError, ValueError):
        raise HTTPException(400)
    return {'ok': True}


@app.post('/douyin/login/input')
async def douyin_login_input(request: Request):
    """登录进行中频道主发来的话（短信验证码、选哪种验证、截图、取消登录），交给登录页"""
    check_key(request)
    body = await request.json()
    if not jobs.input(str(body.get('text', ''))):
        return JSONResponse({'error': 'no login running'}, status_code=409)
    return {'ok': True}


@app.post('/douyin/crawl')
async def douyin_crawl(request: Request):
    """mode=creator：抓登录账号自己的主页（地址由 session 里的 sec_uid 拼）；mode=detail：抓 targets 里的作品"""
    check_key(request)
    body = await request.json()
    mode = body.get('mode')
    if mode not in ('creator', 'detail') or not isinstance(body.get('session'), dict):
        raise HTTPException(400)
    try:
        jobs.crawl(int(body['chat_id']), body['session'], mode, body.get('targets') or [],
                   'cloud' if mode == 'creator' else 'link')
    except jobs_mod.Busy as e:
        return busy(e)
    except ValueError as e:
        return JSONResponse({'error': str(e)}, status_code=400)
    except (KeyError, TypeError):
        raise HTTPException(400)
    return {'ok': True}


@app.get('/douyin/jobs')
async def douyin_jobs(request: Request):
    check_key(request)
    return jobs.status()


@app.get('/debug/net')
async def debug_net(request: Request):
    """排查出站网络：解析、TCP 直连、HTTPS 请求几个要用的地址（要 X-Key）"""
    import socket
    check_key(request)
    out = {}
    for host in ('xiaoju-video.langhua98.workers.dev', 'api.telegram.org', 'www.douyin.com', 'huggingface.co'):
        r = {}
        try:
            infos = await asyncio.get_running_loop().getaddrinfo(host, 443, type=socket.SOCK_STREAM)
            r['addrs'] = sorted({f'{"v6" if i[0] == socket.AF_INET6 else "v4"} {i[4][0]}' for i in infos})
        except Exception as e:  # noqa: BLE001
            r['dns'] = repr(e)
        try:
            async with httpx.AsyncClient(timeout=10) as c:
                res = await c.get(f'https://{host}/')
                r['https'] = res.status_code
        except Exception as e:  # noqa: BLE001
            r['https'] = f'{type(e).__name__}: {e}'[:200]
        out[host] = r
    return out
