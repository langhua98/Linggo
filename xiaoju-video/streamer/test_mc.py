"""MediaCrawler 结果解析、命令行：python -m pytest -q"""

import json

from mc import cookie_header, item_from_row, items_from, mc_args, read_rows


def row(aid, video='', notes='', desc='x'):
    return {'aweme_id': aid, 'desc': desc, 'create_time': 1700000000, 'cover_url': 'https://p3.douyinpic.com/c.jpeg',
            'video_download_url': video, 'note_download_url': notes, 'nickname': '小*'}


def test_item_from_row():
    v = item_from_row(row('7300000000000000001', video='http://v26.douyinvod.com/abc'))
    assert v == {'aweme': '7300000000000000001', 'desc': 'x', 'create_time': 1700000000,
                 'cover': 'https://p3.douyinpic.com/c.jpeg', 'type': 'video',
                 'video_url': 'https://v26.douyinvod.com/abc', 'url': 'https://www.douyin.com/video/7300000000000000001'}
    i = item_from_row(row('7300000000000000002', notes='https://p3.douyinpic.com/1.webp,//p3.douyinpic.com/2.webp,'))
    assert i['type'] == 'images' and i['images'] == ['https://p3.douyinpic.com/1.webp', 'https://p3.douyinpic.com/2.webp']
    assert item_from_row(row('7300000000000000003')) is None  # 没有视频地址
    assert item_from_row(row('abc', video='https://v.douyinvod.com/x')) is None


def test_read_rows_only_contents(tmp_path):
    d = tmp_path / 'dy' / 'jsonl'
    d.mkdir(parents=True)
    (d / 'creator_contents_2026-10-04.jsonl').write_text(
        json.dumps(row('7300000000000000001', video='https://v.douyinvod.com/1')) + '\n\nnot json\n', encoding='utf-8')
    (d / 'creator_comments_2026-10-04.jsonl').write_text('{"comment_id":"1"}\n', encoding='utf-8')
    rows = read_rows(str(tmp_path))
    assert len(rows) == 1 and items_from(rows + rows)[0]['aweme'] == '7300000000000000001'


def test_mc_args():
    a = mc_args('creator', 'https://www.douyin.com/user/MS4wLjABAAAAx', '/d', cookies='a=b; c=d')
    assert a[a.index('--type') + 1] == 'creator' and a[a.index('--creator_id') + 1].endswith('MS4wLjABAAAAx')
    assert a[a.index('--lt') + 1] == 'cookie' and a[a.index('--cookies') + 1] == 'a=b; c=d'
    assert a[a.index('--get_comment') + 1] == 'no' and '--keywords' not in a
    d = mc_args('detail', '7300000000000000001,https://v.douyin.com/x/', '/d')
    assert d[d.index('--lt') + 1] == 'qrcode' and d[d.index('--specified_id') + 1].startswith('7300')


def test_cookie_header_only_douyin():
    cookies = [{'name': 'sessionid', 'value': 's1', 'domain': '.douyin.com'},
               {'name': 'ttwid', 'value': 't', 'domain': 'www.douyin.com'},
               {'name': 'x', 'value': 'y', 'domain': '.example.com'}, 'junk']
    assert cookie_header(cookies) == 'sessionid=s1; ttwid=t'


def test_search_args_and_author():
    a = mc_args('search', '小橘,猫', '/d', cookies='a=b', max_notes=50)
    assert a[a.index('--type') + 1] == 'search' and a[a.index('--keywords') + 1] == '小橘,猫'
    assert a[a.index('--crawler_max_notes_count') + 1] == '50' and '--creator_id' not in a
    r = row('7300000000000000009', video='https://v.douyinvod.com/9')
    r.update(author_sec_uid='MS4wLjABAAAAalt0123456789', author_nickname='小橘的小号')
    it = item_from_row(r)
    assert it['author_sec_uid'] == 'MS4wLjABAAAAalt0123456789' and it['author'] == '小橘的小号'
    r['author_sec_uid'] = 'bad'
    assert 'author_sec_uid' not in item_from_row(r)


def test_kuaishou_rows():
    from mc import item_from_row, mc_args, cookie_header
    row = {'video_id': '3x3zxz4mjrsc8ke', 'title': '快手作品', 'desc': '快手作品', 'create_time': 1700000000123,
           'video_play_url': 'http://v.ks/low.mp4', 'best_play_url': 'https://v.ks/1080.mp4',
           'video_cover_url': 'https://p.ks/c.jpg', 'author_id': '3x84qugg4ch9zhs', 'author_nickname': '快手小号'}
    assert item_from_row(row) == {
        'aweme': 'ks_3x3zxz4mjrsc8ke', 'platform': 'ks', 'type': 'video', 'video_url': 'https://v.ks/1080.mp4',
        'url': 'https://www.kuaishou.com/short-video/3x3zxz4mjrsc8ke', 'desc': '快手作品', 'create_time': 1700000000,
        'author_sec_uid': '3x84qugg4ch9zhs', 'author': '快手小号', 'cover': 'https://p.ks/c.jpg'}
    assert item_from_row({**row, 'best_play_url': ''})['video_url'] == 'https://v.ks/low.mp4'  # 没挑出来用原来的
    assert item_from_row({**row, 'video_id': 'a/b'}) is None
    assert item_from_row({**row, 'best_play_url': '', 'video_play_url': ''}) is None
    args = mc_args('creator', 'https://www.kuaishou.com/profile/3x84', '/d', 'a=b', platform='ks')
    assert args[args.index('--platform') + 1] == 'ks'
    cookies = [{'name': 'passToken', 'value': 'p', 'domain': '.kuaishou.com'}, {'name': 'x', 'value': 'y', 'domain': '.douyin.com'}]
    assert cookie_header(cookies, 'kuaishou.com') == 'passToken=p'
