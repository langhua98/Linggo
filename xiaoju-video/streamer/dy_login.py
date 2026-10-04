"""抖音扫码登录：流式服务用 xvfb-run + MediaCrawler 的 Python 环境启动，工作目录是 MediaCrawler。

用的是 MediaCrawler 自己的浏览器档案（browser_data/dy_user_data_dir），登录好以后 MediaCrawler 直接就是登录状态。
MediaCrawler 自带的扫码登录把二维码弹在本机屏幕上，服务器上没人看得见，所以这里自己打开登录页、截二维码。

扫完码抖音常要再验证一次（新设备）：刷脸、短信验证码……页面长什么样这里事先不知道，所以做成「遥控」：
把整页截图和页面上能点的选项发给频道主，他点哪个（机器人键盘上的按钮），这里就在页面上点哪个；
点了以后页面上出现二维码（刷脸用的）就把它单独截下来发过去，他用抖音 App 扫、在手机上刷脸。
整个过程中一直看着登录有没有成功。

一行一个 JSON 事件，写进环境变量 DY_LOGIN_EVENTS 给的文件（没给就写标准输出），流式服务转给频道主：
  {"event": "qr", "png": "<base64>"}                                   登录二维码（第一次，过期刷新后再发）
  {"event": "verify", "text": "…", "options": [...], "png": "<base64>"}  要再验证：整页截图 + 能点的选项
  {"event": "verify_qr", "text": "…", "png": "<base64>"}               点了验证方式以后出现的二维码（刷脸用）
  {"event": "shot", "text": "…", "options": [...], "png": "<base64>"}  当前页面（频道主要看的、点了选项以后的）
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
# 「要再验证」的字样：都是只在验证弹窗里才有的（登录面板里本来就有「验证码登录」，不能算）
VERIFY_WORDS = ('身份验证', '安全验证', '验证身份', '验证方式', '刷脸验证', '人脸验证', '扫脸验证')

# 页面上的弹窗（验证一般是弹窗）；嵌套匹配上的只要最外层。登录面板不算
DIALOGS_JS = r"""
const vis = el => { const r = el.getBoundingClientRect(); const s = getComputedStyle(el);
  return r.width > 0 && r.height > 0 && s.visibility !== 'hidden' && s.display !== 'none' && s.opacity !== '0'; };
const sel = '[role=dialog],[class*=modal],[class*=Modal],[class*=dialog],[class*=Dialog],[class*=verify],[class*=Verify],[id*=verify],[class*=captcha],[id*=captcha]';
const all = [...document.querySelectorAll(sel)].filter(vis).filter(d => !d.closest('#login-panel-new'));
const tops = all.filter(d => !all.some(o => o !== d && o.contains(d)));
"""

# 弹窗里能点的选项。抖音的选项是一整行可点的卡片（标题 + 小字说明，cursor 是手形，会继承给里面的字），
# 所以只要「最外层能点的」那一层，字取它的第一行（标题）。want 为空返回所有选项的字；
# 给了 want 就把那一项滚到看得见的地方，返回它正中间的坐标（拿真鼠标去点）
OPTIONS_JS = r"""
(want) => {
""" + DIALOGS_JS + r"""
  const clickable = el => !!el && (['BUTTON', 'A'].includes(el.tagName)
    || ['button', 'tab', 'menuitem', 'option', 'radio'].includes(el.getAttribute('role'))
    || getComputedStyle(el).cursor === 'pointer');
  // 卡片的标题：第一行像样的字（跳过图标字符、箭头这种）
  const firstLine = el => (el.innerText || '').split('\n').map(s => s.trim())
    .find(s => s.length >= 2 && /[\p{L}\p{N}]/u.test(s)) || '';
  const words = /(刷脸|人脸|扫脸|扫码|短信|验证|密码|手机|确定|确认|下一步|重新|刷新|发送|换一种|获取)/;
  const found = [];
  const add = (el, t) => { if (t.length >= 2 && t.length <= 12 && !found.some(f => f.t === t)) found.push({ el, t }); };
  for (const root of (tops.length ? tops : [document.body])) {
    for (const el of root.querySelectorAll('*')) {
      if (!vis(el) || !clickable(el)) continue;
      const parent = el.parentElement;
      if (parent && parent !== root && root.contains(parent) && clickable(parent)) continue;  // 只要最外层能点的
      const t = firstLine(el);
      if (!tops.length && !words.test(t)) continue;  // 没有弹窗时全页面找：只要和验证有关的
      add(el, t);
    }
  }
  if (!found.length) {  // 整个弹窗都是手形之类：退回找最里层、和验证有关的字
    for (const root of (tops.length ? tops : [document.body])) {
      for (const el of root.querySelectorAll('*')) {
        const t = (el.innerText || '').trim();
        if (!vis(el) || !t || t.includes('\n') || /^H[1-6]$/.test(el.tagName)
            || [...el.children].some(c => (c.innerText || '').trim() === t)) continue;
        if (words.test(t)) add(el, t);
      }
    }
  }
  if (want == null) return found.slice(0, 8).map(f => f.t);
  const hit = found.find(f => f.t === want) || found.find(f => f.t.includes(want) || want.includes(f.t));
  if (!hit) return null;
  hit.el.scrollIntoView({ block: 'center', inline: 'center' });
  const r = hit.el.getBoundingClientRect();
  return { x: r.x + r.width / 2, y: r.y + r.height / 2, text: hit.t };
}
"""

# 点了验证方式以后出现的二维码（刷脸用）：弹窗里最大的那个方形图片；登录二维码、头像（小）不算
QR_JS = r"""
() => {
""" + DIALOGS_JS + r"""
  let best = null;
  for (const root of (tops.length ? tops : [document.body])) {
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

# 弹窗里的字：点了以后看页面变没变
DIALOG_TEXT_JS = r"""
() => {
""" + DIALOGS_JS + r"""
  return tops.map(d => d.innerText || '').join('\n').slice(0, 2000);
}
"""


# 事件写进单独的文件（流式服务通过环境变量 DY_LOGIN_EVENTS 给路径，一直读它新增的行）。不能走标准输出：
# xvfb-run 会把标准错误并进标准输出，浏览器、Playwright 的日志会插进来；Playwright 的 Node 进程还会把这条
# 共用的管道设成非阻塞，写一张大截图时管道一满就只写进去一半（BlockingIOError），流式服务就认不出这条事件
EVENTS_PATH = os.environ.get('DY_LOGIN_EVENTS', '')


def emit(event, **kw):
    line = json.dumps({'event': event, **kw}, ensure_ascii=False) + '\n'
    if EVENTS_PATH:
        with open(EVENTS_PATH, 'a', encoding='utf-8') as f:
            f.write(line)
    else:  # 手动跑的时候看得见
        sys.stdout.write(line)
        sys.stdout.flush()


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
        return await page.locator(selector).filter(visible=True).count() > 0
    except Exception:  # noqa: BLE001
        return False


async def visible_text(page, words):
    """页面上看得见的第一个字样（同样的字可能有好几处、有的藏着，只要有一处看得见就算）"""
    for w in words:
        try:
            if await page.get_by_text(w, exact=False).filter(visible=True).count():
                return w
        except Exception:  # noqa: BLE001
            continue
    return ''


async def options(page):
    try:
        return await page.evaluate(OPTIONS_JS, None)
    except Exception:  # noqa: BLE001
        return []


async def dialog_text(page):
    try:
        return await page.evaluate(DIALOG_TEXT_JS)
    except Exception:  # noqa: BLE001
        return ''


async def find_qr(page):
    try:
        return await page.evaluate(QR_JS)
    except Exception:  # noqa: BLE001
        return None


# ── 诊断：点了选项以后页面里发生了什么（只给维护的人看，不发给频道主）──
TRACE = {'net': [], 'console': [], 'popups': []}
LAST_CLICK = {}
HIT_JS = r"""
([x, y]) => {
  const e = document.elementFromPoint(x, y);
  if (!e) return null;
  const chain = [];
  for (let n = e; n && chain.length < 6; n = n.parentElement)
    chain.push(n.tagName + '.' + String(n.className).slice(0, 60) + ' cursor=' + getComputedStyle(n).cursor);
  return chain;
}
"""


def trace(page):
    """记下抖音的请求、控制台、新窗口；只留最近的"""
    def keep(lst, item, n=60):
        lst.append(item)
        del lst[:-n]

    async def on_response(res):
        url = res.url
        if not re.search(r'douyin|bytedance|zijie|snssdk|amemv|byteimg', url) or re.search(r'\.(js|css|png|jpe?g|webp|woff2?|svg)(\?|$)', url):
            return
        body = ''
        if re.search(r'verify|passport|safe|risk|face|ticket|auth', url):
            try:
                body = (await res.text())[:400]
            except Exception:  # noqa: BLE001
                pass
        keep(TRACE['net'], {'t': round(time.time(), 1), 'status': res.status, 'url': url[:200], 'body': body})

    page.on('response', on_response)
    page.on('console', lambda m: keep(TRACE['console'], {'t': round(time.time(), 1), 'type': m.type, 'text': m.text[:300]}, 30))
    page.context.on('page', lambda p: keep(TRACE['popups'], {'t': round(time.time(), 1), 'url': p.url}, 10))


def debug(what, **kw):
    since = kw.pop('since', 0)
    emit('debug', what=what, net=[x for x in TRACE['net'] if x['t'] >= since],
         console=[x for x in TRACE['console'] if x['t'] >= since],
         popups=[x for x in TRACE['popups'] if x['t'] >= since], **kw)


async def click_option(page, text):
    """点弹窗里的一个选项：找到那张能点的卡片，滚到看得见，拿真鼠标点它正中间。返回点中的那项的字，没找到返回空"""
    try:
        pos = await page.evaluate(OPTIONS_JS, text)
    except Exception:  # noqa: BLE001
        pos = None
    if pos:
        try:
            hit = await page.evaluate(HIT_JS, [pos['x'], pos['y']])
        except Exception:  # noqa: BLE001
            hit = None
        LAST_CLICK.update(pos=pos, hit=hit)
        await page.mouse.click(pos['x'], pos['y'])
        return pos['text']
    try:  # 退回：按字找看得见的那一处点
        await page.get_by_text(text, exact=True).filter(visible=True).first.click(timeout=3000)
        return text
    except Exception:  # noqa: BLE001
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


async def show(page, text=''):
    emit('shot', text=text, options=await options(page), png=b64(await page.screenshot()))


# 点了一个验证方式以后最多等多久看页面变化、二维码出来（刷脸的二维码要从服务器取，慢）
CLICK_WAIT_S = 10


async def handle_input(ctx, page, text):
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
    if text == '调试':
        debug('调试', dialog=await dialog_text(page), options=await options(page))
        return False
    # 别的当成要点的字：验证方式（手机刷脸验证、接收短信验证码……）、确定、下一步……
    pages_before = len(ctx.pages)
    before = await dialog_text(page)
    t0 = round(time.time(), 1)
    LAST_CLICK.clear()
    clicked = await click_option(page, text)
    if not clicked:
        await show(page, f'页面上没找到「{text}」，现在是这样：')
        return True
    view, changed = page, False
    for _ in range(CLICK_WAIT_S * 2):
        await asyncio.sleep(0.5)
        if len(ctx.pages) > pages_before:  # 抖音新开了一个窗口：看新窗口
            view = ctx.pages[-1]
        box = await find_qr(view)
        if box:
            m = 12
            clip = {'x': max(0, box['x'] - m), 'y': max(0, box['y'] - m),
                    'width': box['width'] + 2 * m, 'height': box['height'] + 2 * m}
            await asyncio.sleep(0.8)  # 二维码图片画完
            emit('verify_qr', text=clicked, png=b64(await view.screenshot(clip=clip)))
            return True
        if view is not page or await dialog_text(page) != before:
            changed = True
            if re.search('短信|验证码', clicked):
                break  # 短信：页面一变就去点「获取验证码」
    if re.search('短信|验证码', clicked):
        for w in ('获取验证码', '发送验证码', '获取短信验证码'):
            try:
                await view.get_by_text(w).filter(visible=True).first.click(timeout=1500)
                break
            except Exception:  # noqa: BLE001
                continue
        await asyncio.sleep(1)
        await show(view, '短信验证码应该发到你手机上了，收到后直接把数字发给我。现在是这样：')
        return True
    debug(f'点了 {clicked}', since=t0, click=dict(LAST_CLICK), changed=changed, dialog=await dialog_text(view))
    await show(view, f'点了「{clicked}」，' + ('现在是这样（没看到二维码）：' if changed else '页面没有变化：'))
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
            shown = await handle_input(ctx, page, inputs.get_nowait()) or shown
        await page.wait_for_timeout(2000)
        if await page.locator('#captcha-verify-image').count() or '验证码中间页' in (await page.title()):
            emit('status', text='抖音弹了滑块验证，正在自动处理…')
            await solve_slider(ctx, page)
            continue
        # 先看是不是要再验证（扫完码以后登录二维码那块可能还在页面上，不能拿它判断扫没扫）。页面变了（选项不一样了）才再报一次
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
        trace(page)
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
