#!/usr/bin/env bash
# 小橘视频 · 云电脑入口。在 Codespaces（.devcontainer/xiaoju-video）的终端里：
#   bash xiaoju-video/cloud/run.sh install                    装 Playwright 和 Chromium（建 Codespace 时自动跑过）
#   bash xiaoju-video/cloud/run.sh setup <Worker 地址> <令牌>  令牌在小橘视频机器人里发「云电脑」拿
#   bash xiaoju-video/cloud/run.sh login                      在网页桌面（端口 6080，密码 vscode）里扫码登录抖音
#   bash xiaoju-video/cloud/run.sh sync                       同步你自己账号的全部作品
set -euo pipefail
HERE="$(cd "$(dirname "$0")" && pwd)"
VENV="$HOME/.xiaoju-video/venv"

install() {
  mkdir -p "$HOME/.xiaoju-video"
  [ -x "$VENV/bin/python" ] || python3 -m venv "$VENV"
  "$VENV/bin/pip" install -q --upgrade pip
  "$VENV/bin/pip" install -q "playwright>=1.45,<2"
  "$VENV/bin/python" -m playwright install --with-deps chromium
}

cmd="${1:-}"
if [ "$cmd" = install ]; then install; exit 0; fi
[ -x "$VENV/bin/python" ] || install
# 网页桌面（desktop-lite）的显示器是 :1
if [ -z "${DISPLAY:-}" ] && [ -S /tmp/.X11-unix/X1 ]; then export DISPLAY=:1; fi
exec "$VENV/bin/python" "$HERE/douyin_self.py" "$@"
