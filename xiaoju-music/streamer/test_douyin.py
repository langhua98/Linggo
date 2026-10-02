"""抖音视频转到频道的测试：假的网页、下载和发帖，不联网、不开浏览器。"""

import asyncio

from fastapi.testclient import TestClient

import app as appmod
from douyin import links
from douyin.items import caption, normalize, video_sources
from douyin.job import DouyinJob
from douyin.web import Blocked, DouyinWeb, DownloadError, Gone

SHARE = '2.58 复制打开抖音，看看【丁的作品】特效一用谁都不认  https://v.douyin.com/-Ghr0VeGTpA/ :0pm C@H.iC Uyt:/ 02/20'
SEC = 'MS4wLjABAAAAJObrvSZxXpV8f05lqI-Y8HJyrBORdiOtKImyUldBdng'
VIDEO_CHANNEL = -1001234567890


# ── 链接 ──

def test_find_link_in_share_text():
    assert links.find_link(SHARE) == 'https://v.douyin.com/-Ghr0VeGTpA/'
    assert links.find_link('看这个https://www.douyin.com/video/7691335977760321704复制') == 'https://www.douyin.com/video/7691335977760321704'
    assert links.find_link('没有链接') is None
    assert links.find_link('https://example.com/video/1') is None


def test_classify_links():
    assert links.classify('https://v.douyin.com/-Ghr0VeGTpA/') == ('short', 'https://v.douyin.com/-Ghr0VeGTpA/')
    assert links.classify('https://www.douyin.com/video/7691335977760321704') == ('aweme', '7691335977760321704')
    assert links.classify('https://www.iesdouyin.com/share/video/7691335977760321704/?region=CN&mid=7691336043069000474') == \
        ('aweme', '7691335977760321704')
    assert links.classify('https://www.douyin.com/note/7675967931876579407') == ('aweme', '7675967931876579407')
    # 主页上点开的作品：两样都有时认作品
    assert links.classify(f'https://www.douyin.com/user/{SEC}?modal_id=7691335977760321704') == ('aweme', '7691335977760321704')
    assert links.classify(f'https://www.iesdouyin.com/share/user/{SEC}?did=1&iid=2&sec_uid={SEC}') == ('user', SEC)
    assert links.classify('https://www.douyin.com/') is None
    assert links.classify(None) is None


def test_resolve_follows_the_short_link_once():
    asked = []

    def follow(url):
        asked.append(url)
        return 'https://www.iesdouyin.com/share/video/7691335977760321704/?region=CN&u_code=x'

    assert asyncio.run(links.resolve(SHARE, follow=follow)) == ('aweme', '7691335977760321704')
    assert asked == ['https://v.douyin.com/-Ghr0VeGTpA/']
    assert asyncio.run(links.resolve('https://www.douyin.com/video/123456789', follow=follow)) == ('aweme', '123456789')
    assert asyncio.run(links.resolve('https://v.douyin.com/abc/', follow=lambda u: 'https://www.douyin.com/')) is None
    assert asyncio.run(links.resolve('随便说点什么', follow=follow)) is None


# ── 整理作品、挑下载地址 ──

def rate(name, br, w, h, url, h265=0, size=1000):
    return {'gear_name': name, 'bit_rate': br, 'is_h265': h265,
            'play_addr': {'url_list': [url, url + '?b'], 'width': w, 'height': h, 'data_size': size}}


def aweme(**kw):
    a = {'aweme_id': '7691335977760321704', 'create_time': 1790778707, 'desc': '特效一用谁都不认',
         'author': {'nickname': '丁', 'sec_uid': SEC},
         'video': {'duration': 12491, 'width': 1080, 'height': 1920,
                   'play_addr': {'url_list': ['https://cdn/default'], 'data_size': 900},
                   'download_addr': {'url_list': ['https://cdn/watermarked']},
                   'cover': {'url_list': ['https://p/cover.jpeg']},
                   'bit_rate': [rate('adapt_540_1', 600, 576, 1024, 'https://cdn/540'),
                                rate('bytevc1_1080', 3000, 1080, 1920, 'https://cdn/h265-1080', h265=1),
                                rate('normal_720_0', 2200, 720, 1280, 'https://cdn/720')]}}
    a.update(kw)
    return a


def test_sources_prefer_the_clearest_h264_and_never_the_watermarked_one():
    firsts = [s['urls'][0] for s in video_sources(aweme()['video'])]
    assert firsts == ['https://cdn/720', 'https://cdn/540', 'https://cdn/default', 'https://cdn/h265-1080']
    assert all('watermarked' not in u for s in video_sources(aweme()['video']) for u in s['urls'])
    # 默认地址和某一档是同一个文件时只留一份
    v = aweme()['video']
    v['play_addr'] = {'url_list': ['https://cdn/720']}
    assert [s['urls'][0] for s in video_sources(v)].count('https://cdn/720') == 1


def test_normalize_video_and_images():
    it = normalize(aweme())
    assert (it['id'], it['kind'], it['seconds'], it['author'], it['sec_uid']) == ('7691335977760321704', 'video', 12, '丁', SEC)
    assert it['cover'] == 'https://p/cover.jpeg'
    assert it['url'] == 'https://www.douyin.com/video/7691335977760321704'
    note = normalize(aweme(images=[{'url_list': ['x']}]))
    assert note['kind'] == 'images' and note['url'] == 'https://www.douyin.com/note/7691335977760321704'
    assert normalize({'aweme_id': '1', 'video': {}})['kind'] == 'other'


def test_caption_has_the_source_link_and_fits_telegram():
    c = caption(normalize(aweme()))
    assert c == '特效一用谁都不认\n\n📹 抖音 @丁 · 2026-09-30\nhttps://www.douyin.com/video/7691335977760321704'
    long = caption(normalize(aweme(desc='好' * 3000)))
    assert len(long.encode('utf-16-le')) // 2 <= 1024 and long.endswith('https://www.douyin.com/video/7691335977760321704')
    assert '…' in long
    emoji = caption(normalize(aweme(desc='🎉' * 900)))  # 表情按 UTF-16 算两个
    assert len(emoji.encode('utf-16-le')) // 2 <= 1024
    assert caption(normalize(aweme(desc=''))).startswith('📹 抖音 @丁')


# ── 网页：调接口、下载（假的页面和请求） ──

class FakePage:
    def __init__(self, result=None, hang=False, error=None):
        self.result, self.hang, self.error = result, hang, error

    async def evaluate(self, js, arg):
        if self.hang:
            await asyncio.sleep(3600)
        if self.error:
            raise self.error
        return self.result


def test_call_reads_json_and_treats_empty_as_not_yet():
    w = DouyinWeb(call_timeout=0.05)
    assert asyncio.run(w.call(FakePage({'status': 200, 'text': '{"a": 1}'}), '/p', {})) == {'a': 1}
    assert asyncio.run(w.call(FakePage({'status': 200, 'text': ''}), '/p', {})) is None
    assert asyncio.run(w.call(FakePage({'status': 200, 'text': '<html>'}), '/p', {})) is None
    assert asyncio.run(w.call(FakePage({'status': 403, 'text': '{}'}), '/p', {})) is None
    assert asyncio.run(w.call(FakePage(error=RuntimeError('navigated')), '/p', {})) is None
    try:
        asyncio.run(w.call(FakePage(hang=True), '/p', {}))
        raise AssertionError('should block')
    except Blocked as e:
        assert '一直没回' in str(e)


def test_call_stops_waiting_when_the_page_asks_for_a_captcha():
    w = DouyinWeb(call_timeout=30)

    async def go():
        abort = asyncio.Event()
        asyncio.get_running_loop().call_later(0.05, abort.set)
        await w.call(FakePage(hang=True), '/p', {}, abort=abort)

    try:
        asyncio.run(asyncio.wait_for(go(), 5))  # 不用等满 30 秒
        raise AssertionError('should block')
    except Blocked as e:
        assert '滑块验证' in str(e)
    from douyin.web import CAPTCHA
    assert CAPTCHA.search('https://verify.zijieapi.com/captcha/get?lang=zh')
    assert CAPTCHA.search('https://rmc.bytedance.com/verifycenter/captcha/v2?from=iframe')
    assert not CAPTCHA.search('https://lf3-static.example.com/obj/rc-verifycenter/rmc-nocaptcha/1.0.0.52/setup.js')


class FakeResponse:
    def __init__(self, status=200, kind='video/mp4', body=b'x' * 20000, length=None):
        self.status, self.body_bytes = status, body
        self.headers = {'content-type': kind, 'content-length': str(length if length is not None else len(body))}
        self.disposed = False

    async def body(self):
        return self.body_bytes

    async def dispose(self):
        self.disposed = True


class FakeRequest:
    def __init__(self, answers):
        self.answers, self.asked = answers, []

    async def get(self, url, headers=None, timeout=None):
        self.asked.append((url, headers))
        a = self.answers.get(url, ConnectionError('refused'))
        if isinstance(a, Exception):
            raise a
        return a


def web_with(answers):
    w = DouyinWeb()
    w.ctx = type('Ctx', (), {})()
    w.ctx.request = FakeRequest(answers)
    return w


def test_download_tries_the_next_address_until_one_works():
    item = normalize(aweme())
    w = web_with({'https://cdn/720': FakeResponse(status=403), 'https://cdn/720?b': TimeoutError(),
                  'https://cdn/540': FakeResponse(kind='text/html'), 'https://cdn/540?b': FakeResponse(body=b'v' * 30000)})
    data, src = asyncio.run(w.download(item))
    assert data == b'v' * 30000 and src['width'] == 576
    assert all(h == {'Referer': 'https://www.douyin.com/'} for _, h in w.ctx.request.asked)


def test_download_gives_up_with_a_reason():
    item = normalize(aweme())
    w = web_with({})  # 全都连不上
    try:
        asyncio.run(w.download(item))
        raise AssertionError('should fail')
    except DownloadError:
        pass
    big = web_with({u: FakeResponse(length=10 ** 10) for s in item['sources'] for u in s['urls']})
    try:
        asyncio.run(big.download(item))
        raise AssertionError('should fail')
    except DownloadError as e:
        assert '太大' in str(e)


# ── 转一条 ──

class FakeWeb:
    def __init__(self, item=None, error=None, download_error=None):
        self.item, self.error, self.download_error = item, error, download_error
        self.opened = 0

    def __call__(self):
        return self

    async def __aenter__(self):
        self.opened += 1
        return self

    async def __aexit__(self, *exc):
        return False

    async def detail(self, aweme_id):
        if self.error:
            raise self.error
        return self.item

    async def download(self, item):
        if self.download_error:
            raise self.download_error
        return b'mp4', item['sources'][0]

    async def download_images(self, item):
        if self.download_error:
            raise self.download_error
        return [b'jpg%d' % n for n in range(len(item['images']))]


def run_job(web, posted=None):
    said, sent = [], []

    async def send_video(data, item, src, text, target):
        sent.append((data, item['id'], src['width'], text, target))
        return 2600

    async def send_images(images, item, text, target):
        sent.append((images, item['id'], text, target))
        return 2700

    async def posted_ids(target):
        assert target == VIDEO_CHANNEL
        return {'7691335977760321704': posted} if posted else {}

    async def say(chat, text):
        said.append((chat, text))

    async def go():
        job = DouyinJob(web=web, send_video=send_video, send_images=send_images, posted_ids=posted_ids, say=say)
        job.start('7691335977760321704', notify=42, target=VIDEO_CHANNEL)
        try:
            job.start('1', notify=42)
            raise AssertionError('second job should be refused')
        except RuntimeError:
            pass
        await job.task
        return job.state

    return asyncio.run(go()), said, sent


def test_job_posts_the_video_and_tells_the_owner():
    st, said, sent = run_job(FakeWeb(normalize(aweme())))
    assert st['status'] == 'done' and st['fresh'] and st['msg'] == 2600
    assert sent == [(b'mp4', '7691335977760321704', 720, caption(normalize(aweme())), VIDEO_CHANNEL)]
    assert said == [(42, '✅ 已转到视频频道：特效一用谁都不认')]


def test_job_skips_what_the_channel_already_has_without_opening_douyin():
    web = FakeWeb(normalize(aweme()))
    st, said, sent = run_job(web, posted=2500)
    assert st['status'] == 'done' and not st['fresh'] and st['msg'] == 2500
    assert web.opened == 0 and sent == [] and '已经有了' in said[0][1]


def test_job_reports_why_it_could_not():
    st, said, _ = run_job(FakeWeb(error=Blocked('抖音没给数据')))
    assert st['blocked'] and '没让我拿到' in said[0][1] and '视频文件发给我' in said[0][1]
    st, said, _ = run_job(FakeWeb(error=Gone('作品不存在')))
    assert not st['blocked'] and '转不了：作品不存在' in said[0][1]
    st, said, _ = run_job(FakeWeb(normalize(aweme()), download_error=DownloadError('HTTP 403')))
    assert st['status'] == 'error' and 'HTTP 403' in said[0][1]
    note = normalize(aweme(images=[{'url_list': ['https://p/1.webp']}, {'url_list': ['https://p/2.jpeg']}]))
    st, said, sent = run_job(FakeWeb(note))
    assert sent == [([b'jpg0', b'jpg1'], '7691335977760321704', caption(note), VIDEO_CHANNEL)] and st['msg'] == 2700
    assert said == [(42, '✅ 已转到视频频道：特效一用谁都不认')]
    st, said, sent = run_job(FakeWeb(normalize(aweme(video={}, images=None))))  # 不是视频也不是图文
    assert sent == [] and '转不了' in said[0][1]


# ── 接口 ──

def test_douyin_link_endpoint(monkeypatch):
    monkeypatch.setenv('STREAMER_KEY', 'k1')
    started = []
    job = DouyinJob(web=None, send_video=None, posted_ids=None)
    monkeypatch.setattr(job, 'start', lambda aweme_id, notify=None, target=None: started.append((aweme_id, notify, target)))
    monkeypatch.setattr(job, 'start_collect', lambda sec_uid, notify=None: started.append(('collect', sec_uid, notify)))
    monkeypatch.setattr(appmod, 'douyin_job', job)

    async def fake_resolve(text):
        if 'user' in text:
            return 'user', SEC
        return ('aweme', '7691335977760321704') if 'douyin' in text else None

    monkeypatch.setattr(appmod.dy_links, 'resolve', fake_resolve)
    c = TestClient(appmod.app)
    key = {'X-Key': 'k1'}
    assert c.post('/douyin/link', json={'text': SHARE}).status_code == 403
    r = c.post('/douyin/link', json={'text': SHARE, 'notify': 42}, headers=key)
    assert r.status_code == 400 and r.json()['detail'] == '没设置视频频道'  # 作品链接一定要说发去哪个频道
    r = c.post('/douyin/link', json={'text': SHARE, 'notify': 42, 'target': str(VIDEO_CHANNEL)}, headers=key)
    assert r.status_code == 200 and r.json() == {'kind': 'aweme', 'id': '7691335977760321704'}
    r = c.post('/douyin/link', json={'text': 'https://www.douyin.com/user/x', 'notify': 42}, headers=key)
    assert r.status_code == 200 and r.json() == {'kind': 'user', 'sec_uid': SEC}
    assert started == [('7691335977760321704', 42, VIDEO_CHANNEL), ('collect', SEC, 42)]
    assert c.post('/douyin/link', json={'text': 'hello'}, headers=key).status_code == 400
    assert c.get('/douyin/status', headers=key).json() == {'status': 'idle'}


def test_douyin_link_busy(monkeypatch):
    monkeypatch.setenv('STREAMER_KEY', 'k1')
    job = DouyinJob(web=None, send_video=None, posted_ids=None)

    def busy(aweme_id, notify=None, target=None):
        raise RuntimeError('already running')

    monkeypatch.setattr(job, 'start', busy)
    monkeypatch.setattr(appmod, 'douyin_job', job)

    async def fake_resolve(text):
        return 'aweme', '1234567890'

    monkeypatch.setattr(appmod.dy_links, 'resolve', fake_resolve)
    r = TestClient(appmod.app).post('/douyin/link', json={'text': 'x', 'target': str(VIDEO_CHANNEL)}, headers={'X-Key': 'k1'})
    assert r.status_code == 409


# ── 打开着的网页：先用网页自己拿到的，没有再自己调 ──

class ScriptedPage:
    """evaluate 按顺序回 answers 里的东西（'hang' 表示一直不回）"""
    def __init__(self, answers):
        self.answers, self.calls = list(answers), 0

    async def evaluate(self, js, arg):
        self.calls += 1
        a = self.answers.pop(0) if self.answers else {'status': 200, 'text': ''}
        if a == 'hang':
            await asyncio.sleep(3600)
        return a


class Res:
    def __init__(self, url, text):
        self.url, self._text = url, text

    async def text(self):
        return self._text


def make_tab(answers, warmup=0.3):
    from douyin.web import Tab
    w = DouyinWeb(warmup=warmup, tries=2, gap=0.01, call_timeout=0.2)
    return Tab(w, ScriptedPage(answers), watch=['/aweme/v1/web/aweme/post/'])


def test_tab_uses_what_the_page_itself_got():
    async def go():
        t = make_tab([])
        await t.on_response(Res('https://www.douyin.com/aweme/v1/web/aweme/post/?sec_user_id=S&max_cursor=0', ''))  # 空的不算
        await t.on_response(Res('https://www.douyin.com/aweme/v1/web/aweme/post/?sec_user_id=S&max_cursor=0', '{"aweme_list": [1]}'))
        await t.on_response(Res('https://www.douyin.com/aweme/v1/web/hot/search/list/', '{"x": 1}'))  # 没在 watch 里
        data = await t.get('/aweme/v1/web/aweme/post/', {}, match=lambda u: 'max_cursor=0' in u)
        return data, t.page.calls, len(t.got)
    assert asyncio.run(go()) == ({'aweme_list': [1]}, 0, 1)


def test_tab_calls_itself_when_the_page_did_not_and_stops_on_a_captcha():
    async def go():
        t = make_tab([{'status': 200, 'text': ''}, {'status': 200, 'text': '{"ok": 1}'}])
        return await t.get('/p', {}, match=lambda u: False), t.page.calls
    assert asyncio.run(go()) == ({'ok': 1}, 2)

    async def captcha():
        t = make_tab(['hang'])
        await t.on_response(Res('https://verify.zijieapi.com/captcha/get?x=1', ''))
        await t.get('/p', {}, match=lambda u: False)
    try:
        asyncio.run(asyncio.wait_for(captcha(), 5))
        raise AssertionError('should block')
    except Blocked as e:
        assert '滑块验证' in str(e)

    async def nothing():
        t = make_tab([])
        await t.get('/p', {})
    try:
        asyncio.run(nothing())
        raise AssertionError('should block')
    except Blocked as e:
        assert '没给数据' in str(e)


# ── 采集一个账号的作品链接 ──

class FakeTab:
    def __init__(self, pages):
        self.pages, self.asked = list(pages), []

    async def get(self, path, params, match=None):
        self.asked.append(params['max_cursor'])
        p = self.pages.pop(0)
        if isinstance(p, Exception):
            raise p
        return p


def web_with_pages(pages):
    import contextlib
    w = DouyinWeb(gap=0)
    tab = FakeTab(pages)

    @contextlib.asynccontextmanager
    async def fake_tab(url, watch=()):
        assert url == f'https://www.douyin.com/user/{SEC}'
        yield tab

    w.tab = fake_tab
    return w, tab


def page_of(ids, more, cursor, hidden=False):
    d = {'status_code': 0, 'has_more': more, 'max_cursor': cursor,
         'aweme_list': [aweme(aweme_id=i, create_time=1790000000 - n) for n, i in enumerate(ids)]}
    if hidden:
        d['not_login_module'] = {'guide_login_tip_exist': True}
    return d


def test_posts_follows_the_pages_and_reports_what_douyin_hid():
    w, tab = web_with_pages([page_of(['1', '2'], 1, 111, hidden=True), page_of(['2', '3'], 1, 222), {'status_code': 0}])
    items, info = asyncio.run(w.posts(SEC))
    assert [i['id'] for i in items] == ['1', '2', '3'] and tab.asked == ['0', '111', '222']
    assert info == {'hidden_newest': True, 'truncated': True}
    w, tab = web_with_pages([page_of(['1'], 0, 0)])
    assert asyncio.run(w.posts(SEC))[1] == {'hidden_newest': False, 'truncated': False}
    w, tab = web_with_pages([page_of(['1', '2'], 1, 111), Blocked('x')])  # 第二页被风控：第一页的照样算
    items, info = asyncio.run(w.posts(SEC))
    assert len(items) == 2 and info['truncated']
    w, tab = web_with_pages([page_of(['1', '2', '3'], 1, 111)])
    assert len(asyncio.run(w.posts(SEC, limit=2))[0]) == 2 and tab.asked == ['0']
    w, tab = web_with_pages([{'status_code': 8, 'status_msg': 'x'}])
    try:
        asyncio.run(w.posts(SEC))
        raise AssertionError('should block')
    except Blocked:
        pass


def test_collect_job_reports_the_links():
    class Web(FakeWeb):
        async def posts(self, sec_uid, limit):
            return ([normalize(aweme(aweme_id='111', desc='视频一')),
                     normalize(aweme(aweme_id='222', desc='图文一', images=[{}], create_time=1790000000))],
                    {'hidden_newest': True, 'truncated': True})

    said = []

    async def say(chat, text):
        said.append(text)

    async def go():
        job = DouyinJob(web=Web(), send_video=None, posted_ids=None, say=say)
        job.start_collect(SEC, notify=42)
        await job.task
        return job.state

    st = asyncio.run(go())
    assert st['status'] == 'done' and st['name'] == '丁' and st['hidden_newest'] and st['truncated']
    assert [(x['id'], x['kind'], x['url']) for x in st['links']] == [
        ('111', 'video', 'https://www.douyin.com/video/111'), ('222', 'images', 'https://www.douyin.com/note/222')]
    text = said[0]
    assert text.startswith('🔗 抖音 @丁 的作品链接：共 2 条（视频 1、图文 1）')
    assert '最新的几条作品' in text and '只给没登录的人看第一页' in text
    assert text.index('https://www.douyin.com/video/111') < text.index('https://www.douyin.com/note/222')
    assert '2026-09-30 视频一' in text


def test_links_report_splits_long_lists():
    from douyin.job import MESSAGE_LIMIT, links_report
    links = [{'id': str(i), 'url': f'https://www.douyin.com/video/{7600000000000000000 + i}', 'kind': 'video',
              'time': 1790000000 - i, 'desc': '很长的文案' * 10} for i in range(120)]
    out = links_report({'name': '丁', 'links': links})
    assert len(out) > 1 and all(len(m) <= MESSAGE_LIMIT for m in out)
    assert sum(m.count('https://www.douyin.com/video/') for m in out) == 120
    assert links_report({'name': '丁', 'links': []})[0].endswith('这个账号没有公开作品。')


# ── 把账号能看到的视频转进视频频道 ──

def test_mirror_posts_the_videos_oldest_first_and_skips_what_is_there():
    class Web(FakeWeb):
        async def posts(self, sec_uid, limit=300):
            return ([normalize(aweme(aweme_id='300', desc='新的', create_time=1790000300)),
                     normalize(aweme(aweme_id='100', desc='旧的', create_time=1790000100)),
                     normalize(aweme(aweme_id='200', desc='已经有了', create_time=1790000200)),
                     normalize(aweme(aweme_id='400', desc='图文', create_time=1790000400,
                                     images=[{'url_list': ['https://p/a.jpeg']}, {'url_list': ['https://p/b.webp']}])),
                     normalize(aweme(aweme_id='500', desc='直播回放', video={}, images=None))],
                    {'hidden_newest': True, 'truncated': False})

        async def download(self, item):
            if item['id'] == '300':
                raise DownloadError('HTTP 403')
            return b'mp4', item['sources'][0]

    sent, said = [], []

    async def send_video(data, item, src, text, target):
        sent.append(('video', item['id'], target))
        return 5000 + len(sent)

    async def send_images(images, item, text, target):
        sent.append(('images', item['id'], target, len(images)))
        return 5000 + len(sent)

    async def posted_ids(target):
        return {'200': 77, '999': 78}

    async def say(chat, text):
        said.append(text)

    async def go():
        job = DouyinJob(web=Web(), send_video=send_video, send_images=send_images, posted_ids=posted_ids, say=say, pause=0)
        job.start_mirror(SEC, notify=42, target=VIDEO_CHANNEL)
        await job.task
        return job.state

    st = asyncio.run(go())
    assert st['status'] == 'done'
    assert sent == [('video', '100', VIDEO_CHANNEL), ('images', '400', VIDEO_CHANNEL, 2)], '旧的先发，图文发成相册'
    assert [r['id'] for r in st['posted']] == ['100', '400'] and [r['id'] for r in st['skipped']] == ['200']
    assert [(r['id'], r['reason']) for r in st['failed']] == [('300', 'HTTP 403')]
    text = said[0]
    assert text.startswith('📤 抖音 @丁：转进视频频道 2 条（视频 1、图文 1）')
    assert '[图文] 图文' in text and '[视频] 旧的' in text
    assert '已经有的 1 条跳过' in text and '新的：HTTP 403' in text and '还有 1 条不是视频也不是图文' in text
    assert '最新的几条' in text and '第一页以后' not in text


def test_mirror_endpoint(monkeypatch):
    monkeypatch.setenv('STREAMER_KEY', 'k1')
    started = []
    job = DouyinJob(web=None, send_video=None, posted_ids=None)
    monkeypatch.setattr(job, 'start_mirror', lambda sec_uid, notify=None, target=None: started.append((sec_uid, notify, target)))
    monkeypatch.setattr(appmod, 'douyin_job', job)
    c = TestClient(appmod.app)
    key = {'X-Key': 'k1'}
    assert c.post('/douyin/mirror', json={'sec_uid': SEC, 'target': '-1001234567890'}).status_code == 403
    assert c.post('/douyin/mirror', json={'sec_uid': 'nope', 'target': '-1001234567890'}, headers=key).status_code == 400
    assert c.post('/douyin/mirror', json={'sec_uid': SEC}, headers=key).json()['detail'] == '没设置视频频道'
    r = c.post('/douyin/mirror', json={'sec_uid': SEC, 'target': '-1001234567890', 'notify': 42}, headers=key)
    assert r.status_code == 200 and started == [(SEC, 42, VIDEO_CHANNEL)]


def test_parse_target():
    assert appmod.parse_target('-1001234567890') == -1001234567890
    assert appmod.parse_target(-1001234567890) == -1001234567890
    assert appmod.parse_target('@xiaojuvideo') == 'xiaojuvideo'
    for bad in (None, '', '123', '-5', 'a b', '@x', '1001234567890'):
        assert appmod.parse_target(bad) is None


def test_channels_owned_only_returns_own_channels_matching_the_title(monkeypatch):
    from types import SimpleNamespace as NS
    monkeypatch.setenv('STREAMER_KEY', 'k1')

    class Client:
        async def iter_dialogs(self):
            for e in [NS(id=111, broadcast=True, creator=True, title='小橘🍊视频', username=None),
                      NS(id=222, broadcast=True, creator=False, title='小橘视频 粉丝站', username='fan'),  # 不是自己建的
                      NS(id=333, broadcast=False, creator=True, title='小橘视频群', username=None),  # 群，不是频道
                      NS(id=444, broadcast=True, creator=True, title='小橘🍊音乐', username='xiaojumusic')]:
                yield NS(entity=e)

    monkeypatch.setattr(appmod, 'user_client', Client())
    c = TestClient(appmod.app)
    r = c.get('/channels/owned', params={'title': '小橘视频'}, headers={'X-Key': 'k1'})
    assert r.json() == {'channels': [{'id': -100111, 'title': '小橘🍊视频', 'username': None}]}
    assert c.get('/channels/owned', params={'title': '小'}, headers={'X-Key': 'k1'}).status_code == 400


def test_mirror_never_posts_the_same_video_twice_in_one_run():
    """列表里同一条出现两次（置顶又在正常位置）也只发一次"""
    class Web(FakeWeb):
        async def posts(self, sec_uid, limit=300):
            it = normalize(aweme(aweme_id='100', desc='置顶的'))
            return [it, dict(it)], {'hidden_newest': False, 'truncated': False}

    sent = []

    async def send_video(data, item, src, text, target):
        sent.append(item['id'])
        return 10

    async def posted_ids(target):
        return {}

    async def go():
        job = DouyinJob(web=Web(), send_video=send_video, posted_ids=posted_ids, pause=0)
        job.start_mirror(SEC, target=VIDEO_CHANNEL)
        await job.task
        return job.state

    st = asyncio.run(go())
    assert sent == ['100'] and len(st['posted']) == 1 and len(st['skipped']) == 1


def test_douyin_posted_reads_work_ids_from_captions(monkeypatch):
    from types import SimpleNamespace as NS

    class Client:
        async def get_input_entity(self, target):
            return target

        async def iter_messages(self, entity, limit=None):
            for m in [NS(id=5, message='新的\n\n📹 抖音 @丁 · 2026-06-04\nhttps://www.douyin.com/video/7647364906534950114'),
                      NS(id=4, message=None),  # 没有说明的帖子
                      NS(id=3, message='图文 https://www.douyin.com/note/7675967931876579407'),
                      NS(id=2, message='旧的同一条 https://www.douyin.com/video/7647364906534950114')]:
                yield m

    monkeypatch.setattr(appmod, 'user_client', Client())
    got = asyncio.run(appmod.douyin_posted(-1004292843233))
    assert got == {'7647364906534950114': 5, '7675967931876579407': 3}
    monkeypatch.setattr(appmod, 'user_client', None)
    assert asyncio.run(appmod.douyin_posted(-1004292843233)) == {}


# ── 图文 ──

def test_image_sources_keep_order_and_prefer_jpeg():
    imgs = [{'url_list': ['https://a/1.webp', 'https://b/1.jpeg'], 'download_url_list': ['https://wm/1'], 'width': 1080, 'height': 1440},
            {'url_list': []},  # 没地址的跳过
            {'url_list': ['https://a/2~tplv-dy-aweme-images:q75.webp']}]
    from douyin.items import image_sources
    got = image_sources(imgs)
    assert [g['urls'] for g in got] == [['https://b/1.jpeg', 'https://a/1.webp'], ['https://a/2~tplv-dy-aweme-images:q75.webp']]
    assert got[0]['width'] == 1080
    note = normalize(aweme(images=imgs))
    assert note['kind'] == 'images' and len(note['images']) == 2
    assert all('wm' not in u for i in note['images'] for u in i['urls']), '带水印的不用'
    assert caption(note) == ('特效一用谁都不认\n\n🖼 抖音 @丁 · 2026-09-30\nhttps://www.douyin.com/note/7691335977760321704')
    assert normalize(aweme())['images'] == []


def test_download_images_gets_every_picture_or_none():
    note = normalize(aweme(images=[{'url_list': ['https://p/1.jpeg', 'https://q/1.jpeg']}, {'url_list': ['https://p/2.webp']}]))
    w = web_with({'https://p/1.jpeg': FakeResponse(status=404), 'https://q/1.jpeg': FakeResponse(kind='image/jpeg', body=b'1' * 5000),
                  'https://p/2.webp': FakeResponse(kind='image/webp', body=b'2' * 3000)})
    assert asyncio.run(w.download_images(note)) == [b'1' * 5000, b'2' * 3000]
    w = web_with({'https://p/1.jpeg': FakeResponse(kind='image/jpeg', body=b'1' * 5000)})  # 第二张拿不到
    try:
        asyncio.run(w.download_images(note))
        raise AssertionError('should fail')
    except DownloadError as e:
        assert '第 2 张' in str(e)


class FakeTelegram:
    def __init__(self, reject_photos=False):
        self.calls, self.reject_photos = [], reject_photos

    async def get_input_entity(self, target):
        return target

    async def send_file(self, chat, files, caption=None, link_preview=None, force_document=False):
        self.calls.append((chat, files if isinstance(files, str) else list(files), caption, force_document))
        if self.reject_photos and not force_document:
            from telethon.errors import PhotoInvalidDimensionsError
            raise PhotoInvalidDimensionsError(request=None)
        from types import SimpleNamespace as NS
        return [NS(id=31), NS(id=32)] if isinstance(files, list) else NS(id=30)


def test_send_images_as_an_album_with_the_caption(monkeypatch):
    tg = FakeTelegram()
    monkeypatch.setattr(appmod, 'user_client', tg)
    monkeypatch.setattr(appmod, 'to_photo', lambda data: (data, '.jpg') if data != b'bad' else None)
    note = normalize(aweme(images=[{'url_list': ['x']}] * 2))
    assert asyncio.run(appmod.douyin_send_images([b'a', b'b'], note, 'cap', VIDEO_CHANNEL)) == 31
    chat, files, cap, as_doc = tg.calls[-1]
    assert chat == VIDEO_CHANNEL and len(files) == 2 and files[0].endswith('_01.jpg') and cap == 'cap' and not as_doc
    assert asyncio.run(appmod.douyin_send_images([b'a'], note, 'cap', VIDEO_CHANNEL)) == 30  # 一张：不发成相册
    assert isinstance(tg.calls[-1][1], str)
    try:
        asyncio.run(appmod.douyin_send_images([b'a', b'bad'], note, 'cap', VIDEO_CHANNEL))
        raise AssertionError('should fail')
    except DownloadError as e:
        assert '第 2 张' in str(e)


def test_send_images_falls_back_to_files_when_telegram_rejects_the_photos(monkeypatch):
    tg = FakeTelegram(reject_photos=True)
    monkeypatch.setattr(appmod, 'user_client', tg)
    monkeypatch.setattr(appmod, 'to_photo', lambda data: (data, '.jpg'))
    note = normalize(aweme(images=[{'url_list': ['x']}] * 2))
    assert asyncio.run(appmod.douyin_send_images([b'a', b'b'], note, 'cap', VIDEO_CHANNEL)) == 31
    assert [c[3] for c in tg.calls] == [False, True]


def test_flood_retry_waits_and_tries_again(monkeypatch):
    from telethon.errors import FloodWaitError
    slept, tries = [], []

    async def fake_sleep(n):
        slept.append(n)

    monkeypatch.setattr(appmod.asyncio, 'sleep', fake_sleep)

    async def send():
        tries.append(1)
        if len(tries) < 2:
            e = FloodWaitError(request=None, capture=7)
            raise e
        return 'ok'

    assert asyncio.run(appmod.flood_retry(send)) == 'ok' and slept == [8] and len(tries) == 2
