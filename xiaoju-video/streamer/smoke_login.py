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
    # 8 秒后当作扫过码：登录面板没了，弹出身份验证；点「刷脸验证」出二维码，4 秒后登录成功
    with open(os.path.join(root, 'index.html'), 'w', encoding='utf-8') as f:
        f.write(f'''<!doctype html><meta charset=utf-8><title>抖音</title>
<style>#nav span{{cursor:pointer;margin:8px}}.modal{{position:fixed;top:120px;left:400px;width:360px;padding:20px;border:1px solid #333}}</style>
<div id="nav"><span>首页</span><span>推荐</span></div>
<div id="login-panel-new"><div id="animate_qrcode_container" style="width:200px;height:200px"><img src="{qr}" width=180 height=180></div><p>验证码登录</p></div>
<script>
setTimeout(() => {{
  document.getElementById('login-panel-new').remove();
  const m = document.createElement('div'); m.className = 'modal'; m.setAttribute('role', 'dialog');
  m.innerHTML = '<h3>身份验证</h3><p>请选择验证方式</p><button id=face>刷脸验证</button><button>短信验证</button>';
  document.body.appendChild(m);
  document.getElementById('face').onclick = () => {{
    m.innerHTML = '<h3>身份验证</h3><img src="{face}" width=160 height=160><button>换一种方式</button>';
    setTimeout(() => {{ document.cookie = 'sessionid=abc; path=/'; localStorage.setItem('HasUserLogin', '1'); m.remove(); }}, 4000);
  }};
}}, 8000);
</script>''')
    with open(os.path.join(root, 'self.html'), 'w', encoding='utf-8') as f:
        f.write(f'<!doctype html><meta charset=utf-8><title>冒烟号的抖音 - 抖音</title>'
                f'<script>fetch("/aweme/v1/web/aweme/post/?sec_user_id={SEC}&count=18")</script>')


async def run(mc_dir, mc_py, base):
    work = tempfile.mkdtemp(prefix='smoke-mc-')  # 用一份空的浏览器档案，不碰真的
    os.symlink(os.path.join(mc_dir, 'libs'), os.path.join(work, 'libs'))
    env = {**os.environ, 'DY_LOGIN_INDEX': base + 'index.html', 'DY_LOGIN_SELF': base + 'self.html', 'PYTHONUNBUFFERED': '1'}
    p = await asyncio.create_subprocess_exec('xvfb-run', '-a', mc_py, os.path.join(HERE, 'dy_login.py'), cwd=work, env=env,
                                             stdin=asyncio.subprocess.PIPE, stdout=asyncio.subprocess.PIPE,
                                             stderr=asyncio.subprocess.PIPE, limit=32 << 20)  # 和线上一样：浏览器日志单独一路

    async def drain():
        while await p.stderr.readline():
            pass
    errs = asyncio.create_task(drain())
    seen = []
    try:
        while True:
            line = await asyncio.wait_for(p.stdout.readline(), 90)
            if not line:
                break
            try:
                ev = json.loads(line)
            except ValueError:
                continue
            seen.append(ev['event'])
            print(ev['event'], {k: (f'<{len(v)} 字>' if k == 'png' else v) for k, v in ev.items() if k != 'event'})
            if ev['event'] == 'verify':
                assert ev['options'] == ['刷脸验证', '短信验证'], ev['options']  # 只要弹窗里的，导航栏不算
                p.stdin.write('刷脸验证\n'.encode())
                await p.stdin.drain()
            if ev['event'] == 'ok':
                assert ev['sec_uid'] == SEC and ev['nickname'] == '冒烟号'
        await p.wait()
        await errs
    finally:
        shutil.rmtree(work, ignore_errors=True)
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
