"""云电脑的活（在流式服务里跑 MediaCrawler）：扫码登录抖音、抓自己主页 / 指定作品。一次只干一件。

- 登录：子进程 dy_login.py（xvfb-run + MediaCrawler 的 Python 环境），它一行一个 JSON 事件；二维码、验证截图由小橘视频机器人
  发给频道主，登录好了把 cookie 和账号存进 Worker（/dy-session），Space 重启后抓作品时由 Worker 带过来。
- 抓作品：子进程 MediaCrawler main.py（creator 模式只抓登录账号自己的主页，detail 模式抓指定作品），读它写的 jsonl，
  问 Worker 哪些收过（/dy-known），新的送过去（/dy-import），Worker 再交审核机器人。

外部依赖（起子进程、发 Telegram、调 Worker）都注入，方便测试。
"""

import asyncio
import base64
import collections
import glob
import json
import logging
import os
import re
import shutil
import signal
import tempfile
import time

from mc import cookie_header, items_from, mc_args, read_rows

log = logging.getLogger('jobs')

HERE = os.path.dirname(os.path.abspath(__file__))
LOGIN_TIMEOUT = 8 * 60
CRAWL_TIMEOUT = 60 * 60
BATCH = 100
SEC_UID = re.compile(r'^MS4wLjABAAAA[\w-]{10,200}$')
DETAIL = re.compile(r'^(?:https://(?:v\.|www\.|m\.)?douyin\.com/\S{1,300}|\d{6,25})$')

QR_TEXT = ('用抖音 App 扫这个二维码登录你自己的账号（首页左上角「≡」或「我」→ 右上角扫一扫）。'
           '二维码一两分钟会失效，失效了我会再发新的。')
VERIFY_TEXT = '抖音要再验证一次（{word}，见截图）。收到短信验证码后，直接把验证码数字发给我。'


class Busy(Exception):
    pass


class Proc:
    """asyncio 子进程的薄包装：按行读输出（标准错误并进标准输出）、往标准输入写"""

    def __init__(self, p):
        self.p = p

    async def lines(self):
        while True:
            line = await self.p.stdout.readline()
            if not line:
                return
            yield line.decode('utf-8', 'replace').rstrip('\r\n')

    def write(self, text):
        self.p.stdin.write(text.encode())

    async def wait(self):
        return await self.p.wait()

    def kill(self):
        # xvfb-run 底下还有 Xvfb、Python、Chromium：整个进程组一起杀，不然浏览器档案一直被锁着
        try:
            os.killpg(self.p.pid, signal.SIGKILL)
        except (ProcessLookupError, PermissionError):
            pass


# 子进程用不到 Telegram、Worker 的密钥，不给它们
SECRET_ENV = {'TG_BOT_TOKEN', 'TG_USER_SESSION', 'TG_API_HASH', 'TG_API_ID', 'STREAMER_KEY'}


async def spawn(argv, cwd):
    env = {k: v for k, v in os.environ.items() if k not in SECRET_ENV}
    env['PYTHONUNBUFFERED'] = '1'
    p = await asyncio.create_subprocess_exec(
        *argv, cwd=cwd, env=env, stdin=asyncio.subprocess.PIPE, stdout=asyncio.subprocess.PIPE,
        stderr=asyncio.subprocess.STDOUT, limit=32 * 1024 * 1024,  # 截图的 base64 一行能有好几 MB
        start_new_session=True)  # 自成一个进程组，kill 时连子孙一起
    return Proc(p)


def unlock_profile(mc_dir):
    """上一次被杀掉的 Chromium 可能留下锁文件，留着的话下一次打不开同一个浏览器档案（一次只干一件，这时没人在用）"""
    for f in glob.glob(os.path.join(mc_dir, 'browser_data', '*', 'Singleton*')):
        try:
            os.remove(f)
        except OSError:
            pass


class Jobs:
    def __init__(self, *, spawn, tg, worker, mc_dir, mc_py, xvfb=('xvfb-run', '-a')):
        self.spawn = spawn    # async (argv, cwd) -> Proc
        self.tg = tg          # async (chat_id, text, png=None)
        self.worker = worker  # async (path, body) -> dict
        self.mc_dir = mc_dir
        self.mc_py = mc_py
        self.xvfb = list(xvfb)
        self.current = None   # {'kind', 'since', 'proc'}
        self.task = None

    def status(self):
        c = self.current
        return {'job': c['kind'], 'since': int(c['since'])} if c else {'job': None}

    def _start(self, kind, chat_id, work):
        if self.current:
            raise Busy(self.current['kind'])
        self.current = {'kind': kind, 'since': time.time(), 'proc': None}

        async def runner():
            try:
                await work()
            except Exception as e:  # noqa: BLE001 — 告诉频道主，别让任务悄悄死掉
                log.exception('%s failed', kind)
                await self._say(chat_id, f'{kind}出错了：{type(e).__name__}: {str(e)[:300]}')
            finally:
                proc = self.current and self.current.get('proc')
                if proc:
                    proc.kill()
                self.current = None

        self.task = asyncio.create_task(runner())

    async def _say(self, chat_id, text, png=None):
        try:
            await self.tg(chat_id, text, png)
        except Exception:  # noqa: BLE001
            log.exception('telegram send failed')

    # ── 登录 ──

    def login(self, chat_id):
        self._start('登录抖音', chat_id, lambda: asyncio.wait_for(self._login(chat_id), LOGIN_TIMEOUT))

    def code(self, code):
        """频道主发来的短信验证码交给登录页；没有在等验证码的登录返回 False"""
        c = self.current
        if not c or c['kind'] != '登录抖音' or not c.get('proc'):
            return False
        c['proc'].write(re.sub(r'\D', '', code) + '\n')
        return True

    async def _login(self, chat_id):
        unlock_profile(self.mc_dir)
        proc = await self.spawn(self.xvfb + [self.mc_py, os.path.join(HERE, 'dy_login.py')], self.mc_dir)
        self.current['proc'] = proc
        tail = collections.deque(maxlen=12)
        finished = False
        async for line in proc.lines():
            ev = parse_event(line)
            if not ev:
                tail.append(line[:300])
                continue
            png = base64.b64decode(ev['png']) if ev.get('png') else None
            kind = ev['event']
            if kind == 'qr':
                await self._say(chat_id, QR_TEXT, png)
            elif kind == 'verify':
                await self._say(chat_id, VERIFY_TEXT.format(word=ev.get('text') or '验证'), png)
            elif kind == 'status':
                await self._say(chat_id, ev.get('text') or '')
            elif kind == 'ok':
                if not SEC_UID.match(ev.get('sec_uid') or ''):
                    await self._say(chat_id, '登录好了，但认出来的账号号码不对，没存。再发一次「登录抖音」试试。')
                else:
                    await self.worker('/dy-session', {'cookies': ev.get('cookies') or [], 'sec_uid': ev['sec_uid'],
                                                      'nickname': ev.get('nickname') or ''})
                    await self._say(chat_id, f'✓ 抖音登录好了：{ev.get("nickname") or ev["sec_uid"]}。'
                                             '发「同步作品」就开始抓你主页的全部作品。')
                finished = True
            elif kind == 'error':
                await self._say(chat_id, '抖音登录没成功：' + (ev.get('text') or ''), png)
                finished = True
        code = await proc.wait()
        if not finished:
            await self._say(chat_id, f'抖音登录页意外退出了（退出码 {code}）。最后几行：\n' + '\n'.join(tail))

    # ── 抓作品 ──

    def crawl(self, chat_id, session, mode, targets, src):
        cookies = cookie_header((session or {}).get('cookies'))
        if mode == 'creator':
            sec_uid = (session or {}).get('sec_uid') or ''
            if not SEC_UID.match(sec_uid):
                raise ValueError('还没登录抖音')
            # 只抓登录的那个账号自己的主页：主页地址由登录时认出的 sec_uid 拼出来，不接受外面传进来的
            target, what = f'https://www.douyin.com/user/{sec_uid}', '主页'
        else:
            links = [t for t in targets or [] if DETAIL.match(str(t))][:20]
            if not links:
                raise ValueError('没有认得的抖音链接')
            target, what = ','.join(links), f'{len(links)} 条链接'
        name = '同步作品' if mode == 'creator' else '抓链接'
        self._start(name, chat_id, lambda: asyncio.wait_for(self._crawl(chat_id, mode, target, cookies, src, what), CRAWL_TIMEOUT))

    async def _crawl(self, chat_id, mode, target, cookies, src, what):
        data_dir = tempfile.mkdtemp(prefix='mc-')
        try:
            await self.worker('/dy-progress', {'stage': f'抓{what}'})
            await self._say(chat_id, f'开始抓{what}（MediaCrawler），抓完把新的交给审核机器人。作品多的话要好一会儿。')
            argv = self.xvfb + [self.mc_py, 'main.py'] + mc_args(mode, target, data_dir, cookies)
            unlock_profile(self.mc_dir)
            proc = await self.spawn(argv, self.mc_dir)
            self.current['proc'] = proc
            tail = collections.deque(maxlen=15)
            seen = 0
            async for line in proc.lines():
                tail.append(line[:300])
                if 'update_douyin_aweme' in line:
                    seen += 1
                    if seen % 20 == 0:
                        await self.worker('/dy-progress', {'stage': f'抓{what}', 'done': seen})
            code = await proc.wait()
            items = items_from(read_rows(data_dir))
            if not items:
                await self.worker('/dy-progress', {'stage': '完成', 'note': f'抓{what}：一条作品也没抓到'})
                await self._say(chat_id, f'一条作品也没抓到（MediaCrawler 退出码 {code}）。最后几行日志：\n' +
                                '\n'.join(list(tail)[-8:]))
                return
            total, known, added = await self.push(items, src)
            await self._say(chat_id, f'抓到 {total} 条，{known} 条以前收过，新的 {added} 条已交审核机器人 @xiaojuverify_bot。')
        finally:
            shutil.rmtree(data_dir, ignore_errors=True)

    async def push(self, items, src):
        known = set()
        for i in range(0, len(items), 1000):
            r = await self.worker('/dy-known', {'ids': [x['aweme'] for x in items[i:i + 1000]]})
            known |= set((r or {}).get('known') or [])
        fresh = [x for x in items if x['aweme'] not in known]
        added = 0
        for i in range(0, len(fresh), BATCH):
            r = await self.worker('/dy-import', {'items': fresh[i:i + BATCH], 'src': src})
            added += (r or {}).get('added', 0)
        await self.worker('/dy-progress', {'stage': '完成', 'done': added, 'total': len(items),
                                           'note': f'新送 {added} 条，已有 {len(known)} 条'})
        return len(items), len(known), added


def parse_event(line):
    if not line.startswith('{'):
        return None
    try:
        ev = json.loads(line)
    except ValueError:
        return None
    return ev if isinstance(ev, dict) and isinstance(ev.get('event'), str) else None
