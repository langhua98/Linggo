"""小橘视频 · 抖音转进视频频道的服务（Hugging Face Space）

小橘视频的 Worker 把抖音的活交给这里：用无头 Chromium 不登录打开抖音网页版拿作品、下载、过 ffmpeg，再用频道主自己的账号
发进视频频道（TG_USER_SESSION）。视频频道由 Worker 在请求里给（target）。

抖音（不登录，见 douyin/）：POST /douyin/link 发作品链接 → 转进视频频道，发主页链接 → 采集这个账号作品的链接；
POST /douyin/mirror 把一个账号能看到的视频都转进视频频道；POST /douyin/import 转云电脑（cloud/）抓来的作品；
GET /douyin/status 看上一次的结果（采集到的链接也在里面）。

视频频道里超过 20 MB 的视频，Worker 转到这里按消息号取：GET /vstream/<消息号>?target=…（机器人身份，边取边传），
封面 GET /vthumb/<消息号>，视频池 GET /videos（要翻频道历史，用频道主账号，只读）。

小橘音乐是另一个项目，在 ../../xiaoju-music/：自己的流式服务、自己的 Space，和这里没有任何共用的代码。

环境变量（在 Space 的 Settings → Variables and secrets 里设成 secret）：
  TG_API_ID / TG_API_HASH   my.telegram.org 申请的应用凭据
  TG_BOT_TOKEN              机器人 token（和小橘视频 Worker 里的是同一个）
  STREAMER_KEY              Worker 转发请求时带的密钥（X-Key 请求头）
  TG_USER_SESSION           频道主账号的登录凭证，发进视频频道、翻频道用；由 /login/verify 生成
  WORKER_URL                小橘视频 Worker 的地址，默认 https://xiaoju-video.langhua98.workers.dev。
                            启动时告诉它「重启过了」（它把没转完的抖音任务再交一次），任务转完告诉它销掉记录
"""

import asyncio
import hmac
import json
import logging
import os
import re
import subprocess
import shutil
import tempfile
import time
import urllib.request
from contextlib import asynccontextmanager

from fastapi import FastAPI, HTTPException, Request
from fastapi.responses import Response, StreamingResponse
from telethon import TelegramClient
from telethon.errors import (FileReferenceExpiredError,
    FloodWaitError,
    ImageProcessFailedError,
    PhotoExtInvalidError,
    PhotoInvalidDimensionsError,
    PhotoSaveFileInvalidError,
    SessionPasswordNeededError)
from telethon.tl.functions.upload import SaveBigFilePartRequest
from telethon.tl.types import DocumentAttributeVideo, InputFileBig, InputMessagesFilterVideo
from telethon.sessions import StringSession

from douyin import links as dy_links
from douyin.job import DouyinJob
from douyin.items import caption as dy_caption, hashtag as dy_hashtag
from douyin.login import QrLogin, restore_state, state_logged_in
from douyin.mcimport import parse_export
from douyin.web import STATE_FILE as DOUYIN_STATE_FILE, DouyinWeb, DownloadError as DouyinDownloadError

# MTProto 每次最多取 512 KB；起点按它对齐，Telegram 才接受
CHUNK = 512 * 1024

# 消息（连同里面的文件引用）缓存多久。引用在下载途中过期会报错，到时候再重取
MESSAGE_TTL = 30 * 60

# 同一次传输里最多重取几次消息
MAX_REFRESHES = 3

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

def norm(s):
    return re.sub(r'[\W_]+', '', (s or '').lower())

class Login:
    """账号登录两步走：先发验证码，再用验证码（开了两步验证时再加密码）登录。"""

    def __init__(self, make_user_client):
        self.make_user_client = make_user_client
        self.pending = None  # (客户端, 手机号, phone_code_hash)
        self.need_password = False

    async def send_code(self, phone):
        client = self.make_user_client(StringSession())
        await client.connect()
        sent = await client.send_code_request(phone)
        self.pending, self.need_password = (client, phone, sent.phone_code_hash), False

    async def verify(self, code, password=None):
        """成功返回已登录的客户端；要两步验证密码而没给时抛 SessionPasswordNeededError（可以带密码再调一次）。"""
        if not self.pending:
            raise RuntimeError('no code requested')
        client, phone, code_hash = self.pending
        if not self.need_password:
            try:
                await client.sign_in(phone=phone, code=code, phone_code_hash=code_hash)
            except SessionPasswordNeededError:
                self.need_password = True  # 验证码已经对了，下次只交密码
        if self.need_password:
            if not password:
                raise SessionPasswordNeededError(request=None)
            await client.sign_in(password=password)
        self.pending, self.need_password = None, False
        return client

def make_client(env):
    # receive_updates=False：这个 MTProto 会话只调用、不订阅推送。机器人同时挂在官方 Bot API 上收
    # webhook，Telegram 给同一个机器人的推送可能只送到其中一个会话；这里要是订阅了，频道新帖的推送
    # 就可能被它接走，Worker 就漏登记新歌（自建 telegram-bot-api 要先 logOut 官方服务器也是这个原因）
    return TelegramClient(StringSession(), int(env['TG_API_ID']), env['TG_API_HASH'], receive_updates=False)

streamer = None

douyin_job = None   # 抖音视频转到频道

douyin_login = None  # 频道主扫码登录抖音

bot_client = None   # 机器人账号（取文件、发通知）

user_client = None  # 频道主账号（搬歌用），没登录时为 None

login = None

def set_user_client(client):
    global user_client
    user_client = client

async def bot_say(chat_id, text):
    """用机器人给某个聊天发消息（通知频道主、回复求歌的人）。对方得先和机器人说过话才收得到。"""
    if bot_client is None:
        return
    await bot_client.send_message(int(chat_id), text, link_preview=False)

def worker_url():
    return os.environ.get('WORKER_URL', 'https://xiaoju-video.langhua98.workers.dev').rstrip('/')

worker_link = {'ok_at': 0, 'fail_at': 0, 'fails': 0, 'error': '', 'path': ''}  # 最近一次连 Worker 成功、失败的情况（进度里显示）

async def tell_worker(path, data):
    """POST 给 Worker（带同一个 STREAMER_KEY）。失败就抛出去，调用方自己决定要不要重试；成功、失败都记进 worker_link"""
    try:
        got = await _post_worker(path, data)
    except Exception as e:
        worker_link.update(fail_at=int(time.time()), fails=worker_link['fails'] + 1, error=f'{type(e).__name__}: {e}'[:160], path=path)
        raise
    worker_link.update(ok_at=int(time.time()), fails=0)
    return got

async def _post_worker(path, data):
    req = urllib.request.Request(worker_url() + path, data=json.dumps(data).encode(), method='POST', headers={
        'Content-Type': 'application/json', 'X-Key': os.environ.get('STREAMER_KEY', ''),
        'User-Agent': 'xiaoju-streamer'})
    raw = await asyncio.to_thread(lambda: urllib.request.urlopen(req, timeout=60).read())
    try:
        return json.loads(raw or b'{}')
    except ValueError:
        return {}

async def douyin_ended(st):
    """抖音任务转完了或出错了：告诉 Worker 销掉「重启后接着转」的记录（叫停的 Worker 自己会销）"""
    if not st.get('run_id'):
        return
    for wait in (0, 10, 60):  # 连 Worker 偶尔握手就断（SSL EOF）：隔一会儿再试；都不行 Worker 的定时任务也会补上
        await asyncio.sleep(wait)
        try:
            await tell_worker('/streamer-done', {'run_id': st['run_id'], 'status': st.get('status')})
            return
        except Exception as e:  # noqa: BLE001
            log.warning('telling the Worker the run ended failed: %s', e)

async def announce_up():
    """刚启动：告诉 Worker 这边重启过了，它会把重启前没转完的抖音任务再交一次（已经发进频道的会跳过）"""
    for wait in (5, 20, 60, 120, 300):
        await asyncio.sleep(wait)
        try:
            got = await tell_worker('/streamer-up', {})
        except Exception as e:  # noqa: BLE001
            log.warning('telling the Worker we are up failed: %s', e)
            continue
        if not got.get('retry'):  # 交上了，或者本来就没有没转完的
            log.info('told the Worker we are up (resumed: %s)', bool(got.get('resumed')))
            return
        log.info('the Worker could not hand the unfinished run back yet, will report again')

def note_run(body):
    """Worker 给这次任务编的号，记进状态里：转完时报回去，它对上号才销记录"""
    if body.get('run_id'):
        douyin_job.state['run_id'] = str(body['run_id'])[:40]

@asynccontextmanager
async def lifespan(app):
    env = os.environ
    client = make_client(env)
    await client.start(bot_token=env['TG_BOT_TOKEN'])
    global bot_client, douyin_job, douyin_login, login
    bot_client = client
    douyin_job = DouyinJob(web=DouyinWeb, send_video=douyin_post_video, prepare_video=douyin_prepare_video, send_images=douyin_send_images, retag=douyin_retag,
                           posted_ids=douyin_posted, say=bot_say, on_end=douyin_ended)
    # 抖音登录：Worker 的登录页上扫码。登录 cookie 在 /tmp，Space 重启就没了，
    # Worker 存了一份，每次调抖音接口都带上（state），这边缺了就写回去
    douyin_login = QrLogin(web=DouyinWeb)
    log.info('logged in to Telegram as a bot')

    login = Login(lambda session: TelegramClient(session, int(env['TG_API_ID']), env['TG_API_HASH'], receive_updates=False))
    if env.get('TG_USER_SESSION'):
        try:
            u = login.make_user_client(StringSession(env['TG_USER_SESSION']))
            await u.connect()
            if await u.is_user_authorized():
                set_user_client(u)
                # 把聊天列表里的频道先记进缓存：用名字找已加入的频道时就不用再「查用户名」，
                # 查用户名的次数 Telegram 卡得很严，多查几次就要等好几个小时
                await u.get_dialogs()
                log.info('user session ready')
            else:
                log.warning('TG_USER_SESSION is no longer valid')
        except Exception:  # noqa: BLE001 — 发不了帖不影响别的
            log.exception('user session failed')
    up = asyncio.create_task(announce_up())
    try:
        yield
    finally:
        up.cancel()
        if douyin_job and douyin_job.running():
            douyin_job.task.cancel()
        if user_client:
            await user_client.disconnect()
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

def ranged(s, msg, message_id, request):
    """按浏览器的 Range 边取边传这条消息里的文件（Worker 转过来的请求）"""
    size = msg.document.size
    rng = parse_range(request.headers.get('range'), size)
    if rng is None:
        return Response(status_code=416, headers={'Content-Range': f'bytes */{size}'})
    start, end, partial = rng
    headers = {'Accept-Ranges': 'bytes', 'Content-Length': str(end - start + 1)}
    if partial:
        headers['Content-Range'] = f'bytes {start}-{end}/{size}'
    return StreamingResponse(s.body(message_id, start, end), status_code=206 if partial else 200,
                             headers=headers, media_type='application/octet-stream')

@app.post('/login/code')
async def login_code(request: Request):
    check_key(request)
    phone = str((await request.json()).get('phone', '')).strip()
    if not re.fullmatch(r'\+?\d{6,16}', phone):
        raise HTTPException(400, 'bad phone')
    await login.send_code(phone)
    return {'ok': True}

@app.post('/login/verify')
async def login_verify(request: Request):
    check_key(request)
    body = await request.json()
    try:
        client = await login.verify(str(body.get('code', '')).strip(), body.get('password') or None)
    except SessionPasswordNeededError:
        return {'ok': False, 'need_password': True}
    set_user_client(client)
    me = await client.get_me()
    # 登录凭证只在这里给一次，要存成 Space 的 secret（TG_USER_SESSION），重启后才还能用
    return {'ok': True, 'session': client.session.save(),
            'me': {'id': me.id, 'name': ' '.join(x for x in [me.first_name, me.last_name] if x), 'username': me.username}}

# ── 抖音视频转到频道（不登录；逻辑在 douyin/ 里）────────────────────────

def probe_seconds(path):
    """视频有几秒（MediaCrawler 导出的作品不带时长）；量不出 → 0"""
    try:
        r = subprocess.run(['ffprobe', '-v', 'error', '-show_entries', 'format=duration', '-of', 'csv=p=0', path],
                           capture_output=True, text=True, timeout=60)
        return round(float(r.stdout.strip()))
    except (OSError, subprocess.TimeoutExpired, ValueError):
        return 0

def is_faststart(data):
    """MP4 的索引（moov）已经在视频数据（mdat）前面：不用再过一遍 ffmpeg 就能边下边播"""
    pos = 0
    while pos + 8 <= len(data):
        size, kind = int.from_bytes(data[pos:pos + 4], 'big'), data[pos + 4:pos + 8]
        if kind == b'moov':
            return True
        if kind == b'mdat':
            return False
        if size == 1 and pos + 16 <= len(data):
            size = int.from_bytes(data[pos + 8:pos + 16], 'big')
        if size < 8:
            return False
        pos += size
    return False

def remux_faststart(src, dst):
    """把索引（moov）挪到文件开头，Telegram 才能边下边播；顺便确认是个完好的视频。不行返回 False"""
    try:
        r = subprocess.run(['ffmpeg', '-v', 'error', '-y', '-i', src, '-c', 'copy', '-movflags', '+faststart', dst],
                           capture_output=True, timeout=300)
    except (OSError, subprocess.TimeoutExpired):
        return False
    return r.returncode == 0 and os.path.exists(dst) and os.path.getsize(dst) > 0

def video_thumb(src, dst):
    """第一秒的画面缩成长边 320 的 JPEG（Telegram 对视频缩略图的要求）。不行返回 False"""
    try:
        r = subprocess.run(['ffmpeg', '-v', 'error', '-y', '-ss', '0.5', '-i', src, '-frames:v', '1', '-q:v', '5',
                            '-vf', "scale='if(gt(iw,ih),320,-2)':'if(gt(iw,ih),-2,320)'", dst], capture_output=True, timeout=60)
    except (OSError, subprocess.TimeoutExpired):
        return False
    return r.returncode == 0 and os.path.exists(dst) and 0 < os.path.getsize(dst) < 200 * 1024

def parse_target(v):
    """抖音视频发去哪个频道：私有频道是 -100 开头的数字 id，公开频道也可以写用户名；认不出 → None"""
    s = str(v if v is not None else '').strip()
    if re.fullmatch(r'-100\d{5,15}', s):
        return int(s)
    if re.fullmatch(r'@?[A-Za-z]\w{3,63}', s):
        return s.lstrip('@')
    return None

async def channel_entity(client, target):
    """频道 → 能发帖的实体。刚建的私有频道还不在会话缓存里（缓存是启动时从聊天列表填的）：刷新一次再找"""
    try:
        return await client.get_input_entity(target)
    except ValueError:
        if client is user_client:
            await client.get_dialogs()
            return await client.get_input_entity(target)
        return await client.get_entity(target)  # 机器人没有聊天列表，按 id 直接问

async def flood_retry(send, tries=3):
    """发帖碰上 Telegram 限流（FloodWait）：等它说的秒数再发，最多等 10 分钟"""
    for i in range(tries):
        try:
            return await send()
        except FloodWaitError as e:
            if i == tries - 1 or e.seconds > 600:
                raise
            await asyncio.sleep(e.seconds + 1)

UPLOAD_PART = 512 * 1024  # Telegram 允许的最大分块

UPLOAD_BIG = 10 * 1024 * 1024  # 超过这么大 Telegram 要求按「大文件」分块传

UPLOAD_WORKERS = 8

upload_gate = asyncio.Semaphore(12)  # 几条视频同时上传时，整个服务一共最多同时传这么多块（免得被 Telegram 限流）

async def upload_parallel(client, path):
    """大文件同时传几块（Telethon 自己是一块传完再传下一块，每块都要等一个来回），小文件交给 Telethon"""
    size = os.path.getsize(path)
    if size <= UPLOAD_BIG:
        return await client.upload_file(path)
    file_id, parts = int.from_bytes(os.urandom(8), 'big', signed=True), -(-size // UPLOAD_PART)
    gate = asyncio.Semaphore(UPLOAD_WORKERS)

    def read(n):
        with open(path, 'rb') as f:
            f.seek(n * UPLOAD_PART)
            return f.read(UPLOAD_PART)

    async def put(n):
        async with gate, upload_gate:
            chunk = await asyncio.to_thread(read, n)
            for _ in range(3):
                try:
                    if await client(SaveBigFilePartRequest(file_id, n, parts, chunk)):
                        return
                except FloodWaitError as e:
                    if e.seconds > 600:
                        raise
                    await asyncio.sleep(e.seconds + 1)
            raise RuntimeError(f'第 {n} 块传不上去')

    await asyncio.gather(*(put(n) for n in range(parts)))
    return InputFileBig(file_id, parts, os.path.basename(path))

class PreparedVideo:
    """处理好、已经传到 Telegram、只差发帖的视频（临时目录里放着缩略图，发完或不发了就 close 删掉）"""

    def __init__(self, d, file, thumb, attrs):
        self.dir, self.file, self.thumb, self.attrs = d, file, thumb, attrs

    def close(self):
        shutil.rmtree(self.dir, ignore_errors=True)

async def douyin_prepare_video(data, item, src, target):
    """下载好的视频：挪 moov、截缩略图、分块传到 Telegram（几条可以同时做），还不发帖"""
    client = user_client or bot_client
    d = tempfile.mkdtemp()
    try:
        raw, mp4, jpg = (os.path.join(d, n) for n in ('raw.mp4', f'douyin_{item["id"]}.mp4', 'thumb.jpg'))
        ready = is_faststart(data)
        with open(mp4 if ready else raw, 'wb') as f:
            f.write(data)
        del data
        t0 = time.monotonic()
        path = mp4 if ready or await asyncio.to_thread(remux_faststart, raw, mp4) else raw
        seconds = item['seconds'] or await asyncio.to_thread(probe_seconds, path)
        thumb = jpg if await asyncio.to_thread(video_thumb, path, jpg) else None
        t1 = time.monotonic()
        file = await upload_parallel(client, path)
        t2 = time.monotonic()
        mb = os.path.getsize(path) / 1048576
        log.info('douyin %s ffmpeg %.1fs%s，上传 %.1fMB 用了 %.1fs（%.2fMB/s）', item['id'], t1 - t0, '' if not ready else '（本来就能边下边播，没挪）',
                 mb, t2 - t1, mb / max(t2 - t1, 0.01))
        for f in (raw, mp4):
            if os.path.exists(f):
                os.remove(f)  # 传上去了，本地这份不用了（只留缩略图）
        attrs = [DocumentAttributeVideo(duration=seconds, w=src.get('width') or item['width'] or 720,
                                        h=src.get('height') or item['height'] or 1280, supports_streaming=True)]
        return PreparedVideo(d, file, thumb, attrs)
    except BaseException:
        shutil.rmtree(d, ignore_errors=True)
        raise

async def douyin_post_video(prep, text, target):
    """备好的视频发进 target 频道，返回消息号。和搬歌一样用频道主账号发；没登录就用机器人发"""
    client = user_client or bot_client
    t0 = time.monotonic()
    try:
        chat = await channel_entity(client, target)
        sent = await flood_retry(lambda: client.send_file(
            chat, prep.file, caption=text, thumb=prep.thumb, supports_streaming=True, link_preview=False,
            mime_type='video/mp4', attributes=prep.attrs))
    finally:
        prep.close()
    log.info('douyin 发帖 %.1fs → 消息 %s', time.monotonic() - t0, sent.id)
    return sent.id

def to_photo(data):
    """图 → (字节, 扩展名)，Telegram 能当照片发的格式。JPEG、PNG 原样；别的（抖音常给 WebP，Telegram 不当照片）用
    ffmpeg 转成 JPEG。转不了 → None"""
    if data[:3] == b'\xff\xd8\xff':
        return data, '.jpg'
    if data[:8] == b'\x89PNG\r\n\x1a\n':
        return data, '.png'
    try:
        r = subprocess.run(['ffmpeg', '-v', 'error', '-i', 'pipe:0', '-frames:v', '1', '-q:v', '2', '-f', 'mjpeg', 'pipe:1'],
                           input=data, capture_output=True, timeout=60)
    except (OSError, subprocess.TimeoutExpired):
        return None
    return (r.stdout, '.jpg') if r.returncode == 0 and r.stdout[:3] == b'\xff\xd8\xff' else None

PHOTO_REJECTED = (PhotoInvalidDimensionsError, PhotoSaveFileInvalidError, ImageProcessFailedError, PhotoExtInvalidError)

async def douyin_send_images(images, item, text, target):
    """图文发进 target 频道：发成相册（一组最多 10 张，多了 Telethon 自动分组；说明在第一张上），返回第一条的消息号。
    长得太夸张的长图 Telegram 不收当照片：那就整条当文件发"""
    client = user_client or bot_client
    chat = await channel_entity(client, target)
    with tempfile.TemporaryDirectory() as d:
        paths = []
        for n, data in enumerate(images, 1):
            got = await asyncio.to_thread(to_photo, data)
            if got is None:
                raise DouyinDownloadError(f'第 {n} 张图的格式认不出')
            paths.append(os.path.join(d, f'douyin_{item["id"]}_{n:02d}{got[1]}'))
            with open(paths[-1], 'wb') as f:
                f.write(got[0])
        files = paths if len(paths) > 1 else paths[0]  # 只有一张就别发成相册
        try:
            sent = await flood_retry(lambda: client.send_file(chat, files, caption=text, link_preview=False))
        except PHOTO_REJECTED:
            sent = await flood_retry(lambda: client.send_file(chat, files, caption=text, link_preview=False, force_document=True))
    return (sent[0] if isinstance(sent, list) else sent).id

DOUYIN_ID_IN_TEXT = re.compile(r'douyin\.com/(?:video|note)/(\d{8,24})')

douyin_texts = {}  # 上次翻频道看到的 {消息号: 说明}：补账号标签时用，不用一条条再去取

async def douyin_retag(target, msg_id, item):
    """频道里已有的帖子，说明里还没有这个账号的标签：按现在的格式重写说明（带上 #标签），不重发。频道主账号才能改"""
    text = douyin_texts.get(msg_id)
    if user_client is None or text is None or f'#{item["tag"]}' in text:
        return
    new = dy_caption(item)
    if new == text:
        return
    entity = await channel_entity(user_client, target)
    await flood_retry(lambda: user_client.edit_message(entity, msg_id, new))
    douyin_texts[msg_id] = new
    await asyncio.sleep(1)  # 慢慢改，免得被限流

DOUYIN_POSTED_TTL = 6 * 3600  # 这么久之内只翻上次之后的新帖子；过了就整个频道重翻（频道主删过帖子也能认出来）

douyin_posted_cache = {}  # 频道 → {'ids': {作品号: 消息号}, 'top': 翻到的最新消息号, 'at': 整翻的时间}

async def douyin_posted(target, limit=20000):  # 作品上千条，频道帖子也多：多翻些才不重复转
    """target 频道里已经转过的抖音作品 → {作品号: 消息号}：翻最近 limit 条帖子，看说明里的原视频链接。
    不用 Telegram 的搜索：实测刚发的帖子搜不到链接里的作品号，查重落空、发了重复的。
    整翻一次很慢：记下来，下次只翻新帖子。返回的就是缓存本身，转作品时往里记的新帖子也就记进去了。
    机器人不能翻频道历史，没登录就当都没转过"""
    if user_client is None:
        return {}
    c = douyin_posted_cache.get(target)
    if c is None or time.time() - c['at'] > DOUYIN_POSTED_TTL:
        c = douyin_posted_cache[target] = {'ids': {}, 'top': 0, 'at': time.time()}
        newer = 0
    else:
        newer = c['top']
    out, top = {}, c['top']
    async for m in user_client.iter_messages(await channel_entity(user_client, target), limit=limit, min_id=newer):
        top = max(top, m.id)
        for aweme_id in DOUYIN_ID_IN_TEXT.findall(m.message or ''):
            out.setdefault(aweme_id, m.id)
            douyin_texts[m.id] = m.message or ''
    for aweme_id, msg_id in out.items():  # 新翻到的帖子更新，同一条作品留最新那条帖子
        if newer == 0 or aweme_id not in c['ids'] or msg_id > c['ids'][aweme_id]:
            c['ids'][aweme_id] = msg_id
    c['top'] = top
    return c['ids']

@app.get('/douyin/posted')
async def douyin_posted_ids(target: str, request: Request):
    """视频频道里已经转过的抖音作品号（云电脑开抓前要一份：转过的不再抓，翻到全是转过的那页就停）"""
    check_key(request)
    t = parse_target(target)
    if t is None:
        raise HTTPException(400, '没设置视频频道')
    if user_client is None:
        raise HTTPException(409, 'not logged in')
    return {'ids': sorted(await douyin_posted(t))}

@app.post('/douyin/stop')
async def douyin_stop(request: Request):
    """频道主在机器人里点「停止」：正在跑的抖音任务（转作品、同步）停下。已经发进频道的不动"""
    check_key(request)
    if douyin_job and douyin_job.running():
        douyin_job.task.cancel()
        return {'stopped': True}
    return {'stopped': False}

@app.post('/douyin/delete')
async def douyin_delete(request: Request):
    """{target, ids: [消息号]}：删掉视频频道里转过的抖音视频帖（换最高画质重转用：删了以后查重认不出，下次就重新转）。
    只删说明里带抖音视频链接、而且确实是视频的帖子，别的一律不动；正在转作品时不删（免得查重乱掉）"""
    check_key(request)
    if user_client is None:
        raise HTTPException(409, 'not logged in')
    if douyin_busy():
        raise HTTPException(409, 'busy')
    body = await request.json()
    target = parse_target(body.get('target'))
    if target is None:
        raise HTTPException(400, '没设置视频频道')
    ids = [int(x) for x in (body.get('ids') or []) if str(x).isdigit()][:500]
    entity = await channel_entity(user_client, target)
    ok, refused = [], []
    for m in await user_client.get_messages(entity, ids=ids):
        if m is not None and m.video and re.search(r'douyin\.com/video/\d{8,24}', m.message or ''):
            ok.append(m.id)
        elif m is not None:
            refused.append(m.id)
    for i in range(0, len(ok), 100):
        await flood_retry(lambda chunk=ok[i:i + 100]: user_client.delete_messages(entity, chunk))
    return {'deleted': ok, 'refused': refused}

@app.get('/channels/owned')
async def channels_owned(title: str, request: Request):
    """频道主自己建的频道里、名字含 title 的那几个（找新建私有频道的数字 id 用）。只回对得上的，不列别的聊天"""
    check_key(request)
    if user_client is None:
        raise HTTPException(409, 'not logged in')
    q = norm(title)
    if len(q) < 2:
        raise HTTPException(400, 'title too short')
    out = []
    async for d in user_client.iter_dialogs():
        e = d.entity
        if getattr(e, 'broadcast', False) and getattr(e, 'creator', False) and q in norm(getattr(e, 'title', '')):
            out.append({'id': int(f'-100{e.id}'), 'title': e.title, 'username': getattr(e, 'username', None)})
    return {'channels': out}

@app.post('/douyin/link')
async def douyin_link(request: Request):
    """{text: 分享文字或链接, target: 视频发去的频道, notify}，在后台跑，跑完通知 notify：
    作品链接 → 转到 target 频道 → {kind: 'aweme', id}；主页链接 → 采集这个账号作品的链接 → {kind: 'user', sec_uid}。
    认不出、作品链接却没给 target → 400；正在跑别的 → 409"""
    check_key(request)
    body = await request.json()
    try:
        got = await dy_links.resolve(str(body.get('text', ''))[:2000])
    except Exception:  # noqa: BLE001 — 短链接打不开
        raise HTTPException(502, '抖音短链接打不开')
    if not got:
        raise HTTPException(400, '没认出抖音链接')
    kind, value = got
    notify = body.get('notify') or None
    target = parse_target(body.get('target'))
    if kind == 'aweme' and target is None:
        raise HTTPException(400, '没设置视频频道')
    if douyin_login and douyin_login.running():  # 登录和别的任务共用一份 cookie，不能同时跑
        raise HTTPException(409, 'logging in')
    restore_state(body.get('state'))
    try:
        if kind == 'user':
            douyin_job.start_collect(value, notify=notify)
        else:
            douyin_job.start(value, notify=notify, target=target)
    except RuntimeError:
        raise HTTPException(409, 'already running')
    note_run(body)
    return {'kind': kind, 'sec_uid': value} if kind == 'user' else {'kind': kind, 'id': value}

@app.post('/douyin/resolve')
async def douyin_resolve(request: Request):
    """{text: 分享文字或链接} → {kind: 'user'|'aweme', id}。只认链接，不开浏览器（机器人加账号用）"""
    check_key(request)
    try:
        got = await dy_links.resolve(str((await request.json()).get('text', ''))[:2000])
    except Exception:  # noqa: BLE001
        raise HTTPException(502, '抖音短链接打不开')
    if not got:
        raise HTTPException(400, '没认出抖音链接')
    return {'kind': got[0], 'id': got[1]}

def clean_tags(raw):
    """Worker 送来的 {sec_uid: 账号标签}（频道主起的名字）→ 只留像样的"""
    if not isinstance(raw, dict):
        return {}
    return {str(k)[:140]: dy_hashtag(v) for k, v in list(raw.items())[:20] if dy_hashtag(v)}

@app.post('/douyin/import')
async def douyin_import(request: Request):
    """{text: MediaCrawler 导出的内容（一批或整个文件）, target, notify, final}：把里面的作品转进 target 频道。
    边抓边转：云电脑每抓到一批就送一次（final=false），正在转的就接着收进队列；最后送 final=true（可以不带作品）
    表示抓完了。不带 final 当作一次送完（旧的用法）。认不出 → 400；正在跑别的 → 409"""
    check_key(request)
    body = await request.json()
    target = parse_target(body.get('target'))
    if target is None:
        raise HTTPException(400, '没设置视频频道')
    final = body.get('final', True) is not False
    items = parse_export(str(body.get('text', '')))
    kinds = [i['kind'] for i in items]
    counts = {'total': len(items), 'video': kinds.count('video'), 'images': kinds.count('images')}
    tags = clean_tags(body.get('tags'))
    if douyin_job.importing(target):
        added = douyin_job.feed_import(items, final=final, tags=tags)
        return {'ok': True, **counts, 'added': added, 'started': False}
    if not items:
        if final and str(body.get('text', '')).strip() == '':
            return {'ok': True, **counts, 'added': 0, 'started': False}  # 抓完的通知，但没有在转的：没事可做
        raise HTTPException(400, '文件里没认出抖音作品（要 MediaCrawler 导出的 creator_contents 文件）')
    if douyin_busy():
        raise HTTPException(409, 'busy')
    douyin_job.start_import(items, notify=body.get('notify') or None, target=target, final=final, tags=tags)
    note_run(body)
    return {'ok': True, **counts, 'added': len(items), 'started': True}

@app.post('/douyin/mirror')
async def douyin_mirror(request: Request):
    """{sec_uid, target, notify}：把这个账号能看到的视频转到 target 频道（旧的先发，已有的跳过），跑完通知。正在跑别的 → 409"""
    check_key(request)
    body = await request.json()
    sec_uids = body.get('sec_uids') or [body.get('sec_uid', '')]
    sec_uids = [str(x).strip() for x in sec_uids][:30]
    if not sec_uids or not all(dy_links.USER.search('/user/' + x) and len(x) <= 140 for x in sec_uids):
        raise HTTPException(400, 'bad sec_uid')
    target = parse_target(body.get('target'))
    if target is None:
        raise HTTPException(400, '没设置视频频道')
    if douyin_login and douyin_login.running():
        raise HTTPException(409, 'logging in')
    restore_state(body.get('state'))
    try:
        douyin_job.start_mirror(sec_uids, notify=body.get('notify') or None, target=target, quiet=bool(body.get('quiet')),
                                tags=clean_tags(body.get('tags')))
    except RuntimeError:
        raise HTTPException(409, 'already running')
    note_run(body)
    return {'ok': True}

def douyin_busy():
    """登录和别的抖音任务共用一份 cookie，不能同时跑"""
    return (douyin_login and douyin_login.running()) or (douyin_job and douyin_job.running())

@app.post('/douyin/login')
async def douyin_login_start(request: Request):
    """开始扫码登录（Worker 的登录页来调）。二维码在 GET /douyin/login/qr，进度在 GET /douyin/login/status"""
    check_key(request)
    if douyin_busy():
        raise HTTPException(409, 'busy')
    douyin_login.start()
    return {'ok': True}

@app.get('/douyin/login/status')
async def douyin_login_status(request: Request):
    check_key(request)
    st = dict(douyin_login.state) if douyin_login else {'status': 'idle'}
    st['logged_in'] = state_logged_in()
    return st

@app.get('/douyin/login/qr')
async def douyin_login_qr(request: Request):
    check_key(request)
    if not douyin_login or not douyin_login.qr_png:
        raise HTTPException(404)
    return Response(content=douyin_login.qr_png, media_type='image/png', headers={'Cache-Control': 'no-store'})

@app.get('/douyin/login/shot')
async def douyin_login_shot(request: Request):
    """服务器那边登录页现在的截图"""
    check_key(request)
    png = await douyin_login.screenshot() if douyin_login else None
    if not png:
        raise HTTPException(404)
    return Response(content=png, media_type='image/png', headers={'Cache-Control': 'no-store'})

@app.get('/douyin/login/state')
async def douyin_login_state(request: Request):
    """登录后的 cookie（敏感，只给拿着 X-Key 的人）：Worker 取走存一份，Space 重启后靠它恢复"""
    check_key(request)
    if not os.path.exists(DOUYIN_STATE_FILE):
        raise HTTPException(404)
    with open(DOUYIN_STATE_FILE) as f:
        return Response(content=f.read(), media_type='application/json')

@app.get('/douyin/status')
async def douyin_status(request: Request):
    check_key(request)
    st = douyin_job.state if douyin_job else {'status': 'idle'}
    return {**st, 'worker_link': worker_link} if worker_link['fail_at'] else st

# ── 视频频道（刷视频网页）──────────────────────────────────────────
# 网页上随机刷「小橘视频」里的视频。私有频道只有数字 id；机器人是那里的管理员，按消息号取视频、边取边传，
# 和音乐频道的大文件一样（各用各的 Streamer，消息缓存分开）。视频池要翻频道历史，机器人不能翻，用频道主账号翻（只读）。
# 找不到的视频回 404 + detail 'gone'，Worker 认这个才把它从视频池去掉——别的 404（比如 Space 还是旧代码、没有这个接口）不算

VIDEO_LIST_MAX = 20000

video_streamers = {}  # 视频频道 → Streamer

def video_target(target):
    t = parse_target(target)
    if t is None:
        raise HTTPException(400, '没设置视频频道')
    return t

async def video_streamer(target):
    s = video_streamers.get(target)
    if s is None:
        client = bot_client
        entity = await channel_entity(client, target)

        async def fetch_message(channel, message_id):
            return await client.get_messages(channel, ids=message_id)

        async def download_thumb(msg):
            return await client.download_media(msg, file=bytes, thumb=-1)

        s = video_streamers[target] = Streamer(channel=entity, fetch_message=fetch_message,
                                               iter_download=client.iter_download, download_thumb=download_thumb)
    return s

def is_video(msg):
    doc = getattr(msg, 'document', None)
    return doc is not None and (getattr(doc, 'mime_type', '') or '').startswith('video/')

@app.get('/vstream/{message_id}')
async def vstream(message_id: int, target: str, request: Request):
    check_key(request)
    s = await video_streamer(video_target(target))
    msg = await s.message(message_id)
    if msg is None or not is_video(msg):
        raise HTTPException(404, 'gone')
    return ranged(s, msg, message_id, request)

@app.get('/vthumb/{message_id}')
async def vthumb(message_id: int, target: str, request: Request):
    """视频的缩略图（转视频时 ffmpeg 截的第一秒，长边 320）；没有这条视频 → 'gone'，有视频没缩略图 → 'no thumb'"""
    check_key(request)
    s = await video_streamer(video_target(target))
    msg = await s.message(message_id)
    if msg is None or not is_video(msg):
        raise HTTPException(404, 'gone')
    data = await s.thumbnail(message_id)
    if not data:
        raise HTTPException(404, 'no thumb')
    return Response(content=data, media_type='image/jpeg')

def video_row(m):
    """频道里的一条视频帖 → 视频池里的一行；不是视频（GIF、圆形视频、别的文件）→ None"""
    f = getattr(m, 'file', None)
    if f is None or not (f.mime_type or '').startswith('video/') or getattr(m, 'gif', None) or getattr(m, 'video_note', None):
        return None
    return {'id': m.id, 'date': int(m.date.timestamp()) if m.date else 0, 'size': f.size or 0, 'duration': round(f.duration or 0),
            'w': f.width or 0, 'h': f.height or 0, 'mime': f.mime_type, 'text': m.message or ''}

@app.get('/videos')
async def videos(target: str, request: Request, min_id: int = 0):
    """视频频道里的视频帖（刷视频网页的视频池），新的在前。complete 为 False 表示到上限没翻完（Worker 就不删旧的）"""
    check_key(request)
    t = video_target(target)
    if user_client is None:
        raise HTTPException(409, 'not logged in')
    entity = await channel_entity(user_client, t)
    out = []
    async for m in user_client.iter_messages(entity, filter=InputMessagesFilterVideo, min_id=max(0, min_id),
                                             limit=VIDEO_LIST_MAX, wait_time=0):
        row = video_row(m)
        if row:
            out.append(row)
    return {'videos': out, 'complete': len(out) < VIDEO_LIST_MAX}
