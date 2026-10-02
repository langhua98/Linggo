#!/usr/bin/env bash
# 小橘 · 抓自己抖音账号的全部作品，抓完自动发给小橘（由 setup.sh 放到 ~/.xiaoju/，桌面图标调用）
set -uo pipefail
HERE="$(cd "$(dirname "$0")" && pwd)"
# 带参数（Codespaces：bash crawl.sh <令牌> <账号1,账号2>）就记下来；不带就用 setup.sh 存的
if [ $# -ge 2 ]; then
  mkdir -p "$HOME/.xiaoju"
  printf 'TOKEN=%q\nCREATORS=%q\nAPI=%q\n' "$1" "$2" "${3:-https://xiaoju-music.langhua98.workers.dev}" > "$HOME/.xiaoju/env"
  chmod 600 "$HOME/.xiaoju/env"
fi
source "$HOME/.xiaoju/env"
# 每次开抓前找小橘要最新的账号名单（在机器人里「添加抖音账号」加的小号这样也能抓到）；要不到就用上次存的
NEW=$(curl -sS -m 20 -X POST -H "X-Token: $TOKEN" "$API/dy-cloud-config" 2>/dev/null \
  | python3 -c 'import json,sys; print(json.load(sys.stdin).get("creators",""))' 2>/dev/null)
if [ -n "$NEW" ] && [ "$NEW" != "$CREATORS" ]; then
  CREATORS="$NEW"
  printf 'TOKEN=%q\nCREATORS=%q\nAPI=%q\n' "$TOKEN" "$CREATORS" "$API" > "$HOME/.xiaoju/env"
fi
echo "== 这次抓 $(printf '%s' "$CREATORS" | tr ',' '\n' | grep -c .) 个抖音账号 =="
export PATH="$HOME/.local/bin:$PATH"
export DISPLAY="${DISPLAY:-:1}"  # 浏览器开在桌面上（Codespaces 的网页桌面是 :1）
[ -S /tmp/.X11-unix/X1 ] && export DISPLAY=:1  # 有网页桌面就一定开在它上面，别开到看不见的地方
# MediaCrawler 的浏览器页面是 1920×1080，网页桌面默认比它小：页面一半在屏幕外，抖音的验证框就点不到。把桌面放大到装得下
command -v xrandr >/dev/null 2>&1 || sudo DEBIAN_FRONTEND=noninteractive apt-get install -y x11-xserver-utils >/dev/null 2>&1 || true
bash "$HERE/win.sh" quiet  # 放大桌面（任务栏跟着挪到底下），见 win.sh
# 之前中途关掉、崩掉的那几次留下的浏览器进程不会自己退，一直占着内存和 /dev/shm，越积越多，
# 新开的页面一开就崩（Page crashed）。开抓前先清干净，再看一眼还剩多少内存
pkill -f 'main.py --platform dy' 2>/dev/null
pkill -f 'ms-playwright' 2>/dev/null
sleep 2
pkill -9 -f 'ms-playwright' 2>/dev/null
rm -rf /dev/shm/.org.chromium.* 2>/dev/null
echo "== 可用内存 $(free -m | awk '/^Mem/{print $7}') MB，/dev/shm 剩 $(df -m /dev/shm | awk 'NR==2{print $4}') MB =="
OUT="$HOME/douyin-data"
rm -rf "$OUT" && mkdir -p "$OUT"
cd "$HOME/MediaCrawler" || { echo "没找到 MediaCrawler，重新运行一次安装命令"; exit 1; }

# MediaCrawler 用 execjs 跑抖音的签名脚本，要有 Node.js（Codespaces 的 Python 镜像里没有）
command -v node >/dev/null 2>&1 || { echo "== 先装 Node.js（一两分钟）=="; sudo apt-get update -y || true; sudo DEBIAN_FRONTEND=noninteractive apt-get install -y nodejs; }
# MediaCrawler 默认 CDP 模式要找本机装的 Chrome/Edge，云电脑上没有，浏览器就起不来；改用它自己装的 Chromium
sed -i 's/^ENABLE_CDP_MODE = True/ENABLE_CDP_MODE = False/' config/base_config.py
# 抖音首页打开后会自己再跳一次（反爬检查），MediaCrawler 没等跳完就读页面，报 Execution context was destroyed；
# 让它打开首页后等页面稳定（最多 20 秒）再往下走
python3 - <<'PY'
p = 'media_platform/douyin/core.py'
s = open(p, encoding='utf-8').read()
old = 'await self.context_page.goto(self.index_url)\n'
if '# xiaoju: settle' not in s and old in s:
    i = s.index(old)
    pad = s[s.rindex('\n', 0, i) + 1:i]
    s = s.replace(old, old + pad + '# xiaoju: settle\n'
                  + pad + 'try:\n' + pad + '    await self.context_page.wait_for_load_state("networkidle", timeout=20000)\n'
                  + pad + 'except Exception:\n' + pad + '    pass\n' + pad + 'await asyncio.sleep(3)\n', 1)
    open(p, 'w', encoding='utf-8').write(s)

# 抖音改过页面，MediaCrawler 自己点「登录」、找二维码常找不到，一找不到就退出。改成找不到也不退：
# 提示频道主在桌面的浏览器里自己点登录、扫码；check_login_state 原来只等 10 分钟，抖音常要再做身份验证，放宽到 30 分钟
p = 'media_platform/douyin/login.py'
s = open(p, encoding='utf-8').read()
if '# xiaoju: manual' not in s:
    note = 'print("\\n== 小橘：请在「桌面」的浏览器里自己点右上角「登录」，用抖音扫码（要验证就在那里做）。最多等 30 分钟 ==\\n", flush=True)'
    for old in ('await self.popup_login_dialog()\n', 'await self.login_by_qrcode()\n'):
        if old in s:
            i = s.index(old)
            pad = s[s.rindex('\n', 0, i) + 1:i]
            s = s.replace(old, '# xiaoju: manual\n' + pad + 'try:\n' + pad + '    ' + old + pad
                          + 'except (Exception, SystemExit):\n' + pad + '    ' + note + '\n', 1)
s = s.replace('最多等 10 分钟', '最多等 30 分钟')
s = s.replace('stop=stop_after_attempt(600), wait=wait_fixed(1)', 'stop=stop_after_attempt(1800), wait=wait_fixed(1)')
open(p, 'w', encoding='utf-8').write(s)
# 翻作品列表时，抖音偶尔回 504（翻得太快、服务器超时），MediaCrawler 一遇到就整个停掉，后面的作品和账号全漏了。
# 改成：每页失败重试 6 次（越等越久），翻页之间歇 2～4 秒；一个账号出错不影响下一个
p2 = 'media_platform/douyin/client.py'
c = open(p2, encoding='utf-8').read()
old = '            aweme_post_res = await self.get_user_aweme_posts(sec_user_id, max_cursor)\n'
if '# xiaoju: retry' not in c and old in c:
    c = c.replace(old, '            # xiaoju: retry\n'
                  '            for _try in range(6):\n'
                  '                try:\n'
                  '                    aweme_post_res = await self.get_user_aweme_posts(sec_user_id, max_cursor)\n'
                  '                    break\n'
                  '                except Exception as _e:\n'
                  '                    if _try == 5:\n'
                  '                        raise\n'
                  '                    utils.logger.info(f"[xiaoju] 这一页没拿到，{5 * (_try + 1)} 秒后重试：{str(_e)[:80]}")\n'
                  '                    await asyncio.sleep(5 * (_try + 1))\n'
                  '            await asyncio.sleep(random.uniform(2, 4))\n', 1)
    for imp in ('import asyncio\n', 'import random\n'):
        if imp not in c:
            c = imp + c
    open(p2, 'w', encoding='utf-8').write(c)
p3 = 'media_platform/douyin/core.py'
c = open(p3, encoding='utf-8').read()
old = '            all_video_list = await self.dy_client.get_all_user_aweme_posts(sec_user_id=user_id, callback=self.fetch_creator_video_detail)\n'
if '# xiaoju: per-creator' not in c and old in c:
    c = c.replace(old, '            # xiaoju: per-creator\n'
                  '            try:\n'
                  '                all_video_list = await self.dy_client.get_all_user_aweme_posts(sec_user_id=user_id, callback=self.fetch_creator_video_detail)\n'
                  '            except Exception as _e:\n'
                  '                utils.logger.error(f"[xiaoju] 这个账号没翻完，先抓下一个：{str(_e)[:120]}")\n'
                  '                continue\n', 1)
    open(p3, 'w', encoding='utf-8').write(c)
c = open(p3, encoding='utf-8').read()
old = '        note_details = await asyncio.gather(*task_list)\n        for aweme_item in note_details:\n'
if '# xiaoju: keep' not in c and old in c:
    # 单条作品的详情也会 504，MediaCrawler 拿不到就把这条丢了：改成拿不到就用列表里那份（字段一样）
    c = c.replace(old, '        note_details = await asyncio.gather(*task_list)\n'
                  '        # xiaoju: keep\n'
                  '        note_details = [d if d is not None else p for d, p in zip(note_details, video_list)]\n'
                  '        for aweme_item in note_details:\n', 1)
    open(p3, 'w', encoding='utf-8').write(c)
c = open(p3, encoding='utf-8').read()
if '# xiaoju: light' not in c:
    # 页面开久了会 Target crashed：容器里 /dev/shm 只有 64MB，抖音首页又一直在放视频把内存撑爆。
    # 浏览器不用 /dev/shm、静音；页面里的视频音频一律不加载（抓列表用不着）
    old = '                accept_downloads=True,\n'
    if old in c:
        c = c.replace(old, old + '                # xiaoju: light\n'
                      '                args=["--disable-dev-shm-usage", "--mute-audio", "--autoplay-policy=user-gesture-required"],\n', 1)
    old = '            self.context_page = await self.browser_context.new_page()\n'
    if old in c:
        pad = '            '
        c = c.replace(old, old + pad + '# xiaoju: light\n'
                      + pad + 'async def _xj_route(route):\n'
                      + pad + '    if route.request.resource_type == "media":\n'
                      + pad + '        await route.abort()\n'
                      + pad + '    else:\n'
                      + pad + '        await route.continue_()\n'
                      , 1)
    open(p3, 'w', encoding='utf-8').write(c)
c = open(p3, encoding='utf-8').read()
# 每个请求都绕到 Python 里判断（拦视频）太慢，抖音首页几百个请求，30 秒都开不完：已经加上的撤掉
c = c.replace('            await self.browser_context.route("**/*", _xj_route)\n', '')
# 首页只等页面结构出来（不等所有图片脚本），最多 60 秒；页面崩了新开那页也一样
c = c.replace('await self.context_page.goto(self.index_url)\n',
              'await self.context_page.goto(self.index_url, wait_until="domcontentloaded", timeout=60000)\n')
open(p3, 'w', encoding='utf-8').write(c)
c = open(p2, encoding='utf-8').read()
c = c.replace('await _pg.goto("https://www.douyin.com/", timeout=60000)',
              'await _pg.goto("https://www.douyin.com/", wait_until="domcontentloaded", timeout=60000)')
open(p2, 'w', encoding='utf-8').write(c)
c = open(p2, encoding='utf-8').read()
old = '        local_storage: Dict = await self.playwright_page.evaluate("() => window.localStorage")  # type: ignore\n'
if '# xiaoju: crash-safe' not in c and old in c:
    # 每个请求都要去页面里读 localStorage（拿 msToken）。抖音首页太重，在小云电脑上开久了页面会崩（Target crashed），
    # 一崩整个抓取就停。改成：读到就记下；页面崩了用记下的那份，还没记过就新开一页重读
    c = c.replace(old, '        # xiaoju: crash-safe\n'
                  '        try:\n'
                  '            local_storage: Dict = await self.playwright_page.evaluate("() => window.localStorage")  # type: ignore\n'
                  '            self._xj_ls = local_storage\n'
                  '        except Exception as _e:\n'
                  '            local_storage = getattr(self, "_xj_ls", None)\n'
                  '            if local_storage is None:\n'
                  '                utils.logger.info(f"[xiaoju] 页面崩了，新开一页：{str(_e)[:80]}")\n'
                  '                _pg = await self.playwright_page.context.new_page()\n'
                  '                await _pg.goto("https://www.douyin.com/", timeout=60000)\n'
                  '                await asyncio.sleep(5)\n'
                  '                self.playwright_page = _pg\n'
                  '                local_storage = await _pg.evaluate("() => window.localStorage")\n'
                  '                self._xj_ls = local_storage\n', 1)
    open(p2, 'w', encoding='utf-8').write(c)

# 最高画质：MediaCrawler 只存 video_download_url（play_addr，抖音的默认画质）。另存两样给小橘挑：
# xiaoju_video = 作品 video 里的各档清晰度（bit_rate）和尺寸时长；xiaoju_images = 每张图的全部地址
p4 = 'store/douyin/__init__.py'
c = open(p4, encoding='utf-8').read()
old = '        "note_download_url": ",".join(extract_image_urls(aweme_item)),\n'
if '# xiaoju: quality' not in c and old in c:
    c = c.replace(old, old + '        # xiaoju: quality\n'
                  '        "xiaoju_video": {k: (aweme_item.get("video") or {}).get(k) for k in ("bit_rate", "play_addr_h264", "play_addr", "width", "height", "duration")},\n'
                  '        "xiaoju_images": [{"url_list": (i or {}).get("url_list"), "width": (i or {}).get("width"), "height": (i or {}).get("height")} for i in (aweme_item.get("images") or [])],\n', 1)
    open(p4, 'w', encoding='utf-8').write(c)
c = open(p4, encoding='utf-8').read()
old = '        "note_download_url": ",".join(extract_image_urls(aweme_item)),\n'
if '# xiaoju: account' not in c and old in c:
    # 作品属于哪个账号：MediaCrawler 把昵称打码、uid 做了哈希，频道里按账号贴标签要原样的 sec_uid 和昵称（都是频道主自己的号）
    c = c.replace(old, old + '        # xiaoju: account\n'
                  '        "xiaoju_sec_uid": (aweme_item.get("author") or {}).get("sec_uid") or "",\n'
                  '        "xiaoju_nickname": (aweme_item.get("author") or {}).get("nickname") or "",\n', 1)
    open(p4, 'w', encoding='utf-8').write(c)
PY

# 浏览器窗口常开在屏幕外一半：抓的时候后台隔几秒把它摆回屏幕里（最多 30 分钟）
WIN="$HERE/win.sh"
( for _ in $(seq 360); do sleep 5; bash "$WIN" quiet; done ) >/dev/null 2>&1 &
WINLOOP=$!
trap 'kill $WINLOOP 2>/dev/null' EXIT

# 边抓边转：MediaCrawler 抓一条往 jsonl 里写一行。后台每 30 秒把新写的几行送给小橘（X-Final: 0），
# 小橘收到第一批就开始转，后面的接着排队；抓完再把剩下的连同「抓完了」（X-Final: 1）送过去。
# 送成功才往前记（SENTF），没送成（小橘在忙、网不好）下次连同新的一起送；重复送的小橘会认出来不重收
SENTF="$HOME/.xiaoju/sent"; echo 0 > "$SENTF"
newest() { find "$OUT" -name 'creator_contents_*.jsonl' -printf '%T@ %p\n' 2>/dev/null | sort -nr | head -1 | cut -d' ' -f2-; }
send() {  # $1 = 0 还在抓 / 1 抓完了
  local f n sent code
  f=$(newest); n=0; [ -n "$f" ] && n=$(wc -l < "$f")
  sent=$(cat "$SENTF")
  [ "$n" -le "$sent" ] && [ "$1" = 0 ] && return 0
  if [ "$n" -gt "$sent" ]; then tail -n +"$((sent + 1))" "$f" | head -n "$((n - sent))" > "$OUT/.batch"; else : > "$OUT/.batch"; fi
  code=$(curl -sS -m 120 -o "$OUT/.resp" -w '%{http_code}' -X POST -H "X-Token: $TOKEN" -H "X-Final: $1" \
    -H 'Content-Type: text/plain; charset=utf-8' --data-binary @"$OUT/.batch" "$API/dy-import" 2>/dev/null)
  if [ "$code" = 200 ]; then
    echo "$n" > "$SENTF"
    [ "$n" -gt "$sent" ] && echo "== 已送给小橘 $n 条（这批 $((n - sent)) 条），小橘在边收边转 =="
    return 0
  fi
  echo "== 这批没送成（$code $(head -c 120 "$OUT/.resp" 2>/dev/null)），等下连同新的一起再送 =="
  return 1
}
( while sleep "${XJ_SEND_EVERY:-30}"; do send 0; done ) &
SENDLOOP=$!
trap 'kill $WINLOOP $SENDLOOP 2>/dev/null' EXIT

echo "== 马上会弹出浏览器，用抖音 App 扫码登录（要验证就在浏览器里完成）=="
uv run main.py --platform dy --lt qrcode --type creator --creator_id "$CREATORS" \
  --get_comment no --get_sub_comment no --get_media no --headless no \
  --save_data_option jsonl --crawler_max_notes_count 100000 --save_data_path "$OUT"

kill $SENDLOOP 2>/dev/null; wait $SENDLOOP 2>/dev/null
F=$(newest); N=0; [ -n "$F" ] && N=$(wc -l < "$F")
if [ "$N" = 0 ] && [ "$(cat "$SENTF")" = 0 ]; then
  echo "== 没抓到作品（登录没成功？）。关掉这个窗口，再双击图标重来一次 =="
  exit 1
fi
echo "== 抓完了，一共 $N 条，把剩下的送给小橘 =="
for i in $(seq 10); do send 1 && break; sleep 30; done
echo "== 好了。作品在陆续转进「小橘视频」，全部转完机器人会通知你。这个窗口可以关了 =="
