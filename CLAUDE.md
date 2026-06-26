# Linggo 代码库说明

## 项目概述

**Linggo** 是一个英文阅读助手 PWA（渐进式 Web 应用），部署于 GitHub Pages：
`https://langhua98.github.io/Linggo/`

核心功能：
- 内置英文书库（57 本，分初级 / 中级 / 高级）+ 离线书目搜索（130+ 本）
- 图书阅读器：TTS 朗读、句子高亮、翻页
- 单词查询弹窗：音标、词义、发音、例句
- 生词本：保存生词 + 导出 CSV
- 闪卡复习（SRS 间隔重复）：从生词本抽取、评分（认识 / 较难 / 不认识 / 很简单）
- 我的书架：用户从 Gutenberg 搜索添加书籍，数据持久化到 Supabase 或 localStorage
- Supabase 用户认证（邮箱 + 密码）

管理后台（独立文件）：
- `admin.html`：查看运营数据（用户数、词汇数、访问量统计图）

---

## 文件结构

```
Linggo/
├── index.html      # 主应用 HTML（landing、library、reader、player 等所有视图）
├── style.css       # 外部样式表（2000+ 行，覆盖所有组件）
├── script.js       # 主应用逻辑（2500+ 行，所有 JS 功能）
├── sw.js           # Service Worker（缓存版本 linggo-v6）
├── manifest.json   # PWA 清单
├── admin.html      # 管理员后台（自包含，内嵌 CSS+JS）
├── icon.png        # 应用图标
├── icon-192.png    # PWA 图标 192×192
├── icon-512.png    # PWA 图标 512×512
└── apple-touch-icon.png
```

**无构建工具、无包管理器、无框架。** 所有依赖通过 CDN 加载，修改文件后刷新浏览器即可。

---

## 技术栈

| 层级 | 技术 |
|------|------|
| 标记 | HTML5 |
| 样式 | CSS3（外部 `style.css`） |
| 脚本 | 原生 JavaScript ES6+（外部 `script.js`） |
| 后端 | Supabase（PostgreSQL + RLS + RPC） |
| 本地存储 | IndexedDB（书籍文本缓存）+ localStorage（设置、生词、进度） |
| PWA | Service Worker（cache-first，版本 `linggo-v6`） |
| 字体 | Google Fonts CDN（Lora 衬线、Nunito 无衬线） |
| 封面来源 | Open Library API（ISBN）→ Gutenberg CDN → 渐变色兜底 |

---

## index.html 视图结构

文件约 445 行，无内嵌 CSS/JS，纯 HTML 结构。主要视图节点：

| 元素 ID | 用途 |
|---------|------|
| `#topbar` | 顶部固定栏：Logo、进度徽章、侧边栏按钮、登录/用户菜单 |
| `#landing` | 首页：Logo、渐变标题、CTA 按钮、文件拖放区、功能介绍 |
| `#library` | 书库面板：搜索栏、分类标签、书架行、我的书架 |
| `#reader` | 阅读区域：`#content` 段落注入于此 |
| `#player` | TTS 播放器：句子预览、进度条、速度/上一/播放/下一按钮 |
| `#sidebar` | 设置侧边栏：字体大小、行距、对齐、夜间模式、音源、阅读模式 |
| `#wpop` | 单词查询弹窗：音标、词性、词义、例句、加入生词 |
| `#voc` | 生词本面板：词列表 + 导出 CSV + 进入闪卡 |
| `#flashcard` | 闪卡界面：正面（单词+音标）→ 翻转 → 背面（词义）→ 评分 |
| `#fc-result` | 闪卡完成统计页 |
| `#chap-panel` | 章节目录面板 |
| `#search-bar` | 阅读内搜索栏 |
| `#gb-panel` | Gutenberg 书目搜索面板（书库内） |

---

## script.js 模块结构

文件约 2564 行，按注释 `// ═══` 分隔为以下模块：

### IndexedDB（第 1–38 行）
```js
openIDB() / idbSave(url, text) / idbGet(url) / idbHas(url)
```
缓存书籍全文到浏览器 IndexedDB，避免重复下载。

### 书库数据（第 40–355 行）
```js
const BOOKS = [...]      // 57 本书，3 个难度数组：[beginner[], intermediate[], advanced[]]
const CATALOG = [...]    // 130+ 本 Gutenberg 书目，格式：[id, title, author, year, [cats], markText]
```
每本书结构：
```js
{ t, a, y, cat[], url, mark, isbn, pal[], _gbId? }
```

### 书库 UI（第 356–555 行）
```js
coverUrl(isbn)           // Open Library 封面
gbCoverUrl(id)           // Gutenberg CDN 封面
buildCard(book)          // 构建单本书卡片（140×200px）
loadBook(book)           // 下载书籍（CORS 代理 → IndexedDB 缓存）
renderLib()              // 渲染所有书架行
localSearch(q)           // 离线书目搜索（Unicode 归一化 + 评分排序）
renderSearchResults()    // 渲染搜索结果卡片
```
分类标签：`all / classic / mystery / adventure / scifi / horror / short`

### 阅读器状态（第 559–571 行）
```js
const S = { /* 所有播放器状态字段 */ }
```

### 进度持久化（第 586–617 行）
```js
saveProg() / loadProg() / restoreProg()  // localStorage：阅读位置、字体、夜间模式
```

### 语音引擎（第 621–682 行）
```js
qualityScore(v) / populateVoices() / getVoice()
```
过滤低质量系统声音（`BLOCK` 正则），优选高质量语音（en-US/en-GB）。

### 文件拖放（第 686–706 行）
`#drop-zone` + `#file-input` → `readFile(f)` → 读取用户本地 TXT 文件。

### 文本解析（第 713–844 行）
```js
splitSents(txt)    // 句子分割（考虑缩写词：Mr./Dr./etc.）
isHeading(text)    // 检测章节标题（全大写、Chapter N 等）
buildPara(ss, i)   // 构建段落 DOM（<p class="para">）
injectWords(sp)    // 在 <span> 上注入单词点击事件
```

### 阅读器 DOM + 手势（第 850–1015 行）
- 移动端：`touchstart/touchend` 长按 → 查词
- 桌面：`mousedown/mouseup` 长按 → 查词
- `buildReader(raw)` → 调用 `splitSents` → `buildPara` → 注入段落到 `#content`

### 章节导航（第 1019–1060 行）
```js
renderChapters() / openChapPanel() / closeChapPanel()
```
正则匹配 `Chapter / CHAPTER / Part` 等标题，构建目录列表。

### 翻译（第 1076–1130 行）
```js
fetchTimed(url, ms)    // 带超时的 fetch
showTL(sp, txt)        // 显示译文（sentence-level）
TRANS_CACHE            // Map：句子文本 → 译文
```
调用 MyMemory API（免费，无需 key），失败时显示错误。

### 单词弹窗（第 1134–1281 行）
```js
positionPopup(wordEl)  // 智能定位（避免超出屏幕）
speakWord(w)           // TTS 发音
```
通过 `https://api.dictionaryapi.dev/api/v2/entries/en/{word}` 获取词典数据（音标、词性、词义、例句、MP3）。

### 生词本（第 1286–1336 行）
```js
addVocab(word, meaning) / renderVoc() / closeVoc()
dl(name, content, type)  // 导出 CSV/TXT
```
存储在 `localStorage['vocab']`（JSON 数组）。

### TTS 播放（第 1340–1455 行）
```js
jump(i) / buildChunk(startIdx) / playChunk(chunk) / playCurrent()
togglePlay() / updateProg() / highlightWordAt(sentEl, charIdx)
```
分块朗读，每块约 200 字符。iOS Safari 需 `resumeTimer` 防止 speechSynthesis 暂停。

### 阅读内搜索（第 1561–1577 行）
```js
doSearch(q) / navSrch(d) / clearSrch() / goMatch(i)
```

### 侧边栏设置（第 1582–1656 行）
```js
applyFont() / applyLineHeight() / applyTextAlign() / applyNight() / applyMode()
```
所有设置持久化到 `localStorage`。

### 闪卡系统（第 1660–1993 行）
```js
const SRS_INTERVALS = { again: 10min, hard: 1d, good: 3d, easy: 7d }
const FC_CACHE = new Map()   // word → { phonetic, audio, pos, enDef }
let fcDeck = []              // 当前复习队列
loadSRS() / saveSRS()        // localStorage 存储 SRS 进度
openFlashcard()              // 从生词本筛选待复习单词 → 开始会话
flipFcCard()                 // 翻转卡片
rateFcCard(rating)           // 评分：again/hard/good/easy
showFcResult()               // 显示会话统计
```
SRS 数据结构：`fcSRS[word] = { nextReview: timestamp, interval: ms }`

### Toast / 键盘（第 1997–2022 行）
```js
toast(msg)  // 底部短暂提示
```
键盘快捷键：空格（播放/暂停）、方向键（上一/下一句）、Escape（关闭面板）。

### Supabase 集成（第 2024–2145 行）
```js
const SB = (() => {
  const BASE = 'https://ueskojxtupmxwolzxdxa.supabase.co';
  const KEY  = '...';  // publishable anon key（可安全暴露于客户端）
  // 方法：
  SB.signUp(email, password)
  SB.signIn(email, password)
  SB.signOut()
  SB.getUser()
  SB.getSession()
  SB.selectUserBooks()           // 从 user_books 表查询
  SB.insertUserBook(book)        // 插入记录
  SB.deleteUserBook(url)         // 按 url 删除
  SB.logVisit()                  // 记录访问（page_views 表）
  SB.rpc('get_admin_stats')      // 管理后台 RPC
})()
```
所有 Supabase 调用通过 REST API（fetch），**不使用 Supabase JS SDK**。

### 我的书架（第 2151–2353 行）
```js
let userBooks = []
loadLocalUserBooks() / saveLocalUserBooks(books)  // localStorage 兜底
loadUserBooks()       // 登录：拉取 Supabase → 合并本地孤儿记录
addUserBook(book)     // 保存到 Supabase 或 localStorage
removeUserBook(book)  // 从状态 + 存储删除
renderUserBooks()     // 渲染"我的书架"区块
gbCoverUrl(id)        // Gutenberg 封面 CDN
injectGbId(b)         // 从 URL 提取 Gutenberg ID
norm(s)               // Unicode 归一化（NFD + 去组合符）
localSearch(q)        // 离线评分搜索（CATALOG + BOOKS）
```

### 用户认证 UI（第 2379–2537 行）
```js
setAuthUI(user)       // 切换登录/头像按钮
authMode              // 'login' | 'signup'
```
认证流程：邮箱 + 密码 → Supabase Auth → 登录后同步 user_books。

---

## CSS 约定（style.css）

### 设计令牌（`:root`）
```css
--bg / --surface / --border       /* 背景层次 */
--text / --text-2 / --text-3      /* 文字层次 */
--accent / --accent-2             /* 品牌色（蓝） */
--green / --hl-sent / --hl-word   /* 功能色 */
--player-bg                       /* 播放器毛玻璃背景 */
--shadow-sm/md/lg                 /* 阴影层次 */
--r-sm/md/lg                      /* 圆角层次 */
--font-read                       /* 阅读字体大小（默认 20px） */
--player-h                        /* 播放器高度（172px） */
```
夜间模式：`.night` 类覆盖所有令牌，通过 `applyNight()` 切换。

### 响应式断点
- `@media(max-width:600px)`：手机布局（书卡大小、控件间距）

### 区块注释格式
```css
/* ── 区块名称 ── */
```

### 关键组件 class
| Class | 描述 |
|-------|------|
| `.bk` | 书籍卡片（140×200px） |
| `.bk-fb-title` | 卡片标题（13px） |
| `.bk-fb-author` | 卡片作者（11px） |
| `.lib-cats-bar` | 水平分类标签栏（横向滚动，无滚动条） |
| `.lcat` / `.lcat.on` | 分类标签按钮 / 选中状态（蓝色） |
| `#lib-add-btn` | "搜索书籍" 按钮 |
| `.gb-item` | 搜索结果行 |
| `.lv-g/y/r` | 书架级别头（绿/黄/红渐变 + 左边框） |
| `.lv-mine` | 我的书架区块（琥珀色） |
| `.bk-remove` | 书籍删除按钮 |

---

## Supabase 数据库表

### `user_books`
| 列 | 类型 | 说明 |
|----|------|------|
| id | uuid | 主键 |
| user_id | uuid | 关联 auth.users |
| title | text | 书名 |
| author | text | 作者 |
| year | int | 出版年 |
| url | text | Gutenberg 文本 URL |
| mark | text | 章节起始标记 |
| isbn | text | ISBN（可空） |
| pal | text[] | 渐变色数组 |
| cat | text[] | 分类标签 |
| added_at | timestamptz | 添加时间 |

RLS：用户只能读写自己的记录。

### `page_views`（访问日志）
由 `SB.logVisit()` 写入，供管理后台图表使用。

### `vocab_progress`（计划中）
用于 CET-4/CET-6 闪卡进度同步（尚未实现）：
```sql
user_id, deck, word, status, next_review, correct_count, wrong_count, last_seen
```

---

## Service Worker（sw.js）

```js
const CACHE = 'linggo-v6';
const SHELL = ['/Linggo/', '/Linggo/index.html', '/Linggo/style.css',
               '/Linggo/script.js', '/Linggo/icon.png', ...];
```
策略：**cache-first + 后台更新**（stale-while-revalidate）。外部域名（API、CDN、字体）直接走网络。

**更改 JS/CSS 后必须更新 `CACHE` 版本号**，否则用户看到旧缓存。

---

## 封面图来源优先级

```
1. Open Library CDN（isbn 存在时）
   https://covers.openlibrary.org/b/isbn/{isbn}-M.jpg
   onerror →
2. Gutenberg Cover CDN（_gbId 存在时）
   https://www.gutenberg.org/cache/epub/{id}/pg{id}.cover.medium.jpg
   onerror →
3. CSS 渐变色兜底（pal 数组：[color1, color2]）
```

---

## 本地搜索算法（localSearch）

```js
function norm(s){
  return s.toLowerCase().normalize('NFD').replace(/[̀-ͯ]/g,'');
}
```
评分规则：
- 标题精确匹配 +10
- 标题前缀匹配 +6 / 包含 +3
- 作者匹配 +2
- 分类命中 +1

结果按分数降序，最多返回 20 条。

---

## 开发流程

### 本地开发
```bash
# 需要 HTTPS 或 localhost 才能使用 Service Worker
python -m http.server 8080
# 访问 http://localhost:8080
```

### 修改文件后
1. 编辑 `index.html` / `style.css` / `script.js`
2. 如修改了 `style.css` 或 `script.js`，在 `sw.js` 中递增 `CACHE` 版本号
3. commit + push 到正确分支

### 部署
GitHub Actions 自动将 `main` 分支部署到 GitHub Pages。

---

## 分支约定

- `main`：生产分支，推送即触发 Pages 部署
- `claude/*`：AI 辅助开发分支（如 `claude/claude-md-docs-Cdrse`）

### 每次工作完成的固定流程（务必遵守）

每完成一项工作就**立即合并推送上线，不把改动留在工作目录**：

1. 在功能分支 `claude/*` 上 `commit`（改了 JS/CSS 记得先递增 `sw.js` 的 `CACHE` 版本号）
2. `git push -u origin <功能分支>`
3. 快进合并到 `main` 并推送上线：`git push origin <commit>:main`
   （`main` 与功能分支保持一致；推 `main` 即触发线上部署）
4. 确认 `git status` 工作区干净，无遗留未提交改动

> 推 `main` 是不可逆的对外部署。除非用户当次明确表示「先别上线」，否则默认按上述流程一路推到 `main`。

---

## 图书下载代理（Cloudflare Worker）

书籍下载走 CORS 代理链（`script.js` 顶部的 `BOOK_PROXY` + `PROXIES`），按序尝试、
首个成功者胜出、`_streamProxy` 用「15s 无新数据才放弃」的停滞看门狗。

**主代理 = 自建 Cloudflare Worker**（边缘缓存，热门书二次下载近乎秒开）：

| 项 | 值 |
|----|----|
| Worker 名 | `linggo-proxy` |
| 线上域名 | `https://linggo-proxy.langhua98.workers.dev` |
| 调用格式 | `…/?url=<URL编码后的书籍地址>` |
| Cloudflare 账号 ID | `aca35ff5f62ae4208757219dbc3b489b` |
| workers.dev 子域 | `langhua98.workers.dev` |
| KV 命名空间 | `linggo-books` id=`9d85306e3292443dad716d055bb32ae6`，绑定名 `BOOKS` |
| 源码 | `cloudflare-proxy/worker.js`（只代理 Gutenberg / Standard Ebooks，非开放代理）|
| 公共备用 | `cors.eu.org` → `proxy.cors.sh` → `allorigins` → `corsproxy`（均在 `PROXIES`）|

**为什么用 KV**：Cloudflare Cache API 是**分机房**的（我测热了，别的地区用户首次仍冷）；
KV 全球复制，命中后任何地区都秒读。Worker 先查 KV，未命中才抓 Gutenberg（伪装 Chrome
UA 防限流）并写回 KV。57 本内置书已预灌进 KV。**Gutenberg 冷抓很慢（8–31s），所以新书
源务必预灌**：依次用 `…/?url=<book>` 命中一次即写入 KV。

**API token**：存于环境密钥 `CLOUDFLARE_API_TOKEN`（**绝不写进仓库**，公开库会泄露）。
建 token 用 Cloudflare「Edit Cloudflare Workers」模板。

**改完 worker.js 后重新部署**（必须带 KV 绑定，否则全球缓存失效；token 从环境变量读）：
```bash
ACC=aca35ff5f62ae4208757219dbc3b489b
KV=9d85306e3292443dad716d055bb32ae6
curl -X PUT "https://api.cloudflare.com/client/v4/accounts/$ACC/workers/scripts/linggo-proxy" \
  -H "Authorization: Bearer $CLOUDFLARE_API_TOKEN" \
  -F "metadata={\"main_module\":\"worker.js\",\"bindings\":[{\"type\":\"kv_namespace\",\"name\":\"BOOKS\",\"namespace_id\":\"$KV\"}]};type=application/json" \
  -F 'worker.js=@cloudflare-proxy/worker.js;type=application/javascript+module'
```
免费额度：Worker 10 万次/天，KV 读 10 万/天、写 1000/天、存储 1GB；改书源主机改 `ALLOW_HOSTS`。

---

## 常见陷阱

1. **Service Worker 缓存旧版本**：修改 JS/CSS 后必须更新 `sw.js` 中的 `CACHE` 常量
2. **regex Unicode 问题**：`norm()` 函数中的字符范围必须用 `̀-ͯ` 转义，直接写 Unicode 组合字符会导致 SyntaxError
3. **CATALOG 格式**：6 元素数组 `[id, title, author, year, [cats], markText]`，id 是 Gutenberg 数字 ID
4. **Gutenberg ID 提取**：从 URL `files/(\d+)/` 正则提取，存入 `_gbId` 字段
5. **iOS TTS 暂停问题**：使用 `resumeTimer` 每秒调用 `synth.resume()` 防止系统暂停
6. **CORS 代理**：书籍下载走 `BOOK_PROXY`（自建 Worker）+ `PROXIES` 备用链，按序尝试、失败自动切换（详见「图书下载代理」节）。免费公共代理会失效（corsproxy.io 已 403、thingproxy 已死），换代理时务必实测连通性
