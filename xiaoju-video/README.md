# 小橘视频 · 抖音转进视频频道、刷视频网页（Cloudflare Worker）

把频道主**自己**的抖音账号的作品（视频和图文）转进私有的 Telegram 频道「小橘视频」，再做成**打开网页就能刷**的短视频页
（上滑下一条、下滑回上一条）。和 Linggo 阅读器没有任何关系，只是借这个仓库存代码。

整体架构、接口和谁能调、密钥放在哪、部署、排障手册见 [`架构与技术支持.md`](架构与技术支持.md)。

**小橘视频和小橘音乐是两个独立的项目**：这里只管视频；音乐（歌单、歌词、搬歌）在 [`../xiaoju-music/`](../xiaoju-music/)。
两边各有各的 Worker、机器人、Durable Object 数据库、流式服务（Hugging Face Space），没有任何共用的代码和数据。

- 刷视频网页：https://xiaoju-video.langhua98.workers.dev/video （`/` 也一样）
- 管理页：https://xiaoju-video.langhua98.workers.dev/video-admin （`/admin` 一样；内容过滤规则、过滤记录）

## 由哪几块组成

| 块 | 在哪 | 干什么 |
|---|---|---|
| Worker | [`worker.js`](worker.js)（Cloudflare） | 小橘视频的机器人（频道主私聊、按钮）、视频池和刷视频网页、审核流程、内容过滤规则、云电脑的接口 |
| 审核机器人 | [`verify.js`](verify.js)，机器人 @xiaojuverify_bot | 搜到的作品转进频道前，频道主在这里审核；通过才转 |
| 流式服务 | [`streamer/`](streamer/)（Hugging Face Space，Docker） | 无头 Chromium 不登录取抖音作品、下载、ffmpeg、用频道主账号发进频道；超过 20 MB 的视频按消息号取 |
| 云电脑 | [`cloud/`](cloud/)（GitHub Codespaces，配置在仓库根的 `.devcontainer/douyin/`） | 在频道主自己的机器上登录抖音，用 MediaCrawler 抓全部作品、按关键词搜，结果送给 Worker |

## 路由

| 路径 | 作用 |
|---|---|
| `GET /`、`GET /video` | 刷视频网页（`video.html`） |
| `GET /api/videos` | 视频池 JSON（新的在前）；离上次和视频频道对一遍超过 30 分钟，就在后台再对一遍（补上 webhook 收不到的、去掉频道里删了的） |
| `GET /vf/<消息号>` | 视频流，支持 Range（20 MB 以内走 Bot API，更大的走流式服务 `/vstream`） |
| `GET /vp/<消息号>` | 视频封面（缩略图），取一次就存起来 |
| `POST /tg-webhook` | 小橘视频机器人的 webhook：视频频道的新帖登记进视频池；频道主私聊和按钮 |
| `POST /verify-webhook` | 审核机器人的 webhook |
| `POST /dy-import` `/dy-cloud-config` `/dy-search` `/dy-progress` `/dy-known` | 云电脑用（`X-Token` 认人） |
| `POST /streamer-up` `/streamer-done` | 流式服务来报到、报结束（`X-Key` 认人） |
| `GET /douyin-login`、`/dl/…` | 在网页上扫码登录抖音 |
| `GET /video-admin`、`/admin`；`/admin/api/…` | 管理页和管理接口（`Authorization: Bearer <ADMIN_KEY>`）：`videos`、`filters`、`filters-delete`、`filter-log`、`douyin-self`、`douyin-search-queue`、`douyin-auto` |

## 数据

在 Durable Object `Library` 的 SQLite 里（只有视频这一边的数据）：

- `videos`：视频池，每条一行（`rec` 是完整记录，含 Bot API 的 `file_id`）；`video_thumbs`：封面（base64）；
- `filter_rules`、`filter_log`：内容过滤规则和过滤记录（见下面「内容过滤规则」）；
- `dy_resume`：交给流式服务、还没转完的导入任务的作品数据（任务说明在 config 的 `dyResume`）；
- `config`：账号、标签、云电脑令牌、搜索队列、审核任务等各种设置。

## Cloudflare 配置

| 项 | 值 |
|---|---|
| Worker 名 | `xiaoju-video`（`wrangler.toml`） |
| 账号 ID | `aca35ff5f62ae4208757219dbc3b489b` |
| Durable Object | 绑定名 `LIB`，类 `Library`（SQLite，迁移标签 `v1`） |
| Secret | `TG_BOT_TOKEN`（**小橘视频自己的机器人**）、`TG_WEBHOOK_SECRET`、`ADMIN_KEY`、`STREAMER_KEY` |
| 普通变量 | `STREAMER_URL`（流式服务地址）、`VIDEO_CHANNEL_ID`（视频频道的数字 id） |
| 定时任务 | `*/5 * * * *`（流式服务重启后没来报到的，自己去问、再交一次）、`*/30 * * * *`（审核单到期、抖音自动同步） |
| Telegram webhook | `…/tg-webhook`，`allowed_updates=["channel_post","edited_channel_post","message","callback_query"]` |

**secret 绝不能写进仓库**（这个仓库是公开的）。

## 改完代码后

1. 跑本地测试（都不联网）：

   ```bash
   node xiaoju-video/test.mjs                              # Worker：模拟 Durable Object、Telegram、流式服务
   cd xiaoju-video/streamer && python -m pytest -q         # 流式服务
   ```

2. 重新部署 Worker（`wrangler deploy`，或 Cloudflare API；`keep_bindings` 保留线上已有的 secret）：

   ```bash
   ACC=aca35ff5f62ae4208757219dbc3b489b
   SU=https://langhua1998-douyin-proxy.hf.space
   curl -X PUT "https://api.cloudflare.com/client/v4/accounts/$ACC/workers/scripts/xiaoju-video" \
     -H "Authorization: Bearer $CLOUDFLARE_API_TOKEN" \
     -F "metadata={\"main_module\":\"worker.js\",\"compatibility_date\":\"2026-01-01\",\"keep_bindings\":[\"secret_text\"],\"bindings\":[{\"type\":\"durable_object_namespace\",\"name\":\"LIB\",\"class_name\":\"Library\"},{\"type\":\"plain_text\",\"name\":\"STREAMER_URL\",\"text\":\"$SU\"},{\"type\":\"plain_text\",\"name\":\"VIDEO_CHANNEL_ID\",\"text\":\"-1004292843233\"}]};type=application/json" \
     -F 'worker.js=@xiaoju-video/worker.js;type=application/javascript+module' \
     -F 'verify.js=@xiaoju-video/verify.js;type=application/javascript+module' \
     -F 'video.html=@xiaoju-video/video.html;type=text/plain' \
     -F 'video-admin.html=@xiaoju-video/video-admin.html;type=text/plain' \
     -F 'douyin-login.html=@xiaoju-video/douyin-login.html;type=text/plain'
   ```

   第一次部署新 Worker 时要带 `migrations`（`{"new_tag":"v1","new_sqlite_classes":["Library"]}`）；之后**不要**再带。
   定时任务不在这条命令里，用 `PUT …/workers/scripts/xiaoju-video/schedules` 设（或 `wrangler deploy` 按 `wrangler.toml` 设）。

3. 改了流式服务：把 `streamer/` 下的 `app.py`、`Dockerfile`、`requirements.txt`、`README.md`（顶部有 Space 的配置）和 `douyin/` 目录
   推到视频的 Space（`langhua1998/douyin-proxy`）的仓库，Space 会自动重新构建（装 Chromium 第一次要几分钟）。
   **推之前先在机器人里发「进度」**：Space 一重新构建，正在跑的任务就断了；断了的会在它重新起来后由 Worker 再交一次，已经发进频道的会跳过。

## 第一次上线（从合并时期的小橘音乐 Worker 拆出来）

拆之前，音乐和视频是同一个 Worker（`xiaoju-music`）、同一个机器人、同一个数据库、同一个 Space。代码已经分开，线上要自己切：

1. **机器人**：在 @BotFather 给小橘视频新建一个机器人，设成视频频道「小橘视频」的管理员；把 token 填进新 Worker 的 `TG_BOT_TOKEN`，
   给它 `setWebhook`（见下）。频道主要先在新机器人里点一次「开始」。
2. **Worker**：按上面的命令部署 `xiaoju-video`，设好四个 secret（`STREAMER_KEY` 和 Space 的同一个值）。
3. **数据**：视频池靠流式服务翻频道自动补回；但账号（`douyinSelf`）、标签、云电脑令牌、过滤规则、审核任务这些设置在旧 Worker 的数据库里，
   新 Worker 是空的，要重新设（管理页 / 机器人里重发「添加抖音账号」等），或者先从旧数据库导出再写进来。
4. **Space**：把 `streamer/`（视频的）推到 `langhua1998/douyin-proxy`，环境变量里 `TG_BOT_TOKEN` 换成视频的机器人，加 `WORKER_URL`。
5. **云电脑**：脚本里的地址已经是 `xiaoju-video.langhua98.workers.dev`，`.devcontainer/douyin/` 里的路径也改成了 `xiaoju-video/cloud/`。
   云电脑每 10 分钟从 `main` 拉一次脚本：**在 `main` 上的路径改动生效之前，先确认新 Worker 已经能用**，不然云电脑里正在守候的脚本会找不到文件。
   在机器人里重新发「云电脑」拿新的上传令牌，在云电脑里重新粘贴命令。
6. 最后把旧的 `xiaoju-music` Worker 里不再用的视频数据清掉（它的代码里已经没有视频的部分，那几张表留着无害）。

重设 webhook：

```bash
curl "https://api.telegram.org/bot<小橘视频机器人 token>/setWebhook" \
  -d url=https://xiaoju-video.langhua98.workers.dev/tg-webhook \
  -d secret_token=<与 Worker 的 TG_WEBHOOK_SECRET 相同> \
  --data-urlencode 'allowed_updates=["channel_post","edited_channel_post","message","callback_query"]'
```

## 机器人和抖音

视频都发到私有频道「小橘视频」（Worker 变量 `VIDEO_CHANNEL_ID`，小橘视频的机器人是那里的管理员）；Worker 每次把它作为 `target` 传给流式服务。
下面所有功能都是频道主私聊**小橘视频的机器人**用的。
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
- 查重：先把视频频道翻一遍（最近 20000 条），从帖子说明的原视频链接里认出转过的作品号，已有的跳过。翻过的记在内存里，6 小时内再转只翻上次之后的新帖子（`douyin_posted_cache`），过了 6 小时或 Space 重启就整个重翻。
- 转得快一点：同时有 3 条作品在下载、过 ffmpeg、传到 Telegram（`douyin_prepare_video`，`job.py` 的 `AHEAD`），发帖只是最后一步、仍按顺序一条条发（`douyin_post_video`，每条间隔 3 秒防限流），频道里的先后不乱；停下时备好没发的删掉临时文件。视频本来就是 faststart 的不再过 ffmpeg；超过 10 MB 的视频分 512 KB 一块、同时传 8 块，整个服务同时最多传 12 块（`upload_parallel`）。
- 重启后接着转：流式服务（Space）一重启——推新代码、Hugging Face 维护、崩溃——内存里正在转的任务就没了。所以 Worker 每交一个抖音任务（转抖音视频、自动同步、云电脑送来的、审核通过的、发来的导出文件、单条链接）都记一笔：任务编号 `run_id` + 原样的请求，导入任务连作品数据一起（config `dyResume` + 表 `dy_resume`）。Space 启动时 POST Worker 的 `/streamer-up`（`X-Key` 用同一个 `STREAMER_KEY`），Worker 把没转完的照原样再交一次（频道里已有的会跳过）并告诉频道主；没交上（Space 还没完全起来）就回 `retry`，Space 过一会儿再报到。转完或出错 Space POST `/streamer-done {run_id}` 销记录；频道主点「停」Worker 自己销；每 30 分钟的定时任务也会对一下状态补漏。同一批最多自动接着转 3 次。Space 通知 Worker（报到、报结束）失败会隔一会儿重试，最近一次成功和失败的时间、原因记在 `worker_link`（`/douyin/status` 里带出），频道主发「进度」能看到；这部分只管通知，不碰审核和过滤。Space 找 Worker 的地址默认 `https://xiaoju-video.langhua98.workers.dev`，可用 Space 变量 `WORKER_URL` 改。
- 单条出错不停整批：某一条上传失败、Telegram 限流太久之类的意外错误，只记成这一条失败、接着转下一条；连续 5 条都这样才整批停下（多半是账号或网络出了问题）。抖音拦截（要验证）照旧整批停下。
  **不要**改回 Telegram 搜索：实测刚发的帖子搜不到链接里的作品号，查重落空、发了重复的（已删掉）。
- 发一个视频文件 → 机器人问一句，点「📤 转到视频频道」才 `copyMessage` 过去（原样复制，不经流式服务，一定能成）。
- **云电脑（全部作品）**：不登录只能拿到公开主页第一页，要全部就在频道主自己的云电脑上登录抓。机器人发「云电脑」→
  给一个 GitHub Codespaces 链接（仓库根目录 `.devcontainer/douyin/`：Python 镜像 + desktop-lite 网页桌面，端口 6080，
  密码 xiaoju；建好时 `cloud/codespace-setup.sh` 装 MediaCrawler 和 Chromium。免费额度内不用绑卡，超了就停、不扣费），
  再给一条 `bash xiaoju-video/cloud/codespace-auto.sh <上传令牌> <账号,…>`（令牌是 config `cloudTok`）。**开机不自己抓**：频道主在机器人里点「▶️ 运行爬虫」（`运行爬虫`、`/crawl`，或进度面板上的按钮）才抓，Worker 记 config `dyCrawlReq`，云电脑每 20 秒问 `/dy-cloud-config` 拿到 `crawl: true` 就跑 `crawl.sh`，开抓报 `starting` 进度时清掉；机器人按 `dyCloudSeen`（云电脑上次来问的时间，90 秒内算开着）告诉频道主是马上开始还是等打开再抓；「停止云电脑抓取」连还没开始的这次也取消。频道主在 iPad Safari 里开
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
- **只抓新的**：crawl.sh 开抓前 POST `/dy-known`（Worker 转给流式服务 `GET /douyin/posted`，翻一遍视频频道）拿已有的作品号
  写进 `~/.xiaoju/known.txt`；补丁让 MediaCrawler 翻作品列表时扔掉转过的（不读详情、不送），一整页（置顶、私密、仅好友
  的不算）全是转过的就停这个号。频道里删掉的帖子不在里面，下次会重抓重转。`XJ_FULL=1` 全部重抓（给旧帖补标签用）。
- **进度**：crawl.sh 每 30 秒用 `cloud/progress.py` 算一次（每个号一共多少作品——补丁让 MediaCrawler 拿到账号资料时把昵称、
  作品数写进 `~/.xiaoju/creators.jsonl`；抓了多少——结果文件里 `xiaoju_sec_uid` 是它的行；送了多少），POST `/dy-progress`
  存进 config `dyCloud`。机器人发「进度」看云电脑和流式服务（`/douyin/status`）两边；按钮「⏹ 停止云电脑抓取」设 `dyStop`，
  云电脑下次报进度收到 `{stop: true}` 就关掉 MediaCrawler（剩下的不送）；「⏹ 停止小橘转发」调 `/douyin/stop` 取消正在跑的任务。
- **内容过滤规则（管理员配置）**：规则只由管理员在**小橘视频**管理页（`/video-admin`，也可以用 `/admin`，用 Worker 的管理密钥 `ADMIN_KEY` 登录）加、改、删、开关，存在 Durable Object 的 `filter_rules` 表；机器人只照着已启用的规则执行，代码里不自己加规则、不扩大条件，没命中任何规则的照常走。每条规则：名字、关键词（包含任意一个就算命中，不分大小写）、查哪里（搜索词 `keyword` / 作品文案 `caption` / 都查 `both`）、命中后（`filter`：搜索词不搜、作品不进审核清单、不转；`flag`：照常进清单，在审核机器人的清单里标「⚠️ 待人工确认」，由管理员决定）。作品没有文案、文案规则查不了的也只标待人工确认。四个地方按规则查：发「搜抖音」时、排队的词交给云电脑前、整理审核清单时、审核通过转之前（转之前只看「过滤」，「只标记」的已由管理员审过）；规则每次现读，改了马上生效。每次过滤、标记都记进 `filter_log`（规则、命中的词、哪一步、哪条作品或搜索词，留最近 2000 条），小橘视频管理页的「过滤记录」看最近 100 条。唯一的固定规则是未成年人保护（`BUILTIN_RULES`，管理员要求保留）：小橘视频管理页里照样列出、命中照样记录，但不能关、不能删、不能改。明确指向未成年人的词（初中、小学、未成年……）直接过滤。「校服」的两条是第一次启动放进去的默认规则（`SEEDED_RULES`），和管理员自己加的规则一样可以改、关、删：搜索那条默认关着（搜得了），文案里有它标待人工确认的那条默认开着；删了不会再放回来。管理接口：`GET/POST /admin/api/filters`、`POST /admin/api/filters-delete {id}`、`GET /admin/api/filter-log?limit=`。审核清单的通知按作品号去重后计数：去重后一共多少、进清单多少（其中待人工确认多少）、数据过期多少、按哪条规则去掉多少；云电脑进度里的「抓到 / 搜到」也按作品号去重。
- **审核机器人（@xiaojuverify_bot，`verify.js`）**：搜到的作品转进视频频道前，必须由频道主本人在审核机器人里审核。两个机器人各用各的令牌、各收各的 webhook（审核机器人是 `POST /verify-webhook`，独立 secret `verifySecret`），数据交接走共享后端——同一个 Durable Object 里的审核任务表：`rv:<任务号>`（状态 pending / approved / rejected / expired / paused、完整清单：作品 ID、链接、来源账号和 sec_uid、文案、文件地址）、`rvRows:<任务号>:<段>`（审核时那份完整作品数据，每段 100 条，转发就用它）、`rvIds`（最近 30 个任务）。
  - 搜完：小橘 `submitForReview` 写任务 → `deliverTask` 用审核机器人的令牌把清单分几条私聊发给频道主，最后一条带「✅ 通过，都是我的号 / ❌ 不通过」。
  - 频道主点了：审核机器人把结果写回任务表，再叫小橘 `onReviewDecision`；小橘重新从任务表读状态，只有 approved 才交给 `/douyin/import`，只转这一批、不登记这些号（登记了云电脑每次开机都会抓它们的全部作品；要长期同步的号用「添加抖音账号」单独加）。登记过的号在清单里标 👤，只作参考，不跳过审核。
  - 不默认通过：没接审核机器人、频道主还没在审核机器人里点「开始」、Telegram 出错 → paused（小橘发「🔁 重新送审」按钮；频道主在审核机器人里点「开始」也会自动补发）；24 小时没审 → expired（cron 每 30 分钟查一次）；不通过 → rejected；通过了但流式服务没接上 → 状态仍是 approved，小橘给「🔁 再试转发」。旧清单上的「📤 转 N」「一键转」「全部转」按钮一律不能用。
  - 接上：频道主在小橘里发「审核机器人 <BotFather 给的令牌>」，Worker 用 `getMe` 认令牌、给审核机器人 `setWebhook`，令牌存进 Durable Object（config `verifyTok`，不进代码库；也可以用 secret `VERIFY_BOT_TOKEN`），发令牌的那条消息删掉。「审核」看接好没有、哪些在等。
- **换最高画质**：流式服务 `POST /douyin/delete {target, ids}` 删掉旧的抖音视频帖（只删说明里带抖音视频链接的视频，
  正在转作品时不删），之后查重认不出，下次就按最高画质重转。
  不用粘贴也行：`codespace-auto.sh` 拿 Codespaces 自带的 `GITHUB_TOKEN` POST `/dy-cloud-config`，Worker 找
  api.github.com 认出是仓库主人（`CLOUD_GH_USER`）才回上传令牌和账号。令牌存在云电脑的 `~/.xiaoju/env`，devcontainer 的 `postAttachCommand`（`cloud/codespace-auto.sh`）
  每次打开都连上小橘：用 `setsid nohup` 起一个不挂在终端上的守候进程（`codespace-auto.sh --watch`，`flock` 防重复，记录写 `~/.xiaoju/watch.log`，终端里只是 `tail -f` 它），关掉终端、网页断开都照常等；每 10 分钟 `git pull` 一次，脚本变了自己换新的（正在抓、正在搜时等它做完再换）。抓和搜都在后台跑，守候进程不管在干什么都每 20 秒来问一次 `/dy-cloud-config`，用 `X-Busy`（`idle` / `crawl` / `search` / `wait:秒`）说在干什么，机器人据此如实说云电脑在不在、在干什么。两个不能同时跑（共用同一个登录抖音的浏览器），搜索优先：正在抓的时候有词要搜，守候进程建 `~/.xiaoju/yield` 并停掉 MediaCrawler，`crawl.sh` 把已经抓到的送给小橘（不带「完了」）、报 `paused`、以退出码 3 退出，搜完守候进程再自动接着抓（只抓频道里还没有的，重复送的小橘认得出来）。没成的同一个词、同一次抓取 10 分钟内不再试，期间照常在线；发新的词、重新点「运行爬虫」马上做。点「运行爬虫」才跑 `crawl.sh`；机器人的「搜抖音」「进度」按 `dyCloudSeen` 说云电脑连没连着。搜完出队时除了结果里的 `source_keyword`，还按云电脑报进度时的关键词出队（两边写法对不上时不会一直重搜）；MediaCrawler 自己存登录状态，没过期就不用再扫码。
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

## 限制

- 机器人只能私聊和它说过话的人（Telegram 的规定）：频道主要先在小橘视频的机器人里点一次「开始」，审核机器人也一样。
- 刷视频网页依赖流式服务在线：超过 20 MB 的视频，Space 休眠时第一次播放要等它醒（约 1～2 分钟）。
- 没登录时抖音只给看一部分，见上面的实测说明；要全部作品靠云电脑。
- `workers.dev` 在中国大陆被屏蔽，不开 VPN 打不开；要给国内用户用，需要绑定自定义域名。
