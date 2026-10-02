#!/usr/bin/env bash
# 小橘 · Codespaces 一打开就自动抓（devcontainer 的 postAttachCommand 调用）。
# 第一次还没有令牌：只提示去粘贴机器人「云电脑」给的命令；粘贴过一次（存进 ~/.xiaoju/env）以后，
# 每次打开这台云电脑都自动跑 crawl.sh。MediaCrawler 会记住登录状态，没过期就连码都不用扫。
set -uo pipefail
HERE="$(cd "$(dirname "$0")" && pwd)"
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
