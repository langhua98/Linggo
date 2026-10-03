---
title: xiaoju-video-streamer
emoji: 🍊
colorFrom: yellow
colorTo: red
sdk: docker
app_port: 7860
pinned: false
---

# 小橘视频 · 抖音转视频频道的服务

小橘视频的 Worker（[`../worker.js`](../worker.js)）把重活交给这里：

1. 用 Playwright 的无头 Chromium **不登录**打开抖音网页版拿作品（`douyin/web.py`），接口签名交给页面自己的安全脚本；
2. 下载不带水印的最高画质，用 ffmpeg 把索引挪到文件开头（本来就是的不重做）、截缩略图；
3. 用频道主自己的账号（`TG_USER_SESSION`）把视频、图文相册发进私有的「小橘视频」频道，说明里带 `#账号标签` 和原视频链接；
4. 超过 20 MB 的视频，Worker 转到这里按消息号取：机器人身份走 MTProto，边取边传（`/vstream`）。

同时有 3 条作品在下载、过 ffmpeg、传到 Telegram，发帖仍按顺序一条条发。重启后 Worker 会把没转完的再交一次。

免费 Space 闲置约 48 小时会休眠，Worker 转来的第一个请求会把它叫醒，先回 503，网页过会儿重试。

## 环境变量（Space → Settings → Variables and secrets，都设成 secret）

| 名字 | 内容 |
|---|---|
| `TG_API_ID` / `TG_API_HASH` | 在 https://my.telegram.org 的「API development tools」申请的应用凭据 |
| `TG_BOT_TOKEN` | 小橘视频的机器人 token，和小橘视频 Worker 里的是同一个（不是小橘音乐的机器人） |
| `STREAMER_KEY` | Worker 转发请求时带在 `X-Key` 请求头里的密钥，和小橘视频 Worker 的 `STREAMER_KEY` 相同 |
| `TG_USER_SESSION` | 频道主账号的登录凭证（发进视频频道、翻频道历史用）。没有时先 `POST /login/code`、`/login/verify` 登录，从响应里拿 |
| `WORKER_URL` | （可选）小橘视频 Worker 的地址，默认 `https://xiaoju-video.langhua98.workers.dev`。启动时来这里报到，转完来这里报结束 |

## 接口（都要 `X-Key`，除了 `GET /`）

- `GET /`：健康检查
- `POST /douyin/link`：`{text, target, notify, run_id?}`。作品链接 → 解析、下载、发进 `target` 频道，回 `{kind: "aweme", id}`；
  主页链接 → 采集这个账号作品的公开链接，回 `{kind: "user", sec_uid}`。认不出 → 400，正在跑别的 → 409
- `POST /douyin/mirror`：`{sec_uids, target, notify, quiet?, tags?, state?}`，把这些账号能看到的作品转进 `target` 频道（旧的先发，已有的跳过）
- `POST /douyin/import`：`{text, target, notify, final, tags?}`，转云电脑（[`../cloud/`](../cloud/)）抓来的作品；边抓边转，`final=false` 表示后面还有
- `GET /douyin/status`：上一次的结果（含 `run_id`、`tags_used`；最近一次通知 Worker 失败时带 `worker_link`）；`POST /douyin/stop` 取消正在跑的
- `GET /douyin/posted?target=`：频道里已转过的作品号（查重，6 小时内只翻上次之后的新帖）；`POST /douyin/delete`：删旧帖以便按最高画质重转
- `POST /douyin/login` 等：在 Worker 的登录页上扫码登录抖音；`GET /channels/owned?title=`：按名字找频道主自己建的频道的数字 id
- `GET /vstream/<消息号>?target=`（Range）、`GET /vthumb/<消息号>?target=`、`GET /videos?target=`：给刷视频网页用
- `POST /login/code`、`POST /login/verify`：频道主账号登录

小橘音乐是另一个项目，在 [`../../xiaoju-music/`](../../xiaoju-music/)，有它自己的流式服务和 Space。

## 本地测试

不联网，模拟 Telegram 和抖音网页：

```bash
pip install -r requirements.txt pytest httpx
python -m pytest -q
```
