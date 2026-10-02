"""用无头浏览器打开抖音网页版拿数据，不登录。

抖音网页的接口要带签名（a_bogus 等），算法藏在页面的安全脚本里、经常换。所以这里不自己算签名：
打开抖音的网页，等它的安全脚本准备好，在页面里用 fetch 调接口——安全脚本会给请求自动签名，
和一个没登录的人用浏览器看主页时一样。

抖音有风控：同一个地方短时间里来了太多「新访客」，接口就返回空（HTTP 200、内容为空），或者弹滑块验证、
请求挂着不回。所以 cookie 存下来下次接着用（像同一个人隔一阵又来看看，而不是每次都是新访客）；每次调用
都有超时；拿不到就算这次没拿到（Blocked），不去碰验证码。"""

import asyncio
import contextlib
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
# 作品列表接口的参数（网页版主页自己调的时候就带这些）；翻页改 max_cursor
POST_PARAMS = {'locate_query': 'false', 'show_live_replay_strategy': '1', 'need_time_list': '1', 'time_list_query': '0',
               'whale_cut_token': '', 'cut_version': '1', 'publish_video_strategy_type': '2'}
CALL_JS = """async ({path, params}) => {
  const r = await fetch(path + '?' + new URLSearchParams(params), {credentials: 'include'});
  return {status: r.status, text: await r.text()};
}"""
MAX_VIDEO_BYTES = 300 * 1024 * 1024
MAX_IMAGE_BYTES = 10 * 1024 * 1024  # Telegram 照片的上限
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


class Tab:
    """一个打开着的抖音网页。取数据时先看网页自己调接口拿到的（不多发请求，风控最松），没有再自己在页面里调。"""

    def __init__(self, web, page, watch=()):
        self.web, self.page, self.watch = web, page, list(watch)
        self.captcha = asyncio.Event()  # 页面去要滑块验证码了：接口不会再给数据，不用干等
        self.got = []  # [(网址, JSON)]：网页自己调 watch 里那些接口拿到的（空的、不是 JSON 的不算）

    async def on_response(self, res):
        if CAPTCHA.search(res.url):
            self.captcha.set()
        if not any(p in res.url for p in self.watch):
            return
        try:
            data = json.loads(await res.text())
        except Exception:  # noqa: BLE001 — 空的、不是 JSON、页面已关
            return
        self.got.append((res.url, data))

    def _found(self, path, match):
        return next((d for u, d in self.got if path in u and match(u)), None) if match else None

    async def get(self, path, params, match=None):
        """match(网址) 认出网页自己的那次调用：给了就先等它一会儿（warmup 秒）；不给就直接自己调"""
        loop = asyncio.get_running_loop()
        deadline = loop.time() + (self.web.warmup if match else 0)
        while loop.time() < deadline and not self.captcha.is_set():
            data = self._found(path, match)
            if data is not None:
                return data
            await asyncio.sleep(0.5)
        for i in range(self.web.tries):
            data = self._found(path, match)
            if data is not None:
                return data
            if self.captcha.is_set():
                raise Blocked(CAPTCHA_MSG)
            data = await self.web.call(self.page, path, params, abort=self.captcha)
            if data is not None:
                return data
            if i < self.web.tries - 1:
                await asyncio.sleep(self.web.gap)
        data = self._found(path, match)
        if data is not None:
            return data
        raise Blocked(CAPTCHA_MSG if self.captcha.is_set() else '抖音没给数据（多半是风控）')


class DouyinWeb:
    """async with DouyinWeb() as w: items, info = await w.posts(sec_uid)；item = await w.detail(作品号)；
    data, src = await w.download(item)（视频）；images = await w.download_images(item)（图文）"""

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

    @contextlib.asynccontextmanager
    async def tab(self, url, watch=()):
        """打开一个抖音网页，在它关掉之前可以连着调好几次接口（翻页时不用每页重开一次网页）"""
        page = await self.ctx.new_page()
        t = Tab(self, page, watch)
        page.on('response', t.on_response)
        try:
            try:
                await page.goto(url, wait_until='domcontentloaded', timeout=45000)
            except Exception as e:  # noqa: BLE001
                raise Blocked(f'打不开抖音网页（{type(e).__name__}）') from e
            yield t
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

    async def posts(self, sec_uid, limit=300):
        """这个账号的作品（新的在前、置顶的在最前），最多 limit 条 → (作品列表, info)。
        没登录时抖音只给看一部分，info 里如实报出来（2026 年 10 月实测）：
          hidden_newest：最新的几条被藏起来了（返回里带 not_login_module，「登录看更多最新作品」）
          truncated：还有更早的作品，但第二页起返回空的 {"status_code": 0}——没登录只给看第一页（18 条）"""
        path = '/aweme/v1/web/aweme/post/'
        params = {**POST_PARAMS, 'sec_user_id': sec_uid, 'count': '18'}
        items, seen, info = [], set(), {'hidden_newest': False, 'truncated': False}
        async with self.tab(f'https://www.douyin.com/user/{sec_uid}', watch=[path]) as t:
            # 第一页：网页自己会调，先看它拿到的
            data = await t.get(path, {**params, 'max_cursor': '0'},
                               match=lambda u: f'sec_user_id={sec_uid}' in u and 'max_cursor=0' in u)
            while True:
                if data.get('status_code') not in (0, None):
                    raise Blocked(f'抖音返回错误 {data.get("status_code")}')
                if (data.get('not_login_module') or {}).get('guide_login_tip_exist'):
                    info['hidden_newest'] = True
                for a in data.get('aweme_list') or []:
                    if a.get('aweme_id') and str(a['aweme_id']) not in seen:
                        seen.add(str(a['aweme_id']))
                        items.append(normalize(a))
                cursor = data.get('max_cursor')
                if not data.get('has_more') or not cursor or len(items) >= limit:
                    break
                await asyncio.sleep(self.gap)  # 慢慢翻，像人往下滑
                try:
                    data = await t.get(path, {**params, 'max_cursor': str(cursor)})
                except Blocked:
                    data = {}
                if not data.get('aweme_list'):  # 后面的页不给：已经拿到的照样算
                    info['truncated'] = True
                    break
        return items[:limit], info

    async def detail(self, aweme_id):
        path = '/aweme/v1/web/aweme/detail/'
        async with self.tab(f'https://www.douyin.com/video/{aweme_id}', watch=[path]) as t:
            data = await t.get(path, {'aweme_id': aweme_id}, match=lambda u: f'aweme_id={aweme_id}' in u)
        a = data.get('aweme_detail')
        if not a:
            why = (data.get('filter_detail') or {}).get('detail_msg') or ''
            raise Gone(why or '这条作品看不了（可能删了或设了私密）')
        return normalize(a)

    async def _get_file(self, urls, kinds, min_bytes, max_bytes):
        """几个 CDN 地址一个个试，拿到内容类型对得上、大小合理的文件 → (字节, None)；都不行 → (None, 最后一个原因)"""
        last = '没有下载地址'
        for url in urls:
            try:
                r = await self.ctx.request.get(url, headers={'Referer': 'https://www.douyin.com/'}, timeout=180000)
            except Exception as e:  # noqa: BLE001
                last = type(e).__name__
                continue
            try:
                kind = r.headers.get('content-type', '')
                if r.status != 200 or not kind.startswith(kinds):
                    last = f'HTTP {r.status} {kind}'.strip()
                    continue
                if int(r.headers.get('content-length') or 0) > max_bytes:
                    last = '文件太大'
                    continue
                data = await r.body()
            finally:
                await r.dispose()
            if len(data) < min_bytes or len(data) > max_bytes:
                last = f'文件大小不对（{len(data)} 字节）'
                continue
            return data, None
        return None, last

    async def download(self, item, max_bytes=MAX_VIDEO_BYTES):
        """视频：按 video_sources 的顺序一档档试 → (视频的字节, 用的是哪一档)"""
        last = '没有下载地址'
        for src in item['sources']:
            if src['size'] and src['size'] > max_bytes:
                last = '文件太大'
                continue
            data, why = await self._get_file(src['urls'], ('video/', 'application/octet-stream'), 10 * 1024, max_bytes)
            if data is not None:
                return data, src
            last = why
        raise DownloadError(last)

    async def download_images(self, item, max_bytes=MAX_IMAGE_BYTES):
        """图文：每张图 → [字节]，按原来的顺序。有一张拿不到就整条不转（免得发出去缺图）"""
        out = []
        for n, img in enumerate(item['images'], 1):
            data, why = await self._get_file(img['urls'], ('image/', 'application/octet-stream'), 1024, max_bytes)
            if data is None:
                raise DownloadError(f'第 {n} 张图下载不了（{why}）')
            out.append(data)
        if not out:
            raise DownloadError('这条图文没有图')
        return out
