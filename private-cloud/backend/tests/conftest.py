import asyncio
import hashlib
import os
import sys
from pathlib import Path

import pytest

sys.path.insert(0, str(Path(__file__).resolve().parents[2]))


@pytest.fixture()
def env(tmp_path, monkeypatch):
    monkeypatch.setenv('DATA_DIR', str(tmp_path / 'data'))
    monkeypatch.setenv('STORAGE_BACKEND', 'local')
    monkeypatch.setenv('TELEGRAM_CHAT_ID', '-1001')
    monkeypatch.setenv('CHUNK_SIZE_MB', '1')
    monkeypatch.setenv('ADMIN_USERNAME', 'admin')
    monkeypatch.setenv('ADMIN_PASSWORD', 'admin-password')
    monkeypatch.setenv('FRONTEND_DIR', str(tmp_path / 'nofrontend'))
    monkeypatch.delenv('DATABASE_URL', raising=False)
    test_db = os.environ.get('TEST_DATABASE_URL')   # 设了就在 PostgreSQL 上跑：TEST_DATABASE_URL=postgresql://...
    if test_db:
        monkeypatch.setenv('DATABASE_URL', test_db)
    from backend import config
    from backend.database import database
    from backend.services import storage_service
    config.reset_settings()
    database.reset_engine()
    if test_db:
        from backend import models  # noqa: F401
        database.Base.metadata.drop_all(database.get_engine())
    storage_service.set_storage(None)
    yield tmp_path
    database.reset_engine()
    config.reset_settings()


@pytest.fixture()
def client(env):
    from fastapi.testclient import TestClient
    from backend.main import app
    with TestClient(app) as c:
        # 等本地存储连上
        for _ in range(50):
            if app.state.storage is not None:
                break
            import time
            time.sleep(0.02)
        r = c.post('/api/auth/login', json={'username': 'admin', 'password': 'admin-password'})
        assert r.status_code == 200, r.text
        yield c


@pytest.fixture()
def storage(client):
    from backend.main import app
    return app.state.storage


def run(coro):
    return asyncio.new_event_loop().run_until_complete(coro)


def drain_worker(storage):
    """把队列里的任务全部跑完（同步调用）。"""
    from backend.workers import upload_worker
    from backend.config import get_settings

    async def go():
        w = upload_worker.UploadWorker(storage, get_settings())
        for _ in range(50):
            n = await w.tick()
            if w.running:
                await asyncio.gather(*list(w.running))
            elif n == 0:
                break
    run(go())


def upload(client, data, name='a.bin', folder_id=None, mime='', complete=True, **extra):
    sha = hashlib.sha256(data).hexdigest()
    r = client.post('/api/upload/create', json={'filename': name, 'file_size': len(data), 'mime_type': mime,
                                                'sha256': sha, 'folder_id': folder_id, **extra})
    assert r.status_code == 200, r.text
    body = r.json()
    if body.get('duplicate'):
        return body
    t = body['task']
    cs = t['chunk_size']
    for i in range(t['total_chunks']):
        if i in t.get('received', []):
            continue
        rr = client.put(f'/api/upload/{t["id"]}/chunks/{i}', content=data[i * cs:(i + 1) * cs])
        assert rr.status_code == 200, rr.text
    if complete:
        rr = client.post(f'/api/upload/{t["id"]}/complete')
        assert rr.status_code == 200, rr.text
    return body
