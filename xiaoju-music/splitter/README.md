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
