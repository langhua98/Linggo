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
API=https://xiaoju-video.langhua98.workers.dev
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
LOG="$HOME/.xiaoju/watch.log"
if [ "${1:-}" != "--watch" ]; then
  # 守着机器人指令的那个进程不挂在终端上（setsid）：关掉终端、网页断开、手机切走都照常等；同一时间只跑一个
  if flock -n "$HOME/.xiaoju/lock" true; then
    setsid nohup bash "$0" --watch >> "$LOG" 2>&1 < /dev/null &
    sleep 1
  fi
  echo "== 小橘：云电脑连上了，不会自己抓。在机器人里点「▶️ 运行爬虫」开始抓，发「搜抖音 关键词」开始搜 =="
  echo "== 下面是云电脑的记录（关掉这个终端不影响；要扫码的话去「桌面」标签页）=="
  exec tail -n 30 -f "$LOG"
fi
exec 9>"$HOME/.xiaoju/lock"
flock -n 9 || exit 0
source "$HOME/.xiaoju/env"
# 每 ${XJ_WATCH_EVERY:-20} 秒问一次小橘（不管在不在抓、在不在搜，都照常来问，机器人据此说云电脑在不在、在干什么）：
# 点了「运行爬虫」就抓，排了「搜抖音」的词就搜。抓和搜都在后台跑；两个不能同时跑（共用同一个登录抖音的浏览器），
# 搜索优先：正在抓的时候有词要搜，先让抓取停一下（已经抓到的先送给小橘），搜完自动接着抓（只抓频道里还没有的）。
# 没成（登录过期之类）同一个词、同一次抓取 10 分钟内不再试，发新的词、重新点「运行爬虫」马上做。
# 每 10 分钟拉一次仓库，脚本改了就换新的接着守（不用刷新网页；正在抓、正在搜时等它做完再换）
echo "== $(date '+%F %T') 开始等机器人的指令 =="
YIELDF="$HOME/.xiaoju/yield"; rm -f "$YIELDF"
CRAWL=""; SEARCH=""; SEARCHING=""; WANT_CRAWL=""; CRAWL_AFTER=0; SEARCH_AFTER=0; FAILED_Q=""; TICK=0
alive() { [ -n "$1" ] && kill -0 "$1" 2>/dev/null; }
while :; do
  now=$(date +%s)
  if [ -n "$CRAWL" ] && ! alive "$CRAWL"; then
    wait "$CRAWL"; rc=$?; CRAWL=""
    if [ "$rc" = 3 ]; then WANT_CRAWL=1  # 给搜索让路停下的：搜完接着抓
    elif [ "$rc" != 0 ]; then CRAWL_AFTER=$((now + 600)); echo "== 这次没抓成，10 分钟内不再自动重抓（登录过期的话去「桌面」标签页扫码；在机器人里再点「运行爬虫」马上重来）=="
    else echo "== $(date '+%F %T') 抓完了，接着等机器人的指令 =="; fi
  fi
  if [ -n "$SEARCH" ] && ! alive "$SEARCH"; then
    wait "$SEARCH"; rc=$?; SEARCH=""
    if [ "$rc" != 0 ]; then SEARCH_AFTER=$((now + 600)); FAILED_Q="$SEARCHING"; echo "== 这次没搜成，10 分钟后再搜（登录过期的话去「桌面」标签页扫码；发新的词马上搜）=="
    else FAILED_Q=""; echo "== $(date '+%F %T') 搜完了，接着等机器人的指令 =="; fi
  fi
  BUSY=idle
  [ -n "$CRAWL" ] && BUSY=crawl
  [ -n "$SEARCH" ] && BUSY=search
  [ "$BUSY" = idle ] && [ "$SEARCH_AFTER" -gt "$now" ] && BUSY="wait:$((SEARCH_AFTER - now))"
  CFG=$(curl -sS -m 20 -X POST -H "X-Token: $TOKEN" -H "X-Busy: $BUSY" "$API/dy-cloud-config" 2>/dev/null)
  RUN=$(printf '%s' "$CFG" | python3 -c 'import json,sys; print(1 if json.load(sys.stdin).get("crawl") else "")' 2>/dev/null)
  Q=$(printf '%s' "$CFG" | python3 -c 'import json,sys; print(",".join(json.load(sys.stdin).get("searches") or []))' 2>/dev/null)
  if [ -n "$RUN" ]; then WANT_CRAWL=1; CRAWL_AFTER=0; fi  # 机器人里刚点了「运行爬虫」：不管上次成没成都马上来
  [ -n "$Q" ] && [ "$Q" != "$FAILED_Q" ] && SEARCH_AFTER=0  # 排了新的词：马上搜
  if [ -n "$Q" ] && [ -z "$SEARCH" ] && [ "$now" -ge "$SEARCH_AFTER" ]; then
    if [ -n "$CRAWL" ]; then
      if [ ! -f "$YIELDF" ]; then
        echo "== $(date '+%F %T') 有词要搜（${Q//,/、}），抓取先停一下，已经抓到的送给小橘，搜完接着抓 =="
        touch "$YIELDF"
        pkill -f 'main.py --platform dy' 2>/dev/null
      fi
    else
      rm -f "$YIELDF"
      SEARCHING="$Q"
      echo "== $(date '+%F %T') 开始搜：${Q//,/、} =="
      XJ_QUIET_EMPTY=1 bash "$HERE/search.sh" &
      SEARCH=$!
    fi
  elif [ -n "$WANT_CRAWL" ] && [ -z "$CRAWL$SEARCH" ] && [ "$now" -ge "$CRAWL_AFTER" ]; then
    WANT_CRAWL=""
    echo "== $(date '+%F %T') 开始抓你登记过的抖音号（要扫码的话去「桌面」那个标签页）=="
    bash "$HERE/crawl.sh" &
    CRAWL=$!
  fi
  sleep "${XJ_WATCH_EVERY:-20}"
  TICK=$((TICK + 1))
  if [ $((TICK % 30)) = 0 ] && [ -z "${XJ_NO_PULL:-}" ] && [ -z "$CRAWL$SEARCH" ]; then
    before=$(sha1sum "$0" 2>/dev/null)
    git -C "$HERE" pull --ff-only -q >/dev/null 2>&1 || true
    if [ "$(sha1sum "$0" 2>/dev/null)" != "$before" ]; then
      echo "== 脚本更新了，换新的接着等 =="
      exec 9>&-
      XIAOJU_UPDATED=1 exec bash "$0" --watch
    fi
  fi
done
