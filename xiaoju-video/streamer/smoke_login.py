"""dy_login.py 的冒烟测试：用假的抖音登录页（扫码 → 身份验证 → 刷脸二维码 → 登录成功）在虚拟屏幕里真跑一遍。

要装好 MediaCrawler（它的 Python 环境里有 Playwright 和 Chromium）和 xvfb-run：
  python smoke_login.py <MediaCrawler 目录> <MediaCrawler 的 python>
例：python smoke_login.py ~/.xiaoju-video/MediaCrawler ~/.xiaoju-video/MediaCrawler/.venv/bin/python
"""

import asyncio
import base64
import functools
import http.server
import json
import os
import shutil
import struct
import sys
import tempfile
import threading
import zlib

HERE = os.path.dirname(os.path.abspath(__file__))
SEC = 'MS4wLjABAAAAsmoketest1234567890'


def png(w, h, f):
    raw = b''.join(b'\x00' + bytes(f(x, y) for x in range(w)) for y in range(h))

    def chunk(t, d):
        return struct.pack('>I', len(d)) + t + d + struct.pack('>I', zlib.crc32(t + d) & 0xffffffff)
    return (b'\x89PNG\r\n\x1a\n' + chunk(b'IHDR', struct.pack('>IIBBBBB', w, h, 8, 0, 0, 0, 0))
            + chunk(b'IDAT', zlib.compress(raw)) + chunk(b'IEND', b''))


def data_url(b):
    return 'data:image/png;base64,' + base64.b64encode(b).decode()


def write_site(root):
    qr = data_url(png(60, 60, lambda x, y: (x * y) % 256))
    face = data_url(png(40, 40, lambda x, y: 255 if (x // 5 + y // 5) % 2 else 0))
    # 照真的抖音（2026-10 截的图）做：8 秒后当作扫过码，登录二维码那块还留在页面上，上面盖一层「身份验证」弹窗；
    # 选项是一整行可点的卡片（标题 + 小字说明），页面别处藏着一份同名的字；点「手机刷脸验证」3 秒后才出二维码，再 4 秒登录成功
    rows = [('接收短信验证码', ''), ('手机刷脸验证', '需**松本人操作'), ('验证登录密码', ''), ('发送短信验证', '')]
    cards = ''.join(f'<div class="card" data-k="{t}"><span class="ico">□</span><div><div class="t">{t}</div>'
                    f'<div class="sub">{sub}</div></div><span>›</span></div>' for t, sub in rows)
    with open(os.path.join(root, 'index.html'), 'w', encoding='utf-8') as f:
        f.write(f'''<!doctype html><meta charset=utf-8><title>抖音</title>
<style>#nav span{{cursor:pointer;margin:8px}}
.verify-modal-wrap{{position:fixed;inset:0;background:rgba(0,0,0,.6)}}
.verify-modal{{position:fixed;top:120px;left:380px;width:520px;padding:20px;background:#fff;border-radius:16px}}
.card{{cursor:pointer;display:flex;gap:10px;padding:14px;margin:8px 0;background:#f4f4f4;border-radius:8px}}
.sub{{font-size:12px;color:#999}}</style>
<div id="nav"><span>首页</span><span>推荐</span></div>
<div style="display:none"><span>手机刷脸验证</span></div>
<div id="login-panel-new"><div id="animate_qrcode_container" style="width:200px;height:200px"><img src="{qr}" width=180 height=180></div><p>验证码登录</p></div>
<script>
setTimeout(() => {{
  const wrap = document.createElement('div'); wrap.className = 'verify-modal-wrap';
  wrap.innerHTML = '<div class="verify-modal"><h3>身份验证</h3><p>为保障账号安全，请先完成身份验证，以确保为本人操作</p>{cards}</div>';
  document.body.appendChild(wrap);
  wrap.querySelector('[data-k="手机刷脸验证"]').onclick = () => {{
    const m = wrap.querySelector('.verify-modal');
    m.innerHTML = '<h3>手机刷脸验证</h3><p>正在生成二维码…</p>';
    setTimeout(() => {{
      m.innerHTML = '<h3>手机刷脸验证</h3><p>请使用抖音 App 扫码，完成刷脸</p><img src="{face}" width=180 height=180>';
      setTimeout(() => {{ document.cookie = 'sessionid=abc; path=/'; localStorage.setItem('HasUserLogin', '1'); wrap.remove(); }}, 4000);
    }}, 3000);
  }};
}}, 8000);
</script>''')
    with open(os.path.join(root, 'self.html'), 'w', encoding='utf-8') as f:
        f.write(f'<!doctype html><meta charset=utf-8><title>冒烟号的抖音 - 抖音</title>'
                f'<script>fetch("/aweme/v1/web/aweme/post/?sec_user_id={SEC}&count=18")</script>')


async def run(mc_dir, mc_py, base):
    from jobs import follow, parse_event  # 和线上一样：事件走单独的文件，一直读它新增的行
    work = tempfile.mkdtemp(prefix='smoke-mc-')  # 用一份空的浏览器档案，不碰真的
    os.symlink(os.path.join(mc_dir, 'libs'), os.path.join(work, 'libs'))
    events = os.path.join(work, 'events.jsonl')
    env = {**os.environ, 'DY_LOGIN_INDEX': base + 'index.html', 'DY_LOGIN_SELF': base + 'self.html',
           'DY_LOGIN_EVENTS': events, 'PYTHONUNBUFFERED': '1'}
    p = await asyncio.create_subprocess_exec('xvfb-run', '-a', mc_py, os.path.join(HERE, 'dy_login.py'), cwd=work, env=env,
                                             stdin=asyncio.subprocess.PIPE, stdout=asyncio.subprocess.PIPE,
                                             stderr=asyncio.subprocess.STDOUT, limit=4 << 20)
    logs = []

    async def drain():
        while True:
            line = await p.stdout.readline()
            if not line:
                return
            logs.append(line.decode('utf-8', 'replace').rstrip())
    drained = asyncio.create_task(drain())
    exited = asyncio.create_task(p.wait())
    seen = []
    try:
        async for line in follow(events, exited, 0.1):
            ev = parse_event(line)
            assert ev, f'读不出来的事件：{line[:200]}'
            seen.append(ev['event'])
            print(ev['event'], {k: (f'<{len(v)} 字>' if k == 'png' and v else v) for k, v in ev.items() if k != 'event'})
            if ev['event'] == 'verify':
                # 只要弹窗里的卡片标题：导航栏、小字说明都不算
                assert ev['options'] == ['接收短信验证码', '手机刷脸验证', '验证登录密码', '发送短信验证'], ev['options']
                p.stdin.write('手机刷脸验证\n'.encode())
                await p.stdin.drain()
            if ev['event'] == 'ok':
                assert ev['sec_uid'] == SEC and ev['nickname'] == '冒烟号'
        await drained
    finally:
        shutil.rmtree(work, ignore_errors=True)
    if seen != ['qr', 'verify', 'verify_qr', 'status', 'ok']:
        print('\n'.join(logs[-30:]))
    assert seen == ['qr', 'verify', 'verify_qr', 'status', 'ok'], seen
    print('✓ 冒烟测试通过')


def main():
    mc_dir, mc_py = sys.argv[1], sys.argv[2]
    site = tempfile.mkdtemp(prefix='smoke-site-')
    write_site(site)
    class Quiet(http.server.SimpleHTTPRequestHandler):
        def log_message(self, *args):
            pass

    handler = functools.partial(Quiet, directory=site)
    server = http.server.ThreadingHTTPServer(('127.0.0.1', 0), handler)
    threading.Thread(target=server.serve_forever, daemon=True).start()
    try:
        asyncio.run(run(os.path.abspath(mc_dir), mc_py, f'http://127.0.0.1:{server.server_port}/'))
    finally:
        server.shutdown()
        shutil.rmtree(site, ignore_errors=True)


if __name__ == '__main__':
    main()
