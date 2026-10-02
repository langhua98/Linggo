#!/usr/bin/env bash
# GitHub Codespaces 建好时自动跑（.devcontainer/douyin/devcontainer.json 的 postCreateCommand）：
# 装中文字体、uv、MediaCrawler 和它要的 Chromium。抓取和上传在 crawl.sh 里。
set -euo pipefail
sudo apt-get update -y && sudo DEBIAN_FRONTEND=noninteractive apt-get install -y fonts-noto-cjk
command -v uv >/dev/null 2>&1 || curl -LsSf https://astral.sh/uv/install.sh | sh
export PATH="$HOME/.local/bin:$PATH"
if [ -d "$HOME/MediaCrawler/.git" ]; then git -C "$HOME/MediaCrawler" pull --ff-only
else git clone --depth 1 https://github.com/NanmiCoder/MediaCrawler.git "$HOME/MediaCrawler"; fi
cd "$HOME/MediaCrawler" && uv sync && uv run playwright install --with-deps chromium
echo "== 小橘：环境装好了。打开端口 6080 的网页桌面（密码 xiaoju），再在终端里运行机器人「云电脑」给的命令 =="
