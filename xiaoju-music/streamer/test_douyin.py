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


def run_job(web, posted=None):
    said, sent = [], []

    async def send_video(data, item, src, text):
        sent.append((data, item['id'], src['width'], text))
        return 2600

    async def find_posted(aweme_id):
        return posted

    async def say(chat, text):
        said.append((chat, text))

    async def go():
        job = DouyinJob(web=web, send_video=send_video, find_posted=find_posted, say=say)
        job.start('7691335977760321704', notify=42)
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
    assert sent == [(b'mp4', '7691335977760321704', 720, caption(normalize(aweme())))]
    assert said == [(42, '✅ 已转到频道：特效一用谁都不认')]


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
    st, said, sent = run_job(FakeWeb(normalize(aweme(images=[{'url_list': ['x']}]))))
    assert sent == [] and '图文' in said[0][1]


# ── 接口 ──

def test_douyin_link_endpoint(monkeypatch):
    monkeypatch.setenv('STREAMER_KEY', 'k1')
    started = []
    job = DouyinJob(web=None, send_video=None, find_posted=None)
    monkeypatch.setattr(job, 'start', lambda aweme_id, notify=None: started.append((aweme_id, notify)))
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
    assert r.status_code == 200 and r.json() == {'kind': 'aweme', 'id': '7691335977760321704'}
    r = c.post('/douyin/link', json={'text': 'https://www.douyin.com/user/x', 'notify': 42}, headers=key)
    assert r.status_code == 200 and r.json() == {'kind': 'user', 'sec_uid': SEC}
    assert started == [('7691335977760321704', 42), ('collect', SEC, 42)]
    assert c.post('/douyin/link', json={'text': 'hello'}, headers=key).status_code == 400
    assert c.get('/douyin/status', headers=key).json() == {'status': 'idle'}


def test_douyin_link_busy(monkeypatch):
    monkeypatch.setenv('STREAMER_KEY', 'k1')
    job = DouyinJob(web=None, send_video=None, find_posted=None)

    def busy(aweme_id, notify=None):
        raise RuntimeError('already running')

    monkeypatch.setattr(job, 'start', busy)
    monkeypatch.setattr(appmod, 'douyin_job', job)

    async def fake_resolve(text):
        return 'aweme', '1234567890'

    monkeypatch.setattr(appmod.dy_links, 'resolve', fake_resolve)
    r = TestClient(appmod.app).post('/douyin/link', json={'text': 'x'}, headers={'X-Key': 'k1'})
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
        job = DouyinJob(web=Web(), send_video=None, find_posted=None, say=say)
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
