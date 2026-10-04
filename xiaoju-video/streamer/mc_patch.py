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
                    ('store/douyin/__init__.py', patch_store)):
        path = os.path.join(mc_dir, rel)
        with open(path, encoding='utf-8') as f:
            text = f.read()
        with open(path, 'w', encoding='utf-8') as f:
            f.write(fn(text))


if __name__ == '__main__':
    apply(sys.argv[1])
