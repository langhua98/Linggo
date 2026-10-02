"""用无头浏览器打开抖音网页版拿数据，不登录。

抖音网页的接口要带签名（a_bogus 等），算法藏在页面的安全脚本里、经常换。所以这里不自己算签名：
打开抖音的网页，等它的安全脚本准备好，在页面里用 fetch 调接口——安全脚本会给请求自动签名，
和一个没登录的人用浏览器看主页时一样。

抖音有风控：同一个地方短时间里来了太多「新访客」，接口就返回空（HTTP 200、内容为空），或者弹滑块验证、
请求挂着不回。所以 cookie 存下来下次接着用（像同一个人隔一阵又来看看，而不是每次都是新访客）；每次调用
都有超时；拿不到就算这次没拿到（Blocked），不去碰验证码。"""

import asyncio
import json
import logging
import os
import re

from .items import normalize

log = logging.getLogger('streamer.douyin')

STATE_FILE = '/tmp/douyin-state.json'
UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/{major}.0.0.0 Safari/537.36'
# 网页版自己调接口时带的固定参数（版本号随网页更新，旧的也照样能用）
BASE = {'device_platform': 'webapp', 'aid': '6383', 'channel': 'channel_pc_web', 'pc_client_type': '1',
        'version_code': '290100', 'version_name': '29.1.0', 'cookie_enabled': 'true', 'platform': 'PC', 'downlink': '10'}
CALL_JS = """async ({path, params}) => {
  const r = await fetch(path + '?' + new URLSearchParams(params), {credentials: 'include'});
  return {status: r.status, text: await r.text()};
}"""
MAX_VIDEO_BYTES = 300 * 1024 * 1024
# 页面去取滑块验证码的请求：出现了就说明这次被风控拦了（不去做验证码）
CAPTCHA = re.compile(r'verify\.zijieapi\.com/captcha/get|/verifycenter/captcha/v\d')
CAPTCHA_MSG = '抖音弹了滑块验证（风控）'
_NOTHING = object()


async def _first(main, other=None, timeout=None):
    """等 main 的结果；other 先完成、或者超时 → _NOTHING。main 没完成就取消（是 future 的话不取消，留着以后用）"""
    main_t = main if isinstance(main, asyncio.Future) else asyncio.ensure_future(main)
    tasks = [main_t] + ([asyncio.ensure_future(other)] if other is not None else [])
    try:
        done, _ = await asyncio.wait(tasks, timeout=timeout, return_when=asyncio.FIRST_COMPLETED)
    finally:
        for t in tasks[1:]:
            t.cancel()
    if main_t in done:
        return main_t.result()
    if main_t is not main:
        main_t.cancel()
    return _NOTHING


class Blocked(Exception):
    """抖音这次没给数据：接口返回空、一直不回，或者网页打不开。过一会儿再试。"""


class Gone(Exception):
    """这条作品看不了：删了、设了私密，或者作品号不对。"""


class DownloadError(Exception):
    pass


class DouyinWeb:
    """async with DouyinWeb() as w: item = await w.detail(作品号); data, src = await w.download(item)"""

    def __init__(self, state_file=STATE_FILE, warmup=10.0, tries=4, gap=4.0, call_timeout=20, extra_args=()):
        self.state_file, self.warmup, self.tries, self.gap, self.call_timeout = state_file, warmup, tries, gap, call_timeout
        self.extra_args = list(extra_args)
        self.pw = self.browser = self.ctx = None

    async def __aenter__(self):
        from playwright.async_api import async_playwright
        self.pw = await async_playwright().start()
        try:
            # channel='chromium'：用完整版 Chromium 的新无头模式（更像真浏览器），不用精简的 headless shell
            # /dev/shm 在容器里往往很小，Chromium 用它会崩：改用 /tmp
            self.browser = await self.pw.chromium.launch(channel='chromium', headless=True,
                                                         args=['--disable-blink-features=AutomationControlled', '--disable-dev-shm-usage',
                                                               *self.extra_args])
            self.ctx = await self._context()
        except BaseException:
            await self.close()
            raise
        return self

    async def _context(self):
        opts = dict(user_agent=UA.format(major=self.browser.version.split('.')[0]), locale='zh-CN',
                    timezone_id='Asia/Shanghai', viewport={'width': 1366, 'height': 900})
        try:
            ctx = await self.browser.new_context(storage_state=self.state_file if os.path.exists(self.state_file) else None, **opts)
        except Exception:  # noqa: BLE001 — 存的 cookie 文件坏了：当新访客
            log.warning('bad douyin state file, starting fresh')
            os.remove(self.state_file)
            ctx = await self.browser.new_context(**opts)
        await ctx.add_init_script("Object.defineProperty(navigator, 'webdriver', {get: () => undefined})")
        return ctx

    async def __aexit__(self, *exc):
        if self.ctx is not None:
            try:  # 存下 cookie，下次接着当同一个访客
                await asyncio.wait_for(self.ctx.storage_state(path=self.state_file), 10)
            except Exception:  # noqa: BLE001
                log.warning('could not save douyin state')
        await self.close()

    async def close(self):
        if self.browser is not None:
            try:
                await asyncio.wait_for(self.browser.close(), 15)
            except Exception:  # noqa: BLE001
                pass
        if self.pw is not None:
            await self.pw.stop()
        self.pw = self.browser = self.ctx = None

    async def fetch(self, url, path, params, match):
        """打开网页 url，拿接口 path 的数据。网页打开时自己就会调这个接口：它拿到了就用它的（不多发请求，
        风控最松）；它没调、拿到空的，再自己在页面里调。match(网址) 认出是不是我们要的那次调用。"""
        got = asyncio.get_running_loop().create_future()
        captcha = asyncio.Event()  # 页面去要滑块验证码了：接口不会再给数据，不用干等

        async def on_response(res):
            if CAPTCHA.search(res.url):
                captcha.set()
            if got.done() or path not in res.url or not match(res.url):
                return
            try:
                data = json.loads(await res.text())
            except Exception:  # noqa: BLE001 — 空的、不是 JSON、页面已关
                return
            if not got.done():
                got.set_result(data)

        page = await self.ctx.new_page()
        page.on('response', on_response)
        try:
            try:
                await page.goto(url, wait_until='domcontentloaded', timeout=45000)
            except Exception as e:  # noqa: BLE001
                raise Blocked(f'打不开抖音网页（{type(e).__name__}）') from e
            # 先等网页自己的那次（等到了、或者页面要验证码了就不再等）
            await _first(got, captcha.wait(), timeout=self.warmup)
            for i in range(self.tries):
                if got.done():
                    return got.result()
                if captcha.is_set():
                    raise Blocked(CAPTCHA_MSG)
                data = await self.call(page, path, params, abort=captcha)
                if data is not None:
                    return data
                if i < self.tries - 1:
                    await _first(got, captcha.wait(), timeout=self.gap)
            if got.done():
                return got.result()
            raise Blocked(CAPTCHA_MSG if captcha.is_set() else '抖音没给数据（多半是风控）')
        finally:
            await page.close()

    async def call(self, page, path, params, abort=None):
        """在页面里调一次接口。返回 JSON；空的（风控、安全脚本还没好）返回 None；
        挂着不回、或者等的时候页面要验证码了（abort）→ Blocked。"""
        try:
            r = await _first(page.evaluate(CALL_JS, {'path': path, 'params': {**BASE, **params}}),
                             abort.wait() if abort else None, timeout=self.call_timeout)
        except Exception:  # noqa: BLE001 — 安全验证后页面会自己刷新一次，刷新时 evaluate 会失败，再试就好
            return None
        if r is _NOTHING:
            raise Blocked(CAPTCHA_MSG if abort and abort.is_set() else '抖音接口一直没回（多半是风控）')
        if r.get('status') != 200 or not r.get('text'):
            return None
        try:
            return json.loads(r['text'])
        except ValueError:
            return None

    async def detail(self, aweme_id):
        data = await self.fetch(f'https://www.douyin.com/video/{aweme_id}', '/aweme/v1/web/aweme/detail/',
                                {'aweme_id': aweme_id}, match=lambda u: f'aweme_id={aweme_id}' in u)
        a = data.get('aweme_detail')
        if not a:
            why = (data.get('filter_detail') or {}).get('detail_msg') or ''
            raise Gone(why or '这条作品看不了（可能删了或设了私密）')
        return normalize(a)

    async def download(self, item, max_bytes=MAX_VIDEO_BYTES):
        """按 video_sources 的顺序一个个试，返回视频文件的字节和用的是哪一档"""
        last = '没有下载地址'
        for src in item['sources']:
            if src['size'] and src['size'] > max_bytes:
                last = '视频太大'
                continue
            for url in src['urls']:
                try:
                    r = await self.ctx.request.get(url, headers={'Referer': 'https://www.douyin.com/'}, timeout=180000)
                except Exception as e:  # noqa: BLE001
                    last = type(e).__name__
                    continue
                try:
                    kind = r.headers.get('content-type', '')
                    if r.status != 200 or not (kind.startswith('video/') or kind.startswith('application/octet-stream')):
                        last = f'HTTP {r.status} {kind}'.strip()
                        continue
                    if int(r.headers.get('content-length') or 0) > max_bytes:
                        last = '视频太大'
                        continue
                    data = await r.body()
                finally:
                    await r.dispose()
                if len(data) < 10 * 1024 or len(data) > max_bytes:
                    last = f'文件大小不对（{len(data)} 字节）'
                    continue
                return data, src
        raise DownloadError(last)
