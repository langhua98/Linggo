# 小橘音乐 · Telegram 频道音频中转（Cloudflare Worker）

把 Telegram 频道 [@xiaojumusic](https://t.me/xiaojumusic) 里的音频变成**打开网页就能直接播放**的
歌单，不需要登录 Telegram。和 Linggo 阅读器没有任何关系，只是借这个仓库存代码。

- 播放页：https://xiaoju-music.langhua98.workers.dev
- 分享单曲：在网址后加 `#消息号`，例如 `…/#4`
- 管理页：https://xiaoju-music.langhua98.workers.dev/admin（用管理密钥登录，用来移除频道里已删掉的歌）
- 刷视频：https://xiaoju-music.langhua98.workers.dev/video（像快手那样随机刷视频频道「小橘视频」里的视频，见下方「刷视频网页」；
  分享某一条在网址后加 `#消息号`。和播放页一样**谁拿到链接都能看**，频道本身是私有的也一样）

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
| `GET /` | 播放页（`page.html`：深色沉浸式，电脑两栏、手机歌单 + 迷你条 + 全屏播放（往下拖收起、往上拖下一首）；「全部 / 歌单 / 我喜欢 / 歌手」四个页签（歌单是管理员编的），歌手页按歌手把歌归在一起，合唱的歌几位歌手底下都有） |
| `GET /l/<消息号>` | 歌词 JSON：`{src, synced, lines: [[秒, 这句], …]}`（`synced` 为 false 时只有文字、秒是 null）。先看数据库，没有就去 LRCLIB、网易云找，找到（或确定没有）就存起来，见下方「歌词」 |
| `GET /v/<消息号>` | 音柱数据：这首歌每秒 15 帧、每帧 16 个频段（50 Hz～5 kHz）各多响，0～15，两个值一个字节（开头 `XV` + 版本 + 帧率 + 频段数）。第一次请流式服务 `/viz` 把整首歌取下来用 ffmpeg 解码算好，存进数据库 `viz` 表（算不了记空字符串）；播放页按播放进度画音柱，不用 Web Audio，iPhone 锁屏、切后台照常出声 |
| `GET /c/<消息号>` | 封面：优先用音乐文件自带的缩略图（新歌走 Bot API，更早的歌请流式服务用 MTProto 取）；没有就从频道的图片帖里随机挑一张（新图片帖由 webhook 记下，更早的由流式服务 `/photos` 按消息号扫出来）。挑定后存进数据库（`own` 列记着是自带的还是配的图），不再变。带 `?art=1` 时只给自带的专辑图，配的频道图片回 404——播放页和歌曲列表这样请求，没有专辑图的歌由网页画文字封面（歌名 + 歌手）；歌单宫格不带它 |
| `GET /api/tracks` | 歌曲 JSON，新的在前；每首带 `big`（超过 20 MB）和 `playable`，不含 `file_id`；`playlists` 是管理员编的歌单 |
| `GET /a/<消息号>` | 音频流，支持 Range（iOS Safari 开始播放、拖进度条都要 206）；加 `?dl=1` 变成下载 |
| `POST /tg-webhook` | Telegram 推送频道新帖，音频自动登记；回复某首歌发的 `.lrc` 文件就是这首的歌词 |
| `GET /admin` | 管理页（`admin.html`） |
| `GET /admin/api/state` / `POST /admin/api/remove` | 管理页数据 / 从歌单移除一首（`{track}`） |
| `GET/POST /admin/api/sources` | 搬歌用的「音乐来源频道」名单（`{sources: [用户名…]}`）。频道主账号加入这些频道（静音、归档）后，流式服务的 `/search/global` 一次搜遍，只认名单里的频道 |
| `POST /admin/api/reshuffle-photo-covers` | 频道里新加了图片后用：没有自带封面、用着频道图片的歌清掉封面，下次打开时从现在的图库里重新挑 |
| `POST /admin/api/ban-cover` | 这首现在的封面不要了（`{track}`）：用这张图的歌都改用频道图片，以后也不再用它 |
| `POST /admin/api/playlists` | 整体设置歌单：`{playlists: [{id?, name, cover?, tracks: [消息号…]}]}`，顺序就是显示顺序；带 `id` 的原地改，没列出的删掉 |
| `GET /video` | 刷视频网页（`video.html`），见下方「刷视频网页」 |
| `GET /api/videos` | 视频池 JSON：`{videos: [{id, d 秒数, w, h, day, by 账号, text 文案}], syncing}`，新的在前，不含 `file_id`。离上次和频道对一遍超过 30 分钟，就在后台再对一遍 |
| `GET /vf/<消息号>` | 视频流，支持 Range。20 MB 以内、webhook 记下了 Bot API `file_id` 的走 Bot API，其余走流式服务 `/vstream` |
| `GET /vp/<消息号>` | 视频封面（转视频时截的第一秒），取一次存进数据库 |
| `GET/POST /admin/api/videos` | 视频池有多少条、上次什么时候和频道对过 / 马上对一遍 |

管理接口都要 `Authorization: Bearer <ADMIN_KEY>`，响应不带 CORS 头。

## 数据

在 Durable Object `Library` 的 SQLite 里（强一致，也没有 KV list 每天 1000 次的限制）：

- `songs`：每首歌一行，`rec` 是完整记录（含 `file_id`、大小、类型、标题等）；
- `covers`：每首歌定下来的封面（base64 文本；`mime='none'` 表示频道里连图片都没有）。FLAC 占大多数且没有内嵌封面，
  所以大多数歌用的是频道图片；
- `logo_covers`：不当封面用的图（别的频道的台标）。同一张图被 8 首以上的歌当封面会自动记进来，也可以用 `ban-cover` 手动加；
- `photos`：频道里的图片帖（`file_id` 为空的是流式服务扫出来的老帖，由它下载）；
- `lyrics`：每首歌的歌词原文，`src` 是 `lrclib` / `netease` / `manual`（频道里手动发的）/ `none`（确定没有）；
  `retry_at` 不为 0 时，过了这个时间再去外面找一次；
- `playlists`：管理员编的歌单（`pos` 顺序、`name`、`cover` 封面用哪首歌的消息号、`tracks` 消息号 JSON 数组）；
- `videos`：刷视频网页的视频池，视频频道里每条视频帖一行（`rec` 含 Bot API 的 `file_id`、缩略图、大小、时长、宽高、说明）；
- `video_thumbs`：视频封面（base64；`mime='none'` 表示确定没有）；
- `config`：`migrated`（已从 KV 迁移过）；`vSyncAt` / `vSyncOk`（视频池上次开始对、对成功的时间）。

**收藏（我喜欢）不在服务器上**：存在各人浏览器的 localStorage 里（`xm-favs`，消息号数组，新收藏的在前；
页签、从哪一页点的歌之类的偏好在 `xm-prefs`）。所以换设备、换浏览器看不到，清网站数据就没了。
在「我喜欢」里点的歌，上一首/下一首只在收藏里切。

`Library` 启动时会做两次性的迁移：最早版本存在 KV（`TRACKS`）里的 `t:<消息号>` 记录搬进来；
试过「切片」方案的那一版留下的 `tracks` 表、`chats` 表和仓库频道配置，搬完或删掉。

## 歌词

播放页点唱片（或歌名旁边的歌词按钮）切到歌词：正在唱的那句居中、亮起来，点某一句就跳过去；唱片那一面在歌手下面显示正在唱的这一句。

**自动找**：某首歌第一次被人打开时，Worker 先查 [LRCLIB](https://lrclib.net)（公开的歌词库），没有再问网易云
（用的是它网页版的接口，不是公开 API，哪天改了就只剩 LRCLIB）。只要歌名、歌手对得上，**时长相差 3 秒以内**
的带时间轴歌词；时长对不上（多半是 DJ 版、Live 版这类别的版本）就退一步，只显示文字、不跟着滚。
找到什么都存进 `lyrics` 表，以后不再出去找。完全没有的 14 天后再找一次，只有文字的 30 天后再找一次；
有一边正好出错时 1 天后就再找。

**手动配**：在频道里**回复**那首歌，发一个 `.lrc` 文件，就是这首的歌词，自动找到的盖不掉它；再回复一个新的就换掉。
不回复的话，按文件名找（`歌名.lrc` 或 `歌手 - 歌名.lrc`），只有唯一一首对得上才算。
UTF-8、GBK、UTF-16 编码都认；配上之后可以把频道里的这条 `.lrc` 删掉，歌词已经存在数据库里了。

## Cloudflare 配置

| 项 | 值 |
|---|---|
| Worker 名 | `xiaoju-music` |
| 账号 ID | `aca35ff5f62ae4208757219dbc3b489b` |
| Durable Object | 绑定名 `LIB`，类 `Library`（SQLite，迁移标签 `v1`），位置提示 `apac` |
| KV（旧） | `xiaoju-music-tracks`，id=`738216f3f7d64f1ab143128406d1b35e`，绑定名 `TRACKS`，只用于迁移 |
| Secret | `TG_BOT_TOKEN`、`TG_WEBHOOK_SECRET`、`ADMIN_KEY`、`STREAMER_KEY` |
| 普通变量 | `CHANNEL_ID=-1003817921075`、`CHANNEL_USERNAME=xiaojumusic`、`STREAMER_URL`（流式服务地址，空＝大文件不能播放）、`VIDEO_CHANNEL_ID=-1004292843233`（视频频道「小橘视频」） |
| Telegram webhook | `…/tg-webhook`，`allowed_updates=["channel_post","edited_channel_post"]` |

**secret 绝不能写进仓库**（这个仓库是公开的，GitHub Pages 会把它原样发布出去）。
`TG_WEBHOOK_SECRET` 在 Cloudflare 里读不回来；丢了就生成一个新的，同时更新 Worker 的 secret 和
Telegram 的 webhook（见下方「重设 webhook」）。

## 刷视频网页

`/video`：像快手那样竖着刷视频频道「小橘视频」里的视频。上滑下一条、下滑回上一条，点一下暂停，双击喜欢，底下的进度条可以拖；
电脑上用滚轮、键盘 ↑↓ 或右边的按钮。

- **随机 + 浏览记录**：看过的视频按顺序记在浏览器里（`localStorage` 的 `xv-hist`，最近 300 条，`xv-pos` 是正在看第几条）。
  下滑按记录往回走，记录不变；往回翻过再上滑也按记录往前；走到记录最新那条再上滑，才从视频池里随机抽一条新的
  （最近看过的约八成先不抽，都看过了再放开）。下一条是预先抽好、提前加载的，所以上滑马上能放。
  每次重新打开网页从一条随机的新视频开始（接在记录后面），往下滑就是上次看的；刷新页面（地址里带着 `#消息号`）停在原来那条。
  右边「记录」打开浏览记录和「我喜欢」，点一条就跳过去。喜欢存在 `xv-favs`。**都只在这个浏览器里**，换设备看不到。
- **视频池从哪来**：webhook 收到视频频道的新视频帖马上登记（帖子说明拆成账号标签/作者、日期、文案）；机器人自己转进去的帖子
  （发视频文件点「转到视频频道」）webhook 收不到，更早的帖子也是，所以有人打开网页时，离上次超过 30 分钟就请流式服务
  `GET /videos` 把频道翻一遍（频道主账号翻，只读）：补上没登记的，去掉频道里删了的（只删比这次翻到的最新一条还旧的，
  翻完以后才发的新帖不会被误删；没翻完、给不了列表都不删）。对不成（流式服务在休眠）两分钟后再试。
  第一次打开时视频池还是空的，网页会显示「正在从频道取视频」，等对完自己开始放。
- **播放**：和音乐一样，20 MB 以内走 Bot API，更大的（抖音最高画质大多超过 20 MB）走流式服务 `/vstream/<消息号>`，
  机器人身份按消息号边取边传。流式服务在休眠时网页提示「正在唤醒」并自己重试；流式服务明确说这条没了
  （404 + `detail: gone`）才从视频池去掉，网页跳到下一条。Space 还是旧代码（没有 `/vstream`）时的 404 当作暂时取不到，不会误删。
- **声音**：浏览器一般不让网页一打开就出声：先静音放，顶上提示「点一下打开声音」，点一下（或滑一下）以后都有声音。

## 部署流式服务

流式服务跑在 Hugging Face Space **`langhua1998/douyin-proxy`** 上，地址
`https://langhua1998-douyin-proxy.hf.space`。2026 年 9 月起，免费账号新建、复制、迁移（含改名）
Docker Space 都要 PRO 订阅，已有的 Space 还能免费运行，所以复用了这个原本做抖音链接解析代理的 Space
（原来的代码在它的 Git 历史里，提交 `031d368d79`）。

更新代码：把 `streamer/` 下的 `app.py`、`Dockerfile`、`requirements.txt`、`README.md` 和 `harvest/`、`douyin/` 两个目录
推到这个 Space 的仓库，Space 会自动重新构建（装 Chromium 那一步第一次要几分钟）。环境变量见 [`streamer/README.md`](streamer/README.md)；Worker 的 `STREAMER_URL`
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
     -F "metadata={\"main_module\":\"worker.js\",\"compatibility_date\":\"2026-01-01\",\"keep_bindings\":[\"secret_text\"],\"bindings\":[{\"type\":\"kv_namespace\",\"name\":\"TRACKS\",\"namespace_id\":\"$KV\"},{\"type\":\"durable_object_namespace\",\"name\":\"LIB\",\"class_name\":\"Library\"},{\"type\":\"plain_text\",\"name\":\"CHANNEL_ID\",\"text\":\"-1003817921075\"},{\"type\":\"plain_text\",\"name\":\"CHANNEL_USERNAME\",\"text\":\"xiaojumusic\"},{\"type\":\"plain_text\",\"name\":\"STREAMER_URL\",\"text\":\"$STREAMER_URL\"},{\"type\":\"plain_text\",\"name\":\"VIDEO_CHANNEL_ID\",\"text\":\"-1004292843233\"}]};type=application/json" \
     -F 'worker.js=@xiaoju-music/worker.js;type=application/javascript+module' \
     -F 'verify.js=@xiaoju-music/verify.js;type=application/javascript+module' \
     -F 'page.html=@xiaoju-music/page.html;type=text/plain' \
     -F 'admin.html=@xiaoju-music/admin.html;type=text/plain' \
     -F 'douyin-login.html=@xiaoju-music/douyin-login.html;type=text/plain' \
     -F 'video.html=@xiaoju-music/video.html;type=text/plain'
   ```

   `page.html`、`admin.html` 以 `text/plain` 上传，就是 Workers 的文本模块，`worker.js` 里 `import` 进来当字符串用。
   也可以在本目录用 `wrangler deploy`（`wrangler.toml` 已写好绑定、迁移和 `.html` 文本模块规则，secret 不受影响）。

3. 改了流式服务：把 `streamer/` 下的 `app.py`、`Dockerfile`、`requirements.txt`、`README.md` 和 `harvest/`、`douyin/`
   两个目录（不要测试文件）推到 `langhua1998/douyin-proxy` 这个 Space 的仓库，Space 会自动重新构建。

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
    --data-urlencode 'allowed_updates=["channel_post","edited_channel_post","message","callback_query"]'
  ```

  设了 webhook 之后 `getUpdates` 不再可用（两者互斥）。

- **补登记旧帖**：机器人加入频道之前发的帖子 webhook 收不到。当初 #4、#5 是这样补的：用
  `forwardMessage` 把旧帖静音转发回频道，从返回里读出 `audio`/`document`，立刻 `deleteMessage`
  删掉转发出来的副本，再把 `message_id`、`date` 换回原帖的值，拼成一个 `channel_post` update，
  带着 `X-Telegram-Bot-Api-Secret-Token` 头 POST 给 `/tg-webhook`。

## 机器人和自动搬歌

机器人 @xiaoju_music_bot 收私聊（webhook 要带 `message`、`callback_query`，见上面「重设 webhook」）。
私聊和按钮由 Worker 先回 200，再在后台处理（`botUpdate`）；要搜歌、搬歌的转给流式服务。

- **频道主**：频道的创建者（Worker 第一次用时问 `getChatAdministrators`，记在 config 的 `ownerId`）。能发：
  - `搜 歌名`：在来源频道里搜（流式服务 `/search/global`），列出来带「搬 N」按钮，点了走 `/copy/pick`。
  - `搬 @频道 N`：流式服务 `/copy/start`（只要中文、60 秒～20 分钟、查重），搬完机器人私聊通知。
  - `找 歌名`：在歌库里找，按钮可以加入/移出歌单、删除（删除只从歌库去掉，频道里的帖子不动，和管理页「移除」一样）。
  - `统计`：歌库总数、最近 1/7 天新增、上次夜里自动搬、各歌单首数。
  - 直接发歌名：和听众求歌一样，不限次。
- **听众求歌**：发歌名。歌库里有就回网页链接（`/#消息号`）；没有就交给流式服务 `/fulfill`：在来源频道里搜，
  按 `rank_requests` 挑最像的一首（歌名一样优先；DJ 版、伴奏、片段等用户没提就往后排；60 秒～15 分钟），
  搬进频道后机器人直接回链接；禁止转发的跳过试下一首。每人每 24 小时最多 10 次（`asks` 表）。
- **新歌自动分歌单**：webhook 收到的新音频帖（第一次登记的，不是编辑）按 `genresOf` 放进已有的同名歌单：
  歌名关键词（DJ/Remix/串烧 → DJ 劲爆，重低音/Bass → 重低音，Live → 现场 Live……）加歌手名单
  （`GENRE_ARTISTS`），一首可以进几个；都对不上但有歌手的进「华语流行」；MV、综艺、伴奏之类不进。
- **贴网址搬授权音频**（频道主私聊机器人发网址，可以带数量：`网址 30`）：流式服务的 `harvest/` 里分四块——
  `sites.py` 网站适配器（现在有互联网档案馆：条目、合集、`/search?query=`；维基共享资源：`File:`、`Category:`），
  `license.py` 授权检查（**每一首都要过**：只认 CC0、公有领域、CC BY 系列，且要是设置里勾选的；认不出、版权保留的跳过并写原因），
  `upload.py` 上传（下载，不是 mp3/m4a 的用 ffmpeg 转 mp3，用频道主账号发帖——机器人收不到自己发的帖子），
  `job.py` 串起来、查重、限数量、跑完把搬了/没搬（及原因）私聊频道主。帖子说明里写歌名、作者、`授权：`、`来源：` 原始链接。
  Worker 收到说明里有「授权：」「来源：」的新帖：设置里指定了歌单就放进去，否则按类型分（分不出类型不塞「华语流行」）。
  设置（`搬运设置` 面板点开关；`搬运数量 N`；`搬运歌单 名字|自动`，名字不存在就新建歌单）存在 config 的 `harvest`。
  授权以网站上标的为准：互联网档案馆的授权是上传者自己填的，标错了程序看不出来。
  加新网站：在 `sites.py` 写一个适配器（`key`、`name`、`match`、`items`）放进 `ADAPTERS`，再在 Worker 的 `HARVEST_SITES` 里加名字。
- **夜里自动搬**：Worker 的定时任务 `0 19 * * *`（北京时间凌晨 3 点）跑 `nightly`：叫醒流式服务，读上一晚
  `/auto/status`，把每个来源频道「看到的最大消息号」合进 config 的 `auto.state`，再 `/auto/start`：每个频道只看
  比上次新的帖子（`min_id`），最多 30 首；第一次只看最新 10 首；禁止转发、出错的频道跳过。搬完机器人私聊频道主。
  手动跑一次：`POST /admin/api/auto-run`；看记录：`GET /admin/api/auto-state`。
- **抖音视频转到视频频道**（频道主私聊机器人）。视频都发到单独的私有频道「小橘视频」（Worker 变量 `VIDEO_CHANNEL_ID`，
  机器人是那里的管理员），**不进音乐频道**；Worker 每次把它作为 `target` 传给流式服务。
  - 发抖音视频的分享链接（整段分享文字也行）→ 流式服务 `/douyin/link`：`douyin/links.py` 认链接（短链接跳一次），
    `web.py` 用无头 Chromium **不登录**打开抖音网页版，接口签名交给页面自己的安全脚本（不自己算 a_bogus），
    `items.py` 挑不带水印的 H.264，`job.py` 下载、ffmpeg 挪 moov 到开头 + 截缩略图、用频道主账号发进视频频道
    （说明里写文案、`📹 抖音 @作者 · 日期` 和原视频链接），好了/失败都私聊通知。
  - 发抖音**主页**的分享链接 → 同一个接口采集这个账号作品的公开链接（视频 `douyin.com/video/<作品号>`，
    图文 `douyin.com/note/<作品号>`，解析网站都认），机器人按视频、图文分开发给频道主；结果也在 `/douyin/status` 里。
    从 Hugging Face 连着跑 3 次都成功（每次约 24 秒）。
  - `转抖音视频` → `/douyin/mirror`：把频道主**自己的**抖音账号（config 的 `douyinSelf`，用
    `POST /admin/api/douyin-self {"sec_uid": ...}` 设；现在是抖音号 43947139）能看到的作品按发布顺序转进视频频道：
    视频发视频；图文发成相册（一组最多 10 张，多了自动分组，说明在第一张上；WebP 用 ffmpeg 转成 JPEG，Telegram
    不收当照片的长图整条改发文件）。下载地址就在作品列表里（不带水印的那个），不经第三方解析网站。
    碰上 Telegram 限流（FloodWait）等它说的秒数再发。只认自己的账号：别人的作品不批量搬。
    视频频道是单独的私有频道，Worker 只登记音乐频道的图片当封面，图文转过去不会混进歌的封面。
  - 查重：每次先把视频频道翻一遍（最近 3000 条），从帖子说明的原视频链接里认出转过的作品号，已有的跳过。
    **不要**改回 Telegram 搜索：实测刚发的帖子搜不到链接里的作品号，查重落空、发了重复的（已删掉）。
  - 发一个视频文件 → 机器人问一句，点「📤 转到视频频道」才 `copyMessage` 过去（原样复制，不经流式服务，一定能成）。
  - **云电脑（全部作品）**：不登录只能拿到公开主页第一页，要全部就在频道主自己的云电脑上登录抓。机器人发「云电脑」→
    给一个 GitHub Codespaces 链接（仓库根目录 `.devcontainer/douyin/`：Python 镜像 + desktop-lite 网页桌面，端口 6080，
    密码 xiaoju；建好时 `cloud/codespace-setup.sh` 装 MediaCrawler 和 Chromium。免费额度内不用绑卡，超了就停、不扣费），
    再给一条 `bash xiaoju-music/cloud/codespace-auto.sh <上传令牌> <账号,…>`（令牌是 config `cloudTok`）。**开机不自己抓**：频道主在机器人里点「▶️ 运行爬虫」（`运行爬虫`、`/crawl`，或进度面板上的按钮）才抓，Worker 记 config `dyCrawlReq`，云电脑每 20 秒问 `/dy-cloud-config` 拿到 `crawl: true` 就跑 `crawl.sh`，开抓报 `starting` 进度时清掉；机器人按 `dyCloudSeen`（云电脑上次来问的时间，90 秒内算开着）告诉频道主是马上开始还是等打开再抓；「停止云电脑抓取」连还没开始的这次也取消。频道主在 iPad Safari 里开
    网页桌面，终端里粘贴命令，在桌面弹出的浏览器里自己扫码登录（验证也在那里做）；`crawl.sh` 跑 MediaCrawler（creator、
    jsonl）后把文件 POST 到 Worker 的 `/dy-import`（`X-Token`），转给 `/douyin/import` 逐条下载、发进视频频道。
    **边抓边转**：crawl.sh 每 30 秒把 jsonl 里新写的几行送一批（`X-Final: 0`），抓完送剩下的和 `X-Final: 1`；
    流式服务第一批进来就开始转，后面的批次 `feed_import` 接着排队（重复的作品号不收），收到 final 或 20 分钟没动静才收尾、
    发总结。**最高画质**：crawl.sh 给 MediaCrawler 的 store 打补丁，每条另存 `xiaoju_video`（各档 bit_rate）和
    `xiaoju_images`，`mcimport` 用 `items.video_sources` 挑：分辨率最高的在前（同分辨率码率高、H.264 优先），
    `video_download_url`（默认画质）垫底；单个视频上限 1GB。每次开抓前用 `X-Token` 找 `/dy-cloud-config` 要最新账号名单。
  - **按账号分类**：每条帖子说明里带 `#账号标签`（`items.caption` 的 `item['tag']`），频道里点标签只看这个号。名字：
    `账号标签 2 小美` 起的（config `douyinTags`）优先，没起就用抖音昵称（流式服务转作品时报回 `tags_used`，Worker
    记进 `douyinTagsSeen`）。频道里置顶一条「📂 目录」（config `dyDirMsg`），名字变了就改它。频道里已有、说明里还没标签
    的帖子，转作品碰到时 `douyin_retag` 改说明补上，不重发。crawl.sh 另存 `xiaoju_sec_uid` / `xiaoju_nickname` 认账号。
  - **搜抖音 → 链接清单**：`搜抖音 舞蹈` 把词排进 `dySearchQueue`；云电脑开着时 `codespace-auto.sh` 每 20 秒问一次 `/dy-cloud-config` 有没有新排的词，有就跑 `cloud/search.sh`，发「搜抖音」不用敲命令就自动开搜（搜失败了 10 分钟后再试）
    （MediaCrawler 的 search 模式），结果每 30 秒一批 POST `/dy-search`（`X-Final: 0`，搜完 `X-Final: 1`），Worker 边收边发，编号接着排（`dySearchNum`），每批按点赞排好、私聊发频道主分享链接和文件地址（登记过的号标 👤），清单上不带转发按钮（作品数据存 config `dySearchRows`，最近 600 条）；搜完整份清单交给审核机器人（见下）。
    只私聊发链接，不下载、不转进频道（批量转进频道的只有登记过的账号）。
  - **只抓新的**：crawl.sh 开抓前 POST `/dy-known`（Worker 转给流式服务 `GET /douyin/posted`，翻一遍视频频道）拿已有的作品号
    写进 `~/.xiaoju/known.txt`；补丁让 MediaCrawler 翻作品列表时扔掉转过的（不读详情、不送），一整页（置顶、私密、仅好友
    的不算）全是转过的就停这个号。频道里删掉的帖子不在里面，下次会重抓重转。`XJ_FULL=1` 全部重抓（给旧帖补标签用）。
  - **进度**：crawl.sh 每 30 秒用 `cloud/progress.py` 算一次（每个号一共多少作品——补丁让 MediaCrawler 拿到账号资料时把昵称、
    作品数写进 `~/.xiaoju/creators.jsonl`；抓了多少——结果文件里 `xiaoju_sec_uid` 是它的行；送了多少），POST `/dy-progress`
    存进 config `dyCloud`。机器人发「进度」看云电脑和流式服务（`/douyin/status`）两边；按钮「⏹ 停止云电脑抓取」设 `dyStop`，
    云电脑下次报进度收到 `{stop: true}` 就关掉 MediaCrawler（剩下的不送）；「⏹ 停止小橘转发」调 `/douyin/stop` 取消正在跑的任务。
  - **审核机器人（@xiaojuverify_bot，`verify.js`）**：搜到的作品转进视频频道前，必须由频道主本人在审核机器人里审核。两个机器人各用各的令牌、各收各的 webhook（审核机器人是 `POST /verify-webhook`，独立 secret `verifySecret`），数据交接走共享后端——同一个 Durable Object 里的审核任务表：`rv:<任务号>`（状态 pending / approved / rejected / expired / paused、完整清单：作品 ID、链接、来源账号和 sec_uid、文案、文件地址）、`rvRows:<任务号>:<段>`（审核时那份完整作品数据，每段 100 条，转发就用它）、`rvIds`（最近 30 个任务）。
    - 搜完：小橘 `submitForReview` 写任务 → `deliverTask` 用审核机器人的令牌把清单分几条私聊发给频道主，最后一条带「✅ 通过，都是我的号 / ❌ 不通过」。
    - 频道主点了：审核机器人把结果写回任务表，再叫小橘 `onReviewDecision`；小橘重新从任务表读状态，只有 approved 才交给 `/douyin/import`，只转这一批、不登记这些号（登记了云电脑每次开机都会抓它们的全部作品；要长期同步的号用「添加抖音账号」单独加）。登记过的号在清单里标 👤，只作参考，不跳过审核。
    - 不默认通过：没接审核机器人、频道主还没在审核机器人里点「开始」、Telegram 出错 → paused（小橘发「🔁 重新送审」按钮；频道主在审核机器人里点「开始」也会自动补发）；24 小时没审 → expired（cron 每 30 分钟查一次）；不通过 → rejected；通过了但流式服务没接上 → 状态仍是 approved，小橘给「🔁 再试转发」。旧清单上的「📤 转 N」「一键转」「全部转」按钮一律不能用。
    - 接上：频道主在小橘里发「审核机器人 <BotFather 给的令牌>」，Worker 用 `getMe` 认令牌、给审核机器人 `setWebhook`，令牌存进 Durable Object（config `verifyTok`，不进代码库；也可以用 secret `VERIFY_BOT_TOKEN`），发令牌的那条消息删掉。「审核」看接好没有、哪些在等。
  - **换最高画质**：流式服务 `POST /douyin/delete {target, ids}` 删掉旧的抖音视频帖（只删说明里带抖音视频链接的视频，
    正在转作品时不删），之后查重认不出，下次就按最高画质重转。
    不用粘贴也行：`codespace-auto.sh` 拿 Codespaces 自带的 `GITHUB_TOKEN` POST `/dy-cloud-config`，Worker 找
    api.github.com 认出是仓库主人（`CLOUD_GH_USER`）才回上传令牌和账号。令牌存在云电脑的 `~/.xiaoju/env`，devcontainer 的 `postAttachCommand`（`cloud/codespace-auto.sh`）
    每次打开都连上小橘：用 `setsid nohup` 起一个不挂在终端上的守候进程（`codespace-auto.sh --watch`，`flock` 防重复，记录写 `~/.xiaoju/watch.log`，终端里只是 `tail -f` 它），关掉终端、网页断开都照常等；每 10 分钟 `git pull` 一次，脚本变了自己换新的。点「运行爬虫」才跑 `crawl.sh`；机器人的「搜抖音」「进度」按 `dyCloudSeen` 说云电脑连没连着。搜完出队时除了结果里的 `source_keyword`，还按云电脑报进度时的关键词出队（两边写法对不上时不会一直重搜）；MediaCrawler 自己存登录状态，没过期就不用再扫码。
    自己有 VPS 的话 `cloud/setup.sh <令牌> <账号>` 一键装 XFCE + xrdp（RDP 连），桌面放「抓抖音发给小橘」。
    也可以手动把导出文件发给机器人。抖音账号和验证全程只在频道主自己的机器上。
  - 视频频道的数字 id 用流式服务 `GET /channels/owned?title=小橘视频` 查（只在频道主自己建的频道里按名字找，不列别的聊天）。
  - 2026 年 10 月实测，没登录时抖音只给看一部分（所以**没有**做「账号发了新视频自动转」）：
    1. 账号**最新**的几条作品被藏起来：作品列表返回里带 `not_login_module`（「登录看更多最新作品」），
       按月份查也是空的——自动发现正好看不到要第一时间转的那几条。
    2. 作品列表**只给第一页**（18 条）：第二页起返回空的 `{"status_code": 0}`，更早的作品采不到。
       采集结果里这两种情况都会标出来（`hidden_newest`、`truncated`）。
    3. 单条作品的详情接口从海外机房 IP（Hugging Face）打开会弹**滑块验证**（风控），拿不到；不去做验证码。
       检测到验证码请求（`verify.zijieapi.com/captcha/get`）就立刻停下，机器人回复原因并提示直接发视频文件。
       作品列表接口目前没有弹验证。
  - 抖音 cookie 存在 Space 的 `/tmp/douyin-state.json`（下次接着当同一个访客，重启就没了），不登录任何抖音账号。

  定时任务的设置（部署脚本不会动它，改时间才需要）：

  ```bash
  curl -X PUT "https://api.cloudflare.com/client/v4/accounts/$ACC/workers/scripts/xiaoju-music/schedules" \
    -H "Authorization: Bearer $CLOUDFLARE_API_TOKEN" -H "Content-Type: application/json" -d '[{"cron":"0 19 * * *"}]'
  ```

## 限制

- 机器人只能私聊和它说过话的人（Telegram 的规定）：频道主、听众都要先在机器人那里点一次「开始」。

- 大概四分之一的歌（多是 DJ 版、翻唱）两个歌词库里都没有，要在频道里手动配 `.lrc`。
- LRCLIB 上不少中文歌词是繁体字（2026 年 9 月存下的 207 首里有 103 首），原样显示。
- 大文件的播放依赖流式服务在线：Space 休眠时第一次播放要等它醒（约 1～2 分钟），重启时正在播的会中断后自动重试。
- 频道里删掉的帖子不会自动从歌单消失，在管理页移除。
- 查重：频道里新发的歌如果和已有的歌名、歌手一样、时长相差 3 秒以内，就不进歌单（帖子本身还在频道里）。
- 收藏只存在当前浏览器里，不跨设备同步。刷视频网页的浏览记录、喜欢也是。iPhone 的 Safari 还会在连续 7 天（按用过 Safari 的天数算）没打开这个网站后
  清掉它存的数据，收藏也在内。
- `workers.dev` 在中国大陆被屏蔽，不开 VPN 打不开；要给国内用户用，需要绑定自定义域名。
- 音频不经 Cloudflare 缓存，每次都从 Telegram 现取，第一次播放首字节约 1～2 秒。
