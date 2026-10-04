"""改 MediaCrawler 的 config/base_config.py：不连本机 Chrome（CDP），用 Playwright 自带的 Chromium；
有界面（服务器上跑在 Xvfb 虚拟屏幕里，云电脑上跑在网页桌面里）；不抓评论；保存登录状态。

  python mc_patch.py <MediaCrawler>/config/base_config.py
"""

import re
import sys

SETTINGS = {'ENABLE_CDP_MODE': 'False', 'HEADLESS': 'False', 'ENABLE_GET_COMMENTS': 'False', 'SAVE_LOGIN_STATE': 'True'}


def patch(text):
    for k, v in SETTINGS.items():
        text, n = re.subn(rf'^{k} = .*$', f'{k} = {v}', text, flags=re.M)
        if n != 1:
            raise SystemExit(f'MediaCrawler 配置里找不到 {k}（上游改了格式？）')
    return text


if __name__ == '__main__':
    path = sys.argv[1]
    with open(path, encoding='utf-8') as f:
        text = f.read()
    with open(path, 'w', encoding='utf-8') as f:
        f.write(patch(text))
