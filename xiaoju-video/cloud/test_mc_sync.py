"""云电脑脚本里不用浏览器、不用 MediaCrawler 的部分：python -m pytest -q xiaoju-video/cloud"""

import json

import mc_sync as m


def row(aid, video='', notes='', desc='x'):
    return {'aweme_id': aid, 'desc': desc, 'create_time': 1700000000, 'cover_url': 'https://p3.douyinpic.com/c.jpeg',
            'video_download_url': video, 'note_download_url': notes, 'nickname': '小*'}


def test_item_from_row():
    v = m.item_from_row(row('7300000000000000001', video='http://v26.douyinvod.com/abc'))
    assert v == {'aweme': '7300000000000000001', 'desc': 'x', 'create_time': 1700000000,
                 'cover': 'https://p3.douyinpic.com/c.jpeg', 'type': 'video',
                 'video_url': 'https://v26.douyinvod.com/abc', 'url': 'https://www.douyin.com/video/7300000000000000001'}
    i = m.item_from_row(row('7300000000000000002', notes='https://p3.douyinpic.com/1.webp,//p3.douyinpic.com/2.webp,'))
    assert i['type'] == 'images' and i['images'] == ['https://p3.douyinpic.com/1.webp', 'https://p3.douyinpic.com/2.webp']
    assert m.item_from_row(row('7300000000000000003')) is None  # 没有视频地址
    assert m.item_from_row(row('abc', video='https://v.douyinvod.com/x')) is None


def test_read_rows_and_dedup(tmp_path):
    d = tmp_path / 'dy' / 'jsonl'
    d.mkdir(parents=True)
    (d / 'creator_contents_2026-10-04.jsonl').write_text(
        json.dumps(row('7300000000000000001', video='https://v.douyinvod.com/1')) + '\n\nnot json\n' +
        json.dumps(row('7300000000000000001', video='https://v.douyinvod.com/1')) + '\n', encoding='utf-8')
    (d / 'creator_comments_2026-10-04.jsonl').write_text('{"comment_id":"1"}\n', encoding='utf-8')
    rows = m.read_rows(str(tmp_path))
    assert len(rows) == 2
    assert [i['aweme'] for i in m.items_from(rows)] == ['7300000000000000001']


def test_mc_args_only_works_no_comments():
    a = m.mc_args('creator', 'https://www.douyin.com/user/MS4wLjABAAAAx', '/tmp/d')
    assert a[:4] == ['uv', 'run', 'main.py', '--platform'] and 'dy' in a
    assert a[a.index('--get_comment') + 1] == 'no'
    assert a[a.index('--creator_id') + 1] == 'https://www.douyin.com/user/MS4wLjABAAAAx'
    assert '--keywords' not in a
    d = m.mc_args('detail', 'https://v.douyin.com/abc/', '/tmp/d')
    assert d[d.index('--type') + 1] == 'detail' and d[d.index('--specified_id') + 1] == 'https://v.douyin.com/abc/'


def test_homepage_must_be_full_user_url():
    assert m.HOMEPAGE.match('https://www.douyin.com/user/MS4wLjABAAAAabc-DEF_1?from_tab_name=main')
    assert not m.HOMEPAGE.match('https://v.douyin.com/abc/')
    assert not m.HOMEPAGE.match('https://www.douyin.com/user/self')


def test_push_sends_only_new_in_batches(monkeypatch):
    calls = []

    def fake(cfg, path, body):
        calls.append((path, body))
        if path == '/dy-known':
            return {'known': ['7300000000000000000']}
        if path == '/dy-import':
            return {'added': len(body['items'])}
        return {'ok': True}

    monkeypatch.setattr(m, 'worker_call', fake)
    items = [{'aweme': f'73000000000000{i:05d}'} for i in range(250)]
    assert m.push({}, items, report=lambda s: None) == 249
    assert [len(b['items']) for p, b in calls if p == '/dy-import'] == [100, 100, 49]
    assert calls[-1][1]['stage'] == '完成'
