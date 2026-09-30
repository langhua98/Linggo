// 小橘音乐 · Telegram 频道音频中转（Cloudflare Worker）
//
// 音频文件存在 Telegram 频道里，但网页没法直接播放 Telegram 的音乐文件。这个 Worker 在服务端
// 持有机器人 token，把「频道消息号」换成浏览器能直接播放的地址。
//
// 超过 20 MB 的文件：官方 Bot API 的 getFile 只能取 20 MB 以内的文件，这些文件转给 Hugging Face
// 上的流式服务（streamer/）。它以机器人身份走 MTProto（不受 20 MB 限制），浏览器要哪一段，就从
// Telegram 现取哪一段、边取边传。免费 Space 闲置会休眠：这时第一次请求会把它叫醒，Worker 先回 503，
// 播放页等它醒了自动重试。
//
//   GET  /                 播放页
//   GET  /api/tracks       歌单 JSON（新的在前）
//   GET  /a/<消息号>        音频流，支持 Range（iOS Safari 开始播放、拖进度条都要 206）；?dl=1 变成下载
//   POST /tg-webhook       Telegram 推送频道新帖，音频自动登记
//   GET  /admin            管理页（管理密钥登录）：把频道里已删掉的帖子从歌单移除
//   *    /admin/api/...    管理接口（Authorization: Bearer <ADMIN_KEY>）
//
// 数据在 Durable Object「Library」的 SQLite 里：强一致，也没有 KV list 每天 1000 次的限制。
//
// 绑定：LIB（Durable Object）、TRACKS（旧 KV，只在第一次启动时迁移数据用）、
//       TG_BOT_TOKEN / TG_WEBHOOK_SECRET / ADMIN_KEY / STREAMER_KEY（secret）、
//       CHANNEL_ID / CHANNEL_USERNAME / STREAMER_URL（普通变量；STREAMER_URL 为空则大文件不能播放）

import { DurableObject } from 'cloudflare:workers';

const TG = 'https://api.telegram.org';
// 官方 Bot API 的 getFile 只能取 20 MB 以内的文件，更大的走流式服务
const BOT_DOWNLOAD_LIMIT = 20 * 1024 * 1024;
// getFile 给的下载路径保证至少 1 小时有效，留 10 分钟余量
const PATH_TTL_MS = 50 * 60 * 1000;
const LIST_TTL_MS = 20 * 1000;
const REC_TTL_MS = 60 * 1000;
// 等流式服务回响应头的时间；等不到多半是它在休眠，先让播放页过会儿再试
const STREAMER_WAIT_MS = 25 * 1000;

const MSG = {
  unavailable: 'Telegram 暂时取不到这个文件，请稍后再试',
  waking: '大文件服务正在唤醒，大约 1 分钟后再试',
  noStreamer: '这首超过 20 MB，暂时不能在网页播放',
  gone: '频道里找不到这首了',
};

const MIME_BY_EXT = {
  mp3: 'audio/mpeg', m4a: 'audio/mp4', mp4: 'audio/mp4', aac: 'audio/aac',
  flac: 'audio/flac', wav: 'audio/wav', ogg: 'audio/ogg', oga: 'audio/ogg',
  opus: 'audio/ogg', webm: 'audio/webm',
};

// 三个缓存都只活在单个 isolate 里，丢了无妨，只是省几次 getFile / Durable Object 调用
const filePaths = new Map(); // file_id -> { path, exp }
const recCache = new Map();  // 消息号 -> { rec, exp }
let listCache = null;        // { body, exp }

class HttpError extends Error {
  constructor(status, message, headers) {
    super(message);
    this.status = status;
    this.headers = headers;
  }
}

export default {
  async fetch(request, env) {
    const url = new URL(request.url);
    const path = url.pathname;
    const method = request.method;
    try {
      if (method === 'OPTIONS') {
        return new Response(null, { status: 204, headers: cors({ 'Access-Control-Max-Age': '86400' }) });
      }
      if (path === '/tg-webhook') {
        return method === 'POST' ? await webhook(request, env) : text('Method Not Allowed', 405);
      }
      if (path.startsWith('/admin/api/')) return await adminApi(request, env, url);
      if (method !== 'GET' && method !== 'HEAD') return text('Method Not Allowed', 405);
      if (path === '/') return html(PAGE, method);
      if (path === '/admin') return html(ADMIN_PAGE, method, { 'X-Robots-Tag': 'noindex' });
      if (path === '/api/tracks') return await trackList(env);
      const m = path.match(/^\/a\/(\d{1,10})(?:\.[a-z0-9]{1,5})?$/i);
      if (m) return await audio(request, env, Number(m[1]), url.searchParams.has('dl'));
      return text('Not Found', 404);
    } catch (e) {
      if (e instanceof HttpError) return text(e.message, e.status, e.headers);
      return text('服务器出错了，请稍后再试', 500);
    }
  },
};

function lib(env) {
  return env.LIB.get(env.LIB.idFromName('library'), { locationHint: 'apac' });
}

function streamerOn(env) {
  return !!(env.STREAMER_URL && env.STREAMER_KEY);
}

// ── Telegram webhook：登记频道里的音频 ──────────────────────────────

async function webhook(request, env) {
  const got = request.headers.get('X-Telegram-Bot-Api-Secret-Token') || '';
  if (!env.TG_WEBHOOK_SECRET || !sameString(got, env.TG_WEBHOOK_SECRET)) return text('Forbidden', 403);

  const update = await request.json().catch(() => null);
  const post = update && (update.channel_post || update.edited_channel_post);
  // 只收自己频道的帖子；别的群、私聊一律忽略，但仍回 200，免得 Telegram 反复重发
  if (!post || !Number.isInteger(post.message_id) || String(post.chat && post.chat.id) !== String(env.CHANNEL_ID)) {
    return text('ok');
  }
  const rec = toRecord(post);
  if (rec) await lib(env).upsertTrack(rec);
  else if (update.edited_channel_post) await lib(env).removeTrack(post.message_id); // 编辑后已不含音频
  forget(post.message_id);
  return text('ok');
}

function toRecord(post) {
  let kind, f;
  if (post.audio) { kind = 'audio'; f = post.audio; }
  else if (post.voice) { kind = 'voice'; f = post.voice; }
  else if (post.document && isAudioDocument(post.document)) { kind = 'document'; f = post.document; }
  else return null;

  const id = post.message_id;
  const name = f.file_name || '';
  const caption = (post.caption || '').trim();
  return {
    id,
    kind,
    file_id: f.file_id,
    file_unique_id: f.file_unique_id || '',
    title: f.title || stripExt(name) || caption.split('\n')[0].trim() || (kind === 'voice' ? '语音' : '未命名') + ' #' + id,
    performer: f.performer || '',
    name,
    mime: pickMime(name, f.mime_type, kind),
    size: f.file_size || 0,
    duration: f.duration || 0,
    date: post.date || 0,
    caption,
  };
}

function isAudioDocument(d) {
  const t = d.mime_type || '';
  if (t.startsWith('audio/')) return true;
  if (t.startsWith('video/') || t.startsWith('image/')) return false;
  return Object.hasOwn(MIME_BY_EXT, extOf(d.file_name));
}

function pickMime(name, telegramMime, kind) {
  // Telegram 报的类型不可靠（.m4a 也会报成 audio/mpeg），优先按扩展名
  const ext = extOf(name);
  if (Object.hasOwn(MIME_BY_EXT, ext)) return MIME_BY_EXT[ext];
  if (kind === 'voice') return 'audio/ogg';
  return telegramMime && telegramMime.startsWith('audio/') ? telegramMime : 'application/octet-stream';
}

// ── 管理接口 ─────────────────────────────────────────────────────

async function adminApi(request, env, url) {
  const auth = request.headers.get('Authorization') || '';
  const key = auth.startsWith('Bearer ') ? auth.slice(7) : '';
  if (!env.ADMIN_KEY || !sameString(key, env.ADMIN_KEY)) return json({ error: '管理密钥不对' }, 401);

  const action = url.pathname.slice('/admin/api/'.length);
  if (action === 'state' && request.method === 'GET') {
    return json({ channel: env.CHANNEL_USERNAME || '', streamer: streamerOn(env), tracks: await tracksFor(env) });
  }
  if (action === 'remove' && request.method === 'POST') {
    const body = await request.json().catch(() => ({}));
    const track = Number(body.track);
    if (!Number.isInteger(track)) return json({ error: '参数不对' }, 400);
    await lib(env).removeTrack(track);
    forget(track);
    return json({ ok: true });
  }
  return json({ error: 'Not Found' }, 404);
}

// ── 歌单 ─────────────────────────────────────────────────────────

// 大文件能不能播，取决于流式服务配没配
async function tracksFor(env) {
  const on = streamerOn(env);
  return (await lib(env).listTracks()).map(t => {
    const big = t.size > BOT_DOWNLOAD_LIMIT;
    return { ...t, big, playable: !big || on };
  });
}

async function trackList(env) {
  const now = Date.now();
  if (!listCache || listCache.exp < now) {
    listCache = { body: JSON.stringify({ channel: env.CHANNEL_USERNAME || '', tracks: await tracksFor(env) }), exp: now + LIST_TTL_MS };
  }
  return new Response(listCache.body, {
    headers: cors({ 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'public, max-age=15' }),
  });
}

async function getRec(env, id) {
  const hit = recCache.get(id);
  if (hit && hit.exp > Date.now()) return hit.rec;
  const rec = await lib(env).getTrack(id);
  if (recCache.size > 500) recCache.clear();
  recCache.set(id, { rec, exp: Date.now() + REC_TTL_MS });
  return rec;
}

function forget(id) {
  recCache.delete(id);
  listCache = null;
}

// ── 音频流 ───────────────────────────────────────────────────────

async function audio(request, env, id, download) {
  const rec = await getRec(env, id);
  if (!rec) throw new HttpError(404, '没有这首歌');
  const big = rec.size > BOT_DOWNLOAD_LIMIT;
  if (big && !streamerOn(env)) throw new HttpError(503, MSG.noStreamer);

  const headers = cors({
    'Content-Type': rec.mime,
    'Accept-Ranges': 'bytes',
    'Cache-Control': 'public, max-age=86400',
    'Content-Disposition': contentDisposition(rec, download),
  });
  if (request.method === 'HEAD') {
    if (rec.size) headers['Content-Length'] = String(rec.size);
    return new Response(null, { headers });
  }
  if (!rec.size) return await passthrough(request, env, rec, headers); // 没有登记大小的老记录：照旧透传

  const range = parseRange(request.headers.get('Range'), rec.size);
  if (!range) {
    return new Response(null, { status: 416, headers: { ...headers, 'Content-Range': `bytes */${rec.size}`, 'Cache-Control': 'no-store' } });
  }
  headers['Content-Length'] = String(range.end - range.start + 1);
  if (range.partial) headers['Content-Range'] = `bytes ${range.start}-${range.end}/${rec.size}`;
  const res = big ? await fromStreamer(env, rec, range) : await fromBotApi(env, rec, range);
  return new Response(res.body, { status: range.partial ? 206 : 200, headers });
}

// 返回 { start, end, partial }；null 表示范围没法满足（416）。认不出的格式、多段 Range 一律当作要整个文件
function parseRange(header, total) {
  const whole = { start: 0, end: total - 1, partial: false };
  const m = /^bytes=(\d*)-(\d*)$/.exec((header || '').trim());
  if (!m || (!m[1] && !m[2])) return whole;
  if (!m[1]) {
    const n = Number(m[2]);
    return n > 0 ? { start: Math.max(0, total - n), end: total - 1, partial: true } : null;
  }
  const start = Number(m[1]);
  const end = m[2] ? Math.min(Number(m[2]), total - 1) : total - 1;
  if (start >= total) return null;
  if (end < start) return whole;
  return { start, end, partial: true };
}

// 要的是整个文件就不带 Range，上游回 200；否则带上算好的 Range，上游回 206
function upstreamRange(rec, range) {
  return range.start === 0 && range.end === rec.size - 1 ? null : `bytes=${range.start}-${range.end}`;
}

function bodyMatches(res, want, range, strict) {
  const len = res.headers.get('Content-Length');
  return res.status === (want ? 206 : 200) &&
    (len === null ? !strict : Number(len) === range.end - range.start + 1);
}

async function fromBotApi(env, rec, range) {
  const want = upstreamRange(rec, range);
  const res = await fetchFile(env, rec.file_id, want);
  if (!bodyMatches(res, want, range, false)) {
    if (res.body) res.body.cancel();
    throw new HttpError(502, MSG.unavailable);
  }
  return res;
}

async function fromStreamer(env, rec, range) {
  const want = upstreamRange(rec, range);
  const headers = { 'X-Key': env.STREAMER_KEY };
  if (want) headers.Range = want;
  // 只限制等响应头的时间；拿到响应头后就不再计时，长歌可以一直传下去
  const abort = new AbortController();
  const timer = setTimeout(() => abort.abort(), STREAMER_WAIT_MS);
  let res;
  try {
    res = await fetch(`${env.STREAMER_URL.replace(/\/+$/, '')}/stream/${rec.id}`, { headers, signal: abort.signal });
  } catch {
    throw waking();
  } finally {
    clearTimeout(timer);
  }
  if (bodyMatches(res, want, range, true)) return res;
  if (res.body) res.body.cancel();
  if (res.status === 404) throw new HttpError(404, MSG.gone);
  // 5xx 或者一张网页（Hugging Face 的「正在启动」页）：服务还没醒
  if (res.status >= 500 || (res.headers.get('Content-Type') || '').includes('text/html')) throw waking();
  throw new HttpError(502, MSG.unavailable);
}

function waking() {
  return new HttpError(503, MSG.waking, { 'Retry-After': '15' });
}

async function passthrough(request, env, rec, headers) {
  const raw = (request.headers.get('Range') || '').trim();
  const res = await fetchFile(env, rec.file_id, /^bytes=(\d+-\d*|-\d+)$/.test(raw) ? raw : null);
  if (![200, 206, 416].includes(res.status)) {
    if (res.body) res.body.cancel();
    throw new HttpError(502, MSG.unavailable);
  }
  for (const h of ['Content-Length', 'Content-Range']) {
    const v = res.headers.get(h);
    if (v) headers[h] = v;
  }
  return new Response(res.body, { status: res.status, headers });
}

async function fetchFile(env, fileId, range) {
  for (let attempt = 0; ; attempt++) {
    const path = await filePath(env, fileId, attempt > 0);
    const res = await fetch(`${TG}/file/bot${env.TG_BOT_TOKEN}/${path}`, { headers: range ? { Range: range } : {} });
    // 缓存的下载路径过期会回 4xx：重新 getFile 换个新路径，再试一次
    if (attempt === 0 && [401, 403, 404].includes(res.status)) {
      if (res.body) res.body.cancel();
      continue;
    }
    return res;
  }
}

async function filePath(env, fileId, refresh) {
  const hit = filePaths.get(fileId);
  if (hit && !refresh && hit.exp > Date.now()) return hit.path;

  const r = await fetch(`${TG}/bot${env.TG_BOT_TOKEN}/getFile?file_id=${encodeURIComponent(fileId)}`);
  const j = await r.json().catch(() => null);
  if (!j || !j.ok || !j.result || !j.result.file_path) throw new HttpError(502, MSG.unavailable);
  if (filePaths.size > 500) filePaths.clear();
  filePaths.set(fileId, { path: j.result.file_path, exp: Date.now() + PATH_TTL_MS });
  return j.result.file_path;
}

function contentDisposition(rec, download) {
  const name = rec.name || rec.title + extFromMime(rec.mime);
  const fallback = 'track-' + rec.id + '.' + (extOf(name) || 'bin');
  // RFC 5987：encodeURIComponent 不转义 ' ( ) *，这里补上
  const encoded = encodeURIComponent(name).replace(/['()*]/g, c => '%' + c.charCodeAt(0).toString(16).toUpperCase());
  return `${download ? 'attachment' : 'inline'}; filename="${fallback}"; filename*=UTF-8''${encoded}`;
}

// ── 数据：Durable Object「Library」────────────────────────────────

export class Library extends DurableObject {
  constructor(ctx, env) {
    super(ctx, env);
    this.sql = ctx.storage.sql;
    ctx.blockConcurrencyWhile(async () => {
      this.sql.exec('CREATE TABLE IF NOT EXISTS songs (id INTEGER PRIMARY KEY, rec TEXT NOT NULL, updated INTEGER NOT NULL)');
      this.sql.exec('CREATE TABLE IF NOT EXISTS config (k TEXT PRIMARY KEY, v TEXT NOT NULL)');
      this.dropSplitterLeftovers();
      // 第一次启动：把更早版本存在 KV 里的歌单搬过来
      if (!this.cfg('migrated')) {
        if (env.TRACKS) await this.importKV(env.TRACKS);
        this.setCfg('migrated', '1');
      }
    });
  }

  // 试过「切片」方案的那一版把歌存在 tracks 表（多几列处理状态），还有 chats 表和仓库频道配置。
  // 换成流式后都用不上：歌搬进 songs，其余删掉。tracks 不存在时 INSERT 会报错，说明已经搬过了
  dropSplitterLeftovers() {
    try {
      this.sql.exec('INSERT OR IGNORE INTO songs (id, rec, updated) SELECT id, rec, updated FROM tracks');
      this.sql.exec('DROP TABLE tracks');
    } catch {
      // 没有旧表
    }
    this.sql.exec('DROP TABLE IF EXISTS chats');
    this.sql.exec("DELETE FROM config WHERE k IN ('storage', 'storageTitle')");
  }

  async listTracks() {
    return this.sql.exec('SELECT rec FROM songs ORDER BY id DESC').toArray().map(r => summary(JSON.parse(r.rec)));
  }

  async getTrack(id) {
    const r = this.sql.exec('SELECT rec FROM songs WHERE id = ?', id).toArray()[0];
    return r ? JSON.parse(r.rec) : null;
  }

  async upsertTrack(rec) {
    this.sql.exec(`INSERT INTO songs (id, rec, updated) VALUES (?, ?, ?)
      ON CONFLICT(id) DO UPDATE SET rec = excluded.rec, updated = excluded.updated`,
      rec.id, JSON.stringify(rec), Date.now());
  }

  async removeTrack(id) {
    this.sql.exec('DELETE FROM songs WHERE id = ?', id);
  }

  async importKV(kv) {
    let cursor = null;
    do {
      const page = await kv.list(cursor ? { prefix: 't:', cursor } : { prefix: 't:' });
      for (const k of page.keys) {
        const rec = await kv.get(k.name, 'json');
        if (rec && Number.isInteger(rec.id)) await this.upsertTrack(rec);
      }
      cursor = page.list_complete ? null : page.cursor;
    } while (cursor);
  }

  cfg(k) {
    const r = this.sql.exec('SELECT v FROM config WHERE k = ?', k).toArray()[0];
    return r ? r.v : null;
  }

  setCfg(k, v) {
    this.sql.exec('INSERT INTO config (k, v) VALUES (?, ?) ON CONFLICT(k) DO UPDATE SET v = excluded.v', k, v);
  }
}

// 歌单里的一行；file_id 只在服务端用，不给出去
function summary(rec) {
  return {
    id: rec.id, kind: rec.kind, title: rec.title, performer: rec.performer, mime: rec.mime,
    size: rec.size, duration: rec.duration, date: rec.date,
  };
}

// ── 小工具 ───────────────────────────────────────────────────────

function extOf(name) {
  const m = /\.([a-z0-9]{1,5})$/i.exec(name || '');
  return m ? m[1].toLowerCase() : '';
}

function stripExt(name) {
  return (name || '').replace(/\.[a-z0-9]{1,5}$/i, '').trim();
}

function extFromMime(mime) {
  const ext = Object.keys(MIME_BY_EXT).find(k => MIME_BY_EXT[k] === mime);
  return ext ? '.' + ext : '';
}

function sameString(a, b) {
  if (a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i++) diff |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return diff === 0;
}

function cors(extra) {
  return {
    'Access-Control-Allow-Origin': '*',
    'Access-Control-Allow-Methods': 'GET, HEAD, OPTIONS',
    'Access-Control-Allow-Headers': 'Range',
    'Access-Control-Expose-Headers': 'Content-Length, Content-Range, Accept-Ranges',
    ...extra,
  };
}

function text(body, status = 200, extra) {
  return new Response(body, {
    status,
    headers: cors({ 'Content-Type': 'text/plain; charset=utf-8', 'Cache-Control': 'no-store', ...extra }),
  });
}

// 管理接口的响应不带 CORS 头：别的网站的脚本调不动它
function json(data, status = 200) {
  return new Response(JSON.stringify(data), {
    status,
    headers: { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store' },
  });
}

function html(body, method, extra) {
  return new Response(method === 'HEAD' ? null : body, {
    headers: { 'Content-Type': 'text/html; charset=utf-8', 'Cache-Control': 'no-cache', ...extra },
  });
}

// ── 页面（客户端脚本里不用反引号和 ${，免得和外层模板字符串打架）─────────

const BASE_STYLE = `
:root{--bg:#fffaf5;--card:#fff;--text:#1c1917;--muted:#78716c;--line:#f0e6db;--accent:#ea580c;--danger:#dc2626;color-scheme:light}
@media (prefers-color-scheme:dark){:root{--bg:#171412;--card:#221d1a;--text:#f5f0eb;--muted:#a8a29e;--line:#2f2925;--accent:#fb923c;--danger:#f87171;color-scheme:dark}}
*{box-sizing:border-box}
body{margin:0;background:var(--bg);color:var(--text);font:16px/1.5 -apple-system,BlinkMacSystemFont,"PingFang SC","Hiragino Sans GB","Microsoft YaHei",sans-serif;-webkit-text-size-adjust:100%}
header,main{max-width:720px;margin:0 auto;padding:0 16px}
header{padding-top:28px;padding-bottom:8px}
h1{font-size:24px;line-height:1.3;margin:0}
.sub{margin:4px 0 0;color:var(--muted);font-size:14px}
.sub a{color:var(--accent);text-decoration:none}
[hidden]{display:none!important}
`;

const PAGE = `<!doctype html>
<html lang="zh-CN">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1, viewport-fit=cover">
<title>小橘音乐</title>
<meta name="theme-color" content="#fffaf5" media="(prefers-color-scheme: light)">
<meta name="theme-color" content="#171412" media="(prefers-color-scheme: dark)">
<link rel="icon" href="data:image/svg+xml,<svg xmlns='http://www.w3.org/2000/svg' viewBox='0 0 100 100'><text y='.9em' font-size='90'>🍊</text></svg>">
<style>${BASE_STYLE}
#status{color:var(--muted);padding:24px 0;margin:0}
#status button{margin-left:8px;font:inherit;color:var(--accent);background:none;border:1px solid currentColor;border-radius:6px;padding:2px 10px;cursor:pointer}
#list{list-style:none;margin:0;padding:0 0 150px}
.track{display:flex;align-items:center;gap:8px;border-bottom:1px solid var(--line)}
.play{flex:1;min-width:0;display:flex;align-items:center;gap:12px;padding:12px 0;background:none;border:0;color:inherit;font:inherit;text-align:left;cursor:pointer}
.play:disabled{cursor:not-allowed}
.num{width:2em;flex:none;text-align:right;color:var(--muted);font-variant-numeric:tabular-nums}
.info{min-width:0;display:flex;flex-direction:column}
.title{font-weight:600;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
.meta{font-size:13px;color:var(--muted);overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
.track.on .title,.track.on .num{color:var(--accent)}
.track.off{opacity:.55}
.links{display:flex;gap:14px;flex:none;font-size:13px}
.links a{color:var(--muted);text-decoration:none;padding:8px 0}
.links a:hover{color:var(--accent)}
#player{position:fixed;left:0;right:0;bottom:0;background:var(--card);border-top:1px solid var(--line);box-shadow:0 -4px 16px rgba(0,0,0,.06);padding:10px 16px calc(10px + env(safe-area-inset-bottom))}
#player .wrap{max-width:720px;margin:0 auto}
.now{display:flex;gap:8px;align-items:baseline;min-width:0;margin-bottom:6px}
#now-title{font-weight:600;white-space:nowrap;overflow:hidden;text-overflow:ellipsis;flex:none;max-width:70%}
#now-artist{color:var(--muted);font-size:13px;white-space:nowrap;overflow:hidden;text-overflow:ellipsis}
audio{display:block;width:100%;height:40px}
</style>
</head>
<body>
<header>
  <h1>小橘🍊音乐</h1>
  <p class="sub"><a id="tg" href="https://t.me/" target="_blank" rel="noopener">在 Telegram 打开频道</a><span id="count"></span></p>
</header>
<main>
  <p id="status">加载中…</p>
  <ol id="list"></ol>
</main>
<div id="player" hidden>
  <div class="wrap">
    <div class="now"><span id="now-title"></span><span id="now-artist"></span></div>
    <audio id="audio" controls preload="none"></audio>
  </div>
</div>
<script>
(function(){
  var list = document.getElementById('list');
  var statusEl = document.getElementById('status');
  var audio = document.getElementById('audio');
  var player = document.getElementById('player');
  var nowTitle = document.getElementById('now-title');
  var nowArtist = document.getElementById('now-artist');
  var tracks = [], curId = null, channel = '', retries = 0, retryTimer = 0;

  // 表演者字段常带着转发来源的 @频道名，展示时去掉
  function artist(p){ return (p || '').replace(/@\\w+/g, '').replace(/\\s+/g, ' ').trim(); }
  function mmss(s){ if(!s) return ''; s = Math.round(s); return Math.floor(s / 60) + ':' + String(s % 60).padStart(2, '0'); }
  function mb(b){ return b ? (b / 1048576).toFixed(1) + ' MB' : ''; }
  function el(tag, cls, txt){
    var e = document.createElement(tag);
    if(cls) e.className = cls;
    if(txt != null) e.textContent = txt;
    return e;
  }
  function indexOf(id){
    for(var i = 0; i < tracks.length; i++) if(tracks[i].id === id) return i;
    return -1;
  }
  function metaText(t){
    if(!t.playable) return '超过 20 MB，暂时不能在网页播放';
    return [artist(t.performer), mmss(t.duration), mb(t.size)].filter(Boolean).join(' · ');
  }

  function render(){
    list.textContent = '';
    tracks.forEach(function(t, i){
      var li = el('li', 'track' + (t.playable ? '' : ' off') + (t.id === curId ? ' on' : ''));
      var btn = el('button', 'play');
      btn.type = 'button';
      btn.setAttribute('aria-label', '播放 ' + t.title);
      btn.appendChild(el('span', 'num', String(i + 1)));
      var info = el('span', 'info');
      info.appendChild(el('span', 'title', t.title));
      info.appendChild(el('span', 'meta', metaText(t)));
      btn.appendChild(info);
      if(!t.playable) btn.disabled = true;
      btn.addEventListener('click', function(){ play(t.id); });
      li.appendChild(btn);
      var links = el('span', 'links');
      if(t.playable){
        var dl = el('a', null, '下载');
        dl.href = '/a/' + t.id + '?dl=1';
        links.appendChild(dl);
      }
      if(channel){
        var src = el('a', null, '原帖');
        src.href = 'https://t.me/' + channel + '/' + t.id;
        src.target = '_blank';
        src.rel = 'noopener';
        links.appendChild(src);
      }
      li.appendChild(links);
      list.appendChild(li);
    });
  }

  function select(id){
    var t = tracks[indexOf(id)];
    curId = id;
    retries = 0;
    clearTimeout(retryTimer);
    audio.src = '/a/' + id;
    nowTitle.textContent = t.title;
    nowArtist.textContent = artist(t.performer);
    player.hidden = false;
    document.title = t.title + ' · 小橘音乐';
    for(var k = 0; k < list.children.length; k++) list.children[k].classList.toggle('on', tracks[k].id === id);
    if('mediaSession' in navigator && typeof MediaMetadata !== 'undefined'){
      navigator.mediaSession.metadata = new MediaMetadata({ title: t.title, artist: artist(t.performer), album: '小橘音乐' });
    }
    history.replaceState(null, '', '#' + id);
  }

  function play(id){
    var i = indexOf(id);
    if(i < 0 || !tracks[i].playable) return;
    if(id === curId && !audio.paused){ audio.pause(); return; }
    if(id !== curId) select(id);
    var p = audio.play();
    if(p && p.catch) p.catch(function(){});
  }

  function step(dir){
    for(var j = indexOf(curId) + dir; j >= 0 && j < tracks.length; j += dir){
      if(tracks[j].playable){ play(tracks[j].id); return; }
    }
  }

  // 大文件服务休眠时第一次请求会失败（503）：提示一下，每 10 秒重试，最多等 2 分钟
  audio.addEventListener('error', function(){
    var id = curId;
    if(id === null) return;
    var pos = audio.currentTime || 0;
    fetch('/a/' + id, { headers: { Range: 'bytes=0-0' } }).then(function(r){
      if(r.body && r.body.cancel) r.body.cancel();
      if(id !== curId) return;
      if(r.status !== 503 || retries >= 12){
        nowArtist.textContent = '这首暂时播放不了，稍后再试';
        return;
      }
      retries++;
      nowArtist.textContent = '大文件服务正在唤醒，请稍等…';
      retryTimer = setTimeout(function(){
        if(id !== curId) return;
        audio.src = '/a/' + id;
        if(pos) audio.addEventListener('loadedmetadata', function(){ audio.currentTime = pos; }, { once: true });
        var p = audio.play();
        if(p && p.catch) p.catch(function(){});
      }, 10000);
    }).catch(function(){
      if(id === curId) nowArtist.textContent = '网络不太好，稍后再试';
    });
  });
  audio.addEventListener('playing', function(){
    var i = indexOf(curId);
    if(i >= 0) nowArtist.textContent = artist(tracks[i].performer);
  });
  audio.addEventListener('ended', function(){ step(1); });
  if('mediaSession' in navigator){
    try {
      navigator.mediaSession.setActionHandler('previoustrack', function(){ step(-1); });
      navigator.mediaSession.setActionHandler('nexttrack', function(){ step(1); });
    } catch(e){}
  }

  function load(){
    statusEl.hidden = false;
    statusEl.textContent = '加载中…';
    fetch('/api/tracks').then(function(r){
      if(!r.ok) throw new Error(String(r.status));
      return r.json();
    }).then(function(d){
      tracks = d.tracks || [];
      channel = d.channel || '';
      if(channel) document.getElementById('tg').href = 'https://t.me/' + channel;
      document.getElementById('count').textContent = tracks.length ? ' · ' + tracks.length + ' 首' : '';
      if(!tracks.length){ statusEl.textContent = '频道里还没有音频'; return; }
      statusEl.hidden = true;
      render();
      // 分享链接 /#消息号：选中那首（浏览器不允许自动出声，需要再点一下播放）
      var i = indexOf(Number(location.hash.slice(1)));
      if(i >= 0 && tracks[i].playable){
        select(tracks[i].id);
        list.children[i].scrollIntoView({ block: 'center' });
      }
    }).catch(function(){
      statusEl.textContent = '歌单加载失败';
      var retry = el('button', null, '重试');
      retry.type = 'button';
      retry.addEventListener('click', load);
      statusEl.appendChild(retry);
    });
  }

  load();
})();
</script>
</body>
</html>
`;

const ADMIN_PAGE = `<!doctype html>
<html lang="zh-CN">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1, viewport-fit=cover">
<meta name="robots" content="noindex">
<title>小橘音乐管理</title>
<link rel="icon" href="data:image/svg+xml,<svg xmlns='http://www.w3.org/2000/svg' viewBox='0 0 100 100'><text y='.9em' font-size='90'>🍊</text></svg>">
<style>${BASE_STYLE}
main{padding-bottom:48px}
h2{font-size:18px;margin:28px 0 4px}
.hint{color:var(--muted);font-size:14px;margin:0 0 8px}
.card{background:var(--card);border:1px solid var(--line);border-radius:12px;padding:12px 16px;margin-top:16px}
.card p{margin:6px 0}
.err{color:var(--danger);font-size:14px}
.rows{list-style:none;margin:0;padding:0}
.row{display:flex;align-items:center;gap:12px;padding:10px 0;border-bottom:1px solid var(--line)}
.row .info{flex:1;min-width:0}
.row .title{font-weight:600;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
.row .meta{font-size:13px;color:var(--muted)}
.empty{color:var(--muted);padding:10px 0}
button{font:inherit;font-size:14px;color:var(--accent);background:none;border:1px solid currentColor;border-radius:8px;padding:6px 12px;cursor:pointer;flex:none}
button.danger{color:var(--danger)}
button.link{border:0;padding:0;color:var(--muted);text-decoration:underline}
#login{margin-top:24px;display:flex;flex-wrap:wrap;gap:8px;align-items:center}
#login p{width:100%;margin:0}
#key{flex:1;min-width:0;font:inherit;padding:8px 10px;border:1px solid var(--line);border-radius:8px;background:var(--card);color:var(--text)}
</style>
</head>
<body>
<header>
  <h1>小橘🍊音乐 · 管理</h1>
  <p class="sub"><a href="/">返回播放页</a></p>
</header>
<main>
  <form id="login" hidden>
    <p>输入管理密钥：</p>
    <input id="key" type="password" autocomplete="current-password" required>
    <button type="submit">进入</button>
    <p id="login-err" class="err"></p>
  </form>
  <div id="app" hidden>
    <section class="card"><p id="streamer"></p></section>
    <h2>全部歌曲</h2>
    <p class="hint">频道里删掉的帖子不会自动从网页消失，在这里移除（不会动 Telegram 里的帖子）。</p>
    <ul id="all" class="rows"></ul>
    <p><button type="button" id="logout" class="link">退出管理</button></p>
  </div>
</main>
<script>
(function(){
  var KEY_STORE = 'xm-admin-key';
  var key = '';
  try { key = localStorage.getItem(KEY_STORE) || ''; } catch(e){}

  function $(id){ return document.getElementById(id); }
  function el(tag, cls, txt){
    var e = document.createElement(tag);
    if(cls) e.className = cls;
    if(txt != null) e.textContent = txt;
    return e;
  }
  function mb(b){ return (b / 1048576).toFixed(1) + ' MB'; }

  function api(path, body){
    var opts = { headers: { Authorization: 'Bearer ' + key } };
    if(body){
      opts.method = 'POST';
      opts.headers['Content-Type'] = 'application/json';
      opts.body = JSON.stringify(body);
    }
    return fetch('/admin/api/' + path, opts).then(function(r){
      return r.json().catch(function(){ return {}; }).then(function(d){
        if(!r.ok){ var e = new Error(d.error || ('HTTP ' + r.status)); e.status = r.status; throw e; }
        return d;
      });
    });
  }

  function showLogin(msg){
    $('app').hidden = true;
    $('login').hidden = false;
    $('login-err').textContent = msg || '';
  }

  function refresh(){
    return api('state').then(function(s){
      $('login').hidden = true;
      $('app').hidden = false;
      $('streamer').textContent = s.streamer
        ? '大文件服务：已开启，超过 20 MB 的歌也能播放'
        : '大文件服务：未开启，超过 20 MB 的歌暂时不能播放';
      render(s.tracks);
    }).catch(function(e){
      if(e.status === 401){
        key = '';
        try { localStorage.removeItem(KEY_STORE); } catch(e2){}
        showLogin('管理密钥不对');
      } else {
        showLogin('加载失败：' + e.message);
      }
    });
  }

  function render(tracks){
    var ul = $('all');
    ul.textContent = '';
    if(!tracks.length){ ul.appendChild(el('li', 'empty', '歌单是空的')); return; }
    tracks.forEach(function(t){
      var li = el('li', 'row');
      var info = el('div', 'info');
      info.appendChild(el('div', 'title', '#' + t.id + ' ' + t.title));
      info.appendChild(el('div', 'meta', mb(t.size) + (t.big ? ' · 大文件' : '')));
      li.appendChild(info);
      var rm = el('button', 'danger', '移除');
      rm.type = 'button';
      rm.addEventListener('click', function(){
        if(!confirm('从网页歌单移除「' + t.title + '」？\\n不会删除 Telegram 里的帖子。')) return;
        api('remove', { track: t.id }).then(refresh).catch(function(e){ alert('出错了：' + e.message); });
      });
      li.appendChild(rm);
      ul.appendChild(li);
    });
  }

  $('login').addEventListener('submit', function(e){
    e.preventDefault();
    key = $('key').value.trim();
    try { localStorage.setItem(KEY_STORE, key); } catch(e2){}
    refresh();
  });
  $('logout').addEventListener('click', function(){
    key = '';
    try { localStorage.removeItem(KEY_STORE); } catch(e){}
    showLogin('');
  });

  if(key) refresh(); else showLogin('');
})();
</script>
</body>
</html>
`;
