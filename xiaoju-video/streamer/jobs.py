"""云电脑的活（在流式服务里跑 MediaCrawler）：扫码登录抖音、抓自己主页 / 指定作品。一次只干一件。

- 登录：子进程 dy_login.py（xvfb-run + MediaCrawler 的 Python 环境），它一行一个 JSON 事件；二维码、验证截图交给 Worker
  由小橘视频机器人发给频道主，登录好了把 cookie 和账号交给 Worker 存起来，Space 重启后抓作品时由 Worker 带过来。
- 抓作品：子进程 MediaCrawler main.py（creator 模式只抓登录账号自己的主页，detail 模式抓指定作品），读它写的 jsonl，
  整批交给 Worker（它查重、交审核机器人、告诉频道主抓到几条）。

要交给 Worker 的都通过 emit 放进发件箱（outbox.py），由 Worker 来取：HF 机房连不上 Worker。
外部依赖（起子进程、发件箱）都注入，方便测试。
"""

import asyncio
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
LOGIN_TIMEOUT = 12 * 60
CRAWL_TIMEOUT = 60 * 60
SEC_UID = re.compile(r'^MS4wLjABAAAA[\w-]{10,200}$')
DETAIL = re.compile(r'^(?:https://(?:v\.|www\.|m\.)?douyin\.com/\S{1,300}|\d{6,25})$')

QR_TEXT = ('用抖音 App 扫这个二维码登录你自己的账号（首页左上角「≡」或「我」→ 右上角扫一扫）。'
           '二维码一两分钟会失效，失效了我会再发新的。')
VERIFY_TEXT = ('抖音要再验证一次（{word}，见截图）。点下面的按钮选验证方式：选刷脸的话，我把刷脸用的二维码发过来，'
               '你用抖音 App 扫、在手机上刷脸；选短信的话，收到验证码后直接把数字发给我。')
VERIFY_QR_TEXT = '用抖音 App 扫这个二维码，在手机上完成刷脸验证。过期了再点一次「{text}」。'
EXTRA_BUTTONS = ['截图', '取消登录']


class Busy(Exception):
    pass


class Proc:
    """asyncio 子进程的薄包装：按行读输出（标准错误并在一起；xvfb-run 本来也会并），往标准输入写"""

    def __init__(self, p):
        self.p = p

    async def lines(self):
        while True:
            try:
                line = await self.p.stdout.readline()
            except ValueError:  # 一行太长（被截断、插断的大段输出）：跳过
                continue
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


async def spawn(argv, cwd, env_extra=None):
    env = {k: v for k, v in os.environ.items() if k not in SECRET_ENV}
    env['PYTHONUNBUFFERED'] = '1'
    env.update(env_extra or {})
    p = await asyncio.create_subprocess_exec(
        *argv, cwd=cwd, env=env, stdin=asyncio.subprocess.PIPE, stdout=asyncio.subprocess.PIPE,
        stderr=asyncio.subprocess.STDOUT, limit=4 * 1024 * 1024,
        start_new_session=True)  # 自成一个进程组，kill 时连子孙一起
    return Proc(p)


async def follow(path, done, interval=0.3):
    """一直读文件新增的整行（像 tail -f）；done（子进程退出的任务）结束后再读最后一遍就停。写了一半的行留到下次"""
    pos, buf = 0, b''
    while True:
        finished = done.done()
        try:
            with open(path, 'rb') as f:
                f.seek(pos)
                data = f.read()
        except FileNotFoundError:
            data = b''
        pos += len(data)
        *lines, buf = (buf + data).split(b'\n')
        for line in lines:
            if line.strip():
                yield line.decode('utf-8', 'replace')
        if finished:
            return
        await asyncio.sleep(interval)


def unlock_profile(mc_dir):
    """上一次被杀掉的 Chromium 可能留下锁文件，留着的话下一次打不开同一个浏览器档案（一次只干一件，这时没人在用）"""
    for f in glob.glob(os.path.join(mc_dir, 'browser_data', '*', 'Singleton*')):
        try:
            os.remove(f)
        except OSError:
            pass


class Jobs:
    def __init__(self, *, spawn, emit, mc_dir, mc_py, xvfb=('xvfb-run', '-a')):
        self.spawn = spawn    # async (argv, cwd) -> Proc
        self.emit = emit      # (kind, **data)：放进发件箱，Worker 来取
        self.mc_dir = mc_dir
        self.mc_py = mc_py
        self.xvfb = list(xvfb)
        self.current = None   # {'kind', 'since', 'proc'}
        self.task = None
        self.poll_interval = 0.3  # 多久读一次登录页的事件文件
        self.debug = collections.deque(maxlen=10)  # 登录页的诊断（GET /douyin/debug 看，不发给频道主）

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
                self._say(chat_id, f'{kind}出错了：{type(e).__name__}: {str(e)[:300]}', menu=True)
            finally:
                proc = self.current and self.current.get('proc')
                if proc:
                    proc.kill()
                self.current = None

        self.task = asyncio.create_task(runner())

    def _say(self, chat_id, text, png=None, buttons=None, menu=False):
        """给频道主的话（png 是 base64 的截图）：Worker 取走后由小橘视频机器人发。
        buttons：机器人键盘上临时换成这几个按钮（点了就把字发回来）；menu：换回平时的菜单键盘"""
        self.emit('say', chat_id=chat_id, text=text, png=png or None, buttons=buttons or None, menu=menu)

    # ── 登录 ──

    def login(self, chat_id):
        self._start('登录抖音', chat_id, lambda: asyncio.wait_for(self._login(chat_id), LOGIN_TIMEOUT))

    def input(self, text):
        """登录进行中频道主发来的话交给登录页（验证码、选哪种验证、截图）；「取消登录」就停掉。没有在登录返回 False"""
        c = self.current
        if not c or c['kind'] != '登录抖音' or not c.get('proc'):
            return False
        text = re.sub(r'[\r\n]+', ' ', str(text or '')).strip()[:40]
        if text == '取消登录':
            c['cancelled'] = True
            c['proc'].kill()
        elif text:
            c['proc'].write(text + '\n')
        return True

    async def _login(self, chat_id):
        unlock_profile(self.mc_dir)
        # 登录页的事件写进单独的文件（见 dy_login.py 的 emit）：标准输出被 xvfb-run 和浏览器的日志并在一起，还会被设成非阻塞
        fd, events_path = tempfile.mkstemp(prefix='dy-login-', suffix='.jsonl')
        os.close(fd)
        try:
            await self._login_run(chat_id, events_path)
        finally:
            try:
                os.remove(events_path)
            except OSError:
                pass

    async def _login_run(self, chat_id, events_path):
        proc = await self.spawn(self.xvfb + [self.mc_py, os.path.join(HERE, 'dy_login.py')], self.mc_dir,
                                env_extra={'DY_LOGIN_EVENTS': events_path})
        self.current['proc'] = proc
        tail = collections.deque(maxlen=12)

        async def drain_logs():  # 子进程自己的输出（浏览器、Playwright 的日志）：留最后几行，出事了给频道主看；不读的话管道满了会卡住
            async for line in proc.lines():
                tail.append(line[:200])
        logs = asyncio.create_task(drain_logs())
        exited = asyncio.create_task(proc.wait())
        finished = False
        async for line in follow(events_path, exited, self.poll_interval):
            ev = parse_event(line)
            if not ev:
                tail.append('（有一条登录页的消息读不出来）')
                continue
            png = ev.get('png') or None
            kind = ev['event']
            opts = [str(o)[:20] for o in (ev.get('options') or []) if o][:6]
            if kind == 'debug':
                self.debug.append(ev)
                continue
            if kind == 'qr':
                self._say(chat_id, QR_TEXT, png)
            elif kind == 'verify':
                self._say(chat_id, VERIFY_TEXT.format(word=ev.get('text') or '验证'), png, buttons=opts + EXTRA_BUTTONS)
            elif kind == 'verify_qr':
                self._say(chat_id, VERIFY_QR_TEXT.format(text=ev.get('text') or '刷脸验证'), png)
            elif kind == 'shot':
                self._say(chat_id, ev.get('text') or '抖音登录页现在的样子：', png, buttons=opts + EXTRA_BUTTONS)
            elif kind == 'status':
                self._say(chat_id, ev.get('text') or '')
            elif kind == 'ok':
                if not SEC_UID.match(ev.get('sec_uid') or ''):
                    self._say(chat_id, '登录好了，但认出来的账号号码不对，没存。再发一次「登录抖音」试试。', menu=True)
                else:
                    self.emit('session', cookies=ev.get('cookies') or [], sec_uid=ev['sec_uid'],
                              nickname=ev.get('nickname') or '')
                    self._say(chat_id, f'✓ 抖音登录好了：{ev.get("nickname") or ev["sec_uid"]}。'
                                       '发「同步作品」就开始抓你主页的全部作品。', menu=True)
                finished = True
            elif kind == 'error':
                self._say(chat_id, '抖音登录没成功：' + (ev.get('text') or ''), png, menu=True)
                finished = True
        code = await exited
        try:
            await asyncio.wait_for(logs, 5)
        except asyncio.TimeoutError:
            logs.cancel()
        if self.current and self.current.get('cancelled'):
            self._say(chat_id, '好，不登录了。', menu=True)
        elif not finished:
            self._say(chat_id, f'抖音登录页意外退出了（退出码 {code}）。最后几行：\n' + '\n'.join(tail), menu=True)

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
            self.emit('progress', stage=f'抓{what}')
            self._say(chat_id, f'开始抓{what}（MediaCrawler），抓完把新的交给审核机器人。作品多的话要好一会儿。')
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
                        self.emit('progress', stage=f'抓{what}', done=seen)
            code = await proc.wait()
            items = items_from(read_rows(data_dir))
            if not items:
                self.emit('progress', stage='完成', note=f'抓{what}：一条作品也没抓到')
                self._say(chat_id, f'一条作品也没抓到（MediaCrawler 退出码 {code}）。最后几行日志：\n' +
                          '\n'.join(list(tail)[-8:]))
                return
            # 整批交给 Worker：它查重、存进待审核、交审核机器人，再告诉频道主抓到几条、新的几条
            self.emit('import', chat_id=chat_id, items=items, src=src, what=what)
        finally:
            shutil.rmtree(data_dir, ignore_errors=True)


def parse_event(line):
    if not line.startswith('{'):
        return None
    try:
        ev = json.loads(line)
    except ValueError:
        return None
    return ev if isinstance(ev, dict) and isinstance(ev.get('event'), str) else None
