# 小橘视频

把频道主**自己**抖音账号的作品（云电脑同步的、私聊机器人发的分享链接）先过审核机器人，通过的转进私有 Telegram 频道
「小橘视频」，再做成打开网页就能上下滑着刷的短视频页。和 Linggo 阅读器、小橘音乐都没有任何代码和数据共用，只是借这个仓库存代码。

## 架构

```
你（私聊）→ 小橘视频机器人 → Cloudflare Worker ⇄ 流式服务（HF Space）→ 抖音分享页 / Telegram 频道
观众浏览器 → Worker（/video、/vf、/vp）→ 频道里的视频
云电脑（Codespaces）→ Worker（/dy-*）→ 流式服务 → 频道
审核机器人 ⇄ Worker
```

| 块 | 在哪 | 干什么 |
|---|---|---|
| Worker | `worker.js`（Cloudflare，`xiaoju-video`） | 两个机器人的 webhook、作品状态机、视频池、刷视频网页、管理页、云电脑和流式服务的接口 |
| 小橘视频机器人 | `TG_BOT_TOKEN` | 频道主私聊：发分享链接、「进度」「云电脑」「重试失败」；它是视频频道管理员，频道新帖由它的 webhook 登记 |
| 审核机器人 | @xiaojuverify_bot（`VERIFY_BOT_TOKEN`） | 每条作品转之前在这里点「通过 / 不转」；云电脑一次来很多条时可以「全部通过」 |
| 流式服务 | `streamer/`（HF Space `langhua1998/douyin-proxy`，原小橘音乐的流式服务改建，`https://langhua1998-douyin-proxy.hf.space`） | 认分享链接、下载、ffmpeg、用频道主账号发帖；超过 20 MB 的视频按 Range 走 MTProto 现取现传。详见 `streamer/README.md` |
| 云电脑 | `cloud/`（MediaCrawler + `mc_sync.py`）+ 仓库根的 `.devcontainer/xiaoju-video/` | Codespaces 里用 MediaCrawler 扫码登录你自己的抖音，抓你主页的作品送给 Worker |

### 一条作品怎么走

```
review（待审核）──通过──▶ queued（排队）──交给流式服务──▶ sending（在转）──成功──▶ posted（已转）
      └──不转──▶ rejected                ▲                        │失败（<3 次）
                                         └────────────────────────┘
                                         失败满 3 次 ──▶ failed（「重试失败」重新排队）
```

- 流式服务发帖时说明里带 `#dy<作品号>`：Telegram 推送这条新帖时 Worker 认这个标签也会记成已转（回报丢了也不怕）。
  **不会主动去频道里搜索、读取帖子的标签**（频道主要求）；流式服务只按消息号取网页要播的那个视频文件。
- 流式服务重启后 POST `/streamer-up` 报到：Worker 把所有「在转」的放回队列重交；定时任务（每 5 分钟）把交出去
  30 分钟没回音的也重交。
- 云电脑送来的视频地址过几个小时会过期，过期了流式服务按作品号去分享页重新取。

## 路由

| 路径 | 谁调 | 作用 |
|---|---|---|
| `GET /`、`/video` | 观众 | 刷视频网页（`video.html`），`#<消息号>` 从那条开始 |
| `GET /api/videos` | 网页 | 视频池 JSON（新的在前） |
| `GET /vf/<消息号>` | 网页 | 视频流，支持 Range；≤20 MB 走 Bot API，更大的转流式服务；它休眠时回 503 + `Retry-After`，网页 10 秒后重试 |
| `GET /vp/<消息号>` | 网页 | 封面，取一次就存进数据库 |
| `POST /tg-webhook` | 小橘视频机器人 | 频道新帖登记、私聊 |
| `POST /verify-webhook` | 审核机器人 | 按钮、私聊 |
| `POST /dy-known` `/dy-import` `/dy-progress` | 云电脑（`X-Token`） | 哪些已收过、送作品（一次 ≤200 条）、报进度 |
| `POST /streamer-up` `/streamer-done` | 流式服务（`X-Key`） | 报到、报每条结果 |
| `GET /admin`；`/admin/api/state`、`review`、`retry-failed`、`dispatch`、`video-delete` | 管理页（`Authorization: Bearer <ADMIN_KEY>`） | 看状态、审核、移出视频池 |

两个机器人的 webhook 用同一个 `TG_WEBHOOK_SECRET`。

## 数据（Durable Object `Library` 的 SQLite）

- `videos`：视频池，`rec` 是完整记录（含 Bot API `file_id`、大小、时长、尺寸、说明、作品号）；`thumbs`：封面 base64
- `items`：抖音作品，`status` 见上图，`data` 是作品信息（文字、作者、视频地址或图片地址）
- `config`：`ownerId`（视频频道创建者，第一次问 Telegram）、`cloudToken`、`cloudProgress`、`streamerUp`

## Cloudflare 配置

| 项 | 值 |
|---|---|
| Worker | `xiaoju-video`（账号 `aca35ff5f62ae4208757219dbc3b489b`） |
| Durable Object | 绑定 `LIB`，类 `Library`（SQLite，迁移标签 `v1`） |
| Secret | `TG_BOT_TOKEN`、`VERIFY_BOT_TOKEN`、`TG_WEBHOOK_SECRET`、`ADMIN_KEY`、`STREAMER_KEY` |
| 普通变量 | `VIDEO_CHANNEL_ID`、`STREAMER_URL` |
| 定时任务 | `*/5 * * * *` |

**secret 绝不能写进仓库**（仓库是公开的）。

## 改完代码后

```bash
node xiaoju-video/test.mjs                                     # Worker（模拟 Durable Object、Telegram、流式服务）
cd xiaoju-video/streamer && python -m pytest -q                # 流式服务
cd xiaoju-video/cloud && python -m pytest -q                   # 云电脑脚本（不用浏览器、不用 MediaCrawler 的部分）
```

重新部署 Worker（`keep_bindings` 保留线上的 secret；第一次部署要加 `"migrations":{"new_tag":"v1","new_sqlite_classes":["Library"]}`，之后不要带）：

```bash
ACC=aca35ff5f62ae4208757219dbc3b489b
CH=-1004292843233   # 视频频道「小橘视频」
curl -X PUT "https://api.cloudflare.com/client/v4/accounts/$ACC/workers/scripts/xiaoju-video" \
  -H "Authorization: Bearer $CLOUDFLARE_API_TOKEN" \
  -F "metadata={\"main_module\":\"worker.js\",\"compatibility_date\":\"2026-01-01\",\"keep_bindings\":[\"secret_text\"],\"bindings\":[{\"type\":\"durable_object_namespace\",\"name\":\"LIB\",\"class_name\":\"Library\"},{\"type\":\"plain_text\",\"name\":\"STREAMER_URL\",\"text\":\"https://langhua1998-douyin-proxy.hf.space\"},{\"type\":\"plain_text\",\"name\":\"VIDEO_CHANNEL_ID\",\"text\":\"$CH\"}]};type=application/json" \
  -F 'worker.js=@xiaoju-video/worker.js;type=application/javascript+module' \
  -F 'video.html=@xiaoju-video/video.html;type=text/plain' \
  -F 'admin.html=@xiaoju-video/admin.html;type=text/plain'
```

定时任务用 `PUT …/workers/scripts/xiaoju-video/schedules`（`[{"cron":"*/5 * * * *"}]`）设。

两个机器人的 webhook：

```bash
for pair in "$TG_BOT_TOKEN tg-webhook" "$VERIFY_BOT_TOKEN verify-webhook"; do set -- $pair
  curl "https://api.telegram.org/bot$1/setWebhook" -d url=https://xiaoju-video.langhua98.workers.dev/$2 \
    -d secret_token="$TG_WEBHOOK_SECRET" --data-urlencode 'allowed_updates=["channel_post","edited_channel_post","message","callback_query"]'
done
```

改了流式服务：把 `streamer/` 下的 `app.py`、`douyin.py`、`Dockerfile`、`requirements.txt`、`README.md`（顶部是 Space 配置）
推到 Space `langhua1998/douyin-proxy`，它会自动重新构建。重新构建会打断正在转的作品，它起来后报到，Worker 会重交。

## 云电脑（MediaCrawler）

爬虫用的是 [MediaCrawler](https://github.com/NanmiCoder/MediaCrawler)（NON-COMMERCIAL LEARNING LICENSE 1.1，只能非商业使用），
`run.sh install` 把它装进 Codespace 的 `~/.xiaoju-video/MediaCrawler`，固定在验证过的版本 `bf28178`，并改配置：不连本机 Chrome（CDP）、
有界面（在网页桌面里扫码、看验证码）、不抓评论、保存登录状态。它在浏览器里登录、自己算接口签名，所以不受「海外 IP 打开分享页没有作品数据」的限制。

1. 在 GitHub 上用 `.devcontainer/xiaoju-video` 这个配置建 Codespace（Python 3.11 + Node 20 + 网页桌面；建好会自动跑 `run.sh install`）。
2. 在小橘视频机器人里发「云电脑」，把它给的命令粘进终端，末尾换成**你自己的**抖音主页链接（`https://www.douyin.com/user/MS4wLjABAAAA…`）。
3. `bash xiaoju-video/cloud/run.sh sync`：MediaCrawler 的 creator 模式只抓这一个主页的作品（不搜关键词、不抓评论），
   第一次要在端口 6080 的网页桌面（密码 `vscode`）里 60 秒内扫码。抓完 `mc_sync.py` 读 jsonl，问 Worker 哪些收过，新的送过去，再去 @xiaojuverify_bot 审核。
4. `bash xiaoju-video/cloud/run.sh link <链接>...`：只抓这几条（detail 模式），用于你自己的或有授权的作品。

抓到的视频地址几个小时后过期：审核拖太久，流式服务下载会失败，满 3 次记成失败；再跑一次 sync，失败的会带着新地址重新待审核。
