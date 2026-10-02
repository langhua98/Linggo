#!/usr/bin/env bash
# 小橘 · 抓自己抖音账号的全部作品，抓完自动发给小橘（由 setup.sh 放到 ~/.xiaoju/，桌面图标调用）
set -uo pipefail
HERE="$(cd "$(dirname "$0")" && pwd)"
# 带参数（Codespaces：bash crawl.sh <令牌> <账号1,账号2>）就记下来；不带就用 setup.sh 存的
if [ $# -ge 2 ]; then
  mkdir -p "$HOME/.xiaoju"
  printf 'TOKEN=%q\nCREATORS=%q\nAPI=%q\n' "$1" "$2" "${3:-https://xiaoju-music.langhua98.workers.dev}" > "$HOME/.xiaoju/env"
  chmod 600 "$HOME/.xiaoju/env"
fi
source "$HOME/.xiaoju/env"
export PATH="$HOME/.local/bin:$PATH"
export DISPLAY="${DISPLAY:-:1}"  # 浏览器开在桌面上（Codespaces 的网页桌面是 :1）
[ -S /tmp/.X11-unix/X1 ] && export DISPLAY=:1  # 有网页桌面就一定开在它上面，别开到看不见的地方
# MediaCrawler 的浏览器页面是 1920×1080，网页桌面默认比它小：页面一半在屏幕外，抖音的验证框就点不到。把桌面放大到装得下
command -v xrandr >/dev/null 2>&1 || sudo DEBIAN_FRONTEND=noninteractive apt-get install -y x11-xserver-utils >/dev/null 2>&1 || true
xrandr --fb 1920x1200 >/dev/null 2>&1 || xrandr -s 1920x1200 >/dev/null 2>&1 || true
OUT="$HOME/douyin-data"
rm -rf "$OUT" && mkdir -p "$OUT"
cd "$HOME/MediaCrawler" || { echo "没找到 MediaCrawler，重新运行一次安装命令"; exit 1; }

# MediaCrawler 用 execjs 跑抖音的签名脚本，要有 Node.js（Codespaces 的 Python 镜像里没有）
command -v node >/dev/null 2>&1 || { echo "== 先装 Node.js（一两分钟）=="; sudo apt-get update -y || true; sudo DEBIAN_FRONTEND=noninteractive apt-get install -y nodejs; }
# MediaCrawler 默认 CDP 模式要找本机装的 Chrome/Edge，云电脑上没有，浏览器就起不来；改用它自己装的 Chromium
sed -i 's/^ENABLE_CDP_MODE = True/ENABLE_CDP_MODE = False/' config/base_config.py
# 抖音首页打开后会自己再跳一次（反爬检查），MediaCrawler 没等跳完就读页面，报 Execution context was destroyed；
# 让它打开首页后等页面稳定（最多 20 秒）再往下走
python3 - <<'PY'
p = 'media_platform/douyin/core.py'
s = open(p, encoding='utf-8').read()
old = 'await self.context_page.goto(self.index_url)\n'
if '# xiaoju: settle' not in s and old in s:
    i = s.index(old)
    pad = s[s.rindex('\n', 0, i) + 1:i]
    s = s.replace(old, old + pad + '# xiaoju: settle\n'
                  + pad + 'try:\n' + pad + '    await self.context_page.wait_for_load_state("networkidle", timeout=20000)\n'
                  + pad + 'except Exception:\n' + pad + '    pass\n' + pad + 'await asyncio.sleep(3)\n', 1)
    open(p, 'w', encoding='utf-8').write(s)

# 抖音改过页面，MediaCrawler 自己点「登录」、找二维码常找不到，一找不到就退出。改成找不到也不退：
# 提示频道主在桌面的浏览器里自己点登录、扫码；check_login_state 原来只等 10 分钟，抖音常要再做身份验证，放宽到 30 分钟
p = 'media_platform/douyin/login.py'
s = open(p, encoding='utf-8').read()
if '# xiaoju: manual' not in s:
    note = 'print("\\n== 小橘：请在「桌面」的浏览器里自己点右上角「登录」，用抖音扫码（要验证就在那里做）。最多等 30 分钟 ==\\n", flush=True)'
    for old in ('await self.popup_login_dialog()\n', 'await self.login_by_qrcode()\n'):
        if old in s:
            i = s.index(old)
            pad = s[s.rindex('\n', 0, i) + 1:i]
            s = s.replace(old, '# xiaoju: manual\n' + pad + 'try:\n' + pad + '    ' + old + pad
                          + 'except (Exception, SystemExit):\n' + pad + '    ' + note + '\n', 1)
s = s.replace('最多等 10 分钟', '最多等 30 分钟')
s = s.replace('stop=stop_after_attempt(600), wait=wait_fixed(1)', 'stop=stop_after_attempt(1800), wait=wait_fixed(1)')
open(p, 'w', encoding='utf-8').write(s)
PY

# 浏览器窗口常开在屏幕外一半：抓的时候后台隔几秒把它摆回屏幕里（最多 30 分钟）
WIN="$HERE/win.sh"
( for _ in $(seq 360); do sleep 5; bash "$WIN" quiet; done ) >/dev/null 2>&1 &
WINLOOP=$!
trap 'kill $WINLOOP 2>/dev/null' EXIT

echo "== 马上会弹出浏览器，用抖音 App 扫码登录（要验证就在浏览器里完成）=="
uv run main.py --platform dy --lt qrcode --type creator --creator_id "$CREATORS" \
  --get_comment no --get_sub_comment no --get_media no --headless no \
  --save_data_option jsonl --crawler_max_notes_count 1000 --save_data_path "$OUT"

FILE=$(find "$OUT" -name 'creator_contents_*.jsonl' -printf '%T@ %p\n' 2>/dev/null | sort -nr | head -1 | cut -d' ' -f2-)
if [ -z "$FILE" ] || [ ! -s "$FILE" ]; then
  echo "== 没抓到作品（登录没成功？）。关掉这个窗口，再双击图标重来一次 =="
  exit 1
fi
echo "== 抓到 $(wc -l < "$FILE") 条，发给小橘 =="
curl -sS -X POST -H "X-Token: $TOKEN" -H 'Content-Type: text/plain; charset=utf-8' --data-binary @"$FILE" "$API/dy-import"
echo
echo "== 好了。作品会陆续转进「小橘视频」，转完机器人会通知你。这个窗口可以关了 =="
