# Linggo 图书下载代理（Cloudflare Worker）

给书籍下载加 CORS 头并做**边缘缓存**的高速代理。跑在 Cloudflare 全球 CDN，
免费 10 万次/天，热门书缓存在边缘后第二个人下载几乎秒开。只代理公开书源
（Gutenberg / Standard Ebooks），不是开放代理。

## 部署步骤（约 5 分钟）

1. 注册/登录一个**免费 Cloudflare 账号**：https://dash.cloudflare.com/sign-up

2. 本机装好 Node.js 后，在本目录执行：

   ```bash
   cd cloudflare-proxy
   npm install -g wrangler     # Cloudflare 官方 CLI
   wrangler login              # 浏览器里授权一次
   wrangler deploy             # 部署 worker.js
   ```

3. 部署成功后终端会打印地址，形如：

   ```
   https://linggo-proxy.<你的子域>.workers.dev
   ```

4. 把这个地址发给我（或自己改）：填进 `script.js` 顶部的 `BOOK_PROXY` 常量，
   并递增 `sw.js` 的 `CACHE` 版本号，推送到 `main` 即生效，它会成为**主代理**，
   `cors.eu.org` 等公共代理自动降为备用。

## 验证

部署后直接在浏览器打开（应当返回《傲慢与偏见》正文）：

```
https://linggo-proxy.<你的子域>.workers.dev/?url=https%3A%2F%2Fwww.gutenberg.org%2Ffiles%2F1342%2F1342-0.txt
```

## 自定义

- 允许的书源主机：改 `worker.js` 里的 `ALLOW_HOSTS`
- 缓存时长：改 `cacheTtl` / `max-age`（默认 86400 秒 = 1 天）
