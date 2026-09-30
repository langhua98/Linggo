"""小橘音乐 · 大文件流式服务（Hugging Face Space）

Telegram 官方 Bot API 只能下载 20 MB 以内的文件，机器人走 MTProto 却没有这个限制。小橘音乐的
Worker 遇到超过 20 MB 的歌，就把浏览器的 Range 请求转到这里（GET /stream/<消息号>）。这里用 Telethon
以机器人身份按消息号取到频道里的原文件，浏览器要哪一段，就从 Telegram 现取哪一段、边取边传：
不落盘，也不用等整首下完。另外 GET /thumb/<消息号> 给出音乐文件自带的专辑封面，Worker 取一次就存起来。

搬歌（频道主要求）：机器人看不到别人的频道，所以另有一个用频道主自己的账号登录的会话（TG_USER_SESSION），
把指定公开频道里的中文歌转到小橘音乐频道（不带「转发自」），转过去的帖子由 Worker 的 webhook 照常登记、查重。
开了「禁止保存内容」的频道 Telegram 不让转，这里也不去绕。登录走 POST /login/code、/login/verify，
搬歌走 /copy/start、/copy/status、/copy/stop。

环境变量（在 Space 的 Settings → Variables and secrets 里设成 secret）：
  TG_API_ID / TG_API_HASH   my.telegram.org 申请的应用凭据
  TG_BOT_TOKEN              机器人 token（和 Worker 里的是同一个）
  TG_CHANNEL                频道用户名，xiaojumusic
  STREAMER_KEY              Worker 转发请求时带的密钥（X-Key 请求头）
  TG_USER_SESSION           （可选）频道主账号的登录凭证，搬歌用；由 /login/verify 生成
"""

import asyncio
import hmac
import logging
import os
import re
import time
from contextlib import asynccontextmanager

from fastapi import FastAPI, HTTPException, Request
from fastapi.responses import Response, StreamingResponse
from telethon import TelegramClient
from telethon.errors import FileReferenceExpiredError, FloodWaitError, SessionPasswordNeededError
from telethon.tl.types import InputMessagesFilterMusic
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


# ── 搬歌 ──────────────────────────────────────────────────────────

CJK = re.compile(r'[一-鿿]')
# 日文假名、韩文：有这些的是日韩歌（只用汉字写的日本歌手名分不出来）
KANA_HANGUL = re.compile(r'[぀-ヿ가-힯]')


def is_chinese(text):
    return bool(CJK.search(text)) and not KANA_HANGUL.search(text)


def norm(s):
    return re.sub(r'[\W_]+', '', (s or '').lower())


def clean_names(title, performer):
    """和 Worker 的 summary() 一样理歌名、歌手：去掉「@频道」「更多音乐」，没有歌手时拆「歌手 - 歌名」。"""
    title = (title or '').strip()
    artist = re.sub(r'\s+', ' ', re.sub(r'@\w+|更多音乐', '', performer or '')).strip()
    if not artist:
        m = re.match(r'^(.+?)\s+-\s+(.+)$', title)
        if m:
            artist, title = m[1].strip(), m[2].strip()
    return title, artist


def song_key(title, performer):
    t, a = clean_names(title, performer)
    return norm(t) + '|' + norm(a)


class Copier:
    """把 source 频道里的中文歌（歌名或歌手里有汉字）从新到旧转到 target，跳过已有的，最多 limit 首。

    iter_music(source) 异步给出 (消息, 歌名, 歌手)；forward(target, 消息) 转一条。都由外面注入，方便测试。"""

    def __init__(self, *, iter_music, forward, sleep=asyncio.sleep, pause=3.0):
        self.iter_music = iter_music
        self.forward = forward
        self.sleep = sleep
        self.pause = pause
        self.task = None
        self.state = {'status': 'idle'}

    def running(self):
        return self.task is not None and not self.task.done()

    def start(self, source, target, limit, existing, dry_run=False):
        if self.running():
            raise RuntimeError('already running')
        self.state = {'status': 'running', 'source': source, 'limit': limit, 'dry_run': dry_run,
                      'scanned': 0, 'copied': 0, 'skipped_lang': 0, 'skipped_dup': 0, 'recent': [], 'error': ''}
        seen = {song_key(t, a) for t, a in existing}
        self.task = asyncio.create_task(self.run(source, target, limit, seen, dry_run))

    def stop(self):
        if self.running():
            self.task.cancel()

    async def run(self, source, target, limit, seen, dry_run):
        st = self.state
        try:
            async for msg, title, performer in self.iter_music(source):
                if st['copied'] >= limit:
                    break
                st['scanned'] += 1
                if not is_chinese((title or '') + (performer or '')):
                    st['skipped_lang'] += 1
                    continue
                key = song_key(title, performer)
                if key in seen:
                    st['skipped_dup'] += 1
                    continue
                if not dry_run:
                    await self.forward_patiently(target, msg)
                    await self.sleep(self.pause)  # 慢慢来，免得账号被限制
                seen.add(key)
                st['copied'] += 1
                t, a = clean_names(title, performer)
                st['recent'] = ([f'{a} - {t}' if a else t] + st['recent'])[:30]
            st['status'] = 'done'
        except asyncio.CancelledError:
            st['status'] = 'stopped'
        except Exception as e:  # noqa: BLE001 — 记下来给 /copy/status 看
            log.exception('copy failed')
            st['status'], st['error'] = 'error', f'{type(e).__name__}: {e}'

    async def forward_patiently(self, target, msg):
        for attempt in range(3):
            try:
                return await self.forward(target, msg)
            except FloodWaitError as e:  # Telegram 叫我们等一会儿
                if attempt == 2 or e.seconds > 3600:
                    raise
                self.state['waiting'] = e.seconds
                await self.sleep(e.seconds + 1)
                self.state.pop('waiting', None)


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
user_client = None  # 频道主账号（搬歌用），没登录时为 None
copier = None
login = None


def user_music(client):
    async def iter_music(source):
        async for msg in client.iter_messages(source, filter=InputMessagesFilterMusic):
            f = msg.file
            if f is None:
                continue
            yield msg, f.title or re.sub(r'\.[a-z0-9]{1,5}$', '', f.name or '', flags=re.I), f.performer or ''
    return iter_music


def set_user_client(client):
    global user_client, copier
    user_client = client

    async def forward(target, msg):
        # drop_author：转过去是一条新帖，不带「转发自」
        return await client.forward_messages(target, msg, drop_author=True)

    copier = Copier(iter_music=user_music(client), forward=forward)


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

    global login
    login = Login(lambda session: TelegramClient(session, int(env['TG_API_ID']), env['TG_API_HASH'], receive_updates=False))
    if env.get('TG_USER_SESSION'):
        try:
            u = login.make_user_client(StringSession(env['TG_USER_SESSION']))
            await u.connect()
            if await u.is_user_authorized():
                set_user_client(u)
                log.info('user session ready')
            else:
                log.warning('TG_USER_SESSION is no longer valid')
        except Exception:  # noqa: BLE001 — 搬歌用不了不影响播放
            log.exception('user session failed')
    try:
        yield
    finally:
        if copier:
            copier.stop()
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


# ── 登录、搬歌（都要 X-Key）─────────────────────────────────────────

def target_channel():
    return os.environ.get('TG_CHANNEL', 'xiaojumusic')


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
    try:
        perm = await client.get_permissions(target_channel(), 'me')
        can_post = bool(perm.is_creator or (perm.is_admin and perm.post_messages))
    except Exception:  # noqa: BLE001 — 不在频道里
        can_post = False
    # 登录凭证只在这里给一次，要存成 Space 的 secret（TG_USER_SESSION），重启后才还能用
    return {'ok': True, 'session': client.session.save(), 'can_post': can_post,
            'me': {'id': me.id, 'name': ' '.join(x for x in [me.first_name, me.last_name] if x), 'username': me.username}}


@app.post('/copy/start')
async def copy_start(request: Request):
    check_key(request)
    if copier is None:
        raise HTTPException(409, 'not logged in')
    body = await request.json()
    source = str(body.get('source', '')).strip().lstrip('@')
    if not re.fullmatch(r'\w{4,64}', source):
        raise HTTPException(400, 'bad source')
    existing = [(str(t), str(a)) for t, a in body.get('existing', [])]
    limit = max(1, min(int(body.get('limit', 50)), 2000))
    try:
        copier.start(source, target_channel(), limit, existing, bool(body.get('dry_run')))
    except RuntimeError:
        raise HTTPException(409, 'already running')
    return copier.state


@app.get('/copy/status')
async def copy_status(request: Request):
    check_key(request)
    return {'logged_in': copier is not None, **(copier.state if copier else {'status': 'idle'})}


@app.post('/copy/stop')
async def copy_stop(request: Request):
    check_key(request)
    if copier:
        copier.stop()
    return {'ok': True}
