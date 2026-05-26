# Linggo 代码库说明

## 项目概述

Linggo 是一个英文阅读助手应用。本仓库目前包含其**管理员后台**（`admin.html`），用于查看应用运营数据，包括用户数、词汇条目数、访问量统计及趋势图表。

后端数据存储和 API 由 **Supabase**（托管 PostgreSQL）提供，无需本地服务器。

---

## 文件结构

```
Linggo/
└── admin.html    # 唯一文件：完整的管理员仪表盘（HTML + CSS + JS 内嵌）
```

这是一个**单文件应用**，所有 HTML 结构、CSS 样式、JavaScript 逻辑均内嵌在 `admin.html` 中，无构建步骤，无依赖安装。

---

## 技术栈

| 层级 | 技术 |
|------|------|
| 标记语言 | HTML5（`lang="zh-CN"`） |
| 样式 | CSS3，内嵌 `<style>` 标签 |
| 脚本 | 原生 JavaScript（ES6+），无框架 |
| 后端服务 | Supabase（PostgreSQL + RPC） |
| UI 字体 | Google Fonts CDN（Lora、Nunito） |
| SDK | Supabase JS v2（via jsDelivr CDN） |

无 `package.json`、无构建工具（Webpack/Vite 等）、无 TypeScript。

---

## 核心功能

### 1. 密码验证门（Password Gate）
- HTML 节点：`#gate`
- 登录逻辑：`login()` 函数，将密码与 `ADMIN_PASSWORD` 常量比对
- 会话持久化：通过 `sessionStorage`（key：`linggo_admin_ok`）
- 验证通过后调用 `showDash()` 切换视图

### 2. 管理员仪表盘（Dashboard）
- HTML 节点：`#dash`，初始 `display:none`，登录后切换为 `display:block`
- 顶部导航栏：Logo、Admin 徽章、刷新按钮、退出按钮
- 4 张统计卡片：活跃用户数 / 生词条目总数 / 今日访问量 / 累计访问量
- 30 天访问趋势柱状图（纯 JS 手动渲染 DOM，无图表库）

### 3. 数据加载
- 函数：`loadStats()`（async）
- 调用 Supabase RPC：`sb.rpc('get_admin_stats')`
- 返回字段：`unique_users`、`total_vocab`、`today_visits`、`total_visits`、`daily_visits[]`

### 4. 图表渲染
- 函数：`renderChart(rows)`
- 数据按日期升序排列
- 每条柱高度 = `(count / max) * 100%`，最小 2%
- 今日柱特殊高亮（class `.today`）
- Hover 显示 tooltip（`.bar-tip`）

---

## CSS 约定

### 主题变量（定义在 `:root`）

```css
--bg: #F7F4EF          /* 页面背景 */
--surface: #fff         /* 卡片背景 */
--border: rgba(0,0,0,.08)
--text: #1C1917         /* 主文字 */
--text-2: #78716C       /* 次文字 */
--text-3: #A8A29E       /* 辅助文字 */
--accent: #2563EB       /* 主色（蓝） */
--accent-2: #EFF6FF     /* 主色浅背景 */
--green: #16A34A        /* 今日访问量 */
--green-2: #DCFCE7
--purple: #7C3AED       /* 生词数量 */
--purple-2: #EDE9FE
--orange: #EA580C       /* 累计访问 */
--orange-2: #FFF7ED
--r: 14px               /* 通用圆角 */
```

### 布局原则
- 响应式断点：`@media(min-width:600px)`（统计卡片从 2 列变为 4 列）
- 布局工具：CSS Grid（统计卡片）、Flexbox（导航栏、图表）
- 内容区最大宽度：`900px`，居中显示

### 字体
- **Lora**（serif，600 weight）：标题、Logo、章节标题
- **Nunito**（sans-serif，400/600/700/800）：所有正文、按钮

### 动画
- 交互过渡：`transition: 0.15s`
- 骨架屏加载：`.skeleton` class + `@keyframes shimmer`
- 图表柱高度：`transition: height 0.4s cubic-bezier(.4,0,.2,1)`

### 注释格式
CSS 区块分隔使用：
```css
/* ── 区块名称 ── */
```

---

## JavaScript 约定

- **命名**：驼峰式函数名（`loadStats`、`renderChart`、`showDash`、`checkGate`）
- **视图切换**：直接操作 `element.style.display`，不使用 class 切换
- **错误处理**：`try/catch`，捕获 Supabase 错误后在界面显示提示
- **JS 注释格式**：`// ── 区块名称`

---

## Supabase 集成

```js
// admin.html:280-285
const SB_URL = 'https://ueskojxtupmxwolzxdxa.supabase.co';
const SB_KEY = 'sb_publishable_-hbkl0aTVPGCfSL8rk6WPQ_mzGQ52O-'; // 公开可发布密钥
const sb = window.supabase.createClient(SB_URL, SB_KEY);
```

- `SB_KEY` 是 Supabase **publishable key**（非 service_role key），可安全暴露在客户端
- 实际安全边界由 Supabase 服务端 RPC 函数 `get_admin_stats` 的行级安全策略控制
- RPC 函数定义在 Supabase 项目中，不在本仓库

---

## 认证机制

```js
// admin.html:283,288
const ADMIN_PASSWORD = 'linggo2025'; // 修改此常量更换密码
const GATE_KEY = 'linggo_admin_ok';  // sessionStorage key
```

- 密码验证为纯客户端比对，适合个人/小团队使用场景
- 认证状态存储在 `sessionStorage`，关闭标签页后失效
- **修改密码**：直接编辑 `ADMIN_PASSWORD` 常量（第 283 行）

> **注意**：不要将 `service_role` key 或敏感密钥放入此文件。`ADMIN_PASSWORD` 对任何能查看源码的人可见，适合低风险内部工具。

---

## 开发流程

### 本地运行
```bash
# 直接用浏览器打开（无需服务器）
open admin.html
# 或在 VS Code 中使用 Live Server 插件
```

### 修改流程
1. 编辑 `admin.html`
2. 刷新浏览器
3. 输入密码 `linggo2025` 登录查看效果

### 无需安装依赖
- 无 `npm install`
- 无构建步骤
- 所有依赖通过 CDN 加载（Supabase SDK、Google Fonts）

---

## 分支约定

- `main`：生产分支
- `claude/*`：AI 辅助开发分支（如 `claude/claude-md-docs-Cdrse`）

---

## 扩展指南

如果未来需要添加新功能，遵循以下原则：

1. **新数据指标**：在 Supabase 中修改 `get_admin_stats` RPC 函数，前端在 `loadStats()` 中解构新字段，在 HTML 中添加对应 `#s-xxx` 元素
2. **新统计卡片**：复制现有 `.stat-card` 结构，从 CSS 变量中选取配色
3. **新图表**：保持纯 JS DOM 渲染风格（无图表库），参考 `renderChart()` 的实现模式
4. **样式修改**：优先调整 `:root` 中的 CSS 变量，避免散落的硬编码颜色值
