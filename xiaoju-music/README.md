# 小橘音乐 · Telegram 频道音频中转（Cloudflare Worker）

把 Telegram 频道 [@xiaojumusic](https://t.me/xiaojumusic) 里的音频变成**打开网页就能直接播放**的
歌单，不需要登录 Telegram。和 Linggo 阅读器没有任何关系，只是借这个仓库存代码。

- 播放页：https://xiaoju-music.langhua98.workers.dev
- 分享单曲：在网址后加 `#消息号`，例如 `…/#4`
- 管理页：https://xiaoju-music.langhua98.workers.dev/admin（用管理密钥登录，用来移除频道里已删掉的歌）

## 工作原理

音频文件一直存在 Telegram 里。Worker 在服务端持有机器人（@xiaoju_music_bot）的 token，
把「频道消息号」换成浏览器能直接播放的地址。频道里新发的音频由 webhook 推过来，自动登记。

- **20 MB 以内**：Worker 用官方 Bot API 的 `getFile` 取文件，按浏览器的 Range 透传。
- **超过 20 MB**：`getFile` 取不了。Worker 把 Range 请求转给 Hugging Face 上的流式服务
  （[`streamer/`](streamer/)）：它以机器人身份走 MTProto（没有 20 MB 限制），浏览器要哪一段，
  就从 Telegram 现取哪一段、边取边传。不落盘、不切片，拖进度条直接跳。

流式服务在 Hugging Face 免费版上，闲置约 48 小时会休眠。休眠时 Worker 转过去的第一个请求会把它叫醒，
Worker 先回 `503` + `Retry-After`，播放页提示「正在唤醒」并每 10 秒重试一次（最多等 2 分钟）。
所以大文件的播放依赖这个 Space 在线；小文件完全不经过它。

## 路由

| 路径 | 作用 |
|---|---|
| `GET /` | 播放页（`page.html`：深色沉浸式，电脑两栏、手机歌单 + 迷你条 + 全屏播放） |
| `GET /c/<消息号>` | 专辑封面：新歌用帖子里的缩略图，更早的歌请流式服务用 MTProto 取；取一次就存进数据库，确定没有的记为没有 |
| `GET /api/tracks` | 歌单 JSON，新的在前；每首带 `big`（超过 20 MB）和 `playable`，不含 `file_id` |
| `GET /a/<消息号>` | 音频流，支持 Range（iOS Safari 开始播放、拖进度条都要 206）；加 `?dl=1` 变成下载 |
| `POST /tg-webhook` | Telegram 推送频道新帖，音频自动登记 |
| `GET /admin` | 管理页（`admin.html`） |
| `GET /admin/api/state` / `POST /admin/api/remove` | 管理页数据 / 从歌单移除一首（`{track}`） |

管理接口都要 `Authorization: Bearer <ADMIN_KEY>`，响应不带 CORS 头。

## 数据

在 Durable Object `Library` 的 SQLite 里（强一致，也没有 KV list 每天 1000 次的限制）：

- `songs`：每首歌一行，`rec` 是完整记录（含 `file_id`、大小、类型、标题等）；
- `covers`：封面（base64 文本；`mime='none'` 表示确定没有）。频道里 FLAC 占大多数，它们没有内嵌封面，
  播放页给这些歌按歌名生成渐变色块加首字；
- `config`：`migrated`（已从 KV 迁移过）。

`Library` 启动时会做两次性的迁移：最早版本存在 KV（`TRACKS`）里的 `t:<消息号>` 记录搬进来；
试过「切片」方案的那一版留下的 `tracks` 表、`chats` 表和仓库频道配置，搬完或删掉。

## Cloudflare 配置

| 项 | 值 |
|---|---|
| Worker 名 | `xiaoju-music` |
| 账号 ID | `aca35ff5f62ae4208757219dbc3b489b` |
| Durable Object | 绑定名 `LIB`，类 `Library`（SQLite，迁移标签 `v1`），位置提示 `apac` |
| KV（旧） | `xiaoju-music-tracks`，id=`738216f3f7d64f1ab143128406d1b35e`，绑定名 `TRACKS`，只用于迁移 |
| Secret | `TG_BOT_TOKEN`、`TG_WEBHOOK_SECRET`、`ADMIN_KEY`、`STREAMER_KEY` |
| 普通变量 | `CHANNEL_ID=-1003817921075`、`CHANNEL_USERNAME=xiaojumusic`、`STREAMER_URL`（流式服务地址，空＝大文件不能播放） |
| Telegram webhook | `…/tg-webhook`，`allowed_updates=["channel_post","edited_channel_post"]` |

**secret 绝不能写进仓库**（这个仓库是公开的，GitHub Pages 会把它原样发布出去）。
`TG_WEBHOOK_SECRET` 在 Cloudflare 里读不回来；丢了就生成一个新的，同时更新 Worker 的 secret 和
Telegram 的 webhook（见下方「重设 webhook」）。

## 部署流式服务

流式服务跑在 Hugging Face Space **`langhua1998/douyin-proxy`** 上，地址
`https://langhua1998-douyin-proxy.hf.space`。2026 年 9 月起，免费账号新建、复制、迁移（含改名）
Docker Space 都要 PRO 订阅，已有的 Space 还能免费运行，所以复用了这个原本做抖音链接解析代理的 Space
（原来的代码在它的 Git 历史里，提交 `031d368d79`）。

更新代码：把 `streamer/` 下的 `app.py`、`Dockerfile`、`requirements.txt`、`README.md` 推到这个 Space 的仓库，
Space 会自动重新构建。环境变量见 [`streamer/README.md`](streamer/README.md)；Worker 的 `STREAMER_URL`
填上面的地址，两边的 `STREAMER_KEY` 设成同一个值。

## 改完代码后

1. 跑本地测试（都不联网）：

   ```bash
   node xiaoju-music/test.mjs                              # Worker：模拟 Durable Object、Telegram、流式服务
   cd xiaoju-music/streamer && python -m pytest -q         # 流式服务
   ```

2. 重新部署 Worker。`keep_bindings` 会保留线上已有的 secret；迁移 `v1` 已经做过，平时部署**不要**再带
   `migrations`（以后新增 Durable Object 类时才需要，写成 `{"old_tag":"v1","new_tag":"v2",...}`）。
   Cloudflare API token 从环境变量 `CLOUDFLARE_API_TOKEN` 读（用「Edit Cloudflare Workers」模板建）：

   ```bash
   ACC=aca35ff5f62ae4208757219dbc3b489b
   KV=738216f3f7d64f1ab143128406d1b35e
   STREAMER_URL=https://langhua1998-douyin-proxy.hf.space      # 没部署流式服务就写空字符串
   curl -X PUT "https://api.cloudflare.com/client/v4/accounts/$ACC/workers/scripts/xiaoju-music" \
     -H "Authorization: Bearer $CLOUDFLARE_API_TOKEN" \
     -F "metadata={\"main_module\":\"worker.js\",\"compatibility_date\":\"2026-01-01\",\"keep_bindings\":[\"secret_text\"],\"bindings\":[{\"type\":\"kv_namespace\",\"name\":\"TRACKS\",\"namespace_id\":\"$KV\"},{\"type\":\"durable_object_namespace\",\"name\":\"LIB\",\"class_name\":\"Library\"},{\"type\":\"plain_text\",\"name\":\"CHANNEL_ID\",\"text\":\"-1003817921075\"},{\"type\":\"plain_text\",\"name\":\"CHANNEL_USERNAME\",\"text\":\"xiaojumusic\"},{\"type\":\"plain_text\",\"name\":\"STREAMER_URL\",\"text\":\"$STREAMER_URL\"}]};type=application/json" \
     -F 'worker.js=@xiaoju-music/worker.js;type=application/javascript+module' \
     -F 'page.html=@xiaoju-music/page.html;type=text/plain' \
     -F 'admin.html=@xiaoju-music/admin.html;type=text/plain'
   ```

   `page.html`、`admin.html` 以 `text/plain` 上传，就是 Workers 的文本模块，`worker.js` 里 `import` 进来当字符串用。
   也可以在本目录用 `wrangler deploy`（`wrangler.toml` 已写好绑定、迁移和 `.html` 文本模块规则，secret 不受影响）。

3. 改了流式服务：把 `streamer/` 下那四个文件推到 `langhua1998/douyin-proxy` 这个 Space 的仓库，Space 会自动重新构建。

## 日常维护

- **移除一首**（频道里删帖不会通知机器人）：在管理页点「移除」。
- **换机器人 token**（在 BotFather 发 `/revoke` 之后）：Worker 和流式服务都要换。

  ```bash
  curl -X PUT "https://api.cloudflare.com/client/v4/accounts/$ACC/workers/scripts/xiaoju-music/secrets" \
    -H "Authorization: Bearer $CLOUDFLARE_API_TOKEN" -H "Content-Type: application/json" \
    -d '{"name":"TG_BOT_TOKEN","text":"<新 token>","type":"secret_text"}'
  ```

  流式服务在 Space 的 Settings 里改 `TG_BOT_TOKEN`。换完用新 token 打开
  `https://api.telegram.org/bot<新 token>/getWebhookInfo`，确认 `url` 还指向本 Worker；不在了就重设。

- **重设 webhook**（换了 Worker 地址、换了 `TG_WEBHOOK_SECRET`，或 webhook 丢了）：

  ```bash
  curl "https://api.telegram.org/bot<机器人 token>/setWebhook" \
    -d url=https://xiaoju-music.langhua98.workers.dev/tg-webhook \
    -d secret_token=<与 Worker 的 TG_WEBHOOK_SECRET 相同> \
    --data-urlencode 'allowed_updates=["channel_post","edited_channel_post"]'
  ```

  设了 webhook 之后 `getUpdates` 不再可用（两者互斥）。

- **补登记旧帖**：机器人加入频道之前发的帖子 webhook 收不到。当初 #4、#5 是这样补的：用
  `forwardMessage` 把旧帖静音转发回频道，从返回里读出 `audio`/`document`，立刻 `deleteMessage`
  删掉转发出来的副本，再把 `message_id`、`date` 换回原帖的值，拼成一个 `channel_post` update，
  带着 `X-Telegram-Bot-Api-Secret-Token` 头 POST 给 `/tg-webhook`。

## 限制

- 大文件的播放依赖流式服务在线：Space 休眠时第一次播放要等它醒（约 1～2 分钟），重启时正在播的会中断后自动重试。
- 频道里删掉的帖子不会自动从歌单消失，在管理页移除。
- `workers.dev` 在中国大陆被屏蔽，不开 VPN 打不开；要给国内用户用，需要绑定自定义域名。
- 音频不经 Cloudflare 缓存，每次都从 Telegram 现取，第一次播放首字节约 1～2 秒。
