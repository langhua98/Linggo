"""TelegramStorage 用假的 Telethon 客户端测：参数传得对、按偏移读、文件引用过期会重取。"""
import asyncio
from types import SimpleNamespace

from telethon.errors import FileReferenceExpiredError

from backend.services.telegram_service import CHUNK, TelegramStorage, make_caption, parse_caption


class FakeClient:
    def __init__(self, data):
        self.data = data
        self.sent = None
        self.expire_once = True
        self.fetches = 0

    async def send_file(self, peer, path, **kw):
        self.sent = (peer, path, kw)
        await kw['progress_callback'](len(self.data), len(self.data))
        return SimpleNamespace(id=42, media=None, file=SimpleNamespace(size=len(self.data)))

    async def get_messages(self, peer, ids):
        self.fetches += 1
        return SimpleNamespace(document=SimpleNamespace(size=len(self.data)))

    def iter_download(self, doc, offset, request_size, file_size):
        assert offset % CHUNK == 0 and request_size == CHUNK
        client = self

        async def gen():
            pos = offset
            while pos < len(client.data):
                if client.expire_once and pos > offset:
                    client.expire_once = False
                    raise FileReferenceExpiredError(request=None)
                yield client.data[pos:pos + request_size]
                pos += request_size
        return gen()


def test_upload_and_ranged_read(tmp_path):
    data = bytes(range(256)) * 9000   # ~2.2 MB，跨好几个 512 KB 块
    s = TelegramStorage(SimpleNamespace(data_dir=tmp_path))
    s.client = FakeClient(data)
    s._peers[-1001] = 'PEER'
    seen = []

    async def progress(a, b):
        seen.append((a, b))

    async def go():
        p = tmp_path / 'x.part'
        p.write_bytes(data)
        ref = await s.upload(p, chat_id=-1001, filename='视频.mp4', mime='video/mp4', caption='c', progress=progress)
        out = b''.join([c async for c in s.iter_range(-1001, 42, 600_000, 1_700_000)])
        return ref, out
    ref, out = asyncio.new_event_loop().run_until_complete(go())
    assert ref.message_id == 42 and ref.size == len(data) and seen
    peer, _, kw = s.client.sent
    assert peer == 'PEER' and kw['force_document'] and kw['attributes'][0].file_name == '视频.mp4'
    assert out == data[600_000:1_700_001]
    assert s.client.fetches == 2   # 过期后重取过一次消息


def test_caption_roundtrip_and_limit():
    meta = {'name': '很长的名字' * 300, 'size': 1, 'sha256': 'a' * 64, 'mime': 'x/y', 'path': '/a/b'}
    cap = make_caption(meta)
    assert len(cap) <= 1024
    back = parse_caption(cap)
    assert back['sha256'] == 'a' * 64 and back['size'] == 1
    assert parse_caption('随便一条消息') is None
