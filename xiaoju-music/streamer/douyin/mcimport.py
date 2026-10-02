"""读 MediaCrawler 导出的抖音作品文件（频道主在自己的云电脑上登录、抓取后发给机器人）。

MediaCrawler 的 store/douyin 每条作品存成：aweme_id、desc、create_time、nickname（脱敏过）、
video_download_url（play_addr，不带水印）、note_download_url（图文的原图，逗号分隔）等。
导出格式默认 jsonl（一行一条），也支持 json（一个数组）。整理成 items.normalize 一样的样子，后面照常下载、发帖。"""

import json

from .items import share_url


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
    images = [u.strip() for u in str(r.get('note_download_url') or '').split(',') if u.strip().startswith('http')]
    video = str(r.get('video_download_url') or '').strip()
    kind = 'images' if images else ('video' if video.startswith('http') else 'other')
    name = str(r.get('nickname') or '')
    try:
        t = int(r.get('create_time') or 0)
    except (TypeError, ValueError):
        t = 0
    return {
        'id': aweme_id, 'kind': kind, 'url': share_url(aweme_id, kind), 'public': True,
        'time': t, 'desc': str(r.get('desc') or r.get('title') or '').strip(),
        'author': '' if '*' in name else name,  # 新版 MediaCrawler 会把昵称打码，打码的就不写
        'sec_uid': '', 'seconds': 0, 'width': 0, 'height': 0,
        'sources': [{'urls': [video], 'size': 0, 'width': 0, 'height': 0, 'h265': False}] if kind == 'video' else [],
        'images': [{'urls': [u], 'width': 0, 'height': 0} for u in images],
        'cover': str(r.get('cover_url') or ''),
    }
