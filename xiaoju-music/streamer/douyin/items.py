"""把抖音接口返回的一条作品整理成要用的几样东西：是视频还是图文、公开链接、发布时间、文案、下载地址。

视频挑不带水印的 H.264：play_addr / bit_rate 里的都不带水印（带水印的是 download_addr，不用）；
H.265 有的 Telegram 客户端放不了，排在最后。图文的每张图用 url_list（download_url_list 带水印，不用），JPEG 的地址排前面。"""

import re
import time

CAPTION_LIMIT = 1024  # Telegram 帖子说明的上限（按 UTF-16 算）


def _urls(addr):
    return [u for u in ((addr or {}).get('url_list') or []) if isinstance(u, str) and u.startswith('http')]


def _h265(b):
    return bool(b.get('is_h265') or b.get('is_bytevc1')) or 'bytevc1' in str(b.get('gear_name') or '')


def video_sources(v):
    """[{urls, size, width, height}]，好的在前：H.264 里画面最清楚、码率最高的一档，再是默认地址，H.265 最后。
    每档的 urls 是几个 CDN 的同一个文件，一个不通换下一个。"""
    picked = []
    rates = [b for b in (v.get('bit_rate') or []) if isinstance(b, dict) and _urls(b.get('play_addr'))]

    def rank(b):
        a = b['play_addr']
        return (not _h265(b), min(a.get('width') or 0, a.get('height') or 0), b.get('bit_rate') or 0)

    for b in sorted(rates, key=rank, reverse=True):
        a = b['play_addr']
        picked.append({'urls': _urls(a), 'size': a.get('data_size') or 0,
                       'width': a.get('width') or 0, 'height': a.get('height') or 0, 'h265': _h265(b)})
    for name in ('play_addr_h264', 'play_addr'):
        a = v.get(name)
        if _urls(a):
            picked.append({'urls': _urls(a), 'size': a.get('data_size') or 0, 'width': a.get('width') or v.get('width') or 0,
                           'height': a.get('height') or v.get('height') or 0, 'h265': False})
    # H.265 的放到最后；同一个文件（第一个地址一样）只留一份
    out, seen = [], set()
    for s in sorted(picked, key=lambda s: s['h265']):
        if s['urls'][0] not in seen:
            seen.add(s['urls'][0])
            out.append(s)
    return out


def image_sources(images):
    """图文的每张图 → [{urls, width, height}]，按原来的顺序。每张的 urls 是几个 CDN 的同一张图，JPEG 的排前面"""
    out = []
    for img in images or []:
        urls = sorted(_urls(img), key=lambda u: not re.search(r'jpe?g', u, re.I))
        if urls:
            out.append({'urls': urls, 'width': img.get('width') or 0, 'height': img.get('height') or 0})
    return out


def normalize(a):
    v = a.get('video') or {}
    author = a.get('author') or {}
    sources = video_sources(v)
    ms = v.get('duration') or a.get('duration') or 0
    if a.get('images'):
        kind = 'images'  # 图文
    elif sources and ms > 0:
        kind = 'video'
    else:
        kind = 'other'
    aweme_id = str(a.get('aweme_id') or '')
    st = a.get('status') or {}
    return {
        # 登录后看自己的主页，列表里会有私密、仅好友可见的作品：这些不转
        'public': not (st.get('is_private') or st.get('private_status') or st.get('friends_status')),
        'id': aweme_id,
        'kind': kind,
        'url': share_url(aweme_id, kind),
        'time': int(a.get('create_time') or 0),
        'desc': (a.get('desc') or '').strip(),
        'author': author.get('nickname') or '',
        'sec_uid': author.get('sec_uid') or '',
        'seconds': round(ms / 1000),
        'width': v.get('width') or 0,
        'height': v.get('height') or 0,
        'sources': sources,
        'images': image_sources(a.get('images')) if kind == 'images' else [],
        'cover': (_urls(v.get('origin_cover')) or _urls(v.get('cover')) or [''])[0],
    }


def share_url(aweme_id, kind='video'):
    """作品的公开链接（解析网站都认）：图文是 /note/，视频是 /video/"""
    return f'https://www.douyin.com/{"note" if kind == "images" else "video"}/{aweme_id}'


def _u16(s):
    return len(s.encode('utf-16-le')) // 2


def caption(item, limit=CAPTION_LIMIT):
    """频道帖子的说明：文案 + 来源（作者、发布日期、原视频链接）。链接里有作品号，查重也靠它。"""
    day = time.strftime('%Y-%m-%d', time.gmtime(item['time'] + 8 * 3600)) if item.get('time') else ''
    icon = '🖼' if item.get('kind') == 'images' else '📹'
    link = item.get('url') or share_url(item['id'], item.get('kind'))
    tail = f'{icon} 抖音 @{item.get("author") or "?"}' + (f' · {day}' if day else '') + f'\n{link}'
    desc = item.get('desc') or ''
    room = limit - _u16(tail) - 2
    if _u16(desc) > room:
        while desc and _u16(desc) > room - 1:
            desc = desc[:-1]
        desc += '…'
    return f'{desc}\n\n{tail}' if desc else tail
