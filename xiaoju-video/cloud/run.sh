#!/usr/bin/env bash
# 小橘视频 · 云电脑入口（MediaCrawler）。在 Codespaces（.devcontainer/xiaoju-video）的终端里：
#   bash xiaoju-video/cloud/run.sh install                                  装 MediaCrawler、uv、Chromium（建 Codespace 时自动跑过）
#   bash xiaoju-video/cloud/run.sh login                                    只登录抖音（网页桌面里扫码），登录状态存进 MediaCrawler 的浏览器档案
#   bash xiaoju-video/cloud/run.sh setup <Worker 地址> <令牌> <你的抖音主页链接>   令牌在小橘视频机器人里发「云电脑」拿
#   bash xiaoju-video/cloud/run.sh sync                                     抓你主页的全部作品，新的送 Worker
#   bash xiaoju-video/cloud/run.sh link <链接>...                            只抓这几条（你自己的或有授权的）
# 第一次 sync / link 要扫码：打开端口 6080 的网页桌面（密码 vscode），60 秒内用抖音 App 扫浏览器里的二维码。
set -euo pipefail
HERE="$(cd "$(dirname "$0")" && pwd)"
HOME_DIR="$HOME/.xiaoju-video"
MC="$HOME_DIR/MediaCrawler"
# 固定在验证过的版本，上游改了接口不会突然坏掉；要升级改这里
MC_REPO=https://github.com/NanmiCoder/MediaCrawler.git
MC_REV=bf28178

install() {
  mkdir -p "$HOME_DIR"
  command -v uv >/dev/null || { curl -LsSf https://astral.sh/uv/install.sh | sh; export PATH="$HOME/.local/bin:$PATH"; }
  if [ ! -d "$MC/.git" ]; then git clone -q "$MC_REPO" "$MC"; fi
  git -C "$MC" fetch -q origin && git -C "$MC" checkout -q "$MC_REV"
  # 不连本机 Chrome（CDP），用 Playwright 自带的 Chromium；不抓评论
  python3 - "$MC/config/base_config.py" <<'PY'
import re, sys
p = sys.argv[1]; s = open(p, encoding='utf-8').read()
for k, v in {'ENABLE_CDP_MODE': 'False', 'HEADLESS': 'False', 'ENABLE_GET_COMMENTS': 'False', 'SAVE_LOGIN_STATE': 'True'}.items():
    s = re.sub(rf'^{k} = .*$', f'{k} = {v}', s, flags=re.M)
open(p, 'w', encoding='utf-8').write(s)
PY
  (cd "$MC" && uv sync && uv run playwright install --with-deps chromium)
}

export PATH="$HOME/.local/bin:$PATH"
cmd="${1:-}"
if [ "$cmd" = install ]; then install; exit 0; fi
[ -d "$MC/.venv" ] || install
# 网页桌面（desktop-lite）的显示器是 :1
if [ -z "${DISPLAY:-}" ] && [ -S /tmp/.X11-unix/X1 ]; then export DISPLAY=:1; fi
if [ "$cmd" = login ]; then cd "$MC" && exec uv run python "$HERE/login.py"; fi
exec python3 "$HERE/mc_sync.py" "$@"
