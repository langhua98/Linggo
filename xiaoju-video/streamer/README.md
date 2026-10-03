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
| `POST /douyin/resolve` `{url}` | 认抖音分享链接，返回作品信息（不登录的分享页 `iesdouyin.com/share/...` 里解析） |
| `POST /douyin/post` `{items}` | 审核通过的作品排进队列：下载 → ffmpeg 挪 moov（不重编码）→ 用频道主账号发进视频频道，说明里带 `#dy<作品号>`；每条转完 POST Worker `/streamer-done` |
| `GET /douyin/status` | 队列状态 |
| `GET /stream/<消息号>` | 超过 20 MB 的视频按 Range 走 MTProto 现取现传 |
| `GET /thumb/<消息号>` | 视频自带的封面 |

除 `/` 外都要 `X-Key` 请求头（= `STREAMER_KEY`）。

刚起来时 POST Worker 的 `/streamer-up` 报到，Worker 把之前交过来、还没转完的作品再交一次（Space 重启、休眠后队列就丢了）。
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
| `STREAMER_KEY` | 和 Worker 的 `STREAMER_KEY` 相同 |
| `WORKER_URL` | `https://xiaoju-video.langhua98.workers.dev` |

## 本地测试

不联网，模拟 Telegram、抖音：

```bash
pip install -r requirements.txt pytest
python -m pytest -q
```
