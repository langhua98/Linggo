"""只登录抖音：在网页桌面里打开 MediaCrawler 用的那个浏览器档案，等你扫码。登录状态存进档案，之后 sync / link 直接用。

由 run.sh login 用 MediaCrawler 的环境（uv run）启动。
"""

import asyncio
import os
import sys
import time

from playwright.async_api import async_playwright

# MediaCrawler 开了 SAVE_LOGIN_STATE 时用的浏览器档案：<MediaCrawler>/browser_data/dy_user_data_dir
PROFILE = os.path.join(os.getcwd(), 'browser_data', 'dy_user_data_dir')
WAIT_S = 10 * 60


async def main():
    if not os.environ.get('DISPLAY'):
        sys.exit('没有图形桌面：要在 Codespace 的网页桌面（端口 6080）里扫码')
    async with async_playwright() as p:
        ctx = await p.chromium.launch_persistent_context(PROFILE, headless=False, locale='zh-CN',
                                                         viewport={'width': 1280, 'height': 860})
        page = ctx.pages[0] if ctx.pages else await ctx.new_page()
        await page.goto('https://www.douyin.com/', wait_until='domcontentloaded')
        print('打开端口 6080 的网页桌面（密码 vscode），在浏览器里点「登录」，用抖音 App 扫码。最多等 10 分钟……')
        deadline = time.time() + WAIT_S
        while time.time() < deadline:
            cookies = await ctx.cookies('https://www.douyin.com')
            if any(c['name'] == 'sessionid' and c['value'] for c in cookies):
                print('✓ 抖音登录好了，登录状态已经存下。')
                await page.wait_for_timeout(3000)
                await ctx.close()
                return
            await asyncio.sleep(3)
        await ctx.close()
        sys.exit('10 分钟内没登录上，再运行一次 run.sh login')


asyncio.run(main())
