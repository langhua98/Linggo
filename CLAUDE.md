# Linggo 代码库说明

> ## ⭐ 优先级第一（最高工作约定）：Plan Big, Execute Small
> **Fable 5 你来负责设计和编排，请将实现交给 Sonnet 5。**
>
> 本项目遵循 Anthropic 官方 cookbook 的「协调者模式」（大模型规划、小模型执行），
> 原文副本存于 `docs/CMA_plan_big_execute_small.ipynb`（来源：anthropics/claude-cookbooks，MIT 协议）。
>
> 具体分工：由 Fable 5 负责需求分析、方案设计与任务编排（诊断问题、给出精确的实现规格与验收标准），
> 具体代码实现交由 Sonnet 5 子代理执行（通过 Agent 工具，model 指定为 sonnet）；
> Fable 5 不直接写实现代码，但审查子代理产出、修补审查中发现的小缺陷属于编排职责。
> 此条优先于本文件其余所有约定。

---

## 关于这份文档

本文件对着 `git log -1`（commit `b8a3787`，工作区干净）的真实代码重写。上一版有大量
行号早已失效、模块表覆盖不到一半代码、把已经换成 FSRS 的调度写成固定间隔、把网络优先
的 Service Worker 策略写成缓存优先——这些错误已经清理。

写作原则延续：**没有 grep/读到的事实不写**；拿不准的地方明确标「未核实」。行号会随后续
提交漂移，用作定位起点，改动较大后请重新 `grep -n` 确认。

---

## 项目概述

**Linggo** 是一个英文阅读助手 PWA（渐进式 Web 应用），部署于 GitHub Pages：
`https://langhua98.github.io/Linggo/`

核心功能：
- 内置英文书库（`BOOKS` 数组，见下方「内置书目数量」一节）+ 离线书目搜索（`CATALOG`）
  + Standard Ebooks 精校书源（`SE_BOOKS`）+ Gutendex 在线实时搜索
- 图书阅读器：TTS 朗读（系统语音 / Edge 神经语音 / Kokoro 服务器神经语音三级链）、
  句子高亮、分块渲染翻页
- 单词查询弹窗：音标、词性、词义、例句、发音、词缀/音节切分
- 中英对照（双语模式）：词典法词对齐（默认）+ 可选神经词对齐（浏览器内 WASM 推理）
- 生词本：保存生词 + 导出 CSV + FSRS 间隔重复复习
- 词库闪卡：CET-4/CET-6/Ogden 850/自备词书 + 词根词族训练法（组前对照卡、总览卡、
  回忆卡、辨析题）
- 每日英语：拉取 Simple English Wikipedia 内容
- 我的书架：用户从 Gutenberg/Standard Ebooks 搜索添加书籍，数据持久化到 Supabase
  或 localStorage
- Supabase 用户认证（邮箱 + 密码）

管理后台（独立文件）：
- `admin.html`：查看运营数据（用户数、词汇数、访问量统计图），客户端密码门（见「已知
  问题 · 安全」）

### ⚠️ 仓库里两个和阅读器完全无关的东西

- **`ble.html`（约 366 KB，906 → 实测见下方文件清单）**：一个独立的单文件项目，
  `<title>` 是「OM BLE 控制台 · DUML」——DJI OM 云台的 BLE DUML 调试控制台。
  自包含 HTML+CSS+JS，**和阅读器没有任何代码共享、任何引用关系**。新代理不要因为
  它体积大就当成阅读器的一部分去读或去改；本次也**没有读取它的正文内容**。
- **`词根.json` / `词霸一.json` / `词霸一cvs.csv` / `词根.md`**：词根词族训练法用的
  大词表数据（`词霸一.json` 是「词霸天下 38000」词书之一，7424 词；`词根.json` 是配套
  词根元数据）。由 `srs.js` 运行时 `fetch()`，不走 `<script src>`（见「加载架构」）。
  `词霸一cvs.csv` 未见任何代码引用，**未核实**是否为该 JSON 的原始数据源留存。
- **`kokoro/`（114 MB）与 `kokoro-server/`**：都是「Kokoro 神经语音」相关，但**不是
  同一套东西，作用完全不同**（这是本次审查中新发现、旧文档完全没提的一点，务必看
  「加载架构」一节里的详细说明）：
  - `kokoro-server/`（`app.py` 等，28 KB）：**当前线上实际使用**的服务端方案，部署成
    Hugging Face Space，`script.js` 里的 `KOK_SERVER_URL` 指向它。
  - `kokoro/`（114 MB：ONNX Runtime WASM、6 个语音包、`kokoro.web.js`、
    `kokoro-worker.js`）：一套**浏览器内 WASM 推理**的替代实现，但 `grep -rn` 遍历
    `script.js` / `srs.js` / `index.html` **找不到任何地方 `new Worker` 它或引用
    `kokoro.web.js`**——这套代码目前是孤立的、未接入任何调用路径。sw.js 里放行
    `/Linggo/kokoro/` 的注释说是给它让路，但既然没人请求这些文件，这 114 MB 实际上
    只是占着仓库体积，不影响任何用户可感知的行为。**这是一处怀疑是遗留代码的发现，
    没有去删它（本批次只改 CLAUDE.md），如需清理请单独立项确认。**

---

## 真实文件清单

（`ls -la` + `wc -l` 实测，commit `b8a3787`）

### 阅读器应用（关键）

| 文件 | 体积 | 行数 | 职责 | 关键路径 |
|---|---|---|---|---|
| `index.html` | 42.5 KB | 901 | 全部视图的 HTML 骨架（landing/library/reader/player/vocab-panel/flashcard/admin 入口等），末尾仅 5 个同步 `<script>` | 是 |
| `style.css` | 116.6 KB | 2989 | 全部组件样式 | 是 |
| `script.js` | 247.9 KB | 5106 | 阅读器主逻辑（书库、阅读、TTS、词典弹窗、我的书架、Supabase 桥接、Kokoro/Edge TTS 引擎） | 是 |
| `srs.js` | 90.3 KB | 1915 | 生词本闪卡系统、FSRS 调度、词库面板、词根词族训练法 | 是 |
| `sb.js` | 5.6 KB | 170 | Supabase 轻量客户端（无 SDK，纯 `fetch`） | 是 |
| `userdeck.js` | 11.8 KB | 277 | 用户自备词书导入/存储（IndexedDB + localStorage） | 是 |
| `licon.js` | 2.0 KB | 56 | Lottie 微交互图标封装（`Licon.mount/setState/nudge`） | 是 |
| `sw.js` | 4.1 KB | 109 | Service Worker，`CACHE = 'linggo-v206'` | 是（拦截 fetch） |
| `manifest.json` | 0.5 KB | 25 | PWA 清单，两个图标（192/512） | 是 |
| `align-worker.js` | 6.0 KB | 154 | 神经词对齐 Web Worker（ES module，`new Worker(..., {type:'module'})`） | 按需（点开「神经词对齐」才加载） |
| `cet4.js` / `cet6.js` / `ogden850.js` | 45.2 / 38.1 / 49.1 KB | 609 / 501 / 823 | 三份内置词库，`<script>` 求值后留下全局变量 `CET4`/`CET6`/`OGDEN850` | 按需（`ensureDecks()` 懒加载） |
| `ecdict.js` | 620.7 KB | 1502 | 中英词典数据（全局变量 `ECDICT`），词典法词对齐用 | 按需（`ensureLexicon()` 懒加载，是这几个懒加载文件里最大的一个） |
| `词根.json` | 19.7 KB | — | 词根元数据（`srs.js` 的 `loadRoots()` 运行时 `fetch`） | 按需 |
| `词霸一.json` | 968.4 KB | — | 「词霸天下 38000」词书之一，7424 词，运行时 `fetch` | 按需 |
| `词霸一cvs.csv` | 689.1 KB | — | 未见代码引用，未核实用途 | 否 |
| `词根.md` | 1.4 KB | — | 未核实用途（可能是词根数据的文档说明） | 否 |

### vendor/（第三方库，本地托管）

| 文件 | 体积 | 是什么 | 用途 |
|---|---|---|---|
| `ts-fsrs.umd.js` | 71.6 KB | `ts-fsrs` v5.4.1（FSRS v6 算法，MIT，`vendor/ts-fsrs.LICENSE`） | 闪卡间隔重复调度，全局变量 `FSRS` |
| `hyphenation.en-us.js` | 26.9 KB | 英语连字符/音节切分模式表（源自 TeX hyphenation patterns） | 配合 `hypher.js` 给单词卡拆音节 |
| `hypher.js` | 7.3 KB | Hypher.js 音节切分引擎 | 同上 |
| `lottie.min.js` | 242.5 KB | lottie-web | 渲染 `lottie/*.json` 微交互图标 |
| `emoji/*.svg` | 各 ~12–36 KB | useAnimations 风格的 deck 徽章图（MIT，见 `vendor/emoji/LICENSE`） | 词库面板的 CET4/CET6/Ogden/自备词书 badge |

### PWA 图标

`icon.png`、`icon-192.png`、`icon-512.png`、`apple-touch-icon.png`、`icon.svg`——
供 `manifest.json` 和 `index.html` 引用。`icon-preview.html`（8.1 KB）是本地看图标效果
用的独立小页面，未核实是否仍在用，**不是应用的一部分**，不被 `sw.js` 预缓存。

### Kokoro 神经语音（两套，见上方「⚠️」说明）

- `kokoro-server/`：`app.py`（FastAPI）+ `Dockerfile` + `requirements.txt`，部署到
  Hugging Face Space（`sdk:docker`），`script.js` 的 `KOK_SERVER_URL` 指向它。
- `kokoro/`：114 MB，`kokoro.web.js`（2.1 MB）+ `kokoro-worker.js`（1.3 KB）+
  `ort/`（ONNX Runtime WASM，21.6 MB）+ `voices/`（6 个语音包，各 522 KB）+
  `hub/`（模型缓存目录，89 MB）。**当前未被任何代码引用**，见上方说明。

### 其它

- `lottie/`（520 KB，多个小 `.json`）：Lottie 动画数据，`licon.js` 按需 `fetch`。
- `cloudflare-proxy/`：`worker.js` + `wrangler.toml` + `README.md`，图书下载代理的
  Worker 源码，见「图书下载代理」一节。
- `admin.html`（21.9 KB，525 行）：自包含管理后台，内嵌 CSS+JS，独立于阅读器。
- `docs/CMA_plan_big_execute_small.ipynb`：本文件顶部工作约定引用的 cookbook 原文。
- `CHANGELOG.md`：迭代记录，**内容已滞后**（写的是 `linggo-v126`，当前 `sw.js` 是
  `linggo-v206`），仅作历史参考，不要当作当前状态的信息源。
- `.github/workflows/supabase-keepalive.yml`：唯一的 Actions workflow，每 3 天 ping
  一次 Supabase 防止免费版项目被自动暂停。**仓库里没有找到部署到 GitHub Pages 的
  workflow 文件**——「push main 即触发 Pages 部署」大概率是通过 GitHub 仓库 Settings
  里的「Pages → Deploy from a branch」配置的（这种方式不需要 workflow 文件，由 GitHub
  后台完成），但这一点**未在 GitHub 仓库设置里核实**，只是没找到反证。

---

## 加载架构

批次 4 把约 1 MB 的词库/词典/音节数据挪出了首屏关键路径。这一节的目的是**防止后人手滑
把它们改回同步加载**。

### `index.html` 末尾只应有 5 个同步 `<script>`

```html
<script src="userdeck.js"></script>
<script src="licon.js"></script>
<script src="sb.js"></script>
<script src="script.js"></script>
<script src="srs.js"></script>
```

顺序是硬约束：`userdeck.js` 顶部注释明确写了「须在 ogden850.js 之后、srs.js 之前加载——
srs.js 的 `getDeckWordList`/`updateVpStats` 需要读本文件暴露的 `userDecks` /
`USER_DECK_CACHE` / `loadUserDeck`」；而 `script.js` 顶部的 `loadScriptOnce` /
`ensureDecks` 等闸门函数要在 `srs.js` 里被跨文件调用（`window.ensureDecks =` 等），
所以 `script.js` 必须先于 `srs.js`。

### 懒加载闸门：`loadScriptOnce()` + 三道 `ensureXxx()`

定义在 `script.js:7-45`：

```js
function loadScriptOnce(src)   // script.js:7   — 同一个 src 只下一次，失败会从表里摘掉重试
function ensureDecks()         // script.js:23  — cet4.js + cet6.js + ogden850.js + vendor/ts-fsrs.umd.js
function ensureLexicon()       // script.js:32  — ensureDecks() 之上再加 ecdict.js（最大的一档）
function ensureHyphen()        // script.js:36  — vendor/hyphenation.en-us.js + vendor/hypher.js
```

`词根.json` / `词霸一.json` 不走这套闸门——它们是纯数据，走 `srs.js` 里 `loadRemoteDeck` /
`loadRoots` 的独立 `fetch()`（`srs.js:1395`, `srs.js:1425`），因为纯 JSON 数组当
`<script>` 求值后不留全局变量，只能 `fetch`（注释见 `srs.js:1379-1382`）。

### 这个项目特有的陷阱：`typeof X !== 'undefined'` 守卫 = 静默降级，不是报错

所有消费大文件的地方都写了形如：

```js
if(typeof CET4 !== 'undefined') add(CET4);     // script.js:2252 附近，及 srs.js:1445-1447
if(typeof FSRS === 'undefined') return null;   // srs.js:84
```

这意味着依赖缺席时**不会抛错、界面也不会报错**，而是悄悄降级：词表变空、词对齐失准、
FSRS 调度悄悄退回 `_FALLBACK_IV` 固定间隔（`srs.js:80`, `102-104`, `115`）。
**加新的按需依赖时必须同时在调用处 `await` 对应的 `ensureXxx()`，光靠 `typeof` 守卫
等于埋雷**——守卫只防炸，不防「静默不工作」。

### 闸门要挡在「功能入口」，不能挡在「界面出现」前面

这是上线前审出来的一个真回归，**必须记住**：

- `openFlashcard()`（`srs.js:235`）、`openVocabPanel()`（`srs.js:1273`）**可以 `await`**：
  ```js
  if(typeof ensureDecks === 'function'){
    try{ await ensureDecks(); }
    catch(e){ toast('词库加载失败，请检查网络'); return; }
  }
  ```
  因为这两个面板本来就是「加载完才有意义」——先禁用按钮、显示"加载中…"，加载完再放行
  （`openVocabPanel` 里连按钮文案复原都写死成字面量，注释解释了为什么不能"记住进来之前
  是什么"：连点两下会把"加载词库中…"当成原始文案永久记下）。

- `onWordClick()`（`script.js:2550`）**绝不能 `await` `ensureHyphen()`**：单词弹窗是
  「先出框、再异步填内容」的设计，`await` 会把整个弹窗的出现挡在 33 KB 的音节库后面，
  冷缓存时表现为「点词没反应」。正确写法（`script.js:2612-2624` 附近）：
  ```js
  Promise.resolve(typeof ensureHyphen === 'function' ? ensureHyphen() : null)
    .then(() => {
      if(document.getElementById('wp-word').textContent !== word) return; // 已经换词了
      // …补写音节…
    })
    .catch(()=>{});
  ```
  不阻塞主流程，补写前用 `wp-word` 的 `textContent` 认一下词还是不是当前词（用户可能
  已经点了下一个）。

  `applyBilin()`（`script.js:2095`）同理，用 `_bilinCallId` 单调计数
  （`script.js:2094, 2096, 2108`）防止快速连点开关双语模式时，后到的 `await` 用旧状态
  覆盖新状态：
  ```js
  let _bilinCallId = 0;
  async function applyBilin(){
    const myId = ++_bilinCallId;
    // … await 之后：
    if(myId !== _bilinCallId) return; // 加载期间又被调用过，以最新那次为准
  }
  ```

  **一句话：凡是把同步函数改成 async，都要问一遍「await 期间用户能做什么」。**

### 关键路径实际体积（首屏必须下载的部分）

`index.html` + `style.css` + `script.js` + `srs.js` + `sb.js` + `userdeck.js` +
`licon.js` ≈ 42.5 + 116.6 + 247.9 + 90.3 + 5.6 + 11.8 + 2.0 ≈ **517 KB**（不含图标/
`lottie/*.json`，那些是 sw.js SHELL 预缓存但非阻塞渲染的资源）。懒加载的
`cet4.js`+`cet6.js`+`ogden850.js`（132.4 KB 合计）+ `ecdict.js`（620.7 KB）+
`vendor/hyphenation.en-us.js`+`vendor/hypher.js`（34.2 KB）+ `vendor/ts-fsrs.umd.js`
（71.6 KB）≈ **859 KB** 挪出了首屏。

---

## Service Worker 契约（sw.js，`CACHE = 'linggo-v206'`）

**上一版文档「改 JS/CSS 必须递增 CACHE 版本号，否则用户看到旧缓存」这句话已经不对**，
按当前 `sw.js` 重写如下：

### 1. 两套策略，按路径分流（`sw.js:66`）

```js
const CODE = /\/Linggo\/(?!vendor\/)[^/]*\.(js|css|html)$|\/Linggo\/$/;
```

- **网络优先**（`CODE` 命中，即非 `vendor/` 目录下的 `.js`/`.css`/`.html`，以及页面
  导航请求）：`fetch(request, {cache:'reload'})`，成功即写回缓存；失败才退回缓存/离线
  兜底 `index.html`。**部署即生效，不需要改版本号。**
- **缓存优先 + 后台更新**（其余同源静态资源：图标、`manifest.json`、`vendor/` 下的库、
  词根/词书 JSON）：先给缓存，同时后台 `fetch` 刷新缓存供下次用。
- **外部域名**（API、CDN、字体、Supabase）：`sw.js:73` 直接放行，SW 不拦截。
- **`/Linggo/kokoro/`**：`sw.js:78` 显式放行不缓存，见下方第 4 点。

### 2. `CACHE` 版本号真正的作用

只在**改了 `SHELL` 数组**（`sw.js:2-37`，预缓存清单——新增/删除文件、改了离线可用范围）
时才需要递增：递增会让 `activate` 阶段（`sw.js:51-58`）删掉旧版本号对应的整个缓存桶，
重新预缓存新的 `SHELL`。代码文件本身走网络优先，不靠版本号保证新鲜度。

### 3. `install` 阶段 `cache:'reload'` 是必须的（`sw.js:39-48`，注释在 `sw.js:40-42`）

```js
self.addEventListener('install', e => {
  e.waitUntil(
    caches.open(CACHE).then(c => c.addAll(SHELL.map(u => new Request(u, { cache: 'reload' }))))
  );
  self.skipWaiting();
});
```

原因：SW 里的 `fetch`/`addAll` 默认仍会经过浏览器自身的 HTTP 缓存，而 GitHub Pages
给静态文件发 `max-age=600`。不加 `cache:'reload'`，`install` 会把 HTTP 缓存里的旧文件
原样烤进新版本的 Cache Storage，然后一直留到下次版本号变更——**线上真出过一次「新 sw
+ 旧 srs.js」的版本错配**。同样的原因，`fetch` 阶段对代码文件也要用
`cache:'reload'`（`sw.js:81-83` 注释），否则"网络优先"会被浏览器 HTTP 缓存直接应答，
压根到不了网络，部署后最长 10 分钟都还是旧代码。

### 4. `/Linggo/kokoro/` 被直接放行的原因（`sw.js:75-78`）

注释写的是「约 115 MB 模型，交给 transformers.js 自己的持久 Cache API 缓存，避免版本号
一变就重下」。但如前所述，**当前没有任何代码路径会请求这些文件**（见「⚠️」一节），
这条规则目前形同虚设——不是错的，是在为一个尚未/已经不再接入的功能预留位置。

---

## script.js 模块地图

按 `grep -n '^// ═'` 拿到的真实分节（`script.js` 共 5106 行）：

| 起始行 | 模块 | 关键内容 |
|---|---|---|
| 2 | LAZY SCRIPT LOADING | `loadScriptOnce`/`ensureDecks`/`ensureLexicon`/`ensureHyphen`，见「加载架构」 |
| 48 | INDEXED DB — book cache | `openIDB`/`idbSave`/`idbGet`；`_idbPromise` 复用同一个连接（注释：57 本书曾各开一次连接、从不关闭） |
| 118 | BOOK DATA | `BOOKS`（87 本内置，3 档）、`CATALOG`（103 条 Gutenberg 目录，`script.js:395`）、`SE_BOOKS`（94 本 Standard Ebooks，`script.js:523`），见「内置书目数量」 |
| 633 | Cover URL | `coverUrl(isbn)`、`gbCoverUrl(id)` |
| 637 | CORS proxies | `BOOK_PROXY`/`PROXIES`/`_streamProxy`，见「图书下载代理」 |
| 705 | SE: strip HTML to text | `seHtmlToText(html)` |
| 713 | Fetch SE 单页书 | `fetchSEText(slug)`（`script.js:714`） |
| 725 | Load SE book | `loadSEBook(book, cardEl)`（`script.js:726`），HTML → 纯文本 → IDB 缓存 |
| 755–1063 | 卡片状态机 / 封面预览 | `openBookPreview`（`script.js:836`）、`_prepStart`（`script.js:1114`，「封面页三行预热状态：静默预热书籍文本 / 神经语音 / 词对齐模型」，注释见 `script.js:1089`） |
| 1029 | 下载去重 | `_BOOK_INFLIGHT`（`script.js:1029`，url → {promise, listeners}）、`_downloadBook`（`script.js:1031`） |
| 1203 | Open book in reader | 含 View Transitions API 平滑切换 |
| 1229 | Render library rows / 1257 Unified search / 1379 Filter bar | 书库 UI |
| 1436 | STATE | `const S = {...}`（`script.js:1449` 起，含 `kokVoice:'af_heart'` 等默认值） |
| 1464 | PERSIST (localStorage) | `saveProg`/`loadProg`（`script.js:1476`，**`JSON.parse` 未包 try**，见「已知问题」）/`restoreProg` |
| 1500 | VOICES | `populateVoices`/`getVoice` |
| 1549 | FILE LOADING | 本地 TXT 上传 |
| 1593 | BUILD READER — chunked render | `splitSents`/`isHeading`（`script.js:1633`）/`buildPara`/`buildReader`（`script.js:1864`，**无代际取消**，见「已知问题」） |
| 1735 | INTERACTION | 移动端长按 / 桌面长按查词，`onWordClick` 挂载点 |
| 1917 | CHAPTER TOC | `renderChapters`/`openChapPanel`/`closeChapPanel` |
| 1965 | SENTENCE TRANSLATE | `translate(txt)`（`script.js:2038`，**失败返回字符串而非 reject**，见「已知问题」）、`TRANS_CACHE` |
| 2067 | BILINGUAL MODE | `applyBilin`（`script.js:2095`）+ `_bilinCallId` 防竞态 |
| 2129 | NEURAL ALIGNMENT | `NALIGN`（`script.js:2134`），封装 `align-worker.js` 的 Worker 通信，`isEnabled/isReady/preload/request` |
| 2211 | WORD ALIGNMENT（词典法） | `_buildLex`（`script.js:2245`）/`_lexGet`（`script.js:2261`），默认/离线兜底 |
| 2380 | WORD CLICK → DICTIONARY | `onWordClick`（`script.js:2550`，async，**内部绝不 await 音节库**）、`positionPopup`、`_ipaSyllables`（`script.js:2403`）、`_splitAffixes`（`script.js:2469`）、`_syllabify`（`script.js:2499`） |
| 2868 | VOCAB | 生词本增删、飞入动画、`localStorage['vocab']` |
| 2997 | TTS — paragraph chunks | `jump`/`buildChunk`/`playChunk`/`makeUtterance`（`script.js:3224`，**`playChunk` 的无意义别名**，见「已知问题」） |
| 3468 | SEARCH | 阅读内搜索 `doSearch`/`navSrch`/`goMatch` |
| 3497 | SETTINGS / MODES | `applyFont`/`applyNight`/`applyLineHeight`/`applyTextAlign` |
| 3663 | TOAST | `toast(msg)` |
| 3689 | 我的书架 | `loadUserBooks`（`script.js:3717`，**本地→云端迁移不检查 `addUserBook` 返回值就清空本地**，见「已知问题」）、`addUserBook`（`script.js:3745`）、`localSearch`（`script.js:3819`，评分规则见「本地搜索算法」）、`localSearchSE`（`script.js:4013`）、每日英语 `loadVoaFeed`（`script.js:3925`） |
| 4023 | Gutendex | Gutenberg JSON API 在线搜索（7 万本，CORS 可用） |
| 4180 | Sync | Supabase 拉取 + 推送本地孤儿记录 |
| 4220 | Auth modal / 4295 User menu | 登录/注册 UI |
| 4372 | 启动预热 / 全局兜底 / 离线检测 / SW 注册 | — |
| 4373 | HIGH-QUALITY TTS 引擎优先级 | 见下 |

### TTS 引擎优先级（`script.js:4373-4379` 注释原文）

```
0: Kokoro-82M server-side neural TTS（HF Space API，全平台）
1: Microsoft Edge 神经语音 WebSocket（非 iOS，连续失败 2 次后跳过）
2: 本地最优 SpeechSynthesis 神经语音（Siri 评分=10，Enhanced=8，评分≥5）
3: Google Translate TTS（非 iOS，连续失败 2 次后跳过）
4: 任意 SpeechSynthesis 语音（保底）
```

- **Kokoro 服务端**：`KOK_SERVER_URL`（`script.js:4453` = `'https://langhua1998-kokoro.hf.space'`）、
  `_kokServerSynth`（`script.js:4515`）请求 `/tts-timed`（`script.js:4532`，返回逐词
  时间戳，失败退回 `/tts`，`script.js:4541`）、`_kokMaybeCold`（`script.js:4483`，判定
  HF Space 免费层冷启动，约需数十秒）。四张状态表：`KOK_CACHE`/`KOK_DONE`/`KOK_ABORT`/
  `KOK_WORDS`（`script.js:4456-4459`）。代码里判断"是否已部署"的方式是比较
  `KOK_SERVER_URL !== 'https://YOUR_HF_USERNAME-kokoro-tts.hf.space'`（占位符），出现
  在十余处调用点，**不是配置开关，是硬编码字符串比较**。
- **Edge TTS**：`_EDGE_TOKEN`（`script.js:4598`，写死的公开 token）、
  `_EDGE_WSS`（`script.js:4600`）、`_secMsGec`（`script.js:4608`，签名算法）——依赖
  微软未公开的内部接口，随时可能失效（见「已知问题」）。

---

## srs.js 模块地图

按 `grep -n '^// ═'` 拿到的分节（`srs.js` 共 1915 行）：

| 起始行 | 模块 |
|---|---|
| 2 | FLASHCARD SYSTEM — SRS + Swipe + Animations |
| 1271 | VOCAB DECK PANEL |
| 1545 | 词根卡：从词根主动召回整个词族 |

### FSRS 调度（`srs.js:74-133`）

```js
function _sched()                    // srs.js:82  — 惰性创建 FSRS.fsrs() 实例，库未加载返回 null
function applyFsrs(rec, rating, nowMs)  // srs.js:100 — 实际评分，返回 {nextReview, interval, fsrs}
function previewFsrs(rec, nowMs)     // srs.js:113 — 一次性算出 again/hard/good/easy 四档间隔，供按钮显示
function _reviveFsrsCard(rec)        // srs.js:89  — JSON 存回来的 due/last_review 字符串复活成 Date
function _serializeFsrsCard(c)       // srs.js:94  — 反向序列化
```

`_FALLBACK_IV`（`srs.js:80`：`again=10分钟 hard=1天 good=3天 easy=7天`）**只是
`vendor/ts-fsrs.umd.js` 没加载成功时的降级路径**，不是当前的调度算法——当前调度是
FSRS v6（`vendor/ts-fsrs.umd.js` 头部注释：`ts-fsrs v5.4.1`）。记录里额外存一份
`fsrs` 字段（含 stability/difficulty），旧的 `nextReview`/`interval` 两个字段保留不动，
组卡、云同步、按钮预览都还在用它们（注释见 `srs.js:74-78`）。

### 为什么进度表一律 `Object.create(null)`（注释见 `srs.js:135-140`）

```js
function emptyProgress(){ return Object.create(null); }   // srs.js:141
```

单词是外部数据，词表里真的有 `constructor` 这个词。普通 `{}` 上
`prog['constructor']` 会命中 `Object.prototype.constructor` 而为真，那个词就被当成
「已学过」——既不算新词，`nextReview` 又是 `undefined` 永远不到期，结果是永远抽不到。
`toString`/`valueOf` 同理。**这是后人极容易改错的地方**：任何新建进度对象的地方都要用
`emptyProgress()`，不要写字面量 `{}`。

### 词根词族系统

```js
function splitRoot(word, rootChain)     // srs.js:1363 — 拆成 {前缀, 词根本体, 后缀}
function rootMetaFor(chain)             // srs.js:1442 — 词根元数据（释义/引申/词源）
function getDeckWordList(deck)          // srs.js:1444
function familyGroups(deck)             // srs.js:1458 — {root, words:[...]}[]，顺序扫词表每满 6 词或 root 变化断组
function orderedGroupSession(deck, ...) // srs.js:1498 — 按组取词（而非按词取词）编排一轮复习
function showFamilyIntro(grp)           // srs.js:320  — 组前对照表：新组开始前一次性摆出整组词的拆解+释义
function showQuiz(v)                    // srs.js:365  — 辨析题：给中文释义，从同族词选正确形式
function showRootCard(meta)             // srs.js:1616 — 词根总览卡：词根链+释义/引申/词源+完整词族列表
function showRecallCard(meta)           // srs.js:1657 — 词族回忆卡：主动召回训练，已掌握✓/未掌握?
```

大词表注册在本文件而非 `userdeck.js`（原因见 `srs.js:1384-1387` 注释：分开放过一次，
结果老用户 SW 缓存里两个文件版本不一致，`REMOTE_DECKS` 直接 `undefined`，词表永远载
不进来；定义和消费放同一文件就没有这种版本错配空间）：

```js
const REMOTE_DECKS = {
  song1: { name:'词霸天下38000之一', url:'词霸一.json', count:7424, ordered:true, rootsUrl:'词根.json' }
};
```
`ordered:true` 表示这份词书按词根编排、必须顺序背（同族词挨着出现才是这套记忆法的
意义）；`cet4`/`cet6`/`ogden`/用户导入的词书仍是随机抽取。

`_normChain(s)`（`srs.js:1421`）用词根链的**首个变体**作匹配键而非整条链——两份数据
对同一词根收录的变体数量可能不同，比对整条链会有约 2 个词根静默匹配不上（注释
`srs.js:1417-1420`）。

### 词根卡复习记录单独存 `vpr_<deck>`（注释见 `srs.js:145-148`）

```js
function loadRootSRS(deck){ ... localStorage.getItem('vpr_'+deck) ... }  // srs.js:151
function saveRootSRS(deck){ localStorage.setItem('vpr_'+deck, ...) }     // srs.js:152
```

不能混进 `vp_<deck>`——`updateVpStats` 是按词表逐词统计的，混进去会污染「新词/待复习/
已掌握」计数。`cardKey` 形如 `'1:info'` / `'1:recall'`（数字前缀是 `词根.json` 里的
`no` 字段）。

### 面板入口的 `await` 用法（对照「加载架构」一节）

`openFlashcard`（`srs.js:235`）和 `openVocabPanel`（`srs.js:1273`）都在函数体最前面
`await ensureDecks()`，失败 `toast` 提示并 `return`——这是正确用法，因为这两个面板打开
前锁按钮、显示「加载中…」本来就合理，不存在「先出框再填内容」的问题。

---

## 存储键总表

### localStorage（`grep -oE "localStorage\.(getItem|setItem|removeItem)\('[^']+'" *.js` 实测）

| 键 | 写入方 | 含义 |
|---|---|---|
| `vocab` | `script.js` | 生词本，JSON 数组 |
| `rdr_<S.fileName>` | `script.js:1466-1477` | 每本书的阅读进度 + 设置（字号/行距/对齐/夜间/双语/口音/模式），**`loadProg` 里 `JSON.parse` 未包 try**（见「已知问题」） |
| `my_books` | `script.js`（`loadLocalUserBooks`/`saveLocalUserBooks`） | 我的书架本地兜底 |
| `userDecks` | `userdeck.js:20-26` | 用户自备词书清单（id/name/count 等小字段；词表正文另存 IndexedDB） |
| `fc_srs` | `srs.js`（`loadSRS`/`saveSRS`） | 生词本闪卡的 FSRS 进度，`fcSRS[word] = {...}` |
| `fcSRSVer` | `srs.js` | `fc_srs` 的数据版本标记（升级用） |
| `fcSize` | `srs.js` | 每轮闪卡张数（默认 12，与 `vpCount` 保持一致） |
| `vp_<deck>` | `srs.js:162-165` | 词库面板某词书的进度，`Object.create(null)` |
| `vp_user:<id>` | `srs.js` | 用户自备词书（`deck='user:'+id`）的进度，同上模式 |
| `vpr_<deck>` | `srs.js:151-152` | 词根卡（总览卡+回忆卡）的独立复习记录，不与 `vp_<deck>` 混存 |
| `vpVer` | `srs.js:160` | 词库进度的数据版本标记（写死 `'fsrs1'`） |
| `linggo_streak` | `srs.js` | 连续学习天数 |
| `selectedVoice` | `script.js` | 用户选择的系统 TTS 音源 |
| `kokVoice` | `script.js` | 选择的 Kokoro 音色（默认 `af_heart`，见 `S` 状态默认值） |
| `nalign` | `script.js` | 神经词对齐开关 |
| `sb_tok` / `sb_ref` | `sb.js:37-38` | Supabase access token / refresh token |
| `tl_src` | `script.js`（`translate()` 内） | 上次翻译成功的源，排到下次尝试的最前面，避免按 IP/时区猜地区 |

### sessionStorage

| 键 | 写入方 | 含义 |
|---|---|---|
| `tl_cache` | `script.js:1989-1993` | 翻译缓存（会话级） |
| `linggo_admin_ok` | `admin.html:306, 332, 342, 369` | 管理后台密码门通过标记（**纯客户端门**，见「已知问题·安全」） |

### IndexedDB

| 库 | Store | keyPath | 用途 |
|---|---|---|---|
| `ReadEN`（`IDB_VER=1`） | `books` | `url` | 缓存下载过的书籍全文（`script.js:50, 58`） |
| （同库或另开，未逐一核实） | `userdeck:<id>` | — | 用户自备词书正文，`userdeck.js:31`（key 前缀 `userdeck:`） |

---

## Supabase

### `sb.js` 真实方法列表（`sb.js`，无 SDK，纯 `fetch`）

```js
SB.signIn(email, password)                         // sb.js:31
SB.signUp(email, password)                          // sb.js:43
SB.signOut()                                        // sb.js:55
SB.restoreSession()                                 // sb.js:62  — 见「已知问题」：网络失败会被当 token 过期
SB.selectVocab(userId)                              // sb.js:88  — 注意要传 userId，不是无参
SB.upsertVocab(rows)                                // sb.js:92
SB.deleteVocab(userId, word)                         // sb.js:100
SB.rpc(fn)                                          // sb.js:106 — POST 空 body
SB.selectUserBooks(userId)                          // sb.js:110
SB.insertUserBook(row)                              // sb.js:114
SB.deleteUserBook(id)                               // sb.js:122 — 按 id 删，不是按 url
SB.selectVocabProgress(userId, deck)                 // sb.js:126
SB.upsertVocabProgress(userId, deck, word, data)     // sb.js:130
SB.selectFcSRS(userId)                              // sb.js:148 — 内部按 deck='book' 查 vocab_progress
SB.upsertFcSRS(userId, word, data)                   // sb.js:152
```

`BASE = 'https://ueskojxtupmxwolzxdxa.supabase.co'`，`KEY` 是 publishable/anon key
（`sb.js:5-6`，可安全暴露于客户端，受 RLS 保护）。

### 数据库表

| 表 | 说明 |
|---|---|
| `user_books` | 我的书架，字段见 `sb.js:111` 的 `select` 列表：`id,title,author,year,url,mark,isbn,pal,cat` |
| `vocab` | 生词本云同步，字段：`word,meaning,sent,time`（`sb.js:89`） |
| `vocab_progress` | **已实现**，不是上一版文档说的「计划中」。字段：`user_id,deck,word,status,next_review,correct_count,wrong_count,interval_ms,last_seen`（`sb.js:127, 134-144`）。`deck='book'` 这一行专门存生词本闪卡的 FSRS 进度（`selectFcSRS`/`upsertFcSRS`），其余 `deck` 值对应词库面板的各词书。 |
| （访问统计表） | 未在 `sb.js` 里找到直接的 `logVisit`/`page_views` 方法名，上一版文档提到的写入方式**未核实**，管理后台走的是 `SB.rpc('get_admin_stats')`（见 `admin.html:393`） |

---

## 已知问题清单

刚完成一轮全面代码审查，以下问题**已确认存在、尚未修复**。本次重写文档时对其中约
12 条做了 `grep -n` 复核，全部与代码实际行为一致；未逐条重新验证的按原样收录，不代表
未经审查。

### 安全

- `admin.html` 的管理密码是纯客户端门：`ADMIN_HASH`（`admin.html:305`，无盐 SHA-256、
  写死在公开仓库里）+ `sessionStorage['linggo_admin_ok']`（`admin.html:306`），拦不住
  任何服务端行为——其 RPC 调用 `apikey`/`Authorization` 都用的同一个 anon key
  （`admin.html:320`），没有区分管理员身份。修复应在数据库侧（`SECURITY DEFINER` +
  `auth.uid()` 白名单 + `REVOKE EXECUTE FROM anon`）。
- `script.js:2625` 单词卡「语境」用 `innerHTML` 拼书籍正文摘录（全项目唯一的
  `innerHTML` 拼接书籍原文的例外），书文本来自用户上传或第三方 CORS 代理 → 存在 XSS
  可能，可偷 `localStorage` 里的 `sb_tok`。

### 数据

- 退出登录不清本地生词（未找到 `signOut` 相关的 `localStorage.removeItem('vocab')`
  调用）→ 同一设备换人登录，`syncVocab`（`script.js:4181`）会把上一个人的生词推进
  新账号。
- `loadUserBooks`（`script.js:3717-3739`）的本地→云端迁移循环 `await addUserBook(lb, true)`
  不检查返回值就 `saveLocalUserBooks([])`（`script.js:3736`）清空本地——插入失败即丢书。
- `syncVpFromSupabase`（`srs.js:167-179`）无条件把云端行写进 `vpProgress`，云端表没有
  `fsrs` 字段（`selectVocabProgress` 只查 `next_review,correct_count,wrong_count,
  interval_ms`，见 `sb.js:127`）→ **每次跨设备同步都把 FSRS 记忆模型清零**。代码注释
  `srs.js:173-174`「这是升级后重置为新卡的预期行为，不是 bug」——这句注释只对**一次性
  迁移**成立，对每次登录都会跑的 `syncVpFromSupabase` **不成立**，因为它没有做过一次
  就不再做的判断。
- 开了邮箱验证时注册会显示成已登录但没有 token（`signUp` 在没有 `access_token` 时仍
  `return d.user || d`，`sb.js:47-53`）——**未逐帧核实前端如何处理这个返回值**，但
  `sb.js` 本身的行为符合这条描述。
- `sb.js:62-86` 的 `restoreSession` 把 `req('/auth/v1/user')` 抛出的任何异常（网络失败
  同样会 throw）都当成 token 过期处理，走 refresh 逻辑，refresh 也失败就清 token→
  **离线打开会被登出**。
- 没有主动的 token 续期定时器（未找到），约 1 小时（Supabase 默认 JWT 有效期）后云端
  写入会静默 401，需要用户触发一次会抛错的操作才会被动 refresh。

### 功能

- `buildReader`（`script.js:1864-1913`）的 `renderChunk` 用 `setTimeout` 链式渲染大书，
  没有代际 / 取消令牌——快速连续换书，旧书的 `renderChunk` 还在跑时，会把段落继续
  `appendChild` 进 `area`，与新书内容混在一起。
- `loadProg`（`script.js:1476-1490`）对 `rdr_<fileName>` 的 `JSON.parse(raw)`
  **没有包 try**（同函数下面对 `vocab` 的 `JSON.parse` 倒是包了 try），存档损坏会导致
  那本书永远打不开（抛到 `buildReader` 外层，未核实是否有全局兜底能恢复）。
- `wpop._audio` 只在词典请求成功分支里被赋值（`script.js:2647`），`onWordClick`
  （`script.js:2550`）开头和 `_stopWordAudio()`（`script.js:2774`）都不重置它→ 词典
  查询失败或还在进行中时，喇叭按钮播的是上一个词的发音。
- `translate()`（`script.js:2038-2064`）所有翻译源都失败时 `return
  '[翻译失败，请检查网络]'`——是普通字符串返回，不是 `reject`。调用方
  `script.js:1978`（`S.trans[i] = res; tl.textContent = res;`）把这个失败提示原样存进
  `S.trans[i]`，此后这句译文永久显示失败提示，整本书不会自动重试。
- `isHeading`（`script.js:1633-1641`）除了 `chapter/part/section/...` 外，还会把
  `Part/Story/Tale/Letter/Book/Act/Adventure` 等**普通单词开头的正文句子**误判成章节
  标题（正则 `^(chapter|part|section|prologue|epilogue|book|preface|introduction|
  appendix|interlude|afterword|act\s|adventure|story|tale|letter|volume)`，对全书任意
  句首都生效，不限于独立成段的标题行）。
- 阅读设置（夜间/字号/行距/对齐/模式）存在每本书各自的 `rdr_<S.fileName>`
  （`script.js:1468`）里，换书会带出该书上次保存的设置，覆盖当前正在用的设置——不是
  全局共享的偏好。
- `lib-empty`（`script.js:1254`）的判定只看三个内置层（`any` 的计算范围未逐一核实是否
  含 CATALOG/SE_BOOKS），可能忽略我的书架和每日英语的存在，导致空状态提示误判——
  **具体判定条件未逐行核实，按原有审查结论收录**。
- `populateVoices`（`script.js:1525`）**未逐行核实**「每次覆盖用户的音源选择，且下拉
  框永远只有一个选项」这条的当前状态，按原有审查结论收录。

### 代码卫生

- `script.js:3058` 的 `boundaryFired` 只在 `playChunk` 内部写（`3058, 3062`），没有任何
  地方读它；附近没有找到它声称要配合的「iOS onboundary 降级」逻辑——这个降级路径
  不存在，变量是死代码。
- `makeUtterance`（`script.js:3224`）：`function makeUtterance(chunk){ return
  playChunk(chunk); }`——`playChunk` 的无意义别名，逐字确认。
- 依赖两个未公开接口，随时可能失效：Edge TTS 的 `_EDGE_TOKEN`/`_EDGE_WSS` WSS 通道
  （`script.js:4598-4664`，写死的公开 token + 自实现签名 `_secMsGec`）；以及
  `translate_a/single`（Google 翻译非公开端点，**未在本次 grep 中直接定位到调用点**，
  按原有审查结论收录）。

---

## 保留并核实的既有章节

### 分支约定 + 每次工作完成的固定流程

- `main`：生产分支，推送即触发 Pages 部署（部署机制见「真实文件清单」结尾对
  `.github/workflows/` 的说明——未在仓库里找到显式的 Pages 部署 workflow，推测走的是
  仓库设置里的「Deploy from a branch」）。
- `claude/*`：AI 辅助开发分支（当前工作分支示例：`claude/software-visual-effects-cevnxg`）。

**每次工作完成的固定流程（务必遵守）**：每完成一项工作就立即合并推送上线，不把改动
留在工作目录：
1. 在功能分支 `claude/*` 上 `commit`（改了 JS/CSS 且**改了 `SHELL` 预缓存清单**才需要
   递增 `sw.js` 的 `CACHE` 版本号——见「Service Worker 契约」，代码文件本身走网络优先
   不需要）
2. `git push -u origin <功能分支>`
3. 快进合并到 `main` 并推送上线：`git push origin <commit>:main`
4. 确认 `git status` 工作区干净，无遗留未提交改动

> 推 `main` 是不可逆的对外部署。除非用户当次明确表示「先别上线」，否则默认按上述流程
> 一路推到 `main`。

### 图书下载代理（Cloudflare Worker）

书籍下载走 CORS 代理链（`script.js:637-652`），`PROXIES` 数组按序尝试、首个成功者
胜出，`_streamProxy`（`script.js:668-694`）用「15 秒无新数据才放弃」的停滞看门狗
（`stallMs=15000`，`script.js:699`），而非固定总超时——避免大书下载慢但仍在进展时被
误杀。

**主代理 = 自建 Cloudflare Worker**（边缘 + KV 全球缓存，热门书二次下载近乎秒开），
对照 `cloudflare-proxy/worker.js` 核实：

| 项 | 值 |
|---|---|
| Worker 名 | `linggo-proxy` |
| 线上域名 | `https://linggo-proxy.langhua98.workers.dev`（`script.js:641`） |
| 调用格式 | `…/?url=<URL编码后的书籍地址>` |
| Cloudflare 账号 ID | `aca35ff5f62ae4208757219dbc3b489b` |
| KV 命名空间 | `linggo-books` id=`9d85306e3292443dad716d055bb32ae6`，绑定名 `BOOKS`（`worker.js:52` 起用 `env.BOOKS`） |
| 源码 | `cloudflare-proxy/worker.js`，只代理 `ALLOW_HOSTS`（`worker.js:13-17`：`gutenberg.org` 系 + `standardebooks.org` 系），非开放代理 |
| 公共备用 | `cors.eu.org` → `proxy.cors.sh` → `allorigins` → `corsproxy`（`script.js:648-651`，按此顺序） |

**为什么用 KV**：Cloudflare Cache API 是分机房的，KV 全球复制，命中后任何地区都秒读
（`worker.js` 头部注释）。Worker 先查 KV（`worker.js:52-63`），未命中才抓 Gutenberg/
Standard Ebooks（伪装 Chrome UA 防限流，`worker.js:66-73`）并 `ctx.waitUntil` 写回 KV
（`worker.js:81-82`，30 天 TTL）。新书源上线务必预灌：依次 `…/?url=<book>` 命中一次
即写入 KV，否则首个用户要等 Gutenberg 冷抓（可能数秒到数十秒）。

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
免费额度：Worker 10 万次/天，KV 读 10 万/天、写 1000/天、存储 1GB；改书源主机改
`worker.js:13-17` 的 `ALLOW_HOSTS`。

### 本地搜索算法（`localSearch`，`script.js:3815-3858`）——评分规则已变，不再是 +10/+6/+3/+2/+1

```js
function norm(s){
  return s.toLowerCase().normalize('NFD').replace(/[̀-ͯ]/g,'');
}
```

评分（`scoreBook`，`script.js:3837-3850`）：
- 标题完全相等：直接返回 1000（不再走后面的累加）
- 标题前缀匹配 +80 / 否则包含 +50
- 标题命中全部查询词（多词查询）+40，另外每个命中的词 +15
- 作者命中全部查询词 +20，另外每个命中的词 +8
- 结果按分数降序，**最多返回 30 条**（不是 20 条）

搜索池是 `BOOKS.flat()` + `CATALOG`（按 url 去重），**不包含 `SE_BOOKS`**——Standard
Ebooks 目录走独立的 `localSearchSE`（`script.js:4013`）。

### 常见陷阱

1. **Service Worker 缓存旧版本**：只有改了 `sw.js` 的 `SHELL` 预缓存清单才需要递增
   `CACHE` 版本号；代码文件（非 `vendor/`）走网络优先，部署即生效，见「Service Worker
   契约」。
2. **`norm()` 的正则**：当前写法是 `/[̀-ͯ]/g`（标准 JS Unicode 转义），
   **可以直接这样写，不会有 SyntaxError**——上一版文档说"必须用字符范围转义、直接写
   Unicode 组合字符会导致 SyntaxError"这条描述与当前代码不符，本次未采信，按代码实际
   写法收录。
3. **`BOOKS`/`CATALOG`/`SE_BOOKS` 三种不同的数组格式**，混用字段会出错：
   - `BOOKS`：`{t,a,y,cat[],url,mark,isbn,pal[]}`，按 3 个难度分组（`script.js:120-390`）
   - `CATALOG`：6 元素数组 `[id,title,author,year,[cats],markText]`，`id` 是 Gutenberg
     数字 ID（`script.js:395-519`）
   - `SE_BOOKS`：`{t,a,y,level,cat[],slug,mark,pal[],_se:true}`（`script.js:523-625`），
     `slug` 是 Standard Ebooks 的书目 slug，不是数字 ID
4. **Gutenberg ID 提取**：从 URL 用 `/\/files\/(\d+)\//` 正则提取（`script.js:3724`
   附近 `loadUserBooks` 里可见此用法），存入 `_gbId` 字段。
5. **iOS TTS 暂停问题**：`resumeTimer`（`script.js:1453-1461`）每秒调用
   `synth.resume()` 防止系统暂停 `speechSynthesis`。
6. **CORS 代理会失效**：免费公共代理常态性失效（上一版文档记录 corsproxy.io 曾 403、
   thingproxy 曾整体下线），换代理时务必实测连通性；自建 Worker 是主代理，公共代理
   只是兜底。

---

## 内置书目数量

`grep -c` 实测，**不是上一版文档和 `index.html` 落地页写的「57 本」**：

| 数组 | 真实条数 | 位置 |
|---|---|---|
| `BOOKS`（内置书库，3 档合计） | **87** = 入门 33 + 中级 32 + 进阶 22 | `script.js:120-390`，🟢 BEGINNER / 🟡 INTERMEDIATE / 🔴 ADVANCED 三段。87 条 `url` 互不重复（已核） |
| `CATALOG`（离线 Gutenberg 目录，不含内置） | **103** | `script.js:395-519` |
| `SE_BOOKS`（Standard Ebooks 精选） | **94** | `script.js:523-625` |

`index.html:396` 落地页文案「57本免费」、`script.js:1555` 分享文案「57本经典名著免费读」
**都还是旧数字，与 `BOOKS` 实际的 87 条不符，待核对**。本批次只改 `CLAUDE.md`，
未改 `index.html`/`script.js` 里的文案。

---

## 开发流程

### 本地开发

```bash
# 需要 HTTPS 或 localhost 才能使用 Service Worker
python -m http.server 8080
# 访问 http://localhost:8080
```

### 修改文件后

1. 编辑对应文件
2. 只有**改了 `sw.js` 的 `SHELL` 预缓存清单**才需要递增 `CACHE` 版本号；改
   `script.js`/`style.css`/`index.html` 本身不需要（网络优先，见「Service Worker
   契约」）
3. 走「每次工作完成的固定流程」commit → push 功能分支 → 快进合并 `main`
