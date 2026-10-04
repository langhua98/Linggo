"""不联网的本地测试：模拟 Telegram、抖音分享页和下载。python -m pytest -q"""

import asyncio
import json
import os
from types import SimpleNamespace

import pytest
from fastapi.testclient import TestClient

os.environ['STREAMER_KEY'] = 'k'  # 强制：外面环境里的真密钥不能带进测试

import app as appmod  # noqa: E402
from app import CAPTION_LIMIT, Poster, Streamer, caption_for, parse_range  # noqa: E402
from douyin import Douyin, DouyinError, aweme_of, find_link, parse_share_page, to_item  # noqa: E402

AW = '7300000000000000001'


def share_page(item):
    data = {'loaderData': {'video_(id)/page': {'videoInfoRes': {'item_list': [item]}}}}
    return f'<html><script>window._ROUTER_DATA = {json.dumps(data)}</script></html>'


RAW_VIDEO = {
    'aweme_id': AW, 'desc': '我的猫', 'create_time': 1700000000, 'author': {'nickname': '小橘'},
    'video': {'play_addr': {'url_list': ['https://aweme.snssdk.com/aweme/v1/playwm/?video_id=v0200']},
              'cover': {'url_list': ['https://p3.douyinpic.com/c.jpeg']}},
}
RAW_NOTE = {'aweme_id': '7300000000000000002', 'desc': '图文', 'images': [
    {'url_list': ['https://p3.douyinpic.com/1.webp']}, {'url_list': ['//p3.douyinpic.com/2.webp']}], 'video': {}}


# ── 纯函数 ──

def test_parse_range():
    assert parse_range(None, 100) == (0, 99, False)
    assert parse_range('bytes=10-19', 100) == (10, 19, True)
    assert parse_range('bytes=-5', 100) == (95, 99, True)
    assert parse_range('bytes=100-', 100) is None


def test_caption_keeps_tag_within_limit():
    assert caption_for({'aweme': AW, 'desc': ''}) == f'#dy{AW}'
    c = caption_for({'aweme': AW, 'desc': '字' * 5000})
    assert len(c) <= CAPTION_LIMIT and c.endswith(f'#dy{AW}')


def test_links_and_ids():
    assert find_link('复制打开抖音 https://v.douyin.com/iAbC/ 看看') == 'https://v.douyin.com/iAbC/'
    assert find_link('nothing') is None
    assert aweme_of(f'https://www.iesdouyin.com/share/video/{AW}/?region=CN') == AW
    assert aweme_of(f'https://www.douyin.com/user/self?modal_id={AW}') == AW
    assert aweme_of('https://www.douyin.com/user/self') is None


def test_share_page_video_and_note():
    item = to_item(parse_share_page(share_page(RAW_VIDEO)))
    assert item['type'] == 'video'
    assert item['video_url'] == 'https://aweme.snssdk.com/aweme/v1/play/?video_id=v0200'  # 去水印
    assert item['author'] == '小橘' and item['cover'].startswith('https://')
    note = to_item(parse_share_page(share_page(RAW_NOTE)))
    assert note['type'] == 'images'
    assert note['images'] == ['https://p3.douyinpic.com/1.webp', 'https://p3.douyinpic.com/2.webp']


def test_share_page_errors():
    with pytest.raises(DouyinError):
        parse_share_page('<html>验证码</html>')
    blocked = {'loaderData': {'x': {'videoInfoRes': {'item_list': [], 'filter_list': [{'detail_msg': '作品已删除'}]}}}}
    with pytest.raises(DouyinError, match='作品已删除'):
        parse_share_page(f'<script>window._ROUTER_DATA = {json.dumps(blocked)}</script>')


class FakeHttp:
    def __init__(self, pages):
        self.pages = pages
        self.calls = []

    async def get(self, url, headers=None, follow_redirects=False):
        self.calls.append(url)
        status, text, loc = self.pages.get(url, (404, '', None))
        return SimpleNamespace(status_code=status, text=text, headers={'location': loc} if loc else {})


def test_resolve_short_link():
    note_url = 'https://www.iesdouyin.com/share/note/7300000000000000002/'
    http = FakeHttp({
        'https://v.douyin.com/abc/': (302, '', note_url + '?from=web'),
        note_url: (200, share_page(RAW_NOTE), None),
    })
    item = asyncio.run(Douyin(http).resolve('看看 https://v.douyin.com/abc/'))
    assert item['type'] == 'images' and item['aweme'] == '7300000000000000002'
    with pytest.raises(DouyinError, match='短链接'):
        asyncio.run(Douyin(FakeHttp({})).resolve('https://v.douyin.com/dead/'))


# ── 转作品 ──

class Fakes:
    def __init__(self):
        self.downloads = []
        self.videos = []
        self.albums = []
        self.reports = []
        self.posted = {}
        self.bad_urls = set()
        self.next_id = 100

    async def download(self, url, path):
        self.downloads.append(url)
        if url in self.bad_urls:
            raise DouyinError('下载回 403')
        with open(path, 'wb') as f:
            f.write(b'x' * 2048)

    async def prepare(self, src, work):
        return {'path': src, 'thumb': None, 'duration': 10, 'width': 720, 'height': 1280}

    async def send_video(self, info, caption):
        self.next_id += 1
        self.videos.append(caption)
        return self.next_id

    async def send_images(self, paths, caption):
        self.next_id += 1
        self.albums.append((len(paths), caption))
        return self.next_id

    async def already_posted(self, aweme):
        return self.posted.get(aweme)

    def report(self, body):
        self.reports.append(body)


class FakeDouyin:
    def __init__(self, fresh):
        self.fresh = fresh
        self.asked = []

    async def by_id(self, aweme, kind='video'):
        self.asked.append(aweme)
        if aweme not in self.fresh:
            raise DouyinError('作品不存在或已删除')
        return self.fresh[aweme]


def make_poster(f, dy):
    return Poster(douyin=dy, download=f.download, prepare=f.prepare, send_video=f.send_video,
                  send_images=f.send_images, already_posted=f.already_posted, report=f.report)




def run_all(p, f, n):
    async def go():
        task = asyncio.create_task(p.run())
        for _ in range(500):
            await asyncio.sleep(0)
            if len(f.reports) >= n:
                break
        task.cancel()
    asyncio.run(go())


def test_poster_video_image_skip_and_refetch():
    f = Fakes()
    f.bad_urls.add('https://cdn/expired.mp4')
    f.posted['7300000000000000009'] = 55
    dy = FakeDouyin({'7300000000000000003': {'type': 'video', 'video_url': 'https://cdn/fresh.mp4'}})
    p = make_poster(f, dy)
    added = p.add([
        {'aweme': AW, 'type': 'video', 'desc': '一', 'video_url': 'https://cdn/1.mp4'},
        {'aweme': AW, 'type': 'video'},  # 重复的不再排
        {'aweme': '7300000000000000002', 'type': 'images', 'desc': '图', 'images': [f'https://cdn/{i}.jpg' for i in range(12)]},
        {'aweme': '7300000000000000003', 'type': 'video', 'video_url': 'https://cdn/expired.mp4'},
        {'aweme': '7300000000000000004', 'type': 'video', 'video_url': 'https://cdn/expired.mp4'},
        {'aweme': '7300000000000000009', 'type': 'video', 'video_url': 'https://cdn/x.mp4'},
        {'aweme': 'bad'},
    ])
    assert added == 5
    run_all(p, f, 5)
    by = {r['aweme']: r for r in f.reports}
    assert by[AW]['ok'] and f.videos[0] == f'一\n\n#dy{AW}'
    assert by['7300000000000000002']['ok'] and f.albums == [(12, f'图\n\n#dy7300000000000000002')]
    assert by['7300000000000000003']['ok'] and 'https://cdn/fresh.mp4' in f.downloads  # 过期地址按作品号重取
    assert not by['7300000000000000004']['ok'] and '不存在' in by['7300000000000000004']['error']
    assert by['7300000000000000009'] == {'aweme': '7300000000000000009', 'ok': True, 'message_id': 55, 'idle': True}
    assert [r['idle'] for r in f.reports] == [False, False, False, False, True]


# ── 大视频流 ──

class Doc:
    def __init__(self, data):
        self.data = data
        self.size = len(data)
        self.mime_type = 'video/mp4'
        self.thumbs = [1]


def make_streamer(data):
    msg = SimpleNamespace(document=Doc(data))

    async def fetch_message(mid):
        return msg if mid == 7 else None

    def iter_download(doc, offset, request_size, file_size):
        assert offset % request_size == 0

        async def gen():
            for i in range(offset, doc.size, request_size):
                yield doc.data[i:i + request_size]
        return gen()

    async def download_thumb(m):
        return b'\xff\xd8thumb'

    return Streamer(fetch_message=fetch_message, iter_download=iter_download, download_thumb=download_thumb)


def test_stream_endpoint():
    data = bytes((i * 7) & 255 for i in range(3 * 512 * 1024 + 100))
    appmod.streamer = make_streamer(data)
    c = TestClient(appmod.app)
    assert c.get('/stream/7').status_code == 403
    h = {'X-Key': 'k'}
    r = c.get('/stream/7', headers={**h, 'Range': 'bytes=600000-600099'})
    assert r.status_code == 206 and r.content == data[600000:600100]
    assert r.headers['content-range'] == f'bytes 600000-600099/{len(data)}'
    r = c.get('/stream/7', headers=h)
    assert r.status_code == 200 and r.content == data
    assert c.get('/stream/7', headers={**h, 'Range': f'bytes={len(data)}-'}).status_code == 416
    r = c.get('/stream/8', headers=h)
    assert r.status_code == 404 and r.json() == {'detail': 'gone'}
    assert c.get('/thumb/7', headers=h).content == b'\xff\xd8thumb'


def test_post_and_resolve_endpoints():
    f = Fakes()
    appmod.poster = make_poster(f, FakeDouyin({}))
    appmod.douyin = Douyin(FakeHttp({}))
    c = TestClient(appmod.app)
    h = {'X-Key': 'k'}
    r = c.post('/douyin/post', json={'items': [{'aweme': AW, 'type': 'video'}]}, headers=h)
    assert r.json()['added'] == 1 and r.json()['queued'] == 1
    assert c.post('/douyin/post', json={'items': 'x'}, headers=h).status_code == 400
    r = c.post('/douyin/resolve', json={'url': '没有链接'}, headers=h)
    assert r.status_code == 400 and r.json()['error'] == '没找到抖音链接'
    assert c.post('/douyin/resolve', json={'url': 'x'}).status_code == 403


def test_expand_endpoint_tells_profile_from_work():
    sec = 'MS4wLjABAAAAaltaccount000001'
    appmod.douyin = Douyin(FakeHttp({
        'https://v.douyin.com/user1/': (302, '', f'https://www.iesdouyin.com/share/user/{sec}?from_ssr=1'),
        'https://v.douyin.com/vid1/': (302, '', 'https://www.iesdouyin.com/share/video/7300000000000000009/?x=1'),
    }))
    c = TestClient(appmod.app)
    h = {'X-Key': 'k'}
    r = c.post('/douyin/expand', json={'urls': ['https://v.douyin.com/user1/', 'https://v.douyin.com/vid1/',
                                                'https://v.douyin.com/dead/', f'https://www.douyin.com/user/{sec}']}, headers=h)
    res = r.json()['results']
    assert res[0]['sec_uid'] == sec and 'aweme' not in res[0]
    assert res[1]['aweme'] == '7300000000000000009' and 'sec_uid' not in res[1]
    assert '短链接' in res[2]['error']
    assert res[3]['sec_uid'] == sec  # 长链接不用跳
    assert c.post('/douyin/expand', json={'urls': 'x'}, headers=h).status_code == 400
    assert c.post('/douyin/expand', json={'urls': []}).status_code == 403


def test_outbox_endpoint():
    from outbox import Outbox
    appmod.outbox = Outbox(boot='b1')
    appmod.jobs = None
    appmod.poster = make_poster(Fakes(), FakeDouyin({}))
    appmod.outbox.put('done', aweme=AW, ok=True, message_id=5, idle=True)
    appmod.outbox.put('say', chat_id=1, text='hi', png=None)
    c = TestClient(appmod.app)
    assert c.get('/outbox').status_code == 403
    h = {'X-Key': 'k'}
    r = c.get('/outbox', headers=h).json()
    assert r['boot'] == 'b1' and [e['seq'] for e in r['events']] == [1, 2] and r['busy'] is False
    r = c.get('/outbox?boot=b1&after=1', headers=h).json()
    assert [e['kind'] for e in r['events']] == ['say']
    r = c.get('/outbox?boot=b1&after=2&wait=1', headers=h).json()  # 没事：等 1 秒后空手回
    assert r['events'] == []
    appmod.poster.add([{'aweme': AW, 'type': 'video'}])
    assert c.get('/outbox?boot=b1&after=2', headers=h).json()['busy'] is True


def test_ffmpeg_prepare_tags_hevc_for_apple(tmp_path):
    """H.265 的视频：不重新编码，mp4 里的标签改成 hvc1；H.264 的不动"""
    import shutil
    import subprocess
    if not shutil.which('ffmpeg'):
        pytest.skip('没装 ffmpeg')
    for codec, want in (('libx265', 'hvc1'), ('libx264', 'avc1')):
        src = str(tmp_path / f'{codec}.mp4')
        extra = ['-tag:v', 'hev1'] if codec == 'libx265' else []  # 抖音给的常是 hev1，苹果不认
        subprocess.run(['ffmpeg', '-v', 'error', '-y', '-f', 'lavfi', '-i', 'testsrc=size=320x240:rate=10:duration=1',
                        '-c:v', codec, *extra, src], check=True)
        work = tmp_path / codec
        work.mkdir()
        info = appmod.ffmpeg_prepare(src, str(work))
        tagged = subprocess.run(['ffprobe', '-v', 'error', '-select_streams', 'v:0', '-show_entries', 'stream=codec_tag_string',
                                 '-of', 'csv=p=0', info['path']], capture_output=True, text=True).stdout.strip()
        assert tagged == want and info['width'] == 320 and info['height'] == 240


def test_video_info_only_media_fields():
    import datetime
    when = datetime.datetime(2026, 1, 2, tzinfo=datetime.timezone.utc)
    f = SimpleNamespace(mime_type='video/mp4', size=123, duration=9.6, width=1080, height=1920)
    msg = SimpleNamespace(id=7, video=object(), document=object(), file=f, gif=None, video_note=None, date=when,
                          message='说明 #标签')
    info = appmod.video_info(msg)
    assert info == {'id': 7, 'size': 123, 'duration': 10, 'width': 1080, 'height': 1920, 'mime': 'video/mp4',
                    'date': int(when.timestamp())}
    assert '说明' not in json.dumps(info, ensure_ascii=False)
    assert appmod.video_info(SimpleNamespace(id=8, video=None, document=None, file=None)) is None  # 文字帖
    photo = SimpleNamespace(id=9, video=None, document=object(), file=SimpleNamespace(mime_type='image/jpeg'), gif=None, video_note=None)
    assert appmod.video_info(photo) is None
    assert appmod.video_info(SimpleNamespace(**{**msg.__dict__, 'gif': object()})) is None


def test_channel_videos_endpoint():
    calls = []

    async def scan(after, limit):
        calls.append((after, limit))
        return {'videos': [{'id': after + 1}], 'last': after + limit, 'done': False}

    appmod.channel_scan = scan
    c = TestClient(appmod.app)
    h = {'X-Key': 'k'}
    r = c.post('/channel/videos', json={'after': 100, 'limit': 9999}, headers=h)
    assert r.json() == {'videos': [{'id': 101}], 'last': 600, 'done': False} and calls == [(100, 500)]
    assert c.post('/channel/videos', json={'after': 'x'}, headers=h).status_code == 400
    assert c.post('/channel/videos', json={}).status_code == 403
    appmod.channel_scan = None
    assert c.post('/channel/videos', json={}, headers=h).status_code == 503


def test_channel_delete_endpoint():
    calls = []

    async def delete(mid):
        calls.append(mid)
        return mid == 5

    appmod.channel_delete = delete
    c = TestClient(appmod.app)
    h = {'X-Key': 'k'}
    assert c.post('/channel/delete', json={'id': 5}, headers=h).json() == {'deleted': True}
    assert c.post('/channel/delete', json={'id': 6}, headers=h).json() == {'deleted': False}
    assert c.post('/channel/delete', json={'id': 'x'}, headers=h).status_code == 400
    assert c.post('/channel/delete', json={'id': 5}).status_code == 403
    assert calls == [5, 6]
    appmod.channel_delete = None
    assert c.post('/channel/delete', json={'id': 5}, headers=h).status_code == 503


def test_expand_kuaishou_links():
    appmod.douyin = Douyin(FakeHttp({
        'https://v.kuaishou.com/abc': (302, '', 'https://www.kuaishou.com/f/X9Idt15MQb9L2cv'),
        'https://www.kuaishou.com/f/X9Idt15MQb9L2cv': (302, '', '/short-video/3x3zxz4mjrsc8ke?authorId=3x84'),
        'https://v.kuaishou.com/usr': (302, '', 'https://v.m.chenzhongtech.com/fw/user/3x84qugg4ch9zhs?cc=share'),
    }))
    c = TestClient(appmod.app)
    res = c.post('/douyin/expand', json={'urls': ['https://v.kuaishou.com/abc', 'https://v.kuaishou.com/usr',
                                                   'https://www.kuaishou.com/profile/3xabcdef', 'https://v.kuaishou.com/dead']},
                 headers={'X-Key': 'k'}).json()['results']
    assert res[0]['ks_video'] == '3x3zxz4mjrsc8ke' and res[0]['canonical'] == 'https://www.kuaishou.com/short-video/3x3zxz4mjrsc8ke'
    assert res[1]['ks_user'] == '3x84qugg4ch9zhs' and res[1]['platform'] == 'ks'
    assert res[2]['ks_user'] == '3xabcdef'
    assert res[3]['error'] == '认不出这个快手链接'


def test_caption_and_download_referer_for_kuaishou():
    assert appmod.caption_for({'aweme': 'ks_3x3zxz', 'desc': 'd'}) == 'd\n\n#ks3x3zxz'
    assert appmod.caption_for({'aweme': '7300', 'desc': ''}) == '#dy7300'
    seen = []

    class H:
        def stream(self, method, url, headers=None, **kw):
            seen.append(headers['Referer'])

            class R:
                status_code = 403
                async def __aenter__(s): return s
                async def __aexit__(s, *a): return False
            return R()

    for u in ('https://v2.kwaicdn.com/x.mp4', 'https://v26-web.douyinvod.com/x.mp4'):
        with pytest.raises(Exception):
            asyncio.run(appmod.http_download(H(), u, '/tmp/x'))
    assert seen == ['https://www.kuaishou.com/', 'https://www.douyin.com/']
