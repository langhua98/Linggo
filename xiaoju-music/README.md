# 小橘音乐 · Telegram 频道音频中转（Cloudflare Worker）

把 Telegram 频道 [@xiaojumusic](https://t.me/xiaojumusic) 里的音频变成**打开网页就能直接播放**的
歌单，不需要登录 Telegram。和 Linggo 阅读器没有任何关系，只是借这个仓库存代码。

- 播放页：https://xiaoju-music.langhua98.workers.dev
- 分享单曲：在网址后加 `#消息号`，例如 `…/#4`
- 管理页：https://xiaoju-music.langhua98.workers.dev/admin（用管理密钥登录）

## 工作原理

音频文件一直存在 Telegram 里。Worker 在服务端持有机器人（@xiaoju_music_bot）的 token，
把「频道消息号」换成浏览器能直接播放的地址。频道里新发的音频由 webhook 推过来，自动登记。

### 超过 20 MB 的文件

官方 Bot API 的 `getFile` 只能取 20 MB 以内的文件。大文件的做法是**切片**：

1. 原文件切成每片 19 MB 的分片，发到一个私有的**仓库频道**（机器人是那里的管理员）；
2. 播放时 Worker 按浏览器要的 Range 算出落在哪几片上，逐片从 Telegram 取回、首尾相接地流给浏览器。
   浏览器看到的是和原文件逐字节相同的一个文件，拖进度条照常可用；
3. 一次响应最多拼 16 片（约 300 MB，受免费版每次请求 50 个子请求的限制）。更长的范围只给前 16 片，
   浏览器会接着要后面的；超过 16 片的文件不能整个下载，播放页会隐藏「下载」。

分片有两个来源：

- **自动**（推荐）：频道里一出现大文件，Worker 就把它派给 Hugging Face 上的切片服务
  （[`splitter/`](splitter/)）。机器人走 MTProto 能下载 2 GB，切片服务下载原文件、切片、上传到仓库频道，
  再回调 Worker 登记。切片服务没醒或处理失败时，定时任务（每 10 分钟）会按退避重派，同一首最多自动派 5 次；
- **手动**：管理页里对着那首歌选本地的同一个文件，浏览器切片后逐片上传（中断后重选同一个文件能接着传）。

状态流转：`pending`（等待派活）→ `queued`（已派出）→ `processing`（切片中，带进度）→ `ok`；
失败是 `failed`，带原因。只有 `ok` 的歌能播放。

## 路由

| 路径 | 作用 |
|---|---|
| `GET /` | 播放页（HTML 在 `worker.js` 末尾的 `PAGE` 常量里） |
| `GET /api/tracks` | 歌单 JSON，新的在前；不含 `file_id` |
| `GET /a/<消息号>` | 音频流，按 Range 取/拼分片（iOS Safari 开始播放、拖进度条都要 206）；加 `?dl=1` 变成下载 |
| `POST /tg-webhook` | Telegram 推送：频道新帖登记；机器人被拉进别的频道就记下来，供管理页选作仓库 |
| `GET /admin` | 管理页（`ADMIN_PAGE` 常量） |
| `GET /admin/api/state` | 管理页数据：仓库频道、候选频道、全部歌曲和处理状态 |
| `POST /admin/api/part?track=&index=&count=` | 手动上传一片（请求体就是分片字节，≤ 19 MB），Worker 流式转发到仓库频道 |
| `POST /admin/api/commit` | 登记分片清单 `{track, size, parts:[{file_id,size}], force?, mime?}` |
| `POST /admin/api/status` | 切片服务回报 `{track, status: processing｜failed, note}` |
| `POST /admin/api/retry` / `remove` / `storage` | 重新自动处理 / 从歌单移除 / 设仓库频道 |

管理接口都要 `Authorization: Bearer <ADMIN_KEY>`，响应不带 CORS 头。

## 数据

全部在 Durable Object `Library` 的 SQLite 里（强一致，也没有 KV list 每天 1000 次的限制）：

- `tracks`：每首歌一行，`rec` 是完整记录（含 `file_id`、分片清单 `parts`），外加 `status` / `note` /
  `attempts` / `updated`；
- `chats`：机器人所在的其它频道（从 webhook 的 `my_chat_member` 和频道帖子里记下），供选仓库；
- `config`：`storage`（仓库频道 id）、`storageTitle`、`migrated`。

第一次启动时，`Library` 会把旧版存在 KV（`TRACKS`）里的 `t:<消息号>` 记录搬过来，之后不再读写 KV。

## Cloudflare 配置

| 项 | 值 |
|---|---|
| Worker 名 | `xiaoju-music` |
| 账号 ID | `aca35ff5f62ae4208757219dbc3b489b` |
| Durable Object | 绑定名 `LIB`，类 `Library`（SQLite，迁移标签 `v1`），位置提示 `apac` |
| KV（旧） | `xiaoju-music-tracks`，id=`738216f3f7d64f1ab143128406d1b35e`，绑定名 `TRACKS`，只用于迁移 |
| Secret | `TG_BOT_TOKEN`、`TG_WEBHOOK_SECRET`、`ADMIN_KEY`、`SPLITTER_KEY` |
| 普通变量 | `CHANNEL_ID=-1003817921075`、`CHANNEL_USERNAME=xiaojumusic`、`BOT_USERNAME=xiaoju_music_bot`、`SPLITTER_URL`（切片服务地址，空＝不自动切片） |
| 定时任务 | `*/10 * * * *` |
| Telegram webhook | `…/tg-webhook`，`allowed_updates=["channel_post","edited_channel_post","my_chat_member"]` |

**secret 绝不能写进仓库**（这个仓库是公开的，GitHub Pages 会把它原样发布出去）。
`TG_WEBHOOK_SECRET` 在 Cloudflare 里读不回来；丢了就生成一个新的，同时更新 Worker 的 secret 和
Telegram 的 webhook（见下方「重设 webhook」）。

## 首次设置清单

1. **仓库频道**：在 Telegram 新建一个私有频道，把 @xiaoju_music_bot 加为管理员；打开管理页点「刷新」，
   把它「设为仓库」。
2. **切片服务**（自动处理才需要）：按 [`splitter/README.md`](splitter/README.md) 部署到 Hugging Face
   Space，把 Space 地址填进 Worker 的 `SPLITTER_URL`，两边的 `SPLITTER_KEY` 设成同一个值。
3. 已经在歌单里、状态是 `pending` 的大文件，定时任务会在 10 分钟内自动派出去；也可以在管理页点
   「重新自动处理」立刻派。

## 改完代码后

1. 跑本地测试（都不联网）：

   ```bash
   node xiaoju-music/test.mjs                              # Worker：模拟 Durable Object、Telegram、切片服务
   cd xiaoju-music/splitter && python -m pytest -q         # 切片服务
   ```

2. 重新部署 Worker。`keep_bindings` 会保留线上已有的 secret；迁移 `v1` 已经做过，平时部署**不要**再带
   `migrations`（以后新增 Durable Object 类时才需要，写成 `{"old_tag":"v1","new_tag":"v2",...}`）。
   Cloudflare API token 从环境变量 `CLOUDFLARE_API_TOKEN` 读（用「Edit Cloudflare Workers」模板建）：

   ```bash
   ACC=aca35ff5f62ae4208757219dbc3b489b
   KV=738216f3f7d64f1ab143128406d1b35e
   SPLITTER_URL=https://langhua1998-xiaoju-splitter.hf.space   # 没部署切片服务就写空字符串
   curl -X PUT "https://api.cloudflare.com/client/v4/accounts/$ACC/workers/scripts/xiaoju-music" \
     -H "Authorization: Bearer $CLOUDFLARE_API_TOKEN" \
     -F "metadata={\"main_module\":\"worker.js\",\"compatibility_date\":\"2026-01-01\",\"keep_bindings\":[\"secret_text\"],\"bindings\":[{\"type\":\"kv_namespace\",\"name\":\"TRACKS\",\"namespace_id\":\"$KV\"},{\"type\":\"durable_object_namespace\",\"name\":\"LIB\",\"class_name\":\"Library\"},{\"type\":\"plain_text\",\"name\":\"CHANNEL_ID\",\"text\":\"-1003817921075\"},{\"type\":\"plain_text\",\"name\":\"CHANNEL_USERNAME\",\"text\":\"xiaojumusic\"},{\"type\":\"plain_text\",\"name\":\"BOT_USERNAME\",\"text\":\"xiaoju_music_bot\"},{\"type\":\"plain_text\",\"name\":\"SPLITTER_URL\",\"text\":\"$SPLITTER_URL\"}]};type=application/json" \
     -F 'worker.js=@xiaoju-music/worker.js;type=application/javascript+module'
   ```

   也可以在本目录用 `wrangler deploy`（`wrangler.toml` 已写好绑定、迁移和定时任务，secret 不受影响）。

3. 改了切片服务：把 `splitter/` 下的 `app.py`、`Dockerfile`、`requirements.txt`、`README.md` 推到
   Hugging Face Space 的仓库，Space 会自动重新构建。

## 日常维护

- **移除一首**（频道里删帖不会通知机器人）、**重新自动处理**、**手动上传大文件**：都在管理页里点。
- **换机器人 token**（在 BotFather 发 `/revoke` 之后）：Worker 和切片服务都要换。

  ```bash
  curl -X PUT "https://api.cloudflare.com/client/v4/accounts/$ACC/workers/scripts/xiaoju-music/secrets" \
    -H "Authorization: Bearer $CLOUDFLARE_API_TOKEN" -H "Content-Type: application/json" \
    -d '{"name":"TG_BOT_TOKEN","text":"<新 token>","type":"secret_text"}'
  ```

  切片服务在 Space 的 Settings 里改 `TG_BOT_TOKEN`。换完用新 token 打开
  `https://api.telegram.org/bot<新 token>/getWebhookInfo`，确认 `url` 还指向本 Worker；不在了就重设。

- **重设 webhook**（换了 Worker 地址、换了 `TG_WEBHOOK_SECRET`，或 webhook 丢了）：

  ```bash
  curl "https://api.telegram.org/bot<机器人 token>/setWebhook" \
    -d url=https://xiaoju-music.langhua98.workers.dev/tg-webhook \
    -d secret_token=<与 Worker 的 TG_WEBHOOK_SECRET 相同> \
    --data-urlencode 'allowed_updates=["channel_post","edited_channel_post","my_chat_member"]'
  ```

  设了 webhook 之后 `getUpdates` 不再可用（两者互斥）。

- **补登记旧帖**：机器人加入频道之前发的帖子 webhook 收不到。当初 #4、#5 是这样补的：用
  `forwardMessage` 把旧帖静音转发回频道，从返回里读出 `audio`/`document`，立刻 `deleteMessage`
  删掉转发出来的副本，再把 `message_id`、`date` 换回原帖的值，拼成一个 `channel_post` update，
  带着 `X-Telegram-Bot-Api-Secret-Token` 头 POST 给 `/tg-webhook`。

## 限制

- 单个文件最大 2 GB（机器人走 MTProto 的下载上限）；超过 16 片（约 300 MB）的文件只能播放、不能在网页整个下载。
- 频道里删掉的帖子不会自动从歌单消失，在管理页移除。
- `workers.dev` 在中国大陆被屏蔽，不开 VPN 打不开；要给国内用户用，需要绑定自定义域名。
- 音频不经 Cloudflare 缓存，每次都从 Telegram 现取，第一次播放首字节约 1～2 秒。
- 切片服务在 Hugging Face 免费版上，闲置 48 小时会休眠；休眠期间来的大文件要等它被唤醒（最多约 10～20 分钟）。
