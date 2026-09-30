"""切片服务的本地测试：假的 Telegram（MTProto 下载 + Bot API 上传）和假的 Worker，不联网。

    pip install -r requirements.txt pytest && python -m pytest -q
"""

import asyncio
import json

import httpx
import pytest
from fastapi.testclient import TestClient

import app as appmod
from app import Splitter

TOKEN = '123:SECRET-BOT-TOKEN'
ADMIN = 'admin-key'
WORKER = 'https://worker.example'


class Fake:
    """记录发出去的请求；按需模拟 Telegram 限速、Worker 拒绝等情况。"""

    def __init__(self, *, limit_once=False, commit_status=200):
        self.uploads = []
        self.reports = []
        self.commits = []
        self.limit_once = limit_once
        self.commit_status = commit_status

    def handler(self, request):
        url = str(request.url)
        if url.endswith('/sendDocument'):
            assert TOKEN in url
            if self.limit_once:
                self.limit_once = False
                return httpx.Response(429, json={'ok': False, 'description': 'Too Many Requests', 'parameters': {'retry_after': 3}})
            body = request.read()
            self.uploads.append(body)
            size = len(body.split(b'application/octet-stream\r\n\r\n', 1)[1].rsplit(b'\r\n--', 1)[0])
            return httpx.Response(200, json={'ok': True, 'result': {'document': {'file_id': f'P{len(self.uploads)}', 'file_size': size}}})
        assert request.headers['authorization'] == 'Bearer ' + ADMIN
        payload = json.loads(request.read())
        if url == WORKER + '/admin/api/status':
            self.reports.append((payload['status'], payload['note']))
            return httpx.Response(200, json={'ok': True})
        if url == WORKER + '/admin/api/commit':
            self.commits.append(payload)
            return httpx.Response(self.commit_status, json={'ok': True} if self.commit_status == 200 else {'error': '大小和频道里的文件不一致'})
        raise AssertionError('unexpected request ' + url)


def run_job(data, *, size=None, found=True, part_size=1000, fake=None, download_error=None):
    fake = fake or Fake()
    sleeps = []

    async def no_sleep(seconds):
        sleeps.append(seconds)

    async def fetch_message(channel, message_id):
        assert (channel, message_id) == ('xiaojumusic', 12)
        return (len(data), 'DOC') if found else None

    async def iter_download(document):
        assert document == 'DOC'
        for i in range(0, len(data), 300):  # 故意用和分片大小对不齐的块
            if download_error and i >= 600:
                raise download_error
            yield data[i:i + 300]

    async def main():
        async with httpx.AsyncClient(transport=httpx.MockTransport(fake.handler)) as http:
            s = Splitter(bot_token=TOKEN, worker_url=WORKER + '/', admin_key=ADMIN, http=http,
                         fetch_message=fetch_message, iter_download=iter_download, sleep=no_sleep)
            task = asyncio.create_task(s.run())
            assert s.submit({'track': 12, 'size': size or len(data), 'part_size': part_size, 'storage': '-100999', 'channel': 'xiaojumusic'})
            assert not s.submit({'track': 12, 'size': 1, 'part_size': 1, 'storage': '-100999', 'channel': 'xiaojumusic'})
            await s.queue.join()
            task.cancel()
            return s

    s = asyncio.run(main())
    return fake, sleeps, s


def test_splits_into_parts_and_commits():
    data = bytes(range(256)) * 10  # 2560 字节 → 1000 + 1000 + 560
    fake, _, s = run_job(data)
    assert len(fake.uploads) == 3
    assert b'name="chat_id"\r\n\r\n-100999' in fake.uploads[0]
    assert b'#t12 1/3' in fake.uploads[0] and b'filename="t12-p3of3.bin"' in fake.uploads[2]
    assert b'name="disable_content_type_detection"\r\n\r\ntrue' in fake.uploads[1]
    joined = b''.join(u.split(b'application/octet-stream\r\n\r\n', 1)[1].rsplit(b'\r\n--', 1)[0] for u in fake.uploads)
    assert joined == data
    assert fake.commits == [{'track': 12, 'size': 2560, 'parts': [
        {'file_id': 'P1', 'size': 1000}, {'file_id': 'P2', 'size': 1000}, {'file_id': 'P3', 'size': 560}]}]
    assert fake.reports == [('processing', '正在下载原文件'), ('processing', '1/3'), ('processing', '2/3')]
    assert not s.active


def test_exact_multiple_has_no_empty_tail():
    fake, _, _ = run_job(b'x' * 2000)
    assert [p['size'] for p in fake.commits[0]['parts']] == [1000, 1000]


def test_waits_when_telegram_rate_limits():
    fake, sleeps, _ = run_job(b'y' * 1500, fake=Fake(limit_once=True))
    assert sleeps == [4]
    assert len(fake.commits) == 1


def test_size_mismatch_is_reported_as_failed():
    fake, _, _ = run_job(b'z' * 1500, size=1600)
    assert fake.uploads == [] and fake.commits == []
    assert fake.reports[-1][0] == 'failed' and '对不上' in fake.reports[-1][1]


def test_missing_message_is_reported_as_failed():
    fake, _, _ = run_job(b'z' * 10, found=False)
    assert fake.reports[-1] == ('failed', '频道里找不到这条音频')


def test_errors_never_leak_the_bot_token():
    fake, _, _ = run_job(b'q' * 2000, download_error=RuntimeError('boom at ' + TOKEN))
    status, note = fake.reports[-1]
    assert status == 'failed' and TOKEN not in note and '***' in note


def test_worker_rejecting_commit_is_reported():
    fake, _, _ = run_job(b'w' * 1200, fake=Fake(commit_status=400))
    assert fake.reports[-1][0] == 'failed' and '拒绝' in fake.reports[-1][1]


def test_submit_validates_sizes():
    s = Splitter(bot_token=TOKEN, worker_url=WORKER, admin_key=ADMIN, http=None, fetch_message=None, iter_download=None)
    with pytest.raises(ValueError):
        s.submit({'track': 1, 'size': 10, 'part_size': 21 * 1024 * 1024, 'storage': '1', 'channel': 'c'})
    with pytest.raises(KeyError):
        s.submit({'track': 1})


def test_http_endpoint_checks_the_key(monkeypatch):
    monkeypatch.setenv('SPLITTER_KEY', 'k1')
    accepted = []

    class Stub:
        def submit(self, job):
            accepted.append(job)
            return True

    monkeypatch.setattr(appmod, 'splitter', Stub())
    client = TestClient(appmod.app)  # 不进 with，就不会触发登录 Telegram 的 lifespan
    assert client.get('/').json() == {'ok': True}
    assert client.post('/split', json={'track': 1}).status_code == 403
    assert client.post('/split', json={'track': 1}, headers={'X-Key': 'wrong'}).status_code == 403
    r = client.post('/split', json={'track': 1}, headers={'X-Key': 'k1'})
    assert r.json() == {'accepted': True} and accepted == [{'track': 1}]


def test_client_never_subscribes_to_updates(monkeypatch):
    seen = {}

    class FakeClient:
        def __init__(self, session, api_id, api_hash, **kw):
            seen.update(api_id=api_id, api_hash=api_hash, **kw)

    monkeypatch.setattr(appmod, 'TelegramClient', FakeClient)
    appmod.make_client({'TG_API_ID': '123', 'TG_API_HASH': 'abc'})
    assert seen == {'api_id': 123, 'api_hash': 'abc', 'receive_updates': False}
