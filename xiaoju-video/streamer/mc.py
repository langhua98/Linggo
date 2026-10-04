"""MediaCrawler（NanmiCoder/MediaCrawler）的命令行和结果：流式服务、云电脑（cloud/mc_sync.py）共用。

MediaCrawler 抓到的作品写成 jsonl（抖音：store/douyin 的 update_douyin_aweme 那些字段；快手：store/kuaishou 的
update_kuaishou_video），这里转成 Worker 要的作品。快手作品的号是 ks_<快手作品号>（快手的号是字母数字，和抖音的纯数字分开）。
用 creator（指定主页）、detail（指定作品）、search（关键词搜索）三种模式，不抓评论。
搜出来的作品要交频道主逐条审核（认得出是自己小号的才通过），所以作品里带上作者（mc_patch.py 让它多存的）。
"""

import glob
import json
import os
import re

HTTPS = re.compile(r'^https://\S{4,2000}$')
# MediaCrawler 的版本固定在验证过的这一个：上游改了接口不会突然坏掉；要升级改这里和 Dockerfile、cloud/run.sh
MC_REV = 'bf28178082bc69989954f65a13a17bc129b9aa6e'


def https(u):
    u = (u or '').strip()
    if u.startswith('//'):
        u = 'https:' + u
    return u.replace('http://', 'https://', 1)


KS_ID = re.compile(r'[0-9A-Za-z_-]{6,40}')


def ks_item_from_row(row):
    """快手的作品行 → Worker 要的作品。视频地址用 mc_patch.py 挑的最高清那档（best_play_url），没有再用它原来的"""
    vid = str(row.get('video_id') or '')
    if not KS_ID.fullmatch(vid):
        return None
    video = https(row.get('best_play_url') or row.get('video_play_url'))
    if not HTTPS.match(video):
        return None
    t = int(row.get('create_time') or 0)
    item = {'aweme': f'ks_{vid}', 'platform': 'ks', 'type': 'video', 'video_url': video,
            'url': f'https://www.kuaishou.com/short-video/{vid}',
            'desc': str(row.get('desc') or row.get('title') or '').strip(), 'create_time': t // 1000 if t > 10 ** 12 else t}
    author = str(row.get('author_id') or '')
    if KS_ID.fullmatch(author):
        item['author_sec_uid'] = author
    if row.get('author_nickname'):
        item['author'] = str(row['author_nickname'])[:100]
    cover = https(row.get('video_cover_url'))
    if HTTPS.match(cover):
        item['cover'] = cover
    return item


def item_from_row(row):
    """MediaCrawler 的作品行 → Worker 要的作品；认不出返回 None"""
    if 'video_id' in row and 'aweme_id' not in row:
        return ks_item_from_row(row)
    aweme = str(row.get('aweme_id') or '')
    if not re.fullmatch(r'\d{6,25}', aweme):
        return None
    images = [https(u) for u in str(row.get('note_download_url') or '').split(',') if u.strip()]
    images = [u for u in images if HTTPS.match(u)]
    item = {'aweme': aweme, 'desc': str(row.get('desc') or row.get('title') or '').strip(),
            'create_time': int(row.get('create_time') or 0)}
    sec = str(row.get('author_sec_uid') or '')
    if re.fullmatch(r'MS4wLjABAAAA[\w-]{10,200}', sec):
        item['author_sec_uid'] = sec
    if row.get('author_nickname'):
        item['author'] = str(row['author_nickname'])[:100]
    cover = https(row.get('cover_url'))
    if HTTPS.match(cover):
        item['cover'] = cover
    if images:
        item.update(type='images', images=images[:35], url=f'https://www.douyin.com/note/{aweme}')
        return item
    video = https(row.get('video_download_url'))
    if not HTTPS.match(video):
        return None
    item.update(type='video', video_url=video, url=f'https://www.douyin.com/video/{aweme}')
    return item


def read_rows(data_dir):
    """data_dir 下 MediaCrawler 写的所有作品 jsonl（文件名形如 creator_contents_2026-10-04.jsonl）"""
    rows = []
    for path in sorted(glob.glob(os.path.join(data_dir, '**', '*_contents_*.jsonl'), recursive=True)):
        with open(path, encoding='utf-8') as f:
            for line in f:
                line = line.strip()
                if line:
                    try:
                        rows.append(json.loads(line))
                    except ValueError:
                        continue
    return rows


def items_from(rows):
    seen, items = set(), []
    for row in rows:
        item = item_from_row(row)
        if item and item['aweme'] not in seen:
            seen.add(item['aweme'])
            items.append(item)
    return items


def mc_args(mode, target, data_dir, cookies='', max_notes=100000, platform='dy'):
    """MediaCrawler 的命令行参数（不含前面的 python main.py）：只抓作品本身，不抓评论。
    cookies 不为空就用 cookie 登录（浏览器档案里的登录状态丢了时，用存在 Worker 里的那份补上）。
    search 模式 target 是逗号隔开的关键词，max_notes 是每个关键词最多要几条"""
    args = ['--platform', platform, '--type', mode, '--get_comment', 'no', '--headless', 'no',
            '--save_data_option', 'jsonl', '--save_data_path', data_dir, '--crawler_max_notes_count', str(max_notes)]
    args += ['--lt', 'cookie', '--cookies', cookies] if cookies else ['--lt', 'qrcode']
    args += {'creator': ['--creator_id', target], 'search': ['--keywords', target]}.get(mode, ['--specified_id', target])
    return args


def cookie_header(cookies, domain='douyin.com'):
    """浏览器导出的 cookie 列表 → 「a=b; c=d」，只要这个平台域名下的（抖音 douyin.com，快手 kuaishou.com）"""
    return '; '.join(f'{c["name"]}={c["value"]}' for c in cookies or []
                     if isinstance(c, dict) and domain in str(c.get('domain', '')) and c.get('name'))
