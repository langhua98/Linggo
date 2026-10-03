#!/usr/bin/env bash
# 小橘 · Codespaces 打开后连上小橘、守着机器人的指令（devcontainer 的 postAttachCommand 调用）。
# 第一次还没有令牌：拿 Codespaces 自带的 GitHub 令牌找小橘领（领不到才提示粘贴机器人「云电脑」给的命令，
# 即 bash codespace-auto.sh <令牌> <账号,…>）。开机**不自己抓**：频道主在机器人里点「▶️ 运行爬虫」才跑 crawl.sh；
# 「搜抖音 关键词」排了词就跑 search.sh。MediaCrawler 会记住登录状态，没过期就连码都不用扫。
set -uo pipefail
HERE="$(cd "$(dirname "$0")" && pwd)"
# 先把仓库更新到最新（修好的问题马上用上，频道主不用自己敲 git pull）；本脚本变了就用新的重跑一次
if [ -z "${XIAOJU_UPDATED:-}" ]; then
  before=$(sha1sum "$0" 2>/dev/null)
  git -C "$HERE" pull --ff-only -q >/dev/null 2>&1 || true
  [ "$(sha1sum "$0" 2>/dev/null)" != "$before" ] && XIAOJU_UPDATED=1 exec bash "$0" "$@"
fi
API=https://xiaoju-music.langhua98.workers.dev
# 粘贴机器人「云电脑」给的命令：带着令牌和账号，记下来
if [ $# -ge 2 ]; then
  mkdir -p "$HOME/.xiaoju"
  printf 'TOKEN=%q\nCREATORS=%q\nAPI=%q\n' "$1" "$2" "${3:-$API}" > "$HOME/.xiaoju/env"
  chmod 600 "$HOME/.xiaoju/env"
fi
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
flock -n 9 || { echo "== 已经连上小橘了，在等机器人的指令（点「▶️ 运行爬虫」开始抓）=="; exit 0; }
source "$HOME/.xiaoju/env"
# 每 ${XJ_WATCH_EVERY:-20} 秒问一次小橘：点了「运行爬虫」就抓，排了「搜抖音」的词就搜。
# 没成（登录过期之类）等 10 分钟再看，别一直刷
echo "== 小橘：云电脑连上了，不会自己抓。在机器人里点「▶️ 运行爬虫」开始抓，发「搜抖音 关键词」开始搜 =="
while :; do
  CFG=$(curl -sS -m 20 -X POST -H "X-Token: $TOKEN" "$API/dy-cloud-config" 2>/dev/null)
  RUN=$(printf '%s' "$CFG" | python3 -c 'import json,sys; print(1 if json.load(sys.stdin).get("crawl") else "")' 2>/dev/null)
  Q=$(printf '%s' "$CFG" | python3 -c 'import json,sys; print(",".join(json.load(sys.stdin).get("searches") or []))' 2>/dev/null)
  ok=1
  if [ -n "$RUN" ]; then
    echo "== 你在机器人里点了运行爬虫，开始抓。要扫码的话去「桌面」那个标签页 =="
    bash "$HERE/crawl.sh" || ok=""
  fi
  if [ -n "$ok" ] && [ -n "$Q" ]; then
    XJ_QUIET_EMPTY=1 bash "$HERE/search.sh" || ok=""
  fi
  if [ -z "$ok" ]; then
    echo "== 这次没成，10 分钟后再看（登录过期的话去「桌面」标签页扫码）=="
    sleep 600
  elif [ -n "$RUN$Q" ]; then
    echo "== 好了，接着等机器人的指令 =="
  fi
  sleep "${XJ_WATCH_EVERY:-20}"
done
