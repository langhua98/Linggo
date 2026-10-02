---
title: xiaoju-streamer
emoji: 🍊
colorFrom: yellow
colorTo: red
sdk: docker
app_port: 7860
pinned: false
---

# 小橘音乐 · 大文件流式服务

Telegram 官方 Bot API 只能下载 20 MB 以内的文件，机器人走 MTProto 却没有这个限制。
小橘音乐的 Worker 遇到超过 20 MB 的歌，就把浏览器的 Range 请求转到这里：

1. 用 Telethon 以机器人身份登录，按消息号取到频道里的原文件（消息缓存 30 分钟）；
2. 浏览器要哪一段，就从 Telegram 现取哪一段（起点按 512 KB 对齐，这是 MTProto 的要求），边取边传；
3. 不落盘，也不用等整首下完，拖进度条直接跳。传到一半文件引用过期了，就重取消息、从断开的地方接着传。

Telethon 以 `receive_updates=False` 登录：这个会话只调用、不订阅推送。机器人同时挂在官方 Bot API
上收 webhook，Telegram 给同一个机器人的推送可能只送到其中一个会话，订阅了就可能把频道新帖抢走。

免费 Space 闲置约 48 小时会休眠。休眠时 Worker 转来的第一个请求会把它叫醒，Worker 先回 503，
播放页每 10 秒重试一次，醒了就开始播。

## 环境变量（Space → Settings → Variables and secrets，都设成 secret）

| 名字 | 内容 |
|---|---|
| `TG_API_ID` / `TG_API_HASH` | 在 https://my.telegram.org 的「API development tools」申请的应用凭据 |
| `TG_BOT_TOKEN` | 机器人 token，和 Worker 里的是同一个 |
| `TG_CHANNEL` | 频道用户名：`xiaojumusic` |
| `STREAMER_KEY` | Worker 转发请求时带在 `X-Key` 请求头里的密钥，和 Worker 的 `STREAMER_KEY` 相同 |

## 接口

- `GET /`：健康检查
- `GET /stream/<消息号>`：请求头 `X-Key`，可带 `Range`；返回 200（整个文件）、206（一段）、
  403（密钥不对）、404（频道里没有这条音频）、416（范围超出文件）
- `POST /douyin/link`（`X-Key`）：`{text: 抖音分享文字或链接, target: 视频频道, notify: 通知谁}`，在后台不登录跑，跑完通知：
  作品链接 → 解析、下载、发进 `target` 频道，回 `{kind: "aweme", id}`；主页链接 → 采集这个账号作品的公开链接，回
  `{kind: "user", sec_uid}`。认不出、作品链接没给 `target` → 400，正在跑别的 → 409。
- `POST /douyin/mirror`（`X-Key`）：`{sec_uid, target, notify}`，把这个账号能看到的视频转进 `target` 频道（旧的先发，已有的跳过）。
- `GET /douyin/status`：上一次的结果。采集到的链接在 `links` 里；`hidden_newest` / `truncated` 是抖音没给没登录的人看的部分
  （最新的几条 / 第一页以后）；`blocked: true` 是被抖音风控拦了（比如弹了滑块验证）。
- `GET /channels/owned?title=`：频道主自己建的频道里名字含 `title` 的（找私有频道的数字 id 用）。
- 抖音这几个用到 Chromium（Dockerfile 里 `playwright install --with-deps chromium`）。

## 为什么不在这里跑官方的 telegram-bot-api（`--local` 模式）

它也能突破 20 MB，但要当机器人唯一的 Bot API 服务器用：

- 启用前必须先对官方服务器 `logOut`，之后 webhook 和所有调用都得走它，Space 一休眠或重启，新歌就漏登记；
  登出后 10 分钟内还切不回官方服务器；
- `--local` 下 `getFile` 要等整个文件下载到本机磁盘才返回，还得另配 HTTP 服务提供下载；
  免费 Space 的磁盘不持久，重启后又得重下。

## 本地测试

不联网，模拟 Telegram：

```bash
pip install -r requirements.txt pytest httpx
python -m pytest -q
```
