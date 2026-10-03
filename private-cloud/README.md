# Telegram Private Cloud Drive（私有云盘）

网页私有云盘 + Telegram 私有频道存储 + 数据库索引 + 自动查重 + 后台上传队列。

网页上传文件 → 服务器暂存 → 后台 Worker 存进 Telegram 私有频道。网站数据库只记「文件是什么、在哪个频道哪条消息、
属于谁、在哪个文件夹」，文件本体全在 Telegram 里。

```
浏览器 ──分片上传──▶ API (FastAPI) ──写任务──▶ 数据库 (PostgreSQL / SQLite)
                         │                        ▲
                         │ 下载/播放（Range）      │ 领任务、写回消息号
                         ▼                        │
                  Telegram 私有频道 ◀──上传──── 上传 Worker
```

## 功能

| 规划里的项 | 实现 |
|---|---|
| 网页上传、多文件、拖拽 | 上传按钮 / 拖进文件列表区域，可一次选多个 |
| 大文件上传、断点续传 | 浏览器按 8 MB 分片、3 片并发上传，每片失败自动重试；刷新页面后重新选同一个文件会从断点继续。单文件上限 2 GB（机器人走 MTProto 的上限） |
| 上传进度 | 两段进度：传到服务器 → 存入 Telegram，右下角面板 + 列表里的进度条 |
| SHA-256 指纹、查重 | 浏览器边读边算（hash-wasm，不把整个文件读进内存）；服务器按 SHA-256 + 文件大小查重，命中就不传，可选「秒传」在当前文件夹放一份。Worker 上传前在服务器上再校验一次 SHA-256 |
| 后台上传、失败重试 | 独立 Worker 进程；失败后 10 秒、60 秒自动重试，第 3 次失败标记 failed 并记录错误，可点「重新上传」。Worker 崩溃时正在传的任务会被放回队列 |
| 上传任务管理 | 「上传任务」页：状态、进度、重试次数、错误、取消、重新上传 |
| 文件夹 | 无限级目录；新建、重命名、移动（防止移进自己的子目录）、删除 |
| 文件操作 | 打开、预览、下载、重命名、移动、复制（不重新上传，共用同一条 Telegram 消息）、删除、详细信息；多选批量移动 / 复制 / 删除 |
| 搜索、排序 | 按文件名 / 文件夹名 / SHA-256 前缀搜索，按类型筛选；按名称 / 大小 / 修改时间 / 类型排序 |
| 预览 | 视频、音频在线播放（支持拖进度条）；图片预览（左右键翻页、点击放大）；PDF 内嵌阅读；文本文件预览；其他类型显示详细信息 |
| 回收站 | 删除先进回收站，可恢复；永久删除时同步删除 Telegram 消息（还有副本在用就不删） |
| 账号、权限 | 用户名 + 密码登录（scrypt 哈希，JWT 放 HttpOnly Cookie），每个接口都在后端检查登录和归属；登录失败限流；多用户各看各的 |
| 管理后台 | 「设置与管理」：概览统计、用户管理、全部任务、系统日志、备份与恢复 |
| 数据库备份 | 一键导出 JSON（gzip），可同时存一份到 Telegram 频道；`python -m backend.cli restore` 恢复到空库 |
| 存储与数据库解耦 | 每条 Telegram 消息的说明文字里带文件元数据（名字、大小、SHA-256、文件夹路径）。数据库整个丢了，后台「从 Telegram 重建索引」能把文件列表扫回来 |
| 多个私有频道（第四阶段） | `TELEGRAM_CHAT_ROUTES` 按类型分到不同频道，数据库统一管理 |

## 部署（docker compose）

1. **建私有频道和机器人**
   - Telegram 里新建一个私有频道。
   - 找 [@BotFather](https://t.me/BotFather) 创建机器人，拿到 Bot Token。
   - 把机器人加进频道，设为管理员（要有发消息、删除消息权限）。
   - 频道 ID：在频道里随便转发一条消息给 [@userinfobot](https://t.me/userinfobot) 之类的机器人，得到 `-100` 开头的 ID。
   - 在 <https://my.telegram.org> → API development tools 申请 `api_id` 和 `api_hash`。机器人要用它们走 MTProto，
     这样上传、下载才能到 2 GB（HTTP Bot API 只能传 50 MB、取 20 MB）。
2. **配置**：`cp .env.example .env`，填好 `TELEGRAM_*`、`JWT_SECRET`、`ADMIN_PASSWORD`、`POSTGRES_PASSWORD`。
3. **启动**：`docker compose up -d --build`，打开 `http://服务器:8000`，用 `ADMIN_USERNAME` / `ADMIN_PASSWORD` 登录。

正式使用请在前面放 HTTPS 反向代理（Caddy / Nginx），并设 `COOKIE_SECURE=true`。Nginx 要把
`client_max_body_size` 设得比分片大（比如 `16m`），`proxy_buffering off` 让下载 / 播放边取边传。

**密钥只放 `.env` / 服务器环境变量**：Bot Token、`api_hash`、`JWT_SECRET`、数据库密码都不会出现在前端代码里，
`.env` 已在 `.gitignore` 中，不要提交到 GitHub。

API 和 Worker 必须挂同一个数据卷（`/data`）：浏览器传上来的分片先存在这里，Worker 从这里读了再传 Telegram，传完即删。

## 本地开发

```bash
# 后端（STORAGE_BACKEND=local：不连 Telegram，文件存在 data/local_store，接口和真 Telegram 一样）
pip install -r backend/requirements.txt
export STORAGE_BACKEND=local TELEGRAM_CHAT_ID=-1001 ADMIN_USERNAME=admin ADMIN_PASSWORD=admin-password
uvicorn backend.main:app --reload --port 8000        # 终端 1
python -m backend.workers.upload_worker               # 终端 2

# 前端
cd frontend && npm install && npm run dev             # http://localhost:3000，/api 自动转发到 8000

# 测试
pytest backend/tests                                   # SQLite
TEST_DATABASE_URL=postgresql://user@host/db pytest backend/tests   # PostgreSQL（会清空这个库）
cd frontend && npm run lint && npm run build
```

`npm run build` 把前端静态导出到 `frontend/out/`，后端检测到这个目录就一起提供页面（生产环境只开一个端口）。

## 命令行

```bash
python -m backend.cli create-user <用户名> [--admin]
python -m backend.cli reset-password <用户名>
python -m backend.cli backup
python -m backend.cli restore data/backups/backup-xxxx.json.gz   # 只能导入空数据库
```

## API

所有接口（除登录）都要登录；文件、文件夹只能操作自己的。交互式文档：`/api/docs`。

```
POST /api/auth/login | /api/auth/logout | /api/auth/password      GET /api/auth/me

GET  /api/files?folder_id=&sort=name|size|updated|type&order=asc|desc
GET  /api/files/:id                    POST /api/files/:id/rename | move | copy | restore
DELETE /api/files/:id（进回收站）
GET  /api/files/:id/download           GET /api/files/:id/stream（支持 Range）

GET  /api/folders                      POST /api/folders
POST /api/folders/:id/rename | move | restore                      DELETE /api/folders/:id

POST /api/upload/create（= POST /api/files/upload）  {filename, file_size, mime_type, sha256, folder_id, link_if_duplicate}
PUT  /api/upload/:id/chunks/:index（请求体 = 这一片的原始字节）
POST /api/upload/:id/complete | cancel | retry       GET /api/upload/:id/status    GET /api/upload/tasks

GET  /api/search?q=&type=video|image|audio|document|archive|other
GET  /api/trash    DELETE /api/trash（清空）   DELETE /api/trash/files/:id | /api/trash/folders/:id
POST /api/batch    {action: delete|move|copy|restore|purge, file_ids, folder_ids, target_folder_id}

GET  /api/admin/stats | users | tasks | logs | backups | rebuild
POST /api/admin/users | backups?to_telegram=true | rebuild          PATCH /api/admin/users/:id
```

## 目录

```
backend/
  main.py                 API 入口（同时提供 frontend/out 静态页面）
  config.py  security.py  cli.py
  api/                    auth files folders upload search admin
  models/                 user folder file upload_task system_log
  services/
    telegram_service.py   Telegram 存储层（Telethon MTProto；STORAGE_BACKEND=local 时换成本地模拟）
    upload_service.py     上传任务、分片、查重
    file_service.py       文件 / 文件夹 / 回收站
    storage_service.py    读文件内容（Telegram 或还没传完的临时文件）、Range
    backup_service.py     备份、恢复、从 Telegram 重建索引
    hash_service.py  log_service.py
  workers/upload_worker.py
  tests/
frontend/                 Next.js（App Router，静态导出）+ Tailwind
  app/  files trash tasks settings login
  components/  FileList FileItem UploadBox UploadProgress VideoPlayer ImageViewer FolderTree SearchBox …
  lib/upload.ts           上传管理（SHA-256、查重、分片、断点续传、进度）
```

## 已知限制

- 单文件最大 2 GB（Telegram 机器人上限）。更大的文件需要拆成多条消息存，目前没做。
- 往 Telegram 传是单连接顺序上传，速度一般在每秒几 MB，取决于服务器网络。
- 「从 Telegram 重建索引」需要知道频道最新消息号：机器人会发一条「·」再立刻删掉。
- 只有本系统传进频道的文件（说明文字里带 `#pcd` 元数据）才能被重建；手动发进频道的文件不会被收录。
- 浏览器能不能播放视频取决于编码：MP4(H.264)、WebM 一般没问题，MKV / HEVC 等请下载后播放。
