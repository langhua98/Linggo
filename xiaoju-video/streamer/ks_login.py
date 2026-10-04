"""快手扫码登录：和 dy_login.py 一样由流式服务用 xvfb-run + MediaCrawler 的 Python 环境启动，工作目录是 MediaCrawler。

用 MediaCrawler 自己的快手浏览器档案（browser_data/ks_user_data_dir），登录好以后 MediaCrawler 抓快手直接就是登录状态。
打开快手首页、点「登录」、把二维码截下来发给频道主，用快手 App 扫；要再验证（滑块、短信……）就跟抖音一样遥控：
整页截图和能点的选项发过去，频道主点哪个这里点哪个（这部分直接用 dy_login.py 的）。

事件和 dy_login.py 一样（一行一个 JSON，写进 DY_LOGIN_EVENTS 给的文件）；ok 里的 sec_uid 是快手的用户 id。
"""

import asyncio
import os
import re
import time

from dy_login import b64, emit, handle_input, is_visible, options, read_inputs, visible_text

# 地址可以用环境变量换掉，只给本地冒烟测试用（假的登录页，见 smoke_ks_login.py）
INDEX = os.environ.get('KS_LOGIN_INDEX', 'https://www.kuaishou.com/?isHome=1')
COOKIE_URL = os.environ.get('KS_COOKIE_URL', 'https://www.kuaishou.com')
COOKIE_DOMAIN = os.environ.get('KS_COOKIE_DOMAIN', 'kuaishou.com')
PROFILE = os.path.join(os.getcwd(), 'browser_data', 'ks_user_data_dir')
QR_IMG = "xpath=//div[contains(@class, 'qrcode-img')]//img"
QR_BOX = "xpath=//div[contains(@class, 'qrcode-img')]"
TOTAL_S = 10 * 60
MAX_QR = 5
VERIFY_WORDS = ('安全验证', '身份验证', '验证身份', '拖动滑块', '请完成验证', '短信验证', '验证码')
KS_ID = re.compile(r'^[0-9A-Za-z_-]{3,40}$')


async def logged_in(ctx):
    cookies = await ctx.cookies(COOKIE_URL)
    return any(c['name'] == 'passToken' and c['value'] for c in cookies)


async def open_panel(page):
    for sel in ("xpath=//p[text() = '登录']", "xpath=//*[text() = '登录']", 'text=登录'):
        try:
            await page.locator(sel).first.click(timeout=5000)
            return
        except Exception:  # noqa: BLE001
            continue


async def send_qr(page):
    await page.wait_for_selector(QR_IMG, timeout=30000)
    await page.wait_for_timeout(1500)  # 等二维码图片真的画出来
    emit('qr', png=b64(await page.locator(QR_BOX).first.screenshot()))


async def who_am_i(ctx, page):
    """登录后：用户 id 从 cookie（userId）拿；昵称从页面上自己主页的链接上找（找不到就空着）"""
    cookies = await ctx.cookies(COOKIE_URL)
    uid = next((c['value'] for c in cookies if c['name'] == 'userId' and c['value']), '')
    nickname = ''
    try:
        await page.goto(INDEX, wait_until='domcontentloaded', timeout=60000)
        await page.wait_for_timeout(3000)
        nickname = await page.evaluate(r"""() => {
          for (const a of document.querySelectorAll('a[href*="/profile/"]')) {
            const t = (a.innerText || a.getAttribute('title') || '').trim();
            if (t && t.length <= 30) return t;
          }
          return '';
        }""")
    except Exception:  # noqa: BLE001
        pass
    return uid, nickname


async def wait_login(ctx, page, inputs):
    """等频道主扫码、过二次验证；成功返回 True，出错已经 emit 过了返回 False"""
    await open_panel(page)
    await send_qr(page)
    sent, announced = 1, ''
    deadline = time.time() + TOTAL_S
    while not await logged_in(ctx):
        if time.time() > deadline:
            emit('error', text=f'{TOTAL_S // 60} 分钟内没登录上', png=b64(await page.screenshot()))
            return False
        shown = False
        while not inputs.empty():
            shown = await handle_input(ctx, page, inputs.get_nowait()) or shown
        await page.wait_for_timeout(2000)
        word = await visible_text(page, VERIFY_WORDS)
        if word:
            opts = await options(page)
            sig = word + '|' + ','.join(opts)
            if shown:
                announced = sig
            elif sig != announced:
                announced = sig
                emit('verify', text=word, options=opts, png=b64(await page.screenshot()))
            continue
        if await is_visible(page, QR_BOX) and await visible_text(page, ('二维码已失效', '二维码已过期', '已过期', '点击刷新', '刷新二维码')):
            if sent >= MAX_QR:
                emit('error', text=f'二维码换了 {MAX_QR} 次都没扫，先不等了')
                return False
            for w in ('点击刷新', '刷新二维码', '刷新'):
                try:
                    await page.get_by_text(w).first.click(timeout=2000)
                    break
                except Exception:  # noqa: BLE001
                    continue
            await send_qr(page)
            sent += 1
    return True


async def main():
    from playwright.async_api import async_playwright
    inputs = asyncio.Queue()
    read_inputs(asyncio.get_running_loop(), inputs)
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
            if not await logged_in(ctx) and not await wait_login(ctx, page, inputs):
                return
            emit('status', text='快手登录好了，正在确认是哪个账号…')
            uid, nickname = await who_am_i(ctx, page)
            if not KS_ID.match(uid):
                emit('error', text='登录好了，但没认出是哪个账号（cookie 里没有 userId）', png=b64(await page.screenshot()))
                return
            cookies = [c for c in await ctx.cookies() if COOKIE_DOMAIN in c.get('domain', '')]
            emit('ok', cookies=cookies, sec_uid=uid, nickname=nickname)
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
