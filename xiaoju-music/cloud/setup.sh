#!/usr/bin/env bash
# 小橘 · 抖音云电脑一键安装（Oracle Cloud 免费套餐 Ubuntu 24.04，ARM 或 x86 都行）
#
# 用法（机器人发「云电脑」会给你带好参数的这一行，复制粘贴就行）：
#   bash <(curl -fsSL https://raw.githubusercontent.com/langhua98/Linggo/main/xiaoju-music/cloud/setup.sh) <令牌> <账号1,账号2>
#
# 装好以后：用 iPad 上的「Windows App」（RDP）连这台机器的公网 IP，桌面上双击「抓抖音发给小橘」，
# 在弹出的浏览器里自己扫码登录抖音（有验证也在那里做），抓完结果自动发给小橘，作品转进「小橘视频」频道。
# 抖音账号、密码、验证码全程只在这台你自己的机器上，不经过小橘。
set -euo pipefail

TOKEN="${1:?缺少令牌：在机器人里发「云电脑」拿完整命令}"
CREATORS="${2:?缺少抖音账号：在机器人里发「云电脑」拿完整命令}"
API="${3:-https://xiaoju-music.langhua98.workers.dev}"
RAW="https://raw.githubusercontent.com/langhua98/Linggo/main/xiaoju-music/cloud"

say() { printf '\n\033[1;33m== %s ==\033[0m\n' "$*"; }

say "1/5 安装桌面和远程桌面（大约 5～10 分钟）"
sudo apt-get update -y
sudo DEBIAN_FRONTEND=noninteractive apt-get install -y xfce4 xfce4-terminal xrdp dbus-x11 curl git fonts-noto-cjk
echo xfce4-session > "$HOME/.xsession"
sudo adduser xrdp ssl-cert >/dev/null 2>&1 || true
sudo systemctl enable --now xrdp

say "2/5 打开远程桌面端口 3389（这台机器自己的防火墙）"
if ! sudo iptables -C INPUT -p tcp --dport 3389 -j ACCEPT 2>/dev/null; then
  sudo iptables -I INPUT 1 -p tcp --dport 3389 -j ACCEPT
fi
sudo netfilter-persistent save >/dev/null 2>&1 || true

say "3/5 设置远程桌面登录密码（用户名是 $USER；输入时屏幕上不显示，正常）"
sudo passwd "$USER" </dev/tty

say "4/5 安装 MediaCrawler 和浏览器（大约 5 分钟）"
if ! command -v uv >/dev/null 2>&1; then
  curl -LsSf https://astral.sh/uv/install.sh | sh
fi
export PATH="$HOME/.local/bin:$PATH"
if [ -d "$HOME/MediaCrawler/.git" ]; then
  git -C "$HOME/MediaCrawler" pull --ff-only
else
  git clone --depth 1 https://github.com/NanmiCoder/MediaCrawler.git "$HOME/MediaCrawler"
fi
cd "$HOME/MediaCrawler"
uv sync
uv run playwright install --with-deps chromium

say "5/5 放好「抓抖音发给小橘」"
mkdir -p "$HOME/.xiaoju" "$HOME/Desktop"
printf 'TOKEN=%q\nCREATORS=%q\nAPI=%q\n' "$TOKEN" "$CREATORS" "$API" > "$HOME/.xiaoju/env"
chmod 600 "$HOME/.xiaoju/env"
curl -fsSL "$RAW/crawl.sh" -o "$HOME/.xiaoju/crawl.sh"
chmod +x "$HOME/.xiaoju/crawl.sh"
cat > "$HOME/Desktop/xiaoju-douyin.desktop" <<DESK
[Desktop Entry]
Type=Application
Name=抓抖音发给小橘
Exec=xfce4-terminal --hold -e "bash $HOME/.xiaoju/crawl.sh"
Icon=web-browser
Terminal=false
DESK
chmod +x "$HOME/Desktop/xiaoju-douyin.desktop"

IP=$(curl -fsS https://ifconfig.me 2>/dev/null || echo '这台机器的公网 IP')
say "装好了"
cat <<MSG
接下来：
  1. 确认 Oracle 控制台里这台机器的「安全列表」已放行 TCP 3389（小橘的说明里有截图步骤）
  2. iPad 打开「Windows App」→ 添加 PC → 地址填 $IP，用户名 $USER，密码是刚才设的
  3. 连上后，桌面上双击「抓抖音发给小橘」，在弹出的浏览器里扫码登录抖音
MSG
