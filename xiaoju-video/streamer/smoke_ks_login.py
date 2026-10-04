"""ks_login.py 的冒烟测试：假的快手首页在虚拟屏幕里真跑一遍——
先弹拼图滑块（在 iframe 里，拼图块走得比按钮快 1.1 倍，差 4 像素以上不算过）→ 点「登录」→ 二维码 → 过期刷新 → 扫码成功写 cookie。

  python smoke_ks_login.py <有 Playwright 和 OpenCV 的 python>
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
<div id=cap style="position:fixed;left:400px;top:200px;background:#fff;padding:12px;border:1px solid #999">
<iframe src="/captcha" style="width:320px;height:240px;border:0"></iframe></div>
<div id=box style="display:none"><div class=qrcode-img><img width=160 height=160 src="data:image/png;base64,%s"></div><span id=tip></span></div>
<script>
window.tries = [];
addEventListener('message', e => { window.tries.push(e.data); if (e.data === 'pass') document.getElementById('cap').remove(); });
document.getElementById('login').onclick = () => {
  if (document.getElementById('cap')) return;  // 滑块没过不让登录
  document.getElementById('box').style.display = 'block';
  // 先过期一次（看会不会刷新、再发），刷新后 3 秒「扫码成功」
  setTimeout(() => { document.getElementById('tip').textContent = '二维码已失效，点击刷新'; }, 2500);
  document.getElementById('tip').onclick = () => {
    document.getElementById('tip').textContent = '';
    setTimeout(() => { document.cookie = 'passToken=pt; path=/'; document.cookie = 'userId=2771234567; path=/'; }, 3000);
  };
};
</script>""" % QR


def puzzle():
    """600×300 的背景（有纹理），(420, 110) 挖一个 80×80 的缺口；拼图块是那一块原图，带透明边"""
    import cv2
    import numpy as np
    rng = np.random.default_rng(7)
    img = np.zeros((300, 600, 3), np.uint8)
    for _ in range(60):
        c = tuple(int(v) for v in rng.integers(0, 255, 3))
        cv2.circle(img, (int(rng.integers(0, 600)), int(rng.integers(0, 300))), int(rng.integers(10, 60)), c, -1)
    img = cv2.GaussianBlur(img, (5, 5), 0)
    x, y, n = 420, 110, 80
    piece = np.zeros((n + 4, n + 4, 4), np.uint8)
    piece[2:-2, 2:-2, :3] = img[y:y + n, x:x + n]
    piece[2:-2, 2:-2, 3] = 255
    cv2.rectangle(piece, (2, 2), (n + 1, n + 1), (255, 255, 255, 255), 2)
    hole = img[y:y + n, x:x + n].astype(float) * 0.35
    img[y:y + n, x:x + n] = hole.astype(np.uint8)
    cv2.rectangle(img, (x, y), (x + n - 1, y + n - 1), (255, 255, 255), 2)
    return cv2.imencode('.png', img)[1].tobytes(), cv2.imencode('.png', piece)[1].tobytes()


BG, PIECE = puzzle()
IMPOSSIBLE = False  # 测「怎么拖都不过」：放弃、告诉频道主、记下滑块的页面结构
CAPTCHA = """<!doctype html><meta charset=utf-8><body style="margin:0;font:14px sans-serif">
<p>Please complete security verification</p>
<div id=wrap style="position:relative;width:300px;height:150px">
  <img id=bg src="/bg.png" style="width:300px;height:150px;display:block">
  <img id=pc src="/piece.png" style="position:absolute;left:0;top:54px;width:42px;height:42px">
</div>
<div style="position:relative;width:300px;height:40px;margin-top:8px;background:#eee">
  <div id=hd class="slider-btn" style="position:absolute;left:0;top:0;width:40px;height:40px;background:#fff;border:1px solid #ccc;text-align:center;line-height:40px">&gt;&gt;</div>
  <span style="margin-left:60px;line-height:40px">Drag to right to fill the puzzle</span>
</div>
<script>
const TOL = %TOL%;
const hd = document.getElementById('hd'), pc = document.getElementById('pc');
let x0 = null;
hd.addEventListener('mousedown', e => { x0 = e.clientX; });
addEventListener('mousemove', e => { if (x0 === null) return; const d = Math.max(0, e.clientX - x0);
  hd.style.left = d + 'px'; pc.style.left = (d * 1.1) + 'px'; });
addEventListener('mouseup', () => { if (x0 === null) return; x0 = null;
  const at = parseFloat(pc.style.left || 0);
  const ok = Math.abs(at - 210) <= TOL;
  parent.postMessage(ok ? 'pass' : 'fail:' + at, '*');
  if (!ok) { hd.style.left = '0px'; pc.style.left = '0px'; } });
</script>"""


class H(http.server.BaseHTTPRequestHandler):
    def do_GET(self):
        path = self.path.split('?')[0]
        body, ctype = {'/bg.png': (BG, 'image/png'), '/piece.png': (PIECE, 'image/png'),
                       '/captcha': (CAPTCHA.replace('%TOL%', '-1' if IMPOSSIBLE else '4').encode(), 'text/html; charset=utf-8')}.get(path, (PAGE.encode(), 'text/html; charset=utf-8'))
        self.send_response(200)
        self.send_header('Content-Type', ctype)
        self.end_headers()
        self.wfile.write(body)

    def log_message(self, *a):
        pass


def run(py, impossible):
    global IMPOSSIBLE
    IMPOSSIBLE = impossible
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
    if impossible:
        assert kinds[-1] == 'error' and '自动拖了几次没过' in evs[-1]['text'] and evs[-1]['png'], evs[-1].get('text')
        dbg = [e for e in evs if e['event'] == 'debug']
        assert dbg and dbg[0]['what'] == 'ks_slider' and 'slider-btn' in dbg[0]['html'], dbg
        assert 'qr' not in kinds
        print('滑块过不去：放弃、报错、记下页面结构 —— 通过')
        return
    assert '快手弹了拼图滑块验证，正在自动拖…' in [e.get('text') for e in evs], evs
    assert '拼图滑块过了' in [e.get('text') for e in evs], [e.get('text') for e in evs]
    assert kinds.count('qr') == 2, kinds  # 第一次 + 过期刷新后
    ok = evs[-1]
    assert ok['event'] == 'ok', ok
    assert ok['sec_uid'] == '2771234567' and ok['nickname'] == '快手小橘', ok
    assert {c['name'] for c in ok['cookies']} >= {'passToken', 'userId'}, ok['cookies']
    print('滑块 + 扫码登录 —— 通过')


def main(py):
    run(py, False)
    run(py, True)
    print('ks_login 冒烟测试通过')


if __name__ == '__main__':
    main(sys.argv[1])
