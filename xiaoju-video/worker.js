// 小橘视频 · Cloudflare Worker
//
// 把频道主自己的抖音作品（云电脑同步来的、私聊发来的分享链接）先交审核机器人过审，通过的交给流式服务
// （Hugging Face Space）下载、发进私有 Telegram 频道「小橘视频」；频道里的视频再做成网页直接刷。
//
//   你（私聊）→ 小橘视频机器人 → Worker ⇄ 流式服务 → 抖音网页版 / Telegram 频道
//   观众浏览器 → Worker（/video、/vf、/vp）→ 频道里的视频
//   云电脑（Codespaces）→ Worker（/dy-*）→ 流式服务 → 频道
//   审核机器人 ⇄ Worker
//
//   GET  / 、/video         刷视频网页（video.html）
//   GET  /api/videos        视频池 JSON（新的在前）
//   GET  /vf/<消息号>        视频流，支持 Range；20 MB 以内走 Bot API，更大的转给流式服务 /stream
//   GET  /vp/<消息号>        封面；取一次就存进数据库
//   POST /tg-webhook        小橘视频机器人：频道新帖登记进视频池；频道主私聊（分享链接、命令）
//   POST /verify-webhook    审核机器人：频道主按「通过 / 不转」
//   POST /dy-known、/dy-import、/dy-progress   云电脑用（X-Token 认人，令牌在机器人里发「云电脑」拿）
//   POST /streamer-up、/streamer-done          流式服务报到、报结果（X-Key 认人）
//   GET  /admin             管理页；/admin/api/...（Authorization: Bearer <ADMIN_KEY>）
//
// 数据在 Durable Object「Library」的 SQLite 里。
//
// 绑定：LIB（Durable Object）；secret：TG_BOT_TOKEN（小橘视频机器人）、VERIFY_BOT_TOKEN（审核机器人）、
//       TG_WEBHOOK_SECRET、ADMIN_KEY、STREAMER_KEY；普通变量：VIDEO_CHANNEL_ID、STREAMER_URL

import { DurableObject } from 'cloudflare:workers';
import PAGE from './video.html';
import ADMIN_PAGE from './admin.html';

const TG = 'https://api.telegram.org';
// 官方 Bot API 的 getFile 只能取 20 MB 以内的文件，更大的走流式服务
const BOT_DOWNLOAD_LIMIT = 20 * 1024 * 1024;
// getFile 给的下载路径保证至少 1 小时有效，留 10 分钟余量
const PATH_TTL_MS = 50 * 60 * 1000;
const LIST_TTL_MS = 20 * 1000;
// 等流式服务回响应头的时间；等不到多半是它在休眠
const STREAMER_WAIT_MS = 25 * 1000;
// 交给流式服务后这么久没回音，就当它丢了，再交一次
const SENDING_STALE_MS = 30 * 60 * 1000;
// 一条作品最多试几次，还不行就记成失败、告诉频道主
const MAX_ATTEMPTS = 3;
// 一次交给流式服务几条（它按顺序一条条转）
const DISPATCH_BATCH = 10;
// 云电脑一次最多送多少条
const IMPORT_MAX = 200;
// 逐条审核时一次发几条
const REVIEW_PAGE = 10;
const THUMB_LIMIT = 512 * 1024;

const MSG = {
  unavailable: 'Telegram 暂时取不到这个视频，请稍后再试',
  waking: '大文件服务正在唤醒，大约 1 分钟后再试',
  noStreamer: '这个视频超过 20 MB，暂时不能在网页播放',
  gone: '频道里找不到这个视频了',
};

// 都只活在单个 isolate 里，丢了无妨
const filePaths = new Map(); // file_id -> { path, exp }
let listCache = null;        // { body, exp }

class HttpError extends Error {
  constructor(status, message, headers) {
    super(message);
    this.status = status;
    this.headers = headers;
  }
}

export default {
  // 每 5 分钟：交出去太久没回音的重交，排着队的交给流式服务
  async scheduled(controller, env, ctx) {
    ctx.waitUntil(tick(env).catch(() => {}));
  },
  async fetch(request, env, ctx) {
    const url = new URL(request.url);
    const path = url.pathname;
    const method = request.method;
    try {
      if (method === 'OPTIONS') {
        return new Response(null, { status: 204, headers: cors({ 'Access-Control-Max-Age': '86400' }) });
      }
      if (path === '/tg-webhook' || path === '/verify-webhook') {
        if (method !== 'POST') return text('Method Not Allowed', 405);
        return await webhook(request, env, ctx, path === '/verify-webhook');
      }
      if (path.startsWith('/dy-')) {
        if (method !== 'POST') return text('Method Not Allowed', 405);
        return await cloudApi(request, env, ctx, path);
      }
      if (path === '/streamer-up' || path === '/streamer-done') {
        if (method !== 'POST') return text('Method Not Allowed', 405);
        return await streamerApi(request, env, ctx, path);
      }
      if (path.startsWith('/admin/api/')) return await adminApi(request, env, ctx, url);
      if (method !== 'GET' && method !== 'HEAD') return text('Method Not Allowed', 405);
      if (path === '/' || path === '/video') return html(PAGE, method);
      if (path === '/admin') return html(ADMIN_PAGE, method, { 'X-Robots-Tag': 'noindex' });
      if (path === '/api/videos') return await videoList(env);
      const f = path.match(/^\/vf\/(\d{1,10})(?:\.mp4)?$/);
      if (f) return await videoFile(request, env, Number(f[1]));
      const p = path.match(/^\/vp\/(\d{1,10})$/);
      if (p) return await poster(env, Number(p[1]), method);
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

// ── 两个机器人的 webhook ──────────────────────────────────────────

async function webhook(request, env, ctx, verify) {
  const got = request.headers.get('X-Telegram-Bot-Api-Secret-Token') || '';
  if (!env.TG_WEBHOOK_SECRET || !sameString(got, env.TG_WEBHOOK_SECRET)) return text('Forbidden', 403);
  const update = await request.json().catch(() => null);
  if (!update) return text('ok');
  const origin = new URL(request.url).origin;
  // 私聊、按钮：先回 200，慢慢处理（问流式服务要好几秒，Telegram 等不了太久会重发）
  const later = work => {
    const p = work.catch(() => {});
    if (ctx && ctx.waitUntil) ctx.waitUntil(p);
    return p;
  };
  if (verify) {
    if (update.callback_query) await later(reviewButton(env, update.callback_query, ctx));
    else if (update.message && update.message.chat && update.message.chat.type === 'private') await later(verifyChat(env, update.message));
    return text('ok');
  }
  if (update.callback_query || (update.message && update.message.chat && update.message.chat.type === 'private')) {
    await later(botUpdate(env, update, origin, ctx));
    return text('ok');
  }
  const post = update.channel_post || update.edited_channel_post;
  // 只收视频频道的帖子；别的一律忽略，但仍回 200，免得 Telegram 反复重发
  if (!post || !Number.isInteger(post.message_id) || String(post.chat && post.chat.id) !== String(env.VIDEO_CHANNEL_ID)) {
    return text('ok');
  }
  const rec = toRecord(post);
  const L = lib(env);
  if (rec) {
    await L.upsertVideo(rec);
    // 流式服务发帖时在说明里带「#dy<作品号>」：就算它的回报丢了，这里也能把作品记成已转
    if (rec.aweme) await L.markPosted(rec.aweme, rec.id);
  } else if (update.edited_channel_post) {
    await L.removeVideo(post.message_id); // 编辑后已不含视频
  } else {
    // 图文作品发成相册（几条图片帖）：记成已转，不进视频池
    const aweme = awemeOf(post.caption || '');
    if (aweme) await L.markPosted(aweme, post.message_id);
  }
  listCache = null;
  return text('ok');
}

function awemeOf(caption) {
  const m = /#dy(\d{6,25})\b/.exec(caption || '');
  return m ? m[1] : '';
}

function toRecord(post) {
  let v = post.video;
  if (!v && post.document && /^video\//.test(post.document.mime_type || '')) v = post.document;
  if (!v || !v.file_id) return null;
  const thumb = v.thumbnail || v.thumb;
  return {
    id: post.message_id,
    file_id: v.file_id,
    size: Number(v.file_size) || 0,
    duration: Number(v.duration) || 0,
    width: Number(v.width) || 0,
    height: Number(v.height) || 0,
    mime: /^video\//.test(v.mime_type || '') ? v.mime_type : 'video/mp4',
    thumb: thumb && thumb.file_id ? thumb.file_id : '',
    caption: String(post.caption || '').slice(0, 1024),
    date: Number(post.date) || 0,
    aweme: awemeOf(post.caption || ''),
  };
}

// ── 小橘视频机器人：频道主私聊 ─────────────────────────────────────

const HELP = `我是小橘视频的管理助手 🍊

• 直接发抖音分享链接（整段分享文字也行）：先去审核机器人 @xiaojuverify_bot 过审，通过后转进视频频道
• 云电脑：拿云电脑的上传令牌和命令，用来同步你自己抖音账号的全部作品
• 进度：看排队、在转、已转、失败各多少
• 重试失败：把失败的作品重新排队
• 帮助：显示这段说明`;

const OWNER_KEYBOARD = {
  keyboard: [[{ text: '进度' }, { text: '云电脑' }], [{ text: '重试失败' }, { text: '帮助' }]],
  resize_keyboard: true,
  is_persistent: true,
};

async function tg(token, method, payload) {
  const res = await fetch(`${TG}/bot${token}/${method}`, {
    method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(payload),
  });
  return res.json().catch(() => ({}));
}

function say(env, chatId, msg, extra) {
  return tg(env.TG_BOT_TOKEN, 'sendMessage', { chat_id: chatId, text: msg, disable_web_page_preview: true, ...extra });
}

function verifySay(env, chatId, msg, buttons) {
  const payload = { chat_id: chatId, text: msg, disable_web_page_preview: true };
  if (buttons) payload.reply_markup = { inline_keyboard: buttons };
  return tg(env.VERIFY_BOT_TOKEN, 'sendMessage', payload);
}

// 频道主：视频频道的创建者（问一次 Telegram 就记下来）
async function ownerId(env) {
  const L = lib(env);
  let id = await L.getConfig('ownerId');
  if (!id) {
    const r = await tg(env.TG_BOT_TOKEN, 'getChatAdministrators', { chat_id: env.VIDEO_CHANNEL_ID });
    const c = (r.result || []).find(a => a.status === 'creator');
    if (c) await L.setConfig('ownerId', (id = String(c.user.id)));
  }
  return id ? Number(id) : null;
}

async function botUpdate(env, update, origin, ctx) {
  const msg = update.message;
  if (!msg) return; // 这个机器人没有按钮
  const chat = msg.chat.id;
  const owner = await ownerId(env);
  if (!owner || msg.from.id !== owner) {
    await say(env, chat, `你好，这里是小橘视频 🍊 打开网页就能刷：${origin}/video`);
    return;
  }
  const t = String(msg.text || msg.caption || '').trim();
  const links = douyinLinks(t);
  if (links.length) return await submitLinks(env, chat, links);
  if (t === '/start' || t === '帮助' || t === '/help') return await say(env, chat, HELP, { reply_markup: OWNER_KEYBOARD });
  if (t === '进度' || t === '/status') return await say(env, chat, await progressText(env), { reply_markup: OWNER_KEYBOARD });
  if (t === '云电脑' || t === '/cloud') return await cloudInfo(env, chat, origin);
  if (t === '重试失败' || t === '/retry') {
    const n = await lib(env).retryFailed();
    await say(env, chat, n ? `已把 ${n} 条失败的作品重新排队` : '没有失败的作品');
    if (n) await dispatch(env);
    return;
  }
  await say(env, chat, '没看懂。发抖音分享链接，或者点下面的按钮。', { reply_markup: OWNER_KEYBOARD });
}

// 分享文字里的抖音链接：v.douyin.com 短链接、www.douyin.com/video|note/<号>、iesdouyin 分享页
function douyinLinks(t) {
  const found = String(t || '').match(/https?:\/\/(?:v\.douyin\.com|(?:www\.|m\.)?douyin\.com|(?:www\.)?iesdouyin\.com)\/[^\s，。！？、"'<>]*/gi) || [];
  return [...new Set(found.map(u => u.replace(/[),.;!?]+$/, '')))].slice(0, 10);
}

async function submitLinks(env, chat, links) {
  if (!streamerOn(env)) return await say(env, chat, '还没接上流式服务，暂时认不了链接');
  const L = lib(env);
  const owner = await ownerId(env);
  let added = 0, dup = 0;
  const bad = [];
  for (const link of links) {
    const r = await streamerCall(env, '/douyin/resolve', { url: link }).catch(() => null);
    const item = r && r.status === 200 && r.data && normalizeItem(r.data.item);
    if (!item) {
      bad.push(r ? (r.data && r.data.error) || `流式服务回 ${r.status}` : '流式服务没响应（可能在休眠，1 分钟后再发一次）');
      continue;
    }
    const fresh = await L.addItems([item], 'link');
    if (!fresh.length) { dup++; continue; }
    added++;
    await sendReview(env, owner, item);
  }
  const parts = [];
  if (added) parts.push(`${added} 条已交审核机器人 @xiaojuverify_bot，去那里点「通过」`);
  if (dup) parts.push(`${dup} 条以前已经收过`);
  if (bad.length) parts.push(`${bad.length} 条认不出：${bad.join('；')}`);
  await say(env, chat, parts.join('\n'));
}

async function progressText(env) {
  const L = lib(env);
  const c = await L.counts();
  const p = JSON.parse((await L.getConfig('cloudProgress')) || 'null');
  const up = Number(await L.getConfig('streamerUp')) || 0;
  const lines = [
    `视频池：${c.videos} 条`,
    `作品：待审核 ${c.review || 0} · 排队 ${c.queued || 0} · 在转 ${c.sending || 0} · 已转 ${c.posted || 0} · 失败 ${c.failed || 0} · 不转 ${c.rejected || 0}`,
    `流式服务：${!streamerOn(env) ? '没配置' : up ? '上次报到 ' + ago(up) : '还没报到过'}`,
  ];
  if (p) lines.push(`云电脑：${p.stage || ''} ${p.done || 0}/${p.total || 0}${p.note ? ' · ' + p.note : ''}（${ago(p.at)}）`);
  return lines.join('\n');
}

function ago(ms) {
  const s = Math.max(0, Math.round((Date.now() - ms) / 1000));
  if (s < 60) return `${s} 秒前`;
  if (s < 3600) return `${Math.round(s / 60)} 分钟前`;
  if (s < 86400) return `${Math.round(s / 3600)} 小时前`;
  return `${Math.round(s / 86400)} 天前`;
}

// 每发一次「云电脑」就换一个新令牌，旧的立刻作废
async function cloudInfo(env, chat, origin) {
  const token = randomToken();
  await lib(env).setConfig('cloudToken', token);
  await say(env, chat, `云电脑的新上传令牌已生成（旧的作废了）。在云电脑（GitHub Codespaces，配置是 .devcontainer/xiaoju-video）的终端里粘贴：

bash xiaoju-video/cloud/run.sh setup ${origin} ${token} <你自己的抖音主页链接>

主页链接形如 https://www.douyin.com/user/MS4wLjABAAAA…（抖音网页版点自己头像，复制地址栏）。然后：
bash xiaoju-video/cloud/run.sh sync —— 用 MediaCrawler 抓你主页的全部作品，新的交给审核机器人。
第一次会要求扫码：打开端口 6080 的网页桌面（密码 vscode），60 秒内用抖音 App 扫浏览器里的二维码。

令牌只发这一次，别给别人。`);
}

function randomToken() {
  const b = new Uint8Array(24);
  crypto.getRandomValues(b);
  return [...b].map(x => x.toString(16).padStart(2, '0')).join('');
}

// ── 审核机器人 ────────────────────────────────────────────────────

const KIND = { video: '视频', images: '图文' };

function reviewText(item) {
  return [
    `待审核 · 抖音${KIND[item.type] || '作品'}（${item.src === 'cloud' ? '云电脑同步' : '私聊链接'}）`,
    item.desc ? item.desc.slice(0, 300) : '（没有文字）',
    item.author ? `作者：${item.author}` : '',
    item.url,
  ].filter(Boolean).join('\n');
}

async function sendReview(env, owner, item) {
  if (!owner) return;
  await verifySay(env, owner, reviewText(item), [[
    { text: '✅ 通过', callback_data: `ok:${item.aweme}` },
    { text: '❌ 不转', callback_data: `no:${item.aweme}` },
  ]]);
}

// 云电脑一次送来很多条：先发一条汇总，频道主可以全部通过、逐条看、或全部不转
async function announceCloud(env, n) {
  const owner = await ownerId(env);
  if (!owner) return;
  const total = (await lib(env).counts()).cloudReview || n;
  await verifySay(env, owner, `云电脑新同步来 ${n} 条你自己账号的作品，现在一共 ${total} 条等你审核。`, [
    [{ text: `✅ 全部通过（${total}）`, callback_data: 'cloud-ok' }],
    [{ text: '👀 逐条审核', callback_data: 'cloud-each' }, { text: '❌ 全部不转', callback_data: 'cloud-no' }],
  ]);
}

async function verifyChat(env, msg) {
  const owner = await ownerId(env);
  if (!owner || msg.from.id !== owner) {
    await verifySay(env, msg.chat.id, '这是小橘视频的审核机器人，只有频道主能用。');
    return;
  }
  const c = await lib(env).counts();
  const buttons = c.review ? [[{ text: `👀 看待审核的（${c.review}）`, callback_data: 'pending' }]] : null;
  await verifySay(env, msg.chat.id, c.review ? `有 ${c.review} 条作品等你审核。` : '现在没有待审核的作品。', buttons);
}

async function reviewButton(env, cb, ctx) {
  const answer = t => tg(env.VERIFY_BOT_TOKEN, 'answerCallbackQuery', { callback_query_id: cb.id, text: t || '' });
  const owner = await ownerId(env);
  if (!owner || cb.from.id !== owner) return await answer('只有频道主能审核');
  const L = lib(env);
  const data = String(cb.data || '');
  const chat = cb.message && cb.message.chat.id;
  const msgId = cb.message && cb.message.message_id;
  const edit = t => tg(env.VERIFY_BOT_TOKEN, 'editMessageText', { chat_id: chat, message_id: msgId, text: t, disable_web_page_preview: true });
  const one = /^(ok|no):(\d{6,25})$/.exec(data);
  if (one) {
    const to = one[1] === 'ok' ? 'queued' : 'rejected';
    const n = await L.review([one[2]], to);
    const item = await L.getItem(one[2]);
    await answer(n ? (to === 'queued' ? '已通过，排队转发' : '不转了') : '这条已经审过了');
    if (item) await edit(`${to === 'queued' ? '✅ 已通过' : '❌ 不转'}\n${reviewText(item)}`);
    if (n && to === 'queued') await dispatch(env);
    return;
  }
  if (data === 'cloud-ok' || data === 'cloud-no') {
    const to = data === 'cloud-ok' ? 'queued' : 'rejected';
    const n = await L.reviewAllCloud(to);
    await answer(`${n} 条${to === 'queued' ? '已通过' : '不转了'}`);
    await edit(`云电脑同步的 ${n} 条作品：${to === 'queued' ? '✅ 全部通过，排队转发' : '❌ 全部不转'}`);
    if (n && to === 'queued') await dispatch(env);
    return;
  }
  if (data === 'cloud-each' || data === 'pending') {
    const items = await L.listItems('review', REVIEW_PAGE, data === 'cloud-each' ? 'cloud' : '');
    await answer(items.length ? '' : '没有待审核的了');
    for (const item of items) await sendReview(env, owner, item);
    const left = (await L.counts()).review - items.length;
    if (left > 0) await verifySay(env, owner, `还有 ${left} 条。`, [[{ text: `👀 再来 ${Math.min(left, REVIEW_PAGE)} 条`, callback_data: 'pending' }]]);
    return;
  }
  await answer();
}

// ── 交给流式服务 ──────────────────────────────────────────────────

async function streamerCall(env, path, body) {
  const res = await fetch(`${streamerBase(env)}${path}`, {
    method: body ? 'POST' : 'GET',
    headers: { 'X-Key': env.STREAMER_KEY, 'Content-Type': 'application/json' },
    body: body ? JSON.stringify(body) : undefined,
    signal: AbortSignal.timeout(STREAMER_WAIT_MS),
  });
  const data = await res.json().catch(() => ({}));
  return { status: res.status, data };
}

// 把排队的作品交给流式服务：先在数据库里改成「在转」（别的请求就不会重复交），交不出去再放回队列
async function dispatch(env) {
  if (!streamerOn(env)) return 0;
  const L = lib(env);
  const items = await L.claimQueued(DISPATCH_BATCH, Date.now());
  if (!items.length) return 0;
  const r = await streamerCall(env, '/douyin/post', { items }).catch(() => null);
  if (!r || r.status !== 200 || !r.data || !r.data.ok) {
    await L.release(items.map(i => i.aweme));
    return 0;
  }
  return items.length;
}

async function tick(env) {
  const L = lib(env);
  const failed = await L.expireSending(Date.now() - SENDING_STALE_MS, MAX_ATTEMPTS);
  if (failed.length) await notifyFailed(env, failed);
  await dispatch(env);
}

async function notifyFailed(env, items) {
  const owner = await ownerId(env);
  if (!owner || !items.length) return;
  const lines = items.slice(0, 10).map(i => `• ${(i.desc || i.aweme).slice(0, 40)}：${i.error || '没有回音'}`);
  if (items.length > 10) lines.push(`……一共 ${items.length} 条`);
  await say(env, owner, `这些作品试了 ${MAX_ATTEMPTS} 次还是没转成，发「重试失败」可以再排队：\n${lines.join('\n')}`);
}

async function streamerApi(request, env, ctx, path) {
  const got = request.headers.get('X-Key') || '';
  if (!env.STREAMER_KEY || !sameString(got, env.STREAMER_KEY)) return json({ error: 'forbidden' }, 403);
  const body = await request.json().catch(() => ({}));
  const L = lib(env);
  if (path === '/streamer-up') {
    // 流式服务刚起来：它手上的任务都丢了，「在转」的全部放回队列再交一次
    await L.setConfig('streamerUp', String(Date.now()));
    await L.releaseAllSending();
    const p = dispatch(env).catch(() => 0);
    if (ctx && ctx.waitUntil) ctx.waitUntil(p); else await p;
    return json({ ok: true });
  }
  const aweme = String(body.aweme || '');
  if (!/^\d{6,25}$/.test(aweme)) return json({ error: 'bad aweme' }, 400);
  const res = await L.itemDone(aweme, !!body.ok, Number(body.message_id) || 0, String(body.error || '').slice(0, 300), MAX_ATTEMPTS);
  if (res === 'failed') await notifyFailed(env, [await L.getItem(aweme)]);
  // 它的队列空了才再交下一批
  if (body.idle) {
    const p = dispatch(env).catch(() => 0);
    if (ctx && ctx.waitUntil) ctx.waitUntil(p); else await p;
  }
  return json({ ok: true, status: res });
}

// ── 云电脑 ────────────────────────────────────────────────────────

async function cloudApi(request, env, ctx, path) {
  const L = lib(env);
  const want = await L.getConfig('cloudToken');
  const got = request.headers.get('X-Token') || '';
  if (!want || !sameString(got, want)) return json({ error: 'forbidden' }, 403);
  const body = await request.json().catch(() => ({}));
  if (path === '/dy-known') {
    const ids = (Array.isArray(body.ids) ? body.ids : []).map(String).filter(x => /^\d{6,25}$/.test(x)).slice(0, 1000);
    return json({ known: await L.knownAwemes(ids) });
  }
  if (path === '/dy-import') {
    const raw = Array.isArray(body.items) ? body.items : [];
    if (raw.length > IMPORT_MAX) return json({ error: `一次最多 ${IMPORT_MAX} 条` }, 413);
    const items = raw.map(normalizeItem).filter(Boolean);
    const fresh = await L.addItems(items, 'cloud');
    if (fresh.length) {
      const p = announceCloud(env, fresh.length).catch(() => {});
      if (ctx && ctx.waitUntil) ctx.waitUntil(p); else await p;
    }
    return json({ ok: true, added: fresh.length, skipped: items.length - fresh.length, invalid: raw.length - items.length });
  }
  if (path === '/dy-progress') {
    const p = {
      stage: String(body.stage || '').slice(0, 40), done: Number(body.done) || 0, total: Number(body.total) || 0,
      note: String(body.note || '').slice(0, 200), at: Date.now(),
    };
    await L.setConfig('cloudProgress', JSON.stringify(p));
    return json({ ok: true });
  }
  return json({ error: 'not found' }, 404);
}

const HTTPS = /^https:\/\/[^\s]{4,2000}$/;

// 云电脑、流式服务送来的作品一律在这里过一遍，只留认得的字段
function normalizeItem(x) {
  if (!x || typeof x !== 'object') return null;
  const aweme = String(x.aweme || '');
  if (!/^\d{6,25}$/.test(aweme)) return null;
  const type = x.type === 'images' ? 'images' : x.type === 'video' ? 'video' : '';
  if (!type) return null;
  const item = {
    aweme, type,
    desc: String(x.desc || '').slice(0, 1000),
    author: String(x.author || '').slice(0, 100),
    create_time: Number(x.create_time) || 0,
    url: HTTPS.test(x.url || '') ? x.url : `https://www.douyin.com/${type === 'images' ? 'note' : 'video'}/${aweme}`,
  };
  if (type === 'video' && HTTPS.test(x.video_url || '')) item.video_url = x.video_url;
  if (type === 'images') item.images = (Array.isArray(x.images) ? x.images : []).filter(u => HTTPS.test(u || '')).slice(0, 35);
  if (HTTPS.test(x.cover || '')) item.cover = x.cover;
  return item;
}

// ── 管理接口 ──────────────────────────────────────────────────────

async function adminApi(request, env, ctx, url) {
  const got = (request.headers.get('Authorization') || '').replace(/^Bearer\s+/i, '');
  if (!env.ADMIN_KEY || !sameString(got, env.ADMIN_KEY)) return json({ error: 'forbidden' }, 403);
  const L = lib(env);
  const action = url.pathname.slice('/admin/api/'.length);
  if (action === 'state' && request.method === 'GET') {
    const status = url.searchParams.get('status') || '';
    return json({
      counts: await L.counts(),
      progress: JSON.parse((await L.getConfig('cloudProgress')) || 'null'),
      streamerUp: Number(await L.getConfig('streamerUp')) || 0,
      streamer: streamerOn(env),
      items: await L.listItems(status, 100, ''),
    });
  }
  if (request.method !== 'POST') return json({ error: 'method' }, 405);
  const body = await request.json().catch(() => ({}));
  if (action === 'video-delete') {
    await L.removeVideo(Number(body.id));
    listCache = null;
    return json({ ok: true });
  }
  if (action === 'retry-failed') {
    const n = await L.retryFailed();
    if (n) await dispatch(env);
    return json({ ok: true, n });
  }
  if (action === 'review') {
    const ids = (Array.isArray(body.ids) ? body.ids : []).map(String).filter(x => /^\d{6,25}$/.test(x));
    const to = body.to === 'queued' ? 'queued' : body.to === 'rejected' ? 'rejected' : '';
    if (!to) return json({ error: 'bad to' }, 400);
    const n = await L.review(ids, to);
    if (n && to === 'queued') await dispatch(env);
    return json({ ok: true, n });
  }
  if (action === 'dispatch') return json({ ok: true, n: await dispatch(env) });
  return json({ error: 'not found' }, 404);
}

// ── 视频池、视频流、封面 ───────────────────────────────────────────

async function videoList(env) {
  if (!listCache || listCache.exp < Date.now()) {
    const videos = await lib(env).listVideos();
    listCache = { body: JSON.stringify({ videos }), exp: Date.now() + LIST_TTL_MS };
  }
  return new Response(listCache.body, {
    headers: cors({ 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'public, max-age=20' }),
  });
}

async function videoFile(request, env, id) {
  const rec = await lib(env).getVideo(id);
  if (!rec) throw new HttpError(404, '没有这个视频');
  const big = !rec.size || rec.size > BOT_DOWNLOAD_LIMIT;
  if (big && !streamerOn(env)) throw new HttpError(503, MSG.noStreamer);
  const headers = cors({
    'Content-Type': rec.mime,
    'Accept-Ranges': 'bytes',
    'Cache-Control': 'public, max-age=86400',
  });
  if (!rec.size) {
    // 不知道大小（不该出现）：整段交给流式服务，它自己处理 Range
    const res = await fromStreamer(env, rec, null, request.headers.get('Range'));
    for (const h of ['Content-Length', 'Content-Range']) if (res.headers.get(h)) headers[h] = res.headers.get(h);
    return new Response(request.method === 'HEAD' ? null : res.body, { status: res.status, headers });
  }
  if (request.method === 'HEAD') {
    headers['Content-Length'] = String(rec.size);
    return new Response(null, { headers });
  }
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

function upstreamRange(rec, range) {
  return range.start === 0 && range.end === rec.size - 1 ? null : `bytes=${range.start}-${range.end}`;
}

function bodyMatches(res, want, range) {
  const len = res.headers.get('Content-Length');
  return res.status === (want ? 206 : 200) && (len === null || Number(len) === range.end - range.start + 1);
}

async function fromBotApi(env, rec, range) {
  const want = upstreamRange(rec, range);
  const res = await fetchFile(env, rec.file_id, want);
  if (!bodyMatches(res, want, range)) {
    if (res.body) res.body.cancel();
    throw new HttpError(502, MSG.unavailable);
  }
  return res;
}

async function fromStreamer(env, rec, range, rawRange) {
  const want = range ? upstreamRange(rec, range) : rawRange;
  const headers = { 'X-Key': env.STREAMER_KEY };
  if (want) headers.Range = want;
  // 只限制等响应头的时间；拿到响应头后就不再计时，长视频可以一直传下去
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
  if (!range ? [200, 206].includes(res.status) : bodyMatches(res, want, range)) return res;
  if (res.body) res.body.cancel();
  if (res.status === 404) throw new HttpError(404, MSG.gone);
  // 5xx 或一张网页（Hugging Face 的「正在启动」页）：服务还没醒
  if (res.status >= 500 || (res.headers.get('Content-Type') || '').includes('text/html')) throw waking();
  throw new HttpError(502, MSG.unavailable);
}

function waking() {
  return new HttpError(503, MSG.waking, { 'Retry-After': '15' });
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

async function poster(env, id, method) {
  const L = lib(env);
  let hit = await L.getThumb(id);
  if (!hit) {
    const rec = await L.getVideo(id);
    if (!rec) throw new HttpError(404, '没有这个视频');
    const img = await fetchThumb(env, rec);
    if (!img) throw new HttpError(404, '这个视频没有封面');
    hit = { mime: img.mime, data: toBase64(img.bytes) };
    await L.putThumb(id, hit.mime, hit.data);
  }
  return new Response(method === 'HEAD' ? null : fromBase64(hit.data), {
    headers: cors({ 'Content-Type': hit.mime, 'Cache-Control': 'public, max-age=604800, immutable' }),
  });
}

async function fetchThumb(env, rec) {
  if (rec.thumb) {
    const res = await fetchFile(env, rec.thumb, null).catch(() => null);
    const img = res && (await imageFrom(res));
    if (img) return img;
  }
  if (!streamerOn(env)) return null;
  const res = await fetch(`${streamerBase(env)}/thumb/${rec.id}`, {
    headers: { 'X-Key': env.STREAMER_KEY }, signal: AbortSignal.timeout(STREAMER_WAIT_MS),
  }).catch(() => null);
  return res ? await imageFrom(res) : null;
}

async function imageFrom(res) {
  if (res.status !== 200) {
    if (res.body) res.body.cancel();
    return null;
  }
  const bytes = new Uint8Array(await res.arrayBuffer());
  if (!bytes.length || bytes.length > THUMB_LIMIT) return null;
  const mime = bytes[0] === 0x89 ? 'image/png' : bytes[0] === 0x52 ? 'image/webp' : 'image/jpeg';
  return { mime, bytes };
}

function toBase64(bytes) {
  let s = '';
  for (let i = 0; i < bytes.length; i += 0x8000) s += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
  return btoa(s);
}

function fromBase64(b64) {
  const s = atob(b64);
  const out = new Uint8Array(s.length);
  for (let i = 0; i < s.length; i++) out[i] = s.charCodeAt(i);
  return out;
}

// ── 数据：Durable Object「Library」────────────────────────────────

export class Library extends DurableObject {
  constructor(ctx, env) {
    super(ctx, env);
    this.sql = ctx.storage.sql;
    ctx.blockConcurrencyWhile(async () => {
      // 视频池：频道里的视频帖，每条一行；rec 是完整记录（含 Bot API 的 file_id）
      this.sql.exec('CREATE TABLE IF NOT EXISTS videos (id INTEGER PRIMARY KEY, rec TEXT NOT NULL, date INTEGER NOT NULL)');
      this.sql.exec('CREATE TABLE IF NOT EXISTS thumbs (id INTEGER PRIMARY KEY, mime TEXT NOT NULL, data TEXT NOT NULL)');
      // 抖音作品：status 是 review（待审核）/ rejected（不转）/ queued（排队）/ sending（交给流式服务了）/
      // posted（已发进频道，msg 是消息号）/ failed（试了 MAX_ATTEMPTS 次还不行）；src 是 cloud / link
      this.sql.exec(`CREATE TABLE IF NOT EXISTS items (aweme TEXT PRIMARY KEY, status TEXT NOT NULL, src TEXT NOT NULL,
        data TEXT NOT NULL, created INTEGER NOT NULL, updated INTEGER NOT NULL, attempts INTEGER NOT NULL DEFAULT 0,
        msg INTEGER NOT NULL DEFAULT 0, error TEXT NOT NULL DEFAULT '')`);
      this.sql.exec('CREATE INDEX IF NOT EXISTS items_status ON items (status, created)');
      this.sql.exec('CREATE TABLE IF NOT EXISTS config (k TEXT PRIMARY KEY, v TEXT NOT NULL)');
    });
  }

  getConfig(k) {
    const r = this.sql.exec('SELECT v FROM config WHERE k = ?', k).toArray()[0];
    return r ? r.v : null;
  }

  setConfig(k, v) {
    this.sql.exec('INSERT INTO config (k, v) VALUES (?, ?) ON CONFLICT(k) DO UPDATE SET v = excluded.v', k, String(v));
  }

  // ── 视频池 ──
  upsertVideo(rec) {
    const fresh = !this.sql.exec('SELECT 1 FROM videos WHERE id = ?', rec.id).toArray().length;
    this.sql.exec('INSERT INTO videos (id, rec, date) VALUES (?, ?, ?) ON CONFLICT(id) DO UPDATE SET rec = excluded.rec, date = excluded.date',
      rec.id, JSON.stringify(rec), rec.date || 0);
    return fresh;
  }

  removeVideo(id) {
    this.sql.exec('DELETE FROM videos WHERE id = ?', id);
    this.sql.exec('DELETE FROM thumbs WHERE id = ?', id);
  }

  getVideo(id) {
    const r = this.sql.exec('SELECT rec FROM videos WHERE id = ?', id).toArray()[0];
    return r ? JSON.parse(r.rec) : null;
  }

  listVideos() {
    return this.sql.exec('SELECT rec FROM videos ORDER BY id DESC').toArray().map(r => {
      const v = JSON.parse(r.rec);
      return {
        id: v.id, duration: v.duration, width: v.width, height: v.height, size: v.size, date: v.date,
        caption: v.caption.replace(/\s*#dy\d+\s*/g, ' ').trim().slice(0, 300),
      };
    });
  }

  getThumb(id) {
    const r = this.sql.exec('SELECT mime, data FROM thumbs WHERE id = ?', id).toArray()[0];
    return r ? { mime: r.mime, data: r.data } : null;
  }

  putThumb(id, mime, data) {
    this.sql.exec('INSERT OR REPLACE INTO thumbs (id, mime, data) VALUES (?, ?, ?)', id, mime, data);
  }

  // ── 抖音作品 ──
  // 新的进待审核；已有的跳过。只有失败过的会用新数据（新的下载地址）重新待审核
  addItems(items, src) {
    const now = Date.now();
    const fresh = [];
    for (const item of items) {
      const old = this.sql.exec('SELECT status FROM items WHERE aweme = ?', item.aweme).toArray()[0];
      if (old && old.status !== 'failed') continue;
      this.sql.exec(`INSERT INTO items (aweme, status, src, data, created, updated) VALUES (?, 'review', ?, ?, ?, ?)
        ON CONFLICT(aweme) DO UPDATE SET status = 'review', src = excluded.src, data = excluded.data, updated = excluded.updated, attempts = 0, error = ''`,
      item.aweme, src, JSON.stringify(item), now, now);
      fresh.push(item.aweme);
    }
    return fresh;
  }

  // 失败的不算「已知」：云电脑会再送一次带新下载地址的
  knownAwemes(ids) {
    const known = [];
    for (const id of ids) {
      const r = this.sql.exec('SELECT status FROM items WHERE aweme = ?', id).toArray()[0];
      if (r && r.status !== 'failed') known.push(id);
    }
    return known;
  }

  row(r) {
    return { ...JSON.parse(r.data), status: r.status, src: r.src, attempts: r.attempts, msg: r.msg, error: r.error, updated: r.updated };
  }

  getItem(aweme) {
    const r = this.sql.exec('SELECT * FROM items WHERE aweme = ?', aweme).toArray()[0];
    return r ? this.row(r) : null;
  }

  listItems(status, limit, src) {
    const where = [], args = [];
    if (status) { where.push('status = ?'); args.push(status); }
    if (src) { where.push('src = ?'); args.push(src); }
    const q = `SELECT * FROM items ${where.length ? 'WHERE ' + where.join(' AND ') : ''} ORDER BY ${status ? 'created' : 'updated DESC'} LIMIT ?`;
    return this.sql.exec(q, ...args, limit).toArray().map(r => this.row(r));
  }

  counts() {
    const c = { videos: this.sql.exec('SELECT COUNT(*) AS n FROM videos').toArray()[0].n };
    for (const r of this.sql.exec('SELECT status, COUNT(*) AS n FROM items GROUP BY status').toArray()) c[r.status] = r.n;
    c.cloudReview = this.sql.exec("SELECT COUNT(*) AS n FROM items WHERE status = 'review' AND src = 'cloud'").toArray()[0].n;
    return c;
  }

  // 审核：只动还在待审核的；返回动了几条
  review(ids, to) {
    let n = 0;
    for (const id of ids) {
      n += this.sql.exec("UPDATE items SET status = ?, updated = ? WHERE aweme = ? AND status = 'review' RETURNING aweme", to, Date.now(), id).toArray().length;
    }
    return n;
  }

  reviewAllCloud(to) {
    return this.sql.exec("UPDATE items SET status = ?, updated = ? WHERE status = 'review' AND src = 'cloud' RETURNING aweme", to, Date.now()).toArray().length;
  }

  // 先发早的：按作品发布时间从旧到新，频道里的顺序和抖音上一样
  claimQueued(limit, now) {
    const rows = this.sql.exec("SELECT * FROM items WHERE status = 'queued' ORDER BY created, aweme LIMIT ?", limit).toArray();
    const items = rows.map(r => JSON.parse(r.data)).sort((a, b) => (a.create_time || 0) - (b.create_time || 0));
    for (const r of rows) this.sql.exec("UPDATE items SET status = 'sending', updated = ? WHERE aweme = ?", now, r.aweme);
    return items;
  }

  release(ids) {
    for (const id of ids) this.sql.exec("UPDATE items SET status = 'queued' WHERE aweme = ? AND status = 'sending'", id);
  }

  releaseAllSending() {
    this.sql.exec("UPDATE items SET status = 'queued' WHERE status = 'sending'");
  }

  // 交出去太久没回音的：再排队，次数用完的记成失败；返回失败的那些
  expireSending(before, maxAttempts) {
    const rows = this.sql.exec("SELECT aweme, attempts FROM items WHERE status = 'sending' AND updated < ?", before).toArray();
    const failed = [];
    for (const r of rows) {
      const attempts = r.attempts + 1;
      const status = attempts >= maxAttempts ? 'failed' : 'queued';
      this.sql.exec("UPDATE items SET status = ?, attempts = ?, error = ?, updated = ? WHERE aweme = ?", status, attempts, '流式服务没有回音', Date.now(), r.aweme);
      if (status === 'failed') failed.push(this.getItem(r.aweme));
    }
    return failed;
  }

  // 流式服务报结果；返回作品现在的状态
  itemDone(aweme, ok, msg, error, maxAttempts) {
    const r = this.sql.exec('SELECT status, attempts FROM items WHERE aweme = ?', aweme).toArray()[0];
    if (!r) return 'unknown';
    if (r.status === 'posted') return 'posted';
    if (ok) {
      this.sql.exec("UPDATE items SET status = 'posted', msg = ?, error = '', updated = ? WHERE aweme = ?", msg, Date.now(), aweme);
      return 'posted';
    }
    const attempts = r.attempts + 1;
    const status = attempts >= maxAttempts ? 'failed' : 'queued';
    this.sql.exec('UPDATE items SET status = ?, attempts = ?, error = ?, updated = ? WHERE aweme = ?', status, attempts, error, Date.now(), aweme);
    return status;
  }

  markPosted(aweme, msg) {
    this.sql.exec("UPDATE items SET status = 'posted', msg = CASE WHEN msg = 0 THEN ? ELSE msg END, error = '', updated = ? WHERE aweme = ?", msg, Date.now(), aweme);
  }

  retryFailed() {
    return this.sql.exec("UPDATE items SET status = 'queued', attempts = 0, error = '', updated = ? WHERE status = 'failed' RETURNING aweme", Date.now()).toArray().length;
  }
}

// ── 小工具 ───────────────────────────────────────────────────────

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

// 管理和内部接口的响应不带 CORS 头：别的网站的脚本调不动它
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

export { parseRange, normalizeItem, douyinLinks, toRecord };
