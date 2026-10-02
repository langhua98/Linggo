#!/usr/bin/env bash
# 小橘 · 抓自己抖音账号的全部作品，抓完自动发给小橘（由 setup.sh 放到 ~/.xiaoju/，桌面图标调用）
set -uo pipefail
# 带参数（Codespaces：bash crawl.sh <令牌> <账号1,账号2>）就记下来；不带就用 setup.sh 存的
if [ $# -ge 2 ]; then
  mkdir -p "$HOME/.xiaoju"
  printf 'TOKEN=%q\nCREATORS=%q\nAPI=%q\n' "$1" "$2" "${3:-https://xiaoju-music.langhua98.workers.dev}" > "$HOME/.xiaoju/env"
  chmod 600 "$HOME/.xiaoju/env"
fi
source "$HOME/.xiaoju/env"
export PATH="$HOME/.local/bin:$PATH"
export DISPLAY="${DISPLAY:-:1}"  # 浏览器开在桌面上（Codespaces 的网页桌面是 :1）
OUT="$HOME/douyin-data"
rm -rf "$OUT" && mkdir -p "$OUT"
cd "$HOME/MediaCrawler" || { echo "没找到 MediaCrawler，重新运行一次安装命令"; exit 1; }

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
