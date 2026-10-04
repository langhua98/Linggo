"""云电脑任务（jobs.py）：假的子进程、Telegram、Worker。python -m pytest -q"""

import asyncio
import base64
import json
import os

import pytest

import jobs as J
from dy_login import nickname_from_title, sec_uid_from_url, sms_code

SEC = 'MS4wLjABAAAAabcdefghijklmnop'
PNG = base64.b64encode(b'\x89PNG fake').decode()


class FakeProc:
    """假的子进程。lines 是它要写的事件（登录页：写进事件文件）或日志（MediaCrawler：标准输出），None 表示退出；
    err_lines 是它自己的输出（浏览器、Playwright 的日志）"""

    def __init__(self, lines, on_write=None, code=0, err_lines=()):
        self.queue = asyncio.Queue()
        for line in lines:
            self.queue.put_nowait(line)
        self.logs = list(err_lines)
        self.on_write = on_write
        self.code = code
        self.written = []
        self.killed = False
        self.events_path = None
        self.exited = asyncio.Event()

    def start(self, events_path=None):
        self.events_path = events_path
        self.task = asyncio.create_task(self._pump())

    async def _pump(self):
        while True:
            line = await self.queue.get()
            if line is None:
                break
            if self.events_path:
                with open(self.events_path, 'a', encoding='utf-8') as f:
                    f.write(line + '\n')
            else:
                self.logs.append(line)
        self.exited.set()

    def close(self):
        self.queue.put_nowait(None)

    async def lines(self):
        await self.exited.wait()
        for line in self.logs:
            yield line

    def write(self, text):
        self.written.append(text)
        if self.on_write:
            self.on_write(self, text)

    async def wait(self):
        await self.exited.wait()
        return self.code

    def kill(self):
        self.killed = True


def ev(event, **kw):
    return json.dumps({'event': event, **kw})


class World:
    """假的发件箱：say 记进 said，其余记进 calls"""

    def __init__(self):
        self.said = []
        self.says = []  # say 的全部字段（按钮、换回菜单）
        self.calls = []
        self.spawned = []
        self.procs = []

    def emit(self, kind, **data):
        if kind == 'say':
            self.said.append((data['chat_id'], data['text'], data['png']))
            self.says.append(data)
        else:
            self.calls.append((kind, data))

    def jobs(self, make_proc):
        async def spawn(argv, cwd, env_extra=None):
            self.spawned.append((argv, cwd))
            self.env_extra = env_extra or {}
            p = make_proc(argv)
            p.start(self.env_extra.get('DY_LOGIN_EVENTS'))
            self.procs.append(p)
            return p
        j = J.Jobs(spawn=spawn, emit=self.emit, mc_dir='/mc', mc_py='/venv/python')
        j.poll_interval = 0.005
        return j


async def until(cond, timeout=2):
    """等到条件成立（登录页的事件是定时去文件里读的）"""
    for _ in range(int(timeout / 0.005)):
        if cond():
            return
        await asyncio.sleep(0.005)
    raise AssertionError('等不到')


async def settle(j):
    if j.task:
        await asyncio.wait_for(j.task, 5)


def test_login_qr_verify_code_ok():
    async def go():
        w = World()

        def on_write(p, text):  # 收到验证码后登录成功
            p.queue.put_nowait(ev('ok', cookies=[{'name': 'sessionid', 'value': 's', 'domain': '.douyin.com'}],
                                  sec_uid=SEC, nickname='小橘'))
            p.close()

        j = w.jobs(lambda argv: FakeProc([
            'playwright noise',
            ev('qr', png=PNG),
            ev('qr', png=PNG),
            ev('verify', text='身份验证', png=PNG),
        ], on_write=on_write))
        j.login(777)
        with pytest.raises(J.Busy):
            j.login(777)
        await until(lambda: len(w.said) >= 3)
        assert j.input('12 34-56')
        await settle(j)
        argv, cwd = w.spawned[0]
        assert argv[:2] == ['xvfb-run', '-a'] and argv[2] == '/venv/python' and argv[3].endswith('dy_login.py')
        assert cwd == '/mc'
        assert w.procs[0].written == ['12 34-56\n']  # 原样交给登录页，它认验证码
        assert [png for _, _, png in w.said[:3]] == [PNG, PNG, PNG]
        assert '扫这个二维码' in w.said[0][1] and '身份验证' in w.said[2][1]
        assert w.calls == [('session', {'cookies': [{'name': 'sessionid', 'value': 's', 'domain': '.douyin.com'}],
                                        'sec_uid': SEC, 'nickname': '小橘'})]
        assert '登录好了：小橘' in w.said[-1][1] and w.says[-1]['menu'] is True
        assert w.says[2]['buttons'] == ['截图', '取消登录']  # 没认出选项也能截图、取消
        assert j.current is None and not j.input('1')
    asyncio.run(go())


def test_login_error_and_crash():
    async def go():
        w = World()
        j = w.jobs(lambda argv: FakeProc([ev('error', text='6 分钟内没登录上'), None]))
        j.login(1)
        await settle(j)
        assert w.said[-1][1] == '抖音登录没成功：6 分钟内没登录上' and w.calls == []
        j = w.jobs(lambda argv: FakeProc([None], code=1, err_lines=['Traceback: boom']))  # 崩了：没写事件，输出里有报错
        j.login(1)
        await settle(j)
        assert '意外退出了（退出码 1）' in w.said[-1][1] and 'boom' in w.said[-1][1]
    asyncio.run(go())


def test_login_rejects_bad_sec_uid():
    async def go():
        w = World()
        j = w.jobs(lambda argv: FakeProc([ev('ok', cookies=[], sec_uid='self', nickname='x'), None]))
        j.login(1)
        await settle(j)
        assert w.calls == [] and '号码不对' in w.said[-1][1]
    asyncio.run(go())


def mc_writes(rows, code=0, log_lines=()):
    """假的 MediaCrawler：往 --save_data_path 写 jsonl"""
    def make(argv):
        d = argv[argv.index('--save_data_path') + 1]
        os.makedirs(os.path.join(d, 'dy', 'jsonl'), exist_ok=True)
        with open(os.path.join(d, 'dy', 'jsonl', 'creator_contents_2026-10-04.jsonl'), 'w') as f:
            for r in rows:
                f.write(json.dumps(r) + '\n')
        return FakeProc([*log_lines, None], code=code)
    return make


def row(aid):
    return {'aweme_id': aid, 'desc': 'd', 'create_time': 1, 'video_download_url': f'https://v.douyinvod.com/{aid}'}


def test_crawl_own_homepage_emits_whole_batch():
    async def go():
        w = World()
        j = w.jobs(mc_writes([row('7300000000000000001'), row('7300000000000000002'), row('7300000000000000002')],
                             log_lines=['[store.douyin.update_douyin_aweme] x'] * 3))
        session = {'sec_uid': SEC, 'cookies': [{'name': 'sessionid', 'value': 's', 'domain': '.douyin.com'}]}
        j.crawl(9, session, 'creator', ['https://www.douyin.com/user/SOMEONE_ELSE'], 'cloud')
        await settle(j)
        argv, cwd = w.spawned[0]
        assert argv[:4] == ['xvfb-run', '-a', '/venv/python', 'main.py'] and cwd == '/mc'
        assert argv[argv.index('--creator_id') + 1] == f'https://www.douyin.com/user/{SEC}'  # 只抓自己的主页
        assert argv[argv.index('--cookies') + 1] == 'sessionid=s'
        imports = [b for k, b in w.calls if k == 'import']
        assert len(imports) == 1  # 整批交给 Worker，它来查重
        assert imports[0]['chat_id'] == 9 and imports[0]['src'] == 'cloud' and imports[0]['what'] == '主页'
        assert [i['aweme'] for i in imports[0]['items']] == ['7300000000000000001', '7300000000000000002']
        assert imports[0]['items'][1] == {'aweme': '7300000000000000002', 'desc': 'd', 'create_time': 1, 'type': 'video',
                                          'video_url': 'https://v.douyinvod.com/7300000000000000002',
                                          'url': 'https://www.douyin.com/video/7300000000000000002'}
        assert ('progress', {'stage': '抓主页'}) in w.calls
        assert not os.path.exists(argv[argv.index('--save_data_path') + 1])  # 临时目录删掉了
    asyncio.run(go())


def test_crawl_alt_accounts():
    async def go():
        w = World()
        j = w.jobs(mc_writes([row('7300000000000000001')]))
        other = 'MS4wLjABAAAAanotheralt00001'
        j.crawl(9, {'sec_uid': SEC, 'cookies': []}, 'accounts', [SEC, 'https://evil.example/', SEC, other], 'alt')
        await settle(j)
        argv = w.spawned[0][0]
        assert argv[argv.index('--type') + 1] == 'creator'
        assert argv[argv.index('--creator_id') + 1] == f'https://www.douyin.com/user/{SEC},https://www.douyin.com/user/{other}'
        imports = [b for k, b in w.calls if k == 'import']
        assert imports[0]['src'] == 'alt' and imports[0]['what'] == '2 个账号的主页'
        with pytest.raises(ValueError, match='没有认得的账号'):
            j.crawl(9, {'sec_uid': SEC}, 'accounts', ['junk'], 'alt')
    asyncio.run(go())


def test_crawl_hands_over_while_crawling(monkeypatch):
    """边抓边交：MediaCrawler 还没退出，已经写进 jsonl 的就交给 Worker；最后一批带 final"""
    monkeypatch.setattr(J, 'FLUSH_EVERY', 0.01)

    async def go():
        w = World()
        box = {}

        def make(argv):
            d = argv[argv.index('--save_data_path') + 1]
            os.makedirs(os.path.join(d, 'dy', 'jsonl'), exist_ok=True)
            box['path'] = os.path.join(d, 'dy', 'jsonl', 'creator_contents_2026-10-04.jsonl')
            box['proc'] = FakeProc([])
            return box['proc']

        j = w.jobs(make)
        j.crawl(9, {'sec_uid': SEC, 'cookies': []}, 'accounts', [SEC], 'alt')
        imports = lambda: [b for k, b in w.calls if k == 'import']
        await until(lambda: 'path' in box)
        with open(box['path'], 'a') as f:
            f.write(json.dumps(row('7300000000000000001')) + '\n' + json.dumps(row('7300000000000000002')) + '\n{"aweme_id": "73')
        await until(lambda: imports())
        first = imports()[0]
        assert [i['aweme'] for i in first['items']] == ['7300000000000000001', '7300000000000000002']  # 写了一半的行先不要
        assert first['final'] is False and first['src'] == 'alt' and first['job']
        assert j.current is not None  # 还在抓
        with open(box['path'], 'a') as f:
            f.write('00000000000000003"}\n'.replace('"}', '", "desc": "d", "create_time": 1, "video_download_url": "https://v.douyinvod.com/3"}'))
            f.write(json.dumps(row('7300000000000000001')) + '\n')
        box['proc'].close()
        await settle(j)
        last = imports()[-1]
        assert last['final'] is True and last['job'] == first['job']
        handed = [i['aweme'] for b in imports() for i in b['items']]
        assert sorted(handed) == ['7300000000000000001', '7300000000000000002', '7300000000000000003']  # 不重复交
    asyncio.run(go())


def test_crawl_requires_login_and_valid_links():
    w = World()
    j = w.jobs(mc_writes([]))
    with pytest.raises(ValueError, match='还没登录'):
        j.crawl(1, {}, 'creator', [], 'cloud')
    with pytest.raises(ValueError, match='没有认得'):
        j.crawl(1, {'sec_uid': SEC}, 'detail', ['https://evil.example/x'], 'link')


def test_crawl_detail_nothing_found_reports_log():
    async def go():
        w = World()
        j = w.jobs(mc_writes([], code=2, log_lines=['line1', 'login failed please confirm']))
        j.crawl(1, {'sec_uid': SEC, 'cookies': []}, 'detail', ['https://v.douyin.com/abc/', 'junk'], 'link')
        await settle(j)
        argv = w.spawned[0][0]
        assert argv[argv.index('--specified_id') + 1] == 'https://v.douyin.com/abc/'
        assert argv[argv.index('--lt') + 1] == 'qrcode'  # 没有 cookie 就靠浏览器档案里的登录状态
        assert '一条作品也没抓到（MediaCrawler 退出码 2）' in w.said[-1][1] and 'login failed' in w.said[-1][1]
        assert ('progress', {'stage': '完成', 'note': '抓1 条链接：一条作品也没抓到'}) in w.calls
        assert not [k for k, _ in w.calls if k == 'import']
    asyncio.run(go())


def test_parse_event_and_login_helpers():
    assert J.parse_event('{"event": "qr", "png": ""}') == {'event': 'qr', 'png': ''}
    assert J.parse_event('INFO something') is None and J.parse_event('{"x": 1}') is None
    assert sec_uid_from_url(f'https://www.douyin.com/aweme/v1/web/aweme/post/?device_platform=webapp&sec_user_id={SEC}&count=18') == SEC
    assert sec_uid_from_url('https://www.douyin.com/aweme/v1/web/aweme/post/?sec_user_id=self') == ''
    assert nickname_from_title('小橘的抖音 - 抖音') == '小橘'
    assert sms_code('12 34-56') == '123456' and sms_code('刷脸验证') == '' and sms_code('123') == ''


def test_unlock_profile_removes_stale_locks(tmp_path):
    prof = tmp_path / 'browser_data' / 'dy_user_data_dir'
    prof.mkdir(parents=True)
    for name in ('SingletonLock', 'SingletonSocket', 'Cookies'):
        (prof / name).write_text('x')
    J.unlock_profile(str(tmp_path))
    assert sorted(p.name for p in prof.iterdir()) == ['Cookies']


def test_outbox_ack_batch_and_wait():
    from outbox import Outbox

    async def go():
        o = Outbox(keep=5, boot='b1')
        for i in range(7):
            o.put('say', text=str(i))
        assert [e['seq'] for e in o.events] == [3, 4, 5, 6, 7]  # 只留最近 5 条
        o.ack('other-boot', 6)  # 启动号对不上：什么也不扔
        assert len(o.events) == 5
        o.ack('b1', 5)
        assert [e['seq'] for e in o.batch()] == [6, 7]
        big = 'x' * 2_000_000
        o.put('say', png=big)
        o.put('say', png=big)
        assert [e['seq'] for e in o.batch()] == [6, 7, 8]  # 约 3 MB 封顶，但至少一条
        o.ack('b1', 8)
        assert [e['seq'] for e in o.batch()] == [9]
        o.ack('b1', 9)
        waiter = asyncio.create_task(o.wait(5))
        await asyncio.sleep(0)
        o.put('done', aweme='1')
        await asyncio.wait_for(waiter, 1)  # 有新事立刻返回
        await asyncio.wait_for(Outbox().wait(0.05), 1)  # 没事等到超时
    asyncio.run(go())


def test_login_face_verification_buttons_and_qr():
    async def go():
        w = World()

        def on_write(p, text):
            if text == '刷脸验证\n':
                p.queue.put_nowait(ev('verify_qr', text='刷脸验证', png=PNG))
            elif text == '截图\n':
                p.queue.put_nowait(ev('shot', options=['刷脸验证', '短信验证', '确定'], png=PNG))
                p.queue.put_nowait(ev('ok', cookies=[], sec_uid=SEC, nickname='小橘'))
                p.close()

        j = w.jobs(lambda argv: FakeProc([
            ev('qr', png=PNG),
            ev('verify', text='身份验证', options=['刷脸验证', '短信验证'], png=PNG),
        ], on_write=on_write))
        j.login(5)
        await until(lambda: len(w.says) >= 2)
        assert w.says[1]['buttons'] == ['刷脸验证', '短信验证', '截图', '取消登录']
        assert '选验证方式' in w.says[1]['text'] and w.says[1]['png'] == PNG
        assert j.input('刷脸验证')
        await until(lambda: len(w.says) >= 3)
        assert '完成刷脸验证' in w.says[2]['text'] and w.says[2]['png'] == PNG and not w.says[2]['buttons']
        assert j.input('截图')
        await settle(j)
        assert w.says[3]['buttons'] == ['刷脸验证', '短信验证', '确定', '截图', '取消登录']
        assert '登录好了' in w.says[-1]['text']
    asyncio.run(go())


def test_login_cancel():
    async def go():
        w = World()
        procs = []

        def make(argv):
            p = FakeProc([ev('qr', png=PNG)])
            orig = p.kill

            def kill():
                orig()
                p.close()  # 杀掉以后就退出了
            p.kill = kill
            procs.append(p)
            return p

        j = w.jobs(make)
        j.login(5)
        await until(lambda: len(w.said) >= 1)
        assert j.input('取消登录')
        await settle(j)
        assert procs[0].killed and w.said[-1][1] == '好，不登录了。' and w.says[-1]['menu'] is True
        assert j.current is None
    asyncio.run(go())


def test_login_unreadable_event_is_not_dumped():
    async def go():
        w = World()
        broken = '{"event": "error", "text": "x", "png": "iVBORw0KGgo' + 'A' * 5000 + '[1:2:ERROR:gpu] boom'
        j = w.jobs(lambda argv: FakeProc([broken, None], code=0, err_lines=['[0101/ERROR:chrome] something']))
        j.login(1)
        await settle(j)
        path = w.env_extra['DY_LOGIN_EVENTS']  # 登录页的事件走单独的文件
        assert not os.path.exists(path)  # 用完删掉
        msg = w.said[-1][1]
        assert '意外退出了' in msg and '有一条登录页的消息读不出来' in msg and 'something' in msg
        assert 'iVBOR' not in msg and len(msg) < 1000
    asyncio.run(go())


def test_dy_login_events_go_to_file_not_stdout():
    """dy_login 的事件写进 DY_LOGIN_EVENTS 给的文件：浏览器、子进程往标准输出写什么都混不进来，大截图也不会写一半"""
    import subprocess
    import sys
    import tempfile
    fd, path = tempfile.mkstemp()
    os.close(fd)
    code = ("import subprocess, dy_login\n"
            "subprocess.run(['sh', '-c', 'echo CHILD-STDOUT; echo CHILD-STDERR >&2'])\n"
            "dy_login.emit('qr', png='x' * 3000000)\n"
            "dy_login.emit('status', text='好')\n")
    try:
        r = subprocess.run([sys.executable, '-c', code], capture_output=True, text=True, timeout=30,
                           cwd=os.path.dirname(os.path.abspath(__file__)), env={**os.environ, 'DY_LOGIN_EVENTS': path})
        lines = open(path, encoding='utf-8').read().splitlines()
    finally:
        os.remove(path)
    assert [J.parse_event(x)['event'] for x in lines] == ['qr', 'status']
    assert J.parse_event(lines[0])['png'] == 'x' * 3000000
    assert 'CHILD-STDOUT' in r.stdout and '"event"' not in r.stdout


def test_follow_reads_whole_lines_until_done(tmp_path):
    async def go():
        path = tmp_path / 'ev.jsonl'
        done = asyncio.get_running_loop().create_future()
        got = []

        async def reader():
            async for line in J.follow(str(path), done, interval=0.01):
                got.append(line)
        t = asyncio.create_task(reader())
        await asyncio.sleep(0.03)
        with open(path, 'a') as f:
            f.write('{"event": "qr"}\n{"event": "st')  # 第二行写了一半
        await asyncio.sleep(0.05)
        assert got == ['{"event": "qr"}']
        with open(path, 'a') as f:
            f.write('atus"}\n')
        done.set_result(0)
        await asyncio.wait_for(t, 1)
        assert got == ['{"event": "qr"}', '{"event": "status"}']
    asyncio.run(go())


def test_crawl_search_keywords():
    async def go():
        w = World()
        r = row('7300000000000000777')
        r.update(author_sec_uid='MS4wLjABAAAAalt0123456789', author_nickname='小号一')
        j = w.jobs(mc_writes([r]))
        j.crawl(9, {'sec_uid': SEC, 'cookies': []}, 'search', ['小橘 猫', '小橘 猫', '', 'a,b', 'x' * 40, '6', '7', '8'], 'search')
        await settle(j)
        argv = w.spawned[0][0]
        assert argv[argv.index('--type') + 1] == 'search'
        assert argv[argv.index('--keywords') + 1] == '小橘 猫,a b,' + 'x' * 20 + ',6,7'  # 去重、去逗号、截短、最多 5 个
        assert argv[argv.index('--crawler_max_notes_count') + 1] == '50'
        imp = [b for k, b in w.calls if k == 'import'][0]
        assert imp['src'] == 'search' and imp['items'][0]['author'] == '小号一'
        assert imp['items'][0]['author_sec_uid'] == 'MS4wLjABAAAAalt0123456789'
        with pytest.raises(ValueError, match='没有关键词'):
            j.crawl(9, {'sec_uid': SEC}, 'search', [' ', ','], 'search')
        # 频道主说了要几条：照办，最多 500
        for count, want in ((120, '120'), (9999, '500'), ('30', '50'), (0, '50')):
            j.crawl(9, {'sec_uid': SEC, 'cookies': []}, 'search', ['小橘'], 'search', count)
            await settle(j)
            argv = w.spawned[-1][0]
            assert argv[argv.index('--crawler_max_notes_count') + 1] == want
        assert [b for k, b in w.calls if k == 'import'][-1]['what'] == '关键词「小橘」各 50 条'
    asyncio.run(go())


def test_crawl_preempts_waiting_login():
    async def go():
        w = World()
        procs = []

        def make(argv):
            if 'main.py' in argv:
                return mc_writes([row('7300000000000000888')])(argv)
            p = FakeProc([ev('qr', png=PNG)])
            orig = p.kill

            def kill():
                orig()
                p.close()
            p.kill = kill
            procs.append(p)
            return p

        j = w.jobs(make)
        j.login(1)
        await until(lambda: len(w.said) >= 1)
        assert await j.stop_login()
        assert procs[0].killed and j.current is None
        assert '登录先停了' in w.said[-1][1]
        j.crawl(1, {'sec_uid': SEC, 'cookies': []}, 'search', ['小橘'], 'search')
        await settle(j)
        assert [k for k, _ in w.calls if k == 'import']
        assert not await j.stop_login()  # 没在登录：什么也不做
    asyncio.run(go())


def test_kuaishou_login_and_crawl():
    async def go():
        w = World()
        j = w.jobs(lambda argv: FakeProc([ev('qr', png=PNG), ev('ok', cookies=[{'name': 'passToken', 'value': 'p', 'domain': '.kuaishou.com'}],
                                                       sec_uid='2771234567', nickname='快手号'), None]))
        j.login(5, 'ks')
        assert j.current['kind'] == '登录快手'
        await settle(j)
        argv = w.spawned[0][0]
        assert argv[3].endswith('ks_login.py')
        assert '快手 App' in w.said[0][1]
        assert w.calls == [('session', {'cookies': [{'name': 'passToken', 'value': 'p', 'domain': '.kuaishou.com'}],
                                        'sec_uid': '2771234567', 'nickname': '快手号', 'platform': 'ks'})]
        assert '快手登录好了：快手号' in w.said[-1][1]

        ks_row = {'video_id': '3x3zxz4mjrsc8ke', 'title': 't', 'create_time': 1700000000000, 'video_play_url': 'https://v.ks/a.mp4',
                  'author_id': '3x84qugg4ch9zhs', 'author_nickname': '小号'}
        j = w.jobs(mc_writes([ks_row]))
        session = {'sec_uid': '2771234567', 'cookies': [{'name': 'passToken', 'value': 'p', 'domain': '.kuaishou.com'},
                                                        {'name': 'sessionid', 'value': 's', 'domain': '.douyin.com'}]}
        j.crawl(5, session, 'accounts', ['3x84qugg4ch9zhs', 'bad id!'], 'alt', None, 'ks')
        assert j.current['kind'] == '快手同步小号'
        await settle(j)
        argv = w.spawned[-1][0]
        assert argv[argv.index('--platform') + 1] == 'ks' and argv[argv.index('--type') + 1] == 'creator'
        assert argv[argv.index('--creator_id') + 1] == 'https://www.kuaishou.com/profile/3x84qugg4ch9zhs'
        assert argv[argv.index('--cookies') + 1] == 'passToken=p'
        imp = [b for k, b in w.calls if k == 'import'][-1]
        assert imp['what'] == '快手小号主页' and imp['items'][0]['aweme'] == 'ks_3x3zxz4mjrsc8ke'
        # 快手作品链接；快手不抓「自己主页」
        j.crawl(5, session, 'detail', ['https://www.kuaishou.com/short-video/3x3zxz4mjrsc8ke', 'https://v.douyin.com/x/'], 'link', None, 'ks')
        await settle(j)
        argv = w.spawned[-1][0]
        assert argv[argv.index('--specified_id') + 1] == 'https://www.kuaishou.com/short-video/3x3zxz4mjrsc8ke'
        with pytest.raises(ValueError, match='快手不抓'):
            j.crawl(5, session, 'creator', [], 'cloud', None, 'ks')
    asyncio.run(go())
