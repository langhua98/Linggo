"""快手扫码登录：和 dy_login.py 一样由流式服务用 xvfb-run + MediaCrawler 的 Python 环境启动，工作目录是 MediaCrawler。

用 MediaCrawler 自己的快手浏览器档案（browser_data/ks_user_data_dir），登录好以后 MediaCrawler 抓快手直接就是登录状态。
打开快手首页、点「登录」、把二维码截下来发给频道主，用快手 App 扫；要再验证（短信……）就跟抖音一样遥控：
整页截图和能点的选项发过去，频道主点哪个这里点哪个（这部分直接用 dy_login.py 的）。

海外机房打开快手常先弹「拼图滑块」（Please complete security verification / Drag to right to fill the puzzle），
远程没法替频道主拖，所以这里自己拖：在页面（含 iframe）里找背景图、拼图块、滑块按钮，OpenCV 找缺口，
像人一样拖过去；拖着不放的时候看拼图块实际到了哪儿再补一点，松手。不行就刷新再来，最多 SLIDER_TRIES 次。
还不行：把截图发给频道主，滑块那块的页面结构记成 debug 事件（/douyin/debug 看得到），好照着改。

事件和 dy_login.py 一样（一行一个 JSON，写进 DY_LOGIN_EVENTS 给的文件）；ok 里的 sec_uid 是快手的用户 id。
"""

import asyncio
import os
import re
import time

import base64
import random

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
SLIDER_TRIES = 6
SLIDER_WORDS = ('security verification', 'Drag to right', 'fill the puzzle', '拖动滑块', '向右拖动', '完成拼图', '安全验证')

# 在一个 frame 里找滑块的三样东西：背景图（最大的图/画布）、拼图块（叠在背景上的小图）、滑块按钮（背景下面、能拖的小块）
FIND_SLIDER_JS = r"""() => {
  const vis = el => { const r = el.getBoundingClientRect(); const s = getComputedStyle(el);
    return r.width > 4 && r.height > 4 && s.visibility !== 'hidden' && s.display !== 'none' && Number(s.opacity) > 0.05; };
  const box = el => { const r = el.getBoundingClientRect(); return { x: r.x, y: r.y, w: r.width, h: r.height }; };
  const pics = [...document.querySelectorAll('img, canvas')].filter(vis).map(el => ({ el, b: box(el) }));
  // 也有用 background-image 的 div
  for (const el of document.querySelectorAll('div, span')) {
    const bg = getComputedStyle(el).backgroundImage;
    if (bg && bg.startsWith('url(') && vis(el)) pics.push({ el, b: box(el), css: bg.slice(5, -2) });
  }
  const big = pics.filter(p => p.b.w >= 200 && p.b.h >= 80 && p.b.w <= 700).sort((a, b) => b.b.w * b.b.h - a.b.w * a.b.h)[0];
  if (!big) return null;
  const B = big.b;
  const inside = p => p !== big && p.b.w < B.w * 0.5 && p.b.h >= 20 && p.b.h <= B.h * 1.05 &&
    p.b.x >= B.x - 5 && p.b.x <= B.x + B.w && p.b.y >= B.y - 10 && p.b.y + p.b.h <= B.y + B.h + 10;
  const piece = pics.filter(inside).sort((a, b) => a.b.x - b.b.x)[0] || null;
  const handles = [...document.querySelectorAll('div, span, i, button')].filter(vis).filter(el => {
    const r = el.getBoundingClientRect();
    const cls = String(el.className || '') + ' ' + (el.getAttribute('role') || '');
    return r.y >= B.y + B.h - 5 && r.y <= B.y + B.h + 120 && r.x <= B.x + 80 && r.width >= 20 && r.width <= 90 && r.height >= 20 && r.height <= 90 &&
      (/slid|drag|btn|handle|move|arrow/i.test(cls) || /[>›»→]/.test(el.innerText || ''));
  }).sort((a, b) => a.getBoundingClientRect().x - b.getBoundingClientRect().x);
  const handle = handles[0];
  const src = p => p && (p.css || (p.el.tagName === 'IMG' ? p.el.currentSrc || p.el.src : (() => { try { return p.el.toDataURL('image/png'); } catch (e) { return ''; } })()));
  const natural = p => p && p.el.tagName === 'IMG' ? { w: p.el.naturalWidth, h: p.el.naturalHeight } : p && p.el.tagName === 'CANVAS' ? { w: p.el.width, h: p.el.height } : null;
  return { bg: { ...B, src: src(big), natural: natural(big) }, piece: piece && { ...piece.b, src: src(piece), natural: natural(piece) },
           handle: handle && box(handle) };
}"""
DUMP_JS = r"""() => {
  const words = /verification|puzzle|拖动|滑块|拼图|安全验证/i;
  let best = null;
  for (const el of document.querySelectorAll('div')) {
    if (words.test(el.innerText || '') && (!best || el.innerHTML.length < best.innerHTML.length) && el.innerHTML.length > 200) best = el;
  }
  return best ? best.outerHTML.replace(/data:image\/[^"')]{40,}/g, 'data:…').slice(0, 6000) : '';
}"""


async def slider_frame(page):
    """有滑块验证就返回它所在的 frame（可能在 iframe 里）"""
    for f in page.frames:
        try:
            text = await f.evaluate('() => document.body ? document.body.innerText : ""')
        except Exception:  # noqa: BLE001
            continue
        if any(w in text for w in SLIDER_WORDS):
            return f
    return None


async def fetch_image(ctx, src):
    """图片地址 → 字节（data: 直接解，http 的用浏览器的会话去取，不受跨域限制）"""
    if not src:
        return None
    if src.startswith('data:'):
        return base64.b64decode(src.split(',', 1)[1])
    r = await ctx.request.get(src)
    return await r.body() if r.ok else None


def gap_x(bg_bytes, piece_bytes):
    """背景图上缺口的左边在图里的横坐标（原图像素）。有拼图块就用模板匹配，没有就找背景上最显眼的竖直边"""
    import cv2
    import numpy as np
    bg = cv2.imdecode(np.frombuffer(bg_bytes, np.uint8), cv2.IMREAD_COLOR)
    if bg is None:
        return None
    bg_edges = cv2.Canny(cv2.cvtColor(bg, cv2.COLOR_BGR2GRAY), 100, 200)
    if piece_bytes:
        piece = cv2.imdecode(np.frombuffer(piece_bytes, np.uint8), cv2.IMREAD_UNCHANGED)
        if piece is not None:
            if piece.ndim == 3 and piece.shape[2] == 4:  # 透明底：只留不透明的部分
                alpha = piece[:, :, 3]
                ys, xs = np.where(alpha > 10)
                if len(xs):
                    piece = piece[ys.min():ys.max() + 1, xs.min():xs.max() + 1]
                piece = cv2.cvtColor(piece, cv2.COLOR_BGRA2BGR)
            tpl = cv2.Canny(cv2.cvtColor(piece, cv2.COLOR_BGR2GRAY), 100, 200)
            if tpl.shape[0] <= bg_edges.shape[0] and tpl.shape[1] <= bg_edges.shape[1]:
                res = cv2.matchTemplate(bg_edges, tpl, cv2.TM_CCOEFF_NORMED)
                # 拼图块一开始在最左边，缺口不会在那儿：左边一块不算
                skip = min(tpl.shape[1], res.shape[1] - 1)
                res[:, :skip] = -1
                return int(cv2.minMaxLoc(res)[3][0])
    cols = bg_edges.sum(axis=0).astype(float)
    cols[: bg_edges.shape[1] // 5] = 0
    return int(cols.argmax())


async def drag(page, handle, distance, piece_now, target_x):
    """按住滑块按钮，像人一样拖 distance 像素；拖完不松手，看拼图块到了哪儿，差多少补多少，再松手"""
    x0, y0 = handle['x'] + handle['w'] / 2, handle['y'] + handle['h'] / 2
    await page.mouse.move(x0 - 30, y0 + random.uniform(-8, 8))
    await page.mouse.move(x0, y0, steps=6)
    await page.mouse.down()
    moved, steps = 0.0, max(18, int(distance / 6))
    for i in range(1, steps + 1):
        t = i / steps
        ease = 1 - (1 - t) ** 3  # 先快后慢
        x = distance * ease + (random.uniform(-1.5, 1.5) if i < steps else 0)
        await page.mouse.move(x0 + x, y0 + random.uniform(-2, 2))
        moved = x
        await page.wait_for_timeout(random.randint(8, 25))
    await page.wait_for_timeout(300)
    for _ in range(3):  # 拼图块实际的位置可能和按钮不是一比一
        now = await piece_now()
        if now is None:
            break
        diff = target_x - now
        if abs(diff) <= 1.5:
            break
        moved += diff
        await page.mouse.move(x0 + moved, y0 + random.uniform(-1, 1), steps=4)
        await page.wait_for_timeout(250)
    await page.wait_for_timeout(random.randint(200, 400))
    await page.mouse.up()


async def solve_slider(ctx, page):
    """有滑块就自己拖过去；过了（或者根本没有）返回 True"""
    for attempt in range(SLIDER_TRIES):
        frame = await slider_frame(page)
        if not frame:
            return True
        if attempt == 0:
            emit('status', text='快手弹了拼图滑块验证，正在自动拖…')
        info = None
        for _ in range(10):  # 图片要加载一会儿
            try:
                info = await frame.evaluate(FIND_SLIDER_JS)
            except Exception:  # noqa: BLE001
                info = None
            if info and info.get('handle') and info['bg'].get('src'):
                break
            await page.wait_for_timeout(800)
        if not info or not info.get('handle'):
            break
        # frame 里的坐标换成整页的坐标
        off = {'x': 0, 'y': 0}
        if frame != page.main_frame:
            el = await frame.frame_element()
            fb = await el.bounding_box()
            off = {'x': fb['x'], 'y': fb['y']}
        bg, piece, handle = info['bg'], info.get('piece'), info['handle']
        handle = {**handle, 'x': handle['x'] + off['x'], 'y': handle['y'] + off['y']}
        bg_bytes = await fetch_image(ctx, bg['src'])
        piece_bytes = await fetch_image(ctx, piece['src']) if piece else None
        gx = gap_x(bg_bytes, piece_bytes) if bg_bytes else None
        if gx is None:
            break
        natural_w = (bg.get('natural') or {}).get('w') or bg['w']
        target = gx * bg['w'] / natural_w  # 缺口在背景上的横坐标（页面像素，相对背景左边）
        start = (piece['x'] - bg['x']) if piece else 0
        distance = max(5, target - start)

        async def piece_now():
            try:
                now = await frame.evaluate(FIND_SLIDER_JS)
            except Exception:  # noqa: BLE001
                return None
            p = now and now.get('piece')
            return p and (p['x'] - now['bg']['x'])
        await drag(page, handle, distance, piece_now if piece else (lambda: asyncio.sleep(0)), target)
        await page.wait_for_timeout(2500)
        if not await slider_frame(page):
            emit('status', text='拼图滑块过了')
            return True
        for w in ('刷新', '换一张', 'Refresh', 'refresh'):  # 没过：换一张再来
            try:
                await frame.get_by_text(w).first.click(timeout=1000)
                break
            except Exception:  # noqa: BLE001
                continue
        await page.wait_for_timeout(1500)
    frame = await slider_frame(page)
    if not frame:
        return True
    try:
        html = await frame.evaluate(DUMP_JS)
    except Exception:  # noqa: BLE001
        html = ''
    emit('debug', what='ks_slider', frames=[f.url[:200] for f in page.frames], html=html)
    return False


def net_diag():
    """打不开快手首页时看看是哪一步不通：本机的出口 IP；www 和 id 两个域名各自 TCP 连不连得上、TLS 握手过不过。
    www 握手不回、id 好好的 = 快手按 IP 拦了这台机器"""
    import socket
    import ssl
    import urllib.request
    lines = []
    try:
        req = urllib.request.Request('https://api.ipify.org', headers={'User-Agent': 'xiaoju-video'})
        lines.append('出口 IP ' + urllib.request.urlopen(req, timeout=8).read().decode()[:40])
    except Exception as e:  # noqa: BLE001
        lines.append(f'出口 IP 查不到（{type(e).__name__}）')
    for host in ('www.kuaishou.com', 'id.kuaishou.com'):
        try:
            ip = socket.getaddrinfo(host, 443, socket.AF_INET)[0][4][0]
        except Exception as e:  # noqa: BLE001
            lines.append(f'{host}：解析不了（{type(e).__name__}）')
            continue
        try:
            sock = socket.create_connection((ip, 443), timeout=8)
        except Exception as e:  # noqa: BLE001
            lines.append(f'{host}（{ip}）：TCP 连不上（{type(e).__name__}）')
            continue
        try:
            with ssl.create_default_context().wrap_socket(sock, server_hostname=host) as t:
                t.settimeout(8)
                t.sendall(f'GET / HTTP/1.1\r\nHost: {host}\r\nUser-Agent: Mozilla/5.0\r\nConnection: close\r\n\r\n'.encode())
                head = t.recv(64).decode('latin1').split('\r\n')[0]
            lines.append(f'{host}（{ip}）：通，{head}')
        except Exception as e:  # noqa: BLE001
            lines.append(f'{host}（{ip}）：TCP 通，TLS 握手不过（{type(e).__name__}）')
    return '\n'.join(lines)


async def page_ready(page):
    """快手首页能用了没有：页面上有「登录」按钮，或者已经登录（有头像、用户菜单）"""
    try:
        return await page.evaluate(r"""() => !!document.body && /登录|快手/.test(document.body.innerText || '')""")
    except Exception:  # noqa: BLE001 — 页面在跳转
        return False


async def open_index(page):
    """打开快手首页。不等「整页加载完」：快手首页上有些资源一直加载不完，浏览器最后报 ERR_TIMED_OUT，
    但页面其实早就能用了。所以只等服务器开始回页面（commit），然后看页面上出没出来「登录」这些字。
    真打不开（页面一直是空的）才抛出去，带上网络诊断"""
    last = None
    for _ in range(3):
        try:
            await page.goto(INDEX, wait_until='commit', timeout=45000)
        except Exception as e:  # noqa: BLE001 — 报错了也看看页面是不是其实出来了
            last = e
        for _ in range(30):
            if await page_ready(page):
                return
            await page.wait_for_timeout(1000)
    diag = await asyncio.to_thread(net_diag)
    why = str(last).splitlines()[0][:120] if last else '页面一直是空的'
    raise RuntimeError(f'打不开快手首页（试了 3 次）：{why}\n网络诊断：\n{diag}')


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
        await open_index(page)
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
    if not await solve_slider(ctx, page):
        emit('error', text='快手弹了拼图滑块验证，自动拖了几次没过。过一会儿再发「登录快手」试试。', png=b64(await page.screenshot()))
        return False
    await open_panel(page)
    await page.wait_for_timeout(1500)
    if not await solve_slider(ctx, page):  # 点了「登录」才弹的
        emit('error', text='快手弹了拼图滑块验证，自动拖了几次没过。过一会儿再发「登录快手」试试。', png=b64(await page.screenshot()))
        return False
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
        if await slider_frame(page):
            if not await solve_slider(ctx, page):
                emit('error', text='快手弹了拼图滑块验证，自动拖了几次没过。过一会儿再发「登录快手」试试。', png=b64(await page.screenshot()))
                return False
            continue
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
            await open_index(page)
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
            emit('error', text=str(e)[:900] if isinstance(e, RuntimeError) else f'{type(e).__name__}: {str(e)[:200]}', png=png)
        finally:
            await ctx.close()


if __name__ == '__main__':
    asyncio.run(main())
