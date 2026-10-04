"""ks_login.py 的冒烟测试：假的快手首页（点「登录」→ 二维码 → 过期刷新 → 扫码成功写 cookie）在虚拟屏幕里真跑一遍。

  python smoke_ks_login.py <有 Playwright 的 python>
"""

import http.server
import json
import os
import subprocess
import sys
import tempfile
import threading

HERE = os.path.dirname(os.path.abspath(__file__))
QR = 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg=='
PAGE = """<!doctype html><meta charset=utf-8><title>快手</title>
<header><p id=login style="cursor:pointer">登录</p><a href="/profile/3x84qugg4ch9zhs">快手小橘</a></header>
<div id=box style="display:none"><div class=qrcode-img><img width=160 height=160 src="data:image/png;base64,%s"></div><span id=tip></span></div>
<script>
document.getElementById('login').onclick = () => {
  document.getElementById('box').style.display = 'block';
  // 先过期一次（看会不会刷新、再发），刷新后 3 秒「扫码成功」
  setTimeout(() => { document.getElementById('tip').textContent = '二维码已失效，点击刷新'; }, 2500);
  document.getElementById('tip').onclick = () => {
    document.getElementById('tip').textContent = '';
    setTimeout(() => { document.cookie = 'passToken=pt; path=/'; document.cookie = 'userId=2771234567; path=/'; }, 3000);
  };
};
</script>""" % QR


class H(http.server.BaseHTTPRequestHandler):
    def do_GET(self):
        self.send_response(200)
        self.send_header('Content-Type', 'text/html; charset=utf-8')
        self.end_headers()
        self.wfile.write(PAGE.encode())

    def log_message(self, *a):
        pass


def main(py):
    srv = http.server.ThreadingHTTPServer(('127.0.0.1', 0), H)
    threading.Thread(target=srv.serve_forever, daemon=True).start()
    base = f'http://127.0.0.1:{srv.server_port}'
    work = tempfile.mkdtemp()
    events = os.path.join(work, 'ev.jsonl')
    env = {**os.environ, 'KS_LOGIN_INDEX': base + '/?isHome=1', 'KS_COOKIE_URL': base, 'KS_COOKIE_DOMAIN': '127.0.0.1',
           'DY_LOGIN_EVENTS': events, 'PYTHONPATH': HERE}
    subprocess.run(['xvfb-run', '-a', py, os.path.join(HERE, 'ks_login.py')], cwd=work, env=env, timeout=120, check=False,
                   stdin=subprocess.DEVNULL)
    evs = [json.loads(line) for line in open(events, encoding='utf-8')]
    kinds = [e['event'] for e in evs]
    print(kinds)
    assert kinds.count('qr') == 2, kinds  # 第一次 + 过期刷新后
    ok = evs[-1]
    assert ok['event'] == 'ok', ok
    assert ok['sec_uid'] == '2771234567' and ok['nickname'] == '快手小橘', ok
    assert {c['name'] for c in ok['cookies']} >= {'passToken', 'userId'}, ok['cookies']
    print('ks_login 冒烟测试通过')


if __name__ == '__main__':
    main(sys.argv[1])
