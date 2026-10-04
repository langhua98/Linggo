"""小橘视频 · 云电脑：用 MediaCrawler 同步频道主自己抖音账号的作品

在 GitHub Codespaces（.devcontainer/xiaoju-video）里跑。MediaCrawler（NanmiCoder/MediaCrawler，装在
~/.xiaoju-video/MediaCrawler）在真浏览器里扫码登录抖音、自己算接口签名，抓到的作品写成 jsonl；
这里把 jsonl 读出来，问 Worker 哪些已经收过（/dy-known），新的送过去（/dy-import），Worker 再交审核机器人。

  python mc_sync.py setup <Worker 地址> <令牌> <你自己的抖音主页链接>
  python mc_sync.py sync              抓你主页的全部作品（creator 模式）
  python mc_sync.py link <链接>...     只抓这几条（detail 模式；只用于你自己的、或有授权的作品）

MediaCrawler 只按 setup 时填的那一个主页抓（creator），不做关键词搜索，也不抓评论。
"""

import json
import os
import re
import subprocess
import sys
import tempfile
import urllib.error
import urllib.request

sys.path.insert(0, os.path.join(os.path.dirname(os.path.abspath(__file__)), '..', 'streamer'))
from mc import items_from, mc_args as _mc_args, read_rows  # noqa: E402,F401  解析和流式服务共用

HOME = os.path.expanduser('~/.xiaoju-video')
CONFIG = os.path.join(HOME, 'config.json')
MC_DIR = os.path.join(HOME, 'MediaCrawler')
BATCH = 100
HOMEPAGE = re.compile(r'^https://(?:www\.)?douyin\.com/user/MS4wLjABAAAA[\w-]+')


def load_config():
    try:
        with open(CONFIG) as f:
            return json.load(f)
    except FileNotFoundError:
        sys.exit('还没设置：先运行 run.sh setup <Worker 地址> <令牌> <你的抖音主页链接>（令牌在小橘视频机器人里发「云电脑」拿）')


def worker_call(cfg, path, body):
    req = urllib.request.Request(cfg['worker'].rstrip('/') + path, data=json.dumps(body).encode(), method='POST',
                                 headers={'Content-Type': 'application/json', 'X-Token': cfg['token'],
                                          'User-Agent': 'xiaoju-video-cloud'})
    try:
        with urllib.request.urlopen(req, timeout=60) as r:
            return json.loads(r.read() or b'{}')
    except urllib.error.HTTPError as e:
        if e.code == 403:
            sys.exit('Worker 不认这个令牌：在机器人里重新发「云电脑」，再运行一次 setup')
        raise


def push(cfg, items, report=print):
    """问 Worker 哪些收过，新的分批送过去；返回被收下的条数"""
    total = len(items)
    known = set()
    for i in range(0, total, 1000):
        known |= set(worker_call(cfg, '/dy-known', {'ids': [x['aweme'] for x in items[i:i + 1000]]}).get('known') or [])
    fresh = [x for x in items if x['aweme'] not in known]
    report(f'一共 {total} 条，Worker 已经有 {len(known)} 条，新的 {len(fresh)} 条')
    added = 0
    for i in range(0, len(fresh), BATCH):
        r = worker_call(cfg, '/dy-import', {'items': fresh[i:i + BATCH]})
        added += r.get('added', 0)
        worker_call(cfg, '/dy-progress', {'stage': '送 Worker', 'done': min(i + BATCH, len(fresh)), 'total': len(fresh)})
    worker_call(cfg, '/dy-progress', {'stage': '完成', 'done': added, 'total': total,
                                      'note': f'新送 {added} 条，已有 {len(known)} 条'})
    return added


def mc_args(mode, target, data_dir):
    """云电脑上用 uv 跑 MediaCrawler；登录状态在它的浏览器档案里（run.sh login 扫的码）"""
    return ['uv', 'run', 'main.py'] + _mc_args(mode, target, data_dir)


def run_mc(mode, target):
    if not os.path.isdir(MC_DIR):
        sys.exit('MediaCrawler 还没装：先运行 run.sh install')
    data_dir = tempfile.mkdtemp(prefix='mc-', dir=HOME)
    print('MediaCrawler 开始抓。第一次要扫码：打开端口 6080 的网页桌面（密码 vscode），60 秒内用抖音 App 扫浏览器里的二维码。')
    p = subprocess.run(mc_args(mode, target, data_dir), cwd=MC_DIR)
    if p.returncode != 0:
        print(f'MediaCrawler 退出码 {p.returncode}，下面照样把已经抓到的送出去')
    return read_rows(data_dir)


def sync_rows(cfg, rows, what):
    items = items_from(rows)
    if not items:
        worker_call(cfg, '/dy-progress', {'stage': '完成', 'note': f'{what}：一条作品也没抓到'})
        sys.exit('一条作品也没抓到：看看网页桌面里是不是没扫码登录、弹了验证码')
    added = push(cfg, items)
    print(f'送过去 {added} 条，去审核机器人 @xiaojuverify_bot 里点「全部通过」或逐条审核')


def main(argv):
    cmd = argv[1] if len(argv) > 1 else ''
    if cmd == 'setup':
        if len(argv) != 5 or not argv[2].startswith('https://') or not HOMEPAGE.match(argv[4]):
            sys.exit('用法：run.sh setup <Worker 地址> <令牌> <你自己的抖音主页链接，形如 https://www.douyin.com/user/MS4wLjABAAAA...>')
        os.makedirs(HOME, exist_ok=True)
        with open(CONFIG, 'w') as f:
            json.dump({'worker': argv[2], 'token': argv[3], 'homepage': argv[4]}, f)
        os.chmod(CONFIG, 0o600)
        worker_call(load_config(), '/dy-progress', {'stage': '已连上'})
        print('设置好了，Worker 认这个令牌。下一步：run.sh sync')
        return
    if cmd == 'sync':
        cfg = load_config()
        worker_call(cfg, '/dy-progress', {'stage': '抓作品'})
        sync_rows(cfg, run_mc('creator', cfg['homepage']), '主页同步')
        return
    if cmd == 'link' and len(argv) > 2:
        cfg = load_config()
        links = [a for a in argv[2:] if re.match(r'^https://(?:v\.|www\.)?douyin\.com/', a) or re.fullmatch(r'\d{6,25}', a)]
        if not links:
            sys.exit('没认出抖音链接')
        sync_rows(cfg, run_mc('detail', ','.join(links)), '指定链接')
        return
    sys.exit(__doc__)


if __name__ == '__main__':
    main(sys.argv)
