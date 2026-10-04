"""抖音扫码登录：流式服务用 xvfb-run + MediaCrawler 的 Python 环境启动，工作目录是 MediaCrawler。

用的是 MediaCrawler 自己的浏览器档案（browser_data/dy_user_data_dir），登录好以后 MediaCrawler 直接就是登录状态。
MediaCrawler 自带的扫码登录把二维码弹在本机屏幕上，服务器上没人看得见，所以这里自己打开登录页、截二维码。

标准输出一行一个 JSON 事件，流式服务转给频道主：
  {"event": "qr", "png": "<base64>"}                     二维码（第一次，过期刷新后再发）
  {"event": "verify", "png": "<base64>", "text": "…"}    扫码后抖音要再验证（短信验证码）：之后从标准输入读一行验证码
  {"event": "status", "text": "…"}                       进度
  {"event": "ok", "cookies": [...], "sec_uid": "…", "nickname": "…"}
  {"event": "error", "text": "…", "png": "<base64，可选>"}
"""

import asyncio
import base64
import json
import os
import re
import sys
import time
import urllib.parse

# 两个地址可以用环境变量换掉，只给本地冒烟测试用（假的登录页）
INDEX = os.environ.get('DY_LOGIN_INDEX', 'https://www.douyin.com/')
SELF_PAGE = os.environ.get('DY_LOGIN_SELF', 'https://www.douyin.com/user/self?showTab=post')
PROFILE = os.path.join(os.getcwd(), 'browser_data', 'dy_user_data_dir')
QR_IMG = "xpath=//div[@id='animate_qrcode_container']//img"
QR_BOX = '#animate_qrcode_container'
LOGIN_PANEL = "xpath=//div[@id='login-panel-new']"
TOTAL_S = 6 * 60
MAX_QR = 5
CODE_WAIT_S = 5 * 60
VERIFY_WORDS = ('身份验证', '安全验证', '短信验证', '验证码中间页', '请输入验证码', '获取验证码')


def emit(event, **kw):
    print(json.dumps({'event': event, **kw}, ensure_ascii=False), flush=True)


def b64(png):
    return base64.b64encode(png).decode()


def sec_uid_from_url(url):
    """作品列表接口的地址里带着 sec_user_id"""
    q = urllib.parse.parse_qs(urllib.parse.urlsplit(url).query)
    v = (q.get('sec_user_id') or [''])[0]
    return v if re.fullmatch(r'MS4wLjABAAAA[\w-]+', v) else ''


def nickname_from_title(title):
    """「小橘的抖音 - 抖音」→「小橘」"""
    t = re.sub(r'\s*-\s*抖音\s*$', '', title or '').strip()
    return re.sub(r'的抖音$', '', t).strip()


async def logged_in(ctx, page):
    try:
        ls = await page.evaluate('() => window.localStorage.getItem("HasUserLogin")')
        if ls == '1':
            return True
    except Exception:  # noqa: BLE001 — 页面在跳转
        pass
    cookies = await ctx.cookies(INDEX)
    return any(c['name'] == 'LOGIN_STATUS' and c['value'] == '1' for c in cookies) or \
        any(c['name'] == 'sessionid' and c['value'] for c in cookies)


async def visible_text(page, words):
    for w in words:
        try:
            if await page.get_by_text(w, exact=False).first.is_visible(timeout=300):
                return w
        except Exception:  # noqa: BLE001
            continue
    return ''


async def open_panel(page):
    try:
        await page.wait_for_selector(LOGIN_PANEL, timeout=10000)
        return
    except Exception:  # noqa: BLE001 — 没自己弹出来，点右上角的「登录」
        pass
    for sel in ("xpath=//p[text() = '登录']", "xpath=//button[contains(., '登录')]", 'text=登录'):
        try:
            await page.locator(sel).first.click(timeout=5000)
            return
        except Exception:  # noqa: BLE001
            continue


async def send_qr(page):
    await page.wait_for_selector(QR_IMG, timeout=30000)
    await page.wait_for_timeout(1500)  # 等二维码图片真的画出来
    box = page.locator(QR_BOX).first
    emit('qr', png=b64(await box.screenshot()))


async def solve_slider(ctx, page):
    """滑块验证：用 MediaCrawler 自带的处理（它在工作目录里）"""
    try:
        sys.path.insert(0, os.getcwd())
        from media_platform.douyin.login import DouYinLogin
        await DouYinLogin('qrcode', ctx, page).check_page_display_slider(move_step=3, slider_level='hard')
    except SystemExit:
        pass
    except Exception as e:  # noqa: BLE001
        emit('status', text=f'滑块验证没处理成：{type(e).__name__}')


async def submit_code(page, code):
    filled = False
    for sel in ("input[placeholder*='验证码']", "input[type='tel']", "input[type='number']"):
        try:
            box = page.locator(sel).first
            if await box.is_visible(timeout=1000):
                await box.fill(code)
                filled = True
                break
        except Exception:  # noqa: BLE001
            continue
    if not filled:
        emit('status', text='页面上没找到填验证码的地方')
        return
    for name in ('验证', '确定', '提交', '登录', '下一步'):
        try:
            btn = page.get_by_role('button', name=name)
            if await btn.first.is_visible(timeout=500):
                await btn.first.click()
                return
        except Exception:  # noqa: BLE001
            continue
    await page.keyboard.press('Enter')


async def read_code():
    loop = asyncio.get_running_loop()
    line = await asyncio.wait_for(loop.run_in_executor(None, sys.stdin.readline), CODE_WAIT_S)
    return re.sub(r'\D', '', line or '')


async def who_am_i(page):
    """登录后打开自己的主页：从作品列表接口的请求里拿 sec_user_id，从标题拿昵称"""
    found = {}

    def on_request(req):
        if '/aweme/v1/web/aweme/post/' in req.url and not found.get('sec_uid'):
            found['sec_uid'] = sec_uid_from_url(req.url)

    async def on_response(res):
        if '/user/profile/self' in res.url and not found.get('sec_uid'):
            try:
                user = (await res.json()).get('user') or {}
                found['sec_uid'] = user.get('sec_uid') or ''
                found['nickname'] = user.get('nickname') or ''
            except Exception:  # noqa: BLE001
                pass

    page.on('request', on_request)
    page.on('response', on_response)
    await page.goto(SELF_PAGE, wait_until='domcontentloaded', timeout=60000)
    for _ in range(30):
        if found.get('sec_uid'):
            break
        await page.wait_for_timeout(1000)
    nickname = found.get('nickname') or nickname_from_title(await page.title())
    return found.get('sec_uid') or '', nickname


async def main():
    from playwright.async_api import async_playwright
    async with async_playwright() as p:
        ctx = await p.chromium.launch_persistent_context(
            PROFILE, headless=False, locale='zh-CN', viewport={'width': 1280, 'height': 860},
            args=['--disable-blink-features=AutomationControlled'])
        if os.path.exists('libs/stealth.min.js'):
            await ctx.add_init_script(path='libs/stealth.min.js')
        page = ctx.pages[0] if ctx.pages else await ctx.new_page()
        try:
            await page.goto(INDEX, wait_until='domcontentloaded', timeout=60000)
            await page.wait_for_timeout(3000)
            if not await logged_in(ctx, page):
                await open_panel(page)
                await send_qr(page)
                sent, asked = 1, False
                deadline = time.time() + TOTAL_S
                while not await logged_in(ctx, page):
                    if time.time() > deadline:
                        emit('error', text='6 分钟内没登录上', png=b64(await page.screenshot()))
                        return
                    await page.wait_for_timeout(2000)
                    if await page.locator('#captcha-verify-image').count() or '验证码中间页' in (await page.title()):
                        emit('status', text='抖音弹了滑块验证，正在自动处理…')
                        await solve_slider(ctx, page)
                        continue
                    if await visible_text(page, ('二维码已失效', '二维码已过期', '点击刷新')):
                        if sent >= MAX_QR:
                            emit('error', text=f'二维码换了 {MAX_QR} 次都没扫，先不等了')
                            return
                        for w in ('点击刷新', '刷新'):
                            try:
                                await page.get_by_text(w).first.click(timeout=2000)
                                break
                            except Exception:  # noqa: BLE001
                                continue
                        await send_qr(page)
                        sent += 1
                        continue
                    # 二维码还在页面上就是还没扫：这时不看「验证码」之类的字（登录面板上本来就有「验证码登录」）
                    scanned = not await page.locator(QR_BOX).first.is_visible()
                    word = '' if asked or not scanned else await visible_text(page, VERIFY_WORDS)
                    if word:
                        # 有「获取验证码」就先点一下，让抖音把短信发出去
                        try:
                            await page.get_by_text('获取验证码').first.click(timeout=2000)
                        except Exception:  # noqa: BLE001
                            pass
                        await page.wait_for_timeout(1500)
                        emit('verify', text=word, png=b64(await page.screenshot()))
                        asked = True
                        try:
                            code = await read_code()
                        except asyncio.TimeoutError:
                            emit('error', text='5 分钟内没收到验证码')
                            return
                        if code:
                            await submit_code(page, code)
                            await page.wait_for_timeout(3000)
                            asked = False  # 验证码不对的话还会再问
            emit('status', text='登录好了，正在确认是哪个账号…')
            sec_uid, nickname = await who_am_i(page)
            if not sec_uid:
                emit('error', text='登录好了，但没认出是哪个账号（主页没加载出作品列表）', png=b64(await page.screenshot()))
                return
            cookies = [c for c in await ctx.cookies() if 'douyin.com' in c.get('domain', '')]
            emit('ok', cookies=cookies, sec_uid=sec_uid, nickname=nickname)
        except Exception as e:  # noqa: BLE001 — 把当时的页面截下来，方便看是卡在哪
            try:
                png = b64(await page.screenshot())
            except Exception:  # noqa: BLE001
                png = ''
            emit('error', text=f'{type(e).__name__}: {str(e)[:200]}', png=png)
        finally:
            await ctx.close()


if __name__ == '__main__':
    asyncio.run(main())
