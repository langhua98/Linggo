"""快手云电脑（ks_agent.py）：报到、送事件、接活、转频道主的话。不起浏览器、不起 MediaCrawler"""

import asyncio
import os
import sys

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))

import ks_agent as A  # noqa: E402


class FakeJobs:
    def __init__(self):
        self.current = None
        self.calls = []
        self.busy_with = ''

    def login(self, chat, platform):
        if self.busy_with:
            raise A.J.Busy(self.busy_with)
        self.calls.append(('login', chat, platform))
        self.current = {'kind': '登录快手'}

    def crawl(self, *args):
        if args[2] == 'creator':
            raise ValueError('快手不抓自己主页：把主页链接当小号发')
        self.calls.append(('crawl',) + args)

    def input(self, text):
        self.calls.append(('input', text))
        return True


def make(replies):
    sent = []

    def call(body):
        sent.append(body)
        r = replies.pop(0)
        if isinstance(r, Exception):
            raise r
        return r
    a = A.Agent('https://w.example/', 'tok', '/mc', '/mc/py', xvfb=(), call=call)
    a.jobs = FakeJobs()
    return a, sent


def test_tick_sends_events_takes_jobs_and_inputs():
    async def go():
        a, sent = make([
            {'jobs': [{'type': 'login', 'chat': 7}], 'inputs': []},
            {'jobs': [], 'inputs': ['截图', '取消登录']},
            {'jobs': [{'type': 'crawl', 'chat': 7, 'mode': 'accounts', 'targets': ['3x84'], 'session': {'sec_uid': '1'}, 'count': None}]},
        ])
        assert await a.tick()
        assert sent[0] == {'busy': '', 'events': [], 'hello': True}
        assert a.jobs.calls == [('login', 7, 'ks')]
        a.emit('say', chat_id=7, text='扫码')
        assert await a.tick()
        assert sent[1]['busy'] == '登录快手' and sent[1]['hello'] is False
        assert sent[1]['events'] == [{'kind': 'say', 'chat_id': 7, 'text': '扫码'}]
        assert a.events == []  # 送到了就去掉
        assert a.jobs.calls[1:] == [('input', '截图'), ('input', '取消登录')]
        a.jobs.current = None
        assert await a.tick()
        assert a.jobs.calls[-1] == ('crawl', 7, {'sec_uid': '1'}, 'accounts', ['3x84'], 'alt', None, 'ks')
    asyncio.run(go())


def test_network_error_keeps_events_and_forbidden_stops(monkeypatch):
    async def go():
        async def no_sleep(_):
            return None
        monkeypatch.setattr(A.asyncio, 'sleep', no_sleep)
        a, sent = make([OSError('down'), {'jobs': []}, A.Forbidden()])
        a.emit('progress', stage='抓')
        assert await a.tick()  # 连不上：不停，事件留着
        assert a.events == [{'kind': 'progress', 'stage': '抓'}]
        assert await a.tick()
        assert sent[1]['events'] == [{'kind': 'progress', 'stage': '抓'}] and a.events == []
        assert await a.tick() is False  # 令牌不对：停
    asyncio.run(go())


def test_events_sent_in_batches_and_new_ones_kept():
    async def go():
        a, sent = make([{'jobs': []}, {'jobs': []}])
        for i in range(A.MAX_EVENTS + 5):
            a.emit('say', n=i)
        assert await a.tick()
        assert len(sent[0]['events']) == A.MAX_EVENTS and len(a.events) == 5
        assert await a.tick()
        assert [e['n'] for e in sent[1]['events']] == list(range(A.MAX_EVENTS, A.MAX_EVENTS + 5))
    asyncio.run(go())


def test_bad_jobs_reported_not_crash():
    a, _ = make([])
    a.jobs.busy_with = '快手搜索'
    a.start({'type': 'login', 'chat': 7})
    a.jobs.busy_with = ''
    a.start({'type': 'crawl', 'chat': 7, 'mode': 'creator', 'targets': []})
    texts = [e['text'] for e in a.events]
    assert '快手云电脑正在「快手搜索」' in texts[0]
    assert '快手不抓自己主页' in texts[1]
