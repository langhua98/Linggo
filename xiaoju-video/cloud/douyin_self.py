"""小橘视频 · 云电脑：同步频道主自己抖音账号的全部作品

在 GitHub Codespaces（.devcontainer/xiaoju-video）里跑。用真的 Chromium 登录你自己的抖音账号（扫码），
打开「我的作品」页一路往下翻，把网页自己请求到的作品数据（/aweme/v1/web/aweme/post/）收下来，
问 Worker 哪些已经收过（/dy-known），新的送过去（/dy-import），Worker 再交审核机器人。

只打开 douyin.com/user/self —— 登录账号自己的主页，抓不到别人的作品。

  python douyin_self.py setup <Worker 地址> <令牌>   令牌在小橘视频机器人里发「云电脑」拿
  python douyin_self.py login                       在网页桌面（端口 6080）里扫码登录抖音
  python douyin_self.py sync                        同步
"""

import asyncio
import json
import os
import sys
import time
import urllib.request

sys.path.insert(0, os.path.join(os.path.dirname(os.path.abspath(__file__)), '..', 'streamer'))
from douyin import DouyinError, to_item  # noqa: E402

HOME = os.path.expanduser('~/.xiaoju-video')
CONFIG = os.path.join(HOME, 'config.json')
PROFILE = os.path.join(HOME, 'profile')
POST_API = '/aweme/v1/web/aweme/post/'
SELF_PAGE = 'https://www.douyin.com/user/self?showTab=post'
BATCH = 100
# 连续翻这么多次都没有新作品，就当翻到底了
IDLE_SCROLLS = 12
LOGIN_WAIT_S = 10 * 60


def load_config():
    try:
        with open(CONFIG) as f:
            return json.load(f)
    except FileNotFoundError:
        sys.exit('还没设置：先运行 run.sh setup <Worker 地址> <令牌>（在小橘视频机器人里发「云电脑」拿）')


def worker_call(cfg, path, body):
    req = urllib.request.Request(cfg['worker'].rstrip('/') + path, data=json.dumps(body).encode(), method='POST',
                                 headers={'Content-Type': 'application/json', 'X-Token': cfg['token'],
                                          'User-Agent': 'xiaoju-video-cloud'})
    try:
        with urllib.request.urlopen(req, timeout=60) as r:
            return json.loads(r.read() or b'{}')
    except urllib.error.HTTPError as e:
        if e.code == 403:
            sys.exit('Worker 不认这个令牌：在机器人里重新发「云电脑」，再运行一次 setup')
        raise


def best_play(raw):
    """网页版接口给好几档码率：挑最高的那档的地址放进 play_addr（to_item 只看 play_addr）"""
    video = raw.get('video') or {}
    rates = [b for b in (video.get('bit_rate') or []) if (b.get('play_addr') or {}).get('url_list')]
    if rates:
        best = max(rates, key=lambda b: b.get('bit_rate') or 0)
        raw = {**raw, 'video': {**video, 'play_addr': best['play_addr']}}
    return raw


def items_from(payloads):
    """收到的作品列表接口响应 → 作品字典，按作品号去重；转不了的（直播回放之类）跳过"""
    seen, items = set(), []
    for p in payloads:
        for raw in (p or {}).get('aweme_list') or []:
            try:
                item = to_item(best_play(raw))
            except DouyinError:
                continue
            if item['aweme'] not in seen:
                seen.add(item['aweme'])
                items.append(item)
    return items


def push(cfg, items, report=print):
    """问 Worker 哪些收过，新的分批送过去；返回送过去被收下的条数"""
    total = len(items)
    known = set()
    for i in range(0, total, 1000):
        known |= set(worker_call(cfg, '/dy-known', {'ids': [x['aweme'] for x in items[i:i + 1000]]}).get('known') or [])
    fresh = [x for x in items if x['aweme'] not in known]
    report(f'一共 {total} 条，Worker 已经有 {len(known)} 条，新的 {len(fresh)} 条')
    added = 0
    for i in range(0, len(fresh), BATCH):
        r = worker_call(cfg, '/dy-import', {'items': fresh[i:i + BATCH]})
        added += r.get('added', 0)
        worker_call(cfg, '/dy-progress', {'stage': '送 Worker', 'done': min(i + BATCH, len(fresh)), 'total': len(fresh)})
    worker_call(cfg, '/dy-progress', {'stage': '完成', 'done': added, 'total': total,
                                      'note': f'新送 {added} 条，已有 {len(known)} 条'})
    return added


async def browser(p, headless):
    os.makedirs(PROFILE, exist_ok=True)
    return await p.chromium.launch_persistent_context(
        PROFILE, headless=headless, locale='zh-CN', viewport={'width': 1280, 'height': 900},
        args=['--disable-blink-features=AutomationControlled'])


def has_display():
    return bool(os.environ.get('DISPLAY'))


async def login():
    from playwright.async_api import async_playwright
    if not has_display():
        sys.exit('没有图形桌面：要在 Codespaces 的网页桌面里扫码（.devcontainer/xiaoju-video 自带，端口 6080）')
    async with async_playwright() as p:
        ctx = await browser(p, headless=False)
        page = ctx.pages[0] if ctx.pages else await ctx.new_page()
        await page.goto('https://www.douyin.com/', wait_until='domcontentloaded')
        print('打开端口 6080 的网页桌面（密码 vscode），在浏览器里点「登录」，用抖音 App 扫码。等你登录……')
        deadline = time.time() + LOGIN_WAIT_S
        while time.time() < deadline:
            if any(c['name'] == 'sessionid' and c['value'] for c in await ctx.cookies('https://www.douyin.com')):
                print('登录好了。现在可以运行 run.sh sync')
                await ctx.close()
                return
            await asyncio.sleep(3)
        await ctx.close()
        sys.exit('10 分钟内没登录上，再运行一次 login')


async def collect(report=print):
    from playwright.async_api import async_playwright
    payloads = []
    state = {'more': True}
    async with async_playwright() as p:
        ctx = await browser(p, headless=not has_display())
        if not any(c['name'] == 'sessionid' for c in await ctx.cookies('https://www.douyin.com')):
            await ctx.close()
            sys.exit('还没登录抖音：先运行 run.sh login')
        page = ctx.pages[0] if ctx.pages else await ctx.new_page()

        async def on_response(res):
            if POST_API not in res.url or res.status != 200:
                return
            try:
                data = await res.json()
            except Exception:  # noqa: BLE001 — 偶尔有空响应
                return
            payloads.append(data)
            state['more'] = bool(data.get('has_more'))

        page.on('response', on_response)
        await page.goto(SELF_PAGE, wait_until='domcontentloaded')
        await page.wait_for_timeout(6000)
        idle, last = 0, -1
        while state['more'] and idle < IDLE_SCROLLS:
            await page.mouse.wheel(0, 4000)
            await page.keyboard.press('End')
            await page.wait_for_timeout(1500)
            n = sum(len(x.get('aweme_list') or []) for x in payloads)
            idle = idle + 1 if n == last else 0
            if n != last:
                report(f'已经翻到 {n} 条')
            last = n
        await ctx.close()
    return payloads


def main(argv):
    if len(argv) >= 2 and argv[1] == 'setup':
        if len(argv) != 4 or not argv[2].startswith('https://'):
            sys.exit('用法：run.sh setup <Worker 地址> <令牌>')
        os.makedirs(HOME, exist_ok=True)
        with open(CONFIG, 'w') as f:
            json.dump({'worker': argv[2], 'token': argv[3]}, f)
        os.chmod(CONFIG, 0o600)
        worker_call(load_config(), '/dy-progress', {'stage': '已连上'})
        print('设置好了，Worker 认这个令牌。下一步：run.sh login')
        return
    if len(argv) == 2 and argv[1] == 'login':
        asyncio.run(login())
        return
    if len(argv) == 2 and argv[1] == 'sync':
        cfg = load_config()
        worker_call(cfg, '/dy-progress', {'stage': '抓作品'})
        items = items_from(asyncio.run(collect()))
        if not items:
            worker_call(cfg, '/dy-progress', {'stage': '完成', 'note': '一条作品也没抓到'})
            sys.exit('一条作品也没抓到：确认登录的是你自己的账号，页面没弹验证码（网页桌面里看得到）')
        added = push(cfg, items)
        print(f'送过去 {added} 条，去审核机器人 @xiaojuverify_bot 里点「全部通过」或逐条审核')
        return
    sys.exit(__doc__)


if __name__ == '__main__':
    main(sys.argv)
