"""读 MediaCrawler 导出的抖音作品文件（频道主在自己的云电脑上登录、抓取后发给机器人）。

MediaCrawler 的 store/douyin 每条作品存成：aweme_id、desc、create_time、nickname（脱敏过）、
video_download_url（play_addr，不带水印）、note_download_url（图文的原图，逗号分隔）等。
导出格式默认 jsonl（一行一条），也支持 json（一个数组）。整理成 items.normalize 一样的样子，后面照常下载、发帖。

video_download_url 只是抖音的默认画质。云电脑上的 crawl.sh 给 MediaCrawler 打了补丁，每条另存 xiaoju_video
（作品的 video 里各档清晰度 bit_rate 等）和 xiaoju_images（每张图的全部地址）：有就用它们挑最高画质。"""

import json

from .items import image_sources, share_url, video_sources


def parse_export(text):
    """文件内容 → [作品]（认不出的行跳过）"""
    text = (text or '').strip()
    rows = []
    if text.startswith('['):
        try:
            rows = json.loads(text)
        except ValueError:
            rows = []
    else:
        for line in text.splitlines():
            line = line.strip()
            if line.startswith('{'):
                try:
                    rows.append(json.loads(line))
                except ValueError:
                    pass
    out, seen = [], set()
    for r in rows:
        item = to_item(r) if isinstance(r, dict) else None
        if item and item['id'] not in seen:
            seen.add(item['id'])
            out.append(item)
    return out


def to_item(r):
    aweme_id = str(r.get('aweme_id') or '').strip()
    if not aweme_id.isdigit():
        return None
    xv = r.get('xiaoju_video') if isinstance(r.get('xiaoju_video'), dict) else {}
    xi = r.get('xiaoju_images') if isinstance(r.get('xiaoju_images'), list) else []
    images = image_sources([i for i in xi if isinstance(i, dict)])
    if not images:
        images = [{'urls': [u.strip()], 'width': 0, 'height': 0}
                  for u in str(r.get('note_download_url') or '').split(',') if u.strip().startswith('http')]
    sources = video_sources(xv)
    video = str(r.get('video_download_url') or '').strip()
    if video.startswith('http') and video not in [u for s in sources for u in s['urls']]:
        sources.append({'urls': [video], 'size': 0, 'width': 0, 'height': 0, 'h265': False})
    kind = 'images' if images else ('video' if sources else 'other')
    name = str(r.get('nickname') or '')
    try:
        t = int(r.get('create_time') or 0)
    except (TypeError, ValueError):
        t = 0
    try:
        seconds = round(int(xv.get('duration') or 0) / 1000)
    except (TypeError, ValueError):
        seconds = 0
    best = sources[0] if sources else {}
    return {
        'id': aweme_id, 'kind': kind, 'url': share_url(aweme_id, kind), 'public': True,
        'time': t, 'desc': str(r.get('desc') or r.get('title') or '').strip(),
        'author': '' if '*' in name else name,  # 新版 MediaCrawler 会把昵称打码，打码的就不写
        'sec_uid': '', 'seconds': seconds,
        'width': best.get('width') or xv.get('width') or 0, 'height': best.get('height') or xv.get('height') or 0,
        'sources': sources if kind == 'video' else [],
        'images': images if kind == 'images' else [],
        'cover': str(r.get('cover_url') or ''),
    }
