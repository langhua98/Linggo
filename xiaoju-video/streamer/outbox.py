"""发件箱：流式服务要报给 Worker 的事都放这里，等 Worker 来取（GET /outbox）。

Hugging Face 的机房按域名挡掉了 *.workers.dev 和 api.telegram.org（TLS 握手超时），流式服务没法主动找 Worker；
Worker 找流式服务一直是通的。所以反过来：Worker 用 Durable Object 的定时器长轮询这里。

事件按序号排好，Worker 取的时候带上它处理到的序号（after）和当时看到的启动号（boot）：启动号对得上，
序号以前的就算收到了、扔掉；对不上说明流式服务重启过，序号从头算，什么也不扔。
"""

import asyncio
import json
import secrets


class Outbox:
    def __init__(self, keep=1000, boot=None):
        self.boot = boot or secrets.token_hex(8)
        self.seq = 0
        self.events = []
        self.keep = keep
        self.changed = asyncio.Event()

    def put(self, kind, **data):
        self.seq += 1
        self.events.append({'seq': self.seq, 'kind': kind, **data})
        if len(self.events) > self.keep:  # Worker 很久没来取：只留最近的
            del self.events[:len(self.events) - self.keep]
        self.changed.set()

    def ack(self, boot, after):
        if boot == self.boot:
            self.events = [e for e in self.events if e['seq'] > after]

    def batch(self, max_bytes=3_000_000, max_events=50):
        """一次给多少：最多 50 条、约 3 MB（截图、整批作品都在里面），至少给一条"""
        out, size = [], 0
        for e in self.events:
            n = len(json.dumps(e, ensure_ascii=False))
            if out and (size + n > max_bytes or len(out) >= max_events):
                break
            out.append(e)
            size += n
        return out

    async def wait(self, timeout):
        """长轮询：有事立刻返回，没事最多等 timeout 秒"""
        if self.events or timeout <= 0:
            return
        self.changed.clear()
        try:
            await asyncio.wait_for(self.changed.wait(), timeout)
        except asyncio.TimeoutError:
            pass
