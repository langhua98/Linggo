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
//   GET  /                 播放页（page.html）
//   GET  /api/tracks       歌单 JSON（新的在前）
//   GET  /a/<消息号>        音频流，支持 Range（iOS Safari 开始播放、拖进度条都要 206）；?dl=1 变成下载
//   GET  /c/<消息号>        专辑封面（音乐文件自带的缩略图），取一次就存进数据库
//   POST /tg-webhook       Telegram 推送频道新帖，音频自动登记
//   GET  /admin            管理页（admin.html，管理密钥登录）：把频道里已删掉的帖子从歌单移除
//   *    /admin/api/...    管理接口（Authorization: Bearer <ADMIN_KEY>）
//
// 数据在 Durable Object「Library」的 SQLite 里：强一致，也没有 KV list 每天 1000 次的限制。
//
// 绑定：LIB（Durable Object）、TRACKS（旧 KV，只在第一次启动时迁移数据用）、
//       TG_BOT_TOKEN / TG_WEBHOOK_SECRET / ADMIN_KEY / STREAMER_KEY（secret）、
//       CHANNEL_ID / CHANNEL_USERNAME / STREAMER_URL（普通变量；STREAMER_URL 为空则大文件不能播放）

import { DurableObject } from 'cloudflare:workers';
import PAGE from './page.html';
import ADMIN_PAGE from './admin.html';

const TG = 'https://api.telegram.org';
// 官方 Bot API 的 getFile 只能取 20 MB 以内的文件，更大的走流式服务
const BOT_DOWNLOAD_LIMIT = 20 * 1024 * 1024;
// getFile 给的下载路径保证至少 1 小时有效，留 10 分钟余量
const PATH_TTL_MS = 50 * 60 * 1000;
const LIST_TTL_MS = 20 * 1000;
const REC_TTL_MS = 60 * 1000;
// 等流式服务回响应头的时间；等不到多半是它在休眠，先让播放页过会儿再试
const STREAMER_WAIT_MS = 25 * 1000;
// Telegram 给音乐文件生成的缩略图一般 20 KB 上下，超过这个大小就不当封面存
const COVER_LIMIT = 512 * 1024;

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
      const c = path.match(/^\/c\/(\d{1,10})$/);
      if (c) return await cover(env, Number(c[1]));
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

function streamerBase(env) {
  return env.STREAMER_URL.replace(/\/+$/, '');
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
    // 音乐文件自带的专辑封面；空字符串表示确定没有（更早登记的歌没有这个字段，封面要靠流式服务去取）
    thumb: (f.thumbnail || f.thumb || {}).file_id || '',
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

// ── 封面 ─────────────────────────────────────────────────────────

// 先看数据库里存没存；没有就去取一次（新歌用 Bot API 取缩略图，更早的歌请流式服务用 MTProto 取），
// 取到了（或确定没有）就存起来，以后不再惊动 Telegram 和流式服务
async function cover(env, id) {
  const L = lib(env);
  let c = await L.getCover(id);
  if (!c) {
    const rec = await getRec(env, id);
    if (!rec) throw new HttpError(404, '没有这首歌');
    const got = await fetchCover(env, rec);
    if (!got) throw new HttpError(503, '封面暂时取不到', { 'Retry-After': '60' });
    c = got === 'none' ? { none: true } : { mime: got.mime, b64: toBase64(got.data) };
    await L.putCover(id, c.none ? 'none' : c.mime, c.none ? '' : c.b64);
  }
  if (c.none) throw new HttpError(404, '这首没有封面', { 'Cache-Control': 'public, max-age=86400' });
  return new Response(fromBase64(c.b64), {
    headers: cors({ 'Content-Type': c.mime, 'Cache-Control': 'public, max-age=604800' }),
  });
}

// 返回 { mime, data }；'none' 表示确定没有封面；null 表示这次没取到（别存，下次再试）
async function fetchCover(env, rec) {
  if (rec.kind === 'voice' || rec.thumb === '') return 'none';
  try {
    if (rec.thumb) {
      const res = await fetchFile(env, rec.thumb, null);
      return await imageFrom(res, 'image/jpeg');
    }
    if (!streamerOn(env)) return null;
    const res = await fetch(`${streamerBase(env)}/thumb/${rec.id}`, {
      headers: { 'X-Key': env.STREAMER_KEY },
      signal: AbortSignal.timeout(STREAMER_WAIT_MS),
    });
    // 流式服务自己的 404 是 JSON；Hugging Face 的错误页是网页，不能当成「没有封面」
    if (res.status === 404 && (res.headers.get('Content-Type') || '').includes('json')) {
      if (res.body) await res.body.cancel();
      return 'none';
    }
    return await imageFrom(res, null);
  } catch {
    return null;
  }
}

async function imageFrom(res, fallbackMime) {
  const type = (res.headers.get('Content-Type') || '').split(';')[0].trim();
  const mime = type.startsWith('image/') ? type : fallbackMime;
  if (!res.ok || !mime) {
    if (res.body) await res.body.cancel();
    return null;
  }
  const data = new Uint8Array(await res.arrayBuffer());
  return data.length && data.length <= COVER_LIMIT ? { mime, data } : null;
}

function toBase64(bytes) {
  let s = '';
  for (let i = 0; i < bytes.length; i += 0x8000) s += String.fromCharCode.apply(null, bytes.subarray(i, i + 0x8000));
  return btoa(s);
}

function fromBase64(b64) {
  const s = atob(b64);
  const out = new Uint8Array(s.length);
  for (let i = 0; i < s.length; i++) out[i] = s.charCodeAt(i);
  return out;
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
    res = await fetch(`${streamerBase(env)}/stream/${rec.id}`, { headers, signal: abort.signal });
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
      // 封面存成 base64 文本（一张二三十 KB）；mime 为 'none' 表示确定没有封面
      this.sql.exec('CREATE TABLE IF NOT EXISTS covers (id INTEGER PRIMARY KEY, mime TEXT NOT NULL, data TEXT NOT NULL)');
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
    const old = await this.getTrack(rec.id);
    // 帖子里换了文件，旧封面就作废
    if (!old || old.file_unique_id !== rec.file_unique_id) this.sql.exec('DELETE FROM covers WHERE id = ?', rec.id);
    this.sql.exec(`INSERT INTO songs (id, rec, updated) VALUES (?, ?, ?)
      ON CONFLICT(id) DO UPDATE SET rec = excluded.rec, updated = excluded.updated`,
      rec.id, JSON.stringify(rec), Date.now());
  }

  async removeTrack(id) {
    this.sql.exec('DELETE FROM songs WHERE id = ?', id);
    this.sql.exec('DELETE FROM covers WHERE id = ?', id);
  }

  async getCover(id) {
    const r = this.sql.exec('SELECT mime, data FROM covers WHERE id = ?', id).toArray()[0];
    if (!r) return null;
    return r.mime === 'none' ? { none: true } : { mime: r.mime, b64: r.data };
  }

  async putCover(id, mime, data) {
    this.sql.exec(`INSERT INTO covers (id, mime, data) VALUES (?, ?, ?)
      ON CONFLICT(id) DO UPDATE SET mime = excluded.mime, data = excluded.data`, id, mime, data);
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

// 歌单里的一行；file_id 只在服务端用，不给出去。
// 这个频道的歌多是从别的频道转来的：表演者一栏常混着转发来源的广告（「更多音乐 @某频道」），
// 标题又常写成「歌手 - 歌名」，这里理成干净的歌名和歌手
function summary(rec) {
  let title = rec.title || '';
  let artist = (rec.performer || '').replace(/@\w+/g, '').replace(/更多音乐/g, '').replace(/\s+/g, ' ').trim();
  const m = !artist && /^(.+?)\s+-\s+(.+)$/.exec(title);
  if (m) {
    artist = m[1].trim();
    title = m[2].trim();
  }
  return {
    id: rec.id, kind: rec.kind, title, artist, mime: rec.mime,
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
