"""抖音扫码登录：流式服务用 xvfb-run + MediaCrawler 的 Python 环境启动，工作目录是 MediaCrawler。

用的是 MediaCrawler 自己的浏览器档案（browser_data/dy_user_data_dir），登录好以后 MediaCrawler 直接就是登录状态。
MediaCrawler 自带的扫码登录把二维码弹在本机屏幕上，服务器上没人看得见，所以这里自己打开登录页、截二维码。

扫完码抖音常要再验证一次（新设备）：刷脸、短信验证码……页面长什么样这里事先不知道，所以做成「遥控」：
把整页截图和页面上能点的选项发给频道主，他点哪个（机器人键盘上的按钮），这里就在页面上点哪个；
点了以后页面上出现二维码（刷脸用的）就把它单独截下来发过去，他用抖音 App 扫、在手机上刷脸。
整个过程中一直看着登录有没有成功。

标准输出一行一个 JSON 事件，流式服务转给频道主：
  {"event": "qr", "png": "<base64>"}                                   登录二维码（第一次，过期刷新后再发）
  {"event": "verify", "text": "…", "options": [...], "png": "<base64>"}  要再验证：整页截图 + 能点的选项
  {"event": "verify_qr", "text": "…", "png": "<base64>"}               点了验证方式以后出现的二维码（刷脸用）
  {"event": "shot", "options": [...], "png": "<base64>"}               频道主要看的当前页面
  {"event": "status", "text": "…"}                                     进度
  {"event": "ok", "cookies": [...], "sec_uid": "…", "nickname": "…"}
  {"event": "error", "text": "…", "png": "<base64，可选>"}
标准输入一行一条频道主发来的话：4～8 位数字是短信验证码；「截图」要当前页面；别的当成页面上要点的字。
"""

import asyncio
import base64
import json
import os
import re
import sys
import threading
import time
import urllib.parse

# 两个地址可以用环境变量换掉，只给本地冒烟测试用（假的登录页）
INDEX = os.environ.get('DY_LOGIN_INDEX', 'https://www.douyin.com/')
SELF_PAGE = os.environ.get('DY_LOGIN_SELF', 'https://www.douyin.com/user/self?showTab=post')
PROFILE = os.path.join(os.getcwd(), 'browser_data', 'dy_user_data_dir')
QR_IMG = "xpath=//div[@id='animate_qrcode_container']//img"
QR_BOX = '#animate_qrcode_container'
LOGIN_PANEL = "xpath=//div[@id='login-panel-new']"
TOTAL_S = 10 * 60
MAX_QR = 5
VERIFY_WORDS = ('身份验证', '安全验证', '验证身份', '验证方式', '刷脸验证', '人脸验证', '扫脸', '短信验证',
                '验证码中间页', '请输入验证码', '获取验证码')

# 页面上能点的选项：先在弹窗里找（验证一般是弹窗），没有弹窗就在全页面按关键字找
OPTIONS_JS = r"""
() => {
  const vis = el => { const r = el.getBoundingClientRect(); const s = getComputedStyle(el);
    return r.width > 0 && r.height > 0 && s.visibility !== 'hidden' && s.display !== 'none' && s.opacity !== '0'; };
  const sel = '[role=dialog],[class*=modal],[class*=Modal],[class*=dialog],[class*=Dialog],[class*=verify],[class*=Verify],[id*=verify],[class*=captcha],[id*=captcha]';
  const dialogs = [...document.querySelectorAll(sel)].filter(vis).filter(d => !d.closest('#login-panel-new'));
  const words = /(刷脸|人脸|扫脸|扫码|短信|验证|手机|确定|确认|下一步|重新|刷新|发送|换一种)/;
  const out = [];
  for (const root of (dialogs.length ? dialogs : [document.body])) {
    for (const el of root.querySelectorAll('button,[role=button],[role=tab],a,li,div,span,p')) {
      if (!vis(el)) continue;
      const t = (el.innerText || '').trim();
      if (t.length < 2 || t.length > 10 || t.includes('\n')) continue;
      if ([...el.children].some(c => (c.innerText || '').trim() === t)) continue;  // 只要最里层那个
      const clickable = ['BUTTON', 'A'].includes(el.tagName) || ['button', 'tab'].includes(el.getAttribute('role'))
        || getComputedStyle(el).cursor === 'pointer';
      if (!clickable) continue;                        // 说明文字不算，只要能点的
      if (!dialogs.length && !words.test(t)) continue;  // 没有弹窗时全页面找：只要和验证有关的
      if (!out.includes(t)) out.push(t);
      if (out.length >= 6) return out;
    }
  }
  return out;
}
"""

# 点了验证方式以后出现的二维码：弹窗里最大的那个方形图片（登录二维码不算）
QR_JS = r"""
() => {
  const vis = el => { const r = el.getBoundingClientRect(); const s = getComputedStyle(el);
    return r.width > 0 && r.height > 0 && s.visibility !== 'hidden' && s.display !== 'none'; };
  const sel = '[role=dialog],[class*=modal],[class*=Modal],[class*=dialog],[class*=Dialog],[class*=verify],[class*=Verify],[id*=verify]';
  const roots = [...document.querySelectorAll(sel)].filter(vis);
  let best = null;
  for (const root of (roots.length ? roots : [document.body])) {
    for (const el of root.querySelectorAll('img,canvas,svg')) {
      if (!vis(el) || el.closest('#animate_qrcode_container')) continue;
      const r = el.getBoundingClientRect();
      if (r.width < 90 || Math.abs(r.width - r.height) > r.width * 0.15) continue;
      if (!best || r.width * r.height > best.width * best.height) best = { x: r.x, y: r.y, width: r.width, height: r.height };
    }
  }
  return best;
}
"""


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


def sms_code(text):
    """「12 34-56」→「123456」；不像验证码返回空"""
    d = re.sub(r'[\s-]', '', text or '')
    return d if re.fullmatch(r'\d{4,8}', d) else ''


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


async def is_visible(page, selector):
    try:
        return await page.locator(selector).first.is_visible()
    except Exception:  # noqa: BLE001
        return False


async def visible_text(page, words):
    for w in words:
        try:
            if await page.get_by_text(w, exact=False).first.is_visible(timeout=300):
                return w
        except Exception:  # noqa: BLE001
            continue
    return ''


async def options(page):
    try:
        return await page.evaluate(OPTIONS_JS)
    except Exception:  # noqa: BLE001
        return []


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
    emit('qr', png=b64(await page.locator(QR_BOX).first.screenshot()))


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
        emit('status', text='页面上没找到填验证码的地方，发「截图」看看现在的样子')
        return
    for name in ('验证', '确定', '提交', '登录', '下一步'):
        try:
            btn = page.get_by_role('button', name=name)
            if await btn.first.is_visible(timeout=500):
                await btn.first.click()
                break
        except Exception:  # noqa: BLE001
            continue
    else:
        await page.keyboard.press('Enter')
    emit('status', text='验证码已经填进去了，等结果…')


async def show(page):
    emit('shot', options=await options(page), png=b64(await page.screenshot()))


async def handle_input(page, text):
    """频道主发来的一句话。返回 True 表示已经把页面现状发过去了（主循环就不用再报一次）"""
    text = (text or '').strip()
    if not text:
        return False
    code = sms_code(text)
    if code:
        await submit_code(page, code)
        return False
    if text == '截图':
        await show(page)
        return True
    # 别的当成要点的字：验证方式（刷脸验证、短信验证……）、确定、下一步……
    try:
        await page.get_by_text(text, exact=True).first.click(timeout=3000)
    except Exception:  # noqa: BLE001
        emit('status', text=f'页面上没找到「{text}」，发「截图」看看现在的样子')
        return False
    await page.wait_for_timeout(2500)
    if re.search('短信|验证码', text):
        for w in ('获取验证码', '发送验证码'):
            try:
                await page.get_by_text(w).first.click(timeout=1500)
                break
            except Exception:  # noqa: BLE001
                continue
        emit('status', text='短信验证码应该发到你手机上了，收到后直接把数字发给我。')
        return False
    box = None
    try:
        box = await page.evaluate(QR_JS)
    except Exception:  # noqa: BLE001
        pass
    if box:
        m = 12
        clip = {'x': max(0, box['x'] - m), 'y': max(0, box['y'] - m),
                'width': box['width'] + 2 * m, 'height': box['height'] + 2 * m}
        emit('verify_qr', text=text, png=b64(await page.screenshot(clip=clip)))
    else:
        await show(page)
    return True


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


def read_inputs(loop, queue):
    """另开一个线程读标准输入（流式服务转来的频道主的话），一行放进队列一条"""
    def run():
        for line in sys.stdin:
            loop.call_soon_threadsafe(queue.put_nowait, line.strip())
    threading.Thread(target=run, daemon=True).start()


async def wait_login(ctx, page, inputs):
    """等频道主扫码、过二次验证；成功返回 True，出错已经 emit 过了返回 False"""
    await open_panel(page)
    await send_qr(page)
    sent, announced = 1, ''
    deadline = time.time() + TOTAL_S
    while not await logged_in(ctx, page):
        if time.time() > deadline:
            emit('error', text=f'{TOTAL_S // 60} 分钟内没登录上', png=b64(await page.screenshot()))
            return False
        shown = False
        while not inputs.empty():
            shown = await handle_input(page, inputs.get_nowait()) or shown
        await page.wait_for_timeout(2000)
        if await page.locator('#captcha-verify-image').count() or '验证码中间页' in (await page.title()):
            emit('status', text='抖音弹了滑块验证，正在自动处理…')
            await solve_slider(ctx, page)
            continue
        if await is_visible(page, QR_BOX):
            # 登录二维码还在：还没扫。过期了就换一张再发
            if await visible_text(page, ('二维码已失效', '二维码已过期', '点击刷新')):
                if sent >= MAX_QR:
                    emit('error', text=f'二维码换了 {MAX_QR} 次都没扫，先不等了')
                    return False
                for w in ('点击刷新', '刷新'):
                    try:
                        await page.get_by_text(w).first.click(timeout=2000)
                        break
                    except Exception:  # noqa: BLE001
                        continue
                await send_qr(page)
                sent += 1
            continue
        # 登录二维码没了（扫过了）：看看是不是要再验证。页面变了（选项不一样了）才再报一次
        word = await visible_text(page, VERIFY_WORDS)
        if not word:
            continue
        opts = await options(page)
        sig = word + '|' + ','.join(opts)
        if shown:
            announced = sig
        elif sig != announced:
            announced = sig
            emit('verify', text=word, options=opts, png=b64(await page.screenshot()))
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
            if not await logged_in(ctx, page) and not await wait_login(ctx, page, inputs):
                return
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
