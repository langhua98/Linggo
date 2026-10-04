"""改 MediaCrawler（参数是它的目录）：

1. config/base_config.py：不连本机 Chrome（CDP），用 Playwright 自带的 Chromium；有界面（服务器上跑在 Xvfb 虚拟屏幕里，
   云电脑上跑在网页桌面里）；不抓评论；保存登录状态。
2. media_platform/douyin/core.py：打开抖音首页只等页面骨架出来（domcontentloaded），最多 60 秒。默认等整页 load，
   抖音首页一直在加载视频，30 秒等不到就超时退出（关键词搜索第一次就死在这）。
3. main.py 最前面 import xiaoju_retry（这里写进去的）：页面在跳转时读页面（page.evaluate）会报「Execution context was
   destroyed」直接退出——抖音首页打开后自己还会再跳一次，MediaCrawler 读 localStorage、算签名的地方都会撞上。改成等新页面出来再读
4. media_platform/douyin/core.py：用 cookie 登录时，打开抖音之前先把 cookie 放进浏览器。它原来是发现没登录才去点页面上的
   「登录」按钮、弹出登录框后再塞 cookie；Space 重启后浏览器档案是空的，页面上又找不到那个按钮，等 30 秒就退出了。
   media_platform/douyin/login.py：点不到「登录」按钮不再直接退出（cookie 已经放进去了）。
   client.py、login.py 判断「已登录」：有 sessionid cookie 也算（它只认 LOGIN_STATUS=1 和 localStorage，
   扫码登录存下的 cookie 里没有 LOGIN_STATUS，空的浏览器档案里也没有 localStorage）。
5. store/douyin/__init__.py：作品记录里多存作者的 sec_uid 和昵称（它默认把昵称打码、作者只存散列）——
   关键词搜索出来的作品要交频道主审核，他得认得出是不是自己小号发的。
6. media_platform/douyin/media.py：视频地址挑最高清的一档。它原来先拿 play_addr_h264（默认播放档，常常不是最高清），
   bit_rate（各档清晰度的列表）只在前面都没有时才兜底。改成先从 bit_rate 里挑：分辨率最高；一样高的先要 H.264
   （哪里都能播），再比码率。bit_rate 里没有能用的再按它原来的顺序。
7. 快手（store/kuaishou/__init__.py）：作品记录里多存作者 id、昵称（认小号用），和最高清那档的视频地址 best_play_url
   （它原来只存 photoUrl，默认档）——从 videoResource.h264/hevc、manifest 的各档里挑分辨率最高的，一样高先要 H.264。
   media_platform/kuaishou/core.py：打开快手首页只等页面骨架（domcontentloaded），最多 60 秒，免得一直加载视频等到超时。

  python mc_patch.py <MediaCrawler 目录>
"""

import os
import re
import sys

SETTINGS = {'ENABLE_CDP_MODE': 'False', 'HEADLESS': 'False', 'ENABLE_GET_COMMENTS': 'False', 'SAVE_LOGIN_STATE': 'True'}
STORE_ANCHOR = '"source_keyword": source_keyword_var.get(),'
STORE_EXTRA = ('"author_sec_uid": user_info.get("sec_uid", ""),  # 小橘视频：审核时认账号\n'
               '        "author_nickname": user_info.get("nickname", ""),')


def patch(text):
    for k, v in SETTINGS.items():
        text, n = re.subn(rf'^{k} = .*$', f'{k} = {v}', text, flags=re.M)
        if n != 1:
            raise SystemExit(f'MediaCrawler 配置里找不到 {k}（上游改了格式？）')
    return text


MEDIA_ANCHOR = '    for key in _VIDEO_ADDR_KEYS:\n'
MEDIA_FUNC_ANCHOR = 'def extract_video_urls('
MEDIA_BEST = '''def _xiaoju_best(video_item):
    """小橘视频：bit_rate 里挑最高清的一档——分辨率最高；一样高的先要 H.264（哪里都能播），再比码率"""
    best, best_key = [], None
    for entry in video_item.get("bit_rate") or []:
        if not isinstance(entry, dict):
            continue
        addr = entry.get("play_addr") if isinstance(entry.get("play_addr"), dict) else {}
        urls = _url_list_of(addr)
        if not urls or str(entry.get("format") or "mp4").lower() != "mp4":
            continue
        try:
            pixels = int(addr.get("width") or 0) * int(addr.get("height") or 0)
            rate = int(entry.get("bit_rate") or 0)
        except (TypeError, ValueError):
            continue
        h265 = bool(entry.get("is_h265") or entry.get("is_bytevc1"))
        key = (pixels, not h265, rate)
        if best_key is None or key > best_key:
            best, best_key = list(reversed(urls)), key
    return best


'''
MEDIA_USE = ('    best = _xiaoju_best(video_item)  # 小橘视频：先挑最高清的一档\n'
             '    if best:\n'
             '        return best\n\n')


def patch_media(text):
    if '_xiaoju_best' in text:
        return text
    if text.count(MEDIA_ANCHOR) != 1 or text.count(MEDIA_FUNC_ANCHOR) != 1:
        raise SystemExit('MediaCrawler 的抖音 media.py 里找不到挑视频地址的地方（上游改了格式？）')
    text = text.replace(MEDIA_FUNC_ANCHOR, MEDIA_BEST + MEDIA_FUNC_ANCHOR)
    return text.replace(MEDIA_ANCHOR, MEDIA_USE + MEDIA_ANCHOR)


KS_STORE_ANCHOR = '"source_keyword": source_keyword_var.get(),'
KS_STORE_EXTRA = ('"author_id": str(user_info.get("id", "")),  # 小橘视频：认小号\n'
                  '        "author_nickname": user_info.get("name", ""),\n'
                  '        "best_play_url": _xiaoju_best_url(photo_info),')
KS_IMPORT_ANCHOR = 'from ._store_impl import *\n'
KS_BEST = '''

def _xiaoju_best_url(photo):
    """小橘视频：快手作品各档清晰度里挑最高的——分辨率最高；一样高先要 H.264（哪里都能播），再比码率"""
    if not isinstance(photo, dict):
        return ""
    best, best_key = "", None
    resource = photo.get("videoResource") if isinstance(photo.get("videoResource"), dict) else {}
    sets = [(resource.get("h264"), False), (resource.get("hevc"), True), (photo.get("manifest"), None)]
    for res, hevc in sets:
        if not isinstance(res, dict):
            continue
        for adaptation in res.get("adaptationSet") or []:
            if not isinstance(adaptation, dict):
                continue
            codec = str(adaptation.get("codecs") or "").lower()
            is_hevc = hevc if hevc is not None else ("hev" in codec or "hvc" in codec)
            for rep in adaptation.get("representation") or []:
                if not isinstance(rep, dict) or not isinstance(rep.get("url"), str) or not rep["url"]:
                    continue
                try:
                    pixels = int(rep.get("width") or 0) * int(rep.get("height") or 0)
                    rate = int(rep.get("avgBitrate") or rep.get("maxBitrate") or 0)
                except (TypeError, ValueError):
                    continue
                key = (pixels, not is_hevc, rate)
                if best_key is None or key > best_key:
                    best, best_key = rep["url"], key
    return best or photo.get("photoUrl") or photo.get("photoH265Url") or ""
'''
KS_GOTO_OLD = 'await self.context_page.goto(f"{self.index_url}?isHome=1")'
KS_GOTO_NEW = 'await self.context_page.goto(f"{self.index_url}?isHome=1", wait_until="domcontentloaded", timeout=60000)'


def patch_ks_store(text):
    if '_xiaoju_best_url' in text:
        return text
    if text.count(KS_STORE_ANCHOR) != 1 or text.count(KS_IMPORT_ANCHOR) != 1:
        raise SystemExit('MediaCrawler 的快手存储里找不到要改的地方（上游改了格式？）')
    text = text.replace(KS_IMPORT_ANCHOR, KS_IMPORT_ANCHOR + KS_BEST)
    return text.replace(KS_STORE_ANCHOR, KS_STORE_ANCHOR + '\n        ' + KS_STORE_EXTRA)


def patch_ks_goto(text):
    if KS_GOTO_NEW in text:
        return text
    if KS_GOTO_OLD not in text:
        raise SystemExit('MediaCrawler 的快手 core.py 里找不到打开首页那一行（上游改了格式？）')
    return text.replace(KS_GOTO_OLD, KS_GOTO_NEW)


def patch_store(text):
    if 'author_sec_uid' in text:
        return text
    if text.count(STORE_ANCHOR) != 1:
        raise SystemExit('MediaCrawler 的抖音存储里找不到 source_keyword 那一行（上游改了格式？）')
    return text.replace(STORE_ANCHOR, STORE_ANCHOR + '\n        ' + STORE_EXTRA)


GOTO_OLD = 'await self.context_page.goto(self.index_url)'
GOTO_NEW = 'await self.context_page.goto(self.index_url, wait_until="domcontentloaded", timeout=60000)'


NEW_PAGE = '            self.context_page = await self.browser_context.new_page()\n'
COOKIES_FIRST = (
    '            if config.LOGIN_TYPE == "cookie" and config.COOKIES:  # 小橘视频：先把存着的登录 cookie 放进浏览器\n'
    '                await self.browser_context.add_cookies([\n'
    '                    {"name": k, "value": v, "domain": ".douyin.com", "path": "/"}\n'
    '                    for k, v in utils.convert_str_cookie_to_dict(config.COOKIES).items()])\n')
CLICK_OLD = '            await login_button_ele.click()\n'
CLICK_NEW = ('            try:  # 小橘视频：点不到也不退出（用 cookie 登录时 cookie 已经放进去了）\n'
             '                await login_button_ele.click(timeout=5000)\n'
             '            except Exception as e:\n'
             '                utils.logger.error(f"[DouYinLogin.popup_login_dialog] no login button: {e}")\n')


def patch_login_click(text):
    if 'click(timeout=5000)' in text:
        return text
    if text.count(CLICK_OLD) != 1:
        raise SystemExit('MediaCrawler 抖音 login.py 里找不到点「登录」那一行（上游改了格式？）')
    return text.replace(CLICK_OLD, CLICK_NEW)


def patch_login_state(text):
    """client.py 的 pong 和 login.py 的 check_login_state：有 sessionid 也算登录了"""
    if 'xiaoju: sessionid' in text:
        return text
    cond = 'cookie_dict.get("LOGIN_STATUS") == "1"'
    wider = '(cookie_dict.get("LOGIN_STATUS") == "1" or bool(cookie_dict.get("sessionid")))'
    n = 0
    for old, new in ((f'return {cond}', f'return {wider}  # xiaoju: sessionid'),
                     (f'if {cond}:', f'if {wider}:  # xiaoju: sessionid')):
        if old in text:
            text = text.replace(old, new)
            n += 1
    if not n:
        raise SystemExit('MediaCrawler 里找不到判断 LOGIN_STATUS 那一行（上游改了格式？）')
    return text


def patch_goto(text):
    if GOTO_NEW not in text:
        if text.count(GOTO_OLD) != 1:
            raise SystemExit('MediaCrawler 抖音 core.py 里找不到打开首页那一行（上游改了格式？）')
        text = text.replace(GOTO_OLD, GOTO_NEW)
    if COOKIES_FIRST not in text:
        if text.count(NEW_PAGE) != 1:
            raise SystemExit('MediaCrawler 抖音 core.py 里找不到新开页面那一行（上游改了格式？）')
        text = text.replace(NEW_PAGE, COOKIES_FIRST + NEW_PAGE)
    return text


RETRY_MODULE = '''"""小橘视频加的：页面在跳转时 page.evaluate 等新页面出来再试（最多 5 次），不直接退出"""
import asyncio

from playwright.async_api import Page

_evaluate = Page.evaluate
GONE = ('Execution context was destroyed', 'Cannot find context', 'navigation')


async def evaluate(self, expression, arg=None):
    for i in range(6):
        try:
            return await _evaluate(self, expression, arg)
        except Exception as e:  # noqa: BLE001
            if i == 5 or not any(g in str(e) for g in GONE):
                raise
            try:
                await self.wait_for_load_state('domcontentloaded', timeout=15000)
            except Exception:  # noqa: BLE001
                pass
            await asyncio.sleep(1)


Page.evaluate = evaluate
'''
MAIN_IMPORT = 'import xiaoju_retry  # noqa: F401  小橘视频：页面跳转时读页面重试\n'


def patch_main(text):
    return text if MAIN_IMPORT in text else MAIN_IMPORT + text


def apply(mc_dir):
    with open(os.path.join(mc_dir, 'xiaoju_retry.py'), 'w', encoding='utf-8') as f:
        f.write(RETRY_MODULE)
    for rel, fn in (('config/base_config.py', patch), ('media_platform/douyin/core.py', patch_goto), ('main.py', patch_main),
                    ('media_platform/douyin/login.py', patch_login_click),
                    ('media_platform/douyin/login.py', patch_login_state), ('media_platform/douyin/client.py', patch_login_state),
                    ('store/douyin/__init__.py', patch_store), ('media_platform/douyin/media.py', patch_media),
                    ('store/kuaishou/__init__.py', patch_ks_store), ('media_platform/kuaishou/core.py', patch_ks_goto)):
        path = os.path.join(mc_dir, rel)
        with open(path, encoding='utf-8') as f:
            text = f.read()
        with open(path, 'w', encoding='utf-8') as f:
            f.write(fn(text))


if __name__ == '__main__':
    apply(sys.argv[1])
