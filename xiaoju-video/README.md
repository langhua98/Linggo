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
| 审核机器人 | @xiaojuverify_bot（`VERIFY_BOT_TOKEN`） | 一批作品一张「🛂 审核单」，只有「✅ 审核通过 / ❌ 审核失败」两个按钮，整批定 |
| 流式服务 | `streamer/`（HF Space `langhua1998/douyin-proxy`，原小橘音乐的流式服务改建，`https://langhua1998-douyin-proxy.hf.space`） | 认分享链接、下载、ffmpeg、用频道主账号发帖；超过 20 MB 的视频按 Range 走 MTProto 现取现传。详见 `streamer/README.md` |
| 云电脑 | 流式服务里的 MediaCrawler（`streamer/jobs.py`、`dy_login.py`）；备用：`cloud/` + `.devcontainer/xiaoju-video/`（Codespaces） | 「登录抖音」把二维码发给频道主扫；「同步作品」抓登录账号自己主页的全部作品；发链接抓那几条。新的送 Worker 交审核 |

### 一条作品怎么走

```
review（待审核）──通过──▶ queued（排队）──交给流式服务──▶ sending（在转）──成功──▶ posted（已转）
      └──不转──▶ rejected                ▲                        │失败（<3 次）
                                         └────────────────────────┘
                                         失败满 3 次 ──▶ failed（「重试失败」重新排队）
```

- **视频池只读视频直链，不读频道帖的说明和标签**（频道主的要求）：登记视频帖只存播放要用的（`file_id`、大小、时长、尺寸、封面），
  作品记「已转」只靠流式服务的回报。以前存过的说明和作品号，Library 启动时清掉。
- **网页的历史、喜欢、心碎**：浏览历史和喜欢存在看的人自己的浏览器里（localStorage `xj_history`、`xj_likes`）。
  点 💔 → `POST /api/heartbreak {id}`：视频从视频池挪进 `trash` 表（频道里的帖子不动），小橘视频机器人告诉频道主
  （消息号、原帖链接、「↩️ 恢复」按钮）；挪进 trash 的，编辑帖子、翻历史都不会再回到视频池。网页是公开的，所以一小时最多删 60 条。
  机器人里发「心碎」看最近删掉的。
- **补全视频池**：机器人只收得到它进频道以后的新帖。以前的视频由流式服务用频道主账号翻历史（`POST /channel/videos`），
  只回视频帖的播放字段（消息号、大小、时长、尺寸、日期），不回说明、标签；Worker 存成没有 `file_id` 的记录，播放一律走流式服务。
  定时任务每次翻 2×500 条，翻完告诉频道主（config `channelScan`）；`POST /admin/api/scan-channel {reset:true}` 从头再翻。
  **不会主动去频道里搜索、读取帖子的标签**（频道主要求）；流式服务只按消息号取网页要播的那个视频文件。
- **流式服务找不到 Worker，一律由 Worker 去问它**：Hugging Face 的机房按域名挡掉了 `*.workers.dev` 和 `api.telegram.org`
  （TLS 握手超时；MTProto、抖音都通）。流式服务要报的事（每条转完的结果、给频道主的话和截图、抓到的作品、抖音登录状态）
  放进它的发件箱，Worker 交给它活以后用 Durable Object 的定时器长轮询 `GET /outbox`（每次等 20 秒、一轮最多 12 分钟，
  忙就接着来），按序号逐条处理；定时任务（每 5 分钟）看到有交出去没回音的、或者 2 小时内让它干过活，也去问一次。
- 发件箱带启动号：变了就是流式服务重启过，Worker 把所有「在转」的放回队列重交，序号从头算；交出去 30 分钟没回音的也重交。
- 云电脑送来的视频地址过几个小时会过期，过期了流式服务按作品号去分享页重新取。

## 路由

| 路径 | 谁调 | 作用 |
|---|---|---|
| `GET /`、`/video` | 观众 | 刷视频网页（`video.html`），`#<消息号>` 从那条开始 |
| `GET /api/videos` | 网页 | 视频池 JSON（新的在前） |
| `GET /vf/<消息号>` | 网页 | 视频流，支持 Range；≤20 MB 走 Bot API，更大的转流式服务；它休眠时回 503 + `Retry-After`，网页 10 秒后重试 |
| `GET /vp/<消息号>` | 网页 | 封面，取一次就存进数据库 |
| `POST /tg-webhook` | 小橘视频机器人 | 频道新帖登记、私聊 |
| `POST /verify-webhook` | 审核机器人 | 审核单的两个按钮、私聊 |
| `POST /api/heartbreak` | 网页 | 💔 心碎：从视频池删掉、告诉频道主（可以恢复） |
| `GET /review/<编号>` | 频道主 | 审核单整批列表（编号就是凭证，页面 noindex） |
| `POST /dy-known` `/dy-import` `/dy-progress` | 云电脑（`X-Token`） | 哪些已收过、送作品（一次 ≤200 条）、报进度 |
| `POST /streamer-up` `/streamer-done` `/streamer-say` | 流式服务（`X-Key`） | 推送用的老接口：HF 机房连不上 `*.workers.dev`，实际由 Worker 轮询发件箱 |
| `GET /admin`；`/admin/api/state`、`review`、`retry-failed`、`dispatch`、`video-delete` | 管理页（`Authorization: Bearer <ADMIN_KEY>`） | 看状态、审核、移出视频池 |

两个机器人的 webhook 用同一个 `TG_WEBHOOK_SECRET`。

## 数据（Durable Object `Library` 的 SQLite）

- `videos`：视频池，`rec` 是播放要用的（Bot API `file_id`、大小、时长、尺寸、日期；不含帖子说明、标签）；`thumbs`：封面 base64
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
推到 Space `langhua1998/douyin-proxy`，它会自动重新构建。重新构建会打断正在转的作品；它起来后启动号变了，Worker 轮询时发现，会重交。

## 云电脑（MediaCrawler）

爬虫是 [MediaCrawler](https://github.com/NanmiCoder/MediaCrawler)（NON-COMMERCIAL LEARNING LICENSE 1.1，只能非商业使用），
固定在验证过的版本 `bf28178`（`streamer/mc.py` 的 `MC_REV`、`streamer/Dockerfile`、`cloud/run.sh` 三处要一致）。
`streamer/mc_patch.py` 改它的配置：不连本机 Chrome（CDP）、有界面、不抓评论、保存登录状态。
**清晰度**：视频地址挑最高清的一档——它原来先拿 `play_addr_h264`（默认播放档），改成先从 `bit_rate`（各档列表）里挑
分辨率最高的，一样高先要 H.264、再比码率（4K 只有 H.265 也要）。转发时不重新编码，H.265 的在 mp4 里标成 `hvc1`，苹果设备才播得了。

**主用：装在流式服务（HF Space `douyin-proxy`）里**，频道主全程只在 Telegram 里操作：

1. 小橘视频机器人里发「登录抖音」→ 流式服务用 `xvfb-run` 在虚拟屏幕上开 MediaCrawler 的浏览器档案（`browser_data/dy_user_data_dir`），
   `dy_login.py` 打开抖音登录页、截二维码，机器人发给频道主，用抖音 App 扫；二维码过期自动换新的再发（最多 5 次、6 分钟）。
   抖音弹滑块就用 MediaCrawler 自带的滑块处理。扫码后要二次验证时，把整页截图和弹窗里能点的选项发过去（机器人键盘临时换成这些按钮），
   频道主点「刷脸验证」就把刷脸用的二维码单独截下来发过去，用抖音 App 扫、在手机上刷脸；选短信就把验证码数字发给机器人。
   登录进行中（发起后 15 分钟内）频道主发的别的话，Worker 都先交给登录页（`/douyin/login/input`）；「截图」「取消登录」随时可用。
2. 登录好了：打开自己的主页，从作品列表接口认出 `sec_uid` 和昵称，连同 cookie 存进 Worker（`/dy-session`，只收 `X-Key`）。
   Space 重启后浏览器档案没了，抓作品时 Worker 把存着的 cookie 带过去，MediaCrawler 用 cookie 登录。
3. 「同步作品」→ MediaCrawler creator 模式**只抓登录账号自己的主页**（地址由 `sec_uid` 拼，不接受外面给的），
   发分享链接 → detail 模式抓那几条。读 jsonl，问 Worker 哪些收过，新的送 `/dy-import`，每一批成一张审核单。
4. 一次只干一件（登录 / 同步 / 抓链接），忙的时候机器人会说正在干什么。

**边抓边交**：MediaCrawler 抓到一条就往 jsonl 追加一行；流式服务每 15 秒把新出现的作品作为一段 `import` 事件放进发件箱
（同一次抓取同一个 `job` 号，最后一段带 `final: true`）。Worker 收到一段处理一段：小号的立刻排队转发，要审的并进同一张审核单、
原地改条数（单子中途审过了，后面的另开一张）；条数攒在 config `crawlJob`，最后一段到了才给频道主发「抓完了」汇总。
中途出错、超时，已经交出去的照常转/审。
每次抓取给频道主一张**进度卡**（config `crawlCards`，最多记 5 张）：第一段到了就发，之后原地改——抓到几条、新的几条、
小号的已转/排队/失败几条、审核单的状态；转完一条（发件箱的 `done`）、审核单被审、定时任务都会刷新。
抓完、该转的都转完、审核单也审了，再发一条「🎉 全部转完了：成功 N 条，失败 M 条」。

**小号**：机器人里发小号的主页链接（抖音「分享主页」的短链接，或 `www.douyin.com/user/…`）→ Worker 认出是个人主页
（短链接问流式服务 `/douyin/expand`），记进 config `altAccounts`，交云电脑 `accounts` 模式抓它的全部作品。
抓回来作者是小号的作品**不用审核**：自动成一个已通过的批次（`#小号同步`）直接排队转发；别的（登录账号自己的、认不出作者的）照常成审核单。
「小号」看列表（每个号收了几条、已转/排队/失败几条、上次抓是什么时候；「进度」里也有小号的合计），「同步小号」现在抓一遍，「删除小号 N」删掉（已转的不动）。

**自动同步**：定时任务（每 5 分钟）到了设定的点（北京时间，默认 4 点，config `autoSync`），当天还没发起过，就让云电脑把
所有小号 + 登录账号抓一遍；云电脑在睡或在忙，这个小时里接着试。顺带每天叫醒一次 Space，免得它 48 小时没人访问就休眠。
「自动同步 8」改时间，「自动同步 关 / 开」。

**关键词搜索**：机器人里发「搜索 关键词 数量」（多个用逗号隔开，最多 5 个；结尾的数字是每个关键词搜几条，不写 50，最多 500）→ MediaCrawler search 模式。
作者信息是 `mc_patch.py` 让 MediaCrawler 多存的（它默认把昵称打码、作者只存散列）。

**审核单**：每次送来的一批（私聊链接、主页同步、关键词搜索）存成一个批次（表 `batches`，作品的 `batch` 列），
审核机器人发一张：`🛂 审核单 <14 位编号>（#来源 #关键词… #批次数量N 条）`，下面是作者统计（通过过的号标 ✓）、前 5 条说明和
「查看全部」链接（`GET /review/<编号>`，整批列表，每条带作者主页和抖音链接）。只有两个按钮：
「✅ 审核通过」整批排队转发，并把这批的作者记进「你的号」（config `myAccounts`）；「❌ 审核失败」整批不转。
私聊审核机器人会把没审的审核单再发一遍；有审核单之前收的待审作品，定时任务按来源凑成一张发过来。

**备用：自己的 GitHub Codespaces**（会话里的 GitHub 权限建不了 Codespace，要频道主自己建）：
一键链接 https://codespaces.new/langhua98/Linggo?devcontainer_path=.devcontainer/xiaoju-video/devcontainer.json ，
`run.sh login` 在端口 6080 的网页桌面里扫码，机器人发「云电脑」拿令牌后 `run.sh setup <Worker> <令牌> <主页链接>`、`run.sh sync`。

抓到的视频地址几个小时后过期：审核拖太久，流式服务下载会失败，满 3 次记成失败；再同步一次，失败的会带着新地址重新待审核。
