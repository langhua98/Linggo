// 本地测试：Node 自带的 SQLite 模拟 Durable Object，再模拟 Telegram 和流式服务，逐条验证 worker.js
import assert from 'node:assert/strict';
import { register } from 'node:module';
import { DatabaseSync } from 'node:sqlite';

register('./test/hooks.mjs', import.meta.url);
const { default: worker, Library } = await import('./worker.js');

const TOKEN = '123:SECRET-BOT-TOKEN';
const VTOKEN = '987654:VERIFY-BOT-TOKEN-abcdefghijklmnopqrstuvwxyz'; // 审核机器人（@xiaojuverify_bot）
const HOOK = 'hook-secret';
const ADMIN = 'admin-key-123';
const SKEY = 'streamer-key-456';
const STREAMER = 'https://streamer.example';
const VIDEO_CHANNEL = -1004292843233;
const MB = 1024 * 1024;


// ── 模拟 Durable Object（SQLite + 结构化克隆，和 RPC 一样不共享引用）──
function makeSql(db = new DatabaseSync(':memory:')) {
  return { exec: (query, ...params) => { const rows = db.prepare(query).all(...params).map(r => ({ ...r })); return { toArray: () => rows }; } };
}
async function makeLibrary(env, db) {
  let ready;
  const ctx = { storage: { sql: makeSql(db) }, blockConcurrencyWhile(fn) { ready = fn(); return ready; } };
  const lib = new Library(ctx, env);
  await ready;
  return new Proxy({}, {
    get: (_, name) => name === 'then' ? undefined : async (...args) => structuredClone(await lib[name](...structuredClone(args))),
  });
}

// ── 模拟 Telegram（小视频）和流式服务（大视频、抖音）──
const files = new Map();   // file_id -> 字节（Bot API 能取的小文件）
let seq = 0;
const addFile = bytes => { const id = 'F' + (++seq); files.set(id, bytes); return id; };
const bytesOf = (n, seed) => { const b = new Uint8Array(n); for (let i = 0; i < n; i++) b[i] = (i * 7 + seed + (i >> 12)) & 255; return b; };
const calls = [];
const OWNER = 777, FAN = 555;
const bot = { vout: [], vStarted: false, out: [], toStreamer: [], streamerDown: false, copyBusy: false, copyFail: '', adminAsks: 0 };
const mode = { getFile: 'ok', expireOnce: false };
// 视频频道（刷视频网页）：流式服务翻出来的视频帖、只有它取得到的大视频和缩略图。mode：ok / down（没连上）/ old（旧版 Space，没有这些接口）
const vids = { scan: [], complete: true, scanMode: 'ok', scans: 0, big: new Map(), thumbs: new Map(), streamMode: 'ok' };
const DAY = 24 * 3600 * 1000;
const JPEG = n => Uint8Array.from([0xff, 0xd8, 0xff, 0xe0, ...bytesOf(n, n)]);

function serve(bytes, range, extraHeaders = {}) {
  if (!range) return new Response(bytes, { headers: { 'Content-Length': String(bytes.length), ...extraHeaders } });
  const [a, b] = range.replace('bytes=', '').split('-');
  const start = Number(a), end = b ? Number(b) : bytes.length - 1;
  return new Response(bytes.slice(start, end + 1), {
    status: 206, headers: { 'Content-Length': String(end - start + 1), 'Content-Range': `bytes ${start}-${end}/${bytes.length}`, ...extraHeaders },
  });
}

globalThis.fetch = async (input, init = {}) => {
  const url = String(input);
  const headers = new Headers(init.headers || {});
  calls.push({ url, range: headers.get('Range'), key: headers.get('X-Key') });
  let m;
  if ((m = url.match(/^https:\/\/streamer\.example\/(videos|vstream\/(\d+)|vthumb\/(\d+))\?(.*)$/))) {
    assert.equal(headers.get('X-Key'), SKEY);
    assert.equal(new URLSearchParams(m[4]).get('target'), String(VIDEO_CHANNEL));
    const which = m[1].split('/')[0], mode2 = which === 'videos' ? vids.scanMode : vids.streamMode;
    if (mode2 === 'down') throw new TypeError('fetch failed');
    if (mode2 === 'old') return Response.json({ detail: 'Not Found' }, { status: 404 });
    if (which === 'videos') { vids.scans++; return Response.json({ videos: vids.scan, complete: vids.complete }); }
    if (which === 'vstream') {
      const f = vids.big.get(Number(m[2]));
      return f ? serve(f, headers.get('Range'), { 'Content-Type': 'application/octet-stream' }) : Response.json({ detail: 'gone' }, { status: 404 });
    }
    const img = vids.thumbs.get(Number(m[3]));
    if (img === undefined) return Response.json({ detail: 'gone' }, { status: 404 });
    return img ? new Response(img, { headers: { 'Content-Type': 'image/jpeg' } }) : Response.json({ detail: 'no thumb' }, { status: 404 });
  }
  if (url === 'https://api.github.com/user') {
    const who = { 'gh-owner': 'langhua98', 'gh-other': 'someone' }[headers.get('Authorization').replace('Bearer ', '')];
    return who ? Response.json({ login: who }) : Response.json({ message: 'Bad credentials' }, { status: 401 });
  }
  if (url.startsWith(STREAMER + '/douyin/posted?')) {
    assert.equal(headers.get('X-Key'), SKEY);
    return Response.json({ ids: ['7600000000000000001', '7600000000000000002'] });
  }
  // 机器人要用的流式服务接口：记下收到的请求，按 bot 里设好的回
  if ((m = url.match(/^https:\/\/streamer\.example\/(douyin\/link|douyin\/mirror|douyin\/login|douyin\/resolve|douyin\/import|douyin\/status|douyin\/stop)(?:\?(.*))?$/)) || url === STREAMER + '/') {
    if (bot.streamerDown) throw new TypeError('fetch failed');
    if (url === STREAMER + '/') return Response.json({ ok: true });
    assert.equal(headers.get('X-Key'), SKEY);
    const body = init.body ? JSON.parse(init.body) : null;
    bot.toStreamer.push({ path: m[1], body, query: m[2] || '' });
    // 没特意设状态时：交过任务就当它已经转完（带着那次的编号），没交过就是刚启动的 idle
    if (m[1] === 'douyin/status') return Response.json(bot.dyStatus || (bot.lastRun ? { status: 'done', run_id: bot.lastRun } : { status: 'idle' }));
    if (m[1] === 'douyin/stop') return Response.json({ stopped: !!bot.dyStatus });
    if (m[1] === 'douyin/import') {
      if (body.final && body.text === '') return Response.json({ ok: true, total: 0, video: 0, images: 0, added: 0, started: false });
      if (!/aweme_id/.test(body.text)) return Response.json({ detail: '文件里没认出抖音作品' }, { status: 400 });
      const started = !bot.importing;
      if (body.final === false) bot.importing = true;
      if (started) bot.lastRun = body.run_id;
      return Response.json({ ok: true, total: 2, video: 1, images: 1, added: 2, started });
    }
    if (m[1] === 'douyin/resolve') {
      if (/\/user\/(\w+)/.test(body.text)) return Response.json({ kind: 'user', id: 'MS4wLjABAAAA' + body.text.match(/\/user\/(\w+)/)[1] });
      if (/video/.test(body.text)) return Response.json({ kind: 'aweme', id: '123456789' });
      return Response.json({ detail: '没认出抖音链接' }, { status: 400 });
    }
    if (m[1] === 'douyin/link') {
      if (!/douyin\.com/.test(body.text)) return Response.json({ detail: '没认出抖音链接' }, { status: 400 });
      if (bot.copyBusy) return Response.json({ detail: 'already running' }, { status: 409 });
      if (/\/user\//.test(body.text)) return Response.json({ kind: 'user', sec_uid: 'MS4wLjABAAAAJObrvSZxXpV8f05lqI-Y8HJyrBORdiOtKImyUldBdng' });
      bot.lastRun = body.run_id;
      return Response.json({ kind: 'aweme', id: '7691335977760321704' });
    }
    return Response.json({ ok: true });
  }
  assert.ok(url.startsWith('https://api.telegram.org/'), 'unexpected fetch ' + url);
  // 审核机器人用自己的令牌：单独记在 bot.vout。频道主没在它那里点「开始」前，它发不了私聊
  if ((m = url.match(/\/bot987654:[^/]+\/(\w+)$/))) {
    assert.ok(url.includes(VTOKEN), '审核机器人的令牌不对');
    const body = JSON.parse(init.body);
    bot.vout.push({ method: m[1], ...body });
    if (m[1] === 'getMe') return Response.json({ ok: true, result: { id: 987654, is_bot: true, username: 'xiaojuverify_bot' } });
    if (m[1] === 'sendMessage' && !bot.vStarted) return Response.json({ ok: false, error_code: 403, description: "Forbidden: bot can't initiate conversation with a user" });
    return Response.json({ ok: true, result: m[1] === 'sendMessage' ? { message_id: 5000 + bot.vout.length } : true });
  }
  if ((m = url.match(/\/bot[^/]+\/(sendMessage|answerCallbackQuery|getChatAdministrators|editMessageText|copyMessage|pinChatMessage|setMyCommands|editMessageReplyMarkup|deleteMessage)$/))) {
    const body = JSON.parse(init.body);
    if (m[1] === 'copyMessage' && bot.copyFail) return Response.json({ ok: false, error_code: 400, description: bot.copyFail });
    if (m[1] === 'getChatAdministrators') {
      assert.equal(String(body.chat_id), String(VIDEO_CHANNEL));
      bot.adminAsks++;
      return Response.json({ ok: true, result: [{ status: 'administrator', user: { id: 1 } }, { status: 'creator', user: { id: OWNER } }] });
    }
    if (m[1] === 'editMessageText' && bot.editGone && String(body.chat_id) === String(VIDEO_CHANNEL)) {
      return Response.json({ ok: false, error_code: 400, description: 'Bad Request: message to edit not found' });
    }
    bot.out.push({ method: m[1], ...body });
    return Response.json({ ok: true, result: m[1] === 'sendMessage' ? { message_id: 9000 + bot.out.length } : {} });
  }
  if ((m = url.match(/\/bot[^/]+\/getFile\?file_id=(.+)$/))) {
    const f = files.get(decodeURIComponent(m[1]));
    if (!f) return Response.json({ ok: false, error_code: 400, description: 'Bad Request: invalid file_id' });
    if (mode.getFile === 'fail') return Response.json({ ok: false, error_code: 500, description: 'Internal Server Error' });
    return Response.json({ ok: true, result: { file_path: 'video/' + m[1] + '.bin' } });
  }
  if ((m = url.match(/\/file\/bot[^/]+\/video\/(.+)\.bin$/))) {
    if (mode.expireOnce) { mode.expireOnce = false; return new Response('Not Found', { status: 404 }); }
    return serve(files.get(m[1]), headers.get('Range'));
  }
  throw new Error('unexpected fetch ' + url);
};

// ── 被测环境 ──
const env = {
  TG_BOT_TOKEN: TOKEN, TG_WEBHOOK_SECRET: HOOK, ADMIN_KEY: ADMIN, STREAMER_KEY: SKEY, STREAMER_URL: STREAMER + '/',
  VIDEO_CHANNEL_ID: String(VIDEO_CHANNEL),
};
const lib = await makeLibrary(env);
env.LIB = { idFromName: n => n, get: () => lib };

const BASE = 'https://xiaoju-video.example.workers.dev';
const req = (path, init) => worker.fetch(new Request(BASE + path, init), env);
const hook = (update, secret = HOOK) => req('/tg-webhook', {
  method: 'POST', headers: { 'Content-Type': 'application/json', 'X-Telegram-Bot-Api-Secret-Token': secret }, body: JSON.stringify(update),
});
const admin = (action, payload, key = ADMIN) => req('/admin/api/' + action, payload === undefined
  ? { headers: { Authorization: 'Bearer ' + key } }
  : { method: 'POST', headers: { Authorization: 'Bearer ' + key, 'Content-Type': 'application/json' }, body: JSON.stringify(payload) });

const seen = []; // 所有响应的开头和头部，最后查有没有泄露
async function bytes(res) {
  const b = new Uint8Array(await res.arrayBuffer());
  seen.push(new TextDecoder().decode(b.slice(0, 4000)) + JSON.stringify([...res.headers]));
  return b;
}
const textOf = async res => new TextDecoder().decode(await bytes(res));
const jsonOf = async res => JSON.parse(await textOf(res));
const publicTracks = async () => (await jsonOf(await req('/api/tracks'))).tracks;
const find = (list, id) => list.find(t => t.id === id);
const same = (got, src, from, to) => { assert.equal(got.length, to - from); assert.ok(Buffer.from(got).equals(Buffer.from(src.subarray(from, to))), `bytes ${from}-${to} 不一致`); };

let n = 0;
async function t(name, fn) { await fn(); n++; console.log('ok', name); }

// 私聊机器人：from 是谁，发什么
const dm = (from, text) => hook({ update_id: 1, message: { message_id: 1, from: { id: from }, chat: { id: from, type: 'private' }, text } });
const press = (from, data) => hook({ update_id: 2, callback_query: { id: 'cb', from: { id: from }, message: { message_id: 9, chat: { id: from, type: 'private' } }, data } });
const lastSay = () => bot.out.filter(o => o.method === 'sendMessage').at(-1);

// ─────────────────────────────────────────────────────────────

await t('刷视频网页：视频频道的视频帖登记进视频池（不进歌单），说明拆成账号、日期、文案；图片帖不当歌的封面', async () => {
  const vchat = { id: VIDEO_CHANNEL, type: 'channel', title: '小橘视频' };
  const small = bytesOf(4000, 21), thumb = JPEG(300);
  await lib.setConfig('vSyncAt', String(Date.now())); // 先别和频道对（后面单独测）
  await hook({ channel_post: { message_id: 501, chat: vchat, date: 1790812800, caption: '跳舞的小美\n\n📹 抖音 #小美 · 2026-09-30\nhttps://www.douyin.com/video/7600000000000000001',
    video: { file_id: addFile(small), file_unique_id: 'V501', mime_type: 'video/mp4', file_size: small.length, duration: 15, width: 1080, height: 1920, thumbnail: { file_id: addFile(thumb), width: 180, height: 320 } } } });
  await hook({ channel_post: { message_id: 502, chat: vchat, date: 1790812800, caption: '📹 抖音 @某 人 · 2026-09-01\nhttps://www.douyin.com/video/7600000000000000002',
    document: { file_id: 'BIGV', file_unique_id: 'V502', file_name: 'douyin_2.mp4', mime_type: 'video/mp4', file_size: 25 * MB, thumbnail: { file_id: 'NOPE' } } } });
  await hook({ channel_post: { message_id: 503, chat: vchat, date: 1790899200, caption: '频道主自己拍的', video: { file_id: addFile(small), file_unique_id: 'V503', mime_type: 'video/quicktime', file_size: small.length, duration: 3 } } });
  await hook({ channel_post: { message_id: 504, chat: vchat, photo: [{ file_id: 'PHOTO504', width: 800, height: 800 }] } });
  await hook({ channel_post: { message_id: 505, chat: vchat, text: '目录' } });
  const list = (await jsonOf(await req('/api/videos'))).videos;
  assert.deepEqual(list, [
    { id: 503, d: 3, w: 0, h: 0, day: '2026-10-02', by: '', text: '频道主自己拍的' },
    { id: 502, d: 0, w: 0, h: 0, day: '2026-09-01', by: '某 人', text: '' },
    { id: 501, d: 15, w: 1080, h: 1920, day: '2026-09-30', by: '小美', text: '跳舞的小美' },
  ]);
  assert.ok(!JSON.stringify(list).includes('BIGV'), 'file_id 不给出去');
  // 编辑以后不是视频了：从视频池去掉
  await hook({ edited_channel_post: { message_id: 503, chat: vchat, text: '改成文字' } });
  assert.deepEqual((await jsonOf(await req('/api/videos'))).videos.map(v => v.id), [502, 501]);
});

await t('刷视频网页：20 MB 以内走 Bot API、更大的走流式服务（带 Range）；封面取一次存起来', async () => {
  const small = files.get([...files.keys()].find(k => files.get(k).length === 4000));
  let r = await req('/vf/501', { headers: { Range: 'bytes=0-1' } });
  assert.equal(r.status, 206);
  assert.deepEqual([r.headers.get('Content-Type'), r.headers.get('Content-Range'), r.headers.get('Accept-Ranges')], ['video/mp4', 'bytes 0-1/4000', 'bytes']);
  same(await bytes(r), small, 0, 2);
  r = await req('/vf/501');
  assert.equal(r.status, 200);
  same(await bytes(r), small, 0, 4000);
  assert.equal((await req('/vf/501', { method: 'HEAD' })).headers.get('Content-Length'), '4000');
  assert.equal((await req('/vf/999')).status, 404);
  // 大视频：流式服务按消息号取（带上视频频道），拖到中间也对
  const big = bytesOf(25 * MB, 77);
  vids.big.set(502, big);
  calls.length = 0;
  r = await req('/vf/502', { headers: { Range: `bytes=${20 * MB}-${20 * MB + 99}` } });
  assert.equal(r.status, 206);
  same(await bytes(r), big, 20 * MB, 20 * MB + 100);
  assert.ok(calls.some(c => c.url.startsWith(STREAMER + '/vstream/502?') && c.range === `bytes=${20 * MB}-${20 * MB + 99}`));
  // 封面：有 Bot API 的缩略图就用它，存起来以后不再取
  r = await req('/vp/501');
  assert.equal(r.status, 200);
  assert.equal(r.headers.get('Content-Type'), 'image/jpeg');
  assert.equal((await bytes(r)).length, JPEG(300).length);
  calls.length = 0;
  assert.equal((await req('/vp/501')).status, 200);
  assert.equal(calls.length, 0, '第二次直接从数据库给');
  // 502 的缩略图 file_id 取不到：改请流式服务取
  vids.thumbs.set(502, JPEG(120));
  r = await req('/vp/502');
  assert.equal(r.status, 200);
  assert.equal((await bytes(r)).length, JPEG(120).length);
});

await t('刷视频网页：有人打开时和频道对一遍：补上 webhook 收不到的、去掉删了的；对完以后才发的新帖不误删；半小时内不再对', async () => {
  const vchat = { id: VIDEO_CHANNEL, type: 'channel', title: '小橘视频' };
  // 频道里现在有 501、502（文案改过）、510（机器人自己转进去的，webhook 收不到）；更早的 499 删了
  await lib.upsertVideo({ id: 499, file_id: '', file_unique_id: '', thumb: '', mime: 'video/mp4', size: 10, duration: 1, w: 0, h: 0, date: 1, caption: '' });
  vids.scan = [
    { id: 510, date: 1790900000, size: 3000, duration: 8, w: 720, h: 1280, mime: 'video/mp4', text: '频道主转来的' },
    { id: 502, date: 1790812800, size: 25 * MB, duration: 40, w: 1080, h: 1920, mime: 'video/mp4', text: '新文案\n\n📹 抖音 #某人 · 2026-09-01\nhttps://www.douyin.com/video/7600000000000000002' },
    { id: 501, date: 1790812800, size: 4000, duration: 15, w: 1080, h: 1920, mime: 'video/mp4', text: '跳舞的小美\n\n📹 抖音 #小美 · 2026-09-30\nhttps://www.douyin.com/video/7600000000000000001' },
  ];
  // 对的同时（流式服务翻完之后）频道里又发了 520：webhook 登记的这条不能当成删了
  await hook({ channel_post: { message_id: 520, chat: vchat, date: 1790990000, caption: '刚发的', video: { file_id: addFile(bytesOf(10, 5)), file_unique_id: 'V520', mime_type: 'video/mp4', file_size: 10, duration: 2 } } });
  await lib.setConfig('vSyncAt', String(Date.now() - 31 * 60 * 1000));
  const before = vids.scans;
  let j = await jsonOf(await req('/api/videos'));
  assert.equal(vids.scans, before + 1);
  assert.equal(j.syncing, false);
  assert.deepEqual(j.videos.map(v => v.id), [520, 510, 502, 501]);
  assert.deepEqual([j.videos[2].by, j.videos[2].text, j.videos[2].d], ['某人', '新文案', 40]);
  // 501 还沿用 webhook 记下的 Bot API file_id：小文件照样不经过流式服务
  calls.length = 0;
  assert.equal((await req('/vf/501', { headers: { Range: 'bytes=0-1' } })).status, 206);
  assert.ok(!calls.some(c => c.url.includes('/vstream/')));
  // 510 没有 file_id：走流式服务
  vids.big.set(510, bytesOf(3000, 10));
  assert.equal((await req('/vf/510', { headers: { Range: 'bytes=0-9' } })).status, 206);
  assert.ok(calls.some(c => c.url.startsWith(STREAMER + '/vstream/510?')));
  // 半小时内再打开：不再对
  await req('/api/videos');
  assert.equal(vids.scans, before + 1);
  // 管理接口：看一眼、马上对一遍
  assert.equal((await jsonOf(await admin('videos'))).total, 4);
  const r = await jsonOf(await admin('videos', {}));
  assert.deepEqual([r.ok, r.added, r.removed, r.total], [true, 0, 0, 4]);
  // 没翻完（到上限）的时候不删
  vids.scan = vids.scan.slice(0, 1);
  vids.complete = false;
  assert.equal((await jsonOf(await admin('videos', {}))).removed, 0);
  vids.complete = true;
  vids.scan = j.videos.filter(v => v.id !== 520).map(v => ({ id: v.id, date: 1, size: v.id === 502 ? 25 * MB : v.id === 501 ? 4000 : 3000, duration: v.d, w: 0, h: 0, mime: 'video/mp4', text: '' }));
});

await t('刷视频网页：流式服务说视频没了（404 gone）才从视频池去掉；旧版 Space、没连上不算；对不成两分钟后再试', async () => {
  // 旧版 Space 没有 /vstream：404 但不是 gone → 502，网页会重试，视频池不动
  vids.streamMode = 'old';
  let r = await req('/vf/502', { headers: { Range: 'bytes=0-1' } });
  assert.equal(r.status, 502);
  assert.ok(await lib.getVideo(502));
  vids.streamMode = 'down';
  r = await req('/vf/502', { headers: { Range: 'bytes=0-1' } });
  assert.equal(r.status, 503);
  vids.streamMode = 'ok';
  vids.big.delete(502);
  r = await req('/vf/502', { headers: { Range: 'bytes=0-1' } });
  assert.equal(r.status, 404);
  assert.equal(await lib.getVideo(502), null, '频道里删了：从视频池去掉');
  assert.ok(!(await jsonOf(await req('/api/videos'))).videos.some(v => v.id === 502));
  // 封面：确定没有记下来，以后直接 404；旧版 Space 的 404 不算没有（503，过会儿再试）
  vids.thumbs.set(510, null);
  assert.equal((await req('/vp/510')).status, 404);
  vids.thumbs.set(510, JPEG(50));
  assert.equal((await req('/vp/510')).status, 404, '记下了没有封面');
  // 520 帖子里没带缩略图，要请流式服务取：旧版 Space 的 404 不算「没有封面」，过会儿再试
  vids.streamMode = 'old';
  assert.equal((await req('/vp/520')).status, 503);
  vids.streamMode = 'ok';
  vids.thumbs.set(520, JPEG(60));
  assert.equal((await req('/vp/520')).status, 200);
  // 对不成（流式服务在休眠）：两分钟后再试，不是半小时
  vids.scanMode = 'down';
  await lib.setConfig('vSyncAt', '0');
  const n0 = vids.scans;
  const j = await jsonOf(await req('/api/videos'));
  assert.equal(j.videos.length, 3, '视频池照样给');
  assert.match(j.error, /流式服务没连上/, '告诉网页上次没对成');
  const at = Number(await lib.getConfig('vSyncAt'));
  assert.ok(Date.now() - at > 27 * 60 * 1000 && Date.now() - at < 29 * 60 * 1000, '过两分钟就该再对');
  vids.scanMode = 'old';
  await lib.setConfig('vSyncAt', '0');
  await req('/api/videos');
  assert.equal(vids.scans, n0);
  assert.equal((await jsonOf(await req('/api/videos'))).videos.length, 3, '旧版 Space 给不了列表：什么都不删');
  vids.scanMode = 'ok';
  await lib.setConfig('vSyncAt', '0');
  assert.equal((await jsonOf(await req('/api/videos'))).error, '', '对成了：清掉');
});

await t('抖音：频道主发作品链接 → 交给流式服务解析转发；主页链接 → 采集作品链接；正在跑别的说清楚；发视频文件 → 点按钮复制到频道', async () => {
  const share = '2.58 复制打开抖音，看看【丁的作品】特效一用谁都不认  https://v.douyin.com/-Ghr0VeGTpA/ :0pm C@H.iC Uyt:/ 02/20';
  await dm(OWNER, share);
  const d = bot.toStreamer.at(-1);
  assert.deepEqual([d.path, d.body.text, d.body.notify, d.body.target], ['douyin/link', share, OWNER, String(VIDEO_CHANNEL)]);
  assert.match(lastSay().text, /正在解析这条抖音视频/);
  await dm(OWNER, 'https://www.douyin.com/user/MS4wLjABAAAAJObrvSZxXpV8f05lqI-Y8HJyrBORdiOtKImyUldBdng');
  assert.equal(bot.toStreamer.at(-1).path, 'douyin/link');
  assert.match(lastSay().text, /正在采集这个账号的作品链接/);
  bot.copyBusy = true;
  await dm(OWNER, 'https://www.douyin.com/video/7691335977760321704');
  assert.match(lastSay().text, /正在处理上一个链接/);
  bot.copyBusy = false;
  bot.streamerDown = true;
  await dm(OWNER, share);
  assert.match(lastSay().text, /正在唤醒/);
  bot.streamerDown = false;
  // 听众发抖音链接不会触发转发
  const n = bot.toStreamer.filter(x => x.path === 'douyin/link').length;
  await dm(FAN + 2, 'https://v.douyin.com/-Ghr0VeGTpA/');
  assert.equal(bot.toStreamer.filter(x => x.path === 'douyin/link').length, n);
  // 发视频文件：先问，点了才复制到频道，复制完把按钮去掉
  const video = (from, extra) => hook({ update_id: 4, message: { message_id: 77, from: { id: from }, chat: { id: from, type: 'private' }, ...extra } });
  await video(OWNER, { video: { file_id: 'V1', mime_type: 'video/mp4', duration: 12 } });
  assert.deepEqual(lastSay().reply_markup.inline_keyboard, [[{ text: '📤 转到视频频道', callback_data: 'fv:77' }]]);
  assert.ok(!bot.out.some(o => o.method === 'copyMessage'), '没点按钮不发');
  await press(OWNER, 'fv:77');
  const copy = bot.out.filter(o => o.method === 'copyMessage').at(-1);
  assert.deepEqual([String(copy.chat_id), copy.from_chat_id, copy.message_id], [String(VIDEO_CHANNEL), OWNER, 77], '视频进视频频道，不进音乐频道');
  assert.equal(bot.out.filter(o => o.method === 'editMessageText').at(-1).text, '✅ 已转到视频频道');
  await video(OWNER, { document: { file_id: 'D1', mime_type: 'video/quicktime', file_name: 'a.mov' } });
  assert.equal(lastSay().reply_markup.inline_keyboard[0][0].callback_data, 'fv:77');
  bot.copyFail = 'Bad Request: message to copy not found';
  await press(OWNER, 'fv:77');
  assert.match(lastSay().text, /没转成：Bad Request: message to copy not found/);
  bot.copyFail = '';
  const copies = bot.out.filter(o => o.method === 'copyMessage').length;
  await press(FAN, 'fv:77'); // 别人按没用
  await video(FAN, { video: { file_id: 'V2', mime_type: 'video/mp4' } }); // 听众发视频不问
  assert.equal(bot.out.filter(o => o.method === 'copyMessage').length, copies);
  assert.match(lastSay().text, /只有频道主能用/);
});

await t('转抖音视频：只转频道主自己的抖音账号（管理接口设），转到视频频道；没设账号时说清楚', async () => {
  await dm(OWNER, '转抖音视频');
  assert.equal(lastSay().text, '还没设置你自己的抖音账号');
  assert.equal((await admin('douyin-self', { sec_uid: 'not-a-sec-uid' })).status, 400);
  assert.equal((await admin('douyin-self', { sec_uid: 'x' }, 'wrong-key')).status, 401);
  const sec = 'MS4wLjABAAAAJObrvSZxXpV8f05lqI-Y8HJyrBORdiOtKImyUldBdng';
  assert.deepEqual(await jsonOf(await admin('douyin-self', { sec_uid: sec })), { sec_uids: [sec] });
  assert.deepEqual(await jsonOf(await admin('douyin-self')), { sec_uids: [sec] });
  await dm(OWNER, '转抖音视频');
  const r = bot.toStreamer.at(-1);
  assert.deepEqual([r.path, r.body.sec_uids, r.body.target, r.body.notify], ['douyin/mirror', [sec], String(VIDEO_CHANNEL), OWNER]);
  // 加小号：发主页链接
  await dm(OWNER, '添加抖音账号 https://www.douyin.com/user/SmallAccount1234567');
  assert.match(lastSay().text, /加好了，现在有 2 个抖音账号/);
  await dm(OWNER, '添加抖音账号 https://www.douyin.com/user/SmallAccount1234567');
  assert.match(lastSay().text, /已经在里面了/);
  await dm(OWNER, '添加抖音账号 https://www.douyin.com/video/123456789');
  assert.match(lastSay().text, /这是作品链接/);
  await dm(OWNER, '转抖音视频');
  assert.deepEqual(bot.toStreamer.at(-1).body.sec_uids, [sec, 'MS4wLjABAAAASmallAccount1234567']);
  await admin('douyin-self', { sec_uids: [sec] });
  assert.match(lastSay().text, /正在把你抖音上能看到的作品（视频和图文）转到视频频道/);
  const n = bot.toStreamer.length;
  await dm(FAN + 3, '转抖音视频'); // 听众发这个只当求歌
  assert.ok(bot.toStreamer.slice(n).every(x => x.path !== 'douyin/mirror'));
});

await t('登录抖音、抖音自动同步：定时任务只在开了时转，带 quiet', async () => {
  await dm(OWNER, '登录抖音');
  assert.match(lastSay().text, /\/douyin-login#[0-9a-f]{36}/);
  const tok = lastSay().text.match(/#([0-9a-f]{36})/)[1];
  assert.equal((await req('/dl/' + 'f'.repeat(36) + '/status')).status, 403);
  assert.equal((await req('/douyin-login')).status, 200);
  assert.ok(tok);
  await lib.resumeClear(); // 前面的用例留下的「没转完」记录：这里只看自动同步
  const n = bot.toStreamer.length;
  await worker.scheduled({ cron: '*/30 * * * *' }, env, { waitUntil: p => p });
  await new Promise(r => setTimeout(r, 20));
  assert.equal(bot.toStreamer.length, n, '没开自动同步不转');
  await dm(OWNER, '抖音自动同步 开');
  assert.match(lastSay().text, /自动同步开了/);
  let done;
  await worker.scheduled({ cron: '*/30 * * * *' }, env, { waitUntil: p => { done = p; } });
  await done;
  const r = bot.toStreamer.at(-1);
  assert.deepEqual([r.path, r.body.target, r.body.quiet, r.body.notify], ['douyin/mirror', String(VIDEO_CHANNEL), true, OWNER]);
  await dm(OWNER, '抖音自动同步 关');
  assert.equal(await lib.getConfig('douyinAuto'), '0');
});

await t('账号标签：视频频道按账号分类，默认用抖音昵称、可以改名；频道里置顶目录跟着改；转作品时把名字带给流式服务', async () => {
  const sec = 'MS4wLjABAAAAJObrvSZxXpV8f05lqI-Y8HJyrBORdiOtKImyUldBdng', alt = 'MS4wLjABAAAASmallAccount1234567';
  await admin('douyin-self', { sec_uids: [sec, alt] });
  bot.dyStatus = { status: 'done', tags_used: { [sec]: '丁', [alt]: '冰美人' } };
  await dm(OWNER, '账号标签');
  assert.match(lastSay().text, /1\. #丁（抖音昵称）\n2\. #冰美人（抖音昵称）/);
  const dir = bot.out.filter(o => o.method === 'sendMessage' && String(o.chat_id) === String(VIDEO_CHANNEL)).at(-1);
  assert.match(dir.text, /📂 目录[\s\S]*1\. #丁\n2\. #冰美人/);
  const pin = bot.out.filter(o => o.method === 'pinChatMessage').at(-1);
  assert.equal(String(pin.chat_id), String(VIDEO_CHANNEL));
  const dirId = pin.message_id;
  await dm(OWNER, '账号标签 2 小美💍');
  assert.match(lastSay().text, /第 2 个账号的标签改成 #小美/);
  const ed = bot.out.filter(o => o.method === 'editMessageText' && String(o.chat_id) === String(VIDEO_CHANNEL)).at(-1);
  assert.equal(ed.message_id, dirId);
  assert.match(ed.text, /1\. #丁\n2\. #小美/);
  bot.editGone = true;  // 目录被删了：发一条新的置顶
  await dm(OWNER, '账号标签 1 主号');
  bot.editGone = false;
  assert.notEqual(bot.out.filter(o => o.method === 'pinChatMessage').at(-1).message_id, dirId);
  assert.match(bot.out.filter(o => o.method === 'sendMessage' && String(o.chat_id) === String(VIDEO_CHANNEL)).at(-1).text, /1\. #主号\n2\. #小美/);
  await dm(OWNER, '账号标签 9 x');
  assert.match(lastSay().text, /没有第 9 个账号/);
  await dm(OWNER, '账号标签 1 💍');
  assert.match(lastSay().text, /要有文字或数字/);
  await dm(OWNER, '转抖音视频');
  assert.deepEqual(bot.toStreamer.filter(x => x.path === 'douyin/mirror').at(-1).body.tags, { [alt]: '小美', [sec]: '主号' });
  bot.dyStatus = null;
  await admin('douyin-self', { sec_uids: [sec] });
});

await t('搜抖音：关键词排队给云电脑；搜索结果按点赞排私聊发频道主；搜完完整清单交给审核机器人，频道主在那里审核通过才转（暂停、不通过、超时都不转）', async () => {
  await dm(OWNER, '搜抖音 舞蹈');
  assert.match(lastSay().text, /记下了「舞蹈」[\s\S]*云电脑现在没连上：打开云电脑就会自动做/);
  assert.match(lastSay().text, /搜 100 条/);
  await dm(OWNER, '搜抖音 街舞 300');
  assert.match(lastSay().text, /记下了「街舞」，搜 300 条（一共 2 个词等着搜：舞蹈、街舞）/);
  await dm(OWNER, '搜抖音');
  assert.match(lastSay().text, /舞蹈、街舞/);
  const n = bot.toStreamer.length;
  await dm(FAN + 5, '搜抖音 舞蹈');  // 听众：不排队
  assert.deepEqual(JSON.parse(await lib.getConfig('dySearchQueue')), ['舞蹈', '街舞']);
  await dm(OWNER, '云电脑');  // 生成云电脑的上传令牌
  const tok = await lib.getConfig('cloudTok');
  const cfg = await jsonOf(await req('/dy-cloud-config', { method: 'POST', headers: { 'X-Token': tok } }));
  assert.deepEqual(cfg.searches, ['舞蹈', '街舞']);
  assert.equal(cfg.search_max, 300, '排队的词里要得最多的');
  const rows = [
    { aweme_id: '7600000000000000001', desc: '低赞', liked_count: '12', source_keyword: '舞蹈', nickname: '甲*', xiaoju_nickname: '甲甲' },
    { aweme_id: '7600000000000000002', desc: '高赞 舞蹈', liked_count: '123456', source_keyword: '舞蹈', nickname: '乙' },
    { aweme_id: '7600000000000000002', desc: '重复', liked_count: '1', source_keyword: '舞蹈' },
    { aweme_id: '7600000000000000003', desc: '图文', liked_count: '5', source_keyword: '舞蹈', aweme_type: '68', note_download_url: 'https://p/1.jpg' },
    { aweme_id: '7600000000000000004', desc: '我自己的', liked_count: '3', source_keyword: '舞蹈', video_download_url: 'https://v/mine.mp4',
      xiaoju_sec_uid: 'MS4wLjABAAAAJObrvSZxXpV8f05lqI-Y8HJyrBORdiOtKImyUldBdng' },
  ].map(r => JSON.stringify(r)).join('\n') + '\nnot json\n';
  const post = (t2, body) => req('/dy-search', { method: 'POST', headers: { 'X-Token': t2 }, body });
  assert.equal((await post('wrong', rows)).status, 403);
  assert.deepEqual(await jsonOf(await post(tok, rows)), { ok: true, keywords: ['舞蹈'], total: 4 });
  const owned = bot.out.filter(o => o.method === 'sendMessage' && o.chat_id === OWNER);
  // 搜完整份清单交给审核机器人；还没接上审核机器人 → 暂停，一条不转（不默认通过）
  assert.match(owned.at(-1).text, /⏸ 「舞蹈」的清单没送到 @xiaojuverify_bot：还没接上审核机器人[\s\S]*一条也不转/);
  const rvs = owned.at(-1).reply_markup.inline_keyboard.flat()[0].callback_data;
  assert.match(rvs, /^rvs:/);
  const taskId = rvs.slice(4);
  assert.equal(JSON.parse(await lib.getConfig('rv:' + taskId)).status, 'paused');
  assert.match(owned.at(-2).text, /✅ 「舞蹈」搜完了，一共 4 条/);
  const msg = owned.at(-3);
  // 每条都附文件地址；登记过的号标 👤；小橘的清单不带转发按钮
  assert.match(msg.text, /4\. 📹 我自己的 ❤3 👤你的号\nhttps:\/\/www\.douyin\.com\/video\/7600000000000000004\n⬇️ 文件（几个小时内有效）：\nhttps:\/\/v\/mine\.mp4/);
  assert.match(msg.text, /3\. 🖼 图文 ❤5\nhttps:\/\/www\.douyin\.com\/note\/7600000000000000003\n⬇️ 文件（几个小时内有效）：\nhttps:\/\/p\/1\.jpg/, '每条都附文件地址');
  assert.match(msg.text, /抖音搜「舞蹈」：边搜边发[\s\S]*1\. 📹 高赞 舞蹈 — @乙 ❤12万\nhttps:\/\/www\.douyin\.com\/video\/7600000000000000002[\s\S]*2\. 📹 低赞 — @甲甲 ❤12\n[\s\S]*3\. 🖼 图文 ❤5\nhttps:\/\/www\.douyin\.com\/note\/7600000000000000003/);
  assert.equal(msg.reply_markup, undefined, '小橘的清单上没有转发按钮');
  assert.deepEqual(JSON.parse(await lib.getConfig('dySearchQueue')), ['街舞'], '搜过的词出队');
  assert.equal(bot.toStreamer.slice(n).filter(x => x.path === 'douyin/import').length, 0, '登记过的号也不跳过审核');
  const press = (from, data, message_id = 77) => hook({ update_id: 900, callback_query: { id: 'cq' + data, from: { id: from }, data,
    message: { message_id, chat: { id: from, type: 'private' } } } });
  const lastAck = () => bot.out.filter(o => o.method === 'answerCallbackQuery').at(-1).text;
  // 旧清单上的「📤 转 N」「一键转」「全部转」按钮都不能绕过审核
  for (const old of ['dys:7600000000000000004', 'dya:abc', 'dyq:yes']) {
    await press(OWNER, old);
    assert.match(lastAck(), /要先在 @xiaojuverify_bot 审核通过才转/);
  }
  assert.equal(bot.toStreamer.slice(n).filter(x => x.path === 'douyin/import').length, 0);
  assert.equal((await post(tok, 'nothing')).status, 400);

  // 接上审核机器人：令牌发给小橘 → 认令牌、给审核机器人设 webhook（独立 secret），令牌那条消息删掉
  await dm(FAN + 5, '审核机器人 ' + VTOKEN);
  assert.equal(await lib.getConfig('verifyTok'), null, '听众不能接');
  // 连 BotFather 的整段说明一起粘过来也认
  await dm(OWNER, '审核机器人Here is the token for bot verify @xiaojuverify_bot:\n\n' + VTOKEN + '\n\nKeep your token secure');
  assert.equal(await lib.getConfig('verifyTok'), VTOKEN);
  const wh = bot.vout.find(o => o.method === 'setWebhook');
  assert.equal(wh.url, BASE + '/verify-webhook');
  const VSECRET = await lib.getConfig('verifySecret');
  assert.ok(VSECRET.length >= 32 && wh.secret_token === VSECRET && VSECRET !== HOOK);
  assert.ok(bot.out.some(o => o.method === 'deleteMessage' && o.chat_id === OWNER), '令牌那条删掉');
  assert.match(lastSay().text, /接上了 @xiaojuverify_bot[\s\S]*点一下「开始」/);
  // 频道主还没在审核机器人里点「开始」：重新送审还是送不到 → 仍然暂停
  await press(OWNER, rvs);
  assert.match(lastAck(), /还是没送到：审核机器人还不能给你发消息/);
  assert.equal(JSON.parse(await lib.getConfig('rv:' + taskId)).status, 'paused');

  // 审核机器人的 webhook：secret 不对 403；频道主点「开始」→ 补发暂停的审核单（完整清单 + 审核按钮）
  const vhook = (update, secret = VSECRET) => req('/verify-webhook', {
    method: 'POST', headers: { 'Content-Type': 'application/json', 'X-Telegram-Bot-Api-Secret-Token': secret }, body: JSON.stringify(update),
  });
  assert.equal((await vhook({ update_id: 1 }, HOOK)).status, 403, '小橘的 secret 进不了审核机器人');
  assert.equal((await hook({ update_id: 1 }, VSECRET)).status, 403, '审核机器人的 secret 进不了小橘');
  bot.vStarted = true;
  const v0 = bot.vout.length;
  await vhook({ update_id: 2, message: { message_id: 1, from: { id: FAN + 5 }, chat: { id: FAN + 5, type: 'private' }, text: '/start' } });
  assert.match(bot.vout.at(-1).text, /私人审核机器人/);
  assert.equal(JSON.parse(await lib.getConfig('rv:' + taskId)).status, 'paused', '别人点开始不补发');
  await vhook({ update_id: 3, message: { message_id: 2, from: { id: OWNER }, chat: { id: OWNER, type: 'private' }, text: '/start' } });
  const vsent = bot.vout.slice(v0).filter(o => o.method === 'sendMessage' && o.chat_id === OWNER);
  const full = vsent.map(o => o.text).join('\n');
  assert.match(full, new RegExp(`🛂 审核单 ${taskId}\\n来源：小橘视频机器人 · 抖音搜索「舞蹈」\\n一共 4 条，来自 4 个账号`));
  // 完整清单：每条有作品 ID、链接、来源账号、文件地址
  assert.match(full, /📹 我自己的\n   账号：👤@（没名字）\n   作品 ID：7600000000000000004\n   链接：https:\/\/www\.douyin\.com\/video\/7600000000000000004\n   文件：https:\/\/v\/mine\.mp4/);
  assert.match(full, /sec_uid: MS4wLjABAAAAJObrvSZxXpV8f05lqI-Y8HJyrBORdiOtKImyUldBdng/);
  for (const id of ['7600000000000000001', '7600000000000000002', '7600000000000000003', '7600000000000000004']) assert.ok(full.includes('作品 ID：' + id));
  const dec = vsent.find(o => o.reply_markup && o.reply_markup.inline_keyboard.length);
  assert.deepEqual(dec.reply_markup.inline_keyboard.flat().map(b => b.callback_data), [`v:ok:${taskId}`, `v:no:${taskId}`]);
  assert.match(bot.vout.at(-1).text, /补发了 1 张之前没送到的审核单/);
  assert.equal(JSON.parse(await lib.getConfig('rv:' + taskId)).status, 'pending');
  const vpress = (from, data, message_id = 5001) => vhook({ update_id: 4, callback_query: { id: 'v' + data, from: { id: from }, data, message: { message_id, chat: { id: from, type: 'private' } } } });
  const vAck = () => bot.vout.filter(o => o.method === 'answerCallbackQuery').at(-1).text;
  await vpress(FAN + 5, `v:ok:${taskId}`);
  assert.match(vAck(), /只有频道主能审核/);
  assert.equal(JSON.parse(await lib.getConfig('rv:' + taskId)).status, 'pending');
  // 不通过：一条不转，小橘那边说一声
  const before = bot.toStreamer.length;
  await vpress(OWNER, `v:no:${taskId}`);
  assert.equal(JSON.parse(await lib.getConfig('rv:' + taskId)).status, 'rejected');
  assert.equal(bot.toStreamer.slice(before).filter(x => x.path === 'douyin/import').length, 0, '不通过：一条不转');
  assert.match(lastSay().text, new RegExp(`❌ 审核单 ${taskId}（「舞蹈」4 条）没通过，一条不转`));
  await vpress(OWNER, `v:ok:${taskId}`);
  assert.match(vAck(), /审核没通过/, '审过的不能再改');
  await press(OWNER, `rvt:${taskId}`);
  assert.match(lastAck(), /没通过审核，不能转/);
  assert.equal(bot.toStreamer.slice(before).filter(x => x.path === 'douyin/import').length, 0);

  // 再搜一次：审核机器人已经能发了 → 直接送审（pending）；通过 → 小橘按审核时那份数据转，并登记这些号
  const A = 'MS4wLjABAAAAOtherAuthor000001', sec4 = 'MS4wLjABAAAAJObrvSZxXpV8f05lqI-Y8HJyrBORdiOtKImyUldBdng';
  const rowA = (id, sec, name) => JSON.stringify({ aweme_id: id, desc: 'x', liked_count: '1', source_keyword: '审批', xiaoju_sec_uid: sec, xiaoju_nickname: name });
  await post(tok, [rowA('7600000000000000021', A, '安66'), rowA('7600000000000000022', A, '安66'), rowA('7600000000000000023', sec4, '丁')].join('\n'));
  const sub = lastSay().text.match(/已经交给 @xiaojuverify_bot，审核单 (\w+)/);
  assert.ok(sub, lastSay().text);
  const t2 = sub[1];
  assert.equal(JSON.parse(await lib.getConfig('rv:' + t2)).status, 'pending');
  assert.equal(bot.toStreamer.slice(before).filter(x => x.path === 'douyin/import').length, 0, '没审核不转');
  assert.match(bot.vout.filter(o => o.method === 'sendMessage').map(o => o.text).join('\n'), /一共 3 条，来自 2 个账号[\s\S]*1\. 👤@丁（1 条）[\s\S]*2\. @安66（2 条）/);
  await vpress(OWNER, `v:ok:${t2}`);
  const task2 = JSON.parse(await lib.getConfig('rv:' + t2));
  assert.deepEqual([task2.status, task2.decidedBy, task2.transfer], ['approved', OWNER, 'started']);
  const go = bot.toStreamer.slice(before).filter(x => x.path === 'douyin/import');
  assert.equal(go.length, 1);
  assert.deepEqual(go[0].body.text.split('\n').map(l => JSON.parse(l).aweme_id), ['7600000000000000021', '7600000000000000022', '7600000000000000023']);
  assert.ok(!(await lib.getConfig('douyinSelf')).includes(A), '审核通过只转这一批，不登记账号');
  assert.match(lastSay().text, new RegExp(`✅ 审核单 ${t2}（「审批」3 条）审核通过，开始转 3 条（只转这一批，不登记账号）`));
  assert.ok(bot.vout.some(o => o.method === 'editMessageText' && /✅ 审核通过/.test(o.text)), '审核机器人那条改成结果');
  await vpress(OWNER, `v:ok:${t2}`);
  assert.match(vAck(), /审核通过/);
  assert.equal(bot.toStreamer.slice(before).filter(x => x.path === 'douyin/import').length, 1, '点两次不转两次');

  // 通过了但转发服务出错：不丢，给「再试转发」按钮
  await post(tok, [rowA('7600000000000000041', A, '安66')].join('\n'));
  const t3 = lastSay().text.match(/审核单 (\w+)/)[1];
  bot.streamerDown = true;
  await vpress(OWNER, `v:ok:${t3}`);
  bot.streamerDown = false;
  assert.match(lastSay().text, /审核通过了，但还没转：小橘的服务正在唤醒/);
  assert.equal(lastSay().reply_markup.inline_keyboard[0][0].callback_data, `rvt:${t3}`);
  await press(OWNER, `rvt:${t3}`);
  assert.equal(JSON.parse(await lib.getConfig('rv:' + t3)).transfer, 'started');
  assert.equal(bot.toStreamer.slice(before).filter(x => x.path === 'douyin/import').length, 2);

  // 超时：24 小时没审 → expired，一条不转
  await post(tok, [rowA('7600000000000000051', A, '安66')].join('\n'));
  const t4 = lastSay().text.match(/审核单 (\w+)/)[1];
  const task4 = JSON.parse(await lib.getConfig('rv:' + t4));
  await lib.setConfig('rv:' + t4, JSON.stringify({ ...task4, expiresAt: Date.now() - 1 }));
  let jobs = [];
  await worker.scheduled({ cron: '*/30 * * * *' }, env, { waitUntil: p => jobs.push(p) });
  await Promise.all(jobs);
  assert.equal(JSON.parse(await lib.getConfig('rv:' + t4)).status, 'expired');
  assert.ok(bot.out.some(o => o.method === 'sendMessage' && new RegExp(`⌛ 审核单 ${t4}`).test(o.text)));
  await vpress(OWNER, `v:ok:${t4}`);
  assert.match(vAck(), /超时/);
  assert.equal(bot.toStreamer.slice(before).filter(x => x.path === 'douyin/import').length, 2, '超时不转');
  // 「审核」：看接好没有、哪些在等
  await dm(OWNER, '审核');
  assert.match(lastSay().text, /🛂 审核机器人：@xiaojuverify_bot[\s\S]*现在没有等审核的/);
  await admin('douyin-self', { sec_uids: [sec4] });
  // 边抓边发：一批一批送（X-Final: 0），编号接着排，重复的不再发；最后送「搜完了」
  const batch = (body, fin) => req('/dy-search', { method: 'POST', headers: { 'X-Token': tok, 'X-Final': fin }, body });
  const row = (id, likes) => JSON.stringify({ aweme_id: id, desc: '街舞' + id.slice(-1), liked_count: String(likes), source_keyword: '街舞' });
  const n1 = bot.out.length;
  await batch([row('7600000000000000011', 5), row('7600000000000000012', 50)].join('\n'), '0');
  assert.match(lastSay().text, /抖音搜「街舞」：边搜边发[\s\S]*1\. 📹 街舞2 ❤50[\s\S]*2\. 📹 街舞1 ❤5/);
  assert.equal(lastSay().reply_markup, undefined);
  await batch([row('7600000000000000012', 50), row('7600000000000000013', 9)].join('\n'), '0');
  assert.match(lastSay().text, /「街舞」接着来：第 3–3 条\n\n3\. 📹 街舞3 ❤9/);
  assert.deepEqual(JSON.parse(await lib.getConfig('dySearchQueue')), ['街舞'], '没搜完不出队');
  assert.equal((await batch('', '1')).status, 200);
  assert.match(bot.out.filter(o => o.method === 'sendMessage').at(-2).text, /✅ 「街舞」搜完了，一共 3 条/);
  assert.match(lastSay().text, /🛂 「街舞」的完整清单（3 条）已经交给 @xiaojuverify_bot/);
  assert.deepEqual(JSON.parse(await lib.getConfig('dySearchQueue')), []);
  assert.equal(bot.out.slice(n1).filter(o => o.method === 'sendMessage').length, 4);
  await dm(OWNER, '搜抖音 清空');
  assert.deepEqual(JSON.parse(await lib.getConfig('dySearchQueue')), []);
  // 管理接口也能看、能清
  await dm(OWNER, '搜抖音 测试词 50');
  assert.deepEqual(await jsonOf(await admin('douyin-search-queue')), { queue: ['测试词'], counts: { '测试词': 50 } });
  assert.equal((await admin('douyin-search-queue', {})).status, 400);
  assert.equal((await admin('douyin-search-queue', undefined, 'wrong')).status, 401);
  assert.deepEqual(await jsonOf(await admin('douyin-search-queue', { clear: true })), { queue: [], counts: {} });
});

await t('进度：云电脑每 30 秒报进度；频道主发「进度」看每个号抓了多少、小橘转了多少；点按钮停', async () => {
  bot.lastRun = null; // 流式服务刚启动，什么都没在转
  await dm(OWNER, '进度');
  assert.match(lastSay().text, /云电脑：还没报过进度[\s\S]*小橘：现在没在转/);
  await dm(OWNER, '云电脑');
  const tok = await lib.getConfig('cloudTok');
  const sec = 'MS4wLjABAAAAJObrvSZxXpV8f05lqI-Y8HJyrBORdiOtKImyUldBdng';
  const rep = (body, t2 = tok) => req('/dy-progress', { method: 'POST', headers: { 'X-Token': t2, 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
  assert.equal((await rep({ phase: 'running' }, 'wrong')).status, 403);
  // 只抓新的：云电脑开抓前要一份频道里已有的作品号
  const known = t2 => req('/dy-known', { method: 'POST', headers: { 'X-Token': t2 } });
  assert.deepEqual(await jsonOf(await known(tok)), { ids: ['7600000000000000001', '7600000000000000002'] });
  assert.equal((await known('wrong')).status, 403);
  const p = { phase: 'running', mode: 'crawl', sent: 40, got: 52, accounts: [{ sec_uid: sec, name: '丁', total: 300, got: 52 }, { sec_uid: 'S2', name: '冰美人💍', total: null, got: 0 }] };
  assert.deepEqual(await jsonOf(await rep(p)), { ok: true, stop: false });
  bot.dyStatus = { status: 'running', mode: 'import', total: 40, posted: [{}, {}], skipped: [{}], failed: [] };
  await dm(OWNER, '进度');
  const msg = lastSay();
  assert.match(msg.text, /云电脑（抓自己的号）：正在抓（\d+ 秒前）\n1\. #[^：]+：这次抓了 52 \/ 共 300\n2\. #冰美人：还没轮到\n这次一共抓了 52 条，送给小橘 40 条/);
  assert.match(msg.text, /小橘（转云电脑送来的作品）：进行中\n新转进频道 2 条，已有跳过 1 条，失败 0 条\n收到 40 条，还有 37 条排着队/);
  assert.deepEqual(msg.reply_markup.inline_keyboard.flat().map(b => b.callback_data), ['prg:run', 'prg:r', 'prg:cloud', 'prg:post']);
  const press = async data => hook({ update_id: 901, callback_query: { id: 'cq' + data, from: { id: OWNER }, data, message: { message_id: 78, chat: { id: OWNER, type: 'private' } } } });
  await press('prg:cloud');
  assert.equal(await lib.getConfig('dyStop'), '1');
  assert.deepEqual(await jsonOf(await rep(p)), { ok: true, stop: true }, '云电脑下次报进度就收到停');
  assert.match(bot.out.filter(o => o.method === 'editMessageText').at(-1).text, /已经叫它停了/);
  await rep({ ...p, phase: 'stopped' });
  assert.equal(await lib.getConfig('dyStop'), '0', '停下以后清掉，下次打开照常抓');
  await press('prg:post');
  assert.ok(bot.toStreamer.some(x => x.path === 'douyin/stop'));
  assert.match(bot.out.filter(o => o.method === 'answerCallbackQuery').at(-1).text, /小橘停了/);
  await rep({ phase: 'running', mode: 'search', keywords: ['舞蹈'], per: { 舞蹈: 7 }, got: 7, sent: 0 });
  await dm(OWNER, '进度');
  assert.match(lastSay().text, /云电脑（搜索）：正在抓[\s\S]*「舞蹈」搜到 7 条/);
  bot.dyStatus = { status: 'idle', worker_link: { ok_at: 0, fail_at: Math.floor(Date.now() / 1000) - 120, fails: 3, error: 'SSLEOFError: EOF', path: '/streamer-done' } };
  await dm(OWNER, '进度');
  assert.match(lastSay().text, /⚠️ 小橘的服务上次通知这边没成功（2 分钟前，连续 3 次：SSLEOFError: EOF），已经自动重试/);
  bot.dyStatus = null;
});

await t('发 MediaCrawler 导出的文件：取下来交给流式服务转进视频频道', async () => {
  const fid = addFile(new TextEncoder().encode('{"aweme_id": "1", "desc": "x"}\n'));
  await hook({ update_id: 5, message: { message_id: 88, from: { id: OWNER }, chat: { id: OWNER, type: 'private' },
    document: { file_id: fid, file_name: 'creator_contents_2026-10-03.jsonl', mime_type: 'application/octet-stream', file_size: 30 } } });
  const r = bot.toStreamer.at(-1);
  assert.deepEqual([r.path, r.body.target, r.body.notify], ['douyin/import', String(VIDEO_CHANNEL), OWNER]);
  assert.match(r.body.text, /aweme_id/);
  assert.match(lastSay().text, /文件里有 2 条作品（视频 1、图文 1）/);
});

await t('云电脑：发 Codespaces 链接和抓取命令（带令牌和自己的账号）；云电脑带令牌上传文件 → 转进视频频道', async () => {
  const sec = 'MS4wLjABAAAAJObrvSZxXpV8f05lqI-Y8HJyrBORdiOtKImyUldBdng';
  await admin('douyin-self', { sec_uids: [sec] });
  await dm(OWNER, '云电脑');
  const says = bot.out.filter(o => o.method === 'sendMessage');
  assert.match(says.at(-2).text, /codespaces\.new\/langhua98\/Linggo\?devcontainer_path=\.devcontainer%2Fdouyin%2Fdevcontainer\.json/);
  const cmd = lastSay().text;
  const m = cmd.match(/^bash xiaoju-video\/cloud\/codespace-auto\.sh ([0-9a-f]{48}) (\S+)$/);
  assert.ok(m, cmd);
  assert.equal(m[2], sec);
  await dm(OWNER, '云电脑');
  assert.equal(lastSay().text, cmd, '令牌不变');
  const up = (tok, body) => req('/dy-import', { method: 'POST', headers: { 'X-Token': tok }, body });
  assert.equal((await up('wrong', '{"aweme_id": "1"}')).status, 403);
  const r = await up(m[1], '{"aweme_id": "1", "desc": "x"}\n');
  assert.deepEqual(await jsonOf(r), { ok: true, total: 2, video: 1, images: 1, added: 2, started: true });
  assert.equal(bot.toStreamer.at(-1).body.final, true, '不带 X-Final 当一次送完');
  const s2 = bot.toStreamer.at(-1);
  assert.deepEqual([s2.path, s2.body.target, s2.body.notify], ['douyin/import', String(VIDEO_CHANNEL), OWNER]);
  assert.match(lastSay().text, /云电脑发来 2 条作品/);
  assert.equal((await up(m[1], 'nothing here')).status, 400);
  // 边抓边转：第一批告诉频道主开始了，后面的批次不再刷屏；最后送一个空的「抓完了」
  const batch = (body, fin) => req('/dy-import', { method: 'POST', headers: { 'X-Token': m[1], 'X-Final': fin }, body });
  const n0 = bot.out.filter(o => o.method === 'sendMessage').length;
  assert.equal((await jsonOf(await batch('{"aweme_id": "2"}\n', '0'))).started, true);
  assert.equal(bot.toStreamer.at(-1).body.final, false);
  assert.match(lastSay().text, /边抓边转/);
  assert.equal((await jsonOf(await batch('{"aweme_id": "3"}\n', '0'))).started, false);
  assert.equal((await batch('', '1')).status, 200);
  assert.equal(bot.toStreamer.at(-1).body.final, true);
  assert.equal(bot.out.filter(o => o.method === 'sendMessage').length, n0 + 1, '只在开始时说一次');
  bot.importing = false;
  await dm(FAN + 4, '云电脑');
  assert.ok(!/codespace-auto\.sh/.test(lastSay().text), '听众拿不到命令');
  // 云电脑拿 Codespaces 自带的 GitHub 令牌领口令：只认仓库主人
  const cfg = gh => req('/dy-cloud-config', { method: 'POST', headers: gh ? { Authorization: 'token ' + gh } : {} });
  assert.deepEqual(await jsonOf(await cfg('gh-owner')), { token: m[1], creators: sec, searches: [], search_max: 100 });
  assert.equal((await cfg('gh-other')).status, 403);
  assert.equal((await cfg('bad')).status, 403);
  assert.equal((await cfg('')).status, 401);
  // 云电脑带上传令牌拿最新账号名单
  const byTok = t => req('/dy-cloud-config', { method: 'POST', headers: { 'X-Token': t } });
  assert.deepEqual(await jsonOf(await byTok(m[1])), { token: m[1], creators: sec, searches: [], search_max: 100, crawl: false }, '开机不自己抓');
  assert.equal((await byTok('wrong')).status, 403);
  // 运行爬虫：点了才抓。云电脑开着（刚来问过）→ 说半分钟内开始；下一次来问就拿到 crawl: true；开抓报 starting 后清掉
  await dm(OWNER, '▶️ 运行爬虫');
  assert.match(lastSay().text, /云电脑开着，半分钟内开始抓/);
  assert.equal((await jsonOf(await byTok(m[1]))).crawl, true);
  const rep = body => req('/dy-progress', { method: 'POST', headers: { 'X-Token': m[1], 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
  await rep({ phase: 'starting', mode: 'crawl' });
  assert.equal((await jsonOf(await byTok(m[1]))).crawl, false, '开抓了就不再叫它抓');
  await dm(OWNER, '运行爬虫');
  assert.match(lastSay().text, /正在抓，不用再点/);
  await rep({ phase: 'done', mode: 'crawl' });
  // 云电脑好久没来问 → 记下来，等它打开再抓；点「停止云电脑抓取」连没开始的这次也取消
  await lib.setConfig('dyCloudSeen', String(Date.now() - 10 * 60 * 1000));
  await dm(OWNER, '/crawl');
  assert.match(lastSay().text, /云电脑现在没开[\s\S]*codespaces\.new/);
  await hook({ update_id: 902, callback_query: { id: 'cqx', from: { id: OWNER }, data: 'prg:cloud', message: { message_id: 79, chat: { id: OWNER, type: 'private' } } } });
  assert.equal((await jsonOf(await byTok(m[1]))).crawl, false);
  await lib.setConfig('dyStop', '0');
  // 听众发「运行爬虫」不管用
  await dm(FAN + 4, '运行爬虫');
  assert.notEqual(await lib.getConfig('dyCrawlReq'), '1');
  assert.equal((await byTok('wrong')).status, 403);
});

await t('审核清单：账号多、文件地址长也按 Telegram 上限分段，一个字不丢', async () => {
  const { reviewMessages } = await import('./verify.js');
  const sec = i => 'MS4wLjABAAAA' + String(i).padStart(64, 'x');
  const items = Array.from({ length: 45 }, (_, i) => ({
    id: String(7400000000000000000n + BigInt(i)), note: i % 3 === 0, sec: sec(i), mine: false,
    account: '菊花裤的朋友' + i + '号'.repeat(18), link: 'https://www.douyin.com/video/' + i,
    title: '文案'.repeat(20), files: ['https://v26-web.douyinvod.com/' + 'a'.repeat(i === 7 ? 9000 : 600)],
  }));
  const msgs = reviewMessages({ id: 'T1', keywords: ['菊花裤'], items });
  for (const m of msgs) assert.ok(m.length <= 4096, '超长：' + m.length);
  const all = msgs.join('');
  for (let i = 0; i < 45; i++) { assert.ok(all.includes(sec(i))); assert.ok(all.includes(items[i].id)); }
  assert.ok(all.replace(/\n/g, '').includes('a'.repeat(9000)), '超长的文件地址切开了也要完整');
  assert.match(msgs[0], /🛂 审核单 T1[\s\S]*一共 45 条，来自 45 个账号/);
});

await t('搜抖音：云电脑连着就说半分钟内开始；结果里标的词和排队的写法对不上也出队，不会一直重搜', async () => {
  const tok = await lib.getConfig('cloudTok');
  const cfg = () => req('/dy-cloud-config', { method: 'POST', headers: { 'X-Token': tok } });
  await dm(OWNER, '搜抖音 #lululemon #define');
  await cfg();  // 云电脑来问过
  await dm(OWNER, '搜抖音');
  assert.match(lastSay().text, /等云电脑去搜的词：.*#lululemon #define[\s\S]*云电脑连着（\d+ 秒前来问过）/);
  assert.deepEqual((await jsonOf(await cfg())).searches.slice(-1), ['#lululemon #define']);
  await req('/dy-progress', { method: 'POST', headers: { 'X-Token': tok, 'Content-Type': 'application/json' },
    body: JSON.stringify({ phase: 'running', mode: 'search', keywords: ['#lululemon #define'], per: {}, got: 1, sent: 0 }) });
  const r = await req('/dy-search', { method: 'POST', headers: { 'X-Token': tok, 'X-Final': '1' },
    body: JSON.stringify({ aweme_id: '7600000000000009999', desc: 'x', source_keyword: 'lululemon define' }) + '\n' });
  assert.equal(r.status, 200);
  assert.ok(!(await jsonOf(await cfg())).searches.includes('#lululemon #define'), '搜完出队');
  await req('/dy-progress', { method: 'POST', headers: { 'X-Token': tok, 'Content-Type': 'application/json' }, body: JSON.stringify({ phase: 'done', mode: 'search' }) });
});

await t('云电脑在线状态：守候脚本在抓、在搜、上次没搜成时照样每 20 秒来问（X-Busy），机器人如实说；旧脚本抓的时候只报进度也算连着', async () => {
  const tok = await lib.getConfig('cloudTok');
  const cfg = busy => req('/dy-cloud-config', { method: 'POST', headers: { 'X-Token': tok, ...(busy ? { 'X-Busy': busy } : {}) } });
  const prog = body => req('/dy-progress', { method: 'POST', headers: { 'X-Token': tok, 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
  await cfg('crawl');
  await dm(OWNER, '搜抖音 #微喇裤 50');
  assert.match(lastSay().text, /云电脑连着（\d+ 秒前来问过），正在抓你的号：有词要搜就先停一下抓取，半分钟内开始搜，搜完接着抓/);
  await cfg('search');
  await dm(OWNER, '搜抖音');
  assert.match(lastSay().text, /正在搜，这个词排在后面/);
  await cfg('wait:540');
  await dm(OWNER, '搜抖音');
  assert.match(lastSay().text, /上一次没搜成[\s\S]*9 分钟后再搜；发新的词会马上搜/);
  await cfg('idle');
  await dm(OWNER, '搜抖音');
  assert.match(lastSay().text, /云电脑连着（\d+ 秒前来问过），半分钟内开始$/m);
  // 旧版脚本：抓的时候不来问，只报进度
  await lib.setConfig('dyCloudSeen', String(Date.now() - 7 * 60 * 1000));
  await prog({ phase: 'running', mode: 'crawl', sent: 3, got: 5, accounts: [] });
  await dm(OWNER, '搜抖音');
  assert.match(lastSay().text, /云电脑连着，正在抓你的号（\d+ 秒前报过进度），这个词等它做完就搜/);
  await prog({ phase: 'paused', mode: 'crawl', sent: 5, got: 5, accounts: [] });
  await dm(OWNER, '进度');
  assert.match(lastSay().text, /先停一下给搜索让路/);
  assert.match(lastSay().text, /云电脑现在没连上（上次是7 分钟前）/, '既不来问、又不在抓：真的没连上');
  await dm(OWNER, '搜抖音 清空');
  await prog({ phase: 'done', mode: 'crawl' });
});

await t('未成年人：相关的词不搜，排着队的也不交给云电脑；文案看得出是未成年人的不进审核清单；这样的审核单通过了也不转', async () => {
  const tok = await lib.getConfig('cloudTok');
  const cfg = () => req('/dy-cloud-config', { method: 'POST', headers: { 'X-Token': tok } });
  await dm(OWNER, '搜抖音 女初中生');
  assert.match(lastSay().text, /不搜、不转未成年人的视频[\s\S]*「女初中生」这个词不搜/);
  assert.ok(!(await jsonOf(await cfg())).searches.includes('女初中生'));
  await lib.setConfig('dySearchQueue', JSON.stringify(['初三变装', '校服变装', '秋冬穿搭']));
  assert.deepEqual((await jsonOf(await cfg())).searches, ['校服变装', '秋冬穿搭'], '直接写明未成年人的词不交给云电脑；「校服」的搜索限制默认是关的，搜');
  // 搜到的结果里文案带「初中生」的：不进审核清单；只带「校服」的（成年人的校服穿搭也常见，看文案定不了）：进清单，标待人工确认
  await req('/dy-progress', { method: 'POST', headers: { 'X-Token': tok, 'Content-Type': 'application/json' },
    body: JSON.stringify({ phase: 'running', mode: 'search', keywords: ['秋冬穿搭'], per: {}, got: 2, sent: 0 }) });
  const rows = [{ aweme_id: '7800000000000000001', desc: '10后初中生的日常 #初中生', source_keyword: '秋冬穿搭' },
    { aweme_id: '7800000000000000002', desc: '秋冬穿搭分享', source_keyword: '秋冬穿搭' },
    { aweme_id: '7800000000000000003', desc: '✌️#青春女大穿搭 #女大穿搭日常 #学姐ootd #校服ootd分享', source_keyword: '秋冬穿搭' },
    { aweme_id: '7800000000000000004', desc: '校服 初中生日常', source_keyword: '秋冬穿搭' }];
  assert.equal((await req('/dy-search', { method: 'POST', headers: { 'X-Token': tok, 'X-Final': '1' }, body: rows.map(r => JSON.stringify(r)).join('\n') + '\n' })).status, 200);
  const V = await import('./verify.js');
  const task = await V.getTask(lib, JSON.parse(await lib.getConfig('rvIds')).at(-1));
  assert.deepEqual(task.keywords, ['秋冬穿搭']);
  assert.deepEqual(task.items.map(i => [i.id, i.flag || '']), [['7800000000000000002', ''],
    ['7800000000000000003', '命中规则「校服·文案要人工确认」（词：校服）：确认视频里都是成年人再通过']]);
  // 搜这类词的审核单：就算点了通过也不转
  Object.assign(task, { keywords: ['女初中生'], status: 'approved', transfer: '' });
  await V.saveTask(lib, task);
  const before = bot.toStreamer.length;
  await hook({ update_id: 904, callback_query: { id: 'cqm', from: { id: OWNER }, data: 'rvt:' + task.id, message: { message_id: 81, chat: { id: OWNER, type: 'private' } } } });
  assert.ok(!bot.toStreamer.slice(before).some(x => x.path === 'douyin/import'));
  assert.match(lastSay().text, /不搜、不转未成年人的视频/);
  await lib.setConfig('dySearchQueue', '[]');
  await req('/dy-progress', { method: 'POST', headers: { 'X-Token': tok, 'Content-Type': 'application/json' }, body: JSON.stringify({ phase: 'done', mode: 'search' }) });
});

await t('内容过滤规则：只由管理员在管理页加改删开关；机器人只照启用的规则执行，没命中的照常走；命中都有记录；查不了的标待人工确认', async () => {
  const tok = await lib.getConfig('cloudTok');
  const cfg = () => req('/dy-cloud-config', { method: 'POST', headers: { 'X-Token': tok } });
  const search = rows => req('/dy-search', { method: 'POST', headers: { 'X-Token': tok, 'X-Final': '1' }, body: rows.map(r => JSON.stringify(r)).join('\n') + '\n' });
  const V = await import('./verify.js');
  const lastTask = async () => V.getTask(lib, JSON.parse(await lib.getConfig('rvIds')).at(-1));
  const log = async () => (await jsonOf(await admin('filter-log'))).log;

  // 管理入口在小橘视频管理页（不在小橘音乐的 /admin）
  const vpage = await (await req('/video-admin')).text();
  assert.match(vpage, /小橘🍊视频 · 管理[\s\S]*内容过滤规则[\s\S]*过滤记录/);
  assert.match(await (await req('/admin')).text(), /内容过滤规则/, '/admin 和 /video-admin 是同一个页面');
  // 管理接口：要管理密钥；一开始只有固定的未成年人保护，别的规则一条都没有（机器人不自己加）
  assert.equal((await admin('filters', undefined, 'wrong')).status, 401);
  let f = await jsonOf(await admin('filters'));
  // 代码里只剩直接写明未成年人的固定词表；「校服」的两条是第一次启动放进去的默认规则，管理员可以改、关、删：搜索那条默认关着（搜得了）
  assert.deepEqual(f.builtin.map(r => [r.id, r.scope, r.action, r.enabled, r.builtin]), [['minor', 'both', 'filter', true, true]]);
  assert.deepEqual(f.rules.map(r => [r.name, r.scope, r.action, r.enabled, r.hint]),
    [['校服·搜索词', 'keyword', 'filter', false, ''], ['校服·文案要人工确认', 'caption', 'flag', true, '确认视频里都是成年人再通过']]);
  const seeded = f.rules.map(r => r.id);
  await dm(OWNER, '搜抖音 校服变装');
  assert.match(lastSay().text, /记下了「校服变装」/, '「校服」的搜索限制默认是关的');
  await dm(OWNER, '搜抖音 清空');
  await admin('filters', { ...f.rules[0], enabled: true });
  await dm(OWNER, '搜抖音 校服变装');
  assert.match(lastSay().text, /命中过滤规则「校服·搜索词」（词：校服），「校服变装」这个词不搜/, '管理员打开它就生效');
  await admin('filters', { ...f.rules[0], enabled: false });
  assert.equal((await jsonOf(await admin('filters-delete', { id: seeded[0] }))).ok, true, '默认规则管理员也能删');
  assert.equal((await jsonOf(await admin('filters-delete', { id: seeded[1] }))).ok, true);
  assert.deepEqual((await jsonOf(await admin('filters'))).rules, [], '删了不会再放回来');
  assert.equal((await admin('filters', { name: '', words: ['x'], scope: 'both', action: 'filter' })).status, 400);
  assert.equal((await admin('filters', { name: 'a', words: [], scope: 'both', action: 'filter' })).status, 400);
  assert.equal((await admin('filters', { name: 'a', words: ['x'], scope: 'everywhere', action: 'filter' })).status, 400);
  assert.equal((await admin('filters', { id: 'minor', name: 'a', words: ['x'], scope: 'both', action: 'filter' })).status, 400, '固定词表不能改');
  assert.equal((await admin('filters-delete', { id: 'minor' })).status, 400, '固定词表不能删');

  // 没有规则时：照常搜、照常进清单（只有固定规则在管）
  await dm(OWNER, '搜抖音 牛仔裤');
  assert.match(lastSay().text, /记下了「牛仔裤」/);
  await search([{ aweme_id: '7900000000000000001', desc: '烟管牛仔裤 广告位', source_keyword: '牛仔裤' }]);
  assert.deepEqual((await lastTask()).items.map(i => [i.id, i.flag || '']), [['7900000000000000001', '']]);

  // 管理员加两条：一条过滤（广告），一条只标记（品牌名，词按逗号分开写也行）
  const ad = (await jsonOf(await admin('filters', { name: '广告', words: '广告, 代购', scope: 'both', action: 'filter' }))).id;
  const brand = (await jsonOf(await admin('filters', { name: '品牌', words: ['Levis'], scope: 'caption', action: 'flag' }))).id;
  f = await jsonOf(await admin('filters'));
  assert.deepEqual(f.rules.map(r => [r.id, r.name, r.words, r.scope, r.action, r.enabled]),
    [[ad, '广告', ['广告', '代购'], 'both', 'filter', true], [brand, '品牌', ['Levis'], 'caption', 'flag', true]]);

  // 搜索词命中过滤规则：不搜，告诉是哪条规则，有记录
  await dm(OWNER, '搜抖音 代购牛仔裤');
  assert.match(lastSay().text, /命中过滤规则「广告」（词：代购），「代购牛仔裤」这个词不搜/);
  assert.deepEqual(Object.values((await log())[0]).slice(2, 8), [String(ad), '广告', '代购', 'search', 'filtered', '代购牛仔裤']);

  // 排着队的词，规则是后来加的：交给云电脑前按新规则再查，出队、告诉频道主、有记录
  await lib.setConfig('dySearchQueue', JSON.stringify(['广告大片', '直筒裤']));
  assert.deepEqual((await jsonOf(await cfg())).searches, ['直筒裤']);
  assert.match(lastSay().text, /「广告大片」不搜了，已经从排队里拿掉/);
  assert.equal((await log())[0].stage, 'queue');

  // 搜到的结果：命中过滤的不进清单；命中「只标记」的、没有文案查不了的标「待人工确认」；没命中的照常
  await dm(OWNER, '搜抖音 清空');
  const rows = [
    { aweme_id: '7900000000000000011', desc: '代购同款 私信', source_keyword: '直筒裤' },
    { aweme_id: '7900000000000000012', desc: 'levis 501 上身', source_keyword: '直筒裤' },
    { aweme_id: '7900000000000000013', desc: '', source_keyword: '直筒裤' },
    { aweme_id: '7900000000000000014', desc: '直筒裤怎么搭', source_keyword: '直筒裤' },
    { aweme_id: '7900000000000000014', desc: '直筒裤怎么搭', source_keyword: '直筒裤' },  // 同一条写了两行：只算一次
  ];
  await search(rows);
  const task = await lastTask();
  assert.deepEqual(task.items.map(i => [i.id, i.flag || '']), [
    ['7900000000000000012', '命中规则「品牌」（词：Levis）'],
    ['7900000000000000013', '没有文案，规则查不了'],
    ['7900000000000000014', ''],
  ]);
  const owned = bot.out.filter(o => o.method === 'sendMessage' && /的完整清单/.test(o.text || '')).at(-1).text;
  assert.match(owned, /按作品号去重后一共 4 条：进清单 3 条（其中 ⚠️ 待人工确认 2 条）；按过滤规则去掉 1 条（广告 1 条）/);
  const sent = bot.vout.filter(o => o.method === 'sendMessage').map(o => o.text).join('\n');
  assert.match(sent, /⚠️ 其中 2 条待人工确认/);
  assert.match(sent, /作品 ID：7900000000000000012\n   ⚠️ 待人工确认：命中规则「品牌」（词：Levis）/);
  const l = await log();
  assert.deepEqual(l.slice(0, 3).map(x => [x.stage, x.result, x.rule_name, x.subject]).sort(), [
    ['review', 'filtered', '广告', '7900000000000000011'],
    ['review', 'flagged', '品牌', '7900000000000000012'],
    ['review', 'unclear', '', '7900000000000000013'],
  ]);

  // 审核通过之后管理员又加了一条规则：转之前按最新的规则再查一遍（只看「过滤」，「只标记」的已经由频道主审过）
  await admin('filters', { name: '怎么搭', words: ['怎么搭'], scope: 'caption', action: 'filter' });
  Object.assign(task, { status: 'approved', transfer: '' });
  await V.saveTask(lib, task);
  const before = bot.toStreamer.length;
  bot.importing = false;
  await hook({ update_id: 905, callback_query: { id: 'cqf', from: { id: OWNER }, data: 'rvt:' + task.id, message: { message_id: 82, chat: { id: OWNER, type: 'private' } } } });
  const imp = bot.toStreamer.slice(before).find(x => x.path === 'douyin/import');
  assert.deepEqual(imp.body.text.split('\n').map(x => JSON.parse(x).aweme_id), ['7900000000000000012', '7900000000000000013']);
  assert.match(lastSay().text, /开始转 2 条（按过滤规则去掉 1 条）/);
  assert.deepEqual([(await log())[0].stage, (await log())[0].rule_name], ['transfer', '怎么搭']);

  // 关掉、改、删：马上生效，不用改代码
  await admin('filters', { id: ad, name: '广告', words: ['广告', '代购'], scope: 'both', action: 'filter', enabled: false });
  await dm(OWNER, '搜抖音 代购牛仔裤');
  assert.match(lastSay().text, /记下了「代购牛仔裤」/, '关掉的规则不再管');
  await admin('filters', { id: brand, name: '品牌', words: ['Levis'], scope: 'keyword', action: 'flag' });
  await dm(OWNER, '搜抖音 levis');
  assert.match(lastSay().text, /⚠️ 这个词命中规则「品牌」（词：Levis，只标记）：照常搜/);
  for (const r of (await jsonOf(await admin('filters'))).rules) assert.equal((await jsonOf(await admin('filters-delete', { id: r.id }))).ok, true);
  assert.deepEqual((await jsonOf(await admin('filters'))).rules, []);
  assert.equal((await jsonOf(await admin('filters-delete', { id: 99999 }))).ok, false);
  await dm(OWNER, '搜抖音 清空');
});

await t('重启后接着转：交给流式服务的抖音任务记下来；它重启后来报到就照原样再交一次（同一个编号），转完、叫停就销掉', async () => {
  await dm(OWNER, '云电脑');
  const tok = await lib.getConfig('cloudTok');
  const batch = (body, fin) => req('/dy-import', { method: 'POST', headers: { 'X-Token': tok, 'X-Final': fin }, body });
  const notice = (path, body, key = SKEY) => req(path, { method: 'POST', headers: { 'X-Key': key, 'Content-Type': 'application/json' }, body: JSON.stringify(body || {}) });
  const imports = () => bot.toStreamer.filter(x => x.path === 'douyin/import');
  bot.importing = false; bot.lastRun = null; bot.dyStatus = null;
  const big = Array.from({ length: 4000 }, (_, i) => JSON.stringify({ aweme_id: String(7700000000000000000n + BigInt(i)), desc: '很长的文案'.repeat(20) })).join('\n');
  const one = JSON.stringify({ aweme_id: '7700000000000099999', desc: 'b' });
  assert.ok(big.length > 300 * 1024, '要大到拆成几段存');
  await batch(big, '0');
  await batch(one, '0');
  const first = imports().at(-2), runId = first.body.run_id;
  assert.ok(runId);
  assert.equal(imports().at(-1).body.run_id.length > 0, true);

  // 流式服务重启：手上什么都没有了
  bot.importing = false; bot.lastRun = null;
  assert.equal((await notice('/streamer-up', {}, 'wrong')).status, 403);
  const n = imports().length;
  assert.deepEqual(await jsonOf(await notice('/streamer-up')), { ok: true, resumed: true, retry: false });
  const again = imports().slice(n);
  assert.deepEqual(again.map(x => [x.body.text === big || x.body.text === one ? 'same' : 'diff', x.body.final, x.body.run_id]),
    [['same', false, runId], ['same', false, runId]], '两批照原样再交，还在边抓边转（final 照旧是 false），编号不变');
  assert.equal(again[0].body.text, big);
  assert.match(lastSay().text, /重启过，没转完的那批接着转/);

  // 云电脑抓完：最后的通知也记上，再重启时最后一批带 final
  await batch('', '1');
  bot.importing = false; bot.lastRun = null;
  const n2 = imports().length;
  await notice('/streamer-up');
  assert.deepEqual(imports().slice(n2).map(x => x.body.final), [false, true]);

  // 交不上（流式服务还没完全起来）：回 retry，它过一会儿再来报到；这次不算次数
  bot.streamerDown = true;
  assert.deepEqual(await jsonOf(await notice('/streamer-up')), { ok: true, resumed: false, retry: true });
  bot.streamerDown = false;
  assert.equal((await lib.resumeGet()).resumes, 2);
  // 报结束：编号对不上不销，对上了销；再报到就没什么可交的
  assert.deepEqual(await jsonOf(await notice('/streamer-done', { run_id: 'other' })), { ok: true, cleared: false });
  assert.deepEqual(await jsonOf(await notice('/streamer-done', { run_id: runId })), { ok: true, cleared: true });
  const n3 = imports().length;
  await notice('/streamer-up');
  assert.equal(imports().length, n3);

  // 「转抖音视频」：报结束没送到也不要紧，定时任务问一下：还是这个编号、已经结束 → 销；流式服务手上没有（重启了）→ 再交
  await dm(OWNER, '转抖音视频');
  const mirror = bot.toStreamer.filter(x => x.path === 'douyin/mirror').at(-1);
  assert.ok(mirror.body.run_id);
  bot.dyStatus = { status: 'idle' };
  let jobs = [];
  await worker.scheduled({ cron: '*/30 * * * *' }, env, { waitUntil: p => jobs.push(p) });
  await Promise.all(jobs);
  const resent = bot.toStreamer.filter(x => x.path === 'douyin/mirror').at(-1);
  assert.notEqual(resent, mirror);
  assert.equal(resent.body.run_id, mirror.body.run_id);
  bot.dyStatus = { status: 'done', run_id: mirror.body.run_id };
  jobs = [];
  await worker.scheduled({ cron: '*/30 * * * *' }, env, { waitUntil: p => jobs.push(p) });
  await Promise.all(jobs);
  assert.equal(await lib.resumeGet(), null, '这个编号已经转完，销掉');

  // 每 5 分钟的自检：流式服务重启后没来报到也能接上（只做自检，不跑自动同步）
  await dm(OWNER, '转抖音视频');
  const m5 = bot.toStreamer.filter(x => x.path === 'douyin/mirror').at(-1);
  bot.dyStatus = { status: 'idle' };
  jobs = [];
  await worker.scheduled({ cron: '*/5 * * * *' }, env, { waitUntil: p => jobs.push(p) });
  await Promise.all(jobs);
  const again5 = bot.toStreamer.filter(x => x.path === 'douyin/mirror').at(-1);
  assert.notEqual(again5, m5);
  assert.equal(again5.body.run_id, m5.body.run_id);
  assert.equal(again5.body.quiet, undefined, '是接着转那一次，不是自动同步');
  await lib.resumeClear();

  // 老是转到一半就重启：最多接着转 3 次，之后告诉频道主，不再自动来
  await dm(OWNER, '转抖音视频');
  bot.dyStatus = { status: 'idle' };
  for (let i = 0; i < 3; i++) await notice('/streamer-up');
  const before = bot.toStreamer.filter(x => x.path === 'douyin/mirror').length;
  await notice('/streamer-up');
  assert.equal(bot.toStreamer.filter(x => x.path === 'douyin/mirror').length, before);
  assert.match(lastSay().text, /重启了 3 次都没把这批转完/);
  assert.equal(await lib.resumeGet(), null);

  // 频道主点「停」：不再接着转
  await dm(OWNER, '转抖音视频');
  assert.ok(await lib.resumeGet());
  bot.dyStatus = { status: 'running' };
  await hook({ update_id: 902, callback_query: { id: 'cqstop', from: { id: OWNER }, data: 'prg:post', message: { message_id: 79, chat: { id: OWNER, type: 'private' } } } });
  assert.equal(await lib.resumeGet(), null);
  bot.dyStatus = null; bot.importing = false; bot.lastRun = null;
});

await t('频道主的菜单：常驻按钮和 / 命令（只设给频道主），点了等于发对应的文字；别人用不了', async () => {
  await lib.setConfig('cmdsVer', '');
  await dm(OWNER, '/start');
  const set = bot.out.filter(o => o.method === 'setMyCommands').at(-1);
  assert.deepEqual(set.scope, { type: 'chat', chat_id: OWNER });
  assert.ok(set.commands.some(c => c.command === 'progress'));
  assert.ok(!set.commands.some(c => c.command === 'stats'), '菜单里没有音乐的命令');
  const help = lastSay();
  assert.match(help.text, /📊 进度[\s\S]*🎬 抖音[\s\S]*🔎 抖音搜索/);
  assert.doesNotMatch(help.text, /搬运设置|统计|歌/);
  assert.deepEqual(help.reply_markup.keyboard[0], ['▶️ 运行爬虫', '📊 进度', '🎬 转抖音视频']);
  const n = bot.out.filter(o => o.method === 'setMyCommands').length;
  await dm(OWNER, '❓ 帮助');
  assert.equal(bot.out.filter(o => o.method === 'setMyCommands').length, n, '设过一次就不再设');
  assert.match(lastSay().text, /全部功能/);
  await dm(OWNER, '📊 进度');
  assert.match(lastSay().text, /📊 进度/);
  await dm(OWNER, '/tags@xiaoju_video_bot');
  assert.match(lastSay().text, /标签/);
  await dm(OWNER, '🔎 搜抖音');
  assert.match(lastSay().text, /搜抖音/);
  await dm(OWNER, '随便说一句');
  assert.match(lastSay().text, /全部功能/, '不认识的话：给出帮助');
  const before = bot.out.length;
  await dm(FAN + 6, '/start');
  assert.match(lastSay().text, /只有频道主能用/);
  assert.ok(!lastSay().reply_markup, '别人没有按钮');
  assert.equal(bot.out.length, before + 1);
});

await t('路由：404、405、CORS 预检；音乐的路径这里没有', async () => {
  assert.equal((await req('/nope')).status, 404);
  assert.equal((await req('/a/9')).status, 404);
  assert.equal((await req('/api/tracks')).status, 404);
  assert.equal((await req('/tg-webhook')).status, 405);
  assert.equal((await req('/vf/9', { method: 'POST' })).status, 405);
  assert.equal((await admin('nope', {})).status, 404);
  assert.equal((await admin('state')).status, 404, '没有音乐的管理接口');
  const r = await req('/vf/9', { method: 'OPTIONS' });
  assert.equal(r.status, 204);
  assert.match(r.headers.get('Access-Control-Allow-Headers'), /Range/);
});

await t('刷视频网页、管理页、登录抖音页都能取到，内嵌脚本能通过语法检查', async () => {
  for (const path of ['/', '/video', '/admin', '/video-admin', '/douyin-login']) {
    const r = await req(path);
    assert.equal(r.status, 200, path);
    assert.equal(r.headers.get('Content-Type'), 'text/html; charset=utf-8');
    const html = await textOf(r);
    new Function(html.split('<script>')[1].split('</script>')[0]); // 语法错误会抛
  }
  for (const path of ['/admin', '/video-admin', '/douyin-login']) assert.equal((await req(path)).headers.get('X-Robots-Tag'), 'noindex');
  assert.match(await textOf(await req('/admin')), /小橘🍊视频 · 管理/);
});

await t('任何响应里都不出现机器人 token、管理密钥、流式服务密钥', async () => {
  assert.ok(seen.length > 20);
  for (const s of seen) {
    for (const secret of [TOKEN, 'SECRET-BOT', VTOKEN, 'VERIFY-BOT', ADMIN, SKEY]) assert.ok(!s.includes(secret), 'leaked: ' + s.slice(0, 200));
  }
});

console.log(`\n全部 ${n} 项通过`);
