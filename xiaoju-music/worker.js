// 小橘音乐 · Telegram 频道音频中转（Cloudflare Worker）
//
// 音频文件存在 Telegram 频道里，但网页没法直接播放 Telegram 的音乐文件。这个 Worker 在服务端
// 持有机器人 token，把「频道消息号」换成浏览器能直接播放的地址。
//
// 超过 20 MB 的文件：官方 Bot API 的 getFile 只能取 20 MB 以内的文件，所以大文件会被切成每片
// 19 MB 的「分片」存进一个私有「仓库频道」；播放时按 Range 把分片拼回原文件，浏览器拿到的和原
// 文件逐字节相同，拖进度条照常可用。分片有两个来源：
//   1. 自动：频道里一出现大文件，就派给 Hugging Face 上的切片服务（splitter/）。它用 MTProto
//      （机器人走 MTProto 能下 2 GB）下载原文件、切片、上传到仓库频道，再回调登记；
//   2. 手动：管理页 /admin 里选本地的同一个文件，浏览器切片后逐片上传。
//
//   GET  /                 播放页
//   GET  /api/tracks       歌单 JSON（新的在前）
//   GET  /a/<消息号>        音频流，按 Range 取/拼分片（iOS Safari 开始播放、拖进度条都要 206）；?dl=1 变成下载
//   POST /tg-webhook       Telegram 推送：频道新帖登记；机器人进了别的频道就记下来，供选作仓库
//   GET  /admin            管理页（管理密钥登录）
//   *    /admin/api/...    管理接口（Authorization: Bearer <ADMIN_KEY>），切片服务也用它回调
//
// 数据在 Durable Object「Library」的 SQLite 里：强一致，也没有 KV list 每天 1000 次的限制。
//
// 绑定：LIB（Durable Object）、TRACKS（旧 KV，只在第一次启动时迁移数据用）、
//       TG_BOT_TOKEN / TG_WEBHOOK_SECRET / ADMIN_KEY / SPLITTER_KEY（secret）、
//       CHANNEL_ID / CHANNEL_USERNAME / BOT_USERNAME / SPLITTER_URL（普通变量；
//       SPLITTER_URL 或 SPLITTER_KEY 为空就不自动切片，只能在管理页手动上传）

import { DurableObject } from 'cloudflare:workers';

const TG = 'https://api.telegram.org';
// 官方 Bot API 的 getFile 只能取 20 MB 以内的文件
const BOT_DOWNLOAD_LIMIT = 20 * 1024 * 1024;
// 分片大小：离 20 MB 上限留余量（上限不管按 20 MiB 还是 20,000,000 字节算都安全）
const PART_SIZE = 19 * 1024 * 1024;
// 一次响应最多拼几片。每片最多两个子请求（getFile + 下载），免费版每次请求最多 50 个子请求
const MAX_PARTS_PER_RESPONSE = 16;
const SUBREQUEST_BUDGET = 45;
// getFile 给的下载路径保证至少 1 小时有效，留 10 分钟余量
const PATH_TTL_MS = 50 * 60 * 1000;
const LIST_TTL_MS = 20 * 1000;
const REC_TTL_MS = 60 * 1000;
// 自动切片：同一首最多派 5 次；排队或处理中超过 30 分钟没有进展，就当作卡住了重新派
const MAX_ATTEMPTS = 5;
const STALE_MS = 30 * 60 * 1000;
const WAITING = ['pending', 'queued', 'processing'];

const MSG = {
  unavailable: 'Telegram 暂时取不到这个文件，请稍后再试',
  processing: '这首超过 20 MB，正在切片处理，稍后再试',
  unplayable: '这首超过 20 MB，还没有可以播放的分片',
  tooBigDownload: '文件太大，请到 Telegram 原帖下载',
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
  constructor(status, message) {
    super(message);
    this.status = status;
  }
}

export default {
  async fetch(request, env, ctx) {
    const url = new URL(request.url);
    const path = url.pathname;
    const method = request.method;
    try {
      if (method === 'OPTIONS') {
        return new Response(null, { status: 204, headers: cors({ 'Access-Control-Max-Age': '86400' }) });
      }
      if (path === '/tg-webhook') {
        return method === 'POST' ? await webhook(request, env, ctx) : text('Method Not Allowed', 405);
      }
      if (path.startsWith('/admin/api/')) return await adminApi(request, env, ctx, url);
      if (method !== 'GET' && method !== 'HEAD') return text('Method Not Allowed', 405);
      if (path === '/') return html(PAGE, method);
      if (path === '/admin') return html(ADMIN_PAGE, method, { 'X-Robots-Tag': 'noindex' });
      if (path === '/api/tracks') return await trackList(env);
      const m = path.match(/^\/a\/(\d{1,10})(?:\.[a-z0-9]{1,5})?$/i);
      if (m) return await audio(request, env, ctx, Number(m[1]), url.searchParams.has('dl'));
      return text('Not Found', 404);
    } catch (e) {
      if (e instanceof HttpError) return text(e.message, e.status);
      return text('服务器出错了，请稍后再试', 500);
    }
  },

  // 定时任务：把还没派出去、失败待重试、卡住的大文件重新派给切片服务
  async scheduled(event, env) {
    await dispatch(env, await lib(env).claim(Date.now()));
  },
};

function lib(env) {
  return env.LIB.get(env.LIB.idFromName('library'), { locationHint: 'apac' });
}

// ── Telegram webhook ─────────────────────────────────────────────

async function webhook(request, env, ctx) {
  const got = request.headers.get('X-Telegram-Bot-Api-Secret-Token') || '';
  if (!env.TG_WEBHOOK_SECRET || !sameString(got, env.TG_WEBHOOK_SECRET)) return text('Forbidden', 403);

  const update = await request.json().catch(() => null);
  if (!update) return text('ok');
  const L = lib(env);

  // 机器人被加进（或移出）别的频道：记下来，管理页可以把它选作「仓库频道」
  const member = update.my_chat_member;
  if (member) {
    const chat = member.chat;
    if (chat && chat.type === 'channel' && String(chat.id) !== String(env.CHANNEL_ID)) {
      await L.noteChat(String(chat.id), chat.title || '', (member.new_chat_member && member.new_chat_member.status) || '');
    }
    return text('ok');
  }

  const post = update.channel_post || update.edited_channel_post;
  if (!post || !post.chat || !Number.isInteger(post.message_id)) return text('ok');
  if (String(post.chat.id) !== String(env.CHANNEL_ID)) {
    // 别的频道里的帖子：不登记，只记下这个频道（机器人能收到频道帖子，说明它是那里的管理员）
    if (post.chat.type === 'channel') await L.noteChat(String(post.chat.id), post.chat.title || '', 'administrator');
    return text('ok');
  }

  const rec = toRecord(post);
  if (rec) {
    const { needsParts } = await L.upsertTrack(rec);
    if (needsParts) ctx.waitUntil(dispatch(env, [jobFor(rec)]));
  } else if (update.edited_channel_post) {
    await L.removeTrack(post.message_id); // 编辑后已不含音频
  }
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

function needsParts(rec) {
  return rec.size > BOT_DOWNLOAD_LIMIT && !(rec.parts && rec.parts.length);
}

function jobFor(rec) {
  return { track: rec.id, size: rec.size, file_unique_id: rec.file_unique_id || '' };
}

// ── 自动切片：派活给 Hugging Face 上的切片服务 ──────────────────────

// 服务睡着时第一次派活会失败（Hugging Face 唤醒要一两分钟），定时任务会接着派
async function dispatch(env, jobs) {
  if (!jobs.length || !env.SPLITTER_URL || !env.SPLITTER_KEY) return;
  const L = lib(env);
  const { storage } = await L.getConfig();
  if (!storage) return;
  for (const job of jobs) {
    let ok = false;
    let note = '';
    try {
      const res = await fetch(env.SPLITTER_URL.replace(/\/+$/, '') + '/split', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'X-Key': env.SPLITTER_KEY },
        body: JSON.stringify({ ...job, channel: env.CHANNEL_USERNAME, storage, part_size: PART_SIZE }),
        signal: AbortSignal.timeout(20000),
      });
      ok = res.ok;
      note = ok ? '' : '切片服务返回 ' + res.status + '，稍后自动重试';
      if (res.body) await res.body.cancel();
    } catch {
      note = '切片服务暂时没响应（可能在休眠），稍后自动重试';
    }
    await L.kicked(job.track, ok, note);
    forget(job.track);
  }
}

// ── 管理接口 ─────────────────────────────────────────────────────

async function adminApi(request, env, ctx, url) {
  const auth = request.headers.get('Authorization') || '';
  const key = auth.startsWith('Bearer ') ? auth.slice(7) : '';
  if (!env.ADMIN_KEY || !sameString(key, env.ADMIN_KEY)) return json({ error: '管理密钥不对' }, 401);

  const L = lib(env);
  const action = url.pathname.slice('/admin/api/'.length);
  try {
    if (action === 'state' && request.method === 'GET') {
      const [config, tracks, chats] = await Promise.all([L.getConfig(), L.listTracks(true), L.listChats()]);
      return json({
        channel: env.CHANNEL_USERNAME || '',
        bot: env.BOT_USERNAME || '',
        storage: config.storage ? { id: config.storage, title: config.storageTitle } : null,
        chats: chats.filter(c => c.id !== String(env.CHANNEL_ID) && c.id !== config.storage),
        splitter: !!(env.SPLITTER_URL && env.SPLITTER_KEY),
        partSize: PART_SIZE,
        limit: BOT_DOWNLOAD_LIMIT,
        tracks,
      });
    }
    if (request.method !== 'POST') return json({ error: 'Method Not Allowed' }, 405);
    if (action === 'part') return json(await uploadPart(request, env, L, url));

    const body = await request.json().catch(() => ({}));
    const track = Number(body.track);
    if (['commit', 'status', 'retry', 'remove'].includes(action) && !Number.isInteger(track)) {
      return json({ error: '参数不对' }, 400);
    }
    let result;
    switch (action) {
      case 'commit':
        result = await L.commitParts(track, body.size, body.parts, !!body.force, String(body.mime || ''));
        break;
      case 'status':
        await L.setTrackStatus(track, String(body.status || ''), String(body.note || ''));
        result = { ok: true };
        break;
      case 'retry': {
        const job = await L.retryTrack(track);
        if (job) ctx.waitUntil(dispatch(env, [job]));
        result = job ? { ok: true } : { error: '这首不需要处理' };
        break;
      }
      case 'remove':
        await L.removeTrack(track);
        result = { ok: true };
        break;
      case 'storage':
        result = await L.setStorage(String(body.id || ''));
        break;
      default:
        return json({ error: 'Not Found' }, 404);
    }
    forget(track);
    return json(result, result.error ? 400 : 200);
  } catch (e) {
    if (e instanceof HttpError) return json({ error: e.message, retryAfter: e.retryAfter }, e.status);
    return json({ error: '服务器出错了' }, 500);
  }
}

// 管理页手动上传的一片：请求体原样流进 multipart 发到仓库频道，Worker 里不整块缓冲 19 MB
async function uploadPart(request, env, L, url) {
  const { storage } = await L.getConfig();
  if (!storage) throw new HttpError(409, '还没有设置仓库频道');
  const track = intParam(url, 'track');
  const index = intParam(url, 'index');
  const count = intParam(url, 'count');
  if (track === null || index === null || count === null || count < 1 || count > 500 || index >= count) {
    throw new HttpError(400, '参数不对');
  }
  const length = Number(request.headers.get('Content-Length'));
  if (!request.body || !Number.isInteger(length) || length <= 0 || length > PART_SIZE) {
    throw new HttpError(413, '每片必须在 1 字节到 19 MB 之间');
  }
  const doc = await sendDocument(env, storage, `t${track}-p${index + 1}of${count}.bin`, `#t${track} ${index + 1}/${count}`, request.body, length);
  if (doc.file_size !== length) throw new HttpError(502, '上传后的大小不对，请重试');
  return { file_id: doc.file_id, size: doc.file_size };
}

async function sendDocument(env, chatId, filename, caption, body, length) {
  const boundary = 'xm' + crypto.randomUUID().replace(/-/g, '');
  const field = (name, value) => `--${boundary}\r\nContent-Disposition: form-data; name="${name}"\r\n\r\n${value}\r\n`;
  const enc = new TextEncoder();
  const head = enc.encode(
    field('chat_id', chatId) + field('caption', caption) +
    field('disable_notification', 'true') + field('disable_content_type_detection', 'true') +
    `--${boundary}\r\nContent-Disposition: form-data; name="document"; filename="${filename}"\r\n` +
    'Content-Type: application/octet-stream\r\n\r\n');
  const tail = enc.encode(`\r\n--${boundary}--\r\n`);
  const { readable, writable } = fixedLengthStream(head.length + length + tail.length);
  const pump = (async () => {
    const w = writable.getWriter();
    await w.write(head);
    w.releaseLock();
    await body.pipeTo(writable, { preventClose: true });
    const w2 = writable.getWriter();
    await w2.write(tail);
    await w2.close();
  })();
  const [res] = await Promise.all([
    fetch(`${TG}/bot${env.TG_BOT_TOKEN}/sendDocument`, {
      method: 'POST',
      headers: { 'Content-Type': `multipart/form-data; boundary=${boundary}` },
      body: readable,
      duplex: 'half',
    }),
    pump,
  ]);
  const j = await res.json().catch(() => null);
  if (j && j.ok && j.result && j.result.document) return j.result.document;
  const err = new HttpError(res.status === 429 ? 429 : 502, '上传到 Telegram 失败：' + ((j && j.description) || res.status));
  err.retryAfter = j && j.parameters && j.parameters.retry_after;
  throw err;
}

// ── 歌单 ─────────────────────────────────────────────────────────

async function trackList(env) {
  const now = Date.now();
  if (!listCache || listCache.exp < now) {
    const tracks = await lib(env).listTracks(false);
    listCache = { body: JSON.stringify({ channel: env.CHANNEL_USERNAME || '', tracks }), exp: now + LIST_TTL_MS };
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

async function audio(request, env, ctx, id, download) {
  const rec = await getRec(env, id);
  if (!rec) throw new HttpError(404, '没有这首歌');
  if (rec.status !== 'ok') {
    throw new HttpError(503, WAITING.includes(rec.status) ? MSG.processing : MSG.unplayable);
  }

  const pieces = piecesOf(rec);
  const total = pieces.reduce((n, p) => n + p.size, 0);
  const headers = cors({
    'Content-Type': rec.mime,
    'Accept-Ranges': 'bytes',
    'Cache-Control': 'public, max-age=86400',
    'Content-Disposition': contentDisposition(rec, download),
  });
  if (request.method === 'HEAD') {
    if (total) headers['Content-Length'] = String(total);
    return new Response(null, { headers });
  }
  if (!total) return await passthrough(request, env, rec, headers); // 没有登记大小的老记录：照旧透传

  const range = parseRange(request.headers.get('Range'), total);
  if (!range) {
    return new Response(null, { status: 416, headers: { ...headers, 'Content-Range': `bytes */${total}`, 'Cache-Control': 'no-store' } });
  }
  let segs = segments(pieces, range.start, range.end);
  if (segs.length > MAX_PARTS_PER_RESPONSE) {
    // 范围太长：只给前 16 片（206 允许少给，浏览器会接着要后面的）；整个文件的下载没法少给
    if (!range.partial) throw new HttpError(413, MSG.tooBigDownload);
    segs = segs.slice(0, MAX_PARTS_PER_RESPONSE);
    const last = segs[segs.length - 1];
    range.end = last.offset + last.to;
  }

  const length = range.end - range.start + 1;
  headers['Content-Length'] = String(length);
  if (range.partial) headers['Content-Range'] = `bytes ${range.start}-${range.end}/${total}`;
  const status = range.partial ? 206 : 200;
  const budget = { left: SUBREQUEST_BUDGET };
  const first = await openSegment(env, segs[0], budget);
  if (segs.length === 1) return new Response(first.body, { status, headers });
  return new Response(concat(env, ctx, first, segs.slice(1), length, budget), { status, headers });
}

// 把一首歌看成若干「片」首尾相接：没切过的就是它自己这一个文件
function piecesOf(rec) {
  const list = rec.parts && rec.parts.length ? rec.parts : [{ file_id: rec.file_id, size: rec.size }];
  let offset = 0;
  return list.map(p => {
    const piece = { file_id: p.file_id, size: p.size, offset };
    offset += p.size;
    return piece;
  });
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

// [start, end] 落在哪几片上；from/to 是片内的字节位置
function segments(pieces, start, end) {
  const out = [];
  for (const p of pieces) {
    const last = p.offset + p.size - 1;
    if (last < start) continue;
    if (p.offset > end) break;
    out.push({ file_id: p.file_id, size: p.size, offset: p.offset, from: Math.max(start, p.offset) - p.offset, to: Math.min(end, last) - p.offset });
  }
  return out;
}

async function openSegment(env, seg, budget) {
  const whole = seg.from === 0 && seg.to === seg.size - 1;
  const res = await fetchFile(env, seg.file_id, whole ? null : `bytes=${seg.from}-${seg.to}`, budget);
  const len = res.headers.get('Content-Length');
  const ok = res.status === (whole ? 200 : 206) && (len === null || Number(len) === seg.to - seg.from + 1);
  if (!ok) {
    if (res.body) res.body.cancel();
    throw new HttpError(502, MSG.unavailable);
  }
  return res;
}

// 多片按顺序接进同一个定长流；下一片要等上一片被读完才去取，不会一口气把整首拉下来
function concat(env, ctx, first, rest, length, budget) {
  const { readable, writable } = fixedLengthStream(length);
  ctx.waitUntil((async () => {
    try {
      await first.body.pipeTo(writable, { preventClose: true });
      for (const seg of rest) {
        const res = await openSegment(env, seg, budget);
        await res.body.pipeTo(writable, { preventClose: true });
      }
      await writable.close();
    } catch (e) {
      await writable.abort(e).catch(() => {});
    }
  })());
  return readable;
}

async function passthrough(request, env, rec, headers) {
  const raw = (request.headers.get('Range') || '').trim();
  const res = await fetchFile(env, rec.file_id, /^bytes=(\d+-\d*|-\d+)$/.test(raw) ? raw : null, { left: SUBREQUEST_BUDGET });
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

async function fetchFile(env, fileId, range, budget) {
  for (let attempt = 0; ; attempt++) {
    const path = await filePath(env, fileId, attempt > 0, budget);
    spend(budget);
    const res = await fetch(`${TG}/file/bot${env.TG_BOT_TOKEN}/${path}`, { headers: range ? { Range: range } : {} });
    // 缓存的下载路径过期会回 4xx：重新 getFile 换个新路径，再试一次
    if (attempt === 0 && [401, 403, 404].includes(res.status) && budget.left >= 2) {
      if (res.body) res.body.cancel();
      continue;
    }
    return res;
  }
}

async function filePath(env, fileId, refresh, budget) {
  const hit = filePaths.get(fileId);
  if (hit && !refresh && hit.exp > Date.now()) return hit.path;

  spend(budget);
  const r = await fetch(`${TG}/bot${env.TG_BOT_TOKEN}/getFile?file_id=${encodeURIComponent(fileId)}`);
  const j = await r.json().catch(() => null);
  if (!j || !j.ok || !j.result || !j.result.file_path) {
    const tooBig = /too big/i.test((j && j.description) || '');
    throw new HttpError(tooBig ? 413 : 502, tooBig ? MSG.unplayable : MSG.unavailable);
  }
  if (filePaths.size > 500) filePaths.clear();
  filePaths.set(fileId, { path: j.result.file_path, exp: Date.now() + PATH_TTL_MS });
  return j.result.file_path;
}

function spend(budget) {
  if (budget.left-- <= 0) throw new HttpError(502, MSG.unavailable);
}

function fixedLengthStream(length) {
  // FixedLengthStream 是 Workers 特有的：让流式响应带上 Content-Length；本地测试里退回普通流
  return typeof FixedLengthStream === 'function' ? new FixedLengthStream(length) : new TransformStream();
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
      this.sql.exec(`CREATE TABLE IF NOT EXISTS tracks (
        id INTEGER PRIMARY KEY, rec TEXT NOT NULL, status TEXT NOT NULL,
        note TEXT NOT NULL DEFAULT '', attempts INTEGER NOT NULL DEFAULT 0, updated INTEGER NOT NULL DEFAULT 0)`);
      this.sql.exec('CREATE TABLE IF NOT EXISTS chats (id TEXT PRIMARY KEY, title TEXT NOT NULL, status TEXT NOT NULL, updated INTEGER NOT NULL)');
      this.sql.exec('CREATE TABLE IF NOT EXISTS config (k TEXT PRIMARY KEY, v TEXT NOT NULL)');
      // 第一次启动：把旧版存在 KV 里的歌单搬过来
      if (!this.cfg('migrated')) {
        if (env.TRACKS) await this.importKV(env.TRACKS);
        this.setCfg('migrated', '1');
      }
    });
  }

  async listTracks(admin) {
    return this.sql.exec('SELECT * FROM tracks ORDER BY id DESC').toArray().map(r => summary(r, admin));
  }

  async getTrack(id) {
    const r = this.row(id);
    return r ? { ...JSON.parse(r.rec), status: r.status } : null;
  }

  async upsertTrack(rec) {
    const old = this.row(rec.id);
    const prev = old && JSON.parse(old.rec);
    const sameFile = !!(prev && prev.file_unique_id && prev.file_unique_id === rec.file_unique_id);
    // 只是改了说明文字：已有的分片沿用（手动上传时可能换过大小和类型，也一起沿用）
    if (sameFile && prev.parts) Object.assign(rec, { parts: prev.parts, size: prev.size, mime: prev.mime });
    if (!needsParts(rec)) {
      this.write(rec, 'ok', '', 0);
      return { needsParts: false };
    }
    if (sameFile) {
      this.write(rec, old.status, old.note, old.attempts);
      return { needsParts: old.status === 'pending' };
    }
    this.write(rec, 'pending', '', 0);
    return { needsParts: true };
  }

  async removeTrack(id) {
    this.sql.exec('DELETE FROM tracks WHERE id = ?', id);
  }

  // 切片服务回报进度或失败
  async setTrackStatus(id, status, note) {
    if (status !== 'processing' && status !== 'failed') return;
    const r = this.row(id);
    if (!r || r.status === 'ok') return;
    this.sql.exec('UPDATE tracks SET status = ?, note = ?, updated = ? WHERE id = ?', status, cut(note, 200), Date.now(), id);
  }

  // 派活的结果：派出去了就记一次尝试；没派出去只记原因，状态不变，等定时任务再派
  async kicked(id, ok, note) {
    const r = this.row(id);
    if (!r || r.status === 'ok') return;
    if (ok) {
      this.sql.exec('UPDATE tracks SET status = ?, note = ?, attempts = attempts + 1, updated = ? WHERE id = ?',
        r.status === 'processing' ? 'processing' : 'queued', '', Date.now(), id);
    } else {
      this.sql.exec('UPDATE tracks SET note = ?, updated = ? WHERE id = ?', cut(note, 200), Date.now(), id);
    }
  }

  // 定时任务要重新派的活：还没派出去的、失败后退避到期的、卡住的；每次最多 3 首
  async claim(now) {
    const rows = this.sql.exec("SELECT * FROM tracks WHERE status != 'ok' ORDER BY id").toArray();
    const due = rows.filter(r => r.attempts < MAX_ATTEMPTS && (
      r.status === 'pending' ||
      (r.status === 'failed' && now - r.updated > 10 * 60 * 1000 * 2 ** Math.max(0, r.attempts - 1)) ||
      ((r.status === 'queued' || r.status === 'processing') && now - r.updated > STALE_MS)));
    return due.slice(0, 3).map(r => jobFor(JSON.parse(r.rec)));
  }

  async retryTrack(id) {
    const r = this.row(id);
    if (!r || r.status === 'ok') return null;
    this.sql.exec("UPDATE tracks SET status = 'pending', note = '', attempts = 0, updated = ? WHERE id = ?", Date.now(), id);
    return jobFor(JSON.parse(r.rec));
  }

  // 登记分片：切片服务或管理页上传完成后调用
  async commitParts(id, size, parts, force, mime) {
    const r = this.row(id);
    if (!r) return { error: '没有这首歌' };
    if (!Number.isInteger(size) || size <= 0 || !Array.isArray(parts) || !parts.length || parts.length > 500) {
      return { error: '分片列表不对' };
    }
    let total = 0;
    for (const p of parts) {
      if (!p || typeof p.file_id !== 'string' || !p.file_id || !Number.isInteger(p.size) || p.size <= 0 || p.size > BOT_DOWNLOAD_LIMIT) {
        return { error: '分片列表不对' };
      }
      total += p.size;
    }
    if (total !== size) return { error: '分片加起来的大小不对' };
    const rec = JSON.parse(r.rec);
    if (size !== rec.size) {
      if (!force) return { error: '大小和频道里的文件不一致' };
      rec.size = size;
      if (mime.startsWith('audio/')) rec.mime = mime;
    }
    rec.parts = parts.map(p => ({ file_id: p.file_id, size: p.size }));
    this.write(rec, 'ok', '', r.attempts);
    return { ok: true };
  }

  async noteChat(id, title, status) {
    this.sql.exec(`INSERT INTO chats (id, title, status, updated) VALUES (?, ?, ?, ?)
      ON CONFLICT(id) DO UPDATE SET title = excluded.title, status = excluded.status, updated = excluded.updated`,
      id, cut(title, 100), status, Date.now());
  }

  async listChats() {
    return this.sql.exec('SELECT id, title, status FROM chats ORDER BY updated DESC LIMIT 20').toArray();
  }

  async getConfig() {
    return { storage: this.cfg('storage') || '', storageTitle: this.cfg('storageTitle') || '' };
  }

  async setStorage(id) {
    const c = this.sql.exec('SELECT * FROM chats WHERE id = ?', id).toArray()[0];
    if (!c) return { error: '机器人不在这个频道里' };
    if (c.status !== 'administrator' && c.status !== 'creator') return { error: '机器人在这个频道里不是管理员' };
    this.setCfg('storage', c.id);
    this.setCfg('storageTitle', c.title);
    return { ok: true };
  }

  async importKV(kv) {
    let cursor = null;
    do {
      const page = await kv.list(cursor ? { prefix: 't:', cursor } : { prefix: 't:' });
      for (const k of page.keys) {
        const rec = await kv.get(k.name, 'json');
        if (rec && Number.isInteger(rec.id)) this.write(rec, needsParts(rec) ? 'pending' : 'ok', '', 0);
      }
      cursor = page.list_complete ? null : page.cursor;
    } while (cursor);
  }

  row(id) {
    return this.sql.exec('SELECT * FROM tracks WHERE id = ?', id).toArray()[0] || null;
  }

  write(rec, status, note, attempts) {
    this.sql.exec(`INSERT INTO tracks (id, rec, status, note, attempts, updated) VALUES (?, ?, ?, ?, ?, ?)
      ON CONFLICT(id) DO UPDATE SET rec = excluded.rec, status = excluded.status, note = excluded.note,
        attempts = excluded.attempts, updated = excluded.updated`,
      rec.id, JSON.stringify(rec), status, note, attempts, Date.now());
  }

  cfg(k) {
    const r = this.sql.exec('SELECT v FROM config WHERE k = ?', k).toArray()[0];
    return r ? r.v : null;
  }

  setCfg(k, v) {
    this.sql.exec('INSERT INTO config (k, v) VALUES (?, ?) ON CONFLICT(k) DO UPDATE SET v = excluded.v', k, v);
  }
}

// 歌单里的一行；file_id、分片清单这些只在服务端用，不给出去
function summary(r, admin) {
  const rec = JSON.parse(r.rec);
  const parts = rec.parts ? rec.parts.length : 0;
  const playable = r.status === 'ok';
  const out = {
    id: rec.id, kind: rec.kind, title: rec.title, performer: rec.performer, mime: rec.mime,
    size: rec.size, duration: rec.duration, date: rec.date,
    status: r.status, playable, parts,
    downloadable: playable && parts <= MAX_PARTS_PER_RESPONSE,
  };
  if (admin) Object.assign(out, { note: r.note, attempts: r.attempts, updated: r.updated });
  return out;
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

// 按码位截断，不会把 emoji 劈成半个
function cut(s, n) {
  const chars = Array.from(s || '');
  return chars.length > n ? chars.slice(0, n - 1).join('') + '…' : chars.join('');
}

function intParam(url, name) {
  const v = url.searchParams.get(name) || '';
  return /^\d{1,10}$/.test(v) ? Number(v) : null;
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

function text(body, status = 200) {
  return new Response(body, {
    status,
    headers: cors({ 'Content-Type': 'text/plain; charset=utf-8', 'Cache-Control': 'no-store' }),
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
.track.big{opacity:.55}
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
  var WAITING = { pending: 1, queued: 1, processing: 1 };
  var tracks = [], curId = null, channel = '', timer = 0, firstLoad = true;

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
    if(t.playable) return [artist(t.performer), mmss(t.duration), mb(t.size)].filter(Boolean).join(' · ');
    return WAITING[t.status] ? '超过 20 MB，正在处理，稍后就能播放' : '超过 20 MB，暂时无法在网页播放';
  }

  function render(){
    list.textContent = '';
    tracks.forEach(function(t, i){
      var li = el('li', 'track' + (t.playable ? '' : ' big') + (t.id === curId ? ' on' : ''));
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
      if(t.downloadable){
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

  audio.addEventListener('ended', function(){ step(1); });
  audio.addEventListener('error', function(){
    if(curId !== null) nowArtist.textContent = '这首暂时播放不了，稍后再试';
  });
  if('mediaSession' in navigator){
    try {
      navigator.mediaSession.setActionHandler('previoustrack', function(){ step(-1); });
      navigator.mediaSession.setActionHandler('nexttrack', function(){ step(1); });
    } catch(e){}
  }

  function load(){
    clearTimeout(timer);
    fetch('/api/tracks').then(function(r){
      if(!r.ok) throw new Error(String(r.status));
      return r.json();
    }).then(function(d){
      tracks = d.tracks || [];
      channel = d.channel || '';
      if(channel) document.getElementById('tg').href = 'https://t.me/' + channel;
      document.getElementById('count').textContent = tracks.length ? ' · ' + tracks.length + ' 首' : '';
      if(!tracks.length){
        statusEl.hidden = false;
        statusEl.textContent = '频道里还没有音频';
        list.textContent = '';
        return;
      }
      statusEl.hidden = true;
      render();
      if(firstLoad){
        firstLoad = false;
        // 分享链接 /#消息号：选中那首（浏览器不允许自动出声，需要再点一下播放）
        var i = indexOf(Number(location.hash.slice(1)));
        if(i >= 0 && tracks[i].playable){
          select(tracks[i].id);
          list.children[i].scrollIntoView({ block: 'center' });
        }
      }
      // 有大文件正在处理：每 20 秒刷新一次，处理好了就能直接点
      if(tracks.some(function(t){ return WAITING[t.status]; })) timer = setTimeout(load, 20000);
    }).catch(function(){
      if(!firstLoad){ timer = setTimeout(load, 60000); return; } // 后台刷新失败不打扰，过会儿再试
      statusEl.hidden = false;
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
.card ol{margin:6px 0;padding-left:20px}
.warn{color:var(--accent);font-weight:600}
.err{color:var(--danger);font-size:14px}
.rows{list-style:none;margin:0;padding:0}
.row{display:flex;align-items:center;gap:12px;padding:10px 0;border-bottom:1px solid var(--line)}
.row .info{flex:1;min-width:0}
.row .title{font-weight:600;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
.row .meta{font-size:13px;color:var(--muted)}
.acts{display:flex;gap:8px;flex:none;flex-wrap:wrap;justify-content:flex-end}
.empty{color:var(--muted);padding:10px 0}
.chat{display:flex;align-items:center;justify-content:space-between;gap:12px;padding:6px 0}
button{font:inherit;font-size:14px;color:var(--accent);background:none;border:1px solid currentColor;border-radius:8px;padding:6px 12px;cursor:pointer}
button:disabled{opacity:.45;cursor:not-allowed}
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
    <section class="card" id="setup"></section>
    <h2>超过 20 MB 的文件</h2>
    <p class="hint">要切成 19 MB 的分片存进仓库频道才能在网页播放。开了自动处理会自己完成；也可以选本地的同一个文件手动上传。</p>
    <ul id="big" class="rows"></ul>
    <h2>全部歌曲</h2>
    <p class="hint">频道里删掉的帖子不会自动从网页消失，在这里移除。</p>
    <ul id="all" class="rows"></ul>
    <p><button type="button" id="logout" class="link">退出管理</button></p>
  </div>
</main>
<script>
(function(){
  var KEY_STORE = 'xm-admin-key';
  var STATUS = { pending: '等待处理', queued: '已派给自动处理，等它开始', processing: '正在处理', failed: '处理失败', ok: '已可播放' };
  var key = '';
  try { key = localStorage.getItem(KEY_STORE) || ''; } catch(e){}
  var state = null, busy = {};

  function $(id){ return document.getElementById(id); }
  function el(tag, cls, txt){
    var e = document.createElement(tag);
    if(cls) e.className = cls;
    if(txt != null) e.textContent = txt;
    return e;
  }
  function button(label, cls, onClick){
    var b = el('button', cls, label);
    b.type = 'button';
    b.addEventListener('click', onClick);
    return b;
  }
  function mb(b){ return (b / 1048576).toFixed(1) + ' MB'; }
  function post(obj){ return { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(obj) }; }
  function alertErr(e){ alert('出错了：' + e.message); }

  function api(path, opts){
    opts = opts || {};
    opts.headers = Object.assign({ Authorization: 'Bearer ' + key }, opts.headers || {});
    return fetch('/admin/api/' + path, opts).then(function(r){
      return r.json().catch(function(){ return {}; }).then(function(d){
        if(!r.ok){
          var e = new Error(d.error || ('HTTP ' + r.status));
          e.status = r.status;
          e.retryAfter = d.retryAfter;
          throw e;
        }
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
      state = s;
      $('login').hidden = true;
      $('app').hidden = false;
      renderSetup();
      renderBig();
      renderAll();
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

  function isAdmin(c){ return c.status === 'administrator' || c.status === 'creator'; }

  function renderSetup(){
    var box = $('setup');
    box.textContent = '';
    if(state.storage){
      box.appendChild(el('p', null, '仓库频道：' + (state.storage.title || state.storage.id)));
    } else {
      box.appendChild(el('p', 'warn', '还没有设置仓库频道，大文件的分片没地方存'));
      var ol = el('ol');
      ol.appendChild(el('li', null, '在 Telegram 新建一个「私有频道」，名字随意，比如「小橘仓库」'));
      ol.appendChild(el('li', null, '把 @' + (state.bot || '你的机器人') + ' 加为这个频道的管理员（要能发消息）'));
      ol.appendChild(el('li', null, '回到这里点「刷新」，在下面把它设为仓库'));
      box.appendChild(ol);
      state.chats.forEach(function(c){
        var row = el('div', 'chat');
        row.appendChild(el('span', null, (c.title || c.id) + (isAdmin(c) ? '' : '（机器人还不是管理员）')));
        var b = button('设为仓库', null, function(){ api('storage', post({ id: c.id })).then(refresh).catch(alertErr); });
        b.disabled = !isAdmin(c);
        row.appendChild(b);
        box.appendChild(row);
      });
      box.appendChild(button('刷新', null, refresh));
    }
    box.appendChild(el('p', null, state.splitter
      ? '自动处理：已开启，频道里一出现大文件就会自动切片'
      : '自动处理：未开启，可以在下面手动上传本地文件'));
  }

  function renderBig(){
    var ul = $('big');
    ul.textContent = '';
    var big = state.tracks.filter(function(t){ return t.size > state.limit || t.parts; });
    if(!big.length){ ul.appendChild(el('li', 'empty', '没有超过 20 MB 的文件')); return; }
    big.forEach(function(t){
      var li = el('li', 'row');
      var info = el('div', 'info');
      info.appendChild(el('div', 'title', '#' + t.id + ' ' + t.title));
      var s = STATUS[t.status] || t.status;
      if(t.status === 'ok') s += '（' + t.parts + ' 片）';
      if(t.note) s += '：' + t.note;
      info.appendChild(el('div', 'meta', mb(t.size) + ' · ' + (busy[t.id] || s)));
      li.appendChild(info);
      var acts = el('div', 'acts');
      if(t.status !== 'ok' && !busy[t.id] && state.storage){
        var input = el('input');
        input.type = 'file';
        input.hidden = true;
        input.accept = 'audio/*,.mp3,.m4a,.flac,.wav,.ogg,.opus,.aac';
        input.addEventListener('change', function(){ if(input.files[0]) upload(t, input.files[0]); });
        acts.appendChild(input);
        acts.appendChild(button('上传本地文件', null, function(){ input.click(); }));
        if(state.splitter){
          acts.appendChild(button('重新自动处理', null, function(){ api('retry', post({ track: t.id })).then(refresh).catch(alertErr); }));
        }
      }
      li.appendChild(acts);
      ul.appendChild(li);
    });
  }

  function renderAll(){
    var ul = $('all');
    ul.textContent = '';
    if(!state.tracks.length){ ul.appendChild(el('li', 'empty', '歌单是空的')); return; }
    state.tracks.forEach(function(t){
      var li = el('li', 'row');
      var info = el('div', 'info');
      info.appendChild(el('div', 'title', '#' + t.id + ' ' + t.title));
      info.appendChild(el('div', 'meta', mb(t.size) + ' · ' + (STATUS[t.status] || t.status)));
      li.appendChild(info);
      var acts = el('div', 'acts');
      acts.appendChild(button('移除', 'danger', function(){
        if(!confirm('从网页歌单移除「' + t.title + '」？\\n不会删除 Telegram 里的帖子。')) return;
        api('remove', post({ track: t.id })).then(refresh).catch(alertErr);
      }));
      li.appendChild(acts);
      ul.appendChild(li);
    });
  }

  // 浏览器里把文件切成 19 MB 一片，逐片上传；传好的片记在本地，中断后重选同一个文件能接着传
  function upload(t, file){
    var PART = state.partSize;
    var force = false;
    if(file.size !== t.size){
      if(!confirm('选的文件（' + mb(file.size) + '）和频道里的（' + mb(t.size) + '）大小不一样，可能不是同一个文件。\\n仍然上传，并用它在网页上播放吗？')) return;
      force = true;
    }
    var count = Math.ceil(file.size / PART);
    var store = 'xm-up:' + t.id + ':' + file.size + ':' + file.lastModified;
    var done = [];
    try { done = JSON.parse(localStorage.getItem(store) || '[]'); } catch(e){}
    var i = 0;

    function show(msg){ busy[t.id] = msg; renderBig(); }
    function uploaded(){ var n = 0; for(var k = 0; k < count; k++) if(done[k]) n++; return n; }
    function sendPart(idx, blob, attempt){
      return api('part?track=' + t.id + '&index=' + idx + '&count=' + count, {
        method: 'POST', body: blob, headers: { 'Content-Type': 'application/octet-stream' }
      }).catch(function(e){
        if(attempt >= 4 || e.status === 400 || e.status === 401 || e.status === 409) throw e;
        var wait = (e.retryAfter || (attempt + 1) * 3) * 1000;
        show('第 ' + (idx + 1) + ' 片没传上去，' + Math.round(wait / 1000) + ' 秒后重试…');
        return new Promise(function(res){ setTimeout(res, wait); }).then(function(){ return sendPart(idx, blob, attempt + 1); });
      });
    }
    function next(){
      while(i < count && done[i]) i++;
      if(i >= count) return finish();
      show('正在上传第 ' + (i + 1) + '/' + count + ' 片（已完成 ' + Math.round(uploaded() / count * 100) + '%）');
      var blob = file.slice(i * PART, Math.min(file.size, (i + 1) * PART));
      return sendPart(i, blob, 0).then(function(r){
        done[i] = r;
        try { localStorage.setItem(store, JSON.stringify(done)); } catch(e){}
        i++;
        return next();
      });
    }
    function finish(){
      show('正在登记…');
      return api('commit', post({ track: t.id, size: file.size, parts: done.slice(0, count), force: force, mime: file.type }))
        .then(function(){ try { localStorage.removeItem(store); } catch(e){} });
    }

    next().then(function(){
      delete busy[t.id];
      return refresh();
    }, function(e){
      delete busy[t.id];
      alert('上传失败：' + e.message + '\\n已经传好的分片会保留，重新选同一个文件就能接着传。');
      refresh();
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

  // 有文件在处理时，每 15 秒刷新一次（正在上传时不刷，免得打断）
  setInterval(function(){
    if(state && key && !Object.keys(busy).length && document.visibilityState === 'visible' &&
       state.tracks.some(function(t){ return t.status !== 'ok'; })) refresh();
  }, 15000);

  if(key) refresh(); else showLogin('');
})();
</script>
</body>
</html>
`;
