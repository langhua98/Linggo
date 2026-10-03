"""从分享文字里找抖音链接，认出是哪条作品、哪个账号。

抖音 App 里「分享 → 复制链接」得到的是一段文字，比如：
  2.58 复制打开抖音，看看【丁的作品】特效一用谁都不认  https://v.douyin.com/-Ghr0VeGTpA/ :0pm C@H.iC Uyt:/ 02/20
里面的短链接要跳转一次才知道是作品（…/share/video/<作品号>）还是主页（…/share/user/<sec_uid>）。"""

import asyncio
import re
import urllib.error
import urllib.request

# re.A：\w 只认英文字母数字（不然链接后面紧跟的「复制」也会被当成链接的一部分）
LINK = re.compile(r'https?://(?:[a-z0-9-]+\.)*(?:douyin|iesdouyin)\.com(?:/[\w\-./?=&%#~+:]*)?', re.I | re.A)
SHORT = re.compile(r'^https?://v\.douyin\.com/', re.I)
# 作品页：/video/<号>、/note/<号>（图文）、分享页 /share/video/<号>；在主页上点开的作品是 ?modal_id=<号>
AWEME = re.compile(r'/(?:share/)?(?:video|note|slides)/(\d{8,24})|[?&#](?:modal_id|aweme_id|vid)=(\d{8,24})', re.A)
# 主页：sec_uid 都以 MS4wLjABAAAA 开头
USER = re.compile(r'/(?:share/)?user/(MS4wLjABAAAA[\w-]{10,120})', re.A)
MOBILE_UA = ('Mozilla/5.0 (iPhone; CPU iPhone OS 17_5 like Mac OS X) AppleWebKit/605.1.15 '
             '(KHTML, like Gecko) Version/17.5 Mobile/15E148 Safari/604.1')


def find_link(text):
    m = LINK.search(text or '')
    return m.group(0).rstrip('.,:;') if m else None


def classify(url):
    """→ ('aweme', 作品号) / ('user', sec_uid) / ('short', 网址) / None"""
    if not url:
        return None
    if SHORT.match(url):
        return 'short', url
    m = AWEME.search(url)  # 先认作品：主页上点开的作品，网址里两样都有
    if m:
        return 'aweme', m.group(1) or m.group(2)
    m = USER.search(url)
    if m:
        return 'user', m.group(1)
    return None


class _NoRedirect(urllib.request.HTTPRedirectHandler):
    def redirect_request(self, *args, **kwargs):
        return None  # 不跟着跳，只要跳去哪


def follow_short(url, timeout=15):
    """短链接 → 它跳转到的网址（拿不到返回空字符串）"""
    opener = urllib.request.build_opener(_NoRedirect)
    try:
        r = opener.open(urllib.request.Request(url, headers={'User-Agent': MOBILE_UA}), timeout=timeout)
        r.close()
        return r.geturl()
    except urllib.error.HTTPError as e:
        if e.code in (301, 302, 303, 307, 308):
            return e.headers.get('Location') or ''
        raise


async def resolve(text, follow=follow_short):
    """分享文字 → ('aweme', 作品号) / ('user', sec_uid) / None"""
    got = classify(find_link(text))
    for _ in range(2):  # 短链接一般跳一次就到
        if not got or got[0] != 'short':
            return got
        got = classify(await asyncio.to_thread(follow, got[1]))
    return None
