"""从「手机上打开的抖音分享页」里取作品数据（iOS 快捷指令转来的）。

服务器自己打开分享页，抖音不给数据（机房 IP、没登录）；频道主的手机打开，页面里的 window._ROUTER_DATA
带着作品的完整信息。快捷指令在手机上取到页面，原样发过来，这里解析。分享页给的是带水印的 playwm 地址，
换成 play 就是不带水印的。"""

import json
import re

from .items import normalize

ROUTER = re.compile(r'window\._ROUTER_DATA\s*=\s*(\{.*?\})\s*</script>', re.S)


def _unwatermark(obj):
    """分享页里视频地址是 /playwm/（带水印），换成 /play/"""
    if isinstance(obj, dict):
        return {k: _unwatermark(v) for k, v in obj.items()}
    if isinstance(obj, list):
        return [_unwatermark(v) for v in obj]
    if isinstance(obj, str) and '/playwm/' in obj:
        return obj.replace('/playwm/', '/play/')
    return obj


def parse_share_html(html):
    """分享页 HTML → normalize 过的作品；页面里没有作品数据 → None"""
    m = ROUTER.search(html or '')
    if not m:
        return None
    try:
        data = json.loads(m.group(1))
    except ValueError:
        return None
    for page in (data.get('loaderData') or {}).values():
        info = (page or {}).get('videoInfoRes') if isinstance(page, dict) else None
        items = (info or {}).get('item_list') or []
        if items and items[0].get('aweme_id'):
            a = _unwatermark(items[0])
            if a.get('images') and not a.get('video', {}).get('duration'):
                a.setdefault('video', {})
            return normalize(a)
    return None
