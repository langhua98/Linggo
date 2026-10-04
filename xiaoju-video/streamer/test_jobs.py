"""云电脑任务（jobs.py）：假的子进程、Telegram、Worker。python -m pytest -q"""

import asyncio
import base64
import json
import os

import pytest

import jobs as J
from dy_login import nickname_from_title, sec_uid_from_url

SEC = 'MS4wLjABAAAAabcdefghijklmnop'
PNG = base64.b64encode(b'\x89PNG fake').decode()


class FakeProc:
    def __init__(self, lines, on_write=None, code=0):
        self.queue = asyncio.Queue()
        for line in lines:
            self.queue.put_nowait(line)
        self.on_write = on_write
        self.code = code
        self.written = []
        self.killed = False
        self.closed = False

    def close(self):
        self.queue.put_nowait(None)

    async def lines(self):
        while True:
            line = await self.queue.get()
            if line is None:
                return
            yield line

    def write(self, text):
        self.written.append(text)
        if self.on_write:
            self.on_write(self, text)

    async def wait(self):
        return self.code

    def kill(self):
        self.killed = True


def ev(event, **kw):
    return json.dumps({'event': event, **kw})


class World:
    """假的发件箱：say 记进 said，其余记进 calls"""

    def __init__(self):
        self.said = []
        self.calls = []
        self.spawned = []
        self.procs = []

    def emit(self, kind, **data):
        if kind == 'say':
            self.said.append((data['chat_id'], data['text'], data['png']))
        else:
            self.calls.append((kind, data))

    def jobs(self, make_proc):
        async def spawn(argv, cwd):
            self.spawned.append((argv, cwd))
            p = make_proc(argv)
            self.procs.append(p)
            return p
        return J.Jobs(spawn=spawn, emit=self.emit, mc_dir='/mc', mc_py='/venv/python')


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
        for _ in range(50):
            await asyncio.sleep(0)
        assert j.code('12 34-56')
        await settle(j)
        argv, cwd = w.spawned[0]
        assert argv[:2] == ['xvfb-run', '-a'] and argv[2] == '/venv/python' and argv[3].endswith('dy_login.py')
        assert cwd == '/mc'
        assert w.procs[0].written == ['123456\n']
        assert [png for _, _, png in w.said[:3]] == [PNG, PNG, PNG]
        assert '扫这个二维码' in w.said[0][1] and '身份验证' in w.said[2][1]
        assert w.calls == [('session', {'cookies': [{'name': 'sessionid', 'value': 's', 'domain': '.douyin.com'}],
                                        'sec_uid': SEC, 'nickname': '小橘'})]
        assert '登录好了：小橘' in w.said[-1][1]
        assert j.current is None and not j.code('1')
    asyncio.run(go())


def test_login_error_and_crash():
    async def go():
        w = World()
        j = w.jobs(lambda argv: FakeProc([ev('error', text='6 分钟内没登录上'), None]))
        j.login(1)
        await settle(j)
        assert w.said[-1][1] == '抖音登录没成功：6 分钟内没登录上' and w.calls == []
        j = w.jobs(lambda argv: FakeProc(['Traceback: boom', None], code=1))
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
