# 小橘音乐 · Telegram 频道音频中转（Cloudflare Worker）

把 Telegram 频道 [@xiaojumusic](https://t.me/xiaojumusic) 里的音频变成**打开网页就能直接播放**的
歌单，不需要登录 Telegram。和 Linggo 阅读器没有任何关系，只是借这个仓库存代码。

- 播放页：https://xiaoju-music.langhua98.workers.dev
- 分享单曲：在网址后加 `#消息号`，例如 `…/#4`

## 工作原理

音频文件一直存在 Telegram 频道里。Worker 在服务端持有机器人（@xiaoju_music_bot）的 token，
把「频道消息号」换成浏览器能直接播放的地址：

| 路径 | 作用 |
|---|---|
| `GET /` | 播放页（HTML 内嵌在 `worker.js` 末尾的 `PAGE` 常量里） |
| `GET /api/tracks` | 歌单 JSON，新的在前 |
| `GET /a/<消息号>` | 音频流，透传 `Range`（iOS Safari 开始播放、拖进度条都要 206）；加 `?dl=1` 变成下载 |
| `POST /tg-webhook` | Telegram 推送频道新帖，音频自动登记进 KV |

频道里新发的音频（音乐、语音、音频类文件）由 webhook 推过来，约 1 分钟内出现在歌单里。
机器人是频道管理员，webhook 只收 `channel_post` / `edited_channel_post`，并且只认本频道。

## Cloudflare 配置

| 项 | 值 |
|---|---|
| Worker 名 | `xiaoju-music` |
| 账号 ID | `aca35ff5f62ae4208757219dbc3b489b` |
| KV 命名空间 | `xiaoju-music-tracks`，id=`738216f3f7d64f1ab143128406d1b35e`，绑定名 `TRACKS` |
| Secret | `TG_BOT_TOKEN`（机器人 token）、`TG_WEBHOOK_SECRET`（webhook 校验串） |
| 普通变量 | `CHANNEL_ID=-1003817921075`、`CHANNEL_USERNAME=xiaojumusic` |

KV 里每首歌一个键 `t:<消息号>`：值是完整记录（含 `file_id`），metadata 是歌单要显示的字段。
歌单只靠 `list()` 带出来的 metadata 拼，不逐条读。

**两个 secret 绝不能写进仓库**（这个仓库是公开的，GitHub Pages 会把它原样发布出去）。
`TG_WEBHOOK_SECRET` 在 Cloudflare 里读不回来；丢了就生成一个新的，同时更新 Worker 的 secret
和 Telegram 的 webhook（见下方「重设 webhook」）。

## 改完 worker.js 后

1. 先跑本地测试（模拟 KV 和 Telegram，不联网）：

   ```bash
   node xiaoju-music/test.mjs
   ```

2. 重新部署。`keep_bindings` 会保留线上已有的两个 secret，所以不需要机器人 token；
   Cloudflare API token 从环境变量 `CLOUDFLARE_API_TOKEN` 读（用「Edit Cloudflare Workers」模板建）：

   ```bash
   ACC=aca35ff5f62ae4208757219dbc3b489b
   KV=738216f3f7d64f1ab143128406d1b35e
   curl -X PUT "https://api.cloudflare.com/client/v4/accounts/$ACC/workers/scripts/xiaoju-music" \
     -H "Authorization: Bearer $CLOUDFLARE_API_TOKEN" \
     -F "metadata={\"main_module\":\"worker.js\",\"compatibility_date\":\"2026-01-01\",\"keep_bindings\":[\"secret_text\"],\"bindings\":[{\"type\":\"kv_namespace\",\"name\":\"TRACKS\",\"namespace_id\":\"$KV\"},{\"type\":\"plain_text\",\"name\":\"CHANNEL_ID\",\"text\":\"-1003817921075\"},{\"type\":\"plain_text\",\"name\":\"CHANNEL_USERNAME\",\"text\":\"xiaojumusic\"}]};type=application/json" \
     -F 'worker.js=@xiaoju-music/worker.js;type=application/javascript+module'
   ```

   也可以在本目录用 `wrangler deploy`（`wrangler.toml` 已写好绑定，secret 不受影响）。

## 日常维护

以下命令里的 `$ACC` / `$KV` 同上。

**从歌单里移除一首**：频道里删帖不会通知机器人，要手动删 KV 里对应的键。也可以在 Cloudflare
控制台 → Storage & Databases → KV → `xiaoju-music-tracks` 里直接删。

```bash
curl -X DELETE "https://api.cloudflare.com/client/v4/accounts/$ACC/storage/kv/namespaces/$KV/values/t:<消息号>" \
  -H "Authorization: Bearer $CLOUDFLARE_API_TOKEN"
```

**换机器人 token**（在 BotFather 发 `/revoke` 之后）：

```bash
curl -X PUT "https://api.cloudflare.com/client/v4/accounts/$ACC/workers/scripts/xiaoju-music/secrets" \
  -H "Authorization: Bearer $CLOUDFLARE_API_TOKEN" -H "Content-Type: application/json" \
  -d '{"name":"TG_BOT_TOKEN","text":"<新 token>","type":"secret_text"}'
```

换完用新 token 打开 `https://api.telegram.org/bot<新 token>/getWebhookInfo`，确认 `url` 还指向
本 Worker；不在了就重设 webhook。

**重设 webhook**（换了 Worker 地址、换了 `TG_WEBHOOK_SECRET`，或 webhook 丢了）：

```bash
curl "https://api.telegram.org/bot<机器人 token>/setWebhook" \
  -d url=https://xiaoju-music.langhua98.workers.dev/tg-webhook \
  -d secret_token=<与 Worker 的 TG_WEBHOOK_SECRET 相同> \
  --data-urlencode 'allowed_updates=["channel_post","edited_channel_post"]'
```

设了 webhook 之后 `getUpdates` 不再可用（两者互斥）。

**补登记旧帖**：机器人加入频道之前发的帖子 webhook 收不到。当初 #4、#5 是这样补的：用
`forwardMessage` 把旧帖静音转发回频道，从返回里读出 `audio`/`document`，立刻 `deleteMessage`
删掉转发出来的副本，再把 `message_id`、`date` 换回原帖的值，拼成一个 `channel_post` update，
带着 `X-Telegram-Bot-Api-Secret-Token` 头 POST 给 `/tg-webhook`。

## 限制

- 官方 Bot API 只能下载 **20 MB 以内**的文件；更大的在歌单里标灰，只能去原帖听。
- 频道里删掉的帖子不会自动从歌单消失，按上面的方法手动移除。
- `workers.dev` 在中国大陆被屏蔽，不开 VPN 打不开；要给国内用户用，需要绑定自定义域名。
- 音频不经 Cloudflare 缓存，每次都从 Telegram 现取，第一次播放首字节约 2 秒。
