"""小橘视频流式服务里「按消息号取视频」那部分的本地测试：假的 Telegram（取消息 + MTProto 分块下载），不联网。

    pip install -r requirements.txt pytest httpx && python -m pytest -q
"""

import asyncio

import pytest
from fastapi.testclient import TestClient
from telethon.errors import FileReferenceExpiredError, SessionPasswordNeededError

import app as appmod
from app import CHUNK, Streamer, parse_range

CHANNEL = -1001234567890
DATA = bytes((i * 7 + (i >> 12)) & 255 for i in range(CHUNK * 3 + 12345))  # 3 块多一点


class Doc:
    mime_type = 'video/mp4'

    def __init__(self, size, ref):
        self.size = size
        self.ref = ref


class Msg:
    def __init__(self, doc):
        self.document = doc


class FakeTelegram:
    """模拟 Telethon：按 512 KB 对齐的偏移分块下载；可以让第一次取到的文件引用在某个位置过期。"""

    def __init__(self, expire_at=None):
        self.fetches = 0
        self.offsets = []
        self.served = 0
        self.closed = 0
        self.expire_at = expire_at

    async def fetch_message(self, channel, message_id):
        assert channel == CHANNEL
        self.fetches += 1
        return Msg(Doc(len(DATA), self.fetches)) if message_id == 12 else None

    def iter_download(self, doc, *, offset, request_size, file_size):
        assert offset % CHUNK == 0 and request_size == CHUNK and file_size == len(DATA)
        self.offsets.append(offset)

        async def gen():
            try:
                pos = offset
                while pos < len(DATA):
                    if self.expire_at is not None and pos >= self.expire_at and doc.ref == 1:
                        raise FileReferenceExpiredError(request=None)
                    chunk = DATA[pos:pos + request_size]
                    self.served += len(chunk)
                    yield chunk
                    pos += len(chunk)
            finally:
                self.closed += 1

        return gen()


def collect(streamer, start, end):
    async def main():
        return b''.join([c async for c in streamer.body(12, start, end)])
    return asyncio.run(main())


def make(tg, **kw):
    return Streamer(channel=CHANNEL, fetch_message=tg.fetch_message, iter_download=tg.iter_download, **kw)


def test_parse_range():
    n = 1000
    assert parse_range(None, n) == (0, 999, False)
    assert parse_range('bytes=0-1', n) == (0, 1, True)
    assert parse_range('bytes=990-', n) == (990, 999, True)
    assert parse_range('bytes=-10', n) == (990, 999, True)
    assert parse_range('bytes=500-5000', n) == (500, 999, True)
    assert parse_range('bytes=1000-', n) is None
    assert parse_range('bytes=-0', n) is None
    assert parse_range('bytes=0-1,5-6', n) == (0, 999, False)
    assert parse_range('bytes=9-3', n) == (0, 999, False)


@pytest.mark.parametrize('start,end', [
    (0, 1),
    (CHUNK - 3, CHUNK + 2),          # 跨一个块边界
    (CHUNK + 100, 3 * CHUNK + 50),   # 从块中间开始，跨两个边界
    (len(DATA) - 7, len(DATA) - 1),  # 最后几个字节
    (0, len(DATA) - 1),              # 整个文件
])
def test_body_returns_exact_bytes_from_aligned_offsets(start, end):
    tg = FakeTelegram()
    assert collect(make(tg), start, end) == DATA[start:end + 1]
    assert tg.offsets == [start - start % CHUNK]
    # 不多下：最多比要的多出两个块的零头
    assert tg.served <= (end - start + 1) + 2 * CHUNK
    assert tg.closed == 1


def test_expired_file_reference_is_refetched_and_resumed():
    tg = FakeTelegram(expire_at=2 * CHUNK)
    start = CHUNK - 10
    assert collect(make(tg), start, len(DATA) - 1) == DATA[start:]
    assert tg.fetches == 2
    assert tg.offsets == [0, 2 * CHUNK]
    assert tg.closed == 2


def test_gives_up_after_repeated_expiry():
    tg = FakeTelegram(expire_at=0)
    tg.fetch_message = _always_stale(tg)
    with pytest.raises(FileReferenceExpiredError):
        collect(make(tg), 0, 10)
    assert tg.fetches == 1 + appmod.MAX_REFRESHES


def _always_stale(tg):
    async def fetch(channel, message_id):
        tg.fetches += 1
        return Msg(Doc(len(DATA), 1))  # 每次拿到的都是会过期的引用
    return fetch


def test_a_failing_close_does_not_hide_the_real_error():
    class Broken:
        def __aiter__(self):
            return self

        async def __anext__(self):
            raise ConnectionError('telegram went away')

        async def close(self):
            raise AttributeError('_sender')  # Telethon 没取过数据就关，就是这样

    tg = FakeTelegram()
    s = Streamer(channel=CHANNEL, fetch_message=tg.fetch_message, iter_download=lambda *a, **kw: Broken())
    with pytest.raises(ConnectionError):
        collect(s, 0, 10)


def test_messages_are_cached_until_ttl():
    tg = FakeTelegram()
    now = [0.0]
    s = make(tg, clock=lambda: now[0])
    collect(s, 0, 1)
    collect(s, 5, 9)
    assert tg.fetches == 1
    now[0] += appmod.MESSAGE_TTL + 1
    collect(s, 0, 1)
    assert tg.fetches == 2




def test_client_never_subscribes_to_updates(monkeypatch):
    seen = {}

    class FakeClient:
        def __init__(self, session, api_id, api_hash, **kw):
            seen.update(api_id=api_id, api_hash=api_hash, **kw)

    monkeypatch.setattr(appmod, 'TelegramClient', FakeClient)
    appmod.make_client({'TG_API_ID': '123', 'TG_API_HASH': 'abc'})
    assert seen == {'api_id': 123, 'api_hash': 'abc', 'receive_updates': False}


def test_login_with_two_step_password():
    sent, signed = [], []

    class FakeUser:
        async def connect(self):
            pass

        async def send_code_request(self, phone):
            sent.append(phone)
            return type('S', (), {'phone_code_hash': 'H'})()

        async def sign_in(self, **kw):
            signed.append(kw)
            if 'code' in kw and not getattr(self, 'two_step_done', False):
                raise SessionPasswordNeededError(request=None)

    login = appmod.Login(lambda session: FakeUser())

    async def go():
        await login.send_code('+8613800000000')
        try:
            await login.verify('12345')
            raise AssertionError('should ask for the password')
        except SessionPasswordNeededError:
            pass
        return await login.verify('12345', 'pw')

    client = asyncio.run(go())
    assert sent == ['+8613800000000'] and isinstance(client, FakeUser)
    assert signed[0]['code'] == '12345' and signed[1] == {'password': 'pw'}


# ── 视频频道：按消息号取视频、缩略图、翻频道历史 ──

def video_app(monkeypatch, **streamer_kw):
    monkeypatch.setenv('STREAMER_KEY', 'k1')
    tg = FakeTelegram()
    monkeypatch.setattr(appmod, 'video_streamers', {CHANNEL: make(tg, **streamer_kw)})
    return TestClient(appmod.app), {'X-Key': 'k1'}, tg


def test_vstream_serves_ranges_and_says_gone_for_missing_posts(monkeypatch):
    client, key, _ = video_app(monkeypatch)
    url = f'/vstream/12?target={CHANNEL}'
    assert client.get(url).status_code == 403
    assert client.get(f'/vstream/99?target={CHANNEL}', headers=key).json() == {'detail': 'gone'}
    assert client.get('/vstream/12?target=12', headers=key).status_code == 400   # 认不出是哪个频道
    r = client.get(url, headers={**key, 'Range': f'bytes={CHUNK - 5}-{CHUNK + 4}'})
    assert r.status_code == 206 and r.content == DATA[CHUNK - 5:CHUNK + 5]
    assert r.headers['content-range'] == f'bytes {CHUNK - 5}-{CHUNK + 4}/{len(DATA)}'
    r = client.get(url, headers=key)
    assert r.status_code == 200 and r.content == DATA
    assert client.get(url, headers={**key, 'Range': f'bytes={len(DATA)}-'}).status_code == 416


def test_vstream_refuses_posts_that_are_not_videos(monkeypatch):
    client, key, tg = video_app(monkeypatch)
    orig = tg.fetch_message

    async def audio_post(channel, message_id):
        msg = await orig(channel, message_id)
        msg.document.mime_type = 'audio/mpeg'
        return msg

    tg.fetch_message = audio_post
    monkeypatch.setattr(appmod, 'video_streamers', {CHANNEL: make(tg)})
    assert client.get(f'/vstream/12?target={CHANNEL}', headers=key).json() == {'detail': 'gone'}


def test_vthumb_distinguishes_gone_from_no_thumb(monkeypatch):
    jpeg = b'\xff\xd8\xff\xe0' + b'x' * 50
    got = []

    async def download_thumb(msg):
        got.append(msg)
        return jpeg if msg.document.ref == 1 else None

    class WithThumbs(FakeTelegram):
        async def fetch_message(self, channel, message_id):
            msg = await super().fetch_message(channel, message_id)
            if msg is not None:
                msg.document.thumbs = ['320x320']
            return msg

    monkeypatch.setenv('STREAMER_KEY', 'k1')
    key = {'X-Key': 'k1'}
    tg = WithThumbs()
    monkeypatch.setattr(appmod, 'video_streamers', {CHANNEL: make(tg, download_thumb=download_thumb)})
    client = TestClient(appmod.app)
    r = client.get(f'/vthumb/12?target={CHANNEL}', headers=key)
    assert r.status_code == 200 and r.content == jpeg and r.headers['content-type'] == 'image/jpeg'
    assert client.get(f'/vthumb/99?target={CHANNEL}', headers=key).json() == {'detail': 'gone'}
    # 有这条视频、但没有缩略图：no thumb（和「帖子没了」分开，Worker 才知道别再问）
    monkeypatch.setattr(appmod, 'video_streamers', {CHANNEL: make(FakeTelegram(), download_thumb=download_thumb)})
    assert client.get(f'/vthumb/12?target={CHANNEL}', headers=key).json() == {'detail': 'no thumb'}


class Post:
    def __init__(self, id, mime='video/mp4', size=1000, gif=False, video_note=False, text='文案'):
        self.id, self.message, self.gif, self.video_note = id, text, gif, video_note
        self.date = __import__('datetime').datetime(2026, 10, 1, 12, 0, 0)
        self.file = type('F', (), {'mime_type': mime, 'size': size, 'duration': 15.4, 'width': 720, 'height': 1280})()


class FakeUser:
    def __init__(self, posts):
        self.posts, self.asked = posts, []

    async def get_input_entity(self, target):
        return target

    async def iter_messages(self, entity, **kw):
        self.asked.append((entity, kw))
        for p in self.posts[:kw.get('limit')]:
            yield p


def test_videos_lists_only_real_videos_and_says_when_it_stopped_early(monkeypatch):
    monkeypatch.setenv('STREAMER_KEY', 'k1')
    key = {'X-Key': 'k1'}
    client = TestClient(appmod.app)
    monkeypatch.setattr(appmod, 'user_client', None)
    assert client.get(f'/videos?target={CHANNEL}', headers=key).status_code == 409   # 频道主账号没登录
    user = FakeUser([Post(30), Post(29, mime='image/jpeg'), Post(28, gif=True), Post(27, video_note=True), Post(26, size=0, text='')])
    monkeypatch.setattr(appmod, 'user_client', user)
    assert client.get(f'/videos?target={CHANNEL}').status_code == 403
    j = client.get(f'/videos?target={CHANNEL}&min_id=20', headers=key).json()
    assert [v['id'] for v in j['videos']] == [30, 26]
    assert j['videos'][0] == {'id': 30, 'date': 1790856000, 'size': 1000, 'duration': 15, 'w': 720, 'h': 1280, 'mime': 'video/mp4', 'text': '文案'}
    assert j['complete'] is True
    assert user.asked[0][1]['min_id'] == 20
    monkeypatch.setattr(appmod, 'VIDEO_LIST_MAX', 3)
    monkeypatch.setattr(appmod, 'user_client', FakeUser([Post(i) for i in range(30, 20, -1)]))
    assert client.get(f'/videos?target={CHANNEL}', headers=key).json()['complete'] is False   # 到上限没翻完：Worker 就不删旧的


def test_the_worker_it_reports_to_is_the_video_one(monkeypatch):
    monkeypatch.delenv('WORKER_URL', raising=False)
    assert appmod.worker_url() == 'https://xiaoju-video.langhua98.workers.dev'
    monkeypatch.setenv('WORKER_URL', 'https://example.test/')
    assert appmod.worker_url() == 'https://example.test'
