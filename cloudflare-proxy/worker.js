// ─────────────────────────────────────────────────────────────────────────
//  Linggo 图书下载代理 — Cloudflare Worker（KV 全球缓存）
// ─────────────────────────────────────────────────────────────────────────
// 给书籍下载加 CORS 头，并用 Cloudflare KV 做**全球**缓存：
//   • KV 全球复制，任何地区读取都快（不像 Cache API 是分机房的）
//   • 命中 KV → 直接返回（秒级）；未命中 → 抓 Gutenberg 并写入 KV
//   • 57 本内置书已预灌进 KV，所有用户首次打开即秒读，不必等 Gutenberg
//   • 只代理公开书源（Gutenberg / Standard Ebooks），非开放代理
//
// 绑定：KV 命名空间 linggo-books 绑为变量名 BOOKS（见部署命令的 bindings）。
// 调用：https://<worker>.workers.dev/?url=<URL编码后的书籍地址>

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
const err = (status, msg) => withCors(new Response(msg, { status }));

const KV_TTL = 60 * 60 * 24 * 30;  // 30 天

export default {
  async fetch(request, env, ctx) {
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

    const key = dest.href;

    // 1) KV 全球缓存命中 → 直接返回（任何地区都快）
    if (env.BOOKS) {
      const cached = await env.BOOKS.get(key, { type: 'arrayBuffer' });
      if (cached) {
        return withCors(new Response(cached, {
          headers: {
            'Content-Type': 'text/plain; charset=utf-8',
            'Cache-Control': 'public, max-age=86400',
            'X-Linggo-Cache': 'kv-hit',
          },
        }));
      }
    }

    // 2) 未命中 → 抓源站。Gutenberg 对非浏览器 UA 限流，故伪装成 Chrome。
    const upstream = await fetch(dest.href, {
      headers: {
        'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36',
        'Accept': 'text/html,application/xhtml+xml,text/plain,*/*',
        'Accept-Language': 'en-US,en;q=0.9',
      },
      redirect: 'follow',
    });

    if (!upstream.ok)
      return withCors(new Response('upstream ' + upstream.status, { status: 502 }));

    const body = await upstream.arrayBuffer();

    // 写入 KV（全球生效），下次任何用户秒读
    if (env.BOOKS && request.method === 'GET' && body.byteLength > 0)
      ctx.waitUntil(env.BOOKS.put(key, body, { expirationTtl: KV_TTL }));

    return withCors(new Response(body, {
      headers: {
        'Content-Type': 'text/plain; charset=utf-8',
        'Cache-Control': 'public, max-age=86400',
        'X-Linggo-Cache': 'miss',
      },
    }));
  },
};
