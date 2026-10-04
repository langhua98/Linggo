"""快手云电脑：在频道主自己的 GitHub Codespace 里跑快手的活。

快手拦了流式服务所在的 Hugging Face 机房（连 www.kuaishou.com 握手都不回），GitHub 的机器连得上，所以快手的
登录、抓作品放到这里。干活的代码和流式服务是同一份（streamer/jobs.py、ks_login.py、MediaCrawler），只是事件不放发件箱，
而是每隔几秒 POST 给 Worker 的 /ks-agent/poll（带 X-Token），同时取走 Worker 派给这里的活、登录时频道主发的话。
抓到的作品由 Worker 交流式服务转发进频道，这里不转。

  python3 ks_agent.py <Worker 地址> <令牌> <MediaCrawler 目录> <MediaCrawler 的 python>
令牌在小橘视频机器人里发「快手云电脑」拿。一般用 run.sh ks 启动。
"""

import asyncio
import json
import os
import sys
import urllib.error
import urllib.request

HERE = os.path.dirname(os.path.abspath(__file__))
sys.path.insert(0, os.path.join(HERE, '..', 'streamer'))

import jobs as J  # noqa: E402

POLL_S = 3          # 闲着的时候多久报到一次
MAX_EVENTS = 50     # 一次最多带几条事件（截图、作品列表可能很大）
SRC = {'accounts': 'alt', 'search': 'search'}


class Forbidden(Exception):
    pass


class Agent:
    def __init__(self, worker, token, mc_dir, mc_py, xvfb=None, call=None):
        self.worker = worker.rstrip('/')
        self.token = token
        self.events = []
        if xvfb is None:  # 有桌面（Codespace 的网页桌面）就直接用，没有用虚拟屏幕
            xvfb = () if os.environ.get('DISPLAY') else ('xvfb-run', '-a')
        self.jobs = J.Jobs(spawn=J.spawn, emit=self.emit, mc_dir=mc_dir, mc_py=mc_py, xvfb=xvfb)
        self.call = call or self.post
        self.hello = True

    def emit(self, kind, **data):
        self.events.append({'kind': kind, **data})

    def post(self, body):
        req = urllib.request.Request(f'{self.worker}/ks-agent/poll', data=json.dumps(body).encode(),
                                     headers={'Content-Type': 'application/json', 'X-Token': self.token}, method='POST')
        try:
            with urllib.request.urlopen(req, timeout=60) as r:
                return json.loads(r.read() or b'{}')
        except urllib.error.HTTPError as e:
            if e.code == 403:
                raise Forbidden() from e
            raise

    def busy(self):
        return (self.jobs.current or {}).get('kind') or ''

    def start(self, job):
        chat = int(job.get('chat') or 0)
        try:
            if job.get('type') == 'login':
                self.jobs.login(chat, 'ks')
            elif job.get('type') == 'crawl':
                self.jobs.crawl(chat, job.get('session') or {}, job.get('mode'), job.get('targets') or [],
                                SRC.get(job.get('mode'), 'link'), job.get('count'), 'ks')
        except J.Busy as e:
            self.emit('say', chat_id=chat, text=f'快手云电脑正在「{e}」，这件没接上，等它干完再发一次。')
        except (ValueError, KeyError, TypeError) as e:
            self.emit('say', chat_id=chat, text=f'快手云电脑没接这件活：{e}')

    async def tick(self):
        """报到一次：带上攒的事件，拿回活和频道主的话。返回 False 表示令牌不对，该停了"""
        events = self.events[:MAX_EVENTS]
        body = {'busy': self.busy(), 'events': events, 'hello': self.hello}
        try:
            r = await asyncio.to_thread(self.call, body)
        except Forbidden:
            print('令牌不对（换过了？）：在机器人里发「快手云电脑」拿新的，再运行 run.sh ks <Worker> <新令牌>', flush=True)
            return False
        except Exception as e:  # noqa: BLE001 — 网络抖一下：事件留着下次再送
            print(f'连不上 Worker：{type(e).__name__}: {e}，过一会儿再试', flush=True)
            await asyncio.sleep(10)
            return True
        del self.events[:len(events)]  # 送到了：去掉送出去的这几条（等回音时新来的留着）
        if self.hello:
            print('快手云电脑开着了：等机器人派活（这个终端别关）。', flush=True)
            self.hello = False
        for text in r.get('inputs') or []:
            self.jobs.input(text)
        for job in r.get('jobs') or []:
            print(f'接到活：{job.get("type")} {job.get("mode") or ""}', flush=True)
            self.start(job)
        return True

    async def run(self):
        while await self.tick():
            await asyncio.sleep(1 if self.events else POLL_S)


def main(argv):
    worker, token, mc_dir, mc_py = argv[1:5]
    asyncio.run(Agent(worker, token, mc_dir, mc_py).run())


if __name__ == '__main__':
    main(sys.argv)
