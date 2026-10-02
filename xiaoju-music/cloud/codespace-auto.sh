#!/usr/bin/env bash
# 小橘 · Codespaces 一打开就自动抓（devcontainer 的 postAttachCommand 调用）。
# 第一次还没有令牌：拿 Codespaces 自带的 GitHub 令牌找小橘领（领不到才提示粘贴机器人「云电脑」给的命令）；
# 有了令牌（存进 ~/.xiaoju/env）以后，每次打开这台云电脑都自动跑 crawl.sh。MediaCrawler 会记住登录状态，没过期就连码都不用扫。
set -uo pipefail
HERE="$(cd "$(dirname "$0")" && pwd)"
# 先把仓库更新到最新（修好的问题马上用上，频道主不用自己敲 git pull）；本脚本变了就用新的重跑一次
if [ -z "${XIAOJU_UPDATED:-}" ]; then
  before=$(sha1sum "$0" 2>/dev/null)
  git -C "$HERE" pull --ff-only -q >/dev/null 2>&1 || true
  [ "$(sha1sum "$0" 2>/dev/null)" != "$before" ] && XIAOJU_UPDATED=1 exec bash "$0" "$@"
fi
API=https://xiaoju-music.langhua98.workers.dev
if [ ! -s "$HOME/.xiaoju/env" ] && [ -n "${GITHUB_TOKEN:-}" ]; then
  # 第一次：用 Codespaces 自带的 GitHub 令牌找小橘领上传令牌和抖音账号（手机网页版终端粘贴不了）
  CFG=$(curl -sS -X POST -H "Authorization: Bearer $GITHUB_TOKEN" "$API/dy-cloud-config" || true)
  TOK=$(printf '%s' "$CFG" | python3 -c 'import json,sys; print(json.load(sys.stdin).get("token",""))' 2>/dev/null)
  IDS=$(printf '%s' "$CFG" | python3 -c 'import json,sys; print(json.load(sys.stdin).get("creators",""))' 2>/dev/null)
  if [ -n "$TOK" ] && [ -n "$IDS" ]; then
    mkdir -p "$HOME/.xiaoju"
    printf 'TOKEN=%q\nCREATORS=%q\nAPI=%q\n' "$TOK" "$IDS" "$API" > "$HOME/.xiaoju/env"
    chmod 600 "$HOME/.xiaoju/env"
  else
    echo "== 没领到口令：$CFG =="
  fi
fi
if [ ! -s "$HOME/.xiaoju/env" ]; then
  echo "== 第一次用：在 Telegram 给小橘发「云电脑」，把第二条消息粘贴到下面的终端里回车 =="
  exit 0
fi
[ -d "$HOME/MediaCrawler" ] || bash "$HERE/codespace-setup.sh"
# 重新连上网页也会触发一次，同一时间只跑一个
exec 9>"$HOME/.xiaoju/lock"
flock -n 9 || { echo "== 已经在抓了 =="; exit 0; }
echo "== 小橘：开始抓。要扫码的话去「桌面」那个标签页 =="
bash "$HERE/crawl.sh"
# 机器人里「搜抖音 关键词」排了队的话，接着搜（没有就不出声）
XJ_QUIET_EMPTY=1 bash "$HERE/search.sh"
