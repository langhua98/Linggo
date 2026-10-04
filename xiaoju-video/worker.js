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
//   POST /streamer-up、/streamer-done、/streamer-say   流式服务主动推（X-Key）。HF 机房按域名挡掉了 *.workers.dev，
//                                              实际上用不上：改由这里长轮询流式服务的发件箱（GET /outbox，见 pollStreamer）
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
const THUMB_LIMIT = 512 * 1024;
// 轮询流式服务的发件箱：每次最多等它 20 秒（长轮询）；一次定时器最多连着问 12 分钟（Durable Object 的定时器最多跑 15 分钟）
const POLL_WAIT_S = 20;
const POLL_WINDOW_MS = 12 * 60 * 1000;
// 交给流式服务的活（登录、抓作品）这么久以内，定时任务还会去问它
const JOB_RECENT_MS = 2 * 3600 * 1000;
// 发起登录后这么久以内，频道主发来认不出的话都先问问登录页要不要（验证码、选验证方式……）
const LOGIN_INPUT_MS = 15 * 60 * 1000;

const MSG = {
  unavailable: 'Telegram 暂时取不到这个视频，请稍后再试',
  waking: '大文件服务正在唤醒，大约 1 分钟后再试',
  noStreamer: '这个视频超过 20 MB，暂时不能在网页播放',
  gone: '频道里找不到这个视频了',
};

// 都只活在单个 isolate 里，丢了无妨
const filePaths = new Map(); // file_id -> { path, exp }
let listCache = null;        // { body, exp }
const filling = new Set();   // 正在往边缘缓存里放的视频（消息号）
// 视频放一次就整个存进 Cloudflare 边缘缓存：再看、拖进度条都不用再绕 Telegram（每次要 1～2 秒才出第一个字节）
const EDGE_CACHE_MAX = 60 * 1024 * 1024;
const EDGE_CACHE_TTL_S = 30 * 86400;

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
      if (path === '/ks-agent/poll') {
        if (method !== 'POST') return text('Method Not Allowed', 405);
        return await ksAgentPoll(request, env);
      }
      if (path.startsWith('/dy-')) {
        if (method !== 'POST') return text('Method Not Allowed', 405);
        return await cloudApi(request, env, ctx, path);
      }
      if (path === '/streamer-up' || path === '/streamer-done' || path === '/streamer-say') {
        if (method !== 'POST') return text('Method Not Allowed', 405);
        return await streamerApi(request, env, ctx, path);
      }
      if (path.startsWith('/admin/api/')) return await adminApi(request, env, ctx, url);
      if (path === '/api/heartbreak') {
        if (method !== 'POST') return text('Method Not Allowed', 405);
        return await heartbreak(request, env);
      }
      if (method !== 'GET' && method !== 'HEAD') return text('Method Not Allowed', 405);
      if (path === '/' || path === '/video') return html(PAGE, method);
      const rv = path.match(/^\/review\/([a-z0-9]{14})$/);
      if (rv) return await reviewPage(env, rv[1], method);
      if (path === '/admin') return html(ADMIN_PAGE, method, { 'X-Robots-Tag': 'noindex' });
      if (path === '/api/videos') return await videoList(env);
      const f = path.match(/^\/vf\/(\d{1,10})(?:\.mp4)?$/);
      if (f) return await videoFile(request, env, Number(f[1]), ctx);
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
  // 在 Durable Object 自己里面（定时轮询流式服务）直接用它，不再绕一圈 RPC
  if (env.__self) return env.__self;
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
  // 视频池只记播放要用的（文件、大小、时长、尺寸、封面）：频道帖的说明、标签一概不读、不存（频道主的要求）。
  // 作品转完记「已转」只靠流式服务的回报（发件箱的 done）
  const rec = toRecord(post);
  const L = lib(env);
  if (rec) {
    await L.upsertVideo(rec);
  } else if (update.edited_channel_post) {
    await L.removeVideo(post.message_id); // 编辑后已不含视频
  }
  listCache = null;
  return text('ok');
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
    date: Number(post.date) || 0,
  };
}

// ── 小橘视频机器人：频道主私聊 ─────────────────────────────────────

const HELP = `我是小橘视频的管理助手 🍊

• 登录抖音：云电脑打开抖音登录页，把二维码发给你，用抖音 App 扫一下就行。抖音要再验证时，我把页面截图和能选的验证方式发给你：
  点「刷脸验证」我就把刷脸用的二维码发过来；选短信就把验证码数字发给我；「截图」看页面现在的样子；「取消登录」不登了
• 同步作品：云电脑（MediaCrawler）抓你登录账号自己主页的全部作品，新的交审核机器人 @xiaojuverify_bot
• 搜索 关键词 数量：按关键词搜抖音，比如「搜索 坏脾气小橘 100」（多个关键词用逗号隔开；数量是每个关键词搜几条，不写是 50，最多 500），搜到的成审核单。
  搜出来的也有别人的作品：审核消息里有作者和主页链接，是你小号的才通过；通过过的号会记住，下次标出来、可以一键通过
• 登录快手 / 重新登录快手：快手扫码登录（用快手 App 扫），之后快手的小号、链接、搜索就都能用
• 快手搜索 关键词 数量：按关键词搜快手，和抖音的「搜索」一样
• 快手云电脑：快手的活在你自己的 GitHub Codespace 里跑（快手拦了流式服务的机房），发这个看怎么开
• 发小号的主页链接（抖音、快手里点「分享主页」复制的链接，或者 www.douyin.com/user/…、www.kuaishou.com/profile/… 地址）：记成你的小号，
  云电脑马上抓它的全部作品，新的不用审核，直接转进视频频道
• 小号：看加了哪些小号；「同步小号」现在把所有小号抓一遍；「删除小号 2」删第 2 个
• 自动同步：每天定时把所有小号和你登录的账号抓一遍（小号的直接转，登录账号的交审核单）。
  「自动同步 8」改成每天 8 点（北京时间），「自动同步 关」关掉
• 直接发抖音、快手的作品分享链接（整段分享文字也行）：云电脑抓这几条，交审核机器人过审，通过后转进视频频道
  （云电脑一次干一件，忙的时候发来的活排队，轮到了自动开始）
• 进度：看排队、在转、已转、失败各多少，抖音登录的是哪个账号
• 网页口令：给你一个带口令的网页链接，用它打开才有 💔 心碎按钮；点了删掉频道里的原帖（找不回来）
• 心碎：看最近心碎删掉的视频
• 重试失败：把失败的作品重新排队
• 云电脑：（备用）在你自己的 GitHub Codespaces 里跑 MediaCrawler 要用的令牌和命令
• 帮助：显示这段说明`;

const OWNER_KEYBOARD = {
  keyboard: [[{ text: '登录抖音' }, { text: '同步作品' }], [{ text: '登录快手' }, { text: '快手搜索' }],
    [{ text: '小号' }, { text: '搜索' }], [{ text: '进度' }, { text: '重试失败' }, { text: '帮助' }]],
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
  if (update.callback_query) {
    await tg(env.TG_BOT_TOKEN, 'answerCallbackQuery', { callback_query_id: update.callback_query.id, text: '这个按钮已经不用了' });
    return;
  }
  const msg = update.message;
  if (!msg) return;
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
  if (t === '登录抖音' || t === '/login') {
    // 已经登录了就不再登录（误点不会开一轮扫码、占着云电脑）。登录失效了（12 月 cookie 过期）发「重新登录」
    const s = await dySession(env);
    if (s) return await say(env, chat, `已经登录了「${s.nickname || s.sec_uid}」，不用再登录。`, { reply_markup: OWNER_KEYBOARD });
    return await douyinLogin(env, chat);
  }
  if (t === '重新登录') return await douyinLogin(env, chat);
  if (t === '登录快手') {
    const s = await getSession(env, 'ks');
    if (s) return await say(env, chat, `快手已经登录了「${s.nickname || s.sec_uid}」，不用再登录。`, { reply_markup: OWNER_KEYBOARD });
    return await douyinLogin(env, chat, 'ks');
  }
  if (t === '重新登录快手') return await douyinLogin(env, chat, 'ks');
  const search = /^(快手搜索|搜索|\/search)(?:\s+([\s\S]*))?$/.exec(t);
  if (search) {
    const plat = search[1] === '快手搜索' ? 'ks' : 'dy';
    const cmd = plat === 'ks' ? '快手搜索' : '搜索';
    // 结尾的数字是每个关键词要几条：「搜索 坏脾气小橘 100」「搜索 小橘，猫咪 30条」
    let arg = String(search[2] || '').trim();
    let count;
    const n = /(?:^|\s)(\d{1,4})\s*条?$/.exec(arg);
    if (n) {
      count = Math.min(Math.max(Number(n[1]), 1), SEARCH_MAX);
      arg = arg.slice(0, n.index).trim();
    }
    const words = arg.split(/[,，、;；\n]+/).map(w => w.trim()).filter(Boolean).slice(0, 5);
    if (!words.length) return await say(env, chat, `发「${cmd} 关键词 数量」，比如「${cmd} 坏脾气小橘 100」；多个关键词用逗号隔开，不写数量每个搜 50 条，最多 ${SEARCH_MAX} 条。`);
    const session = await getSession(env, plat);
    if (!session) return await say(env, chat, `还没登录${PLATFORMS[plat].name}：先发「${PLATFORMS[plat].login}」扫码。`, { reply_markup: OWNER_KEYBOARD });
    return await startCrawl(env, chat, { mode: 'search', platform: plat, targets: words, session, ...(count ? { count } : {}) });
  }
  if (t === '同步作品' || t === '/sync') {
    const session = await dySession(env);
    if (!session) return await say(env, chat, '还没登录抖音：先发「登录抖音」扫码。', { reply_markup: OWNER_KEYBOARD });
    return await startCrawl(env, chat, { mode: 'creator', session });
  }
  if (t === '小号' || t === '/alts') return await say(env, chat, await altsText(env), { reply_markup: OWNER_KEYBOARD });
  if (t === '同步小号') {
    const alts = await altAccounts(env);
    if (!alts.length) return await say(env, chat, '还没加小号：把小号的主页分享链接发给我。');
    let started = 0;
    for (const plat of ['dy', 'ks']) {
      const mine = alts.filter(a => (a.platform || 'dy') === plat).map(a => a.sec);
      if (!mine.length) continue;
      if (!(await getSession(env, plat))) {
        await say(env, chat, `还没登录${PLATFORMS[plat].name}：先发「${PLATFORMS[plat].login}」扫码。`, { reply_markup: OWNER_KEYBOARD });
        continue;
      }
      await startCrawl(env, chat, { mode: 'accounts', platform: plat, targets: mine });
      started++;
    }
    return;
  }
  const del = /^删除小号\s*(\d+)$/.exec(t);
  if (del) {
    const alts = await altAccounts(env);
    const gone = alts.splice(Number(del[1]) - 1, 1)[0];
    if (!gone) return await say(env, chat, '没有这个编号，发「小号」看列表。');
    await lib(env).setConfig('altAccounts', JSON.stringify(alts));
    return await say(env, chat, `删掉了小号「${gone.name || gone.sec}」，以后不再抓它。已经转进频道的不动。`);
  }
  const auto = /^自动同步(?:\s*(关|开|\d{1,2})点?)?$/.exec(t);
  if (auto) return await autoSyncSetting(env, chat, auto[1]);
  if (t === '网页口令' || t === '/key') return await pageLink(env, chat, origin);
  if (t === '快手云电脑') return await ksAgentInfo(env, chat, origin);
  if (t === '心碎' || t === '心碎记录') return await say(env, chat, await trashText(env), { reply_markup: OWNER_KEYBOARD });
  if (t === '重试失败' || t === '/retry') {
    const n = await lib(env).retryFailed();
    await say(env, chat, n ? `已把 ${n} 条失败的作品重新排队` : '没有失败的作品');
    if (n) await dispatch(env);
    return;
  }
  // 快手登录进行中（在快手云电脑上）：别的话都交给它的登录页
  if (t && t.length <= 40 && /^登录快手/.test(await lib(env).getConfig('ksAgentBusy') || '') && (await ksAgentOnline(env))) {
    await ksPush(env, 'ksInputs', t);
    if (t !== '取消登录') await say(env, chat, '已经交给快手登录页，等它的回音…');
    return;
  }
  // 抖音登录进行中：别的话（短信验证码、选哪种验证、截图、取消登录）都交给登录页
  if (t && t.length <= 40 && streamerOn(env) && Date.now() - (Number(await lib(env).getConfig('jobAt')) || 0) < LOGIN_INPUT_MS) {
    const r = await streamerCall(env, '/douyin/login/input', { text: t }).catch(() => null);
    if (r && r.status === 200) {
      if (t !== '取消登录') await say(env, chat, '已经交给抖音登录页，等它的回音…');
      return;
    }
  }
  await say(env, chat, '没看懂。发抖音分享链接，或者点下面的按钮。', { reply_markup: OWNER_KEYBOARD });
}

// ── 心碎：频道主在网页上点 💔 → 删掉频道里的原帖、从视频池拿掉 ──
// 网页是公开的，删原帖又找不回来：只有拿着「网页口令」的才能删（机器人里发「网页口令」拿一个带口令的链接）

const HEARTBREAK_PER_HOUR = 60; // 口令万一漏了：一小时最多删这么多

async function pageLink(env, chat, origin) {
  const key = randomToken();
  await lib(env).setConfig('pageKey', key);
  await say(env, chat, `你的网页链接（带口令，用它打开的手机/浏览器才有 💔 心碎按钮；点了会删掉频道里的原帖，找不回来）：
${origin}/video#key=${key}

别发给别人。每发一次「网页口令」就换一个新的，旧链接打开的立刻没有删除权限。`);
}

function fmtDuration(s) {
  s = Number(s) || 0;
  return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, '0')}`;
}

async function heartbreak(request, env) {
  const body = await request.json().catch(() => ({}));
  const id = Number(body && body.id);
  if (!Number.isInteger(id) || id <= 0) return json({ error: 'bad id' }, 400);
  const L = lib(env);
  const want = await L.getConfig('pageKey');
  if (!want || !sameString(String(body.key || ''), want)) return json({ error: '口令不对：在机器人里发「网页口令」拿新链接' }, 403);
  if (await L.trashedSince(Date.now() - 3600 * 1000) >= HEARTBREAK_PER_HOUR) return json({ error: '一小时最多删 60 条，过一会儿再删' }, 429);
  const rec = await L.getVideo(id);
  if (!rec || !(await L.trashVideo(id))) return json({ ok: true, gone: true }); // 已经删过了
  listCache = null;
  const deleted = await deleteChannelPost(env, id);
  if (!deleted) await L.setConfig('pendingDeletes', JSON.stringify([...new Set([...(await pendingDeletes(env)), id])].slice(-500)));
  const owner = await ownerId(env);
  if (owner) {
    await say(env, owner, deleted
      ? `💔 心碎：已删掉频道原帖 #${id}（${fmtDuration(rec.duration)}，${rec.width}×${rec.height}），视频池也拿掉了。`
      : `💔 心碎：视频 #${id} 已从视频池拿掉；频道原帖这会儿没删成，定时任务会接着删。`);
  }
  return json({ ok: true, deleted });
}

async function pendingDeletes(env) {
  return JSON.parse((await lib(env).getConfig('pendingDeletes')) || '[]');
}

// 先让机器人删（它是频道管理员）；删不了（比如没有删帖权限）再让流式服务用频道主账号删
async function deleteChannelPost(env, id) {
  const r = await tg(env.TG_BOT_TOKEN, 'deleteMessage', { chat_id: env.VIDEO_CHANNEL_ID, message_id: id }).catch(() => null);
  if (r && r.ok) return true;
  if (r && /message to delete not found/i.test(r.description || '')) return true; // 已经没了
  if (!streamerOn(env)) return false;
  const s = await streamerCall(env, '/channel/delete', { id }).catch(() => null);
  return !!(s && s.status === 200 && s.data && s.data.deleted);
}

// 定时任务：上次没删成的原帖再删一次
async function retryDeletes(env) {
  const list = await pendingDeletes(env);
  if (!list.length) return;
  const left = [];
  for (const id of list) if (!(await deleteChannelPost(env, id))) left.push(id);
  await lib(env).setConfig('pendingDeletes', JSON.stringify(left));
}

async function trashText(env) {
  const list = await lib(env).listTrash(20);
  const pending = new Set(await pendingDeletes(env));
  if (!list.length) return '还没有心碎删掉的视频。';
  return ['最近心碎删掉的视频：', ...list.map(r => `#${r.id}  ${ago(r.at)}${pending.has(r.id) ? '  （原帖还没删成，会接着删）' : ''}`)].join('\n');
}

// 分享文字里的抖音链接：v.douyin.com 短链接、www.douyin.com/video|note/<号>、iesdouyin 分享页
function douyinLinks(t) {
  const found = String(t || '').match(/https?:\/\/(?:v\.douyin\.com|(?:www\.|m\.)?douyin\.com|(?:www\.)?iesdouyin\.com|(?:v\.|www\.|m\.)?kuaishou\.com|[\w.-]*\.chenzhongtech\.com|(?:www\.|m\.)?gifshow\.com)\/[^\s，。！？、"'<>]*/gi) || [];
  return [...new Set(found.map(u => u.replace(/[),.;!?]+$/, '')))].slice(0, 10);
}

// 登录过抖音：链接交给云电脑（MediaCrawler）抓，抓到的逐条交审核机器人。
// 没登录：退回不登录的分享页解析（流式服务在海外机房，多半拿不到作品数据）
async function submitLinks(env, chat, links) {
  if (!streamerOn(env)) return await say(env, chat, '还没接上流式服务，暂时认不了链接');
  const session = await dySession(env);
  const ksSession = await getSession(env, 'ks');
  const { accounts, works } = await sortLinks(env, links, !!(session || ksSession));
  // 要干的活：小号（每个平台一件）、作品链接（每个平台一件）。云电脑一次干一件，其余排队
  const todo = [];
  const notes = [];
  for (const plat of ['dy', 'ks']) {
    const P = PLATFORMS[plat];
    const mine = accounts.filter(a => a.platform === plat).map(a => a.sec);
    if (!mine.length) continue;
    if (!(await getSession(env, plat))) {
      notes.push(`要抓${P.name}小号得先登录${P.name}：发「${P.login}」扫码，再把主页链接发一次。`);
      continue;
    }
    const fresh = await addAlts(env, mine, plat);
    notes.push((plat === 'ks' ? '快手：' : '') + (fresh ? `加了 ${fresh} 个小号` : '这个小号以前加过了') +
      '，现在去抓它的全部作品，新的直接转进视频频道。');
    todo.push({ mode: 'accounts', platform: plat, targets: mine });
  }
  if (works.ks.length) {
    if (ksSession) todo.push({ mode: 'detail', platform: 'ks', targets: works.ks.slice(0, 20) });
    else notes.push(`${works.ks.length} 条快手链接：先发「登录快手」扫码，再发一次。`);
  }
  links = works.dy;
  if (session && links.length) todo.push({ mode: 'detail', platform: 'dy', targets: links });
  if (notes.length) await say(env, chat, notes.join('\n'), { reply_markup: OWNER_KEYBOARD });
  for (const job of todo) await startCrawl(env, chat, job);
  if (session || !links.length) return;
  const items = [];
  const bad = [];
  for (const link of links) {
    const r = await streamerCall(env, '/douyin/resolve', { url: link }).catch(() => null);
    const item = r && r.status === 200 && r.data && normalizeItem(r.data.item);
    if (!item) {
      bad.push(r ? (r.data && r.data.error) || `流式服务回 ${r.status}` : '流式服务没响应（可能在休眠，1 分钟后再发一次）');
      continue;
    }
    items.push(item);
  }
  const res = await importItems(env, items, 'link');
  const parts = [];
  if (res.added) parts.push(`${res.added} 条成了审核单 ${res.batch}，去审核机器人 @xiaojuverify_bot 审`);
  if (res.skipped) parts.push(`${res.skipped} 条以前已经收过`);
  if (bad.length) parts.push(`${bad.length} 条认不出：${bad.join('；')}\n先发「登录抖音」扫码，之后链接改由云电脑（MediaCrawler）抓。`);
  await say(env, chat, parts.join('\n'));
}

const SEARCH_MAX = 500; // 每个关键词最多搜几条（流式服务那边也是这个上限）

// ── 快手云电脑：频道主自己的 GitHub Codespace ──
// 快手拦了流式服务所在的 Hugging Face 机房（www.kuaishou.com 的握手直接不回），GitHub 的机器连得上。
// Codespace 里跑 cloud/ks_agent.py：每隔几秒 POST /ks-agent/poll（X-Token），带上它那边的事件（话、截图、登录状态、
// 抓到的作品……跟流式服务发件箱里的一样，照样 handleEvent），拿走给它的活（ksQueue）和登录时频道主发的话（ksInputs）。
// 抓到的快手作品还是交流式服务转发进频道。

const KS_AGENT_ONLINE_MS = 60 * 1000;

async function ksAgentOnline(env) {
  return Date.now() - (Number(await lib(env).getConfig('ksAgentAt')) || 0) < KS_AGENT_ONLINE_MS;
}

async function ksPush(env, key, value, max = 20) {
  const L = lib(env);
  const list = JSON.parse((await L.getConfig(key)) || '[]');
  list.push(value);
  await L.setConfig(key, JSON.stringify(list.slice(-max)));
  return list.length;
}

async function ksAgentJob(env, chat, job, okText) {
  const n = await ksPush(env, 'ksQueue', { ...job, chat });
  if (!chat) return;
  if (await ksAgentOnline(env)) {
    const busy = await lib(env).getConfig('ksAgentBusy');
    await say(env, chat, busy ? `快手云电脑正在「${busy}」，这件排上队了（队里 ${n} 件），轮到了自动开始。` : okText || '交给快手云电脑了，马上开始。');
  } else {
    await say(env, chat, `快手云电脑（你的 GitHub Codespace）现在没开，这件先排着（队里 ${n} 件）。开起来就自动开始——发「快手云电脑」看怎么开。`);
  }
}

async function ksAgentInfo(env, chat, origin) {
  const token = randomToken();
  await lib(env).setConfig('ksAgentToken', token);
  await say(env, chat, `快手云电脑 = 你自己的 GitHub Codespace（快手拦了流式服务的机房，GitHub 的机器连得上）。

1. 打开 https://codespaces.new/langhua98/Linggo?devcontainer_path=.devcontainer/xiaoju-video/devcontainer.json ，点「Create codespace」。第一次要装几分钟。
2. 装好后在下面的终端里粘贴（新令牌，旧的作废了）：
bash xiaoju-video/cloud/run.sh ks ${origin} ${token}
3. 看到「快手云电脑开着了」就行，终端别关。排着的快手的活会自动开始。

Codespace 没人操作 30 分钟会自己停：GitHub 头像 → Settings → Codespaces → Default idle timeout 改成 240 分钟。停了以后要用再打开，再跑第 2 步那行（令牌不变）。
令牌只发这一次，别给别人。`, { reply_markup: OWNER_KEYBOARD });
}

async function ksAgentPoll(request, env) {
  const L = lib(env);
  const want = await L.getConfig('ksAgentToken');
  if (!want || !sameString(request.headers.get('X-Token') || '', want)) return json({ error: 'forbidden' }, 403);
  const body = await request.json().catch(() => ({}));
  const wasOnline = await ksAgentOnline(env);
  const busy = String(body.busy || '').slice(0, 40);
  await L.setConfig('ksAgentAt', String(Date.now()));
  await L.setConfig('ksAgentBusy', busy);
  for (const ev of (Array.isArray(body.events) ? body.events : []).slice(0, 200)) {
    if (!ev || typeof ev !== 'object') continue;
    if (ev.kind === 'done') continue; // 快手云电脑不转发，转发是流式服务的事
    if (ev.kind === 'session') ev.platform = 'ks'; // 这里来的登录状态只能是快手的
    try {
      await handleEvent(env, ev);
    } catch {
      // 一条出错不卡住后面的
    }
  }
  const owner = await ownerId(env);
  if (!wasOnline && owner && body.hello) await say(env, owner, '✓ 快手云电脑开着了。');
  const out = { jobs: [], inputs: JSON.parse((await L.getConfig('ksInputs')) || '[]') };
  if (out.inputs.length) await L.setConfig('ksInputs', '[]');
  const queue = JSON.parse((await L.getConfig('ksQueue')) || '[]');
  if (!busy && queue.length) {
    const job = queue.shift();
    await L.setConfig('ksQueue', JSON.stringify(queue));
    if (job.type === 'crawl') {
      const session = await getSession(env, 'ks');
      if (!session) {
        if (job.chat) await say(env, job.chat, '快手还没登录：先发「登录快手」。');
      } else {
        out.jobs.push({ ...job, session });
      }
    } else {
      await L.setConfig('ksInputs', '[]');
      out.jobs.push(job);
    }
    // 交出去了就算它在忙（名字和 jobs.py 里的一样），不等它下次报到
    if (out.jobs.length) {
      const label = job.type === 'login' ? '登录快手' : '快手' + ({ accounts: '同步小号', search: '搜索' }[job.mode] || '抓链接');
      await L.setConfig('ksAgentBusy', label);
    }
  }
  return json(out);
}

// 两个平台：抖音作品号是纯数字，快手的是 ks_<快手作品号>；账号号码抖音是 sec_uid，快手是用户 id
const SEC_RE = /^MS4wLjABAAAA[\w-]{10,200}$/;
const KS_UID_RE = /^[0-9A-Za-z_-]{3,40}$/;
const ITEM_ID_RE = /^(?:\d{6,25}|ks_[0-9A-Za-z_-]{6,40})$/;
const PLATFORMS = {
  dy: { name: '抖音', session: 'dySession', login: '登录抖音', id: SEC_RE, profile: id => `https://www.douyin.com/user/${id}` },
  ks: { name: '快手', session: 'ksSession', login: '登录快手', id: KS_UID_RE, profile: id => `https://www.kuaishou.com/profile/${id}` },
};
const platOfItem = item => (String(item.aweme || '').startsWith('ks_') ? 'ks' : 'dy');
const isKsLink = l => /^https?:\/\/([\w.-]*\.)?(kuaishou\.com|chenzhongtech\.com|gifshow\.com)\//i.test(l);

// 分出哪些是个人主页（小号）、哪些是作品，各是哪个平台。www.douyin.com/user/…、www.kuaishou.com/profile/… 一看就知道；
// 短链接要流式服务跳一次才知道。返回 { accounts: [{ sec, platform }], works: { dy: [链接], ks: [链接] } }
async function sortLinks(env, links, expand) {
  const accounts = [];
  const works = { dy: [], ks: [] };
  const short = [];
  for (const l of links) {
    const dy = /douyin\.com\/(?:share\/)?user\/(MS4wLjABAAAA[\w-]{10,200})/.exec(l);
    const ks = /kuaishou\.com\/profile\/([0-9A-Za-z_-]{3,40})/.exec(l);
    if (dy) accounts.push({ sec: dy[1], platform: 'dy' });
    else if (ks) accounts.push({ sec: ks[1], platform: 'ks' });
    else if (/kuaishou\.com\/short-video\/[0-9A-Za-z_-]{6,40}/.test(l)) works.ks.push(l);
    else if (expand && (/v\.douyin\.com/.test(l) || isKsLink(l))) short.push(l);
    else works[isKsLink(l) ? 'ks' : 'dy'].push(l);
  }
  if (short.length) {
    const r = await streamerCall(env, '/douyin/expand', { urls: short }).catch(() => null);
    const res = r && r.status === 200 && Array.isArray(r.data.results) ? r.data.results : [];
    for (const l of short) {
      const x = res.find(y => y && y.url === l) || {};
      if (SEC_RE.test(String(x.sec_uid || ''))) accounts.push({ sec: x.sec_uid, platform: 'dy' });
      else if (KS_UID_RE.test(String(x.ks_user || ''))) accounts.push({ sec: x.ks_user, platform: 'ks' });
      else if (/^https:\/\/www\.kuaishou\.com\/short-video\//.test(String(x.canonical || ''))) works.ks.push(x.canonical);
      else works[isKsLink(l) ? 'ks' : 'dy'].push(l); // 认不出就当作品链接，交给 MediaCrawler 去认
    }
  }
  const seen = new Set();
  return { accounts: accounts.filter(a => !seen.has(a.platform + a.sec) && seen.add(a.platform + a.sec)), works };
}

// 小号：[{ sec, name, at }]。频道主亲手加的，抓到的作品不用审核
async function altAccounts(env) {
  return JSON.parse((await lib(env).getConfig('altAccounts')) || '[]');
}

async function addAlts(env, secs, platform = 'dy') {
  const alts = await altAccounts(env);
  let fresh = 0;
  for (const sec of secs) {
    if (alts.some(a => a.sec === sec)) continue;
    alts.push({ sec, name: '', at: Date.now(), ...(platform === 'dy' ? {} : { platform }) });
    fresh++;
  }
  await lib(env).setConfig('altAccounts', JSON.stringify(alts.slice(-100)));
  return fresh;
}

// 每个小号一行：昵称、收了几条、转了几条、排队几条、失败几条、上次抓是什么时候
async function altLines(env, alts) {
  const stats = await lib(env).authorStats(alts.map(a => a.sec));
  return alts.map((x, i) => {
    const c = stats[x.sec] || {};
    const total = Object.values(c).reduce((m, n) => m + n, 0);
    return `${i + 1}. ${x.platform === 'ks' ? '[快手] ' : ''}${x.name || '（还没抓过，不知道昵称）'}\n` +
      (total ? `   收了 ${total} 条：${countLine(c)}${c.review ? ` · 待审 ${c.review}` : ''}${c.rejected ? ` · 不转 ${c.rejected}` : ''}` : '   还没收到作品') +
      (x.last ? `；上次抓 ${ago(x.last)}` : '') + `\n   ${PLATFORMS[x.platform || 'dy'].profile(x.sec)}`;
  });
}

async function altsText(env) {
  const alts = await altAccounts(env);
  const a = await autoSync(env);
  const lines = alts.length
    ? ['你的小号（抓到的作品直接转进频道）：', ...await altLines(env, alts)]
    : ['还没加小号。把小号的主页分享链接发给我就加上。'];
  lines.push('', a.on ? `自动同步：每天 ${a.hour} 点（北京时间）${a.last ? `，上次 ${ago(a.last)}` : ''}` : '自动同步：关着',
    '「同步小号」现在抓一遍；「删除小号 2」删第 2 个；「自动同步 8」改时间，「自动同步 关」关掉');
  return lines.join('\n');
}

// 自动同步设置：{ on, hour（北京时间）, last（上次发起的时间）, day（上次发起是哪天）}
async function autoSync(env) {
  return { on: true, hour: 4, last: 0, day: '', ...JSON.parse((await lib(env).getConfig('autoSync')) || '{}') };
}

async function autoSyncSetting(env, chat, arg) {
  const a = await autoSync(env);
  if (arg === '关') a.on = false;
  else if (arg === '开') a.on = true;
  else if (arg !== undefined) {
    const h = Number(arg);
    if (h > 23) return await say(env, chat, '点数是 0 到 23，比如「自动同步 8」。');
    a.on = true;
    a.hour = h;
  }
  await lib(env).setConfig('autoSync', JSON.stringify(a));
  await say(env, chat, a.on ? `自动同步开着：每天 ${a.hour} 点（北京时间）把小号和登录账号抓一遍。` : '自动同步关了。', { reply_markup: OWNER_KEYBOARD });
}

// 补全视频池：机器人只能收到加进频道以后的新帖，以前的视频让流式服务用频道主账号翻历史找出来。
// 它只给视频帖的播放字段（消息号、大小、时长、尺寸、日期），不给说明、标签。每次最多翻 pages×500 条，
// 定时任务接着翻，翻到头就停，告诉频道主一声
async function scanChannel(env, pages) {
  const L = lib(env);
  const st = { after: 0, added: 0, seen: 0, done: false, ...JSON.parse((await L.getConfig('channelScan')) || '{}') };
  if (st.done || !streamerOn(env)) return st;
  for (let i = 0; i < pages && !st.done; i++) {
    const r = await streamerCall(env, '/channel/videos', { after: st.after, limit: 500 }).catch(() => null);
    if (!r || r.status !== 200 || !Array.isArray(r.data.videos)) break; // 在睡、在重启：下次再来
    const list = r.data.videos.map(v => ({
      id: Number(v.id), file_id: '', size: Number(v.size) || 0, duration: Number(v.duration) || 0,
      width: Number(v.width) || 0, height: Number(v.height) || 0,
      mime: /^video\//.test(String(v.mime || '')) ? String(v.mime) : 'video/mp4', thumb: '', date: Number(v.date) || 0,
    })).filter(v => Number.isInteger(v.id) && v.id > 0);
    st.added += await L.addScannedVideos(list);
    st.seen += list.length;
    const last = Number(r.data.last) || st.after;
    st.done = !!r.data.done || last <= st.after;
    st.after = Math.max(st.after, last);
    listCache = null;
  }
  await L.setConfig('channelScan', JSON.stringify(st));
  if (st.done) {
    const owner = await ownerId(env);
    if (owner) await say(env, owner, `视频池补全了：翻完频道历史，补进 ${st.added} 条以前的视频，现在一共 ${(await L.counts()).videos} 条。`);
  }
  return st;
}

// 定时任务里调：到了点、今天还没发起过，就交给云电脑抓。云电脑在睡或者在忙，这个小时里每 5 分钟再试
async function maybeAutoSync(env, now = Date.now()) {
  const a = await autoSync(env);
  const bj = new Date(now + 8 * 3600 * 1000);
  const day = bj.toISOString().slice(0, 10);
  if (!a.on || bj.getUTCHours() !== a.hour || a.day === day || !streamerOn(env)) return;
  const owner = await ownerId(env);
  if (!owner) return;
  const alts = await altAccounts(env);
  const jobs = [];
  const dy = await dySession(env);
  if (dy) {
    const targets = [...new Set([...alts.filter(x => (x.platform || 'dy') === 'dy').map(x => x.sec), dy.sec_uid])].filter(x => SEC_RE.test(x));
    jobs.push({ chat: owner, mode: 'accounts', platform: 'dy', targets });
  }
  const ksAlts = alts.filter(x => x.platform === 'ks').map(x => x.sec);
  const ksJob = ksAlts.length && (await getSession(env, 'ks')) ? { type: 'crawl', chat: owner, mode: 'accounts', platform: 'ks', targets: ksAlts } : null;
  if (!jobs.length && !ksJob) return;
  for (const job of jobs) await enqueue(env, 0, job, '');
  if (ksJob) await ksAgentJob(env, 0, ksJob, '');
  a.day = day;
  a.last = now;
  await lib(env).setConfig('autoSync', JSON.stringify(a));
  await startQueued(env);
}

// 抖音登录状态（流式服务登录成功后存进来的 cookie、sec_uid、昵称）；没有返回 null
async function dySession(env) {
  return await getSession(env, 'dy');
}

async function getSession(env, platform) {
  const raw = await lib(env).getConfig(PLATFORMS[platform].session);
  const s = raw ? JSON.parse(raw) : null;
  return s && s.sec_uid ? s : null;
}

async function douyinLogin(env, chat, platform = 'dy') {
  if (platform === 'ks') return await ksAgentJob(env, chat, { type: 'login' }, '正在打开快手登录页，二维码大约半分钟后发过来…');
  const P = PLATFORMS[platform];
  if (!streamerOn(env)) return await say(env, chat, '还没接上流式服务');
  const r = await streamerCall(env, '/douyin/login', { chat_id: chat, ...(platform === 'dy' ? {} : { platform }) }).catch(() => null);
  if (!r) return await say(env, chat, `云电脑没响应（可能在休眠），1 分钟后再发一次「${P.login}」。`);
  if (r.status === 409) return await say(env, chat, `云电脑正在「${r.data.busy}」，等它干完再发。`);
  if (r.status !== 200) return await say(env, chat, `云电脑没接：${(r.data && r.data.error) || r.status}`);
  await jobStarted(env);
  await say(env, chat, `正在打开${P.name}登录页，二维码大约半分钟后发过来…`);
}

// 交给流式服务一件活：记下时间，开始轮询它的发件箱（二维码、结果都从那里来）
async function jobStarted(env) {
  const L = lib(env);
  await L.setConfig('jobAt', String(Date.now()));
  await L.kick();
}

// 交给云电脑抓：它自己会把「开始抓」「抓到几条」发给频道主，这里只处理没交出去的情况
// 云电脑一次只干一件：忙着、在睡，就排进队（config crawlQueue）；它闲下来（发件箱说不忙了）、定时任务时接着交
async function startCrawl(env, chat, body) {
  const job = { chat, mode: body.mode, platform: body.platform || 'dy', targets: body.targets || [], ...(body.count ? { count: body.count } : {}) };
  if (job.platform === 'ks') return await ksAgentJob(env, chat, { type: 'crawl', ...job }, '');
  if ((await crawlQueue(env)).length) return await enqueue(env, chat, job, '前面还有活');
  const r = await sendCrawl(env, job, body.session);
  if (r.ok) return;
  if (r.busy || r.down) return await enqueue(env, chat, job, r.busy ? `云电脑正在「${r.busy}」` : '云电脑没响应（可能在休眠）');
  await say(env, chat, `云电脑没接：${r.error}`);
}

// 交一件活；返回 { ok } / { busy: 在干什么 } / { down } / { error }
async function sendCrawl(env, job, session) {
  const P = PLATFORMS[job.platform] || PLATFORMS.dy;
  const s = session || (await getSession(env, job.platform));
  if (!s) return { error: `还没登录${P.name}（发「${P.login}」）` };
  const body = { chat_id: job.chat, mode: job.mode, targets: job.targets, session: s };
  if (job.platform === 'ks') body.platform = 'ks';
  if (job.count) body.count = job.count;
  const r = await streamerCall(env, '/douyin/crawl', body).catch(() => null);
  if (!r) return { down: true };
  if (r.status === 409) return { busy: (r.data && r.data.busy) || '别的活' };
  if (r.status !== 200) return { error: (r.data && r.data.error) || String(r.status) };
  await jobStarted(env);
  return { ok: true };
}

async function crawlQueue(env) {
  return JSON.parse((await lib(env).getConfig('crawlQueue')) || '[]');
}

async function enqueue(env, chat, job, why) {
  const queue = await crawlQueue(env);
  const key = j => JSON.stringify([j.platform, j.mode, j.targets, j.count || 0]);
  if (!queue.some(j => key(j) === key(job))) queue.push(job);
  await lib(env).setConfig('crawlQueue', JSON.stringify(queue.slice(-20)));
  await lib(env).kick();
  if (chat && why) await say(env, chat, `${why}，这件排上队了（队里 ${queue.length} 件），轮到了自动开始。`);
}

// 云电脑闲着：交队里的下一件。忙、在睡就留着下次再试；交不了的（比如没登录）扔掉、告诉频道主
async function startQueued(env) {
  const queue = await crawlQueue(env);
  if (!queue.length || !streamerOn(env)) return;
  const job = queue[0];
  const r = await sendCrawl(env, job);
  if (r.busy || r.down) return;
  queue.shift();
  await lib(env).setConfig('crawlQueue', JSON.stringify(queue));
  if (r.error && job.chat) await say(env, job.chat, `排队的活没交出去：${r.error}`);
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
  const s = await dySession(env);
  lines.push(s ? `抖音账号：${s.nickname || s.sec_uid}（${ago(s.at)}登录）` : '抖音：还没登录（发「登录抖音」）');
  const ks = await getSession(env, 'ks');
  lines.push(ks ? `快手账号：${ks.nickname || ks.sec_uid}（${ago(ks.at)}登录）` : '快手：还没登录（发「登录快手」）');
  const ksAt = Number(await L.getConfig('ksAgentAt')) || 0;
  const ksQ = JSON.parse((await L.getConfig('ksQueue')) || '[]');
  lines.push(`快手云电脑（Codespace）：${(await ksAgentOnline(env)) ? `开着${(await L.getConfig('ksAgentBusy')) ? `，在「${await L.getConfig('ksAgentBusy')}」` : ''}` : ksAt ? `没开（上次 ${ago(ksAt)}）` : '还没开过（发「快手云电脑」看怎么开）'}` +
    (ksQ.length ? `；等它的活 ${ksQ.length} 件` : ''));
  const queue = await crawlQueue(env);
  if (queue.length) lines.push(`排队的活：${queue.length} 件（云电脑闲下来自动开始）`);
  if (p) lines.push(`云电脑：${p.stage || ''} ${p.done || 0}/${p.total || 0}${p.note ? ' · ' + p.note : ''}（${ago(p.at)}）`);
  const alts = await altAccounts(env);
  if (alts.length) {
    const stats = await L.authorStats(alts.map(a => a.sec));
    const sum = {};
    for (const c of Object.values(stats)) for (const [k, n] of Object.entries(c)) sum[k] = (sum[k] || 0) + n;
    lines.push(`小号 ${alts.length} 个：${countLine(sum)}（发「小号」看每个号的）`);
  }
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

const SRC = { cloud: '云电脑同步', link: '私聊链接', search: '关键词搜索', alt: '小号同步' };
const SRC_TAG = { cloud: '#主页同步', link: '#私聊链接', search: '#关键词搜索', alt: '#小号同步' };
const PUBLIC_URL = 'https://xiaoju-video.langhua98.workers.dev';

// mine：频道主通过过的账号（sec_uid 列表），作品要标出是不是这些号发的
function reviewText(item, mine = []) {
  const known = item.author_sec_uid && mine.includes(item.author_sec_uid);
  return [
    `抖音${KIND[item.type] || '作品'}（${SRC[item.src] || '私聊链接'}）`,
    item.desc ? item.desc.slice(0, 300) : '（没有文字）',
    item.author || item.author_sec_uid ? `作者：${item.author || '（没有昵称）'}${known ? '  ✓ 你通过过这个号的作品' : ''}` : '',
    item.author_sec_uid ? `作者主页：${PLATFORMS[platOfItem(item)].profile(item.author_sec_uid)}` : '',
    item.url,
  ].filter(Boolean).join('\n');
}

async function myAccounts(env) {
  return JSON.parse((await lib(env).getConfig('myAccounts')) || '[]');
}

// 频道主通过了一批：这批作品的作者都记成他的号，之后再搜到会标出来
async function rememberAccounts(env, items) {
  const mine = await myAccounts(env);
  for (const i of items) if (i.author_sec_uid && !mine.includes(i.author_sec_uid)) mine.push(i.author_sec_uid);
  await lib(env).setConfig('myAccounts', JSON.stringify(mine.slice(-2000)));
}

// 审核单编号：14 位小写字母和数字
function newBatchId() {
  const abc = 'abcdefghijklmnopqrstuvwxyz0123456789';
  const b = new Uint8Array(14);
  crypto.getRandomValues(b);
  return [...b].map(x => abc[x % abc.length]).join('');
}

// 标签：来源 + 搜的关键词（「橘猫」「猫」→ #橘猫 #猫）
function batchTags(src, what) {
  const words = [...String(what || '').matchAll(/「([^」]+)」/g)].map(m => '#' + m[1].replace(/\s+/g, ''));
  return [SRC_TAG[src] || '#私聊链接', ...(/^快手/.test(String(what || '')) ? ['#快手'] : []), ...words].slice(0, 8);
}

function sheetHeader(b) {
  return `🛂 审核单 ${b.id}（${b.tags.join(' ')} #批次数量${b.total} 条）`;
}

// 审核单：一批一张，只有两个按钮。上面列作者统计和前几条，「查看全部」打开整批的列表
async function sendSheet(env, id, edit = false) {
  const L = lib(env);
  const owner = await ownerId(env);
  const b = await L.getBatch(id);
  if (!owner || !b) return;
  const items = await L.batchItems(id);
  const mine = await myAccounts(env);
  const by = new Map();
  for (const i of items) {
    const k = i.author || '（没有作者信息）';
    const e = by.get(k) || { n: 0, known: i.author_sec_uid && mine.includes(i.author_sec_uid) };
    e.n++;
    by.set(k, e);
  }
  const authors = [...by.entries()].sort((a, b2) => b2[1].n - a[1].n).slice(0, 8)
    .map(([k, e]) => `${k} ×${e.n}${e.known ? ' ✓' : ''}`);
  const lines = [
    sheetHeader(b),
    '',
    `作者：${authors.join('、')}${by.size > 8 ? ` 等 ${by.size} 个` : ''}`,
    ...items.slice(0, 5).map(i => `• ${(i.desc || i.aweme).replace(/\s+/g, ' ').slice(0, 40)}`),
    items.length > 5 ? `……一共 ${items.length} 条` : '',
    '',
    `查看全部：${PUBLIC_URL}/review/${id}`,
  ].filter(x => x !== undefined && x !== false);
  const text = lines.join('\n').replace(/\n{3,}/g, '\n\n');
  const buttons = [[
    { text: '✅ 审核通过', callback_data: `batch-ok:${id}` },
    { text: '❌ 审核失败', callback_data: `batch-no:${id}` },
  ]];
  // 边抓边交：同一次抓取后面送来的并进这张单子，原地改条数，不再发新的
  if (edit && b.msg) {
    await tg(env.VERIFY_BOT_TOKEN, 'editMessageText', {
      chat_id: owner, message_id: b.msg, text, disable_web_page_preview: true, reply_markup: { inline_keyboard: buttons },
    });
    return;
  }
  const r = await verifySay(env, owner, text, buttons);
  if (r && r.result && r.result.message_id) await L.setBatchMsg(id, r.result.message_id);
}

// 有审核单之前收的、还没审的作品：按来源各凑成一张审核单。返回新开的编号
async function adoptOrphans(env) {
  const L = lib(env);
  const ids = [];
  for (const src of await L.orphanSrcs()) {
    const id = newBatchId();
    await L.addBatch(id, src, batchTags(src, ''));
    await L.adoptOrphans(id, src);
    ids.push(id);
  }
  return ids;
}

async function verifyChat(env, msg) {
  const owner = await ownerId(env);
  if (!owner || msg.from.id !== owner) {
    await verifySay(env, msg.chat.id, '这是小橘视频的审核机器人，只有频道主能用。');
    return;
  }
  await adoptOrphans(env);
  const open = await lib(env).openBatches(5);
  if (!open.length) return await verifySay(env, msg.chat.id, '现在没有待审核的审核单。');
  for (const b of open) await sendSheet(env, b.id);
}

async function reviewButton(env, cb, ctx) {
  const answer = t => tg(env.VERIFY_BOT_TOKEN, 'answerCallbackQuery', { callback_query_id: cb.id, text: t || '' });
  const owner = await ownerId(env);
  if (!owner || cb.from.id !== owner) return await answer('只有频道主能审核');
  const L = lib(env);
  const m = /^batch-(ok|no):([a-z0-9]{14})$/.exec(String(cb.data || ''));
  if (!m) return await answer('这个按钮已经不用了，看最新的审核单');
  const to = m[1] === 'ok' ? 'queued' : 'rejected';
  const items = to === 'queued' ? (await L.batchItems(m[2])).filter(i => i.status === 'review') : [];
  const n = await L.reviewBatch(m[2], to);
  const b = await L.getBatch(m[2]);
  await answer(n ? (to === 'queued' ? `${n} 条已通过，排队转发` : `${n} 条不转了`) : '这张审核单已经审过了');
  if (b) {
    await tg(env.VERIFY_BOT_TOKEN, 'editMessageText', {
      chat_id: cb.message && cb.message.chat.id, message_id: cb.message && cb.message.message_id, disable_web_page_preview: true,
      text: `${sheetHeader(b)}\n\n${to === 'queued' ? `✅ 审核通过：${n} 条排队转发进频道` : `❌ 审核失败：${n} 条不转`}\n查看全部：${PUBLIC_URL}/review/${b.id}`,
    });
  }
  if (n && to === 'queued') {
    await rememberAccounts(env, items);
    await dispatch(env);
  }
  if (n) await refreshCards(env).catch(() => {});
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
  await L.kick(); // 结果在流式服务的发件箱里，去取
  return items.length;
}

async function tick(env) {
  const L = lib(env);
  const failed = await L.expireSending(Date.now() - SENDING_STALE_MS, MAX_ATTEMPTS);
  if (failed.length) await notifyFailed(env, failed);
  await maybeAutoSync(env);
  await startQueued(env).catch(() => {});
  await scanChannel(env, 2).catch(() => {});
  await retryDeletes(env).catch(() => {});
  await refreshCards(env).catch(() => {});
  for (const id of await adoptOrphans(env)) await sendSheet(env, id);
  await dispatch(env);
  // 有交出去还没回音的、或者最近让它干过活：去它的发件箱看看。闲着就不去，免得把休眠的 Space 一直叫醒
  if (!streamerOn(env)) return;
  const c = await L.counts();
  const lastJob = Number(await L.getConfig('jobAt')) || 0;
  if (c.sending || c.queued || Date.now() - lastJob < JOB_RECENT_MS) await L.kick();
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
  if (path === '/streamer-say') {
    const r = await sendToOwner(env, body.chat_id, body.text, body.png);
    return json({ ok: r === 'ok', error: r === 'ok' ? undefined : r }, r === 'ok' ? 200 : r === 'only the owner' ? 403 : 502);
  }
  const aweme = String(body.aweme || '');
  if (!ITEM_ID_RE.test(aweme)) return json({ error: 'bad aweme' }, 400);
  const res = await itemDone(env, body);
  return json({ ok: true, status: res });
}

// 流式服务转完一条：记结果；失败满次数告诉频道主；它的队列空了就再交下一批
async function itemDone(env, body) {
  const L = lib(env);
  const aweme = String(body.aweme || '');
  const res = await L.itemDone(aweme, !!body.ok, Number(body.message_id) || 0, String(body.error || '').slice(0, 300), MAX_ATTEMPTS);
  if (res === 'failed') await notifyFailed(env, [await L.getItem(aweme)]);
  if (body.idle) await dispatch(env);
  return res;
}

// 流式服务要发给频道主的二维码、验证截图、进度（Hugging Face 的机房连不上 api.telegram.org，由这里代发）。只发给频道主；
// buttons：机器人键盘临时换成这几个按钮（抖音登录页上能点的选项，点了就把字发回来）；menu：换回平时的菜单。返回 'ok' 或出错原因
async function sendToOwner(env, chatId, text, png, opts = {}) {
  const owner = await ownerId(env);
  const chat = Number(chatId);
  if (!owner || chat !== owner) return 'only the owner';
  const buttons = (Array.isArray(opts.buttons) ? opts.buttons : []).map(b => String(b).slice(0, 20)).filter(Boolean).slice(0, 8);
  const markup = buttons.length ? { keyboard: rows(buttons.map(text => ({ text })), 2), resize_keyboard: true, one_time_keyboard: true }
    : opts.menu ? OWNER_KEYBOARD : null;
  let res;
  if (png) {
    const bytes = fromBase64(String(png));
    if (bytes.length > 8 * 1024 * 1024) return 'too big';
    const form = new FormData();
    form.append('chat_id', String(chat));
    form.append('caption', String(text || '').slice(0, 1000));
    if (markup) form.append('reply_markup', JSON.stringify(markup));
    form.append('photo', new Blob([bytes], { type: 'image/png' }), 'douyin.png');
    res = await fetch(`${TG}/bot${env.TG_BOT_TOKEN}/sendPhoto`, { method: 'POST', body: form }).then(r => r.json()).catch(() => ({}));
  } else {
    res = await say(env, chat, String(text || '').slice(0, 4000) || '…', markup ? { reply_markup: markup } : undefined);
  }
  return res.ok ? 'ok' : 'telegram failed';
}

function rows(buttons, per) {
  const out = [];
  for (let i = 0; i < buttons.length; i += per) out.push(buttons.slice(i, i + per));
  return out;
}

// 抖音登录状态（流式服务登录成功后给的 cookie、sec_uid、昵称）；返回出错原因，存好了返回 ''
async function saveSession(env, body) {
  const cookies = (Array.isArray(body.cookies) ? body.cookies : [])
    .filter(c => c && typeof c.name === 'string' && typeof c.value === 'string').slice(0, 200);
  const sec = String(body.sec_uid || '');
  const P = PLATFORMS[body.platform === 'ks' ? 'ks' : 'dy'];
  if (!P.id.test(sec)) return 'bad sec_uid';
  const session = { cookies, sec_uid: sec, nickname: String(body.nickname || '').slice(0, 60), at: Date.now() };
  if (JSON.stringify(session).length > 64 * 1024) return 'too big';
  await lib(env).setConfig(P.session, JSON.stringify(session));
  return '';
}

async function saveProgress(env, body) {
  const p = {
    stage: String(body.stage || '').slice(0, 40), done: Number(body.done) || 0, total: Number(body.total) || 0,
    note: String(body.note || '').slice(0, 200), at: Date.now(),
  };
  await lib(env).setConfig('cloudProgress', JSON.stringify(p));
}

// 收作品：查重、存进待审核，新的成一批，发一张审核单。
// into：同一次抓取上一段用的批次（{ batch, autoBatch }）：还没审的就并进去、改原来那张单子
async function importItems(env, raw, src, what = '', into = {}) {
  const list = Array.isArray(raw) ? raw : [];
  const items = list.map(normalizeItem).filter(Boolean);
  const L = lib(env);
  if (src === 'alt') {
    // 小号的作品：频道主加小号时就认过了，直接排队转发；别的（登录账号自己的、认不出作者的）照常成审核单
    const alts = await altAccounts(env);
    for (const a of alts) {
      const one = items.find(i => i.author_sec_uid === a.sec && i.author);
      if (one) a.name = one.author.slice(0, 50);
      if (items.some(i => i.author_sec_uid === a.sec)) a.last = Date.now();
    }
    await L.setConfig('altAccounts', JSON.stringify(alts));
    const secs = new Set(alts.map(a => a.sec));
    const mine = items.filter(i => secs.has(i.author_sec_uid));
    const old = into.autoBatch && (await L.getBatch(into.autoBatch));
    const batch = old ? into.autoBatch : newBatchId();
    const fresh = await L.addItems(mine, 'alt', batch);
    let auto = 0;
    if (fresh.length) {
      if (!old) await L.addBatch(batch, 'alt', ['#小号同步']);
      auto = await L.reviewBatch(batch, 'queued');
      await rememberAccounts(env, mine);
      await dispatch(env);
    }
    const r = await importItems(env, items.filter(i => !secs.has(i.author_sec_uid)), 'cloud', what, into);
    return { ...r, auto, autoBatch: fresh.length || old ? batch : '', skipped: r.skipped + mine.length - fresh.length, invalid: list.length - items.length };
  }
  const prev = into.batch && (await L.getBatch(into.batch));
  const open = prev && prev.status === 'review';
  const batch = open ? into.batch : newBatchId();
  const fresh = await L.addItems(items, src, batch);
  if (fresh.length) {
    if (!open) await L.addBatch(batch, src, batchTags(src, what));
    await sendSheet(env, batch, open);
  }
  return { added: fresh.length, skipped: items.length - fresh.length, invalid: list.length - items.length, batch: fresh.length || open ? batch : '' };
}

// ── 流式服务的发件箱 ──────────────────────────────────────────────
// Hugging Face 的机房按域名挡掉了 *.workers.dev 和 api.telegram.org：流式服务找不到这里，只能这里去找它。
// 交给它活（转作品、登录抖音、抓作品）以后，Durable Object 的定时器连着长轮询它的 /outbox，按序号一条条处理；
// 闲下来就停，定时任务每 5 分钟看一眼还有没有交出去没回音的。

async function pollStreamer(env, waitS) {
  const L = lib(env);
  const boot = (await L.getConfig('streamerBoot')) || '';
  const after = Number(await L.getConfig('outboxSeq')) || 0;
  const res = await fetch(`${streamerBase(env)}/outbox?boot=${encodeURIComponent(boot)}&after=${after}&wait=${waitS}`, {
    headers: { 'X-Key': env.STREAMER_KEY }, signal: AbortSignal.timeout((waitS + 30) * 1000),
  });
  const data = res.status === 200 ? await res.json().catch(() => null) : null;
  if (!data || typeof data.boot !== 'string' || !data.boot) {
    if (res.body && !res.bodyUsed) res.body.cancel();
    throw new Error(`outbox ${res.status}`); // 休眠、重启中
  }
  if (data.boot !== boot) {
    // 流式服务重启过（或第一次连上）：它手上的队列丢了，「在转」的放回队列再交；发件箱序号从头算，这一批不认
    await L.setConfig('streamerBoot', data.boot);
    await L.setConfig('outboxSeq', '0');
    await L.setConfig('streamerUp', String(Date.now()));
    await L.releaseAllSending();
    await dispatch(env);
    return { busy: true, more: true };
  }
  const events = Array.isArray(data.events) ? data.events : [];
  for (const ev of events) {
    try {
      await handleEvent(env, ev);
    } catch {
      // 一条出错不卡住后面的
    }
    await L.setConfig('outboxSeq', String(ev.seq));
  }
  if (events.some(e => e.kind === 'done')) await refreshCards(env).catch(() => {});
  if (!data.busy && (await crawlQueue(env)).length) {
    await startQueued(env).catch(() => {});
    return { busy: true, more: events.length > 0 }; // 刚交了（或者还在排）：接着轮询
  }
  return { busy: !!data.busy, more: events.length > 0 };
}

async function handleEvent(env, ev) {
  if (ev.kind === 'done') {
    if (ITEM_ID_RE.test(String(ev.aweme || ''))) await itemDone(env, ev);
  } else if (ev.kind === 'say') {
    await sendToOwner(env, ev.chat_id, ev.text, ev.png, { buttons: ev.buttons, menu: ev.menu });
  } else if (ev.kind === 'session') {
    await saveSession(env, ev);
  } else if (ev.kind === 'progress') {
    await saveProgress(env, ev);
  } else if (ev.kind === 'import') {
    await importEvent(env, ev);
  }
}

// 云电脑边抓边交：同一次抓取（job）分好几段送来，最后一段带 final。
// 小号的每段一到就排队转发；要审的并进同一张审核单。每次抓取给频道主一张「进度卡」，原地更新：
// 抓到几条、新的几条，小号的转了几条、排队几条、失败几条。抓完发汇总，全部转完再说一声。
// 没有 job 的（Codespaces 的 /dy-import、老版本）当成一次送完，只发汇总
async function importEvent(env, ev) {
  const L = lib(env);
  const job = /^[0-9a-f]{6,32}$/.test(String(ev.job || '')) ? String(ev.job) : '';
  const cards = await crawlCards(env);
  let st = job && cards.find(c => c.job === job);
  if (!st) {
    // 上一版只记一个 crawlJob：换版本时正在抓的那次，接着它的条数和批次算
    const prev = JSON.parse((await L.getConfig('crawlJob')) || '{}');
    const carry = job && prev.job === job ? prev : {};
    st = { job, chat: Number(ev.chat_id) || 0, what: String(ev.what || '').slice(0, 80), src: ev.src, at: Date.now(),
      added: carry.added || 0, skipped: carry.skipped || 0, auto: carry.auto || 0, batch: carry.batch || '', autoBatch: carry.autoBatch || '',
      final: false, msg: 0, text: '', closed: false };
    if (job) cards.push(st);
  }
  const src = ['link', 'search', 'alt'].includes(ev.src) ? ev.src : 'cloud';
  const r = await importItems(env, (ev.items || []).slice(0, 10000), src, ev.what, st);
  st.added += r.added;
  st.skipped += r.skipped;
  st.auto += r.auto || 0;
  st.batch = r.batch || st.batch;
  st.autoBatch = r.autoBatch || st.autoBatch;
  st.final = !job || ev.final !== false;
  if (st.final) st.end = Date.now();
  const total = st.added + st.skipped + st.auto;
  await saveProgress(env, st.final
    ? { stage: '完成', done: st.added + st.auto, total, note: `新的 ${st.added + st.auto} 条，已有 ${st.skipped} 条` }
    : { stage: `抓${ev.what || ''}`, done: total, note: `边抓边交：新的 ${st.added + st.auto} 条，已有 ${st.skipped} 条` });
  if (job) {
    await saveCards(env, cards);
    await refreshCards(env);
  }
  if (!st.final) return;
  const parts = [];
  if (st.auto) parts.push(`新的 ${st.auto} 条是小号的作品，已经排队转进频道`);
  if (st.added) parts.push(`新的 ${st.added} 条在审核单 ${st.batch}，去审核机器人 @xiaojuverify_bot 审`);
  await sendToOwner(env, ev.chat_id, `抓完了：一共 ${total} 条，${st.skipped} 条以前收过` + (parts.length ? `，${parts.join('；')}。` : '，没有新的。') +
    (st.auto ? '\n转发进度看上面的进度卡，全部转完我再告诉你。' : ''));
}

async function crawlCards(env) {
  return JSON.parse((await lib(env).getConfig('crawlCards')) || '[]');
}

async function saveCards(env, cards) {
  await lib(env).setConfig('crawlCards', JSON.stringify(cards.slice(-5)));
}

function countLine(c) {
  const busy = (c.queued || 0) + (c.sending || 0);
  return `✅ 已转 ${c.posted || 0} · ⏳ 排队/在转 ${busy} · ❌ 失败 ${c.failed || 0}`;
}

// 进度卡的文字
async function cardText(env, st) {
  const L = lib(env);
  const total = st.added + st.skipped + st.auto;
  const mins = Math.max(1, Math.round(((st.end || Date.now()) - st.at) / 60000));
  const lines = [
    `📥 抓取进度：${st.what || '抖音作品'}`,
    st.final ? `✅ 抓完了（用了 ${mins} 分钟）` : `⏳ 正在抓…（已经 ${mins} 分钟，边抓边转）`,
    `抓到 ${total} 条：新的 ${st.added + st.auto} 条，以前收过 ${st.skipped} 条`,
  ];
  const a = st.autoBatch && (await L.getBatch(st.autoBatch));
  if (a) lines.push(`小号的作品 ${a.total} 条：${countLine(a.counts)}`);
  const b = st.batch && (await L.getBatch(st.batch));
  if (b) {
    const state = { review: '等你审核', approved: '已通过', rejected: '审核失败，不转' }[b.status] || b.status;
    lines.push(`要审核的 ${b.total} 条（审核单 ${b.id}，${state}）` + (b.status === 'approved' ? `：${countLine(b.counts)}` : ''));
  }
  return { text: lines.join('\n'), a, b };
}

// 更新还没结束的进度卡：文字变了才改。抓完、该转的都转完（排队、在转的都没了），发一句「全部转完」就不再管它
async function refreshCards(env) {
  const cards = await crawlCards(env);
  const open = cards.filter(c => !c.closed);
  if (!open.length) return;
  for (const st of open) {
    const { text, a, b } = await cardText(env, st);
    if (text !== st.text) {
      if (st.msg) {
        await tg(env.TG_BOT_TOKEN, 'editMessageText', { chat_id: st.chat, message_id: st.msg, text, disable_web_page_preview: true });
      } else {
        const r = await say(env, st.chat, text);
        st.msg = (r && r.result && r.result.message_id) || 0;
      }
      st.text = text;
    }
    const moving = x => x && ((x.counts.queued || 0) + (x.counts.sending || 0));
    if (st.final && !moving(a) && !moving(b) && !(b && b.status === 'review')) {
      st.closed = true;
      const posted = ((a && a.counts.posted) || 0) + ((b && b.counts.posted) || 0);
      const failed = ((a && a.counts.failed) || 0) + ((b && b.counts.failed) || 0);
      if (posted || failed) {
        await say(env, st.chat, `🎉 「${st.what || '这次抓的'}」全部转完了：成功 ${posted} 条` +
          (failed ? `，失败 ${failed} 条（发「重试失败」再试一次）` : '') + '。');
      }
    }
  }
  await saveCards(env, cards);
}

// ── 云电脑 ────────────────────────────────────────────────────────

// 两种来路：Codespaces 里的云电脑（X-Token，机器人「云电脑」发的令牌）、流式服务里的 MediaCrawler（X-Key）
async function cloudApi(request, env, ctx, path) {
  const L = lib(env);
  const key = request.headers.get('X-Key') || '';
  const viaStreamer = !!env.STREAMER_KEY && sameString(key, env.STREAMER_KEY);
  if (!viaStreamer) {
    const want = await L.getConfig('cloudToken');
    const got = request.headers.get('X-Token') || '';
    if (!want || !sameString(got, want)) return json({ error: 'forbidden' }, 403);
  }
  const body = await request.json().catch(() => ({}));
  if (path === '/dy-session') {
    // 抖音登录状态只收流式服务的：Codespaces 那边自己存在浏览器档案里
    if (!viaStreamer) return json({ error: 'forbidden' }, 403);
    const err = await saveSession(env, body);
    return err ? json({ error: err }, err === 'too big' ? 413 : 400) : json({ ok: true });
  }
  if (path === '/dy-known') {
    const ids = (Array.isArray(body.ids) ? body.ids : []).map(String).filter(x => ITEM_ID_RE.test(x)).slice(0, 1000);
    return json({ known: await L.knownAwemes(ids) });
  }
  if (path === '/dy-import') {
    const raw = Array.isArray(body.items) ? body.items : [];
    if (raw.length > IMPORT_MAX) return json({ error: `一次最多 ${IMPORT_MAX} 条` }, 413);
    const r = await importItems(env, raw, viaStreamer && body.src === 'link' ? 'link' : 'cloud');
    return json({ ok: true, ...r });
  }
  if (path === '/dy-progress') {
    await saveProgress(env, body);
    return json({ ok: true });
  }
  return json({ error: 'not found' }, 404);
}

const HTTPS = /^https:\/\/[^\s]{4,2000}$/;

// 云电脑、流式服务送来的作品一律在这里过一遍，只留认得的字段
function normalizeItem(x) {
  if (!x || typeof x !== 'object') return null;
  const aweme = String(x.aweme || '');
  if (!ITEM_ID_RE.test(aweme)) return null;
  const ks = aweme.startsWith('ks_');
  const type = x.type === 'images' ? 'images' : x.type === 'video' ? 'video' : '';
  if (!type) return null;
  const item = {
    aweme, type,
    desc: String(x.desc || '').slice(0, 1000),
    author: String(x.author || '').slice(0, 100),
    create_time: Number(x.create_time) || 0,
    url: HTTPS.test(x.url || '') ? x.url
      : ks ? `https://www.kuaishou.com/short-video/${aweme.slice(3)}` : `https://www.douyin.com/${type === 'images' ? 'note' : 'video'}/${aweme}`,
  };
  if (ks) item.platform = 'ks';
  if (type === 'video' && HTTPS.test(x.video_url || '')) item.video_url = x.video_url;
  if (type === 'images') item.images = (Array.isArray(x.images) ? x.images : []).filter(u => HTTPS.test(u || '')).slice(0, 35);
  if (HTTPS.test(x.cover || '')) item.cover = x.cover;
  if ((ks ? KS_UID_RE : SEC_RE).test(String(x.author_sec_uid || ''))) item.author_sec_uid = x.author_sec_uid;
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
      // 抖音登录的是哪个账号（cookie 不给）
      douyin: await dySession(env).then(x => x && {
        nickname: x.nickname, sec_uid: x.sec_uid, at: x.at,
        // 只给名字、域名、过期时间，值不给
        cookies: x.cookies.map(c => ({ name: c.name, domain: c.domain, expires: c.expires, httpOnly: c.httpOnly })),
      }),
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
    const ids = (Array.isArray(body.ids) ? body.ids : []).map(String).filter(x => ITEM_ID_RE.test(x));
    const to = body.to === 'queued' ? 'queued' : body.to === 'rejected' ? 'rejected' : '';
    if (!to) return json({ error: 'bad to' }, 400);
    const n = await L.review(ids, to);
    if (n && to === 'queued') await dispatch(env);
    return json({ ok: true, n });
  }
  if (action === 'dispatch') return json({ ok: true, n: await dispatch(env) });
  // 补全视频池：从头（reset）或接着上次翻频道历史
  if (action === 'scan-channel') {
    if (body.reset) await L.setConfig('channelScan', '{}');
    return json({ ok: true, ...(await scanChannel(env, 10)) });
  }
  // 替频道主点「登录抖音」：二维码照样发到频道主和小橘视频机器人的私聊里
  if (action === 'douyin-login') {
    const owner = await ownerId(env);
    if (!owner) return json({ error: 'no owner' }, 409);
    await douyinLogin(env, owner);
    return json({ ok: true });
  }
  if (action === 'poll') {
    await L.kick();
    return json({ ok: true });
  }
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

async function videoFile(request, env, id, ctx) {
  const rec = await lib(env).getVideo(id);
  if (!rec) throw new HttpError(404, '没有这个视频');
  const cached = await fromEdgeCache(request, env, rec, ctx);
  if (cached) return cached;
  // 翻历史补进来的没有 Bot API 的 file_id：和大视频一样走流式服务（按消息号取）
  const big = !rec.file_id || !rec.size || rec.size > BOT_DOWNLOAD_LIMIT;
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

function edgeKey(request, id) {
  return new URL(`/__video-cache/${id}`, request.url).toString();
}

// 边缘缓存里有就直接给（它自己会按 Range 切成 206）；没有就在后台整个取一份放进去，这次照常从源头给
async function fromEdgeCache(request, env, rec, ctx) {
  if (typeof caches === 'undefined' || request.method !== 'GET' || !rec.size || rec.size > EDGE_CACHE_MAX) return null;
  const key = edgeKey(request, rec.id);
  const range = request.headers.get('Range');
  const hit = await caches.default.match(new Request(key, { headers: range ? { Range: range } : {} })).catch(() => null);
  if (hit && (hit.status === 200 || hit.status === 206)) {
    const headers = cors({ 'Content-Type': rec.mime, 'Accept-Ranges': 'bytes', 'Cache-Control': 'public, max-age=86400', 'X-Edge-Cache': 'hit' });
    for (const h of ['Content-Length', 'Content-Range']) if (hit.headers.get(h)) headers[h] = hit.headers.get(h);
    return new Response(hit.body, { status: hit.status, headers });
  }
  if (hit && hit.body) hit.body.cancel();
  if (ctx && !filling.has(rec.id) && (rec.file_id || streamerOn(env))) {
    filling.add(rec.id);
    ctx.waitUntil(fillEdgeCache(env, rec, key).catch(() => {}).finally(() => filling.delete(rec.id)));
  }
  return null;
}

async function fillEdgeCache(env, rec, key) {
  const viaBot = rec.file_id && rec.size <= BOT_DOWNLOAD_LIMIT;
  const res = viaBot ? await fetchFile(env, rec.file_id, null) : await fromStreamer(env, rec, null, null);
  if (res.status !== 200 || Number(res.headers.get('Content-Length') || rec.size) !== rec.size) {
    if (res.body) res.body.cancel();
    return;
  }
  await caches.default.put(key, new Response(res.body, {
    headers: { 'Content-Type': rec.mime, 'Content-Length': String(rec.size), 'Cache-Control': `public, max-age=${EDGE_CACHE_TTL_S}` },
  }));
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
    this.polling = false; // 定时器正在轮询流式服务
    this.kicked = false;  // 轮询期间又交了新活：这一轮别急着停
    ctx.blockConcurrencyWhile(async () => {
      // 视频池：频道里的视频帖，每条一行；rec 是完整记录（含 Bot API 的 file_id）
      this.sql.exec('CREATE TABLE IF NOT EXISTS videos (id INTEGER PRIMARY KEY, rec TEXT NOT NULL, date INTEGER NOT NULL)');
      this.sql.exec('CREATE TABLE IF NOT EXISTS thumbs (id INTEGER PRIMARY KEY, mime TEXT NOT NULL, data TEXT NOT NULL)');
      // 以前的记录里存过频道帖的说明和标签：清掉，只留播放要用的
      this.sql.exec("UPDATE videos SET rec = json_remove(rec, '$.caption', '$.aweme') WHERE json_type(rec, '$.caption') IS NOT NULL OR json_type(rec, '$.aweme') IS NOT NULL");
      // 抖音作品：status 是 review（待审核）/ rejected（不转）/ queued（排队）/ sending（交给流式服务了）/
      // posted（已发进频道，msg 是消息号）/ failed（试了 MAX_ATTEMPTS 次还不行）；src 是 cloud / link
      this.sql.exec(`CREATE TABLE IF NOT EXISTS items (aweme TEXT PRIMARY KEY, status TEXT NOT NULL, src TEXT NOT NULL,
        data TEXT NOT NULL, created INTEGER NOT NULL, updated INTEGER NOT NULL, attempts INTEGER NOT NULL DEFAULT 0,
        msg INTEGER NOT NULL DEFAULT 0, error TEXT NOT NULL DEFAULT '')`);
      this.sql.exec('CREATE INDEX IF NOT EXISTS items_status ON items (status, created)');
      // 审核单：每次同步、搜索、发链接收进来的一批作品。频道主整批审：通过 / 失败
      if (!this.sql.exec('PRAGMA table_info(items)').toArray().some(r => r.name === 'batch')) {
        this.sql.exec("ALTER TABLE items ADD COLUMN batch TEXT NOT NULL DEFAULT ''");
      }
      this.sql.exec('CREATE INDEX IF NOT EXISTS items_batch ON items (batch)');
      this.sql.exec(`CREATE TABLE IF NOT EXISTS batches (id TEXT PRIMARY KEY, src TEXT NOT NULL, tags TEXT NOT NULL,
        created INTEGER NOT NULL, status TEXT NOT NULL DEFAULT 'review', msg INTEGER NOT NULL DEFAULT 0)`);
      this.sql.exec('CREATE TABLE IF NOT EXISTS config (k TEXT PRIMARY KEY, v TEXT NOT NULL)');
      // 心碎：网页上点了 💔 的视频从视频池挪到这里（不删频道里的帖子），频道主在机器人里可以恢复
      this.sql.exec('CREATE TABLE IF NOT EXISTS trash (id INTEGER PRIMARY KEY, rec TEXT NOT NULL, at INTEGER NOT NULL)');
    });
  }

  // ── 轮询流式服务的发件箱（见 pollStreamer）──
  async alarm() {
    const env = { ...this.env, __self: this };
    const until = Date.now() + POLL_WINDOW_MS;
    let busy = false;
    let fails = 0;
    this.polling = true;
    try {
      while (Date.now() < until) {
        this.kicked = false;
        let r;
        try {
          r = await pollStreamer(env, POLL_WAIT_S);
          fails = 0;
        } catch {
          // 连不上（休眠、重启中）：歇 5 秒再试，连着 3 次不行就停，等定时任务
          if (++fails >= 3) break;
          await new Promise(res => setTimeout(res, 5000));
          continue;
        }
        busy = r.busy;
        if (!r.busy && !r.more && !this.kicked) break;
      }
    } finally {
      this.polling = false;
    }
    // 跑满 12 分钟还在忙：接着来
    if (busy && Date.now() >= until) await this.ctx.storage.setAlarm(Date.now() + 1000);
  }

  // 交给流式服务新活以后调：没在轮询就马上开始
  async kick() {
    if (this.polling) {
      this.kicked = true;
      return;
    }
    if (!(await this.ctx.storage.getAlarm())) await this.ctx.storage.setAlarm(Date.now());
  }

  getConfig(k) {
    const r = this.sql.exec('SELECT v FROM config WHERE k = ?', k).toArray()[0];
    return r ? r.v : null;
  }

  setConfig(k, v) {
    this.sql.exec('INSERT INTO config (k, v) VALUES (?, ?) ON CONFLICT(k) DO UPDATE SET v = excluded.v', k, String(v));
  }

  // ── 视频池 ──
  // 翻频道历史补进来的：已经登记过的不动（webhook 登记的带 file_id，更好用）。返回新加了几条
  addScannedVideos(list) {
    let n = 0;
    for (const v of list) {
      if (this.sql.exec('SELECT 1 FROM videos WHERE id = ?', v.id).toArray().length || this.isTrashed(v.id)) continue;
      this.sql.exec('INSERT INTO videos (id, rec, date) VALUES (?, ?, ?)', v.id, JSON.stringify(v), v.date || 0);
      n++;
    }
    return n;
  }

  upsertVideo(rec) {
    if (this.isTrashed(rec.id)) return false; // 心碎过的：频道里编辑这条帖子也不回到视频池
    const fresh = !this.sql.exec('SELECT 1 FROM videos WHERE id = ?', rec.id).toArray().length;
    this.sql.exec('INSERT INTO videos (id, rec, date) VALUES (?, ?, ?) ON CONFLICT(id) DO UPDATE SET rec = excluded.rec, date = excluded.date',
      rec.id, JSON.stringify(rec), rec.date || 0);
    return fresh;
  }

  // 心碎：挪进 trash（缩略图留着，恢复时还用得上）。没有这条返回 false
  trashVideo(id) {
    const r = this.sql.exec('SELECT rec FROM videos WHERE id = ?', id).toArray()[0];
    if (!r) return false;
    this.sql.exec('INSERT OR REPLACE INTO trash (id, rec, at) VALUES (?, ?, ?)', id, r.rec, Date.now());
    this.sql.exec('DELETE FROM videos WHERE id = ?', id);
    return true;
  }

  restoreVideo(id) {
    const r = this.sql.exec('SELECT rec FROM trash WHERE id = ?', id).toArray()[0];
    if (!r) return false;
    const rec = JSON.parse(r.rec);
    this.sql.exec('INSERT OR REPLACE INTO videos (id, rec, date) VALUES (?, ?, ?)', id, r.rec, rec.date || 0);
    this.sql.exec('DELETE FROM trash WHERE id = ?', id);
    return true;
  }

  isTrashed(id) {
    return this.sql.exec('SELECT 1 FROM trash WHERE id = ?', id).toArray().length > 0;
  }

  trashedSince(ms) {
    return this.sql.exec('SELECT COUNT(*) AS n FROM trash WHERE at > ?', ms).toArray()[0].n;
  }

  listTrash(limit) {
    return this.sql.exec('SELECT id, at FROM trash ORDER BY at DESC LIMIT ?', limit).toArray();
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
  addItems(items, src, batch = '') {
    const now = Date.now();
    const fresh = [];
    for (const item of items) {
      const old = this.sql.exec('SELECT status FROM items WHERE aweme = ?', item.aweme).toArray()[0];
      if (old && old.status !== 'failed') continue;
      this.sql.exec(`INSERT INTO items (aweme, status, src, data, created, updated, batch) VALUES (?, 'review', ?, ?, ?, ?, ?)
        ON CONFLICT(aweme) DO UPDATE SET status = 'review', src = excluded.src, data = excluded.data, updated = excluded.updated,
          attempts = 0, error = '', batch = excluded.batch`,
      item.aweme, src, JSON.stringify(item), now, now, batch);
      fresh.push(item.aweme);
    }
    return fresh;
  }

  // ── 审核单 ──
  addBatch(id, src, tags) {
    this.sql.exec('INSERT INTO batches (id, src, tags, created) VALUES (?, ?, ?, ?)', id, src, JSON.stringify(tags), Date.now());
  }

  getBatch(id) {
    const r = this.sql.exec('SELECT * FROM batches WHERE id = ?', id).toArray()[0];
    if (!r) return null;
    const counts = {};
    for (const c of this.sql.exec('SELECT status, COUNT(*) AS n FROM items WHERE batch = ? GROUP BY status', id).toArray()) counts[c.status] = c.n;
    return { ...r, tags: JSON.parse(r.tags), counts, total: Object.values(counts).reduce((a, b) => a + b, 0) };
  }

  batchItems(id) {
    return this.sql.exec('SELECT * FROM items WHERE batch = ? ORDER BY created, aweme', id).toArray().map(r => this.row(r));
  }

  // 按作者统计作品各状态的条数：{ sec_uid: { posted: 3, queued: 1, … } }
  authorStats(secs) {
    const out = {};
    if (!secs.length) return out;
    const rows = this.sql.exec(`SELECT json_extract(data, '$.author_sec_uid') AS sec, status, COUNT(*) AS n FROM items
      WHERE json_extract(data, '$.author_sec_uid') IN (${secs.map(() => '?').join(',')}) GROUP BY sec, status`, ...secs).toArray();
    for (const r of rows) (out[r.sec] = out[r.sec] || {})[r.status] = r.n;
    return out;
  }

  orphanSrcs() {
    return this.sql.exec("SELECT DISTINCT src FROM items WHERE status = 'review' AND (batch IS NULL OR batch = '')").toArray().map(r => r.src);
  }

  adoptOrphans(id, src) {
    this.sql.exec("UPDATE items SET batch = ? WHERE status = 'review' AND (batch IS NULL OR batch = '') AND src = ?", id, src);
  }

  openBatches(limit) {
    return this.sql.exec("SELECT id FROM batches WHERE status = 'review' ORDER BY created LIMIT ?", limit).toArray();
  }

  setBatchMsg(id, msg) {
    this.sql.exec('UPDATE batches SET msg = ? WHERE id = ?', msg, id);
  }

  // 整批审：只动这批里还在待审核的；返回动了几条
  reviewBatch(id, to) {
    const n = this.sql.exec("UPDATE items SET status = ?, updated = ? WHERE batch = ? AND status = 'review' RETURNING aweme", to, Date.now(), id).toArray().length;
    this.sql.exec('UPDATE batches SET status = ? WHERE id = ?', to === 'queued' ? 'approved' : 'rejected', id);
    return n;
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
    c.searchReview = this.sql.exec("SELECT COUNT(*) AS n FROM items WHERE status = 'review' AND src = 'search'").toArray()[0].n;
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

// 审核单的「查看全部」：这批作品的文字、作者、作者主页、抖音链接（审核单编号随机 14 位，知道编号才打得开）
async function reviewPage(env, id, method) {
  const L = lib(env);
  const b = await L.getBatch(id);
  if (!b) return text('没有这张审核单', 404);
  const items = await L.batchItems(id);
  const mine = await myAccounts(env);
  const esc = x => String(x == null ? '' : x).replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]);
  const state = { review: '待审核', queued: '排队', sending: '在转', posted: '已转', failed: '失败', rejected: '不转' };
  const rows = items.map((i, n) => `<li><div class="d">${esc(i.desc || '（没有文字）')}</div>
<div class="m">${n + 1}. ${KIND[i.type] || '作品'} · ${esc(state[i.status] || i.status)} ·
${i.author_sec_uid ? `<a href="${esc(PLATFORMS[platOfItem(i)].profile(i.author_sec_uid))}" target="_blank" rel="noopener">${esc(i.author || '作者主页')}</a>` : esc(i.author || '（没有作者信息）')}
${i.author_sec_uid && mine.includes(i.author_sec_uid) ? '<b>✓ 认过的号</b>' : ''} ·
<a href="${esc(i.url)}" target="_blank" rel="noopener">抖音上看</a></div></li>`).join('\n');
  const page = `<!doctype html><html lang="zh-CN"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<meta name="robots" content="noindex"><title>审核单 ${esc(id)}</title><style>
:root{--bg:#fafaf7;--fg:#222;--dim:#777;--line:#e5e2da;--ok:#2e7d32}
@media (prefers-color-scheme:dark){:root{--bg:#151413;--fg:#eee;--dim:#999;--line:#333;--ok:#81c784}}
body{margin:0;background:var(--bg);color:var(--fg);font:15px/1.6 -apple-system,"PingFang SC","Noto Sans SC",sans-serif}
main{max-width:760px;margin:0 auto;padding:16px}h1{font-size:18px}ol{list-style:none;padding:0}
li{border-top:1px solid var(--line);padding:10px 0}.d{white-space:pre-wrap;word-break:break-word}.m{color:var(--dim);font-size:13px}
a{color:inherit}b{color:var(--ok);font-weight:normal}</style></head><body><main>
<h1>${esc(sheetHeader(b))}</h1><p class="m">回审核机器人点「✅ 审核通过」或「❌ 审核失败」，整批一起。</p><ol>${rows}</ol></main></body></html>`;
  return html(page, method, { 'X-Robots-Tag': 'noindex' });
}

function html(body, method, extra) {
  return new Response(method === 'HEAD' ? null : body, {
    headers: { 'Content-Type': 'text/html; charset=utf-8', 'Cache-Control': 'no-cache', ...extra },
  });
}

export { parseRange, normalizeItem, douyinLinks, toRecord };
