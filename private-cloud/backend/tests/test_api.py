import hashlib
import os

from .conftest import drain_worker, run, upload

MB = 1024 * 1024


def blob(n, seed=1):
    return (hashlib.sha256(str(seed).encode()).digest() * (n // 32 + 1))[:n]


def test_requires_login(env):
    from fastapi.testclient import TestClient
    from backend.main import app
    with TestClient(app) as c:
        for method, url in [('get', '/api/files'), ('post', '/api/upload/create'), ('delete', '/api/files/1'),
                            ('get', '/api/files/1/download'), ('get', '/api/search?q=a'), ('get', '/api/folders')]:
            assert getattr(c, method)(url).status_code == 401, url
        assert c.post('/api/auth/login', json={'username': 'admin', 'password': 'nope'}).status_code == 401
        assert c.post('/api/auth/login', json={'username': 'admin', 'password': 'admin-password'}).status_code == 200
        assert c.get('/api/auth/me').json()['username'] == 'admin'
        c.post('/api/auth/logout')
        assert c.get('/api/files').status_code == 401


def test_upload_to_telegram_and_download(client, storage):
    data = blob(2 * MB + 12345)
    body = upload(client, data, 'movie.mp4', mime='video/mp4')
    tid = body['task']['id']
    assert body['task']['total_chunks'] == 3
    # 排队中就能预览（从临时文件读）
    files = client.get('/api/files').json()['files']
    assert files[0]['status'] == 'pending'
    assert client.get(f'/api/files/{files[0]["id"]}/stream').content == data

    drain_worker(storage)
    st = client.get(f'/api/upload/{tid}/status').json()
    assert st['status'] == 'completed' and st['progress'] == 100
    f = client.get('/api/files').json()['files'][0]
    assert f['status'] == 'completed' and f['telegram_message_id'] == 1 and f['telegram_chat_id'] == -1001
    assert f['telegram_file_id']
    from backend.services.upload_service import staging_path
    assert not staging_path(tid).exists()

    r = client.get(f'/api/files/{f["id"]}/download')
    assert r.content == data
    assert 'attachment' in r.headers['content-disposition']
    r = client.get(f'/api/files/{f["id"]}/stream', headers={'Range': 'bytes=1000-1999'})
    assert r.status_code == 206 and r.content == data[1000:2000]
    assert r.headers['content-range'] == f'bytes 1000-1999/{len(data)}'
    r = client.get(f'/api/files/{f["id"]}/stream', headers={'Range': f'bytes={len(data)}-'})
    assert r.status_code == 416
    # 说明文字里带元数据，可用于重建索引
    from backend.services.telegram_service import parse_caption
    import json
    meta = parse_caption(json.loads((env_store(storage) / '-1001' / '1.json').read_text())['caption'])
    assert meta['sha256'] == hashlib.sha256(data).hexdigest() and meta['name'] == 'movie.mp4'


def env_store(storage):
    return storage.root


def test_duplicate_detection_and_instant_link(client, storage):
    data = blob(5000)
    upload(client, data, 'video.mp4')
    drain_worker(storage)
    dup = upload(client, data, 'video_new.mp4')
    assert dup['duplicate'] is True and dup['file']['filename'] == 'video.mp4'
    folder = client.post('/api/folders', json={'name': '备份'}).json()
    linked = upload(client, data, 'video_new.mp4', folder_id=folder['id'], link_if_duplicate=True)
    assert linked['linked'] is True
    assert linked['file']['telegram_message_id'] == dup['file']['telegram_message_id']
    # 不同内容同名：不算重复，自动改名
    upload(client, blob(5000, seed=2), 'video.mp4')
    names = sorted(f['filename'] for f in client.get('/api/files').json()['files'])
    assert names == ['video (1).mp4', 'video.mp4']


def test_resume_after_reload(client):
    data = blob(3 * MB)
    sha = hashlib.sha256(data).hexdigest()
    first = client.post('/api/upload/create', json={'filename': 'big.zip', 'file_size': len(data), 'sha256': sha}).json()
    tid = first['task']['id']
    client.put(f'/api/upload/{tid}/chunks/0', content=data[:MB])
    again = client.post('/api/upload/create', json={'filename': 'big.zip', 'file_size': len(data), 'sha256': sha}).json()
    assert again['resume'] is True and again['task']['id'] == tid and again['task']['received'] == [0]
    r = client.post(f'/api/upload/{tid}/complete')
    assert r.status_code == 400 and r.json()['missing'] == [1, 2]
    assert client.put(f'/api/upload/{tid}/chunks/1', content=b'short').status_code == 400


def test_checksum_mismatch_fails_without_retry(client, storage):
    data = blob(1000)
    wrong = hashlib.sha256(b'other').hexdigest()
    t = client.post('/api/upload/create', json={'filename': 'x.bin', 'file_size': len(data), 'sha256': wrong}).json()
    tid = t['task']['id']
    client.put(f'/api/upload/{tid}/chunks/0', content=data)
    client.post(f'/api/upload/{tid}/complete')
    drain_worker(storage)
    st = client.get(f'/api/upload/{tid}/status').json()
    assert st['status'] == 'failed' and '校验' in st['error_message'] and st['retry_count'] == 1


def test_retry_then_fail_then_manual_retry(client, storage, monkeypatch):
    from backend.workers import upload_worker
    monkeypatch.setattr(upload_worker, 'BACKOFF', [0, 0, 0])
    real = storage.upload
    calls = {'n': 0}

    async def flaky(*a, **kw):
        calls['n'] += 1
        raise ConnectionError('network down')
    storage.upload = flaky
    body = upload(client, blob(4000), 'doc.pdf')
    tid = body['task']['id']
    drain_worker(storage)
    st = client.get(f'/api/upload/{tid}/status').json()
    assert calls['n'] == 3 and st['status'] == 'failed' and 'network down' in st['error_message']
    assert client.get('/api/files').json()['files'][0]['status'] == 'failed'
    storage.upload = real
    assert client.post(f'/api/upload/{tid}/retry').json()['status'] == 'queued'
    drain_worker(storage)
    assert client.get(f'/api/upload/{tid}/status').json()['status'] == 'completed'


def test_cancel_during_upload_removes_telegram_message(client, storage):
    body = upload(client, blob(3000), 'a.bin')
    tid = body['task']['id']
    real = storage.upload

    async def upload_then_cancel(*a, **kw):
        ref = await real(*a, **kw)
        client.post(f'/api/upload/{tid}/cancel')
        return ref
    storage.upload = upload_then_cancel
    drain_worker(storage)
    assert client.get(f'/api/upload/{tid}/status').json()['status'] == 'cancelled'
    assert client.get('/api/files').json()['files'] == []
    assert not (storage.root / '-1001' / '1.bin').exists()


def test_folders_tree_move_rename(client):
    v = client.post('/api/folders', json={'name': '视频'}).json()
    m = client.post('/api/folders', json={'name': '电影', 'parent_id': v['id']}).json()
    y = client.post('/api/folders', json={'name': '2026', 'parent_id': m['id']}).json()
    assert client.post('/api/folders', json={'name': '视频'}).status_code == 409
    listing = client.get(f'/api/files?folder_id={y["id"]}').json()
    assert [p['name'] for p in listing['path']] == ['视频', '电影', '2026']
    assert client.post(f'/api/folders/{v["id"]}/move', json={'target_folder_id': y['id']}).status_code == 400
    assert client.post(f'/api/folders/{y["id"]}/move', json={'target_folder_id': None}).status_code == 200
    assert client.post(f'/api/folders/{y["id"]}/rename', json={'name': '视频'}).status_code == 409
    assert client.post(f'/api/folders/{y["id"]}/rename', json={'name': '2025'}).json()['name'] == '2025'
    assert len(client.get('/api/folders').json()['folders']) == 3


def test_trash_restore_and_purge_with_shared_message(client, storage):
    v = client.post('/api/folders', json={'name': '图片'}).json()
    upload(client, blob(2000), 'cat.jpg', folder_id=v['id'], mime='image/jpeg')
    drain_worker(storage)
    f = client.get(f'/api/files?folder_id={v["id"]}').json()['files'][0]
    c = client.post(f'/api/files/{f["id"]}/copy', json={'target_folder_id': None}).json()
    assert c['telegram_message_id'] == f['telegram_message_id']

    assert client.delete(f'/api/folders/{v["id"]}').json()['ok']
    trash = client.get('/api/trash').json()
    assert [x['name'] for x in trash['folders']] == ['图片'] and trash['files'] == []
    assert client.get(f'/api/files/{f["id"]}/download').status_code == 404
    client.post(f'/api/folders/{v["id"]}/restore')
    assert client.get(f'/api/files?folder_id={v["id"]}').json()['files'][0]['id'] == f['id']

    # 删原件并永久删除：副本还在用这条消息 → Telegram 里不删
    client.delete(f'/api/files/{f["id"]}')
    r = client.delete(f'/api/trash/files/{f["id"]}').json()
    assert r['telegram_messages'] == 0 and (storage.root / '-1001' / '1.bin').exists()
    assert client.get(f'/api/files/{c["id"]}/download').content == blob(2000)
    # 再删副本 → 没人用了，Telegram 里一起删
    client.delete(f'/api/files/{c["id"]}')
    assert client.delete('/api/trash').json()['telegram_messages'] == 1
    assert not (storage.root / '-1001' / '1.bin').exists()
    assert client.delete(f'/api/trash/files/{c["id"]}').status_code == 404


def test_search_and_sort(client, storage):
    v = client.post('/api/folders', json={'name': 'Movies'}).json()
    upload(client, blob(100, 1), 'movie.mp4', mime='video/mp4')
    upload(client, blob(300, 2), 'movie2.mp4', mime='video/mp4')
    upload(client, blob(200, 3), 'old_movie.zip')
    upload(client, blob(50, 4), 'notes.txt', folder_id=v['id'])
    drain_worker(storage)
    names = lambda r: sorted(x['filename'] for x in r['files'])  # noqa: E731
    assert names(client.get('/api/search?q=movie').json()) == ['movie.mp4', 'movie2.mp4', 'notes.txt', 'old_movie.zip']
    assert names(client.get('/api/search?q=movie&type=video').json()) == ['movie.mp4', 'movie2.mp4']
    assert names(client.get('/api/search?q=movie&type=archive').json()) == ['old_movie.zip']
    sha = hashlib.sha256(blob(200, 3)).hexdigest()
    assert names(client.get(f'/api/search?q={sha[:10]}').json()) == ['old_movie.zip']
    by_size = [f['filename'] for f in client.get('/api/files?sort=size&order=desc').json()['files']]
    assert by_size == ['movie2.mp4', 'old_movie.zip', 'movie.mp4']
    assert client.get('/api/search?q=100%').json()['files'] == []


def test_other_users_cannot_touch_files(client, storage):
    upload(client, blob(100), 'secret.txt')
    drain_worker(storage)
    fid = client.get('/api/files').json()['files'][0]['id']
    assert client.post('/api/admin/users', json={'username': 'bob', 'password': 'bob-password'}).status_code == 200
    from fastapi.testclient import TestClient
    from backend.main import app
    bob = TestClient(app)
    bob.post('/api/auth/login', json={'username': 'bob', 'password': 'bob-password'})
    assert bob.get('/api/files').json()['files'] == []
    for method, url in [('get', f'/api/files/{fid}/download'), ('delete', f'/api/files/{fid}'),
                        ('post', f'/api/files/{fid}/rename')]:
        kw = {'json': {'name': 'x'}} if method == 'post' else {}
        assert getattr(bob, method)(url, **kw).status_code == 404
    assert bob.get('/api/admin/stats').status_code == 403
    # bob 传同一个文件：查重只在自己的文件里查
    assert upload(bob, blob(100), 'secret.txt').get('duplicate') is False


def test_html_is_never_served_inline(client, storage):
    upload(client, b'<script>alert(1)</script>', 'evil.html', mime='text/html')
    drain_worker(storage)
    fid = client.get('/api/files').json()['files'][0]['id']
    r = client.get(f'/api/files/{fid}/stream')
    assert r.headers['content-disposition'].startswith('attachment')
    assert 'sandbox' in r.headers['content-security-policy']


def test_trashing_unfinished_upload_cancels_it(client):
    body = upload(client, blob(500), 'a.bin', complete=False)
    fid = body['task']['file_id']
    client.delete(f'/api/files/{fid}')
    assert client.get(f'/api/upload/{body["task"]["id"]}/status').json()['status'] == 'cancelled'
    assert client.get('/api/trash').json()['files'] == []


def test_admin_stats_logs_backup_restore(client, storage, tmp_path):
    v = client.post('/api/folders', json={'name': '文档'}).json()
    upload(client, blob(1000), 'a.pdf', folder_id=v['id'], mime='application/pdf')
    drain_worker(storage)
    s = client.get('/api/admin/stats').json()
    assert s['files'] == 1 and s['by_type']['document']['count'] == 1 and s['tasks']['completed'] == 1
    events = [x['event'] for x in client.get('/api/admin/logs').json()['logs']]
    assert 'upload_completed' in events and 'login' in events
    b = client.post('/api/admin/backups?to_telegram=true').json()
    assert b['files'] == 1 and b['telegram']['message_id'] == 2
    raw = client.get(f'/api/admin/backups/{b["name"]}').content
    import gzip
    import json
    data = json.loads(gzip.decompress(raw))
    assert data['files'][0]['filename'] == 'a.pdf'

    # 恢复到一个新的空库
    from backend import config
    from backend.database import database, init_db, session_scope
    from backend.models import File, Folder
    from backend.services import backup_service
    os.environ['DATABASE_URL'] = f'sqlite:///{tmp_path / "restored.db"}'
    try:
        config.reset_settings()
        database.reset_engine()
        init_db()
        with session_scope() as db:
            backup_service.restore_data(db, data)
        with session_scope() as db:
            f = db.query(File).one()
            assert f.telegram_message_id == 1 and db.get(Folder, f.folder_id).name == '文档'
    finally:
        del os.environ['DATABASE_URL']
        config.reset_settings()
        database.reset_engine()


def test_rebuild_index_from_telegram(client, storage):
    v = client.post('/api/folders', json={'name': '软件'}).json()
    upload(client, blob(1000), 'tool.zip', folder_id=v['id'])
    upload(client, blob(2000, 2), 'root.txt')
    drain_worker(storage)
    # 模拟数据库丢失：直接删记录（Telegram 里的消息还在）
    from backend.database import session_scope
    from backend.models import File, Folder
    with session_scope() as db:
        db.query(File).delete()
        db.query(Folder).delete()
    from backend.services.backup_service import RebuildJob

    async def go():
        job = RebuildJob()
        job.start(storage, 1)
        await job.task
        return job.state
    state = run(go())
    assert state['error'] is None and state['added'] == 2
    root = client.get('/api/files').json()
    assert [f['filename'] for f in root['files']] == ['root.txt'] and root['folders'][0]['name'] == '软件'
    sub = client.get(f'/api/files?folder_id={root["folders"][0]["id"]}').json()
    assert sub['files'][0]['filename'] == 'tool.zip'
    assert client.get(f'/api/files/{sub["files"][0]["id"]}/download').content == blob(1000)
