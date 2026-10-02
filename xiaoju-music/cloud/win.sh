#!/usr/bin/env bash
# 小橘 · 把桌面上的浏览器窗口挪回屏幕里、摆满（窗口一半在屏幕外时，抖音的登录/验证框点不到）。
# 手动：bash xiaoju-music/cloud/win.sh；crawl.sh 抓的时候也会在后台隔几秒跑一次
export DISPLAY=:1
command -v xdotool >/dev/null 2>&1 || sudo DEBIAN_FRONTEND=noninteractive apt-get install -y xdotool >/dev/null 2>&1 || true
# 桌面放大到 1920×1200（装得下 1920×1080 的页面）；放大以后让桌面程序 fluxbox 重启一下，
# 不然底下黄色的任务栏还停在原来的高度，正好挡住抖音验证框的按钮
if command -v xrandr >/dev/null 2>&1 && ! xrandr 2>/dev/null | grep -q 'current 1920 x 1200'; then
  xrandr --fb 1920x1200 >/dev/null 2>&1 && pkill -HUP -x fluxbox 2>/dev/null && sleep 2
fi
n=0
for w in $(xdotool search --onlyvisible --class 'chrom' 2>/dev/null); do
  xdotool windowmove "$w" 0 0 windowsize "$w" 1920 1170 >/dev/null 2>&1 && n=$((n + 1))
done
[ "${1:-}" = quiet ] || echo "== 摆好了 $n 个浏览器窗口，去桌面刷新看看 =="
