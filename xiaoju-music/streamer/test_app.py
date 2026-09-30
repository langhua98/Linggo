"""流式服务的本地测试：假的 Telegram（取消息 + MTProto 分块下载），不联网。

    pip install -r requirements.txt pytest httpx && python -m pytest -q
"""

import asyncio

import pytest
from fastapi.testclient import TestClient
from telethon.errors import FileReferenceExpiredError

import app as appmod
from app import CHUNK, Streamer, parse_range

DATA = bytes((i * 7 + (i >> 12)) & 255 for i in range(CHUNK * 3 + 12345))  # 3 块多一点


class Doc:
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
        assert channel == 'xiaojumusic'
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
    return Streamer(channel='xiaojumusic', fetch_message=tg.fetch_message, iter_download=tg.iter_download, **kw)


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
    s = Streamer(channel='xiaojumusic', fetch_message=tg.fetch_message, iter_download=lambda *a, **kw: Broken())
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


def test_http_endpoint(monkeypatch):
    monkeypatch.setenv('STREAMER_KEY', 'k1')
    tg = FakeTelegram()
    monkeypatch.setattr(appmod, 'streamer', make(tg))
    client = TestClient(appmod.app)  # 不进 with，就不会触发登录 Telegram 的 lifespan
    assert client.get('/').json() == {'ok': True}
    assert client.get('/stream/12').status_code == 403
    assert client.get('/stream/12', headers={'X-Key': 'wrong'}).status_code == 403
    key = {'X-Key': 'k1'}
    assert client.get('/stream/99', headers=key).status_code == 404

    r = client.get('/stream/12', headers={**key, 'Range': f'bytes={CHUNK - 5}-{CHUNK + 4}'})
    assert r.status_code == 206
    assert r.headers['content-range'] == f'bytes {CHUNK - 5}-{CHUNK + 4}/{len(DATA)}'
    assert r.headers['content-length'] == '10'
    assert r.content == DATA[CHUNK - 5:CHUNK + 5]

    r = client.get('/stream/12', headers=key)
    assert r.status_code == 200 and r.content == DATA
    assert r.headers['content-length'] == str(len(DATA))

    r = client.get('/stream/12', headers={**key, 'Range': f'bytes={len(DATA)}-'})
    assert r.status_code == 416 and r.headers['content-range'] == f'bytes */{len(DATA)}'


def test_client_never_subscribes_to_updates(monkeypatch):
    seen = {}

    class FakeClient:
        def __init__(self, session, api_id, api_hash, **kw):
            seen.update(api_id=api_id, api_hash=api_hash, **kw)

    monkeypatch.setattr(appmod, 'TelegramClient', FakeClient)
    appmod.make_client({'TG_API_ID': '123', 'TG_API_HASH': 'abc'})
    assert seen == {'api_id': 123, 'api_hash': 'abc', 'receive_updates': False}
