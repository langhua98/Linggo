"""频道主登录自己的抖音账号（频道主同意的）。

没登录时抖音藏起账号最新的作品、只给第一页；登录后作品列表能看全，自动同步才做得成。
在 Worker 的登录页（/douyin-login）上扫码：无头浏览器打开抖音搜索页（会自己弹出扫码登录框），二维码从页面
取二维码的接口里拿（最清楚，取不到再截图），登录页显示出来，频道主用抖音 App 扫、在手机上确认 → 出现登录
cookie（sessionid）就算登上了。cookie 由这边自己存进 STATE_FILE（频道主不用碰 cookie），DouyinWeb 每次都带着它；
Worker 再取走存一份，Space 重启后写回来。密码不经过这里。弹滑块验证就停下，不去做验证码。"""

import asyncio
import base64
import json
import logging
import os

from .web import CAPTCHA, STATE_FILE

log = logging.getLogger('streamer.douyin')

LOGIN_PAGE = 'https://www.douyin.com/search/%E7%83%AD%E9%97%A8'  # 搜索页：没登录会自己弹出扫码登录框
QR_SELECTORS = ["xpath=//div[contains(@class,'web-login-scan-code')]", "xpath=//div[contains(@class,'qrcode')]"]
SESSION_COOKIES = ('sessionid', 'sessionid_ss', 'sid_guard', 'sid_tt')
WAIT_SECONDS = 300
# check_qrconnect 返回的 status
SCAN_STATUS = {'1': '等待扫码', '2': '已扫码，等手机上确认', '3': '已确认', '4': '已取消', '5': '已过期'}


def logged_in(cookies):
    return any(c.get('name') in SESSION_COOKIES and c.get('value') for c in cookies)


def state_logged_in(path=STATE_FILE):
    try:
        with open(path) as f:
            return logged_in(json.load(f).get('cookies') or [])
    except (OSError, ValueError):
        return False


def restore_state(text, path=STATE_FILE):
    """Worker 存的那份登录 cookie 写回 STATE_FILE（Space 重启后 /tmp 清空了）。本地已经是登录状态就不动"""
    if not text or state_logged_in(path):
        return False
    try:
        if not logged_in(json.loads(text).get('cookies') or []):
            return False
    except ValueError:
        return False
    _write(path, text)
    return True


def _write(path, text):
    tmp = path + '.tmp'
    with open(tmp, 'w') as f:
        f.write(text)
    os.replace(tmp, path)


class QrLogin:
    """start() 之后 state：running → qr_ready（图在 self.qr_png）→ done / error"""

    def __init__(self, *, web, wait=WAIT_SECONDS, poll=3.0, qr_wait=30):
        self.web, self.wait, self.poll, self.qr_wait = web, wait, poll, qr_wait
        self.task = None
        self.qr_png = None
        self.page = None
        self.state = {'status': 'idle'}

    async def screenshot(self):
        """服务器那边登录页现在的样子（排查卡在哪）"""
        if self.page is None or self.page.is_closed():
            return None
        return await self.page.screenshot()

    def running(self):
        return self.task is not None and not self.task.done()

    def start(self):
        if self.running():
            raise RuntimeError('already running')
        self.qr_png = None
        self.state = {'status': 'running', 'qr_ready': False, 'error': ''}
        self.task = asyncio.create_task(self._run())

    async def _run(self):
        st = self.state
        try:
            async with self.web() as w:  # 退出时 DouyinWeb 会把 cookie 存进 STATE_FILE
                if logged_in(await w.ctx.cookies()):
                    st['status'] = 'done'
                    return
                page = await w.ctx.new_page()
                captcha = asyncio.Event()
                qr = asyncio.get_running_loop().create_future()

                async def on_response(res):
                    if CAPTCHA.search(res.url):
                        captcha.set()
                    if 'qrconnect' in res.url:  # 页面每隔一会儿问一次扫码进度
                        try:
                            data = (await res.json()).get('data') or {}
                            st['scan'] = SCAN_STATUS.get(str(data.get('status')), str(data.get('status')))
                            if data.get('redirect_url') or data.get('verify_ticket'):
                                st['scan_extra'] = 'verify' if data.get('verify_ticket') else 'redirect'
                        except Exception:  # noqa: BLE001
                            pass
                    elif 'qrcode' in res.url:
                        try:
                            data = (await res.json()).get('data') or {}
                            if data.get('qrcode'):
                                png = base64.b64decode(data['qrcode'])
                                if qr.done():  # 过期后页面自己换了新码：换上新的
                                    self.qr_png = png
                                    st['qr_version'] = st.get('qr_version', 1) + 1
                                else:
                                    qr.set_result(png)
                        except Exception:  # noqa: BLE001 — 不是 JSON（比如二维码图片本身）
                            pass

                page.on('response', on_response)
                await page.goto(LOGIN_PAGE, wait_until='domcontentloaded', timeout=45000)
                try:
                    png = await asyncio.wait_for(asyncio.shield(qr), self.qr_wait)
                    st['qr'] = 'api'
                except asyncio.TimeoutError:
                    png = await self._screenshot_qr(page)
                    st['qr'] = 'element' if png else 'page'
                self.qr_png = png or await page.screenshot()
                st['qr_ready'] = True
                self.page = page
                for _ in range(int(self.wait / self.poll)):
                    await asyncio.sleep(self.poll)
                    if st.get('scan') == '已过期':  # 二维码过期：点一下刷新（抖音登录框里点二维码就换新的）
                        try:
                            await page.click("xpath=//div[contains(@class,'web-login-scan-code')]", timeout=3000)
                        except Exception:  # noqa: BLE001
                            pass
                    if logged_in(await w.ctx.cookies()):
                        await asyncio.sleep(3)  # 让页面把剩下的 cookie 写完
                        st['status'] = 'done'
                        return
                    if captcha.is_set():
                        st['status'], st['error'] = 'error', '抖音要求滑块验证，这边没法继续'
                        return
                st['status'], st['error'] = 'error', '5 分钟内没登上'
        except asyncio.CancelledError:
            st['status'] = 'stopped'
        except Exception as e:  # noqa: BLE001
            log.exception('douyin login failed')
            st['status'], st['error'] = 'error', f'{type(e).__name__}: {e}'[:200]

    async def _screenshot_qr(self, page):
        """接口里没拿到二维码：等框里的二维码真的画出来（不只是抖音图标）再截那一块"""
        try:
            await page.wait_for_function(
                "() => [...document.querySelectorAll('img,canvas')].some(e => {"
                " const r = e.getBoundingClientRect(); return r.width > 120 && r.width < 400"
                " && Math.abs(r.width - r.height) < 10 && (e.tagName === 'CANVAS' || e.naturalWidth > 100) })",
                timeout=15000)
        except Exception:  # noqa: BLE001
            return None
        for sel in QR_SELECTORS:
            try:
                el = await page.query_selector(sel)
                if el and await el.is_visible():
                    return await el.screenshot()
            except Exception:  # noqa: BLE001
                pass
        return None
