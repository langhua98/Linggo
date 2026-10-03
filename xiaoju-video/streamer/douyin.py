"""抖音：认分享链接、取作品信息。

不登录也能看的分享页（iesdouyin.com/share/video|note/<作品号>/）里带着一段 window._ROUTER_DATA，
是这条作品的完整信息（文字、作者、视频地址、图文的图片）。这里只解析这一页，不碰要签名的网页版接口。
云电脑抓来的作品自带视频地址，地址过期了（几个小时）也走这里重新取一次。
"""

import json
import re

MOBILE_UA = ('Mozilla/5.0 (iPhone; CPU iPhone OS 17_5 like Mac OS X) AppleWebKit/605.1.15 '
             '(KHTML, like Gecko) Version/17.5 Mobile/15E148 Safari/604.1')
DESKTOP_UA = ('Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 '
              '(KHTML, like Gecko) Chrome/126.0.0.0 Safari/537.36')

LINK = re.compile(r'https?://(?:v\.douyin\.com|(?:www\.|m\.)?douyin\.com|(?:www\.)?iesdouyin\.com)/[^\s，。！？、"\'<>]*', re.I)
AWEME = re.compile(r'(?:/(?:video|note|slides)/|[?&](?:modal_id|aweme_id|item_ids)=)(\d{6,25})')
ROUTER = re.compile(r'window\._ROUTER_DATA\s*=\s*(\{.*?\})\s*;?\s*</script>', re.S)


class DouyinError(Exception):
    """给频道主看的错误说明"""


def find_link(text):
    m = LINK.search(text or '')
    return m.group(0).rstrip('),.;!?') if m else None


def aweme_of(url):
    m = AWEME.search(url or '')
    return m.group(1) if m else None


def parse_share_page(html):
    """分享页 HTML → 作品原始数据（item_list[0]）；没有就抛 DouyinError"""
    m = ROUTER.search(html or '')
    if not m:
        raise DouyinError('分享页里没有作品数据（可能被风控了，过会儿再试）')
    try:
        data = json.loads(m.group(1))
    except ValueError as e:
        raise DouyinError('分享页的作品数据解析不了') from e
    for page in (data.get('loaderData') or {}).values():
        res = (page or {}).get('videoInfoRes') if isinstance(page, dict) else None
        items = (res or {}).get('item_list') or []
        if items:
            return items[0]
        if res and res.get('filter_list'):
            reason = (res['filter_list'][0] or {}).get('detail_msg') or '作品不可见'
            raise DouyinError(f'抖音说：{reason}')
    raise DouyinError('作品不存在或已删除')


def first_url(obj):
    urls = (obj or {}).get('url_list') or []
    return next((u for u in urls if isinstance(u, str) and u.startswith(('http', '//'))), None)


def https(u):
    return 'https:' + u if u.startswith('//') else u.replace('http://', 'https://', 1)


def to_item(raw, fallback_id=None):
    """抖音的作品原始数据（分享页、网页版接口的格式差不多）→ 统一的作品字典"""
    aweme = str(raw.get('aweme_id') or fallback_id or '')
    if not re.fullmatch(r'\d{6,25}', aweme):
        raise DouyinError('作品号不对')
    images = [first_url(i) for i in (raw.get('images') or [])]
    images = [https(u) for u in images if u]
    item = {
        'aweme': aweme,
        'desc': (raw.get('desc') or '').strip(),
        'author': ((raw.get('author') or {}).get('nickname') or '').strip(),
        'create_time': int(raw.get('create_time') or 0),
    }
    cover = first_url((raw.get('video') or {}).get('cover')) or first_url((raw.get('video') or {}).get('origin_cover'))
    if cover:
        item['cover'] = https(cover)
    if images:
        item.update(type='images', images=images[:35], url=f'https://www.douyin.com/note/{aweme}')
        return item
    play = first_url((raw.get('video') or {}).get('play_addr'))
    if not play:
        raise DouyinError('作品里没有视频地址')
    # 分享页给的是带水印的 playwm，换成 play 就是原片（这是频道主自己的作品）
    play = https(play.replace('/playwm/', '/play/'))
    item.update(type='video', video_url=play, url=f'https://www.douyin.com/video/{aweme}')
    return item


class Douyin:
    """http 由外面注入（httpx.AsyncClient 那样的接口），方便测试"""

    def __init__(self, http):
        self.http = http

    async def expand(self, url):
        """短链接跳一次拿到真正的地址"""
        if 'v.douyin.com' not in url:
            return url
        r = await self.http.get(url, headers={'User-Agent': MOBILE_UA}, follow_redirects=False)
        loc = r.headers.get('location')
        if r.status_code in (301, 302, 303, 307, 308) and loc:
            return loc
        raise DouyinError('短链接打不开（可能已失效）')

    async def by_id(self, aweme, kind='video'):
        r = await self.http.get(f'https://www.iesdouyin.com/share/{kind}/{aweme}/',
                                headers={'User-Agent': MOBILE_UA, 'Referer': 'https://www.douyin.com/'},
                                follow_redirects=True)
        if r.status_code != 200:
            raise DouyinError(f'分享页回 {r.status_code}')
        return to_item(parse_share_page(r.text), aweme)

    async def resolve(self, text):
        link = find_link(text)
        if not link:
            raise DouyinError('没找到抖音链接')
        url = await self.expand(link)
        aweme = aweme_of(url)
        if not aweme:
            raise DouyinError('链接里没有作品号')
        return await self.by_id(aweme, 'note' if re.search(r'/(?:note|slides)/', url) else 'video')
