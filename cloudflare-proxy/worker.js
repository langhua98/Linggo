// ─────────────────────────────────────────────────────────────────────────
//  Linggo 图书下载代理 — Cloudflare Worker
// ─────────────────────────────────────────────────────────────────────────
// 跑在 Cloudflare 全球边缘节点，给书籍下载加上 CORS 头并做边缘缓存：
//   • 比公共免费代理快、稳，免费额度 10 万次/天
//   • 热门书缓存在边缘 → 第二个人下载几乎秒开（所有用户共享缓存）
//   • 只允许代理公开书源（Gutenberg / Standard Ebooks），不是开放代理，防滥用
//
// 部署见同目录 README.md。客户端调用格式：
//   https://<你的worker>.workers.dev/?url=<URL编码后的书籍地址>

// 只允许这些主机，避免被当成任意开放代理滥用
const ALLOW_HOSTS = new Set([
  'www.gutenberg.org', 'gutenberg.org',
  'gutenberg.pglaf.org', 'aleph.gutenberg.org',
  'standardebooks.org', 'www.standardebooks.org',
]);

const CORS = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Methods': 'GET, HEAD, OPTIONS',
  'Access-Control-Allow-Headers': '*',
  'Access-Control-Max-Age': '86400',
};

const withCors = (resp) => {
  for (const [k, v] of Object.entries(CORS)) resp.headers.set(k, v);
  return resp;
};
const err = (status, msg) =>
  withCors(new Response(msg, { status, headers: {} }));

export default {
  async fetch(request, ctx_unused, ctx) {
    if (request.method === 'OPTIONS') return withCors(new Response(null));
    if (request.method !== 'GET' && request.method !== 'HEAD')
      return err(405, 'method not allowed');

    const target = new URL(request.url).searchParams.get('url');
    if (!target) return err(400, 'missing ?url=');

    let dest;
    try { dest = new URL(target); } catch { return err(400, 'bad url'); }
    if (dest.protocol !== 'https:' && dest.protocol !== 'http:')
      return err(400, 'bad protocol');
    if (!ALLOW_HOSTS.has(dest.hostname)) return err(403, 'host not allowed');

    // 边缘缓存：命中直接返回；未命中则回源抓取并写入缓存
    const cache = caches.default;
    const cacheKey = new Request('https://linggo.proxy.cache/' + encodeURIComponent(dest.href));
    const hit = await cache.match(cacheKey);
    if (hit) return withCors(new Response(hit.body, hit));

    const upstream = await fetch(dest.href, {
      headers: { 'User-Agent': 'Mozilla/5.0 (Linggo book fetcher)' },
      cf: { cacheTtl: 86400, cacheEverything: true },
    });

    const resp = withCors(new Response(upstream.body, upstream));
    resp.headers.set('Cache-Control', 'public, max-age=86400');
    if (upstream.ok && request.method === 'GET')
      ctx.waitUntil(cache.put(cacheKey, resp.clone()));
    return resp;
  },
};
