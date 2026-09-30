---
title: xiaoju-splitter
emoji: 🍊
colorFrom: yellow
colorTo: red
sdk: docker
app_port: 7860
pinned: false
---

# 小橘音乐 · 大文件切片服务

Telegram 官方 Bot API 只能下载 20 MB 以内的文件，机器人走 MTProto 却能下载 2 GB。
小橘音乐的 Worker 发现频道里有超过 20 MB 的音频，就 `POST /split` 派活到这里：

1. 用 Telethon 以机器人身份登录，按消息号取到频道里的原文件；
2. 边下载边切成 19 MB 的分片，用 Bot API 的 `sendDocument` 发到私有仓库频道；
3. 把分片清单回调给 Worker 的 `/admin/api/commit` 登记，处理进度和失败原因回报到 `/admin/api/status`。

之后播放完全不经过这里：Worker 直接从 Telegram 取分片、按 Range 拼回原文件。所以这个 Space
睡着了也不影响听歌，只是新的大文件要等它醒来（Worker 每 10 分钟会再派一次活）。

一次只处理一首，内存里最多留一片多一点（约 40 MB）。

Telethon 以 `receive_updates=False` 登录：这个会话只调用、不订阅推送。机器人同时挂在官方 Bot API
上收 webhook，Telegram 给同一个机器人的推送可能只送到其中一个会话，订阅了就可能把频道新帖抢走。

### 为什么不在这里跑官方的 telegram-bot-api（`--local` 模式）

它也能突破 20 MB，但要当机器人唯一的 Bot API 服务器用，放在免费 Space 上不合适：

- 启用前必须先对官方服务器 `logOut`（否则推送可能被两边瓜分），之后 webhook 和所有调用都得走它；
  登出后 10 分钟内还切不回官方服务器；
- 免费 Space 闲置约 48 小时会休眠，磁盘不持久，重启就清空；它一停，新歌的推送就没人接；
- `--local` 下 `getFile` 要等整个文件下载到本机磁盘才返回，文件还得另配 HTTP 服务提供下载，
  每首大文件的第一次播放都要等整首下完。

切片方案只在新的大文件出现时用一下这个 Space，播放完全不依赖它。

## 环境变量（Space → Settings → Variables and secrets，都设成 secret）

| 名字 | 内容 |
|---|---|
| `TG_API_ID` / `TG_API_HASH` | 在 https://my.telegram.org 的「API development tools」申请的应用凭据 |
| `TG_BOT_TOKEN` | 机器人 token，和 Worker 里的是同一个 |
| `WORKER_URL` | `https://xiaoju-music.langhua98.workers.dev` |
| `ADMIN_KEY` | Worker 的管理密钥 |
| `SPLITTER_KEY` | Worker 派活时带在 `X-Key` 请求头里的密钥，和 Worker 的 `SPLITTER_KEY` 相同 |

## 接口

- `GET /`：健康检查
- `POST /split`：派活，请求头 `X-Key`，请求体
  `{"track": 消息号, "size": 字节数, "part_size": 分片大小, "storage": "仓库频道 id", "channel": "频道用户名"}`；
  同一首已在排队或处理中时返回 `{"accepted": false}`

## 本地测试

不联网，模拟 Telegram 和 Worker：

```bash
pip install -r requirements.txt pytest
python -m pytest -q
```
