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
