"""小橘 · 云电脑抓取进度 → 一段 JSON（crawl.sh 每 30 秒 POST 给 Worker 的 /dy-progress，频道主在机器人里发「进度」看）。

python3 progress.py <阶段> <模式 crawl|search> <结果目录> <已送条数> <账号或关键词，逗号分隔>
- 每个账号：昵称和作品总数来自 MediaCrawler 拿到的账号资料（crawl.sh 打的补丁写在 ~/.xiaoju/creators.jsonl），
  已抓多少数结果文件里 xiaoju_sec_uid 是它的行。"""

import glob
import json
import os
import sys


def newest(pattern):
    files = glob.glob(pattern, recursive=True)
    return max(files, key=os.path.getmtime) if files else ''


def rows(path):
    out = []
    try:
        with open(path, encoding='utf-8') as f:
            for line in f:
                try:
                    out.append(json.loads(line))
                except ValueError:
                    pass
    except OSError:
        pass
    return out


def main():
    phase, mode, out_dir, sent, names = sys.argv[1:6]
    info = {'phase': phase, 'mode': mode, 'sent': int(sent or 0)}
    if mode == 'search':
        got = rows(newest(os.path.join(out_dir, '**', 'search_contents_*.jsonl')))
        info['keywords'] = [k for k in names.split(',') if k]
        info['got'] = len(got)
        info['per'] = {k: sum(r.get('source_keyword') == k for r in got) for k in info['keywords']}
    else:
        got = rows(newest(os.path.join(out_dir, '**', 'creator_contents_*.jsonl')))
        meta = {}
        for c in rows(os.path.expanduser('~/.xiaoju/creators.jsonl')):
            meta[c.get('sec_uid')] = c
        accounts = []
        for sec in [s for s in names.split(',') if s]:
            m = meta.get(sec, {})
            accounts.append({'sec_uid': sec, 'name': m.get('name', ''), 'total': m.get('total'),
                             'got': sum(r.get('xiaoju_sec_uid') == sec for r in got)})
        info['accounts'] = accounts
        info['got'] = len(got)
    print(json.dumps(info, ensure_ascii=False))


if __name__ == '__main__':
    main()
