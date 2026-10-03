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
//   GET  /c/<消息号>        封面：音乐文件自带的缩略图；没有就从频道的图片帖里随机挑一张，挑定后存进数据库
//   GET  /l/<消息号>        歌词 JSON：先看数据库；没有就去 LRCLIB、网易云找，找到（或确定没有）就存起来
//   POST /tg-webhook       Telegram 推送频道新帖，音频自动登记；回复某首歌发的 .lrc 文件就是这首的歌词
//   GET  /video            刷视频网页（video.html）：随机刷视频频道「小橘视频」里的视频，上滑下一条、下滑回上一条
//   GET  /api/videos       视频池 JSON（新的在前）；离上次和频道对一遍超过 30 分钟，就在后台再对一遍
//   GET  /vf/<消息号>       视频流，支持 Range（20 MB 以内走 Bot API，更大的走流式服务）
//   GET  /vp/<消息号>       视频封面（缩略图），取一次就存起来
//   GET  /admin            小橘音乐管理页（admin.html，管理密钥登录）：把频道里已删掉的帖子从歌单移除
//   GET  /video-admin      小橘视频管理页（video-admin.html，同一个管理密钥）：内容过滤规则、过滤记录
//   *    /admin/api/...    管理接口（Authorization: Bearer <ADMIN_KEY>）
//
// 数据在 Durable Object「Library」的 SQLite 里：强一致，也没有 KV list 每天 1000 次的限制。
//
// 绑定：LIB（Durable Object）、TRACKS（旧 KV，只在第一次启动时迁移数据用）、
//       TG_BOT_TOKEN / TG_WEBHOOK_SECRET / ADMIN_KEY / STREAMER_KEY（secret）、
//       CHANNEL_ID / CHANNEL_USERNAME / STREAMER_URL（普通变量；STREAMER_URL 为空则大文件不能播放）、
//       VIDEO_CHANNEL_ID（视频频道「小橘视频」，私有频道的数字 id：抖音视频、频道主发来的视频文件都转到这里，不进音乐频道）
//   POST /verify-webhook   审核机器人（verify.js）的 webhook：抖音搜索结果转进视频频道前，频道主在那里审核

import { DurableObject } from 'cloudflare:workers';
import PAGE from './page.html';
import ADMIN_PAGE from './admin.html';
import DOUYIN_LOGIN_PAGE from './douyin-login.html';
import VIDEO_PAGE from './video.html';
import VIDEO_ADMIN_PAGE from './video-admin.html';
import * as V from './verify.js';

const TG = 'https://api.telegram.org';
// 官方 Bot API 的 getFile 只能取 20 MB 以内的文件，更大的走流式服务
const BOT_DOWNLOAD_LIMIT = 20 * 1024 * 1024;
// getFile 给的下载路径保证至少 1 小时有效，留 10 分钟余量
const PATH_TTL_MS = 50 * 60 * 1000;
const LIST_TTL_MS = 20 * 1000;
const REC_TTL_MS = 60 * 1000;
// 等流式服务回响应头的时间；等不到多半是它在休眠，先让播放页过会儿再试
const STREAMER_WAIT_MS = 25 * 1000;
// 机器人问流式服务（搜歌、开始搬）最多等多久
const BOT_WAIT_MS = 25 * 1000;
// 算音柱数据要先把整首歌从 Telegram 取下来再解码，大文件要久一点
const VIZ_WAIT_MS = 90 * 1000;
// Telegram 给音乐文件生成的缩略图一般 20 KB 上下，超过这个大小就不当封面存
const COVER_LIMIT = 512 * 1024;
// 同一张图被这么多首歌当封面，就当它是别的频道的台标
const LOGO_MIN_SONGS = 8;
// 刷视频网页：有人打开网页时，离上次和视频频道对一遍（补上 webhook 收不到的、去掉删了的）超过这么久就再对一遍
const VIDEO_SYNC_MS = 30 * 60 * 1000;
// 对不成（流式服务在休眠之类）过这么久再试
const VIDEO_SYNC_RETRY_MS = 2 * 60 * 1000;
// 翻一遍视频频道最多等多久（几千条视频要翻几十页）
const VIDEO_SYNC_WAIT_MS = 120 * 1000;

// 歌词：LRCLIB 是公开的歌词库（本来就给播放器用）；网易云用的是它网页版的接口，不是公开 API，随时可能变
const LRCLIB = 'https://lrclib.net/api/search';
const NETEASE = 'https://music.163.com/api';
const UA = 'xiaoju-music (https://xiaoju-music.langhua98.workers.dev)';
// 外面那首歌的时长和我们这首相差几秒以内，才认为时间轴对得上
const LYRICS_SLACK_S = 3;
const LYRICS_WAIT_MS = 8000;
const DAY_MS = 24 * 3600 * 1000;
const ASK_PER_DAY = 10;
// 手动发的 .lrc 文件大小上限（一首歌的歌词一般几 KB）
const LRC_LIMIT = 256 * 1024;

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
const videoRecCache = new Map(); // 视频频道的消息号 -> { rec, exp }
let videoListCache = null;       // { body, exp }

class HttpError extends Error {
  constructor(status, message, headers) {
    super(message);
    this.status = status;
    this.headers = headers;
  }
}

export default {
  // 每天北京时间凌晨 3 点（UTC 19:00）：自动去来源频道搬新歌
  async scheduled(controller, env, ctx) {
    if (controller.cron === DOUYIN_CRON) {
      ctx.waitUntil(expireReviews(env).catch(() => {}));
      ctx.waitUntil(douyinTick(env).catch(() => {}));
    }
    else ctx.waitUntil(nightly(env).catch(() => {}));
  },
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
      if (path === '/verify-webhook') {
        return method === 'POST' ? await V.verifyWebhook(request, env, reviewDeps(env)) : text('Method Not Allowed', 405);
      }
      if (path.startsWith('/admin/api/')) return await adminApi(request, env, url);
      if (path === '/dy-import' && method === 'POST') return await cloudImport(request, env);
      if (path === '/dy-cloud-config' && method === 'POST') return await cloudConfig(request, env);
      if (path === '/dy-search' && method === 'POST') return await cloudSearchResult(request, env);
      if (path === '/dy-progress' && method === 'POST') return await cloudProgress(request, env);
      if (path === '/dy-known' && method === 'POST') return await cloudKnown(request, env);
      if ((path === '/streamer-up' || path === '/streamer-done') && method === 'POST') return await streamerNotice(request, env, ctx, path);
      if (path.startsWith('/dl/') && method === 'POST') {
        const m2 = path.match(/^\/dl\/([\w-]{20,64})\/start$/);
        if (m2) return await douyinLoginApi(env, m2[1], 'start');
      }
      if (method !== 'GET' && method !== 'HEAD') return text('Method Not Allowed', 405);
      if (path === '/') return html(PAGE, method);
      if (path === '/admin') return html(ADMIN_PAGE, method, { 'X-Robots-Tag': 'noindex' });
      if (path === '/video-admin') return html(VIDEO_ADMIN_PAGE, method, { 'X-Robots-Tag': 'noindex' });
      if (path === '/video') return html(VIDEO_PAGE, method);
      if (path === '/api/videos') return await videoList(env, ctx);
      const vf = path.match(/^\/vf\/(\d{1,10})(?:\.mp4)?$/);
      if (vf) return await videoFile(request, env, Number(vf[1]));
      const vp = path.match(/^\/vp\/(\d{1,10})$/);
      if (vp) return await videoPoster(env, Number(vp[1]));
      if (path === '/douyin-login') return html(DOUYIN_LOGIN_PAGE, method, { 'X-Robots-Tag': 'noindex' });
      const dl = path.match(/^\/dl\/([\w-]{20,64})\/(start|status|qr|shot)$/);
      if (dl) return await douyinLoginApi(env, dl[1], dl[2]);
      if (path === '/api/tracks') return await trackList(env);
      const m = path.match(/^\/a\/(\d{1,10})(?:\.[a-z0-9]{1,5})?$/i);
      if (m) return await audio(request, env, Number(m[1]), url.searchParams.has('dl'));
      const c = path.match(/^\/c\/(\d{1,10})$/);
      if (c) return await cover(env, Number(c[1]), url.searchParams.get('art') === '1');
      const v = path.match(/^\/v\/(\d{1,10})$/);
      if (v) return await viz(env, Number(v[1]));
      const l = path.match(/^\/l\/(\d{1,10})$/);
      if (l) return await lyrics(env, Number(l[1]));
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

async function webhook(request, env, ctx) {
  const got = request.headers.get('X-Telegram-Bot-Api-Secret-Token') || '';
  if (!env.TG_WEBHOOK_SECRET || !sameString(got, env.TG_WEBHOOK_SECRET)) return text('Forbidden', 403);

  const update = await request.json().catch(() => null);
  // 私聊机器人（频道主管理、听众求歌）和按按钮：先回 200，慢慢处理（搜歌要好几秒，Telegram 等不了太久会重发）
  if (update && ((update.message && update.message.chat && update.message.chat.type === 'private') || update.callback_query)) {
    const work = botUpdate(env, update, new URL(request.url).origin).catch(() => {});
    if (ctx && ctx.waitUntil) ctx.waitUntil(work); else await work;
    return text('ok');
  }
  const post = update && (update.channel_post || update.edited_channel_post);
  // 视频频道「小橘视频」的视频帖：登记进刷视频网页的视频池（不进歌单）。编辑后不再是视频的从池里去掉
  if (post && Number.isInteger(post.message_id) && env.VIDEO_CHANNEL_ID && String(post.chat && post.chat.id) === String(env.VIDEO_CHANNEL_ID)) {
    const v = toVideo(post);
    if (v) await lib(env).upsertVideo(v);
    else if (update.edited_channel_post) await lib(env).removeVideo(post.message_id);
    forgetVideo(post.message_id);
    return text('ok');
  }
  // 只收自己频道的帖子；别的群、私聊一律忽略，但仍回 200，免得 Telegram 反复重发
  if (!post || !Number.isInteger(post.message_id) || String(post.chat && post.chat.id) !== String(env.CHANNEL_ID)) {
    return text('ok');
  }
  // .lrc 文件：手动给某首歌配歌词。出了错也回 200，免得 Telegram 反复重发、把后面的新歌堵住
  if (post.document && /\.lrc$/i.test(post.document.file_name || '')) {
    try {
      await attachLyrics(env, post);
    } catch {
      // 重新发一次就好
    }
    return text('ok');
  }
  // 图片帖：记下来，给没有封面的歌当封面
  if (post.photo && post.photo.length) {
    await lib(env).addPhoto(post.message_id, pickPhotoSize(post.photo));
    return text('ok');
  }
  const rec = toRecord(post);
  // 新帖是已有的歌（歌名、歌手一样，时长差 3 秒以内）：不再进歌单。编辑已登记的帖子不算
  if (rec && update.channel_post && (await lib(env).findSame(rec))) return text('ok');
  if (rec) {
    const fresh = await lib(env).upsertTrack(rec);
    // 新进来的歌（不管是手动发的、夜里自动搬的还是机器人搬的）：按类型放进对应的歌单
    if (fresh && update.channel_post) {
      // 贴网址搬来的授权音频（帖子说明里有「授权：」「来源：」）：设置里指定了歌单就放那个歌单，没指定就按类型分
      const harvested = /^授权：/m.test(rec.caption) && /^来源：/m.test(rec.caption);
      const target = harvested ? (await lib(env).getHarvest()).playlist : '';
      // 搬来的多是外语、纯音乐：分不出类型时不硬塞「华语流行」，只留在「全部」
      await lib(env).addToPlaylists(rec.id, target ? [target] : genresOf(summary(rec), !harvested));
    }
  } else if (update.edited_channel_post) await lib(env).removeTrack(post.message_id); // 编辑后已不含音频
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

// 视频频道的一条帖子 → 视频池里的一条记录；不是视频 → null。file_id、缩略图只在服务端用
function toVideo(post) {
  const d = post.document;
  const f = post.video || (d && /^video\//.test(d.mime_type || '') ? d : null);
  if (!f || !f.file_id) return null;
  return {
    id: post.message_id,
    file_id: f.file_id,
    file_unique_id: f.file_unique_id || '',
    thumb: (f.thumbnail || f.thumb || {}).file_id || '',
    mime: /^video\//.test(f.mime_type || '') ? f.mime_type : 'video/mp4',
    size: f.file_size || 0,
    duration: f.duration || 0,
    w: f.width || 0,
    h: f.height || 0,
    date: post.date || 0,
    caption: (post.caption || '').trim(),
  };
}

// 边长不超过 800 的最大一档；都超过就取最小的
function pickPhotoSize(sizes) {
  const area = s => (s.width || 0) * (s.height || 0);
  const fit = sizes.filter(s => Math.max(s.width || 0, s.height || 0) <= 800);
  const pool = fit.length ? fit : sizes;
  return pool.reduce((a, b) => (fit.length ? area(b) > area(a) : area(b) < area(a)) ? b : a).file_id;
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
  // 刷视频网页的视频池：GET 看有多少条、上次什么时候和频道对过；POST 马上对一遍
  if (action === 'videos') {
    if (request.method === 'POST') return json(await syncVideos(env));
    const L = lib(env);
    return json({ total: (await L.listVideos()).length, syncedAt: Number(await L.getConfig('vSyncOk')) || 0 });
  }
  // 内容过滤规则：管理员在这里加、改、删、开关；固定规则（未成年人保护）只读
  if (action === 'filters' && request.method === 'GET') {
    return json({ builtin: BUILTIN_RULES, rules: await lib(env).listFilterRules() });
  }
  if (action === 'filters' && request.method === 'POST') {
    let body;
    try { body = await request.json(); } catch { return json({ error: '格式不对' }, 400); }
    const rule = cleanRule(body);
    if (rule.error) return json({ error: rule.error }, 400);
    const id = await lib(env).saveFilterRule(rule);
    if (!id) return json({ error: '找不到这条规则' }, 404);
    return json({ ok: true, id });
  }
  if (action === 'filters-delete' && request.method === 'POST') {
    let body;
    try { body = await request.json(); } catch { return json({ error: '格式不对' }, 400); }
    if (String(body.id) === 'minor') return json({ error: '固定规则不能删' }, 400);
    return json({ ok: await lib(env).deleteFilterRule(Number(body.id) || 0) });
  }
  if (action === 'filter-log' && request.method === 'GET') {
    const n = Math.max(1, Math.min(Number(url.searchParams.get('limit')) || 100, 500));
    return json({ log: await lib(env).listFilterLog(n) });
  }
  if (action === 'state' && request.method === 'GET') {
    return json({ channel: env.CHANNEL_USERNAME || '', streamer: streamerOn(env), tracks: await tracksFor(env), playlists: await lib(env).listPlaylists() });
  }
  // 整体设置歌单：{ playlists: [{ id?, name, cover?, tracks: [消息号...] }] }，顺序就是显示顺序
  if (action === 'playlists' && request.method === 'POST') {
    const body = await request.json().catch(() => ({}));
    const list = Array.isArray(body.playlists) ? body.playlists : null;
    const ok = list && list.length <= 100 && list.every(p => p && typeof p.name === 'string' && p.name.trim() && p.name.length <= 40 &&
      Array.isArray(p.tracks) && p.tracks.length <= 5000 && p.tracks.every(Number.isInteger) &&
      (p.id === undefined || Number.isInteger(p.id)) && (p.cover === undefined || Number.isInteger(p.cover)));
    if (!ok) return json({ error: '参数不对' }, 400);
    const saved = await lib(env).setPlaylists(list.map(p => ({ id: p.id, name: p.name.trim(), cover: p.cover, tracks: [...new Set(p.tracks)] })));
    listCache = null;
    return json({ ok: true, playlists: saved });
  }
  // 频道主自己的抖音账号（「转抖音视频」只转这个账号的）：GET 取，POST {sec_uid} 设
  if (action === 'douyin-self') {
    if (request.method === 'POST') {
      const body = await request.json().catch(() => ({}));
      const list = body.sec_uids !== undefined ? body.sec_uids : [...await douyinSelves(lib(env)), body.sec_uid];
      const clean = [...new Set((Array.isArray(list) ? list : []).map(x => String(x || '').trim()))];
      if (!clean.length || clean.length > MAX_SELVES || !clean.every(x => SEC_UID.test(x))) return json({ error: '参数不对' }, 400);
      await lib(env).setConfig('douyinSelf', JSON.stringify(clean));
    }
    return json({ sec_uids: await douyinSelves(lib(env)) });
  }
  // 等云电脑去搜的词：GET 看；POST {clear: true} 清空（和机器人里「搜抖音 清空」一样）
  if (action === 'douyin-search-queue') {
    const L = lib(env);
    if (request.method === 'POST') {
      const body = await request.json().catch(() => ({}));
      if (body.clear !== true) return json({ error: '参数不对' }, 400);
      await L.setConfig('dySearchQueue', '[]');
      await L.setConfig('dySearchCounts', '{}');
    }
    return json({ queue: await douyinSearchQueue(L), counts: await douyinTagMap(L, 'dySearchCounts') });
  }
  // 抖音自动同步开关（和机器人里「抖音自动同步 开/关」一样）：POST {on: true|false}
  if (action === 'douyin-auto' && request.method === 'POST') {
    const body = await request.json().catch(() => ({}));
    await lib(env).setConfig('douyinAuto', body.on ? '1' : '0');
    return json({ on: !!body.on });
  }
  // 手动跑一次「夜里自动搬」（测试、或者想马上搬）
  if (action === 'auto-run' && request.method === 'POST') return json(await nightly(env));
  if (action === 'auto-state') return json(await lib(env).getAuto());
  if (action === 'remove' && request.method === 'POST') {
    const body = await request.json().catch(() => ({}));
    const track = Number(body.track);
    if (!Number.isInteger(track)) return json({ error: '参数不对' }, 400);
    await lib(env).removeTrack(track);
    forget(track);
    return json({ ok: true });
  }
  // 搬歌用的「音乐来源频道」名单：{sources: [用户名...]}；GET 取、POST 整个换掉
  if (action === 'sources') {
    if (request.method === 'GET') return json({ sources: await lib(env).getSources() });
    if (request.method === 'POST') {
      const body = await request.json().catch(() => ({}));
      const list = Array.isArray(body.sources) ? body.sources.map(s => String(s).trim().replace(/^@/, '')) : null;
      if (!list || list.length > 500 || !list.every(s => /^\w{4,64}$/.test(s))) return json({ error: '参数不对' }, 400);
      return json({ ok: true, sources: await lib(env).setSources([...new Set(list)]) });
    }
  }
  // 这首现在的封面不要了（比如别的频道的台标）：用这张图的歌都改用频道图片，以后也不再用它
  // 频道里新加了图片：没有自带封面、用着频道图片的歌清掉封面，下次打开时从现在的图库里重新挑
  if (action === 'reshuffle-photo-covers' && request.method === 'POST') {
    return json({ ok: true, cleared: await lib(env).clearPhotoCovers() });
  }
  if (action === 'ban-cover' && request.method === 'POST') {
    const body = await request.json().catch(() => ({}));
    const track = Number(body.track);
    if (!Number.isInteger(track)) return json({ error: '参数不对' }, 400);
    const affected = await lib(env).banCover(track);
    return json({ ok: true, affected });
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
    const [tracks, playlists] = await Promise.all([tracksFor(env), lib(env).listPlaylists()]);
    listCache = { body: JSON.stringify({ channel: env.CHANNEL_USERNAME || '', tracks, playlists }), exp: now + LIST_TTL_MS };
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
// artOnly：只要这首歌自己的专辑图（播放页、歌曲列表用）；配的频道图片当作没有，网页改画文字封面。
// 歌单宫格不带 artOnly，频道图片照样给
async function cover(env, id, artOnly) {
  const L = lib(env);
  let c = await L.getCover(id);
  if (!c) {
    const rec = await getRec(env, id);
    if (!rec) throw new HttpError(404, '没有这首歌');
    let got = await fetchCover(env, rec), own = true;
    if (got && got !== 'none' && (await L.isLogo(toBase64(got.data)))) got = 'none'; // 别的频道的台标，不算封面
    if (got === 'none'){ got = await photoCover(env); own = false; }
    if (!got) throw new HttpError(503, '封面暂时取不到', { 'Retry-After': '60' });
    c = got === 'none' ? { none: true } : { mime: got.mime, b64: toBase64(got.data), own };
    await L.putCover(id, c.none ? 'none' : c.mime, c.none ? '' : c.b64, c.none ? 0 : own);
  }
  if (c.none || (artOnly && !c.own)) throw new HttpError(404, '这首没有封面', { 'Cache-Control': 'public, max-age=86400' });
  return new Response(fromBase64(c.b64), {
    headers: cors({ 'Content-Type': c.mime, 'Cache-Control': 'public, max-age=604800' }),
  });
}

// ── 音柱数据 ─────────────────────────────────────────────────────
// 每首歌各频段随时间的响度（格式见流式服务的 pack_viz），第一次请流式服务算，存下来以后直接给。
// 网页按播放进度画音柱，iPhone 上也能跟着歌真的跳
async function viz(env, id) {
  const L = lib(env);
  let b64 = await L.getViz(id);
  if (b64 === null) {
    if (!(await getRec(env, id))) throw new HttpError(404, '没有这首歌');
    if (!streamerOn(env)) throw new HttpError(503, '暂时算不了', { 'Retry-After': '300' });
    let res;
    try {
      res = await fetch(`${streamerBase(env)}/viz/${id}`, {
        headers: { 'X-Key': env.STREAMER_KEY },
        signal: AbortSignal.timeout(VIZ_WAIT_MS),
      });
    } catch {
      throw new HttpError(503, '暂时算不了', { 'Retry-After': '30' });
    }
    // 流式服务自己的 404（JSON）才是「这首算不了」；Hugging Face 的错误页不算
    if (res.status === 404 && (res.headers.get('Content-Type') || '').includes('json')) {
      if (res.body) await res.body.cancel();
      b64 = '';
    } else {
      const buf = res.ok ? new Uint8Array(await res.arrayBuffer()) : null;
      if (!buf || buf.length < 5 || buf[0] !== 0x58 || buf[1] !== 0x56) {
        if (res.body && !res.bodyUsed) await res.body.cancel();
        throw new HttpError(503, '暂时算不了', { 'Retry-After': '30' });
      }
      b64 = toBase64(buf);
    }
    await L.putViz(id, b64);
  }
  if (!b64) throw new HttpError(404, '这首没有音柱数据', { 'Cache-Control': 'public, max-age=86400' });
  return new Response(fromBase64(b64), {
    headers: cors({ 'Content-Type': 'application/octet-stream', 'Cache-Control': 'public, max-age=2592000' }),
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

// 从频道的图片帖里随机挑一张。更早的图片帖 webhook 没见过，第一次用时请流式服务按消息号扫一遍
async function photoCover(env) {
  const L = lib(env);
  if (!(await L.getFlag('photosScanned'))) {
    if (!streamerOn(env)) return null;
    try {
      const res = await fetch(`${streamerBase(env)}/photos?upto=${(await L.maxTrackId()) + 300}`, {
        headers: { 'X-Key': env.STREAMER_KEY },
        signal: AbortSignal.timeout(60 * 1000),
      });
      const j = res.ok ? await res.json().catch(() => null) : null;
      if (!j || !Array.isArray(j.photos)) return null;
      await L.addScannedPhotos(j.photos.filter(Number.isInteger));
      await L.setFlag('photosScanned');
    } catch {
      return null;
    }
  }
  const photos = await L.listPhotos();
  if (!photos.length) return 'none';
  for (let i = 0; i < 3; i++) {
    const img = await fetchPhoto(env, photos[Math.floor(Math.random() * photos.length)]);
    if (img) return img;
  }
  return null;
}

async function fetchPhoto(env, p) {
  try {
    if (p.file_id) return await imageFrom(await fetchFile(env, p.file_id, null), 'image/jpeg');
    if (!streamerOn(env)) return null;
    const res = await fetch(`${streamerBase(env)}/photo/${p.id}`, {
      headers: { 'X-Key': env.STREAMER_KEY },
      signal: AbortSignal.timeout(STREAMER_WAIT_MS),
    });
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

// ── 歌词 ─────────────────────────────────────────────────────────

// 先看数据库；没有（或者上次没找到、到了该再找的时候）就去外面找，找到什么都存起来。
// 外面两边都出错时，有旧结果就先给旧的，没有就 503
async function lyrics(env, id) {
  const L = lib(env);
  let row = await L.getLyrics(id);
  if (!row || (row.retry_at && row.retry_at < Date.now())) {
    const rec = await getRec(env, id);
    if (!rec) throw new HttpError(404, '没有这首歌');
    const found = await findLyrics(summary(rec));
    if (found) row = await L.putLyrics(id, found.src, found.lrc, found.retryAt);
    else if (!row) throw new HttpError(503, '歌词暂时取不到', { 'Retry-After': '60' });
  }
  const { synced, lines } = parseLrc(row.lrc);
  return new Response(JSON.stringify({ src: lines.length ? row.src : 'none', synced, lines }), {
    headers: cors({ 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'public, max-age=300' }),
  });
}

// 先找「时间轴对得上」的：LRCLIB 优先，没有再问网易云。都没有就退一步，用同一首歌别的版本的歌词，
// 只显示文字、不跟着滚。返回 { src, lrc, retryAt }（retryAt 为 0 表示不用再找）；两边都出错返回 null
async function findLyrics(t) {
  if (!t.title) return { src: 'none', lrc: '', retryAt: 0 };
  const a = await fromLrclib(t).catch(() => null);
  if (a && a.synced) return { ...a.synced, retryAt: 0 };
  const b = await fromNetease(t).catch(() => null);
  if (b && b.synced) return { ...b.synced, retryAt: 0 };
  if (!a && !b) return null;
  // 有一边这次出错了：先用着，过一天再找；否则只有文字的 30 天、完全没有的 14 天后再找（歌词库一直在长）
  const soon = !a || !b;
  const plain = (a && a.plain) || (b && b.plain);
  if (plain) return { ...plain, retryAt: Date.now() + (soon ? 1 : 30) * DAY_MS };
  return { src: 'none', lrc: '', retryAt: Date.now() + (soon ? 1 : 14) * DAY_MS };
}

// 返回 { synced, plain }：synced 是时长对得上、带时间轴的；plain 是同一首歌的文字歌词。出错就抛
async function fromLrclib(t) {
  let plain = null;
  for (const title of titlesFor(t.title)) {
    const q = { track_name: title };
    if (t.artist) q.artist_name = t.artist;
    let res = await getJson(LRCLIB + '?' + new URLSearchParams(q), { headers: { 'User-Agent': UA, 'Lrclib-Client': UA } });
    if ((!Array.isArray(res) || !res.length) && t.artist) {
      res = await getJson(LRCLIB + '?' + new URLSearchParams({ q: title + ' ' + t.artist }), { headers: { 'User-Agent': UA, 'Lrclib-Client': UA } });
    }
    const want = norm(cleanTitle(title));
    const hits = (Array.isArray(res) ? res : [])
      .filter(r => want && norm(r.trackName).includes(want) && !r.instrumental && sameArtist(t.artist, r.artistName))
      .map(r => ({ r, diff: Math.abs((r.duration || 0) - t.duration) }))
      .sort((x, y) => x.diff - y.diff);
    for (const { r, diff } of hits) {
      if (diff <= LYRICS_SLACK_S && isSynced(r.syncedLyrics)) return { synced: { src: 'lrclib', lrc: r.syncedLyrics }, plain: null };
      if (!plain) {
        const words = r.plainLyrics || plainText(r.syncedLyrics);
        if (words && words.trim()) plain = { src: 'lrclib', lrc: words };
      }
    }
  }
  return { synced: null, plain };
}

// 网易云：搜歌（按歌名、歌手筛，时长最接近的两首），再取歌词
async function fromNetease(t) {
  const headers = { 'User-Agent': UA, Referer: 'https://music.163.com/' };
  let plain = null;
  for (const title of titlesFor(t.title)) {
    const body = new URLSearchParams({ s: (title + ' ' + t.artist).trim(), type: '1', limit: '10', offset: '0' });
    const j = await getJson(NETEASE + '/cloudsearch/pc', { method: 'POST', body, headers });
    const want = norm(cleanTitle(title));
    const picks = ((j && j.result && j.result.songs) || [])
      .filter(s => want && norm(s.name).includes(want) && (!t.artist || (s.ar || []).some(a => sameArtist(t.artist, a.name))))
      .map(s => ({ id: s.id, diff: Math.abs((s.dt || 0) / 1000 - t.duration) }))
      .sort((x, y) => x.diff - y.diff)
      .slice(0, 2);
    for (const p of picks) {
      const lj = await getJson(`${NETEASE}/song/lyric?id=${encodeURIComponent(p.id)}&lv=1&kv=1&tv=-1`, { headers });
      const lrc = (lj && lj.lrc && lj.lrc.lyric) || '';
      const words = plainText(lrc);
      if (!words.trim() || /^纯音乐，请欣赏/.test(words.trim())) continue;
      if (p.diff <= LYRICS_SLACK_S && isSynced(lrc)) return { synced: { src: 'netease', lrc }, plain: null };
      if (!plain) plain = { src: 'netease', lrc: words };
    }
  }
  return { synced: null, plain };
}

async function getJson(url, init) {
  const res = await fetch(url, { ...init, signal: AbortSignal.timeout(LYRICS_WAIT_MS) });
  if (res.status === 404) {
    if (res.body) await res.body.cancel();
    return null;
  }
  if (!res.ok) {
    if (res.body) await res.body.cancel();
    throw new Error(`${url.split('?')[0]} → ${res.status}`);
  }
  return res.json();
}

// 先用完整歌名找，再用去掉「(DJ版)」「(Live)」之类版本说明的歌名找
function titlesFor(title) {
  return [...new Set([title, cleanTitle(title)])];
}

const VARIANT = /dj|版|remix|live|伴奏|加速|降调|0\.\d+x|抖音|片段|翻自|cover/i;
function cleanTitle(title) {
  let t = title.replace(/[(（[【][^)）\]】]*[)）\]】]/g, '');
  if (VARIANT.test(t)) t = t.replace(/\s*[-—].*$/, '');
  return t.trim() || title;
}

// 比较歌名、歌手时只看字母、数字和汉字
function norm(s) {
  return String(s || '').toLowerCase().replace(/[^\p{L}\p{N}]+/gu, '');
}

// 我们这边的歌手可能是几个人（「A&B」「A、B」）；有一个对得上就算。我们这边没写歌手就不查
function sameArtist(ours, theirs) {
  const parts = String(ours || '').split(/[&、/,，]| x | feat\.? /).map(norm).filter(Boolean);
  if (!parts.length) return true;
  const th = norm(theirs);
  return !!th && parts.some(p => p.includes(th) || th.includes(p));
}

// 至少 5 句带时间、有字的歌词，才算真有时间轴
function isSynced(lrc) {
  const { synced, lines } = parseLrc(lrc);
  return synced && lines.filter(l => l[1]).length >= 5;
}

function plainText(lrc) {
  return parseLrc(lrc).lines.map(l => l[1]).join('\n').replace(/\n{3,}/g, '\n\n').trim();
}

// 解析 LRC，返回 { synced, lines: [[秒, 这句歌词], ...] }，按时间排好；没有时间轴时秒是 null。
// 认得：一行多个时间 [00:12.00][01:30.00]、[offset:毫秒]、逐字时间 <00:12.34>（去掉）、
// [ti:] [ar:] 之类的标签（跳过）、网易云开头几行 JSON 格式的演职员信息
function parseLrc(text) {
  const timed = [], plain = [];
  let offset = 0;
  for (const raw of String(text || '').replace(/^\uFEFF/, '').split(/\r\n|\r|\n/)) {
    const line = raw.trim();
    if (!line) continue;
    if (line.startsWith('{')) {
      try {
        const j = JSON.parse(line); // {"t":毫秒,"c":[{"tx":"作词: "},{"tx":"某某"}]}
        if (Number.isFinite(j.t) && Array.isArray(j.c)) timed.push([j.t / 1000, j.c.map(c => (c && c.tx) || '').join('').trim()]);
      } catch {
        plain.push(line);
      }
      continue;
    }
    const off = /^\[offset:\s*([+-]?\d+)\s*\]$/i.exec(line);
    if (off) {
      offset = Number(off[1]) / 1000; // 正数表示歌词整体提前
      continue;
    }
    const times = [];
    let rest = line, m;
    while ((m = /^\[(\d{1,3}):(\d{1,2})(?:[.:](\d{1,3}))?\]/.exec(rest))) {
      times.push(Number(m[1]) * 60 + Number(m[2]) + (m[3] ? Number('0.' + m[3]) : 0));
      rest = rest.slice(m[0].length);
    }
    const words = rest.replace(/<\d{1,3}:\d{1,2}(?:[.:]\d{1,3})?>/g, '').trim();
    if (times.length) for (const t of times) timed.push([t, words]);
    else if (!/^\[[a-z#]+:[^\]]*\]$/i.test(line)) plain.push(words);
  }
  if (timed.some(l => l[1])) {
    const lines = timed.map(([t, w]) => [Math.max(0, Math.round((t - offset) * 100) / 100), w]).sort((a, b) => a[0] - b[0]);
    return { synced: true, lines };
  }
  return { synced: false, lines: plain.filter(Boolean).map(w => [null, w]) };
}

// 频道里回复某首歌发一个 .lrc 文件，就是这首的歌词（优先于自动找到的）。
// 没有回复具体哪首时按文件名找（「歌名.lrc」或「歌手 - 歌名.lrc」），只有唯一一首对得上才算
async function attachLyrics(env, post) {
  const doc = post.document;
  if (!doc.file_id || (doc.file_size || 0) > LRC_LIMIT) return;
  const L = lib(env);
  const reply = post.reply_to_message && post.reply_to_message.message_id;
  const id = Number.isInteger(reply) && (await L.getTrack(reply)) ? reply : await trackByFileName(env, doc.file_name);
  if (!id) return;
  const res = await fetchFile(env, doc.file_id, null);
  if (!res.ok) {
    if (res.body) await res.body.cancel();
    return;
  }
  const lrc = decodeText(new Uint8Array(await res.arrayBuffer()));
  if (parseLrc(lrc).lines.length) await L.putLyrics(id, 'manual', lrc, 0);
}

async function trackByFileName(env, fileName) {
  const base = norm(stripExt(fileName));
  if (!base) return null;
  const hits = (await lib(env).listTracks()).filter(t => {
    const title = norm(t.title), artist = norm(t.artist);
    return base === title || (artist && (base === artist + title || base === title + artist));
  });
  return hits.length === 1 ? hits[0].id : null;
}

// .lrc 多是 UTF-8，也有不少老的中文歌词是 GBK，偶尔还有 Windows 记事本存的 UTF-16
function decodeText(bytes) {
  if (bytes[0] === 0xff && bytes[1] === 0xfe) return new TextDecoder('utf-16le').decode(bytes);
  if (bytes[0] === 0xfe && bytes[1] === 0xff) return new TextDecoder('utf-16be').decode(bytes);
  try {
    return new TextDecoder('utf-8', { fatal: true }).decode(bytes);
  } catch {
    // 不是 UTF-8
  }
  try {
    return new TextDecoder('gb18030').decode(bytes);
  } catch {
    return new TextDecoder().decode(bytes);
  }
}

// ── 刷视频网页：视频池、视频流、封面 ───────────────────────────────────
// 视频池是视频频道「小橘视频」里的视频帖：webhook 收到新帖马上登记；机器人自己转过去的帖子（发视频文件点「转到视频频道」）
// webhook 收不到，更早的帖子也是，所以有人打开网页时，离上次超过 30 分钟就请流式服务把频道翻一遍（GET /videos），
// 补上没登记的、去掉频道里删了的。播放时流式服务说这条没了（404 gone），也马上去掉

async function videoList(env, ctx) {
  const L = lib(env), now = Date.now();
  // 该和频道对一遍了：在后台对（「该不该对、记下开始对了」在 Durable Object 里一步做完，同时打开的人不会各对一遍）
  if (streamerOn(env) && env.VIDEO_CHANNEL_ID && (await L.claimVideoSync(now, VIDEO_SYNC_MS))) {
    const sync = syncVideos(env, now).catch(() => {});
    if (ctx && ctx.waitUntil) ctx.waitUntil(sync); else await sync;
    videoListCache = null;
  }
  if (!videoListCache || videoListCache.exp < now) {
    const at = Number(await L.getConfig('vSyncAt')) || 0;
    // 正在对（第一次打开时视频池还是空的）：网页看到 syncing 就过几秒再来要；上次没对成，error 是原因
    const syncing = Date.now() - at < VIDEO_SYNC_WAIT_MS && !(Number(await L.getConfig('vSyncOk')) >= at);
    const error = (await L.getConfig('vSyncErr')) || '';
    videoListCache = { body: JSON.stringify({ videos: await L.listVideos(), syncing, error }), exp: now + LIST_TTL_MS };
  }
  return new Response(videoListCache.body, {
    headers: cors({ 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store' }),
  });
}

// started：videoList 已经记下的开始时间；管理接口手动对的时候不带
async function syncVideos(env, started) {
  if (!streamerOn(env) || !env.VIDEO_CHANNEL_ID) return { ok: false, why: '没配置视频频道或流式服务' };
  const L = lib(env);
  if (!started) await L.setConfig('vSyncAt', String((started = Date.now())));
  const fail = async why => {
    await L.setConfig('vSyncAt', String(started - VIDEO_SYNC_MS + VIDEO_SYNC_RETRY_MS)); // 过两分钟再试
    await L.setConfig('vSyncErr', why);
    videoListCache = null;
    return { ok: false, why };
  };
  let res;
  try {
    res = await fetch(`${streamerBase(env)}/videos?target=${encodeURIComponent(env.VIDEO_CHANNEL_ID)}`, {
      headers: { 'X-Key': env.STREAMER_KEY },
      signal: AbortSignal.timeout(VIDEO_SYNC_WAIT_MS),
    });
  } catch {
    return fail('流式服务没连上（可能在休眠，过两分钟再试）');
  }
  const j = res.ok ? await res.json().catch(() => null) : null;
  if (!j || !Array.isArray(j.videos)) {
    if (!res.bodyUsed && res.body) await res.body.cancel();
    return fail(`流式服务没给视频列表（${res.status}）`);
  }
  const list = j.videos.map(scannedVideo).filter(Boolean);
  const r = await L.syncVideos(list, j.complete !== false);
  await L.setConfig('vSyncOk', String(Date.now()));
  await L.setConfig('vSyncErr', '');
  videoRecCache.clear();
  videoListCache = null;
  return { ok: true, ...r };
}

// 流式服务翻出来的一行（MTProto 没有 Bot API 的 file_id，Library 会沿用 webhook 记下的）
function scannedVideo(v) {
  if (!v || !Number.isInteger(v.id) || v.id <= 0) return null;
  const int = x => (Number.isFinite(x) && x > 0 ? Math.round(x) : 0);
  return {
    id: v.id, file_id: '', file_unique_id: '', thumb: '',
    mime: /^video\/[\w.+-]+$/.test(v.mime || '') ? v.mime : 'video/mp4',
    size: int(v.size), duration: int(v.duration), w: int(v.w), h: int(v.h), date: int(v.date),
    caption: String(v.text || '').trim(),
  };
}

// 抖音转来的帖子说明是「文案\n\n📹 抖音 #账号标签 · 2026-09-30\n原视频链接」（没标签的是 @作者），
// 拆成文案、账号、日期给网页；别的视频（频道主自己发的）整段当文案
function videoCaption(caption) {
  const lines = String(caption || '').split('\n');
  for (let i = lines.length - 1; i >= Math.max(0, lines.length - 3); i--) {
    const m = /^(?:📹|🖼) 抖音(?: [#@](.+?))?(?: · (\d{4}-\d{2}-\d{2}))?$/.exec(lines[i].trim());
    if (m) return { by: (m[1] || '').trim(), day: m[2] || '', text: lines.slice(0, i).join('\n').trim() };
  }
  return { by: '', day: '', text: String(caption || '').trim() };
}

// 网页上的一条：id、秒数、宽高、日期、账号、文案。file_id 不给出去
function videoSummary(v) {
  const c = videoCaption(v.caption);
  const day = c.day || (v.date ? new Date((v.date + 8 * 3600) * 1000).toISOString().slice(0, 10) : '');
  return { id: v.id, d: v.duration || 0, w: v.w || 0, h: v.h || 0, day, by: c.by, text: c.text.slice(0, 300) };
}

async function getVideoRec(env, id) {
  const hit = videoRecCache.get(id);
  if (hit && hit.exp > Date.now()) return hit.rec;
  const rec = await lib(env).getVideo(id);
  if (videoRecCache.size > 500) videoRecCache.clear();
  videoRecCache.set(id, { rec, exp: Date.now() + REC_TTL_MS });
  return rec;
}

function forgetVideo(id) {
  videoRecCache.delete(id);
  videoListCache = null;
}

async function videoFile(request, env, id) {
  const rec = await getVideoRec(env, id);
  if (!rec) throw new HttpError(404, '没有这个视频');
  const viaBot = !!rec.file_id && rec.size > 0 && rec.size <= BOT_DOWNLOAD_LIMIT;
  if (!viaBot && !streamerOn(env)) throw new HttpError(503, '这个视频超过 20 MB，暂时不能在网页播放');
  const headers = cors({ 'Content-Type': rec.mime || 'video/mp4', 'Accept-Ranges': 'bytes', 'Cache-Control': 'public, max-age=86400' });
  if (request.method === 'HEAD') {
    if (rec.size) headers['Content-Length'] = String(rec.size);
    return new Response(null, { headers });
  }
  if (!rec.size) {
    if (rec.file_id) return await passthrough(request, env, rec, headers);
    throw new HttpError(502, MSG.unavailable);
  }
  const range = parseRange(request.headers.get('Range'), rec.size);
  if (!range) {
    return new Response(null, { status: 416, headers: { ...headers, 'Content-Range': `bytes */${rec.size}`, 'Cache-Control': 'no-store' } });
  }
  headers['Content-Length'] = String(range.end - range.start + 1);
  if (range.partial) headers['Content-Range'] = `bytes ${range.start}-${range.end}/${rec.size}`;
  const viaStreamer = () => fromStreamer(env, rec, range, `/vstream/${rec.id}?target=${encodeURIComponent(env.VIDEO_CHANNEL_ID)}`);
  let res;
  try {
    // Bot API 取不到（file_id 失效之类）就改走流式服务
    res = viaBot ? await fromBotApi(env, rec, range).catch(e => (streamerOn(env) ? viaStreamer() : Promise.reject(e))) : await viaStreamer();
  } catch (e) {
    // 流式服务明确说频道里没这条了：从视频池去掉，网页跳过它
    if (e instanceof HttpError && e.gone) {
      await lib(env).removeVideo(id);
      forgetVideo(id);
      throw new HttpError(404, '频道里找不到这个视频了');
    }
    // 别的 404（Space 还是旧代码、没有 /vstream）不能让网页当成视频没了：当作暂时取不到，网页会重试
    if (e instanceof HttpError && e.status === 404) throw new HttpError(502, MSG.unavailable);
    throw e;
  }
  return new Response(res.body, { status: range.partial ? 206 : 200, headers });
}

// 视频封面：转视频时 ffmpeg 截的第一秒（长边 320）。取一次就存进数据库
async function videoPoster(env, id) {
  const L = lib(env);
  let c = await L.getVideoThumb(id);
  if (!c) {
    const rec = await getVideoRec(env, id);
    if (!rec) throw new HttpError(404, '没有这个视频');
    const got = await fetchVideoThumb(env, rec);
    if (!got) throw new HttpError(503, '封面暂时取不到', { 'Retry-After': '60' });
    c = got === 'none' ? { none: true } : { mime: got.mime, b64: toBase64(got.data) };
    await L.putVideoThumb(id, c.none ? 'none' : c.mime, c.none ? '' : c.b64);
  }
  if (c.none) throw new HttpError(404, '这个视频没有封面', { 'Cache-Control': 'public, max-age=86400' });
  return new Response(fromBase64(c.b64), {
    headers: cors({ 'Content-Type': c.mime, 'Cache-Control': 'public, max-age=604800' }),
  });
}

// 有 Bot API 的缩略图 file_id 先用它；没有（或取不到）请流式服务取。确定没有 → 'none'，暂时取不到 → null
async function fetchVideoThumb(env, rec) {
  if (rec.thumb) {
    try {
      const img = await imageFrom(await fetchFile(env, rec.thumb, null), 'image/jpeg');
      if (img) return img;
    } catch {
      // file_id 失效之类：下面改请流式服务取
    }
  }
  if (!streamerOn(env)) return rec.thumb ? null : 'none';
  try {
    const res = await fetch(`${streamerBase(env)}/vthumb/${rec.id}?target=${encodeURIComponent(env.VIDEO_CHANNEL_ID)}`, {
      headers: { 'X-Key': env.STREAMER_KEY },
      signal: AbortSignal.timeout(STREAMER_WAIT_MS),
    });
    if (res.status === 404) {
      const j = await res.json().catch(() => null);
      return j && (j.detail === 'no thumb' || j.detail === 'gone') ? 'none' : null; // 别的 404（旧版流式服务没这个接口）不算
    }
    return await imageFrom(res, null);
  } catch {
    return null;
  }
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

async function fromStreamer(env, rec, range, path = `/stream/${rec.id}`) {
  const want = upstreamRange(rec, range);
  const headers = { 'X-Key': env.STREAMER_KEY };
  if (want) headers.Range = want;
  // 只限制等响应头的时间；拿到响应头后就不再计时，长歌可以一直传下去
  const abort = new AbortController();
  const timer = setTimeout(() => abort.abort(), STREAMER_WAIT_MS);
  let res;
  try {
    res = await fetch(`${streamerBase(env)}${path}`, { headers, signal: abort.signal });
  } catch {
    throw waking();
  } finally {
    clearTimeout(timer);
  }
  if (bodyMatches(res, want, range, true)) return res;
  if (res.status === 404) {
    const j = await res.json().catch(() => null);
    const e = new HttpError(404, MSG.gone);
    e.gone = !!j && j.detail === 'gone'; // 流式服务自己说的「频道里没这条」；Space 没有这个接口的 404 不算
    throw e;
  }
  if (res.body) res.body.cancel();
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
      // 频道里的图片帖；file_id 为空的是流式服务扫出来的老帖，要请它下载
      this.sql.exec("CREATE TABLE IF NOT EXISTS photos (id INTEGER PRIMARY KEY, file_id TEXT NOT NULL DEFAULT '')");
      // 歌词：src 是 lrclib / netease / manual（频道里手动发的）/ none（确定没有）；lrc 是原文；
      // retry_at 不为 0 时，过了这个时间要再去外面找一次
      this.sql.exec('CREATE TABLE IF NOT EXISTS lyrics (id INTEGER PRIMARY KEY, src TEXT NOT NULL, lrc TEXT NOT NULL, retry_at INTEGER NOT NULL DEFAULT 0)');
      // 管理员编的歌单：pos 是在歌单列表里的顺序，tracks 是消息号数组（JSON），按歌单里的顺序
      this.sql.exec('CREATE TABLE IF NOT EXISTS playlists (id INTEGER PRIMARY KEY, pos INTEGER NOT NULL, name TEXT NOT NULL, cover INTEGER NOT NULL DEFAULT 0, tracks TEXT NOT NULL)');
      // 别的频道的台标：搬来的歌自带的「封面」常是那个频道的标志，好多首共用同一张。记下来的图不再当封面
      this.sql.exec('CREATE TABLE IF NOT EXISTS logo_covers (data TEXT PRIMARY KEY)');
      // 音柱数据：base64；空字符串表示确定算不了
      this.sql.exec('CREATE TABLE IF NOT EXISTS viz (id INTEGER PRIMARY KEY, data TEXT NOT NULL)');
      // 听众求歌的记录（限次用）
      this.sql.exec('CREATE TABLE IF NOT EXISTS asks (uid INTEGER NOT NULL, at INTEGER NOT NULL)');
      // 交给流式服务、还没转完的抖音任务：任务说明在 config 的 dyResume，导入任务的作品数据在这里（云电脑送一批是一批；
      // 一批太大拆成几段，batch 相同）。流式服务重启后照原样再交一次
      this.sql.exec('CREATE TABLE IF NOT EXISTS dy_resume (seq INTEGER PRIMARY KEY, batch INTEGER NOT NULL, body TEXT NOT NULL)');
      // 内容过滤规则：全部由管理员在管理页里加、改、删、开关（机器人自己不加、不改）。words 是 JSON 数组
      this.sql.exec('CREATE TABLE IF NOT EXISTS filter_rules (id INTEGER PRIMARY KEY, name TEXT NOT NULL, words TEXT NOT NULL, scope TEXT NOT NULL, action TEXT NOT NULL, enabled INTEGER NOT NULL, updated INTEGER NOT NULL)');
      // 每次按规则过滤、标记的记录：命中哪条规则、哪个词、在哪一步、是哪条作品（或哪个搜索词）
      this.sql.exec('CREATE TABLE IF NOT EXISTS filter_log (id INTEGER PRIMARY KEY, at INTEGER NOT NULL, rule_id TEXT NOT NULL, rule_name TEXT NOT NULL, word TEXT NOT NULL, stage TEXT NOT NULL, result TEXT NOT NULL, subject TEXT NOT NULL, text TEXT NOT NULL)');
      // 刷视频网页的视频池：视频频道「小橘视频」里的视频帖，rec 是完整记录（含 Bot API 的 file_id）
      this.sql.exec('CREATE TABLE IF NOT EXISTS videos (id INTEGER PRIMARY KEY, rec TEXT NOT NULL, updated INTEGER NOT NULL)');
      // 视频封面（base64；mime 为 'none' 表示确定没有）
      this.sql.exec('CREATE TABLE IF NOT EXISTS video_thumbs (id INTEGER PRIMARY KEY, mime TEXT NOT NULL, data TEXT NOT NULL)');
      this.dropSplitterLeftovers();
      const coversV = this.cfg('coversV');
      // 以前没封面的歌记成了「没有」；现在改用频道图片，清掉这些记号让它们重新配图
      if (coversV !== '2' && coversV !== '3') this.sql.exec("DELETE FROM covers WHERE mime = 'none'");
      // 已经存下的台标封面：找出来记住，这些歌重新配图
      if (coversV !== '3') {
        const shared = this.sql.exec(`SELECT data FROM covers WHERE mime != 'none' GROUP BY data HAVING COUNT(*) >= ${LOGO_MIN_SONGS}`).toArray();
        for (const r of shared) this.markLogo(r.data);
        this.setCfg('coversV', '3');
      }
      // own：这张封面是不是歌自己带的（1）还是配的频道图片（0）。加这一列之前存的按下面的规则补：
      // 语音、确定没缩略图的 → 频道图片；有缩略图 file_id 的 → 自带；更早登记、说不清的删掉，下次请求时重新判断
      if (!this.sql.exec('PRAGMA table_info(covers)').toArray().some(r => r.name === 'own')) {
        this.sql.exec('ALTER TABLE covers ADD COLUMN own INTEGER NOT NULL DEFAULT 1');
        for (const r of this.sql.exec("SELECT s.id, s.rec FROM songs s JOIN covers c ON c.id = s.id WHERE c.mime != 'none'").toArray()) {
          const rec = JSON.parse(r.rec);
          if (rec.kind === 'voice' || rec.thumb === '') this.sql.exec('UPDATE covers SET own = 0 WHERE id = ?', r.id);
          else if (!rec.thumb) this.sql.exec('DELETE FROM covers WHERE id = ?', r.id);
        }
      }
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

  // art：这首有没有自己的专辑图（1 有 / 0 没有），封面还没判断过的不带。网页据此直接画文字封面，不用一首首去试
  async listTracks() {
    return this.sql.exec('SELECT s.rec, c.mime, c.own FROM songs s LEFT JOIN covers c ON c.id = s.id ORDER BY s.id DESC').toArray().map(r => {
      const t = summary(JSON.parse(r.rec));
      if (r.mime != null) t.art = r.mime !== 'none' && r.own ? 1 : 0;
      return t;
    });
  }

  // 歌单里有没有同一首歌（按整理后的歌名、歌手比，时长相差 3 秒以内；时长不知道的也算）
  async findSame(rec) {
    const want = summary(rec);
    const key = norm(want.title) + '|' + norm(want.artist);
    for (const r of this.sql.exec('SELECT rec FROM songs WHERE id != ?', rec.id).toArray()) {
      const t = summary(JSON.parse(r.rec));
      if (norm(t.title) + '|' + norm(t.artist) === key && (!t.duration || !want.duration || Math.abs(t.duration - want.duration) <= 3)) return t.id;
    }
    return null;
  }

  async getTrack(id) {
    const r = this.sql.exec('SELECT rec FROM songs WHERE id = ?', id).toArray()[0];
    return r ? JSON.parse(r.rec) : null;
  }

  // 返回这首是不是第一次登记
  async upsertTrack(rec) {
    const old = await this.getTrack(rec.id);
    // 帖子里换了文件，旧封面、旧歌词、旧音柱数据就作废
    if (!old || old.file_unique_id !== rec.file_unique_id) {
      this.sql.exec('DELETE FROM covers WHERE id = ?', rec.id);
      this.sql.exec('DELETE FROM lyrics WHERE id = ?', rec.id);
      this.sql.exec('DELETE FROM viz WHERE id = ?', rec.id);
    }
    this.sql.exec(`INSERT INTO songs (id, rec, updated) VALUES (?, ?, ?)
      ON CONFLICT(id) DO UPDATE SET rec = excluded.rec, updated = excluded.updated`,
      rec.id, JSON.stringify(rec), Date.now());
    return !old;
  }

  // 把这首放到这几个歌单的最前面（已经在里面的不动）。返回真正放进去的歌单名
  async addToPlaylists(id, names) {
    const done = [];
    for (const p of await this.listPlaylists()) {
      if (!names.includes(p.name) || p.tracks.includes(id)) continue;
      this.sql.exec('UPDATE playlists SET tracks = ? WHERE id = ?', JSON.stringify([id, ...p.tracks]), p.id);
      done.push(p.name);
    }
    return done;
  }

  async removeFromPlaylist(id, name) {
    const p = (await this.listPlaylists()).find(x => x.name === name);
    if (!p || !p.tracks.includes(id)) return false;
    this.sql.exec('UPDATE playlists SET tracks = ? WHERE id = ?', JSON.stringify(p.tracks.filter(x => x !== id)), p.id);
    return true;
  }

  async removeTrack(id) {
    this.sql.exec('DELETE FROM songs WHERE id = ?', id);
    this.sql.exec('DELETE FROM covers WHERE id = ?', id);
    this.sql.exec('DELETE FROM lyrics WHERE id = ?', id);
    this.sql.exec('DELETE FROM viz WHERE id = ?', id);
  }

  // ── 视频池 ──
  async listVideos() {
    return this.sql.exec('SELECT rec FROM videos ORDER BY id DESC').toArray().map(r => videoSummary(JSON.parse(r.rec)));
  }

  async getVideo(id) {
    const r = this.sql.exec('SELECT rec FROM videos WHERE id = ?', id).toArray()[0];
    return r ? JSON.parse(r.rec) : null;
  }

  // 返回是不是第一次登记。流式服务翻出来的记录没有 Bot API 的 file_id、缩略图：沿用 webhook 记下的（文件没换的话）
  async upsertVideo(rec) {
    const old = await this.getVideo(rec.id);
    let v = rec;
    if (old) {
      const sameFile = rec.file_unique_id && old.file_unique_id ? rec.file_unique_id === old.file_unique_id : !rec.size || !old.size || rec.size === old.size;
      if (!sameFile) this.sql.exec('DELETE FROM video_thumbs WHERE id = ?', rec.id);
      if (!rec.file_id && sameFile) v = { ...rec, file_id: old.file_id || '', file_unique_id: old.file_unique_id || '', thumb: old.thumb || '' };
    }
    this.sql.exec(`INSERT INTO videos (id, rec, updated) VALUES (?, ?, ?)
      ON CONFLICT(id) DO UPDATE SET rec = excluded.rec, updated = excluded.updated`, rec.id, JSON.stringify(v), Date.now());
    return !old;
  }

  async removeVideo(id) {
    this.sql.exec('DELETE FROM videos WHERE id = ?', id);
    this.sql.exec('DELETE FROM video_thumbs WHERE id = ?', id);
  }

  // 和频道对一遍：list 是频道里现在的视频（新的在前）。complete（翻完了）时，比 list 里最新那条还旧、又不在 list 里的，
  // 是频道里删掉的，从视频池去掉；比它新的是翻完以后才发的帖子（webhook 登记的），不动
  async syncVideos(list, complete) {
    let added = 0, removed = 0;
    for (const rec of list) if (await this.upsertVideo(rec)) added++;
    if (complete && list.length) {
      const keep = new Set(list.map(r => r.id)), top = Math.max(...keep);
      for (const r of this.sql.exec('SELECT id FROM videos WHERE id <= ?', top).toArray()) {
        if (!keep.has(r.id)) { await this.removeVideo(r.id); removed++; }
      }
    }
    const total = this.sql.exec('SELECT COUNT(*) AS n FROM videos').toArray()[0].n;
    return { added, removed, total };
  }

  async getVideoThumb(id) {
    const r = this.sql.exec('SELECT mime, data FROM video_thumbs WHERE id = ?', id).toArray()[0];
    if (!r) return null;
    return r.mime === 'none' ? { none: true } : { mime: r.mime, b64: r.data };
  }

  // 离上次开始对超过 every 毫秒：记下现在开始对，返回 true；否则 false（中间没有 await，不会两个请求都拿到 true）
  async claimVideoSync(now, every) {
    if (now - (Number(this.cfg('vSyncAt')) || 0) < every) return false;
    this.setCfg('vSyncAt', String(now));
    return true;
  }

  async putVideoThumb(id, mime, data) {
    // 视频还在池里才存（取封面的时候帖子可能刚被删）
    if (!this.sql.exec('SELECT 1 FROM videos WHERE id = ?', id).toArray().length) return;
    this.sql.exec(`INSERT INTO video_thumbs (id, mime, data) VALUES (?, ?, ?)
      ON CONFLICT(id) DO UPDATE SET mime = excluded.mime, data = excluded.data`, id, mime, data);
  }

  // 贴网址搬运的设置：开着的网站、接受的授权、每次最多几首、放进哪个歌单（空 = 按类型分）
  async getHarvest() {
    return { sites: ['archive', 'commons'], licenses: ['cc0', 'pd', 'by', 'by-sa', 'by-nc', 'by-nc-sa', 'by-nd', 'by-nc-nd'],
      limit: 20, playlist: '', ...JSON.parse(this.cfg('harvest') || '{}') };
  }
  async setHarvest(v) { this.setCfg('harvest', JSON.stringify(v)); }

  async getConfig(k) { return this.cfg(k); }

  // ── 内容过滤规则（见 filterRules）──
  async listFilterRules() {
    return this.sql.exec('SELECT * FROM filter_rules ORDER BY id').toArray().map(r => ({
      id: r.id, name: r.name, words: JSON.parse(r.words), scope: r.scope, action: r.action, enabled: !!r.enabled, updated: r.updated,
    }));
  }

  async saveFilterRule(r) {
    const now = Date.now();
    if (r.id) {
      if (!this.sql.exec('SELECT id FROM filter_rules WHERE id = ?', r.id).toArray().length) return 0;
      this.sql.exec('UPDATE filter_rules SET name = ?, words = ?, scope = ?, action = ?, enabled = ?, updated = ? WHERE id = ?',
        r.name, JSON.stringify(r.words), r.scope, r.action, r.enabled ? 1 : 0, now, r.id);
      return r.id;
    }
    this.sql.exec('INSERT INTO filter_rules (name, words, scope, action, enabled, updated) VALUES (?, ?, ?, ?, ?, ?)',
      r.name, JSON.stringify(r.words), r.scope, r.action, r.enabled ? 1 : 0, now);
    return this.sql.exec('SELECT last_insert_rowid() AS id').toArray()[0].id;
  }

  async deleteFilterRule(id) {
    if (!this.sql.exec('SELECT id FROM filter_rules WHERE id = ?', id).toArray().length) return false;
    this.sql.exec('DELETE FROM filter_rules WHERE id = ?', id);
    return true;
  }

  async logFilter(entries) {
    for (const e of entries) {
      this.sql.exec('INSERT INTO filter_log (at, rule_id, rule_name, word, stage, result, subject, text) VALUES (?, ?, ?, ?, ?, ?, ?, ?)',
        e.at, e.rule_id, e.rule_name, e.word, e.stage, e.result, e.subject, e.text);
    }
    this.sql.exec('DELETE FROM filter_log WHERE id <= (SELECT MAX(id) FROM filter_log) - 2000');
  }

  async listFilterLog(limit) {
    return this.sql.exec('SELECT * FROM filter_log ORDER BY id DESC LIMIT ?', limit).toArray();
  }

  // ── 重启后接着转（见 douyinStart）──
  async resumeStart(rec, text) {
    this.sql.exec('DELETE FROM dy_resume');
    this.setCfg('dyResume', JSON.stringify(rec));
    if (text) this.addResumeBatch(text);
  }

  async resumeAppend(text, final) {
    const rec = this.resumeRec();
    if (!rec) return;
    if (text) this.addResumeBatch(text);
    if (final) { rec.final = true; this.setCfg('dyResume', JSON.stringify(rec)); }
  }

  async resumeGet() { return this.resumeRec(); }
  async resumeSave(rec) { this.setCfg('dyResume', JSON.stringify(rec)); }

  // 没给编号就直接销；给了编号要对得上（新的任务已经把记录换掉了，旧任务转完不能把新的销掉）
  async resumeClear(runId) {
    const rec = this.resumeRec();
    if (!rec || (runId && rec.run_id !== runId)) return false;
    this.sql.exec('DELETE FROM dy_resume');
    this.sql.exec("DELETE FROM config WHERE k = 'dyResume'");
    return true;
  }

  async resumeBatches() {
    return this.sql.exec('SELECT DISTINCT batch FROM dy_resume ORDER BY batch').toArray().map(r => r.batch);
  }

  async resumeBatch(batch) {
    return this.sql.exec('SELECT body FROM dy_resume WHERE batch = ? ORDER BY seq', batch).toArray().map(r => r.body).join('');
  }

  resumeRec() {
    try { return JSON.parse(this.cfg('dyResume') || 'null'); } catch { return null; }
  }

  addResumeBatch(text) {
    const batch = (this.sql.exec('SELECT MAX(batch) AS b FROM dy_resume').toArray()[0].b ?? -1) + 1;
    for (let i = 0; i < text.length; i += RESUME_PIECE) this.sql.exec('INSERT INTO dy_resume (batch, body) VALUES (?, ?)', batch, text.slice(i, i + RESUME_PIECE));
  }
  async setConfig(k, v) { this.setCfg(k, v); }

  // 夜里自动搬的记录：state 是 {频道: 看到的最大消息号}
  async getAuto() {
    return { state: {}, ...JSON.parse(this.cfg('auto') || '{}') };
  }
  async setAuto(v) { this.setCfg('auto', JSON.stringify(v)); }

  // 听众求歌限次：每人每 24 小时最多 ASK_PER_DAY 次（库里直接有的不算）
  async allowAsk(uid, now) {
    this.sql.exec('DELETE FROM asks WHERE at < ?', now - DAY_MS);
    if (this.sql.exec('SELECT COUNT(*) AS n FROM asks WHERE uid = ?', uid).toArray()[0].n >= ASK_PER_DAY) return false;
    this.sql.exec('INSERT INTO asks (uid, at) VALUES (?, ?)', uid, now);
    return true;
  }

  async getSources() {
    return JSON.parse(this.cfg('sources') || '[]');
  }

  async setSources(list) {
    this.setCfg('sources', JSON.stringify(list));
    return list;
  }

  async listPlaylists() {
    return this.sql.exec('SELECT id, name, cover, tracks FROM playlists ORDER BY pos').toArray()
      .map(r => ({ id: r.id, name: r.name, cover: r.cover, tracks: JSON.parse(r.tracks) }));
  }

  // 整体换掉：给的是 [{ id?, name, cover?, tracks }]，没带 id（或 id 不存在）的是新歌单。
  // 中间没有 await，这一串 SQL 不会被别的请求打断，也会一起写进存储
  async setPlaylists(list) {
    const keep = [];
    list.forEach((p, pos) => {
      const args = [pos, p.name, p.cover || 0, JSON.stringify(p.tracks)];
      const hit = Number.isInteger(p.id)
        ? this.sql.exec('UPDATE playlists SET pos = ?, name = ?, cover = ?, tracks = ? WHERE id = ? RETURNING id', ...args, p.id).toArray()[0]
        : null;
      keep.push(hit ? hit.id : this.sql.exec('INSERT INTO playlists (pos, name, cover, tracks) VALUES (?, ?, ?, ?) RETURNING id', ...args).toArray()[0].id);
    });
    this.sql.exec(`DELETE FROM playlists WHERE id NOT IN (${keep.map(() => '?').join(',') || 'NULL'})`, ...keep);
    return this.listPlaylists();
  }

  async getLyrics(id) {
    return this.sql.exec('SELECT src, lrc, retry_at FROM lyrics WHERE id = ?', id).toArray()[0] || null;
  }

  // 自动找到的结果盖不掉手动配的歌词。返回最后存着的那一行
  async putLyrics(id, src, lrc, retryAt) {
    this.sql.exec(`INSERT INTO lyrics (id, src, lrc, retry_at) VALUES (?, ?, ?, ?)
      ON CONFLICT(id) DO UPDATE SET src = excluded.src, lrc = excluded.lrc, retry_at = excluded.retry_at
      WHERE lyrics.src != 'manual' OR excluded.src = 'manual'`, id, src, lrc, retryAt);
    return this.getLyrics(id);
  }

  // 这张图是不是台标：记下过的，或者已经有 LOGO_MIN_SONGS - 1 首歌用它当封面（同一张专辑的歌共用封面，
  // 不过很少有七八首同专辑的；台标一搬就是几十首）。是的话记下来，用它的歌全部重新配图
  async isLogo(data) {
    if (this.sql.exec('SELECT 1 FROM logo_covers WHERE data = ?', data).toArray().length) return true;
    if (this.sql.exec('SELECT COUNT(*) AS n FROM covers WHERE data = ?', data).toArray()[0].n < LOGO_MIN_SONGS - 1) return false;
    this.markLogo(data);
    return true;
  }

  // 返回受影响的歌有几首（这首没存封面、或者存的是「没有」时为 0）
  // 哪些歌用的是频道图片：语音、确定没有自带缩略图的（thumb 为空字符串）；更早登记、不知道有没有缩略图的，
  // 封面和别的歌一模一样的也算（频道图片是好几首共用的，自带的专辑封面很少重）。返回清掉了几首
  async clearPhotoCovers() {
    const shared = new Set(this.sql.exec(`SELECT data FROM covers WHERE mime != 'none' GROUP BY data HAVING COUNT(*) >= 2`).toArray().map(r => r.data));
    let n = 0;
    for (const r of this.sql.exec("SELECT s.id, s.rec, c.data FROM songs s JOIN covers c ON c.id = s.id WHERE c.mime != 'none'").toArray()) {
      const rec = JSON.parse(r.rec);
      if (rec.kind === 'voice' || rec.thumb === '' || (rec.thumb === undefined && shared.has(r.data))) {
        this.sql.exec('DELETE FROM covers WHERE id = ?', r.id);
        n++;
      }
    }
    return n;
  }

  async banCover(id) {
    const r = this.sql.exec("SELECT data FROM covers WHERE id = ? AND mime != 'none'", id).toArray()[0];
    if (!r) return 0;
    const n = this.sql.exec('SELECT COUNT(*) AS n FROM covers WHERE data = ?', r.data).toArray()[0].n;
    this.markLogo(r.data);
    return n;
  }

  markLogo(data) {
    this.sql.exec('INSERT OR IGNORE INTO logo_covers (data) VALUES (?)', data);
    this.sql.exec('DELETE FROM covers WHERE data = ?', data);
  }

  async getViz(id) {
    const r = this.sql.exec('SELECT data FROM viz WHERE id = ?', id).toArray()[0];
    return r ? r.data : null;
  }

  async putViz(id, data) {
    this.sql.exec('INSERT INTO viz (id, data) VALUES (?, ?) ON CONFLICT(id) DO UPDATE SET data = excluded.data', id, data);
  }

  async getCover(id) {
    const r = this.sql.exec('SELECT mime, data, own FROM covers WHERE id = ?', id).toArray()[0];
    if (!r) return null;
    return r.mime === 'none' ? { none: true } : { mime: r.mime, b64: r.data, own: !!r.own };
  }

  async putCover(id, mime, data, own = 1) {
    this.sql.exec(`INSERT INTO covers (id, mime, data, own) VALUES (?, ?, ?, ?)
      ON CONFLICT(id) DO UPDATE SET mime = excluded.mime, data = excluded.data, own = excluded.own`, id, mime, data, own ? 1 : 0);
  }

  async addPhoto(id, fileId) {
    this.sql.exec('INSERT INTO photos (id, file_id) VALUES (?, ?) ON CONFLICT(id) DO UPDATE SET file_id = excluded.file_id', id, fileId || '');
  }

  async addScannedPhotos(ids) {
    for (const id of ids) this.sql.exec('INSERT OR IGNORE INTO photos (id, file_id) VALUES (?, ?)', id, '');
  }

  async listPhotos() {
    return this.sql.exec('SELECT id, file_id FROM photos').toArray();
  }

  async maxTrackId() {
    const r = this.sql.exec('SELECT MAX(id) AS m FROM songs').toArray()[0];
    return (r && r.m) || 0;
  }

  async getFlag(k) {
    return this.cfg(k) === '1';
  }

  async setFlag(k) {
    this.setCfg(k, '1');
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

// ── 机器人：频道主私聊管理、听众私聊求歌 ─────────────────────────────

async function tg(env, method, payload) {
  const res = await fetch(`${TG}/bot${env.TG_BOT_TOKEN}/${method}`, {
    method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(payload),
  });
  return res.json().catch(() => ({}));
}

function say(env, chatId, textMsg, buttons) {
  const payload = { chat_id: chatId, text: textMsg, disable_web_page_preview: true };
  if (buttons) payload.reply_markup = { inline_keyboard: buttons };
  return tg(env, 'sendMessage', payload);
}

// 频道主：频道的创建者（问一次 Telegram 就记下来）
async function ownerId(env) {
  const L = lib(env);
  let id = await L.getConfig('ownerId');
  if (!id) {
    const r = await tg(env, 'getChatAdministrators', { chat_id: env.CHANNEL_ID });
    const c = (r.result || []).find(a => a.status === 'creator');
    if (c) await L.setConfig('ownerId', (id = String(c.user.id)));
  }
  return id ? Number(id) : null;
}

async function streamerCall(env, path, body) {
  const res = await fetch(`${streamerBase(env)}${path}`, {
    method: body ? 'POST' : 'GET',
    headers: { 'X-Key': env.STREAMER_KEY, 'Content-Type': 'application/json' },
    body: body ? JSON.stringify(body) : undefined,
    signal: AbortSignal.timeout(BOT_WAIT_MS),
  });
  const data = await res.json().catch(() => ({}));
  return { status: res.status, data };
}

// ── 抖音任务：重启后接着转 ──
// 流式服务（Hugging Face Space）一重启（推新代码、平台维护、崩溃），内存里正在转的任务就没了。所以交任务时在这边记一笔
// （任务编号 run_id + 原样的请求；导入任务连作品数据一起），流式服务启动时来 /streamer-up 报到，没转完的就再交一次，
// 频道里已经有的它会跳过。转完或出错它来 /streamer-done 报编号，销掉记录；频道主点停，这边自己销。
// 定时任务也会对一下（报到没送到的话）：流式服务没在跑、手上也不是这个编号的任务 → 再交；是这个编号且已经结束 → 销
const RESUME_PIECE = 300 * 1024;  // 存作品数据时一段最多这么多字（数据库一行有大小上限）
const RESUME_MAX = 3;             // 同一批最多自动接着转几次（老是转到一半就重启，多半是这批本身有问题）

async function douyinStart(env, path, body) {
  const L = lib(env), run_id = crypto.randomUUID().slice(0, 12);
  const r = await streamerCall(env, path, { ...body, run_id });
  if (r.status !== 200) return r;
  const { text, ...rest } = body;
  if (path === '/douyin/import' && !r.data.started) {
    // 送进了正在转的那批（边抓边转），或者是「抓完了」的通知
    await L.resumeAppend(r.data.added ? text : '', body.final !== false);
  } else if (!(path === '/douyin/link' && r.data.kind === 'user')) { // 采集主页链接不算转发，不用接着做
    await L.resumeStart({ path, body: rest, run_id, final: body.final !== false, resumes: 0, at: Date.now() }, path === '/douyin/import' ? text : '');
  }
  return r;
}

async function resumeDouyin(env) {
  if (!streamerOn(env)) return { ok: false, why: 'not configured' };
  const L = lib(env), rec = await L.resumeGet();
  if (!rec) return { ok: true, resumed: false };
  const owner = await ownerId(env);
  if (rec.resumes >= RESUME_MAX) {
    await L.resumeClear(rec.run_id);
    if (owner) await say(env, owner, `⚠️ 小橘的服务重启了 ${RESUME_MAX} 次都没把这批转完，不再自动接着转了。点「📊 进度」看看，需要的话重新发一次命令`);
    return { ok: false, why: 'too many restarts' };
  }
  rec.resumes++;
  await L.resumeSave(rec); // 先记次数：要是这批一转就把服务弄崩，也不会无休止地重来
  let r = null;
  const base = { ...rec.body, run_id: rec.run_id };
  if ('state' in base) base.state = (await L.getConfig('douyinState')) || ''; // 抖音登录状态用最新的
  try {
    if (rec.path === '/douyin/import') {
      const batches = await L.resumeBatches();
      if (!batches.length) { await L.resumeClear(rec.run_id); return { ok: true, resumed: false }; }
      for (let i = 0; i < batches.length; i++) {
        r = await streamerCall(env, rec.path, { ...base, text: await L.resumeBatch(batches[i]), final: i === batches.length - 1 ? rec.final : false });
        if (r.status !== 200) break;
      }
    } else {
      r = await streamerCall(env, rec.path, base);
    }
  } catch {
    r = null;
  }
  if (!r || r.status !== 200) {
    rec.resumes--; // 没交上（服务还没醒、正忙）不算一次，下次再来
    await L.resumeSave(rec);
    return { ok: false, retry: true, why: r ? `status ${r.status}` : 'unreachable' };
  }
  if (owner && !rec.body.quiet) await say(env, owner, '♻️ 小橘的服务刚才重启过，没转完的那批接着转了（已经发进频道的会跳过），转完照常告诉你');
  return { ok: true, resumed: true };
}

// 流式服务来报到（刚启动）/ 报结束（转完、出错）。用同一个 STREAMER_KEY 认人
async function streamerNotice(request, env, ctx, path) {
  if (!env.STREAMER_KEY || !sameString(request.headers.get('X-Key') || '', env.STREAMER_KEY)) return json({ error: 'forbidden' }, 403);
  if (path === '/streamer-done') {
    const body = await request.json().catch(() => ({}));
    return json({ ok: true, cleared: await lib(env).resumeClear(String(body.run_id || '') || 'none') });
  }
  // 等交完再回：没交上（它这边还没完全起来、正忙）就回 retry，它过一会儿再来报到
  const r = await resumeDouyin(env).catch(() => ({ ok: false, retry: true }));
  return json({ ok: true, resumed: !!r.resumed, retry: !!r.retry });
}

// 定时对一下：报到没送到、或者报结束没送到时补上
async function checkResume(env) {
  const L = lib(env), rec = await L.resumeGet();
  if (!rec) return;
  let st;
  try { st = (await streamerCall(env, '/douyin/status')).data; } catch { return; }
  if (!st || st.status === 'running') return;
  if (st.run_id === rec.run_id) return void (await L.resumeClear(rec.run_id)); // 这个任务已经结束了
  return resumeDouyin(env);
}

const HELP = `我是小橘音乐的管理助手 🍊 常用的点下面的按钮；左下角「菜单」里也有。全部功能：

▶️ 运行爬虫
运行爬虫 —— 让云电脑抓你登记过的抖音号的新作品（云电脑开机不会自己抓，点了才抓；没开的话下次打开时抓）

📊 进度
进度 —— 云电脑抓到哪了（每个号一共多少、抓了多少、送了多少）、小橘转了多少；可以点按钮停下

🎬 抖音（视频频道「小橘视频」）
转抖音视频 —— 把你自己抖音账号的作品（视频和图文）都转进视频频道，已有的跳过
云电脑 —— 打开云电脑的链接：在云电脑上登录抖音；点「▶️ 运行爬虫」才抓你所有账号的作品，按最高画质边抓边转进频道
添加抖音账号 主页分享链接 —— 再加一个你自己的号（小号），转作品、自动同步都会带上它
账号标签 —— 每个号在频道里的标签（点标签只看这个号）；「账号标签 2 小美」给第 2 个号改名
抖音自动同步 开 / 关 —— 每 30 分钟看一次你的抖音公开主页，有新作品自动转进频道
刷视频网页：https://xiaoju-music.langhua98.workers.dev/video —— 随机刷「小橘视频」里的视频（上滑下一条、下滑回上一条），有链接的人都能看
抖音视频的分享链接 —— 把这条转进视频频道
抖音主页的分享链接 —— 把这个号作品的链接整理给你
发一个视频文件 —— 点按钮转进视频频道

🔎 抖音搜索
搜抖音 舞蹈 —— 让云电脑在抖音里搜这个词（默认 100 条；「搜抖音 舞蹈 300」搜 300 条，最多 500），结果按点赞排好私聊发你（链接、文件地址）；搜完完整清单交给审核机器人，你在那里审核通过才转进视频频道
审核 —— 审核机器人接好没有、哪些审核单在等你；「审核机器人 令牌」接上审核机器人（令牌在 @BotFather 里拿）
搜抖音 —— 看还有哪些词排着队；「搜抖音 清空」清掉

🎵 音乐（小橘音乐）
搜 歌名或歌手 —— 去来源频道里找，点按钮就搬
搬 @频道名 100 —— 从这个频道搬 100 首中文歌（查重），搬完告诉你
找 歌名 —— 在小橘音乐里找这首，可以加进/移出歌单、删除
统计 —— 歌库和这几天搬歌的情况
贴一个网址 —— 搬这个页面里允许转载的音频（每首都检查授权），后面可以加数量，比如「网址 30」
搬运设置 —— 选网站、接受哪些授权、每次搬几首、搬到哪个歌单
直接发歌名 —— 和听众一样找这首歌，库里没有就自动搬进来（新歌按类型自动进歌单）`;

const PUBLIC_HELP = `你好，这里是小橘音乐 🍊
发一个歌名给我（可以加上歌手名），我帮你找。找到了会给你一个链接，点开就能听。`;

const tooLong = s => s.length > 60;

// 频道主的菜单：输入框下面常驻的按钮（点了等于发对应的文字），和左下角「菜单」里的 / 命令
const OWNER_KEYBOARD = {
  keyboard: [['▶️ 运行爬虫', '📊 进度', '🎬 转抖音视频'], ['🔎 搜抖音', '🏷 账号标签'], ['☁️ 云电脑', '📈 统计'], ['🎵 搬运设置', '❓ 帮助']],
  resize_keyboard: true, is_persistent: true,
};
const OWNER_COMMANDS = [
  ['crawl', '▶️ 运行爬虫：云电脑抓你登记过的抖音号'],
  ['progress', '📊 进度：云电脑抓到哪、小橘转了多少，可以停下'],
  ['douyin', '🎬 把你抖音号的作品转进视频频道'],
  ['cloud', '☁️ 云电脑：抓你所有账号的全部作品（最高画质）'],
  ['search', '🔎 抖音搜索（发「搜抖音 关键词」）'],
  ['tags', '🏷 账号标签：频道里按账号分类'],
  ['stats', '📈 歌库和搬歌统计'],
  ['harvest', '🎵 搬运设置'],
  ['help', '❓ 全部功能'],
];
const OWNER_ALIAS = {
  '▶️ 运行爬虫': '运行爬虫', '📊 进度': '进度', '🎬 转抖音视频': '转抖音视频', '🔎 搜抖音': '搜抖音', '🏷 账号标签': '账号标签', '☁️ 云电脑': '云电脑',
  '📈 统计': '统计', '🎵 搬运设置': '搬运设置', '❓ 帮助': '帮助',
  '/crawl': '运行爬虫', '/progress': '进度', '/douyin': '转抖音视频', '/cloud': '云电脑', '/search': '搜抖音', '/tags': '账号标签',
  '/stats': '统计', '/harvest': '搬运设置',
};
const COMMANDS_VERSION = '2';

// 频道主的「菜单」命令只设给频道主自己看（听众那边不变）；版本变了才重设
async function ensureOwnerCommands(env, owner) {
  const L = lib(env);
  if ((await L.getConfig('cmdsVer')) === COMMANDS_VERSION) return;
  const r = await tg(env, 'setMyCommands', {
    commands: OWNER_COMMANDS.map(([command, description]) => ({ command, description })),
    scope: { type: 'chat', chat_id: owner },
  });
  if (r.ok) await L.setConfig('cmdsVer', COMMANDS_VERSION);
}

function ownerHelp(env, chat) {
  return tg(env, 'sendMessage', { chat_id: chat, text: HELP, disable_web_page_preview: true, reply_markup: OWNER_KEYBOARD });
}

async function botUpdate(env, update, origin) {
  const owner = await ownerId(env);
  if (update.callback_query) return botButton(env, update.callback_query, owner, origin);
  const m = update.message;
  const chat = m.chat.id, isOwner = owner && m.from && m.from.id === owner;
  // 频道主发来 MediaCrawler 导出的作品文件（.json / .jsonl）：里面的作品全部转进视频频道
  if (isOwner && m.document && /\.(jsonl?|txt)$/i.test(m.document.file_name || '')) return ownerDouyinImport(env, chat, m.document);
  // 频道主发来视频文件：问一句要不要转到视频频道（不自动发，免得发错）
  if (isOwner && env.VIDEO_CHANNEL_ID && (m.video || (m.document && /^video\//.test(m.document.mime_type || '')))) {
    return say(env, chat, '要把这个视频转到视频频道吗？', [[{ text: '📤 转到视频频道', callback_data: `fv:${m.message_id}` }]]);
  }
  let t = (m.text || '').trim();
  if (isOwner) {
    try { await ensureOwnerCommands(env, owner); } catch {}
    t = t.replace(/^(\/\w+)@\w+/, '$1');  // 群里点菜单会带 @机器人名
    t = OWNER_ALIAS[t] || t;
  }
  if (!t || /^\/(start|help)\b/.test(t) || t === '帮助') return isOwner ? ownerHelp(env, chat) : say(env, chat, PUBLIC_HELP);
  if (isOwner) {
    let c;
    // 「审核机器人 令牌」：令牌前后带着 BotFather 的整段说明也认（直接整条转发过来最省事）
    if (/^审核(?:机器人)?(?:$|[\s\S]*?\b\d{5,15}:[\w-]{30,80}\b)/.test(t)) {
      return ownerVerify(env, chat, m.message_id, (/\b(\d{5,15}:[\w-]{30,80})\b/.exec(t) || [])[1], origin);
    }
    if ((c = /^搜抖音\s*(.*)$/.exec(t))) return ownerDouyinSearch(env, chat, c[1].trim());
    if (/^进度$/.test(t)) return ownerProgress(env, chat);
    if (/^(运行爬虫|开始爬|开始抓|抓作品)$/.test(t)) return ownerCrawlRun(env, chat);
    if ((c = /^搜\s*(.+)$/.exec(t))) return ownerSearch(env, chat, c[1].trim());
    if ((c = /^搬\s*@?(\w{4,64})(?:\s+(\d{1,4}))?\s*(?:首)?$/.exec(t))) return ownerCopy(env, chat, c[1], Number(c[2] || 50));
    if ((c = /^找\s*(.+)$/.exec(t))) return ownerFind(env, chat, c[1].trim(), origin);
    if (/^(统计|今天搬了多少|搬了多少)/.test(t)) return ownerStats(env, chat);
    if (/^云电脑$/.test(t)) return ownerCloud(env, chat);
    if (/^添加抖音账号/.test(t)) return ownerDouyinAdd(env, chat, t); // 带着主页链接，要在下一条之前认
    if ((c = /^账号标签(?:\s+(\d+)\s+(.+))?$/.exec(t))) return ownerDouyinTags(env, chat, c[1], c[2]);
    if (DOUYIN_LINK.test(t)) return ownerDouyin(env, chat, t);
    if (/^转抖音视频$/.test(t)) return ownerDouyinMirror(env, chat);
    if (/^登录抖音$/.test(t)) return ownerDouyinLogin(env, chat, origin);
    if ((c = /^抖音自动同步\s*(开|关)$/.exec(t))) return ownerDouyinAuto(env, chat, c[1] === '开');
    if ((c = /(https?:\/\/\S+)(?:\s+(\d{1,3}))?/.exec(t))) return ownerHarvest(env, chat, c[1], c[2] ? Number(c[2]) : 0);
    if (/^搬运设置$/.test(t)) return showHarvest(env, chat);
    if ((c = /^搬运数量\s*(\d{1,3})$/.exec(t))) return setHarvestLimit(env, chat, Number(c[1]));
    if ((c = /^搬运歌单\s*(.+)$/.exec(t))) return setHarvestPlaylist(env, chat, c[1].trim());
  }
  if (tooLong(t)) return say(env, chat, '歌名太长啦，发短一点（歌名，或者「歌名 歌手」）');
  return songRequest(env, chat, m.from ? m.from.id : chat, t, origin, isOwner);
}

// 在小橘音乐里按歌名、歌手找（不分大小写、去掉符号）
async function libraryFind(env, q, n = 5) {
  const nq = norm(q);
  if (!nq) return [];
  const scored = [];
  for (const t of await lib(env).listTracks()) {
    const nt = norm(t.title), na = norm(t.artist);
    let s = 0;
    if (nt === nq) s = 100;
    else if (na && nt && nq.includes(nt) && nq.includes(na)) s = 95;
    else if (nt.includes(nq)) s = 60;
    else if ((nt + na).includes(nq)) s = 40;
    if (s) scored.push([s, t]);
  }
  return scored.sort((a, b) => b[0] - a[0] || b[1].id - a[1].id).slice(0, n).map(x => x[1]);
}

const nameOf = t => (t.artist ? `${t.artist} - ${t.title}` : t.title);

async function songRequest(env, chat, uid, q, origin, isOwner) {
  const hit = (await libraryFind(env, q, 1))[0];
  if (hit && norm(hit.title).length >= Math.min(2, norm(q).length)) {
    return say(env, chat, `🎵 小橘音乐里有：${nameOf(hit)}\n点这里听：${origin}/#${hit.id}`);
  }
  if (!isOwner && !(await lib(env).allowAsk(uid, Date.now()))) {
    return say(env, chat, '今天帮你找的歌有点多啦，明天再来吧 🙏');
  }
  if (!streamerOn(env)) return say(env, chat, `小橘音乐里还没有「${q}」`);
  await say(env, chat, `小橘音乐里还没有「${q}」，我去找找，稍等一会儿…`);
  try {
    const L = lib(env);
    const { status } = await streamerCall(env, '/fulfill', {
      q, chat_id: chat, only: await L.getSources(), link: origin + '/',
      existing: (await L.listTracks()).map(t => [t.title, t.artist]),
    });
    if (status !== 200) throw new Error(String(status));
  } catch {
    await say(env, chat, '找歌的服务正在睡觉（刚被叫醒），过一两分钟再发一次歌名试试');
  }
}

async function ownerSearch(env, chat, q) {
  if (!streamerOn(env)) return say(env, chat, '搬歌服务没配置');
  const only = (await lib(env).getSources()).join(',');
  let res;
  try {
    const r = await fetch(`${streamerBase(env)}/search/global?q=${encodeURIComponent(q)}&only=${encodeURIComponent(only)}&limit=150`, {
      headers: { 'X-Key': env.STREAMER_KEY }, signal: AbortSignal.timeout(BOT_WAIT_MS),
    });
    res = ((await r.json().catch(() => ({}))).results || []);
  } catch {
    return say(env, chat, '搬歌服务正在唤醒，过一两分钟再搜一次');
  }
  res = res.filter(r => r.duration >= 60).slice(0, 8);
  if (!res.length) return say(env, chat, `来源频道里没搜到「${q}」`);
  const lines = res.map((r, i) => `${i + 1}. ${r.performer ? r.performer + ' - ' : ''}${r.title}（${Math.floor(r.duration / 60)}:${String(r.duration % 60).padStart(2, '0')}，@${r.channel}）`);
  const buttons = [];
  for (let i = 0; i < res.length; i += 4) {
    buttons.push(res.slice(i, i + 4).map((r, k) => ({ text: `搬 ${i + k + 1}`, callback_data: `p:${r.channel}:${r.id}` })));
  }
  return say(env, chat, `搜「${q}」找到这些，点按钮搬进来：\n` + lines.join('\n'), buttons);
}

async function ownerCopy(env, chat, source, n) {
  if (!streamerOn(env)) return say(env, chat, '搬歌服务没配置');
  const L = lib(env);
  try {
    const { status } = await streamerCall(env, '/copy/start', {
      source, limit: Math.max(1, Math.min(n, 500)), min_seconds: 60, max_seconds: 1200, chinese_only: true,
      notify: chat, existing: (await L.listTracks()).map(t => [t.title, t.artist]),
    });
    if (status === 409) return say(env, chat, '正在搬别的，等那边搬完再来（搬完会通知你）');
    if (status !== 200) throw new Error(String(status));
  } catch {
    return say(env, chat, '搬歌服务正在唤醒，过一两分钟再发一次');
  }
  return say(env, chat, `开始从 @${source} 搬最多 ${n} 首中文歌，搬完告诉你 👌`);
}

async function ownerFind(env, chat, q, origin) {
  const hits = await libraryFind(env, q, 5);
  if (!hits.length) return say(env, chat, `小橘音乐里没有「${q}」。想从来源频道找的话发：搜 ${q}`);
  const pls = await lib(env).listPlaylists();
  for (const t of hits) {
    const inside = pls.filter(p => p.tracks.includes(t.id)).map(p => p.name);
    await say(env, chat, `${nameOf(t)}\n${inside.length ? '在歌单：' + inside.join('、') : '不在任何歌单'}\n${origin}/#${t.id}`, [[
      { text: '加入歌单', callback_data: `a:${t.id}` },
      { text: '移出歌单', callback_data: `r:${t.id}` },
      { text: '删除', callback_data: `d:${t.id}` },
    ]]);
  }
}

async function ownerStats(env, chat) {
  const L = lib(env);
  const tracks = await L.listTracks();
  const now = Date.now() / 1000;
  const recent = d => tracks.filter(t => t.date > now - d * 86400).length;
  const auto = await L.getAuto();
  const lines = [`歌库一共 ${tracks.length} 首`, `最近 24 小时新增 ${recent(1)} 首，7 天 ${recent(7)} 首`];
  if (auto.lastStart) lines.push(`上次夜里自动搬：${auto.lastStart.slice(0, 10)}${auto.lastCopied != null ? `，搬了 ${auto.lastCopied} 首` : ''}`);
  lines.push('', '各歌单：', ...(await L.listPlaylists()).map(p => `· ${p.name} ${p.tracks.length} 首`));
  return say(env, chat, lines.join('\n'));
}

async function botButton(env, cb, owner, origin) {
  const chat = cb.message && cb.message.chat.id;
  const ack = textMsg => tg(env, 'answerCallbackQuery', { callback_query_id: cb.id, text: textMsg || '' });
  if (!owner || !cb.from || cb.from.id !== owner) return ack('只有频道主能用');
  const [kind, a, b] = String(cb.data || '').split(':');
  const L = lib(env);
  if (kind === 'fv') { // 频道主发来的视频：原样复制到视频频道
    if (!env.VIDEO_CHANNEL_ID) return ack('还没设置视频频道');
    const r = await tg(env, 'copyMessage', { chat_id: env.VIDEO_CHANNEL_ID, from_chat_id: chat, message_id: Number(a) });
    if (!r.ok) {
      await ack();
      return say(env, chat, `没转成：${r.description || '未知原因'}`);
    }
    await ack('已转到视频频道');
    // 去掉按钮，免得再点一次又发一遍
    return tg(env, 'editMessageText', { chat_id: chat, message_id: cb.message.message_id, text: '✅ 已转到视频频道' });
  }
  if (kind === 'prg') { // 进度面板：刷新 / 停云电脑 / 停小橘
    let tip = '';
    if (a === 'cloud') {
      await L.setConfig('dyStop', '1');
      await L.setConfig('dyCrawlReq', '0');  // 还没开抓的那次也不抓了
      tip = '好，云电脑下次报进度时（半分钟内）停下';
    } else if (a === 'run') {
      tip = (await douyinSelves(L)).length ? (await requestCrawl(L)).short : '还没设置你自己的抖音账号';
    } else if (a === 'post') {
      let r = null;
      try { r = await streamerCall(env, '/douyin/stop', {}); } catch {}
      if (r && r.status === 200) await L.resumeClear(); // 叫停的不再接着转
      tip = !r || r.status !== 200 ? '小橘的服务没连上，过一会儿再点' : r.data.stopped ? '小橘停了（已经发进频道的不动）' : '小橘现在没在转';
    }
    await ack(tip);
    return tg(env, 'editMessageText', { chat_id: chat, message_id: cb.message.message_id, text: await progressText(env), reply_markup: { inline_keyboard: PROGRESS_KB } });
  }
  if (kind === 'dyp' || kind === 'dyq' || kind === 'dys' || kind === 'dya') { // 旧清单上的转发按钮：搜索结果一律先经审核机器人
    return ack(`搜到的作品要先在 @${await V.verifyName(L)} 审核通过才转，这个按钮不能用了`);
  }
  if (kind === 'rvs') { // 重新送审：清单再交给审核机器人一次（只对暂停的审核单）
    const t = await V.getTask(L, a);
    if (!t) return ack('找不到这张审核单了');
    if (t.status !== 'paused') return ack(t.status === 'pending' ? '已经在审核机器人那里等你审核了' : '这张审核单已经处理过了');
    const r = await V.deliverTask(env, L, owner, t);
    await ack(r.ok ? `送到 @${await V.verifyName(L)} 了，去那里审核` : `还是没送到：${r.why}`);
    if (r.ok) return tg(env, 'editMessageReplyMarkup', { chat_id: chat, message_id: cb.message.message_id, reply_markup: { inline_keyboard: [] } });
    return;
  }
  if (kind === 'rvt') { // 审核通过但没转成：再试（只认任务表里 approved 的）
    const t = await V.getTask(L, a);
    if (!t || t.status !== 'approved') return ack('这张审核单没通过审核，不能转');
    if (t.transfer === 'started') return ack('已经在转了');
    await ack('再试一次');
    return transferApproved(env, L, owner, t);
  }
  if (kind === 'hs' || kind === 'hl') { // 搬运设置里点开关：网站 / 授权
    const h = await L.getHarvest();
    const list = kind === 'hs' ? h.sites : h.licenses;
    const valid = kind === 'hs' ? HARVEST_SITES : HARVEST_LICENSES;
    if (!Object.hasOwn(valid, a)) return ack();
    const on = !list.includes(a);
    if (on) list.push(a); else list.splice(list.indexOf(a), 1);
    await L.setHarvest(h);
    await ack(`${valid[a]}：${on ? '开' : '关'}`);
    return tg(env, 'editMessageText', { chat_id: chat, message_id: cb.message.message_id, ...harvestPanel(h) });
  }
  if (kind === 'p') { // 搬搜到的那首
    await ack('搬运中…');
    try {
      const { data } = await streamerCall(env, '/copy/pick', { items: [{ channel: a, id: Number(b) }] });
      const id = (data.new_ids || [])[0];
      return say(env, chat, id ? `✅ 搬好了，会自动放进对应的歌单：${origin}/#${id}` : '⛔ 这首搬不了（可能那个频道禁止转发）');
    } catch {
      return say(env, chat, '搬歌服务正在唤醒，过一两分钟再点一次');
    }
  }
  const id = Number(a);
  const t = (await L.listTracks()).find(x => x.id === id);
  if (!t) return ack('这首已经不在了');
  const pls = await L.listPlaylists();
  if (kind === 'a') {
    await ack();
    const opts = pls.filter(p => !p.tracks.includes(id));
    if (!opts.length) return say(env, chat, '已经在所有歌单里了');
    return say(env, chat, `把「${t.title}」加到哪个歌单？`, rows(opts.map(p => ({ text: p.name, callback_data: `ap:${id}:${p.id}` }))));
  }
  if (kind === 'r') {
    await ack();
    const opts = pls.filter(p => p.tracks.includes(id));
    if (!opts.length) return say(env, chat, '它不在任何歌单里');
    return say(env, chat, `把「${t.title}」从哪个歌单移出？`, rows(opts.map(p => ({ text: p.name, callback_data: `rp:${id}:${p.id}` }))));
  }
  if (kind === 'ap' || kind === 'rp') {
    const p = pls.find(x => x.id === Number(b));
    if (!p) return ack('歌单不在了');
    if (kind === 'ap') await L.addToPlaylists(id, [p.name]); else await L.removeFromPlaylist(id, p.name);
    listCache = null;
    await ack(kind === 'ap' ? `已加入「${p.name}」` : `已移出「${p.name}」`);
    return say(env, chat, `${kind === 'ap' ? '✅ 已加入' : '✅ 已移出'}「${p.name}」：${nameOf(t)}`);
  }
  if (kind === 'd') {
    await ack();
    return say(env, chat, `确定从小橘音乐删除「${nameOf(t)}」吗？（频道里的帖子不动）`, [[
      { text: '确定删除', callback_data: `dd:${id}` }, { text: '算了', callback_data: 'x:0' },
    ]]);
  }
  if (kind === 'dd') {
    await L.removeTrack(id);
    forget(id);
    await ack('已删除');
    return say(env, chat, `🗑 已删除：${nameOf(t)}`);
  }
  return ack();
}

// ── 贴网址搬授权音频（真正干活的在流式服务的 harvest/ 里：网站适配器、逐首授权检查、上传） ──
const HARVEST_SITES = { archive: '互联网档案馆', commons: '维基共享资源' };
const HARVEST_LICENSES = {
  cc0: 'CC0 放弃版权', pd: '公有领域', by: 'CC BY', 'by-sa': 'CC BY-SA', 'by-nc': 'CC BY-NC',
  'by-nc-sa': 'CC BY-NC-SA', 'by-nd': 'CC BY-ND', 'by-nc-nd': 'CC BY-NC-ND',
};

function harvestPanel(h) {
  const lines = [
    '搬运设置（点按钮开关）', '',
    `每次最多搬：${h.limit} 首（发「搬运数量 30」改）`,
    `搬到歌单：${h.playlist || '按类型自动分'}（发「搬运歌单 纯音乐」或「搬运歌单 自动」改）`, '',
    '只搬下面打 ✅ 的网站和授权；每一首都会检查授权，没有允许转载授权的不搬。',
  ];
  const btn = (k, name, on, kind) => ({ text: `${on ? '✅' : '⬜️'} ${name}`, callback_data: `${kind}:${k}` });
  return {
    text: lines.join('\n'),
    reply_markup: { inline_keyboard: [
      ...rows(Object.entries(HARVEST_SITES).map(([k, n]) => btn(k, n, h.sites.includes(k), 'hs'))),
      ...rows(Object.entries(HARVEST_LICENSES).map(([k, n]) => btn(k, n, h.licenses.includes(k), 'hl'))),
    ] },
  };
}

async function showHarvest(env, chat) {
  const p = harvestPanel(await lib(env).getHarvest());
  return tg(env, 'sendMessage', { chat_id: chat, ...p, disable_web_page_preview: true });
}

async function setHarvestLimit(env, chat, n) {
  const L = lib(env), h = await L.getHarvest();
  h.limit = Math.max(1, Math.min(n, 200));
  await L.setHarvest(h);
  return say(env, chat, `好的，以后每次最多搬 ${h.limit} 首`);
}

async function setHarvestPlaylist(env, chat, name) {
  const L = lib(env), h = await L.getHarvest();
  if (name === '自动') {
    h.playlist = '';
    await L.setHarvest(h);
    return say(env, chat, '好的，搬来的歌按类型自动分进歌单');
  }
  if (name.length > 40) return say(env, chat, '歌单名太长了');
  const pls = await L.listPlaylists();
  let made = false;
  if (!pls.some(p => p.name === name)) { // 没有这个歌单就新建一个，排在最后
    await L.setPlaylists([...pls.map(p => ({ id: p.id, name: p.name, cover: p.cover, tracks: p.tracks })), { name, tracks: [] }]);
    listCache = null;
    made = true;
  }
  h.playlist = name;
  await L.setHarvest(h);
  return say(env, chat, `好的，搬来的歌都放进「${name}」${made ? '（新建了这个歌单）' : ''}`);
}

async function ownerHarvest(env, chat, url, n) {
  if (!streamerOn(env)) return say(env, chat, '搬运服务没配置');
  const L = lib(env), settings = await L.getHarvest();
  if (n) settings.limit = Math.max(1, Math.min(n, 200));
  let r;
  try {
    r = await streamerCall(env, '/harvest', {
      url, settings, notify: chat, existing: (await L.listTracks()).map(t => [t.title, t.artist]),
    });
  } catch {
    return say(env, chat, '搬运服务正在唤醒，过一两分钟再发一次网址');
  }
  if (r.status === 400) {
    const why = r.data.detail || '这个网址搬不了';
    return say(env, chat, `${why}。${/不支持/.test(why) ? '现在支持：' + Object.values(HARVEST_SITES).join('、') + '。想加别的网站跟我说。' : ''}`);
  }
  if (r.status === 409) return say(env, chat, '正在搬别的网址，等那边搬完再来（搬完会通知你）');
  if (r.status !== 200) return say(env, chat, '搬运服务正在唤醒，过一两分钟再发一次网址');
  return say(env, chat, `开始从${r.data.site || '这个网站'}搬，最多 ${settings.limit} 首。每首都会检查授权，搬完告诉你结果 👌`);
}

// ── 抖音（真正干活的在流式服务的 streamer/douyin/ 里，不登录）：频道主发作品链接 → 解析、下载、发进频道；
// 发主页链接 → 采集这个账号作品的公开链接。都在后台跑，好了机器人通知。
// 没登录时抖音只给看一部分（藏起最新的几条、只给第一页），所以不做「自动发现新视频」，见 streamer/douyin/job.py
const DOUYIN_LINK = /https?:\/\/(?:[\w-]+\.)*(?:douyin|iesdouyin)\.com\//i;

async function ownerDouyin(env, chat, t) {
  if (!streamerOn(env)) return say(env, chat, '解析服务没配置');
  let r;
  try {
    r = await douyinStart(env, '/douyin/link', { text: t, notify: chat, target: env.VIDEO_CHANNEL_ID || '', state: (await lib(env).getConfig('douyinState')) || '' });
  } catch {
    return say(env, chat, '解析服务正在唤醒，过一两分钟再发一次链接');
  }
  if (r.status === 400 || r.status === 502) return say(env, chat, r.data.detail || '这个链接认不出来');
  if (r.status === 409) return say(env, chat, '正在处理上一个链接，好了会告诉你，之后再发这个');
  if (r.status !== 200) return say(env, chat, '解析服务正在唤醒，过一两分钟再发一次链接');
  if (r.data.kind === 'user') return say(env, chat, '收到 👌 正在采集这个账号的作品链接（不登录），大约半分钟，采好了发给你');
  return say(env, chat, '收到 👌 正在解析这条抖音视频，大约半分钟，转好了告诉你');
}

const SEC_UID = /^MS4wLjABAAAA[\w-]{10,120}$/;

// 频道主自己的抖音账号（可以有几个，比如主号和小号）。以前只存一个字符串，兼容
async function douyinSelves(L) {
  const raw = (await L.getConfig('douyinSelf')) || '';
  if (!raw) return [];
  try { const a = JSON.parse(raw); if (Array.isArray(a)) return a; } catch {}
  return [raw];
}

// 「云电脑」：教频道主开一台 GitHub Codespaces（不用绑卡），给一条带上传令牌和自己抖音账号的抓取命令。
// （自己有 VPS 的话也可以用 cloud/setup.sh 一键装，参数一样。）
// 云电脑上 MediaCrawler 抓完，cloud/crawl.sh 把文件 POST 到 /dy-import（带 X-Token），这边转给流式服务
const CLOUD_SETUP = 'https://raw.githubusercontent.com/langhua98/Linggo/main/xiaoju-music/cloud/setup.sh';
// GitHub Codespaces：用仓库里 .devcontainer/douyin 的配置开一台带网页桌面的云电脑（不用绑卡）
const CODESPACE_URL = 'https://codespaces.new/langhua98/Linggo?devcontainer_path=.devcontainer%2Fdouyin%2Fdevcontainer.json';

// 云电脑领口令（手机网页版终端粘贴不了）：Codespaces 里自带频道主的 GitHub 令牌，拿它找 GitHub 认人，
// 是仓库主人本人（CLOUD_GH_USER）才给上传令牌和抖音账号；GitHub 令牌只转给 api.github.com，不存
const CLOUD_GH_USER = 'langhua98';

async function cloudConfig(request, env) {
  // 已经领过上传令牌的云电脑：带 X-Token 来，每次开抓前拿最新的账号名单（后来加的小号也能抓到）
  const xt = request.headers.get('X-Token') || '';
  if (xt) {
    const L = lib(env), tok = await L.getConfig('cloudTok');
    if (!tok || !sameString(xt, tok)) return json({ error: '令牌不对' }, 403);
    const selves = await douyinSelves(L);
    if (!selves.length) return json({ error: '还没设置你自己的抖音账号' }, 400);
    const q = await queueAfterRules(env, L);
    await L.setConfig('dyCloudSeen', String(Date.now()));  // 云电脑开着时每 20 秒来问一次，机器人据此说它在不在
    // 它在干什么：idle / crawl（在抓）/ search（在搜）/ wait:秒（上次没搜成，过这么久再搜）；旧脚本不带
    await L.setConfig('dyCloudBusy', String(request.headers.get('X-Busy') || '').slice(0, 40));
    return json({ token: tok, creators: selves.join(','), searches: q, search_max: await douyinSearchMax(L, q), crawl: (await L.getConfig('dyCrawlReq')) === '1' });
  }
  const gh = (request.headers.get('Authorization') || '').replace(/^(Bearer|token)\s+/i, '');
  if (!gh) return json({ error: '没带 GitHub 令牌' }, 401);
  let login = '';
  try {
    const r = await fetch('https://api.github.com/user', {
      headers: { Authorization: `Bearer ${gh}`, Accept: 'application/vnd.github+json', 'User-Agent': 'xiaoju-music' },
    });
    if (r.ok) login = String((await r.json()).login || '');
  } catch {}
  if (login.toLowerCase() !== CLOUD_GH_USER) return json({ error: '不是仓库主人的 GitHub 账号' }, 403);
  const L = lib(env), selves = await douyinSelves(L);
  if (!selves.length) return json({ error: '还没设置你自己的抖音账号' }, 400);
  const q = await douyinSearchQueue(L);
  return json({ token: await cloudToken(L), creators: selves.join(','), searches: q, search_max: await douyinSearchMax(L, q) });
}

// ── 抖音搜索 → 链接清单 ──
// 「搜抖音 舞蹈」：关键词记进 dySearchQueue；云电脑（MediaCrawler 的 search 模式，频道主自己登录的）下次打开时搜，
// 结果 POST /dy-search（X-Token）。只整理成分享链接清单私聊发给频道主，点链接在抖音里看——别人的视频不下载、不转发
const SEARCH_DEFAULT = 100, SEARCH_MAX = 500;

// ── 内容过滤 ──
// 规则全部由管理员在小橘视频管理页（/video-admin）配置：加、改、删、开关，表 filter_rules。机器人只照着已经启用的规则执行，
// 不自己加规则、不自己扩大条件；没命中任何规则的照常走。规则每次现读，改了马上用到后面的任务上。
// 每条规则：关键词（文字里包含任意一个就算命中，不分大小写）、查哪里（搜索词 keyword / 作品文案 caption / 两个都查 both）、
// 命中了怎么办（filter 不进清单、不转；flag 只标「待人工确认」，照常进清单，审核时管理员决定）。
// 查不了的（作品没有文案，文案规则无从判断）也只标「待人工确认」，不替管理员下结论。每次过滤、标记都记进 filter_log。
// 唯一的固定规则是未成年人保护（管理员要求保留）：在管理页里照样列出、命中照样记录，但不能关、不能删。
const MINOR_WORDS = ['初中', '小学', '中学生', '高中生', '未成年', '学生妹', '萝莉', '幼女', '女童', '小女孩', '童模', '初一', '初二', '初三',
  '高一', '高二', '高三', '七年级', '八年级', '九年级', '10后', '幼儿', '儿童', '小朋友', '中考', '校服'];
const MINOR_REFUSAL = '🚫 小橘不搜、不转未成年人的视频。';
const BUILTIN_RULES = [{ id: 'minor', name: '未成年人保护（固定规则，不能关闭）', words: MINOR_WORDS, scope: 'both', action: 'filter', enabled: true, builtin: true }];
const RULE_SCOPES = ['keyword', 'caption', 'both'], RULE_ACTIONS = ['filter', 'flag'];

// 现在生效的规则：固定规则 + 管理员启用的；「过滤」的排在「只标记」前面（同时命中时按过滤算）
async function filterRules(L) {
  const mine = (await L.listFilterRules()).filter(r => r.enabled);
  return [...BUILTIN_RULES, ...mine.filter(r => r.action === 'filter'), ...mine.filter(r => r.action === 'flag')];
}

// 一段文字（kind：keyword 搜索词 / caption 作品文案）命中的第一条规则 → { rule, word }；没命中 → null
function ruleHit(rules, text, kind) {
  const t = String(text || '').toLowerCase();
  for (const r of rules) {
    if (r.scope !== 'both' && r.scope !== kind) continue;
    const w = r.words.find(x => x && t.includes(String(x).toLowerCase()));
    if (w) return { rule: r, word: w };
  }
  return null;
}

const captionOf = r => (String((r && r.desc) || '') + ' ' + String((r && r.title) || '')).trim();

function hitEntry(hit, stage, result, subject, text) {
  return { at: Date.now(), rule_id: hit ? String(hit.rule.id) : '', rule_name: hit ? hit.rule.name : '', word: hit ? String(hit.word) : '',
    stage, result, subject: String(subject).slice(0, 60), text: String(text || '').replace(/\s+/g, ' ').slice(0, 120) };
}

// 管理页送来的一条规则 → 存进表的样子；不像样 → { error }
function cleanRule(b) {
  if (!b || typeof b !== 'object') return { error: '格式不对' };
  if (String(b.id) === 'minor') return { error: '固定规则不能改' };
  const name = String(b.name || '').trim().slice(0, 30);
  const raw = Array.isArray(b.words) ? b.words : String(b.words || '').split(/[,，、\n]/);
  const words = [...new Set(raw.map(w => String(w).trim()).filter(Boolean))].slice(0, 100);
  if (!name) return { error: '规则要有个名字' };
  if (!words.length) return { error: '至少写一个关键词' };
  if (words.some(w => w.length > 30)) return { error: '关键词太长（一个最多 30 个字）' };
  if (!RULE_SCOPES.includes(b.scope)) return { error: '查哪里不对' };
  if (!RULE_ACTIONS.includes(b.action)) return { error: '命中后怎么办不对' };
  return { id: Number(b.id) || 0, name, words, scope: b.scope, action: b.action, enabled: b.enabled !== false };
}

function refusal(hit, what) {
  return hit.rule.id === 'minor' ? `${MINOR_REFUSAL}${what}` : `🚫 命中过滤规则「${hit.rule.name}」（词：${hit.word}），${what}`;
}

// 交给云电脑之前按现在的规则再查一遍排队的词（规则可能是排队之后才加的）：命中过滤规则的出队、记录、告诉频道主
async function queueAfterRules(env, L) {
  const q = await douyinSearchQueue(L), rules = await filterRules(L);
  const keep = [], log = [], gone = [];
  for (const k of q) {
    const hit = ruleHit(rules, k, 'keyword');
    if (hit && hit.rule.action === 'filter') { log.push(hitEntry(hit, 'queue', 'filtered', k, k)); gone.push(refusal(hit, `「${k}」不搜了，已经从排队里拿掉。`)); }
    else keep.push(k);
  }
  if (!log.length) return q;
  await L.setConfig('dySearchQueue', JSON.stringify(keep));
  await L.logFilter(log);
  const owner = await ownerId(env);
  if (owner) await say(env, owner, gone.join('\n'));
  return keep;
}

// 这次要搜多少条：排队的词里要得最多的那个（MediaCrawler 一次只能给一个数）
async function douyinSearchMax(L, queue) {
  const counts = await douyinTagMap(L, 'dySearchCounts');
  return queue.length ? Math.max(...queue.map(k => Number(counts[k]) || SEARCH_DEFAULT)) : SEARCH_DEFAULT;
}

async function douyinSearchQueue(L) {
  try {
    const a = JSON.parse((await L.getConfig('dySearchQueue')) || '[]');
    return Array.isArray(a) ? a.filter(x => typeof x === 'string' && x) : [];
  } catch {
    return [];
  }
}

async function ownerDouyinSearch(env, chat, kw) {
  const L = lib(env), q = await douyinSearchQueue(L);
  if (!kw) {
    return say(env, chat, q.length
      ? `等云电脑去搜的词：${q.join('、')}\n${await cloudStatusLine(L)}\n不想搜了发「搜抖音 清空」`
      : '发「搜抖音 关键词」，比如「搜抖音 舞蹈」');
  }
  if (kw === '清空') {
    await L.setConfig('dySearchQueue', '[]');
    return say(env, chat, '清空了');
  }
  // 「搜抖音 瑜伽裤 300」：最后的数字是这个词要搜多少条（默认 100，最多 500）
  let want = SEARCH_DEFAULT;
  const num = /^(.*?)\s+(\d{1,4})$/.exec(kw);
  if (num) { kw = num[1]; want = Math.min(SEARCH_MAX, Math.max(10, Number(num[2]))); }
  kw = kw.replace(/[,，]/g, ' ').replace(/\s+/g, ' ').slice(0, 30);
  const kwHit = ruleHit(await filterRules(L), kw, 'keyword');
  if (kwHit && kwHit.rule.action === 'filter') {
    await L.logFilter([hitEntry(kwHit, 'search', 'filtered', kw, kw)]);
    return say(env, chat, refusal(kwHit, `「${kw}」这个词不搜。`));
  }
  if (kwHit) await L.logFilter([hitEntry(kwHit, 'search', 'flagged', kw, kw)]);
  if (!q.includes(kw)) q.push(kw);
  await L.setConfig('dySearchQueue', JSON.stringify(q.slice(-10)));
  const counts = await douyinTagMap(L, 'dySearchCounts');
  counts[kw] = want;
  await L.setConfig('dySearchCounts', JSON.stringify(counts));
  return say(env, chat, [
    `🔎 记下了「${kw}」，搜 ${want} 条${q.length > 1 ? `（一共 ${q.length} 个词等着搜：${q.join('、')}）` : ''}`,
    `想多搜一些：「搜抖音 ${kw} 300」（最多 ${SEARCH_MAX} 条；搜得越多越容易被抖音限制）`,
    '',
    '搜索要用云电脑上登录的抖音，搜完把链接清单私聊发你。',
    ...(kwHit ? [`⚠️ 这个词命中规则「${kwHit.rule.name}」（词：${kwHit.word}，只标记）：照常搜，审核清单里会标出来，你来决定`] : []),
    await cloudStatusLine(L),
  ].join('\n'));
}

async function searchRows(L) {
  try {
    const o = JSON.parse((await L.getConfig('dySearchRows')) || '{}');
    return o && typeof o === 'object' && !Array.isArray(o) ? o : {};
  } catch {
    return {};
  }
}

// 搜索结果的一条 → 转进频道要用的那几样（和 MediaCrawler 导出的格式一样，流式服务的 mcimport 认得），各档清晰度留着挑最高的
function compactSearchRow(r) {
  const addr = a => (a && typeof a === 'object' ? { url_list: (a.url_list || []).slice(0, 2), width: a.width, height: a.height, data_size: a.data_size } : undefined);
  const v = r.xiaoju_video && typeof r.xiaoju_video === 'object' ? r.xiaoju_video : null;
  const out = {};
  for (const k of ['aweme_id', 'aweme_type', 'desc', 'create_time', 'nickname', 'xiaoju_nickname', 'xiaoju_sec_uid',
    'video_download_url', 'note_download_url', 'cover_url', 'xiaoju_images']) if (r[k] !== undefined) out[k] = r[k];
  if (v) {
    out.xiaoju_video = {
      width: v.width, height: v.height, duration: v.duration, play_addr: addr(v.play_addr), play_addr_h264: addr(v.play_addr_h264),
      // 只留清晰度最高的 4 档（按分辨率、码率排），每条存得小一点：几百条都放得下
      bit_rate: (Array.isArray(v.bit_rate) ? v.bit_rate : []).filter(b => b && b.play_addr)
        .sort((x, y) => (Math.min(y.play_addr.width || 0, y.play_addr.height || 0) - Math.min(x.play_addr.width || 0, x.play_addr.height || 0)) || ((y.bit_rate || 0) - (x.bit_rate || 0)))
        .slice(0, 4).map(b => ({
        bit_rate: b.bit_rate, is_h265: b.is_h265, gear_name: b.gear_name, play_addr: addr(b.play_addr),
      })),
    };
  }
  return out;
}

// 云电脑开抓前要一份「视频频道里已经有的作品号」：转过的不再抓，某个号翻到一整页都是转过的就停（只抓新的）。
// 频道里删掉的帖子不在里面，下次就会重新抓、重新转（换最高画质就是这么做的）
async function cloudKnown(request, env) {
  const L = lib(env), tok = await L.getConfig('cloudTok');
  if (!tok || !sameString(request.headers.get('X-Token') || '', tok)) return json({ error: '令牌不对' }, 403);
  if (!streamerOn(env) || !env.VIDEO_CHANNEL_ID) return json({ error: '视频频道没配置' }, 500);
  try {
    const r = await fetch(`${streamerBase(env)}/douyin/posted?target=${encodeURIComponent(env.VIDEO_CHANNEL_ID)}`, {
      headers: { 'X-Key': env.STREAMER_KEY }, signal: AbortSignal.timeout(150000),  // 翻一遍频道要一会儿
    });
    const data = await r.json().catch(() => ({}));
    if (!r.ok || !Array.isArray(data.ids)) return json({ error: data.detail || '小橘没给' }, 502);
    return json({ ids: data.ids });
  } catch {
    return json({ error: '小橘的服务正在唤醒' }, 503);
  }
}

// ── 进度：云电脑每 30 秒报一次（POST /dy-progress，X-Token），记在 dyCloud；频道主发「进度」看，点按钮停 ──
const CLOUD_PHASE = { starting: '刚开始（开浏览器、等登录）', running: '正在抓', paused: '先停一下给搜索让路（已经抓到的送过来了，搜完自动接着抓）', done: '抓完了', stopped: '停了', failed: '没成（没抓到、登录过期，或者没发出去；看云电脑终端里的原因）' };

async function cloudProgress(request, env) {
  const L = lib(env), tok = await L.getConfig('cloudTok');
  if (!tok || !sameString(request.headers.get('X-Token') || '', tok)) return json({ error: '令牌不对' }, 403);
  let p;
  try { p = await request.json(); } catch { return json({ error: '格式不对' }, 400); }
  if (!p || typeof p !== 'object') return json({ error: '格式不对' }, 400);
  const keep = { phase: String(p.phase || ''), mode: p.mode === 'search' ? 'search' : 'crawl', sent: Number(p.sent) || 0, got: Number(p.got) || 0,
    accounts: (Array.isArray(p.accounts) ? p.accounts : []).slice(0, 30).map(a => ({
      sec_uid: String(a.sec_uid || ''), name: String(a.name || '').slice(0, 40), total: Number.isFinite(a.total) ? a.total : null, got: Number(a.got) || 0,
    })),
    keywords: (Array.isArray(p.keywords) ? p.keywords : []).slice(0, 10).map(String), per: p.per && typeof p.per === 'object' ? p.per : {},
    at: Date.now() };
  await L.setConfig('dyCloud', JSON.stringify(keep));
  if (keep.mode === 'crawl' && keep.phase === 'starting') await L.setConfig('dyCrawlReq', '0');  // 这次「运行爬虫」开始了
  const stop = (await L.getConfig('dyStop')) === '1';
  if (['done', 'stopped', 'failed'].includes(keep.phase)) await L.setConfig('dyStop', '0');
  return json({ ok: true, stop });
}

function ago(ms) {
  const s = Math.round(ms / 1000);
  return s < 60 ? `${s} 秒前` : s < 3600 ? `${Math.round(s / 60)} 分钟前` : `${Math.round(s / 3600)} 小时前`;
}

async function progressText(env) {
  const L = lib(env), lines = ['📊 进度', ''];
  let c = null;
  try { c = JSON.parse((await L.getConfig('dyCloud')) || 'null'); } catch {}
  if (!c) {
    lines.push('☁️ 云电脑：还没报过进度（点「▶️ 运行爬虫」才会开始抓）');
  } else {
    const quiet = Date.now() - c.at > 3 * 60 * 1000 && !['done', 'stopped', 'failed'].includes(c.phase);
    lines.push(`☁️ 云电脑（${c.mode === 'search' ? '搜索' : '抓自己的号'}）：${CLOUD_PHASE[c.phase] || c.phase}${quiet ? '——不过已经好久没报了，可能云电脑停了或关了' : ''}（${ago(Date.now() - c.at)}）`);
    if (c.mode === 'search') {
      for (const k of c.keywords) lines.push(`· 「${k}」搜到 ${(c.per || {})[k] || 0} 条`);
    } else {
      const seen = await douyinTagMap(L, 'douyinTagsSeen'), mine = await douyinTagMap(L, 'douyinTags');
      c.accounts.forEach((a, i) => {
        const tag = mine[a.sec_uid] || seen[a.sec_uid] || douyinHashtag(a.name);
        const total = a.total == null ? '' : ` / 共 ${a.total}`;
        const turn = a.total == null && !a.got;  // 云电脑按顺序一个号一个号抓，没轮到的还不知道名字和作品数
        lines.push(`${i + 1}. ${tag ? '#' + tag : '（这个号）'}：${turn ? '还没轮到' : `这次抓了 ${a.got}${total}${a.total && a.got >= a.total ? ' ✅' : ''}`}`);
      });
      lines.push(`这次一共抓了 ${c.got} 条，送给小橘 ${c.sent} 条（以前转过的不算在里面；频道里已有的会跳过）`);
    }
    if ((await L.getConfig('dyStop')) === '1') lines.push('⏹ 已经叫它停了，下次报进度时（半分钟内）停下');
  }
  lines.push(await cloudStatusLine(L));
  if ((await L.getConfig('dyCrawlReq')) === '1') lines.push(`▶️ 已经点了运行爬虫，${cloudOnline(Number(await L.getConfig('dyCloudSeen')) || 0) ? '云电脑半分钟内开始抓' : '等云电脑打开就抓'}`);
  lines.push('');
  let st = null;
  if (streamerOn(env)) {
    try { st = (await streamerCall(env, '/douyin/status')).data; } catch {}
  }
  const wl = st && st.worker_link;
  if (wl && wl.fail_at > (wl.ok_at || 0)) {
    lines.push(`⚠️ 小橘的服务上次通知这边没成功（${ago(Date.now() - wl.fail_at * 1000)}，连续 ${wl.fails} 次：${wl.error}），已经自动重试；这边每 30 分钟也会自己对一遍，转发不受影响`);
  }
  if (!st || !st.status || st.status === 'idle') {
    lines.push('🍊 小橘：现在没在转');
  } else {
    const n = k => (Array.isArray(st[k]) ? st[k].length : 0);
    const doneN = n('posted') + n('skipped') + n('failed');
    const what = st.mode === 'import' ? '转云电脑送来的作品' : st.mode === 'mirror' ? '同步公开主页' : st.mode === 'one' ? '转单条作品' : st.mode;
    const state = { running: '进行中', done: '转完了', stopped: '停了', error: `出错了（${st.error || ''}）` }[st.status] || st.status;
    lines.push(`🍊 小橘（${what}）：${state}`);
    if (st.mode === 'import' || st.mode === 'mirror') {
      lines.push(`新转进频道 ${n('posted')} 条，已有跳过 ${n('skipped')} 条，失败 ${n('failed')} 条`);
      if (st.mode === 'import' && st.status === 'running') lines.push(`收到 ${st.total || 0} 条，还有 ${Math.max(0, (st.total || 0) - doneN)} 条排着队`);
    }
  }
  return lines.join('\n');
}

const PROGRESS_KB = [[{ text: '▶️ 运行爬虫', callback_data: 'prg:run' }, { text: '🔄 刷新', callback_data: 'prg:r' }],
  [{ text: '⏹ 停止云电脑抓取', callback_data: 'prg:cloud' }, { text: '⏹ 停止小橘转发', callback_data: 'prg:post' }]];

async function ownerProgress(env, chat) {
  return say(env, chat, await progressText(env), PROGRESS_KB);
}

// 数字好读：12345 → 1.2万
function fmtCount(n) {
  n = Number(n) || 0;
  return n >= 10000 ? `${(n / 10000).toFixed(n >= 100000 ? 0 : 1)}万` : String(n);
}

async function cloudSearchResult(request, env) {
  const L = lib(env), tok = await L.getConfig('cloudTok');
  if (!tok || !sameString(request.headers.get('X-Token') || '', tok)) return json({ error: '令牌不对' }, 403);
  const body = await request.text();
  if (body.length > 20 * 1024 * 1024) return json({ error: '文件太大' }, 413);  // 云电脑一次最多送 50 条，这只是防万一
  // 边搜边发：云电脑每 30 秒送一批（X-Final: 0），搜完送 X-Final: 1（可以不带结果）。不带这个头当一次送完。
  // 编号在这一轮里接着往下排（dySearchNum: {词: 已经发了几条}），同一轮送重复的不再发（dySearchRun）
  const final = request.headers.get('X-Final') !== '0';
  // 清单只私聊发给频道主一个人：每条附上文件地址；登记过的号（douyinSelf）标 👤（只作参考）。
  // 小橘这里只发清单、不带转发按钮：搜完把这一轮的完整清单交给审核机器人，频道主在那里审核通过才转
  const mine = new Set(await douyinSelves(L));
  const groups = new Map();
  let run = [];
  try { run = JSON.parse((await L.getConfig('dySearchRun')) || '[]'); } catch {}
  const seen = new Set(run);
  const nums = await douyinTagMap(L, 'dySearchNum');
  // 这一轮的作品数据先存着，搜完一起交给审核机器人
  const rows = await searchRows(L);
  let fresh = 0;
  for (const line of body.split('\n')) {
    let r;
    try { r = JSON.parse(line); } catch { continue; }
    const id = String((r && r.aweme_id) || '');
    if (!/^\d{8,24}$/.test(id) || seen.has(id)) continue;
    seen.add(id);
    fresh++;
    const kw = String(r.source_keyword || '').trim() || '（没标关键词）';
    if (!groups.has(kw)) groups.set(kw, []);
    const name = String(r.xiaoju_nickname || (String(r.nickname || '').includes('*') ? '' : r.nickname) || '');
    const note = String(r.aweme_type || '') === '68' || String(r.note_download_url || '').startsWith('http');
    const own = mine.has(String(r.xiaoju_sec_uid || ''));
    const files = (note ? String(r.note_download_url || '').split(',') : [String(r.video_download_url || '')])
      .map(u => u.trim()).filter(u => /^https?:\/\//.test(u));
    rows[id] = compactSearchRow(r);
    groups.get(kw).push({
      id, likes: Number(r.liked_count) || 0, name, note, own, files,
      title: String(r.desc || r.title || '').replace(/\s+/g, ' ').trim().slice(0, 40) || '（没有文案）',
    });
  }
  const owner = await ownerId(env);
  if (!fresh && final && !Object.keys(nums).length && body.trim()) return json({ error: '文件里没认出搜索结果' }, 400);
  const send = async text => { if (owner) await say(env, owner, text); };

  for (const [kw, list] of groups) {
    list.sort((a, b) => b.likes - a.likes);  // 这一批里按点赞排
    const start = Number(nums[kw]) || 0;
    const lines = list.map((x, i) => `${start + i + 1}. ${x.note ? '🖼' : '📹'} ${x.title}${x.name ? ` — @${x.name}` : ''} ❤${fmtCount(x.likes)}${x.own ? ' 👤你的号' : ''}\nhttps://www.douyin.com/${x.note ? 'note' : 'video'}/${x.id}`
      + (x.files.length ? `\n⬇️ 文件（几个小时内有效）：\n${x.files.slice(0, 9).join('\n')}` : ''));
    const head = start
      ? `🔎「${kw}」接着来：第 ${start + 1}–${start + list.length} 条`
      : `🔎 抖音搜「${kw}」：边搜边发，每批按点赞排（⬇️ 是文件地址，几个小时内有效；👤 是机器人里登记过的号）。搜完整份清单交给审核机器人，你在那里审核通过才转`;
    let chunk = head;
    for (const l of lines) {
      if ((chunk + '\n\n' + l).length > 3800) {
        await send(chunk);
        chunk = l;
      } else {
        chunk += '\n\n' + l;
      }
    }
    await send(chunk);
    nums[kw] = start + list.length;
  }
  const keep = Object.keys(rows).slice(-600);  // 只留最近 600 条（地址几个小时就失效，旧的留着也没用；再多存不下）
  await L.setConfig('dySearchRows', JSON.stringify(Object.fromEntries(keep.map(k => [k, rows[k]]))));
  const touched = Object.keys(nums);
  if (!final) {
    await L.setConfig('dySearchNum', JSON.stringify(nums));
    await L.setConfig('dySearchRun', JSON.stringify([...seen].slice(-2000)));
    return json({ ok: true, keywords: touched, total: fresh });
  }
  // 搜完了：每个词说一声一共几条，出队，这一轮的编号清零
  for (const kw of touched) await say(env, owner, `✅ 「${kw}」搜完了，一共 ${nums[kw]} 条`);
  // 这一轮的完整清单交给审核机器人（审核任务写进共享的任务表）；审核通过前一条不转
  if (owner) await submitForReview(env, L, owner, touched, [...seen], rows);
  // 出队：结果里标的词，加上云电脑报进度时说这次在搜的词（结果里的 source_keyword 和排队的写法对不上时，不出队就会一直重搜）
  let ran = [];
  try { const c = JSON.parse((await L.getConfig('dyCloud')) || 'null'); if (c && c.mode === 'search') ran = c.keywords || []; } catch {}
  const done = new Set([...touched, ...ran]);
  await L.setConfig('dySearchQueue', JSON.stringify((await douyinSearchQueue(L)).filter(k => !done.has(k))));
  const counts = await douyinTagMap(L, 'dySearchCounts');
  for (const k of done) delete counts[k];
  await L.setConfig('dySearchCounts', JSON.stringify(counts));
  await L.setConfig('dySearchNum', '{}');
  await L.setConfig('dySearchRun', '[]');
  return json({ ok: true, keywords: touched, total: fresh });
}

const MAX_SELVES = 30;

// ── 和审核机器人（verify.js）的交接 ──
// 小橘：搜完生成完整清单 → 写进共享任务表 → 审核机器人发给频道主。频道主在审核机器人里点了，结果写回任务表，
// 再叫小橘 onReviewDecision：小橘重新从任务表读状态，只有 approved 才转（只转这一批，不登记账号）。送不到、超时、不通过，都不转。
function reviewDeps(env) {
  return { L: lib(env), owner: () => ownerId(env), onDecision: id => onReviewDecision(env, id) };
}

async function submitForReview(env, L, owner, kws, ids, rows) {
  const rules = await filterRules(L), log = [];
  for (const k of kws) {
    const hit = ruleHit(rules, k, 'keyword');
    if (hit && hit.rule.action === 'filter') {
      await L.logFilter([hitEntry(hit, 'review', 'filtered', k, k)]);
      return say(env, owner, refusal(hit, `「${kws.join('、')}」这批不送审、不转。`));
    }
  }
  const kwFlag = kws.map(k => ruleHit(rules, k, 'keyword')).find(Boolean);
  const captionRules = rules.some(r => r.scope !== 'keyword');
  const mine = new Set(await douyinSelves(L));
  const items = [], data = [], byRule = new Map();
  let lost = 0, flagged = 0;
  for (const id of ids) {
    const r = rows[id];
    if (!r) { lost++; continue; }
    const text = captionOf(r), hit = ruleHit(rules, text, 'caption');
    if (hit && hit.rule.action === 'filter') { // 命中过滤规则：不进清单
      log.push(hitEntry(hit, 'review', 'filtered', id, text));
      byRule.set(hit.rule.name, (byRule.get(hit.rule.name) || 0) + 1);
      continue;
    }
    let flag = '';
    if (hit) { flag = `命中规则「${hit.rule.name}」（词：${hit.word}）`; log.push(hitEntry(hit, 'review', 'flagged', id, text)); }
    else if (!text && captionRules) { flag = '没有文案，规则查不了'; log.push(hitEntry(null, 'review', 'unclear', id, '')); }
    else if (kwFlag) flag = `搜索词命中规则「${kwFlag.rule.name}」（词：${kwFlag.word}）`;
    if (flag) flagged++;
    const note = String(r.aweme_type || '') === '68' || String(r.note_download_url || '').startsWith('http');
    const sec = SEC_UID.test(String(r.xiaoju_sec_uid || '')) ? String(r.xiaoju_sec_uid) : '';
    items.push({
      id, note, sec, mine: !!sec && mine.has(sec), link: `https://www.douyin.com/${note ? 'note' : 'video'}/${id}`,
      account: String(r.xiaoju_nickname || (String(r.nickname || '').includes('*') ? '' : r.nickname) || '').slice(0, 30),
      title: String(r.desc || '').replace(/\s+/g, ' ').trim().slice(0, 40) || '（没有文案）',
      files: (note ? String(r.note_download_url || '').split(',') : [String(r.video_download_url || '')]).map(u => u.trim()).filter(u => /^https?:\/\//.test(u)).slice(0, 9),
      ...(flag ? { flag } : {}),
    });
    data.push(r);
  }
  if (log.length) await L.logFilter(log);
  const filtered = [...byRule.values()].reduce((a, b) => a + b, 0);
  // 数都按作品号去重以后算：去重后一共多少、进清单多少（其中待人工确认多少）、过期多少、按哪条规则去掉多少
  const tally = `按作品号去重后一共 ${ids.length} 条：进清单 ${items.length} 条${flagged ? `（其中 ⚠️ 待人工确认 ${flagged} 条）` : ''}`
    + `${lost ? `；数据过期 ${lost} 条` : ''}${filtered ? `；按过滤规则去掉 ${filtered} 条（${[...byRule].map(([n, c]) => `${n} ${c} 条`).join('、')}）` : ''}`;
  if (!items.length) return say(env, owner, `🔎 「${kws.join('、')}」${tally}，没有可以送审的。`);
  const t = await V.createTask(L, { keywords: kws, items, rows: data });
  const res = await V.deliverTask(env, L, owner, t);
  const bot = '@' + await V.verifyName(L);
  if (res.ok) {
    return say(env, owner, `🛂 「${kws.join('、')}」的完整清单（${items.length} 条）已经交给 ${bot}，审核单 ${t.id}。${tally}。去那里审核，通过了小橘才转；24 小时不审就不转。`);
  }
  return say(env, owner, `⏸ 「${kws.join('、')}」的清单没送到 ${bot}：${res.why}\n这批 ${items.length} 条先暂停，一条也不转。处理好后点下面重新送审（或者直接去 ${bot} 点「开始」，它会自己补发）。`,
    [[{ text: '🔁 重新送审', callback_data: `rvs:${t.id}` }]]);
}

async function onReviewDecision(env, id) {
  const L = lib(env), owner = await ownerId(env);
  const t = await V.getTask(L, id);
  if (!t || !owner) return;
  const what = `审核单 ${t.id}（「${t.keywords.join('、')}」${t.items.length} 条）`;
  if (t.status === 'rejected') return say(env, owner, `❌ ${what}没通过，一条不转。`);
  if (t.status === 'expired') return say(env, owner, `⌛ ${what}超时没审，一条不转。要转就重新搜一次。`);
  if (t.status !== 'approved') return;
  return transferApproved(env, L, owner, t);
}

// 只转任务表里 approved 的那一批（就是审核时看到的那份数据）
async function transferApproved(env, L, owner, t) {
  const what = `审核单 ${t.id}（「${t.keywords.join('、')}」${t.items.length} 条）`;
  const fail = async tip => {
    t.transfer = 'failed';
    await V.saveTask(L, t);
    return say(env, owner, `⚠️ ${what}审核通过了，但还没转：${tip}`, [[{ text: '🔁 再试转发', callback_data: `rvt:${t.id}` }]]);
  };
  if (t.status !== 'approved') return;
  if (t.transfer === 'started') return;
  // 转之前按现在的规则再查一遍（审核之后规则可能改过）：只看「过滤」；「只标记」的审核时已经由频道主看过
  const rules = (await filterRules(L)).filter(r => r.action === 'filter');
  for (const k of t.keywords) {
    const hit = ruleHit(rules, k, 'keyword');
    if (hit) { await L.logFilter([hitEntry(hit, 'transfer', 'filtered', k, k)]); return say(env, owner, refusal(hit, `${what}不转。`)); }
  }
  if (!streamerOn(env) || !env.VIDEO_CHANNEL_ID) return fail('还没设置视频频道');
  const all = await V.taskRows(L, t), log = [];
  const data = all.filter(r => {
    const hit = ruleHit(rules, captionOf(r), 'caption');
    if (hit) log.push(hitEntry(hit, 'transfer', 'filtered', (r && r.aweme_id) || '', captionOf(r)));
    return !hit;
  });
  if (log.length) await L.logFilter(log);
  if (!data.length) return fail(all.length ? '这一批都命中了过滤规则' : '作品数据不见了，重新搜一次');
  let r;
  try {
    r = await douyinStart(env, '/douyin/import', {
      text: data.map(x => JSON.stringify(x)).join('\n'), target: env.VIDEO_CHANNEL_ID, notify: owner, final: true,
      tags: await douyinTagMap(L, 'douyinTags'),
    });
  } catch {
    return fail('小橘的服务正在唤醒，过一两分钟再点');
  }
  if (r.status === 409) return fail('小橘正在转别的，转完再点');
  if (r.status !== 200) return fail((r.data && r.data.detail) || '没转成');
  t.transfer = 'started';
  await V.saveTask(L, t);
  // 只转这一批，不登记这些号（登记了云电脑每次开机都会抓它们的全部作品）；要长期同步的号用「添加抖音账号」单独加
  return say(env, owner, `✅ ${what}审核通过，开始转 ${data.length} 条${log.length ? `（按过滤规则去掉 ${log.length} 条）` : ''}（只转这一批，不登记账号）；进度点「📊 进度」看`);
}

async function expireReviews(env) {
  return V.expireTasks(env, lib(env), await ownerId(env), id => onReviewDecision(env, id));
}

async function ownerVerify(env, chat, msgId, token, origin) {
  const L = lib(env);
  if (token) {
    // 令牌不留在聊天记录里
    await tg(env, 'deleteMessage', { chat_id: chat, message_id: msgId });
    const r = await V.connectVerifyBot(env, L, token, origin);
    if (!r.ok) return say(env, chat, `没接上审核机器人：${r.why}`);
    return say(env, chat, `✅ 接上了 @${r.name}（你发的令牌那条已经删掉）。\n去 @${r.name} 点一下「开始」，它才能给你发审核清单。以后搜抖音搜完，完整清单都交给它审核，审核通过小橘才转。`);
  }
  const has = !!(env.VERIFY_BOT_TOKEN || (await L.getConfig('verifyTok')));
  const list = await V.pendingTasks(L);
  return say(env, chat, [
    has ? `🛂 审核机器人：@${await V.verifyName(L)}` : '🛂 还没接审核机器人：在 @BotFather 里拿到它的令牌，发「审核机器人 令牌」给我',
    list.length ? `等审核 / 暂停的：\n${list.map(t => `· ${t.id}「${t.keywords.join('、')}」${t.items.length} 条 —— ${t.status === 'paused' ? `暂停（${t.reason}）` : '等你审核'}`).join('\n')}` : '现在没有等审核的。',
  ].join('\n\n'), list.filter(t => t.status === 'paused').map(t => [{ text: `🔁 重新送审 ${t.id}`, callback_data: `rvs:${t.id}` }]));
}

async function cloudToken(L) {
  let tok = await L.getConfig('cloudTok');
  if (!tok) {
    tok = [...crypto.getRandomValues(new Uint8Array(24))].map(x => x.toString(16).padStart(2, '0')).join('');
    await L.setConfig('cloudTok', tok);
  }
  return tok;
}

// ── 运行爬虫：云电脑开机不自己抓，频道主点了才抓（dyCrawlReq）。云电脑开着时每 20 秒问 /dy-cloud-config，看到就开抓，
// 开抓时报 starting 进度把它清掉；没开的话等下次打开 ──
const cloudOnline = seen => Date.now() - seen < 90 * 1000;

// 云电脑现在在不在、在干什么。守候脚本不管在抓、在搜，每 20 秒都来问一次 /dy-cloud-config（带 X-Busy 说在干什么）。
// 旧版脚本抓的时候不来问、只每 30 秒报进度：90 秒内报过进度也算连着
async function cloudStatusLine(L) {
  const seen = Number(await L.getConfig('dyCloudSeen')) || 0;
  let c = null;
  try { c = JSON.parse((await L.getConfig('dyCloud')) || 'null'); } catch {}
  const reporting = !!c && ['starting', 'running'].includes(c.phase) && Date.now() - c.at < 90 * 1000;
  if (!cloudOnline(seen)) {
    if (reporting) return `☁️ 云电脑连着，正在${c.mode === 'search' ? '搜' : '抓你的号'}（${ago(Date.now() - c.at)}报过进度），这个词等它做完就搜`;
    return `☁️ 云电脑现在没连上${seen ? `（上次是${ago(Date.now() - seen)}）` : ''}：打开云电脑就会自动做；已经开着的话把网页刷新一下（旧脚本要刷新一次才换成新的）`;
  }
  const busy = (await L.getConfig('dyCloudBusy')) || '', when = `${ago(Date.now() - seen)}来问过`;
  if (busy === 'crawl') return `☁️ 云电脑连着（${when}），正在抓你的号：有词要搜就先停一下抓取，半分钟内开始搜，搜完接着抓`;
  if (busy === 'search') return `☁️ 云电脑连着（${when}），正在搜，这个词排在后面，搜完接着搜`;
  const w = /^wait:(\d+)$/.exec(busy);
  if (w) return `☁️ 云电脑连着（${when}），上一次没搜成（多半是抖音登录过期，去云电脑的「桌面」扫码），${Math.max(1, Math.round(Number(w[1]) / 60))} 分钟后再搜；发新的词会马上搜`;
  return `☁️ 云电脑连着（${when}），半分钟内开始${busy ? '' : '（正在抓、正在搜的话等它做完）'}`;
}

async function requestCrawl(L) {
  let c = null;
  try { c = JSON.parse((await L.getConfig('dyCloud')) || 'null'); } catch {}
  if (c && c.mode === 'crawl' && ['starting', 'running'].includes(c.phase) && Date.now() - c.at < 3 * 60 * 1000) {
    return { short: '正在抓了', text: '☁️ 云电脑正在抓，不用再点。发「进度」看抓到哪了。' };
  }
  await L.setConfig('dyCrawlReq', '1');
  await L.setConfig('dyStop', '0');
  if (cloudOnline(Number(await L.getConfig('dyCloudSeen')) || 0)) {
    return { short: '好，云电脑半分钟内开始抓', text: '▶️ 好，云电脑开着，半分钟内开始抓你登记过的抖音号（只抓频道里还没有的）。要扫码的话去云电脑的「桌面」。发「进度」看抓到哪了。' };
  }
  return { short: '记下了，云电脑没开，打开就抓', text: `▶️ 记下了。云电脑现在没开（或者还是旧版脚本）：打开它就开始抓。\n${CODESPACE_URL}\n已经开着的话，把网页刷新一下。` };
}

async function ownerCrawlRun(env, chat) {
  const L = lib(env);
  if (!(await douyinSelves(L)).length) return say(env, chat, '还没设置你自己的抖音账号（发「添加抖音账号 主页分享链接」）');
  return say(env, chat, (await requestCrawl(L)).text, [[{ text: '📊 进度', callback_data: 'prg:r' }]]);
}

async function ownerCloud(env, chat) {
  const L = lib(env), selves = await douyinSelves(L);
  if (!selves.length) return say(env, chat, '还没设置你自己的抖音账号');
  const tok = await cloudToken(L), ids = selves.join(',');
  await say(env, chat, [
    '☁️ 云电脑（GitHub Codespaces，免费额度内不用绑卡、不会扣费）：',
    '',
    `1. 用 iPad 的 Safari 打开这个链接，点绿色的「Create codespace」，等它装好（第一次大约 5～10 分钟）：\n${CODESPACE_URL}`,
    '2. 装好后在下面「PORTS（端口）」里打开 6080「桌面」，密码 xiaoju，这就是云电脑的桌面',
    '3. 不用粘贴：装好它会自己连上小橘，但不会自己抓。要抓的时候在这里点「▶️ 运行爬虫」，半分钟内开始（没反应就把网页刷新一下）',
    '4. 开抓后桌面上会弹出抖音登录页，用手机抖音扫码（要验证就在那里做；手机打开的话先截屏，再用抖音扫一扫里的相册），抓完自动发回小橘',
    '',
    '万一没自己开始，就把下一条消息粘贴进网页编辑器下面的「TERMINAL（终端）」回车。用完在 github.com/codespaces 里点「⋯ → Stop codespace」停掉（别删）；以后想抓新作品，打开它再点「▶️ 运行爬虫」，登录没过期连码都不用扫。',
    '下一条命令里有你的上传令牌，别发给别人。',
  ].join('\n'));
  return say(env, chat, `bash xiaoju-music/cloud/codespace-auto.sh ${tok} ${ids}`);
}

async function cloudImport(request, env) {
  const L = lib(env), tok = await L.getConfig('cloudTok');
  if (!tok || !sameString(request.headers.get('X-Token') || '', tok)) return json({ error: '令牌不对：在机器人里重新发「云电脑」拿新命令' }, 403);
  if (!streamerOn(env) || !env.VIDEO_CHANNEL_ID) return json({ error: '视频频道没配置' }, 500);
  const body = await request.text();
  if (body.length > 20 * 1024 * 1024) return json({ error: '文件太大' }, 413);
  // 边抓边转：云电脑每抓到一批就送一批（X-Final: 0），抓完送 X-Final: 1；不带这个头当一次送完
  const final = request.headers.get('X-Final') !== '0';
  const owner = await ownerId(env);
  let r;
  try {
    r = await douyinStart(env, '/douyin/import', { text: body, target: env.VIDEO_CHANNEL_ID, notify: owner, final, tags: await douyinTagMap(L, 'douyinTags') });
  } catch {
    return json({ error: '小橘的服务正在唤醒，过两分钟再双击图标重发一次' }, 503);
  }
  if (r.status !== 200) return json({ error: r.data.detail || '小橘没收下，过一会儿再试' }, r.status === 409 ? 409 : 400);
  if (owner && r.data.started) {
    await say(env, owner, final
      ? `☁️ 云电脑发来 ${r.data.total} 条作品（视频 ${r.data.video}、图文 ${r.data.images}），开始转进视频频道，已经有的跳过，转完告诉你`
      : `☁️ 云电脑开始送作品过来了（先到 ${r.data.total} 条），边抓边转进视频频道，已经有的跳过，全部转完告诉你`);
  }
  return json({ ok: true, total: r.data.total, video: r.data.video, images: r.data.images, added: r.data.added ?? r.data.total, started: !!r.data.started });
}

// MediaCrawler（频道主在自己的云电脑上登录抖音抓的）导出的 creator_contents 文件：交给流式服务逐条下载、发帖
async function ownerDouyinImport(env, chat, doc) {
  if (!streamerOn(env) || !env.VIDEO_CHANNEL_ID) return say(env, chat, '解析服务或视频频道没配置');
  if ((doc.file_size || 0) > BOT_DOWNLOAD_LIMIT) return say(env, chat, '文件超过 20 MB，拆成几个再发');
  let textBody;
  try {
    const res = await fetchFile(env, doc.file_id, null);
    if (!res.ok) throw new Error(String(res.status));
    textBody = await res.text();
  } catch {
    return say(env, chat, '这个文件取不下来，再发一次试试');
  }
  let r;
  try {
    r = await douyinStart(env, '/douyin/import', { text: textBody, target: env.VIDEO_CHANNEL_ID, notify: chat, tags: await douyinTagMap(lib(env), 'douyinTags') });
  } catch {
    return say(env, chat, '解析服务正在唤醒，过一两分钟再发一次文件');
  }
  if (r.status === 400) return say(env, chat, r.data.detail || '文件里没认出抖音作品');
  if (r.status === 409) return say(env, chat, '正在处理别的抖音任务，好了以后再发一次文件');
  if (r.status !== 200) return say(env, chat, '解析服务正在唤醒，过一两分钟再发一次文件');
  return say(env, chat, `收到 👌 文件里有 ${r.data.total} 条作品（视频 ${r.data.video}、图文 ${r.data.images}），开始转进视频频道，已经有的跳过，转完告诉你`);
}

// 「添加抖音账号 <主页分享链接>」：加一个频道主自己的账号（小号）
async function ownerDouyinAdd(env, chat, text) {
  if (!streamerOn(env)) return say(env, chat, '解析服务没配置');
  let r;
  try {
    r = await streamerCall(env, '/douyin/resolve', { text });
  } catch {
    return say(env, chat, '解析服务正在唤醒，过一两分钟再发一次');
  }
  if (r.status !== 200) return say(env, chat, r.data.detail || '没认出这个链接');
  if (r.data.kind !== 'user') return say(env, chat, '这是作品链接。要发账号主页的分享链接（抖音里点「我」→ 右上角 ··· →「分享主页」→ 复制链接）');
  const L = lib(env), list = await douyinSelves(L);
  if (list.includes(r.data.id)) return say(env, chat, '这个账号已经在里面了 👌');
  if (list.length >= MAX_SELVES) return say(env, chat, `最多 ${MAX_SELVES} 个账号`);
  await L.setConfig('douyinSelf', JSON.stringify([...list, r.data.id]));
  return say(env, chat, `✅ 加好了，现在有 ${list.length + 1} 个抖音账号。发「转抖音视频」马上转一次；开了自动同步的话之后会自动转。\n视频频道里每条帖子会带上账号标签（默认用抖音昵称），想改名发「账号标签」看看`);
}

// 「转抖音视频」：把频道主自己的抖音账号（config 的 douyinSelf，管理接口 douyin-self 设）能看到的作品（视频和图文）都转到视频频道。
// 只认频道主自己的账号：别人的作品不批量搬
async function ownerDouyinMirror(env, chat) {
  if (!streamerOn(env)) return say(env, chat, '解析服务没配置');
  if (!env.VIDEO_CHANNEL_ID) return say(env, chat, '还没设置视频频道');
  const selves = await douyinSelves(lib(env));
  if (!selves.length) return say(env, chat, '还没设置你自己的抖音账号');
  let r;
  try {
    r = await douyinStart(env, '/douyin/mirror', {
      sec_uids: selves, target: env.VIDEO_CHANNEL_ID, notify: chat, state: (await lib(env).getConfig('douyinState')) || '',
      tags: await douyinTagMap(lib(env), 'douyinTags'),
    });
  } catch {
    return say(env, chat, '解析服务正在唤醒，过一两分钟再发一次');
  }
  if (r.status === 409) return say(env, chat, '正在处理上一个链接，好了会告诉你，之后再发');
  if (r.status !== 200) return say(env, chat, '解析服务正在唤醒，过一两分钟再发一次');
  return say(env, chat, '收到 👌 正在把你抖音上能看到的作品（视频和图文）转到视频频道（不登录），转好了告诉你');
}

// 每 30 分钟：频道主开了「抖音自动同步」就把自己账号（可以几个）公开列表里的新作品转到视频频道（没新的不打扰）。
// 不登录：抖音对没登录的人藏起最新的几条、只给第一页，新作品要等它出现在公开列表里才转得到
const DOUYIN_CRON = '*/30 * * * *';

async function douyinTick(env) {
  if (!streamerOn(env) || !env.VIDEO_CHANNEL_ID) return { ok: false, why: 'not configured' };
  const L = lib(env);
  try { await checkResume(env); } catch {}
  if ((await L.getConfig('douyinAuto')) !== '1') return { ok: false, why: 'off' };
  const selves = await douyinSelves(L);
  if (!selves.length) return { ok: false, why: 'no account' };
  // 上一次转作品用的账号标签记下来（目录里要用），有新的就更新频道里置顶的目录
  try {
    if (await learnDouyinTags(env)) await douyinDirectory(env);
  } catch {}
  const { status } = await douyinStart(env, '/douyin/mirror', {
    sec_uids: selves, target: env.VIDEO_CHANNEL_ID, notify: await ownerId(env), quiet: true, state: (await L.getConfig('douyinState')) || '',
    tags: await douyinTagMap(L, 'douyinTags'),
  });
  return { ok: status === 200, status };
}

// ── 视频频道按账号分类 ──
// 每条帖子的说明里带 #账号标签（流式服务贴），在频道里点标签就只看这个号的作品。
// 名字：频道主起的（config douyinTags: {sec_uid: 名字}）优先；没起就用抖音昵称（流式服务转作品时报回来，记在 douyinTagsSeen）。
// 频道里置顶一条「目录」列出所有账号的标签（config dyDirMsg 是它的消息号，名字变了就改它）
function douyinHashtag(name) {
  return String(name || '').replace(/[^\p{L}\p{N}_]/gu, '').slice(0, 24);
}

async function douyinTagMap(L, key) {
  try {
    const o = JSON.parse((await L.getConfig(key)) || '{}');
    return o && typeof o === 'object' && !Array.isArray(o) ? o : {};
  } catch {
    return {};
  }
}

// 流式服务上一次转作品时每个账号用的标签 → douyinTagsSeen。有变化返回 true
async function learnDouyinTags(env) {
  const { status, data } = await streamerCall(env, '/douyin/status');
  const used = status === 200 && data && typeof data.tags_used === 'object' ? data.tags_used : null;
  if (!used) return false;
  const L = lib(env), seen = await douyinTagMap(L, 'douyinTagsSeen');
  let changed = false;
  for (const [k, v] of Object.entries(used)) {
    const tag = douyinHashtag(v);
    if (tag && seen[k] !== tag) { seen[k] = tag; changed = true; }
  }
  if (changed) await L.setConfig('douyinTagsSeen', JSON.stringify(seen));
  return changed;
}

async function douyinTagList(L) {
  const selves = await douyinSelves(L), mine = await douyinTagMap(L, 'douyinTags'), seen = await douyinTagMap(L, 'douyinTagsSeen');
  return selves.map(id => ({ id, tag: mine[id] || seen[id] || '', custom: !!mine[id] }));
}

// 频道里置顶的目录：有就改，没有（或被删了）就发一条新的置顶
async function douyinDirectory(env) {
  if (!env.VIDEO_CHANNEL_ID) return;
  const L = lib(env), list = await douyinTagList(L);
  const text = ['📂 目录：点账号的标签，只看这个号的作品', '',
    ...list.map((a, i) => `${i + 1}. ${a.tag ? '#' + a.tag : '（还没转过作品，转过以后这里会有标签）'}`),
    '', '📹 是视频，🖼 是图文'].join('\n');
  const old = Number(await L.getConfig('dyDirMsg')) || 0;
  if (old) {
    const r = await tg(env, 'editMessageText', { chat_id: env.VIDEO_CHANNEL_ID, message_id: old, text });
    if (r.ok || /not modified/i.test(r.description || '')) return;
  }
  const r = await tg(env, 'sendMessage', { chat_id: env.VIDEO_CHANNEL_ID, text, disable_notification: true });
  const id = r.ok && r.result && r.result.message_id;
  if (!id) return;
  await L.setConfig('dyDirMsg', String(id));
  await tg(env, 'pinChatMessage', { chat_id: env.VIDEO_CHANNEL_ID, message_id: id, disable_notification: true });
}

// 「账号标签」看所有账号的标签；「账号标签 2 小美」给第 2 个账号改名。改完更新频道里的目录，以后的新帖用新名字，旧帖下次转作品时补上
async function ownerDouyinTags(env, chat, n, name) {
  const L = lib(env);
  if (streamerOn(env)) {
    try { await learnDouyinTags(env); } catch {}
  }
  let list = await douyinTagList(L);
  if (!list.length) return say(env, chat, '还没设置你自己的抖音账号');
  if (n) {
    const i = Number(n) - 1, tag = douyinHashtag(name);
    if (!list[i]) return say(env, chat, `没有第 ${n} 个账号（现在有 ${list.length} 个）`);
    if (!tag) return say(env, chat, '名字里要有文字或数字（表情、空格、符号会被去掉）');
    const mine = await douyinTagMap(L, 'douyinTags');
    mine[list[i].id] = tag;
    await L.setConfig('douyinTags', JSON.stringify(mine));
    list = await douyinTagList(L);
  }
  await douyinDirectory(env);
  return say(env, chat, [
    n ? `✅ 第 ${n} 个账号的标签改成 #${list[Number(n) - 1].tag}` : '🏷 视频频道里每个抖音账号的标签（点标签只看这个号的作品）：',
    '',
    ...list.map((a, i) => `${i + 1}. ${a.tag ? '#' + a.tag : '（还没转过作品，转过以后默认用抖音昵称）'}${a.custom ? '' : a.tag ? '（抖音昵称）' : ''}`),
    '',
    '改名：发「账号标签 序号 名字」，比如「账号标签 2 小美」。新帖马上用新名字，旧帖下次转作品时自动补上；频道里置顶的目录也会跟着改',
  ].join('\n'));
}

async function ownerDouyinLogin(env, chat, origin) {
  if (!streamerOn(env)) return say(env, chat, '解析服务没配置');
  const t = [...crypto.getRandomValues(new Uint8Array(18))].map(x => x.toString(16).padStart(2, '0')).join('');
  await lib(env).setConfig('dlTok', JSON.stringify({ t, exp: Date.now() + 15 * 60 * 1000 }));
  return say(env, chat, `打开这个页面登录抖音（15 分钟内有效，只能你用）：\n${origin}/douyin-login#${t}\n\n页面上点「获取二维码」，用抖音 App 扫一扫。手机上打开的话，长按二维码存到相册，再在抖音「扫一扫」里选相册。登录信息由服务器自己保存。`);
}

// 登录页的接口：/dl/<一次性令牌>/start|status|qr，转给流式服务。登上了就把 cookie 取回来存一份（Space 重启后靠它）
async function douyinLoginApi(env, token, action) {
  const L = lib(env);
  const tok = JSON.parse((await L.getConfig('dlTok')) || '{}');
  if (!tok.t || !sameString(token, tok.t) || Date.now() > tok.exp) return json({ error: '链接过期了，在机器人里再发一次「登录抖音」' }, 403);
  const call = (p, init = {}) => fetch(`${streamerBase(env)}${p}`, {
    ...init, headers: { 'X-Key': env.STREAMER_KEY, 'Content-Type': 'application/json' }, signal: AbortSignal.timeout(BOT_WAIT_MS),
  });
  try {
    if (action === 'start') {
      const r = await call('/douyin/login', { method: 'POST', body: '{}' });
      if (r.ok) return json({ ok: true });
      if (r.status === 409) { // 已经有一次登录在等扫码：直接用它的二维码
        const st = await (await call('/douyin/login/status')).json().catch(() => ({}));
        if (st.status === 'running') return json({ ok: true });
        return json({ error: '服务器正在处理别的抖音任务，过一会儿再点' }, 503);
      }
      return json({ error: '服务器正在唤醒，一分钟后再点' }, 503);
    }
    if (action === 'qr' || action === 'shot') {
      const r = await call(action === 'qr' ? '/douyin/login/qr' : '/douyin/login/shot');
      if (!r.ok) return json({ error: 'no qr' }, 404);
      return new Response(r.body, { headers: { 'Content-Type': 'image/png', 'Cache-Control': 'no-store' } });
    }
    const st = await (await call('/douyin/login/status')).json();
    if (st.logged_in) {
      const r = await call('/douyin/login/state');
      if (r.ok) await L.setConfig('douyinState', await r.text());
    }
    return json({ status: st.status, qr_ready: !!st.qr_ready, logged_in: !!st.logged_in, error: st.error || '',
      scan: st.scan || '', qr_version: st.qr_version || 1 });
  } catch {
    return json({ error: '服务器正在唤醒，一分钟后再试' }, 503);
  }
}

async function ownerDouyinAuto(env, chat, on) {
  const L = lib(env);
  if (on && !(await douyinSelves(L)).length) return say(env, chat, '还没设置你自己的抖音账号');
  await L.setConfig('douyinAuto', on ? '1' : '0');
  return say(env, chat, on
    ? '✅ 抖音自动同步开了：每 30 分钟看一次你的抖音公开主页，有新作品自动转到视频频道。刚发的作品抖音会先对外藏一阵，出现在公开主页上以后才转得到'
    : '抖音自动同步关了');
}

function rows(buttons, per = 2) {
  const out = [];
  for (let i = 0; i < buttons.length; i += per) out.push(buttons.slice(i, i + per));
  return out;
}

// ── 每天夜里自动搬歌 ───────────────────────────────────────────────
// 先看上一晚那次搬完没有：搬完了就把每个频道「看到哪条了」记下来；再开始今晚这次（只看比上次新的帖子）。
// 流式服务在 Hugging Face 上，久没人用会睡着，先叫醒它
async function nightly(env) {
  if (!streamerOn(env)) return { ok: false, why: 'no streamer' };
  const L = lib(env);
  let up = false;
  for (let i = 0; i < 10 && !up; i++) {
    try {
      const r = await fetch(`${streamerBase(env)}/`, { signal: AbortSignal.timeout(20000) });
      up = r.ok && ((await r.json().catch(() => ({}))).ok === true);
    } catch {}
    if (!up) await new Promise(res => setTimeout(res, 20000));
  }
  if (!up) return { ok: false, why: 'streamer asleep' };
  const auto = await L.getAuto();
  const { data: st } = await streamerCall(env, '/auto/status');
  if (st.status === 'running') return { ok: false, why: 'still running' };
  if (st.run_id && st.run_id === auto.runId && st.sources) {
    for (const [name, info] of Object.entries(st.sources)) {
      if (info && info.max_id) auto.state[name] = Math.max(auto.state[name] || 0, info.max_id);
    }
    auto.lastCopied = st.copied;
  }
  const sources = await L.getSources();
  const runId = new Date().toISOString().slice(0, 19);
  const { status } = await streamerCall(env, '/auto/start', {
    sources: Object.fromEntries(sources.map(s => [s, auto.state[s] || 0])),
    existing: (await L.listTracks()).map(t => [t.title, t.artist]),
    notify: await ownerId(env), run_id: runId, per_source: 30, first_time: 10,
  });
  if (status === 200) { auto.runId = runId; auto.lastStart = new Date().toISOString(); auto.lastCopied = null; }
  await L.setAuto(auto);
  return { ok: status === 200, status, runId };
}

// ── 自动分歌单 ───────────────────────────────────────────────────
// 新歌按歌名里的关键词和歌手放进对应的歌单（一首可以进好几个）；MV、综艺片段、伴奏这类不进歌单，只留在「全部」。
// 都对不上、但有歌手名的，放「华语流行」
const W = s => s.split(' ');
const GENRE_ARTISTS = {
  '经典老歌': W('邓丽君 蔡琴 李宗盛 张学友 刘德华 黎明 郭富城 谭咏麟 张国荣 梅艳芳 王杰 齐秦 童安格 周华健 刘若英 孟庭苇 费玉清 罗大佑 羅大佑 叶倩文 林子祥 许冠杰 陈百强 徐小凤 韩宝仪 卓依婷 甄妮 凤飞飞 高胜美 姜育恒 赵传 伍佰 黄品源 张雨生 郑智化 小虎队 毛阿敏 那英 田震 韦唯 杨钰莹 毛宁 陈慧娴 关淑怡 林忆莲 苏芮 潘美辰 李玲玉 王菲 辛晓琪 黄安 任贤齐 张信哲 刘欢 屠洪刚 郑钧 许巍 汪峰 黑豹 唐朝 Beyond 黄家驹 孙楠 陈淑桦 叶蒨文 周璇 黄莺莺 李翊君 万芳 张宇 光良 品冠 动力火车 庾澄庆 蔡幸娟'),
  '粤语金曲': W('张学友 刘德华 黎明 郭富城 谭咏麟 张国荣 梅艳芳 陈百强 许冠杰 林子祥 叶倩文 Beyond 黄家驹 陈慧娴 关淑怡 李克勤 陈奕迅 杨千嬅 容祖儿 古巨基 郑秀文 卫兰 Twins 谢安琪 吴雨霏 侧田 林峯 张敬轩 周慧敏 许志安 郑中基 薛凯琪 陈小春 草蜢 太极乐队 达明一派 黄耀明 林家谦'),
  '古风国风': W('银临 河图 双笙 等什么君 音阙诗听 小魂 霍尊 司南 叶里 Hita HITA 排骨教主 汐音社 西瓜JUN 灰原穷 刘珂矣 小曲儿 裁缝铺 王朝1982 戴荃 龚琳娜 萨顶顶 徐梦圆 慕寒 李常超 刘烨溦 任安琪 戏班 自得琴社 少司命 国风堂 黄诗扶 乐正绫 洛天依 五音Jw 小坠'),
  '民谣·治愈': W('赵雷 宋冬野 马頔 陈鸿宇 好妹妹 房东的猫 程璧 李志 万能青年旅店 朴树 老狼 郝云 尧十三 陈粒 花粥 谢春花 曾轶可 鹿先森 隔壁老樊 毛不易 刘昊霖 痛仰 新裤子 草东没有派对 告五人 落日飞车 陈绮贞 蛙池 好乐无荒 马良 尹约 宿羽阳 暗杠 福禄寿 门尼 椿乐队 犬儒乐队 银河快递 安与骑兵 莫非定律'),
  '广场舞·民族风': W('凤凰传奇 降央卓玛 乌兰图雅 云飞 杨魏玲花 刀郎 龚玥 阿鲁阿卓 韩红 腾格尔 德德玛 王琪 祁隆 乌兰托娅 李琼 雷佳 宋祖英 卓依婷 庄心妍 云朵 拉毛 斯琴格日乐 布仁巴雅尔 安东阳'),
  '说唱': W('GAI 艾热 法老 马思唯 幼稚园杀手 谢帝 万妮达 VAVA 盛宇 杨和苏 弹壳 小青龙 黄旭 C-BLOCK 功夫胖 布瑞吉 BrAnTB 宝石Gem Capper 蛋堡 热狗 潘玮柏 KEY.L'),
  '华语流行': W('周杰伦 林俊杰 薛之谦 陈奕迅 邓紫棋 G.E.M. 蔡依林 王力宏 孙燕姿 梁静茹 张惠妹 五月天 李荣浩 周深 许嵩 汪苏泷 张杰 华晨宇 田馥甄 S.H.E 萧敬腾 杨丞琳 林宥嘉 徐佳莹 莫文蔚 张韶涵 王心凌 李宇春 张靓颖 周笔畅 郁可唯 任然 单依纯 张碧晨 刘宇宁 胡夏 杨宗纬 方大同 陶喆 蔡健雅 梁博 张远 李健 陈楚生 苏打绿 吴青峰 王嘉尔 易烊千玺 王俊凯 王源 时代少年团 TFBOYS 张艺兴 弦子 王贰浪 苏星婕 程响 海来阿木 承桓 王小帅 小阿七'),
  '伤感情歌': W('海来阿木 承桓 王小帅 小阿七 半吨兄弟 张碧晨 王贰浪 苏星婕 祁隆 王琪 杨宗纬 任然 庄心妍 张宇 刘增瞳 弦子 冷漠 杨坤 曲婉婷 莫叫姐姐 阿冗 周林枫 阿肆'),
};
const GENRE_WORDS = [
  ['DJ 劲爆', /dj|remix|慢摇|串烧|劲爆|电音|蹦迪|disco|嗨曲|舞曲|edm|车载/i],
  ['重低音', /重低音|低音炮|bass|超重低/i],
  ['现场 Live', /live|现场|演唱会/i],
  ['粤语金曲', /粤语|粵語|cantonese/i],
  ['古风国风', /古风|国风|戏腔|古筝|琵琶|二胡/],
  ['广场舞·民族风', /广场舞|民族风|草原|蒙古|藏族|西藏|山歌/],
  ['说唱', /说唱|\brap\b|hiphop|hip-hop|cypher/i],
  ['抖音热歌', /抖音|热播|爆款|网红|tiktok/i],
  ['伤感情歌', /伤感|心碎|心痛|离别|失恋|眼泪|分手|忘不了|放手|错过|遗憾|难过|孤单|寂寞|想你/],
];
const NOT_A_SONG = /\.mp4|\bMV\b|综艺|音乐缘计划|伴奏|铃声|广告|会员|试听|片段|教学|有声书|相声|小品|Lyrics Video|Official Video/i;

function genresOf(t, fallback = true) {
  if (NOT_A_SONG.test(t.title)) return [];
  const text = t.title + ' ' + t.artist, out = new Set();
  for (const [name, re] of GENRE_WORDS) if (re.test(text)) out.add(name);
  for (const [name, list] of Object.entries(GENRE_ARTISTS)) if (t.artist && list.some(a => t.artist.includes(a))) out.add(name);
  // 没写歌手的长串烧、「某某专属定制」之类：DJ 频道打的混音，放 DJ 劲爆
  if (!out.size && !t.artist && ((t.duration || 0) >= 600 || /专属|定制|vol\.?\s*\d|私货|全中文|全英文|全粤语|连版/i.test(t.title))) out.add('DJ 劲爆');
  if (fallback && !out.size && t.artist) out.add('华语流行');
  return [...out];
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
