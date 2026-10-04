---
title: xiaoju-video
emoji: 🍊
colorFrom: yellow
colorTo: red
sdk: docker
app_port: 7860
pinned: false
---

# 小橘视频 · 流式服务

小橘视频 Worker（`xiaoju-video/worker.js`）干不了的重活都在这里：

| 接口 | 作用 |
|---|---|
| `GET /` | 健康检查：机器人、频道主账号是否登录，频道名，转作品队列 |
| `POST /douyin/login` `{chat_id}` | 云电脑：扫码登录抖音（`dy_login.py`），二维码、验证截图由机器人发给 `chat_id`；登录好了 cookie 和 `sec_uid` 存进 Worker `/dy-session` |
| `POST /douyin/login/input` `{text}` | 登录进行中频道主发给机器人的话交给登录页：短信验证码、点哪个验证方式（如「刷脸验证」）、「截图」、「取消登录」 |
| `POST /douyin/crawl` `{chat_id, session, mode, targets}` | 云电脑：MediaCrawler 抓作品（`creator` 只抓 `session.sec_uid` 那个主页，`accounts` 抓 `targets` 里的小号主页（sec_uid，最多 30 个，结果标 `src=alt`），`detail` 抓 `targets` 里的链接，`search` 按 `targets` 里的关键词搜，每个最多 50 条），整批交给 Worker |
| `GET /douyin/jobs` | 云电脑正在干什么（一次只干一件，忙时上面两个接口回 409） |
| `POST /douyin/expand` `{urls}` | 分享短链接跳一次，认出是个人主页（`sec_uid`）还是作品（`aweme`），Worker 据此决定加小号还是抓作品 |
| `POST /douyin/resolve` `{url}` | 不登录的分享页解析（备用；海外机房拿不到作品数据） |
| `POST /douyin/post` `{items}` | 审核通过的作品排进队列：下载 → ffmpeg 挪 moov（不重编码）→ 用频道主账号发进视频频道，说明里带 `#dy<作品号>`；每条转完的结果放进发件箱 |
| `GET /douyin/status` | 队列状态 |
| `GET /stream/<消息号>` | 超过 20 MB 的视频按 Range 走 MTProto 现取现传 |
| `GET /thumb/<消息号>` | 视频自带的封面 |

除 `/` 外都要 `X-Key` 请求头（= `STREAMER_KEY`）。

镜像里另装了 MediaCrawler（`/opt/MediaCrawler`，自己的 venv `/opt/mc-venv`，固定版本见 `mc.py` 的 `MC_REV`）、
Playwright Chromium、Node（它算抖音接口签名）、Xvfb（有界面的浏览器跑在虚拟屏幕上）、中文字体。
起子进程时不把 Telegram、Worker 的密钥传给它们。

**这里找不到 Worker**（HF 机房按域名挡掉了 `*.workers.dev` 和 `api.telegram.org`，TLS 握手超时），要报的事都放进发件箱：
`GET /outbox?boot=&after=&wait=` 由 Worker 长轮询（`outbox.py`）。事件有 `done`（一条转完）、`say`（给频道主的话、截图，Worker 代发）、
`session`（抖音登录状态）、`progress`、`import`（抓到的整批作品）。启动号变了 Worker 就知道这里重启过，把还没转完的再交一次。
`GET /debug/net` 查出站网络（哪些域名连得上）。
防重复发：这次运行里发过的作品直接报回那条消息号；重启后靠 Worker 的作品状态（已转的不会再交过来）。
**不去频道里搜索、读取帖子和标签**（频道主要求）——只按消息号取网页要播的那个视频文件。

免费 Space 闲置约 48 小时会休眠。休眠时 Worker 转来的第一个请求会把它叫醒，网页先显示「正在唤醒」，过一会儿自动重试。

## 环境变量（Space → Settings → Variables and secrets，都设成 secret）

| 名字 | 内容 |
|---|---|
| `TG_API_ID` / `TG_API_HASH` | my.telegram.org 申请的应用凭据 |
| `TG_BOT_TOKEN` | **小橘视频机器人**的 token（视频频道的管理员），取文件用 |
| `TG_USER_SESSION` | 频道主账号的登录凭证（Telethon StringSession），发帖用 |
| `VIDEO_CHANNEL_ID` | 视频频道的数字 id（`-100` 开头），或私有频道的邀请链接（`GET /` 会显示认出的数字 id） |
| `STREAMER_KEY` | 和小橘视频 Worker 的 `STREAMER_KEY` 相同（视频自己的密钥，和小橘音乐的不是同一个） |

## 二次验证（刷脸、短信）

扫完码抖音常要再验证一次。`dy_login.py` 不事先认定页面长什么样：把整页截图和弹窗里能点的选项发给频道主（机器人键盘临时换成这些按钮，
再加「截图」「取消登录」），他点哪个，登录页就点哪个；点了以后弹窗里出现二维码（刷脸用）就单独截下来发过去，他用抖音 App 扫、在手机上刷脸。
选短信的话自动点「获取验证码」，他把数字发给机器人。一直盯着登录有没有成功，最多 10 分钟。

- 选项只取弹窗里**最外层能点的那一层**（抖音的选项是一整行卡片，cursor 会继承给里面的字），字取卡片标题；点的时候把卡片滚到看得见，
  用真鼠标点它正中间。点完最多等 10 秒找二维码（刷脸的二维码要从服务器取），抖音新开窗口就去新窗口找。
- 先看有没有「身份验证」之类的弹窗，再看登录二维码：扫完码以后登录二维码那块还留在页面上，不能拿它判断扫没扫。
- **登录页的事件写进单独的文件**（环境变量 `DY_LOGIN_EVENTS`，`jobs.follow` 一直读新增的行），不走标准输出：
  xvfb-run 会把标准错误并进标准输出，Playwright 的 Node 进程还会把这条共用的管道设成非阻塞，大截图写一半就报
  `BlockingIOError`，频道主收到半截 base64、按钮点了没反应，都是这个原因。

## 本地测试

不联网，模拟 Telegram、抖音：

```bash
pip install -r requirements.txt pytest
python -m pytest -q        # 不用装 MediaCrawler：子进程、Telegram、Worker 都是假的
# 登录页真跑一遍（要装好 MediaCrawler 和 xvfb-run；假的抖音页：扫码 → 身份验证 → 刷脸二维码 → 登录成功）
python smoke_login.py <MediaCrawler 目录> <MediaCrawler 的 python>
```
