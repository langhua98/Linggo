// 本地测试：Node 自带的 SQLite 模拟 Durable Object，再模拟两个机器人的 Telegram 接口和流式服务，逐条验证 worker.js
import assert from 'node:assert/strict';
import { register } from 'node:module';
import { DatabaseSync } from 'node:sqlite';

register('./test/hooks.mjs', import.meta.url);
const { default: worker, Library, parseRange, normalizeItem, douyinLinks } = await import('./worker.js');

const BOT = '111:VIDEO-BOT';
const VERIFY = '222:VERIFY-BOT';
const HOOK = 'hook-secret';
const ADMIN = 'admin-key';
const SKEY = 'streamer-key';
const STREAMER = 'https://streamer.example';
const CHANNEL = -1004000000001;
const OWNER = 777, STRANGER = 555;
const MB = 1024 * 1024;
const ORIGIN = 'https://xiaoju-video.example';

// ── 模拟 Durable Object ──
function makeSql(db = new DatabaseSync(':memory:')) {
  return { exec: (query, ...params) => { const rows = db.prepare(query).all(...params).map(r => ({ ...r })); return { toArray: () => rows }; } };
}
let libStorage; // 模拟的 Durable Object 存储（看定时器设了没有）
async function makeLibrary(env) {
  let ready;
  const storage = {
    sql: makeSql(), alarm: null,
    async getAlarm() { return this.alarm; }, async setAlarm(t) { this.alarm = t; }, async deleteAlarm() { this.alarm = null; },
  };
  const ctx = { storage, blockConcurrencyWhile(fn) { ready = fn(); return ready; } };
  const lib = new Library(ctx, env);
  await ready;
  libStorage = storage;
  return new Proxy({}, {
    get: (_, name) => name === 'then' ? undefined : async (...args) => structuredClone(await lib[name](...structuredClone(args))),
  });
}

// ── 模拟 Telegram 和流式服务 ──
const files = new Map(); // file_id -> 字节
const tgFiles = []; // 从 Telegram 下了哪些文件
const bigFiles = new Map(); // 消息号 -> 字节（只有流式服务取得到）
const sent = { bot: [], verify: [] };
const toStreamer = [];
const channelCalls = [];
const userDeletes = [];
const state = { streamer: 'ok', resolve: {}, expand: {}, channel: [], busy: '', outbox: { boot: 'B1', events: [], busy: false } };
const outboxCalls = []; // Worker 来取发件箱时带的 boot、after
const jobCalls = []; // 交给流式服务的云电脑活：[路径, 请求体]
const bytesOf = (n, seed) => { const b = new Uint8Array(n); for (let i = 0; i < n; i++) b[i] = (i * 7 + seed) & 255; return b; };

function serve(bytes, range) {
  if (!range) return new Response(bytes, { headers: { 'Content-Length': String(bytes.length) } });
  const [a, b] = range.replace('bytes=', '').split('-');
  const start = Number(a), end = b ? Number(b) : bytes.length - 1;
  return new Response(bytes.slice(start, end + 1), {
    status: 206, headers: { 'Content-Length': String(end - start + 1), 'Content-Range': `bytes ${start}-${end}/${bytes.length}` },
  });
}

globalThis.fetch = async (input, init = {}) => {
  const url = String(input);
  const headers = new Headers(init.headers || {});
  const body = init.body instanceof FormData ? Object.fromEntries(init.body) : init.body ? JSON.parse(init.body) : null;
  let m;
  if ((m = url.match(/^https:\/\/api\.telegram\.org\/bot([^/]+)\/(\w+)(\?.*)?$/))) {
    const [, token, method, qs] = m;
    const who = token === BOT ? 'bot' : token === VERIFY ? 'verify' : null;
    assert.ok(who, 'unknown bot token');
    if (method === 'getChatAdministrators') {
      assert.equal(who, 'bot');
      return Response.json({ ok: true, result: [{ status: 'administrator', user: { id: 1 } }, { status: 'creator', user: { id: OWNER } }] });
    }
    if (method === 'getFile') {
      const id = new URLSearchParams(qs).get('file_id');
      return Response.json(files.has(id) ? { ok: true, result: { file_path: 'videos/' + id } } : { ok: false });
    }
    sent[who].push({ method, ...body });
    if (method === 'deleteMessage' && state.botDelete === 'fail') return Response.json({ ok: false, description: "Bad Request: message can't be deleted" });
    return Response.json({ ok: true, result: { message_id: 1 } });
  }
  if ((m = url.match(/^https:\/\/api\.telegram\.org\/file\/bot[^/]+\/videos\/(\w+)$/))) {
    tgFiles.push(m[1]);
    return files.has(m[1]) ? serve(files.get(m[1]), headers.get('Range')) : new Response('nope', { status: 404 });
  }
  if (url.startsWith(STREAMER)) {
    assert.equal(headers.get('X-Key'), SKEY);
    if (state.streamer === 'down') throw new TypeError('fetch failed');
    if (state.streamer === 'html') return new Response('<html>starting</html>', { status: 200, headers: { 'Content-Type': 'text/html' } });
    const path = url.slice(STREAMER.length);
    if ((m = path.match(/^\/stream\/(\d+)$/))) {
      const b = bigFiles.get(Number(m[1]));
      return b ? serve(b, headers.get('Range')) : Response.json({ detail: 'gone' }, { status: 404 });
    }
    if ((m = path.match(/^\/thumb\/(\d+)$/))) return new Response(Uint8Array.from([0xff, 0xd8, 0xff, 1, 2, 3]));
    if (path === '/douyin/resolve') {
      const item = state.resolve[body.url];
      return item ? Response.json({ item }) : Response.json({ error: '认不出这个链接' }, { status: 400 });
    }
    if (path === '/channel/delete') {
      userDeletes.push(body.id);
      return Response.json({ deleted: state.userDelete !== false });
    }
    if (path === '/channel/videos') {
      channelCalls.push(body);
      const page = state.channel.filter(v => v.id > body.after).slice(0, body.limit);
      return Response.json({ videos: page, last: page.length ? page[page.length - 1].id : body.after, done: page.length < body.limit });
    }
    if (path === '/douyin/expand') {
      return Response.json({ results: body.urls.map(u => ({ url: u, ...(state.expand[u] || {}) })) });
    }
    if (path === '/douyin/post') {
      toStreamer.push(...body.items);
      return Response.json({ ok: true });
    }
    if (path.startsWith('/outbox?')) {
      const q = new URL(STREAMER + path).searchParams;
      outboxCalls.push({ boot: q.get('boot'), after: Number(q.get('after')) });
      const ob = state.outbox;
      if (q.get('boot') === ob.boot) ob.events = ob.events.filter(e => e.seq > Number(q.get('after')));
      return Response.json({ boot: ob.boot, events: ob.events, busy: ob.busy });
    }
    if (path === '/douyin/login' || path === '/douyin/crawl') {
      jobCalls.push([path, body]);
      return state.busy ? Response.json({ busy: state.busy }, { status: 409 }) : Response.json({ ok: true });
    }
    if (path === '/douyin/login/input') {
      jobCalls.push([path, body]);
      return state.busy === '登录抖音' ? Response.json({ ok: true }) : Response.json({ error: 'no' }, { status: 409 });
    }
  }
  throw new Error('unexpected fetch ' + url);
};

const env = {
  TG_BOT_TOKEN: BOT, VERIFY_BOT_TOKEN: VERIFY, TG_WEBHOOK_SECRET: HOOK, ADMIN_KEY: ADMIN, STREAMER_KEY: SKEY,
  STREAMER_URL: STREAMER + '/', VIDEO_CHANNEL_ID: String(CHANNEL),
};
const L = await makeLibrary(env);
env.LIB = { idFromName: () => 'id', get: () => L };

// 和线上一样：响应先回，waitUntil 里的活在后台跑完；测试等它们跑完再断言
const call = async (path, init = {}) => {
  const pending = [];
  const res = await worker.fetch(new Request(ORIGIN + path, init), env, { waitUntil: p => pending.push(p) });
  await Promise.all(pending);
  return res;
};
const post = (path, body, headers = {}) => call(path, { method: 'POST', headers: { 'Content-Type': 'application/json', ...headers }, body: JSON.stringify(body) });
const hook = (update, verify = false) => post(verify ? '/verify-webhook' : '/tg-webhook', update, { 'X-Telegram-Bot-Api-Secret-Token': HOOK });
const dm = (from, text) => hook({ update_id: 1, message: { message_id: 5, chat: { id: from, type: 'private' }, from: { id: from }, text } });
const press = (from, data) => hook({ update_id: 2, callback_query: { id: 'cb', from: { id: from }, data, message: { message_id: 9, chat: { id: from } } } }, true);
const channelPost = (msg, edited = false) => hook({ update_id: 3, [edited ? 'edited_channel_post' : 'channel_post']: { chat: { id: CHANNEL }, date: 1700000000, ...msg } });
const last = who => sent[who][sent[who].length - 1];
const reset = () => { sent.bot.length = 0; sent.verify.length = 0; toStreamer.length = 0; };

let n = 0;
async function test(name, fn) {
  reset();
  try {
    await fn();
    n++;
  } catch (e) {
    console.error('✗ ' + name);
    throw e;
  }
}

// ── 纯函数 ──
await test('parseRange', () => {
  assert.deepEqual(parseRange(null, 100), { start: 0, end: 99, partial: false });
  assert.deepEqual(parseRange('bytes=10-19', 100), { start: 10, end: 19, partial: true });
  assert.deepEqual(parseRange('bytes=90-', 100), { start: 90, end: 99, partial: true });
  assert.deepEqual(parseRange('bytes=-5', 100), { start: 95, end: 99, partial: true });
  assert.equal(parseRange('bytes=100-', 100), null);
  assert.deepEqual(parseRange('bytes=0-5,10-20', 100), { start: 0, end: 99, partial: false });
});

await test('douyinLinks 从分享文字里认链接', () => {
  const t = '7.43 复制打开抖音，看看【小橘的作品】今天的猫 # 猫 https://v.douyin.com/iAbC123/ dCu:/ 11/02 W@M.Ji';
  assert.deepEqual(douyinLinks(t), ['https://v.douyin.com/iAbC123/']);
  assert.deepEqual(douyinLinks('https://www.douyin.com/video/7300000000000000001?x=1，好看'), ['https://www.douyin.com/video/7300000000000000001?x=1']);
  assert.deepEqual(douyinLinks('https://example.com/video/1'), []);
});

await test('normalizeItem 只留认得的字段', () => {
  assert.equal(normalizeItem({ aweme: 'abc', type: 'video' }), null);
  assert.equal(normalizeItem({ aweme: '7300000000000000001', type: 'live' }), null);
  const v = normalizeItem({ aweme: '7300000000000000001', type: 'video', desc: 'x', video_url: 'http://insecure', evil: 1 });
  assert.equal(v.video_url, undefined);
  assert.equal(v.evil, undefined);
  assert.equal(v.url, 'https://www.douyin.com/video/7300000000000000001');
  const i = normalizeItem({ aweme: '7300000000000000002', type: 'images', images: ['https://a/1.jpg', 'ftp://x', 3] });
  assert.deepEqual(i.images, ['https://a/1.jpg']);
});

// ── 鉴权 ──
await test('webhook 密钥不对 403；内部接口不带凭证 403', async () => {
  assert.equal((await post('/tg-webhook', {}, { 'X-Telegram-Bot-Api-Secret-Token': 'x' })).status, 403);
  assert.equal((await post('/verify-webhook', {})).status, 403);
  assert.equal((await post('/streamer-up', {})).status, 403);
  assert.equal((await post('/dy-import', { items: [] })).status, 403); // 还没生成云电脑令牌
  assert.equal((await call('/admin/api/state')).status, 403);
  assert.equal((await call('/admin/api/state', { headers: { Authorization: 'Bearer nope' } })).status, 403);
});

// ── 频道新帖登记进视频池 ──
const small = bytesOf(3 * MB, 1);
const big = bytesOf(25 * MB, 2);
files.set('VSMALL', small);
files.set('THUMB1', Uint8Array.from([0xff, 0xd8, 0xff, 9, 9]));
bigFiles.set(11, big);

await test('频道视频帖登记；别的频道、非视频帖不登记', async () => {
  await channelPost({ message_id: 10, video: { file_id: 'VSMALL', file_size: small.length, duration: 12, width: 720, height: 1280, mime_type: 'video/mp4', thumbnail: { file_id: 'THUMB1' } }, caption: '小猫 #dy7300000000000000009' });
  await channelPost({ message_id: 11, document: { file_id: 'VBIG', file_size: big.length, mime_type: 'video/mp4' }, caption: '大视频' });
  await hook({ channel_post: { chat: { id: -100999 }, message_id: 12, video: { file_id: 'X', file_size: 1 } } });
  await channelPost({ message_id: 13, text: '纯文字' });
  const j = await (await call('/api/videos')).json();
  assert.deepEqual(j.videos.map(v => v.id), [11, 10]);
  // 只记播放要用的：帖子的说明、标签不读不存
  assert.deepEqual(Object.keys(j.videos[1]).sort(), ['date', 'duration', 'height', 'id', 'size', 'width']);
  assert.ok(!JSON.stringify(await L.getVideo(10)).includes('小猫'));
  assert.ok(!JSON.stringify(await L.getVideo(10)).includes('#dy'));
});

await test('小视频走 Bot API，支持 Range', async () => {
  let r = await call('/vf/10');
  assert.equal(r.status, 200);
  assert.equal(r.headers.get('Content-Length'), String(small.length));
  assert.deepEqual(new Uint8Array(await r.arrayBuffer()), small);
  r = await call('/vf/10', { headers: { Range: 'bytes=100-199' } });
  assert.equal(r.status, 206);
  assert.equal(r.headers.get('Content-Range'), `bytes 100-199/${small.length}`);
  assert.deepEqual(new Uint8Array(await r.arrayBuffer()), small.slice(100, 200));
  r = await call('/vf/10', { headers: { Range: `bytes=${small.length}-` } });
  assert.equal(r.status, 416);
  r = await call('/vf/10', { method: 'HEAD' });
  assert.equal(r.headers.get('Content-Length'), String(small.length));
  assert.equal((await call('/vf/99')).status, 404);
});

await test('边缘缓存：第一次照常从 Telegram 给、后台整个存一份；之后按 Range 从缓存给，不再找 Telegram', async () => {
  // 假的 Cloudflare 缓存：存整份，取的时候按 Range 切
  const store = new Map();
  globalThis.caches = { default: {
    async match(req) {
      const b = store.get(req.url);
      if (!b) return undefined;
      const m = /bytes=(\d+)-(\d*)/.exec(req.headers.get('Range') || '');
      if (!m) return new Response(b, { headers: { 'Content-Length': String(b.length) } });
      const end = m[2] ? Number(m[2]) : b.length - 1;
      return new Response(b.slice(Number(m[1]), end + 1), { status: 206, headers: { 'Content-Range': `bytes ${m[1]}-${end}/${b.length}`, 'Content-Length': String(end - Number(m[1]) + 1) } });
    },
    async put(key, res) { store.set(key, new Uint8Array(await res.arrayBuffer())); },
  } };
  try {
    let r = await call('/vf/10', { headers: { Range: 'bytes=0-99' } });
    assert.equal(r.status, 206);
    assert.equal(r.headers.get('X-Edge-Cache'), null);
    assert.deepEqual(new Uint8Array(await r.arrayBuffer()), small.slice(0, 100));
    assert.equal(store.size, 1); // 后台存好了整份
    tgFiles.length = 0;
    r = await call('/vf/10', { headers: { Range: 'bytes=1000-1999' } });
    assert.equal(r.status, 206);
    assert.equal(r.headers.get('X-Edge-Cache'), 'hit');
    assert.equal(r.headers.get('Content-Range'), `bytes 1000-1999/${small.length}`);
    assert.deepEqual(new Uint8Array(await r.arrayBuffer()), small.slice(1000, 2000));
    assert.equal(tgFiles.length, 0); // 没再找 Telegram
  } finally {
    delete globalThis.caches;
  }
});

await test('大视频走流式服务；休眠时 503 + Retry-After', async () => {
  let r = await call('/vf/11', { headers: { Range: 'bytes=0-1023' } });
  assert.equal(r.status, 206);
  assert.deepEqual(new Uint8Array(await r.arrayBuffer()), big.slice(0, 1024));
  r = await call('/vf/11.mp4', { headers: { Range: `bytes=${big.length - 10}-` } });
  assert.deepEqual(new Uint8Array(await r.arrayBuffer()), big.slice(big.length - 10));
  state.streamer = 'html';
  r = await call('/vf/11', { headers: { Range: 'bytes=0-1' } });
  assert.equal(r.status, 503);
  assert.equal(r.headers.get('Retry-After'), '15');
  state.streamer = 'down';
  assert.equal((await call('/vf/11')).status, 503);
  state.streamer = 'ok';
});

await test('封面：有缩略图走 Bot API，没有问流式服务；取一次就存下', async () => {
  let r = await call('/vp/10');
  assert.equal(r.status, 200);
  assert.equal(r.headers.get('Content-Type'), 'image/jpeg');
  assert.deepEqual(new Uint8Array(await r.arrayBuffer()), Uint8Array.from([0xff, 0xd8, 0xff, 9, 9]));
  files.delete('THUMB1');
  r = await call('/vp/10'); // 从数据库出
  assert.equal(r.status, 200);
  r = await call('/vp/11');
  assert.deepEqual(new Uint8Array(await r.arrayBuffer()), Uint8Array.from([0xff, 0xd8, 0xff, 1, 2, 3]));
});

await test('编辑后不含视频的帖子移出视频池', async () => {
  await channelPost({ message_id: 11, text: '改成文字了' }, true);
  const j = await (await call('/api/videos')).json();
  assert.deepEqual(j.videos.map(v => v.id), [10]);
});

// ── 小橘视频机器人：私聊 ──
const AW1 = '7300000000000000001', AW2 = '7300000000000000002';
state.resolve['https://v.douyin.com/aaa/'] = { aweme: AW1, type: 'video', desc: '我的第一条', author: '小橘', video_url: 'https://cdn.example/1.mp4' };

await test('陌生人私聊只给网页地址', async () => {
  await dm(STRANGER, 'https://v.douyin.com/aaa/');
  assert.equal(last('bot').chat_id, STRANGER);
  assert.match(last('bot').text, /\/video/);
  assert.equal(sent.verify.length, 0);
});

// 审核单：一批一张，只有两个按钮
const sheets = () => sent.verify.filter(m => m.method === 'sendMessage' && /🛂 审核单/.test(m.text));
const bidOf = m => /审核单 ([a-z0-9]{14})/.exec(m.text)[1];
let B1;
await test('频道主发分享链接 → 成一张审核单（只有两个按钮）；重复的不再收', async () => {
  await dm(OWNER, '复制打开抖音 https://v.douyin.com/aaa/ 看看 https://v.douyin.com/bad/');
  assert.equal(sheets().length, 1);
  const sh = sheets()[0];
  assert.equal(sh.chat_id, OWNER);
  assert.match(sh.text, /🛂 审核单 [a-z0-9]{14}（#私聊链接 #批次数量1 条）/);
  assert.match(sh.text, /我的第一条/);
  assert.match(sh.text, /查看全部：https:\/\/xiaoju-video\.langhua98\.workers\.dev\/review\/[a-z0-9]{14}/);
  B1 = bidOf(sh);
  assert.deepEqual(sh.reply_markup.inline_keyboard, [[
    { text: '✅ 审核通过', callback_data: `batch-ok:${B1}` }, { text: '❌ 审核失败', callback_data: `batch-no:${B1}` }]]);
  assert.match(last('bot').text, new RegExp(`1 条成了审核单 ${B1}`));
  assert.match(last('bot').text, /1 条认不出：认不出这个链接/);
  reset();
  await dm(OWNER, 'https://v.douyin.com/aaa/');
  assert.equal(sheets().length, 0);
  assert.match(last('bot').text, /以前已经收过/);
});

await test('流式服务没醒时，链接如实告诉频道主', async () => {
  state.streamer = 'down';
  await dm(OWNER, 'https://v.douyin.com/zzz/');
  assert.match(last('bot').text, /流式服务没响应/);
  state.streamer = 'ok';
});

await test('只有频道主能按审核按钮', async () => {
  await press(STRANGER, `batch-ok:${B1}`);
  assert.equal(last('verify').method, 'answerCallbackQuery');
  assert.match(last('verify').text, /只有频道主/);
  assert.equal((await L.getItem(AW1)).status, 'review');
});

await test('审核通过 → 整批排队并立刻交给流式服务（在转）', async () => {
  await press(OWNER, `batch-ok:${B1}`);
  assert.equal(toStreamer.length, 1);
  assert.equal(toStreamer[0].aweme, AW1);
  assert.equal(toStreamer[0].video_url, 'https://cdn.example/1.mp4');
  assert.equal((await L.getItem(AW1)).status, 'sending');
  assert.ok(sent.verify.some(m => m.method === 'editMessageText' && /✅ 审核通过：1 条排队转发/.test(m.text)));
  reset();
  await press(OWNER, `batch-ok:${B1}`); // 再按一次：已经审过
  assert.equal(toStreamer.length, 0);
  assert.match(sent.verify.find(m => m.method === 'answerCallbackQuery').text, /已经审过/);
  await press(OWNER, 'ok:7300000000000000001'); // 老按钮不再管用
  assert.match(last('verify').text, /已经不用了/);
});

await test('流式服务交不进去：放回队列，定时任务再交', async () => {
  state.resolve['https://v.douyin.com/bbb/'] = { aweme: AW2, type: 'images', desc: '图文', images: ['https://cdn.example/a.jpg'] };
  reset();
  await dm(OWNER, 'https://v.douyin.com/bbb/');
  state.streamer = 'down';
  await press(OWNER, `batch-ok:${bidOf(sheets()[0])}`);
  assert.equal((await L.getItem(AW2)).status, 'queued');
  state.streamer = 'ok';
  await worker.scheduled({}, env, { waitUntil: p => p });
  await new Promise(r => setTimeout(r, 0));
  assert.equal((await L.getItem(AW2)).status, 'sending');
  assert.deepEqual(toStreamer.map(i => i.aweme), [AW2]);
});

await test('流式服务报结果：成功记已转；频道帖带 #dy 也不读', async () => {
  const H = { 'X-Key': SKEY };
  let r = await post('/streamer-done', { aweme: AW1, ok: true, message_id: 20 }, H);
  assert.equal((await r.json()).status, 'posted');
  assert.equal((await L.getItem(AW1)).msg, 20);
  // 频道帖的标签不读：带 #dy 也不会记成已转，只认流式服务的回报
  await channelPost({ message_id: 21, photo: [{ file_id: 'P' }], caption: `图文 #dy${AW2}` });
  assert.equal((await L.getItem(AW2)).status, 'sending');
  r = await post('/streamer-done', { aweme: AW2, ok: true, message_id: 21 }, H);
  assert.equal((await L.getItem(AW2)).status, 'posted');
  assert.equal((await post('/streamer-done', { aweme: 'x', ok: true }, H)).status, 400);
});

await test('失败重试，满 3 次记失败并告诉频道主；「重试失败」重新排队', async () => {
  const AW = '7300000000000000003';
  await L.addItems([normalizeItem({ aweme: AW, type: 'video' })], 'link');
  await L.review([AW], 'queued');
  const H = { 'X-Key': SKEY };
  for (let i = 0; i < 2; i++) {
    const r = await post('/streamer-done', { aweme: AW, ok: false, error: '下载 403' }, H);
    assert.equal((await r.json()).status, 'queued');
  }
  const r = await post('/streamer-done', { aweme: AW, ok: false, error: '下载 403', idle: true }, H);
  assert.equal((await r.json()).status, 'failed');
  assert.match(last('bot').text, /下载 403/);
  reset();
  await dm(OWNER, '重试失败');
  assert.deepEqual(toStreamer.map(i => i.aweme), [AW]);
  assert.match(sent.bot[0].text, /1 条失败的作品重新排队/);
});

await test('流式服务重启报到：在转的全部重交', async () => {
  const before = (await L.counts()).sending;
  assert.ok(before >= 1);
  const r = await post('/streamer-up', {}, { 'X-Key': SKEY });
  assert.equal(r.status, 200);
  assert.equal(toStreamer.length, before);
  assert.ok(Number(await L.getConfig('streamerUp')) > 0);
});

await test('交出去 30 分钟没回音：重排队；超过次数记失败', async () => {
  const AW = '7300000000000000004';
  await L.addItems([normalizeItem({ aweme: AW, type: 'video' })], 'link');
  await L.review([AW], 'queued');
  await L.claimQueued(50, Date.now() - 31 * 60 * 1000);
  const failed = await L.expireSending(Date.now() - 30 * 60 * 1000, 3);
  assert.deepEqual(failed, []);
  assert.equal((await L.getItem(AW)).attempts, 1);
});

// ── 云电脑 ──
let token;
await test('「云电脑」生成令牌，换新的旧的作废', async () => {
  await dm(OWNER, '云电脑');
  token = /setup \S+ ([0-9a-f]{48})/.exec(last('bot').text)[1];
  assert.match(last('bot').text, new RegExp(`setup ${ORIGIN} `));
  await dm(OWNER, '云电脑');
  const t2 = /setup \S+ ([0-9a-f]{48})/.exec(last('bot').text)[1];
  assert.notEqual(t2, token);
  assert.equal((await post('/dy-known', { ids: [] }, { 'X-Token': token })).status, 403);
  token = t2;
});

const C1 = '7300000000000000101', C2 = '7300000000000000102', C3 = '7300000000000000103';
await test('云电脑：查已知、导入（成一张审核单）、进度', async () => {
  const H = { 'X-Token': token };
  let r = await post('/dy-known', { ids: [AW1, C1, 'junk'] }, H);
  assert.deepEqual((await r.json()).known, [AW1]);
  r = await post('/dy-import', { items: [
    { aweme: C1, type: 'video', desc: 'c1', create_time: 3, video_url: 'https://cdn/c1.mp4' },
    { aweme: C2, type: 'video', desc: 'c2', create_time: 1, video_url: 'https://cdn/c2.mp4' },
    { aweme: C3, type: 'images', desc: 'c3', create_time: 2, images: ['https://cdn/c3.jpg'] },
    { aweme: AW1, type: 'video' },
    { aweme: 'bad' },
  ] }, H);
  const j = await r.json();
  assert.deepEqual({ ...j, batch: undefined }, { ok: true, added: 3, skipped: 1, invalid: 1, batch: undefined });
  assert.equal(sheets().length, 1);
  assert.match(sheets()[0].text, /（#主页同步 #批次数量3 条）/);
  assert.equal(bidOf(sheets()[0]), j.batch);
  r = await post('/dy-progress', { stage: '抓作品', done: 30, total: 120 }, H);
  assert.equal(r.status, 200);
  reset();
  await dm(OWNER, '进度');
  assert.match(last('bot').text, /待审核 3/);
  assert.match(last('bot').text, /云电脑：抓作品 30\/120/);
  assert.equal((await post('/dy-import', { items: new Array(201).fill({}) }, H)).status, 413);
});

await test('审核通过整批：按发布时间从旧到新交出去；审核失败整批不转', async () => {
  const open = await L.openBatches(10);
  const B = open[open.length - 1].id;
  reset();
  await press(OWNER, `batch-ok:${B}`);
  assert.deepEqual(toStreamer.map(i => i.aweme).filter(a => a.startsWith('73000000000000001')), [C2, C3, C1]);
  assert.equal((await L.getBatch(B)).status, 'approved');
  // 再来一批，审核失败
  const r = await post('/dy-import', { items: [{ aweme: '7300000000000000104', type: 'video', video_url: 'https://cdn/c4.mp4' }] }, { 'X-Token': token });
  const B2 = (await r.json()).batch;
  await press(OWNER, `batch-no:${B2}`);
  assert.equal((await L.getItem('7300000000000000104')).status, 'rejected');
  assert.ok(sent.verify.some(m => m.method === 'editMessageText' && /❌ 审核失败：1 条不转/.test(m.text)));
});

await test('失败过的作品，云电脑再送来会用新地址重新待审核', async () => {
  const AW = '7300000000000000005';
  await L.addItems([normalizeItem({ aweme: AW, type: 'video', video_url: 'https://cdn.example/old.mp4' })], 'cloud');
  await L.review([AW], 'queued');
  for (let i = 0; i < 3; i++) await L.itemDone(AW, false, 0, 'x', 3);
  assert.equal((await L.getItem(AW)).status, 'failed');
  const r = await post('/dy-known', { ids: [AW] }, { 'X-Token': token });
  assert.deepEqual((await r.json()).known, []);
  await post('/dy-import', { items: [{ aweme: AW, type: 'video', video_url: 'https://cdn.example/new.mp4' }] }, { 'X-Token': token });
  const it = await L.getItem(AW);
  assert.equal(it.status, 'review');
  assert.equal(it.video_url, 'https://cdn.example/new.mp4');
  assert.equal(it.attempts, 0);
});

// ── 审核机器人私聊、管理接口 ──
await test('审核机器人私聊：把没审的审核单再发一遍；有审核单之前的待审作品凑成一张', async () => {
  await L.addItems([normalizeItem({ aweme: '7300000000000000006', type: 'video', desc: '老的待审' })], 'search');
  reset();
  await hook({ message: { chat: { id: OWNER, type: 'private' }, from: { id: OWNER }, text: '/start' } }, true);
  assert.equal(sheets().length, (await L.openBatches(5)).length);
  assert.ok(sheets().length >= 1);
  const old = sheets().find(m => /老的待审/.test(m.text));
  assert.match(old.text, /（#关键词搜索 #批次数量1 条）/);
  await press(OWNER, `batch-no:${bidOf(old)}`);
  await hook({ message: { chat: { id: STRANGER, type: 'private' }, from: { id: STRANGER }, text: '/start' } }, true);
  assert.match(last('verify').text, /只有频道主/);
});

await test('管理接口', async () => {
  const A = { Authorization: 'Bearer ' + ADMIN };
  let r = await call('/admin/api/state?status=review', { headers: A });
  const s = await r.json();
  assert.equal(s.items.length, 1);
  assert.equal(s.counts.videos, 1);
  r = await post('/admin/api/review', { ids: [s.items[0].aweme], to: 'rejected' }, A);
  assert.equal((await r.json()).n, 1);
  r = await post('/admin/api/video-delete', { id: 10 }, A);
  assert.equal(r.status, 200);
  assert.deepEqual((await (await call('/api/videos')).json()).videos, []);
  assert.equal((await post('/admin/api/review', { ids: [], to: 'x' }, A)).status, 400);
});

// ── 云电脑（流式服务里的 MediaCrawler）──
const SEC = 'MS4wLjABAAAAabcdefghijklmnop';
await test('「登录抖音」交给流式服务；忙的时候如实说', async () => {
  jobCalls.length = 0;
  await dm(OWNER, '登录抖音');
  assert.deepEqual(jobCalls, [['/douyin/login', { chat_id: OWNER }]]);
  assert.match(last('bot').text, /二维码大约半分钟后发过来/);
  state.busy = '同步作品';
  await dm(OWNER, '登录抖音');
  assert.match(last('bot').text, /正在「同步作品」/);
  state.busy = '';
  state.streamer = 'down';
  await dm(OWNER, '登录抖音');
  assert.match(last('bot').text, /没响应/);
  state.streamer = 'ok';
});

await test('登录进行中：验证码、验证方式、截图都转给登录页；没在登录就照常说没看懂', async () => {
  jobCalls.length = 0;
  state.busy = '登录抖音';
  await dm(OWNER, '123456');
  await dm(OWNER, '刷脸验证');
  assert.deepEqual(jobCalls, [['/douyin/login/input', { text: '123456' }], ['/douyin/login/input', { text: '刷脸验证' }]]);
  assert.match(last('bot').text, /已经交给抖音登录页/);
  reset();
  await dm(OWNER, '取消登录');
  assert.equal(sent.bot.length, 0); // 流式服务自己会说「好，不登录了」
  state.busy = '';
  await dm(OWNER, '654321');
  assert.match(last('bot').text, /没看懂/);
  // 发起登录超过 15 分钟：不再去问登录页
  jobCalls.length = 0;
  await L.setConfig('jobAt', String(Date.now() - 16 * 60 * 1000));
  await dm(OWNER, '刷脸验证');
  assert.deepEqual(jobCalls, []);
  await L.setConfig('jobAt', String(Date.now()));
});

await test('/dy-session 只收流式服务的', async () => {
  const body = { cookies: [{ name: 'sessionid', value: 's', domain: '.douyin.com' }, { bad: 1 }], sec_uid: SEC, nickname: '小橘' };
  assert.equal((await post('/dy-session', body, { 'X-Token': token })).status, 403);
  assert.equal((await post('/dy-session', { ...body, sec_uid: 'self' }, { 'X-Key': SKEY })).status, 400);
  assert.equal((await post('/dy-session', body, { 'X-Key': SKEY })).status, 200);
  const saved = JSON.parse(await L.getConfig('dySession'));
  assert.deepEqual(saved.cookies, [{ name: 'sessionid', value: 's', domain: '.douyin.com' }]);
  await dm(OWNER, '进度');
  assert.match(last('bot').text, /抖音账号：小橘/);
});

await test('「同步作品」带着登录状态交给流式服务；链接也交给它抓', async () => {
  jobCalls.length = 0;
  await dm(OWNER, '同步作品');
  assert.equal(jobCalls[0][0], '/douyin/crawl');
  assert.equal(jobCalls[0][1].mode, 'creator');
  assert.equal(jobCalls[0][1].chat_id, OWNER);
  assert.equal(jobCalls[0][1].session.sec_uid, SEC);
  await dm(OWNER, '看看 https://v.douyin.com/new1/ 和 https://v.douyin.com/new2/');
  assert.deepEqual(jobCalls[1][1].targets, ['https://v.douyin.com/new1/', 'https://v.douyin.com/new2/']);
  assert.equal(jobCalls[1][1].mode, 'detail');
});

await test('流式服务送来的作品：按来源打标签成审核单；Codespaces 令牌一律当主页同步', async () => {
  reset();
  const K = { 'X-Key': SKEY };
  let r = await post('/dy-import', { src: 'link', items: [{ aweme: '7300000000000000201', type: 'video', desc: '链接作品', video_url: 'https://cdn.example/201.mp4' }] }, K);
  assert.equal((await r.json()).added, 1);
  assert.equal(sheets().length, 1);
  assert.match(sheets()[0].text, /（#私聊链接 #批次数量1 条）/);
  assert.match(sheets()[0].text, /链接作品/);
  assert.deepEqual(sheets()[0].reply_markup.inline_keyboard[0].map(b => b.callback_data).map(d => d.split(':')[0]), ['batch-ok', 'batch-no']);
  reset();
  r = await post('/dy-import', { src: 'cloud', items: [{ aweme: '7300000000000000202', type: 'video', video_url: 'https://cdn.example/202.mp4' }] }, K);
  assert.match(sheets()[0].text, /（#主页同步 #批次数量1 条）/);
  reset();
  await post('/dy-import', { src: 'link', items: [{ aweme: '7300000000000000203', type: 'video', video_url: 'https://cdn.example/203.mp4' }] }, { 'X-Token': token });
  assert.match(sheets()[0].text, /（#主页同步 #批次数量1 条）/);
});

await test('/streamer-say：流式服务托 Worker 给频道主发消息和图片，别人不发', async () => {
  reset();
  const K = { 'X-Key': SKEY };
  assert.equal((await post('/streamer-say', { chat_id: OWNER, text: 'x' })).status, 403);
  assert.equal((await post('/streamer-say', { chat_id: STRANGER, text: 'x' }, K)).status, 403);
  let r = await post('/streamer-say', { chat_id: OWNER, text: '进度' }, K);
  assert.equal(r.status, 200);
  assert.equal(last('bot').method, 'sendMessage');
  assert.equal(last('bot').text, '进度');
  r = await post('/streamer-say', { chat_id: OWNER, text: '扫码', png: Buffer.from('PNGDATA').toString('base64') }, K);
  assert.equal(r.status, 200);
  const photo = last('bot');
  assert.equal(photo.method, 'sendPhoto');
  assert.equal(photo.chat_id, String(OWNER));
  assert.equal(photo.caption, '扫码');
  assert.equal(await photo.photo.text(), 'PNGDATA');
});

// ── 发件箱：HF 机房连不上 Worker，由 Worker 的定时器去流式服务那里取 ──
await test('交出活以后开始轮询；轮询期间再交活不重复设定时器', async () => {
  libStorage.alarm = null;
  await L.kick();
  assert.ok(libStorage.alarm > 0);
});

await test('定时器轮询发件箱：重启检测、转完的结果、二维码、登录状态、进度、链接抓来的作品', async () => {
  const AWX = '7300000000000000301';
  await L.addItems([normalizeItem({ aweme: AWX, type: 'video', video_url: 'https://cdn.example/301.mp4' })], 'link');
  await L.review([AWX], 'queued');
  await L.claimQueued(50, Date.now());
  reset();
  outboxCalls.length = 0;
  const png = Buffer.from('QRPNG').toString('base64');
  state.outbox = { boot: 'B1', busy: false, events: [
    { seq: 1, kind: 'done', aweme: AWX, ok: true, message_id: 77, idle: true },
    { seq: 2, kind: 'say', chat_id: OWNER, text: '扫码', png },
    { seq: 3, kind: 'say', chat_id: STRANGER, text: '别人' },
    { seq: 4, kind: 'session', cookies: [{ name: 'sessionid', value: 's2', domain: '.douyin.com' }], sec_uid: 'MS4wLjABAAAAnewaccount12345', nickname: '新号' },
    { seq: 5, kind: 'progress', stage: '抓主页', done: 20 },
    { seq: 6, kind: 'import', chat_id: OWNER, src: 'link', what: '1 条链接', items: [{ aweme: '7300000000000000302', type: 'video', desc: '抓来的', video_url: 'https://cdn.example/302.mp4' }] },
  ] };
  libStorage.alarm = null; // 定时器触发时就被用掉了
  await L.alarm();
  // 第一次见到这个启动号：当成重启（在转的放回队列再交），这一批不认，从序号 0 重新取
  assert.deepEqual(outboxCalls.map(c => [c.boot, c.after]), [['', 0], ['B1', 0], ['B1', 6]]);
  assert.equal(await L.getConfig('streamerBoot'), 'B1');
  assert.equal(await L.getConfig('outboxSeq'), '6');
  const it = await L.getItem(AWX);
  assert.equal(it.status, 'posted');
  assert.equal(it.msg, 77);
  const photo = sent.bot.find(m => m.method === 'sendPhoto');
  assert.equal(photo.chat_id, String(OWNER));
  assert.equal(await photo.photo.text(), 'QRPNG');
  assert.ok(!sent.bot.some(m => m.chat_id === STRANGER || m.chat_id === String(STRANGER)));
  assert.equal(JSON.parse(await L.getConfig('dySession')).nickname, '新号');
  assert.match(sent.bot.map(m => m.text).join('\n'), /抓完了：一共 1 条，0 条以前收过，新的 1 条在审核单 [a-z0-9]{14}/);
  assert.equal(sheets().filter(m => /抓来的/.test(m.text)).length, 1);
  assert.equal(JSON.parse(await L.getConfig('cloudProgress')).stage, '完成');
  assert.equal(libStorage.alarm, null); // 不忙了：不再设定时器
});

await test('流式服务重启：启动号变了，在转的放回队列重交，序号从头算', async () => {
  const AWY = '7300000000000000303';
  await L.addItems([normalizeItem({ aweme: AWY, type: 'video', video_url: 'https://cdn.example/303.mp4' })], 'link');
  await L.review([AWY], 'queued');
  await L.claimQueued(50, Date.now());
  reset();
  outboxCalls.length = 0;
  state.outbox = { boot: 'B2', busy: false, events: [{ seq: 1, kind: 'say', chat_id: OWNER, text: '重启后的第一句' }] };
  await L.alarm();
  assert.deepEqual(outboxCalls.map(c => [c.boot, c.after]), [['B1', 6], ['B2', 0], ['B2', 1]]);
  assert.ok(toStreamer.some(i => i.aweme === AWY)); // 重交了
  assert.equal((await L.getItem(AWY)).status, 'sending');
  assert.ok(sent.bot.some(m => m.text === '重启后的第一句'));
  assert.ok(Number(await L.getConfig('streamerUp')) > 0);
});

async function cron() {
  const pending = [];
  await worker.scheduled({}, env, { waitUntil: p => pending.push(p) });
  await Promise.all(pending);
}

await test('定时任务：有交出去没回音的就去轮询，闲着不去', async () => {
  libStorage.alarm = null;
  await cron();
  assert.ok(libStorage.alarm > 0); // 还有在转的
  for (const it of await L.listItems('sending', 100, '')) await L.itemDone(it.aweme, true, 1, '', 3);
  await L.setConfig('jobAt', '0');
  libStorage.alarm = null;
  await cron();
  const c = await L.counts();
  assert.equal(c.sending || 0, 0);
  assert.equal(c.queued || 0, 0);
  assert.equal(libStorage.alarm, null);
});

await test('管理接口：替频道主发起抖音登录、开始轮询', async () => {
  const A = { Authorization: 'Bearer ' + ADMIN };
  jobCalls.length = 0;
  libStorage.alarm = null;
  const r = await post('/admin/api/douyin-login', {}, A);
  assert.equal(r.status, 200);
  assert.deepEqual(jobCalls, [['/douyin/login', { chat_id: OWNER }]]);
  assert.match(last('bot').text, /二维码大约半分钟后发过来/);
  assert.ok(libStorage.alarm > 0);
  libStorage.alarm = null;
  assert.equal((await post('/admin/api/poll', {}, A)).status, 200);
  assert.ok(libStorage.alarm > 0);
  assert.equal((await post('/admin/api/douyin-login', {}, {})).status, 403);
});

await test('带按钮的话：键盘临时换成登录页的选项；登录结束换回菜单', async () => {
  reset();
  const png = Buffer.from('SHOT').toString('base64');
  state.outbox = { boot: 'B2', busy: false, events: [
    { seq: 2, kind: 'say', chat_id: OWNER, text: '要验证', png, buttons: ['刷脸验证', '短信验证', '截图', '取消登录'] },
    { seq: 3, kind: 'say', chat_id: OWNER, text: '登录好了', png: null, buttons: null, menu: true },
  ] };
  await L.alarm();
  const photo = sent.bot.find(m => m.method === 'sendPhoto');
  assert.deepEqual(JSON.parse(photo.reply_markup).keyboard, [[{ text: '刷脸验证' }, { text: '短信验证' }], [{ text: '截图' }, { text: '取消登录' }]]);
  assert.equal(JSON.parse(photo.reply_markup).one_time_keyboard, true);
  const done = sent.bot.find(m => m.text === '登录好了');
  assert.deepEqual(done.reply_markup.keyboard[0].map(b => b.text), ['登录抖音', '同步作品']);
});

// ── 关键词搜索：一批一张审核单；通过过的号记住，下次标 ✓ ──
await test('「搜索 关键词」交给流式服务；没给关键词说用法', async () => {
  jobCalls.length = 0;
  await dm(OWNER, '搜索 坏脾气小橘，小橘 猫咪、第三个');
  assert.equal(jobCalls[0][0], '/douyin/crawl');
  assert.equal(jobCalls[0][1].mode, 'search');
  assert.deepEqual(jobCalls[0][1].targets, ['坏脾气小橘', '小橘 猫咪', '第三个']);
  assert.ok(jobCalls[0][1].session.sec_uid);
  assert.equal(jobCalls[0][1].count, undefined); // 没写数量：流式服务按默认的 50
  await dm(OWNER, '搜索 坏脾气小橘，猫咪 120条');
  assert.deepEqual(jobCalls[1][1].targets, ['坏脾气小橘', '猫咪']);
  assert.equal(jobCalls[1][1].count, 120);
  await dm(OWNER, '搜索 小橘 9999');
  assert.equal(jobCalls[2][1].count, 500);
  await dm(OWNER, '搜索 2024');
  assert.match(last('bot').text, /发「搜索 关键词 数量」/); // 只有数字：没关键词
  await dm(OWNER, '搜索');
  assert.match(last('bot').text, /发「搜索 关键词 数量」/);
});

const ALT = 'MS4wLjABAAAAmyaltaccount0001', OTHER = 'MS4wLjABAAAAsomeoneelse0001';
const sitem = (n, author, sec) => ({ aweme: `73000000000000005${n}`, type: 'video', desc: `搜到的${n}`, author, author_sec_uid: sec, video_url: `https://cdn.example/s${n}.mp4` });
let SB;
await test('搜索结果：一张审核单，标签带关键词，列出作者，只有两个按钮', async () => {
  reset();
  await importBatch([sitem(1, '小号一', ALT), sitem(2, '路人', OTHER)]);
  assert.equal(sheets().length, 1);
  const sh = sheets()[0];
  SB = bidOf(sh);
  assert.match(sh.text, /（#关键词搜索 #橘猫 #猫 #批次数量2 条）/);
  assert.match(sh.text, /作者：小号一 ×1、路人 ×1/);
  assert.doesNotMatch(sh.text, /✓/);
  assert.equal(sh.reply_markup.inline_keyboard.flat().length, 2);
  const page = await call(`/review/${bidOf(sh)}`);
  assert.equal(page.status, 200);
  const html = await page.text();
  assert.match(html, /搜到的1/);
  assert.match(html, new RegExp(`douyin.com/user/${ALT}`));
  assert.equal((await call('/review/aaaaaaaaaaaaaa')).status, 404);
});

await test('审核通过：整批作者记住；下次这些号的作品在审核单上标 ✓；审核失败的不记', async () => {
  await press(OWNER, `batch-ok:${SB}`);
  assert.deepEqual(JSON.parse(await L.getConfig('myAccounts')), [ALT, OTHER]);
  assert.notEqual((await L.getItem('730000000000000051')).status, 'review');
  reset();
  const THIRD = 'MS4wLjABAAAAthirdperson0001';
  await importBatch([sitem(3, '小号一', ALT), sitem(4, '第三人', THIRD)]);
  const sh = sheets()[0];
  assert.match(sh.text, /小号一 ×1 ✓/);
  assert.match(sh.text, /第三人 ×1(?! ✓)/);
  await press(OWNER, `batch-no:${bidOf(sh)}`);
  assert.equal((await L.getItem('730000000000000054')).status, 'rejected');
  assert.deepEqual(JSON.parse(await L.getConfig('myAccounts')), [ALT, OTHER]);
});

async function importBatch(items) {
  const seq = (Number(await L.getConfig('outboxSeq')) || 0) + 1;
  state.outbox = { boot: await L.getConfig('streamerBoot'), busy: false, events: [{ seq, kind: 'import', chat_id: OWNER, src: 'search', what: '「橘猫」「猫」', items }] };
  await L.alarm();
}

await test('已经登录了再点「登录抖音」：不登录；「重新登录」才登录', async () => {
  jobCalls.length = 0;
  await dm(OWNER, '登录抖音');
  assert.deepEqual(jobCalls, []);
  assert.match(last('bot').text, /已经登录了「新号」，不用再登录/);
  await dm(OWNER, '重新登录');
  assert.deepEqual(jobCalls, [['/douyin/login', { chat_id: OWNER }]]);
});

// ── 小号：发主页链接就加上，抓到的直接转；每天定时自动同步 ──
const ALT2 = 'MS4wLjABAAAAmyaltaccount0002', ALT3 = 'MS4wLjABAAAAmyaltaccount0003';
await test('发小号主页短链接：记成小号，交云电脑抓它的主页；一起发的作品链接请他之后再发', async () => {
  jobCalls.length = 0;
  state.expand['https://v.douyin.com/alt2/'] = { sec_uid: ALT2 };
  state.expand['https://v.douyin.com/work9/'] = { aweme: '7300000000000000900' };
  await dm(OWNER, '长按复制此条消息，打开抖音搜索，查看TA的更多作品。 https://v.douyin.com/alt2/ https://v.douyin.com/work9/');
  assert.deepEqual(JSON.parse(await L.getConfig('altAccounts')).map(a => a.sec), [ALT2]);
  assert.equal(jobCalls[0][1].mode, 'accounts');
  assert.deepEqual(jobCalls[0][1].targets, [ALT2]);
  const said = sent.bot.map(m => m.text).join('\n');
  assert.match(said, /加了 1 个小号/);
  assert.match(said, /1 条作品链接，等这次抓完再发一次/);
  // 长链接不用问流式服务；加过的不重复记
  jobCalls.length = 0;
  await dm(OWNER, `https://www.douyin.com/user/${ALT2}?from_tab_name=main`);
  assert.match(last('bot').text, /以前加过了/);
  assert.equal(JSON.parse(await L.getConfig('altAccounts')).length, 1);
  assert.deepEqual(jobCalls[0][1].targets, [ALT2]);
});

await test('小号抓来的作品：小号的直接排队转发不用审；登录账号自己的照常成审核单', async () => {
  reset();
  const own = JSON.parse(await L.getConfig('dySession')).sec_uid;
  const seq = (Number(await L.getConfig('outboxSeq')) || 0) + 1;
  state.outbox = { boot: await L.getConfig('streamerBoot'), busy: false, events: [{ seq, kind: 'import', chat_id: OWNER, src: 'alt', what: '小号主页', items: [
    { aweme: '7300000000000000601', type: 'video', desc: '小号作品', author: '小号二', author_sec_uid: ALT2, video_url: 'https://cdn.example/601.mp4' },
    { aweme: '7300000000000000602', type: 'video', desc: '大号作品', author: '新号', author_sec_uid: own, video_url: 'https://cdn.example/602.mp4' },
    { aweme: AW1, type: 'video', author_sec_uid: ALT2 },
  ] }] };
  await L.alarm();
  assert.equal((await L.getItem('7300000000000000601')).status, 'sending');
  assert.ok(toStreamer.some(i => i.aweme === '7300000000000000601'));
  assert.equal((await L.getItem('7300000000000000602')).status, 'review');
  assert.equal(sheets().length, 1);
  assert.match(sheets()[0].text, /（#主页同步 #批次数量1 条）/);
  assert.match(sent.bot.map(m => m.text).join('\n'), /抓完了：一共 3 条，1 条以前收过，新的 1 条是小号的作品，已经排队转进频道；新的 1 条在审核单/);
  assert.equal(JSON.parse(await L.getConfig('altAccounts'))[0].name, '小号二');
});

await test('边抓边交：小号的每段一到就转；要审的并进同一张审核单（原地改条数）；最后一段才发汇总', async () => {
  reset();
  const own = JSON.parse(await L.getConfig('dySession')).sec_uid;
  const it = (n, sec) => ({ aweme: `73000000000000007${n}`, type: 'video', desc: `段${n}`, author: sec === ALT2 ? '小号二' : '新号', author_sec_uid: sec, video_url: `https://cdn.example/7${n}.mp4` });
  const send = async (events) => {
    let seq = Number(await L.getConfig('outboxSeq')) || 0;
    state.outbox = { boot: await L.getConfig('streamerBoot'), busy: false, events: events.map(e => ({ seq: ++seq, kind: 'import', chat_id: OWNER, src: 'alt', what: '小号主页', job: 'abc123abc123', ...e })) };
    await L.alarm();
  };
  await send([{ final: false, items: [it(1, ALT2), it(2, own)] }]);
  assert.equal((await L.getItem('730000000000000071')).status, 'sending'); // 没等抓完就转了
  assert.equal(sheets().length, 1);
  assert.match(sheets()[0].text, /#批次数量1 条/);
  assert.ok(!sent.bot.some(m => /抓完了/.test(m.text || ''))); // 还没发汇总
  // 进度卡：第一段到了就发，之后原地改
  const card = sent.bot.find(m => m.method === 'sendMessage' && /📥 抓取进度：小号主页/.test(m.text));
  assert.match(card.text, /⏳ 正在抓/);
  assert.match(card.text, /抓到 2 条：新的 2 条/);
  assert.match(card.text, /小号的作品 1 条：✅ 已转 0 · ⏳ 排队\/在转 1 · ❌ 失败 0/);
  assert.match(card.text, /要审核的 1 条（审核单 [a-z0-9]{14}，等你审核）/);
  assert.match(JSON.parse(await L.getConfig('cloudProgress')).note, /边抓边交：新的 2 条/);
  await send([{ final: false, items: [it(3, own), it(4, ALT2)] }, { final: true, items: [it(5, own)] }]);
  assert.equal(sheets().length, 1); // 没发新单子
  const edits = sent.verify.filter(m => m.method === 'editMessageText' && /🛂 审核单/.test(m.text));
  assert.match(edits[edits.length - 1].text, /#批次数量3 条/);
  assert.deepEqual(edits[edits.length - 1].reply_markup.inline_keyboard[0].map(b => b.callback_data), [`batch-ok:${bidOf(sheets()[0])}`, `batch-no:${bidOf(sheets()[0])}`]);
  assert.equal((await L.getItem('730000000000000074')).status === 'review', false);
  const sum = sent.bot.filter(m => /^抓完了/.test(m.text || ''));
  assert.equal(sum.length, 1);
  assert.match(sum[0].text, /一共 5 条，0 条以前收过，新的 2 条是小号的作品，已经排队转进频道；新的 3 条在审核单/);
  const cardEdits = sent.bot.filter(m => m.method === 'editMessageText' && /📥/.test(m.text));
  assert.match(cardEdits[cardEdits.length - 1].text, /✅ 抓完了/);
  assert.match(cardEdits[cardEdits.length - 1].text, /抓到 5 条：新的 5 条/);
  // 转完一条改一次卡；审核单审完、小号的都转完：说一声全部转完
  let seq = Number(await L.getConfig('outboxSeq'));
  state.outbox = { boot: await L.getConfig('streamerBoot'), busy: false, events: [
    { seq: ++seq, kind: 'done', aweme: '730000000000000071', ok: true, message_id: 801 },
    { seq: ++seq, kind: 'done', aweme: '730000000000000074', ok: false, error: '下载 403', idle: true },
  ] };
  for (let i = 0; i < 2; i++) await L.itemDone('730000000000000074', false, 0, 'x', 3); // 满次数记失败
  await L.alarm();
  const latest = sent.bot.filter(m => m.method === 'editMessageText' && /📥/.test(m.text)).pop();
  assert.match(latest.text, /小号的作品 2 条：✅ 已转 1 · ⏳ 排队\/在转 0 · ❌ 失败 1/);
  assert.ok(!sent.bot.some(m => /🎉.*全部转完/.test(m.text || ''))); // 审核单还没审
  await press(OWNER, `batch-no:${bidOf(sheets()[0])}`);
  const done = sent.bot.filter(m => /🎉.*全部转完/.test(m.text || ''));
  assert.equal(done.length, 1);
  assert.match(done[0].text, /成功 1 条，失败 1 条（发「重试失败」再试一次）/);
  await L.alarm();
  assert.equal(sent.bot.filter(m => /🎉.*全部转完/.test(m.text || '')).length, 1); // 只说一次
  // 中途审过了：后面送来的另开一张
  reset();
  await send([{ job: 'def456def456', final: false, items: [it(6, own)] }]);
  await press(OWNER, `batch-ok:${bidOf(sheets()[0])}`);
  reset();
  await send([{ job: 'def456def456', final: true, items: [it(7, own)] }]);
  assert.equal(sheets().length, 1);
  assert.match(sheets()[0].text, /#批次数量1 条/);
  assert.equal((await L.getItem('730000000000000077')).status, 'review');
});

await test('「小号」列表、「同步小号」、「删除小号」', async () => {
  await L.setConfig('altAccounts', JSON.stringify([...JSON.parse(await L.getConfig('altAccounts')), { sec: ALT3, name: '', at: 1 }]));
  await dm(OWNER, '小号');
  assert.match(last('bot').text, /1\. 小号二/);
  assert.match(last('bot').text, /1\. 小号二\n   收了 \d+ 条：✅ 已转 1 · ⏳ 排队\/在转 \d+ · ❌ 失败 1；上次抓 \d+ 秒前\n   https:\/\/www\.douyin\.com\/user\//);
  assert.match(last('bot').text, /2\. （还没抓过，不知道昵称）\n   还没收到作品/);
  await dm(OWNER, '进度');
  assert.match(last('bot').text, /小号 2 个：✅ 已转 1 · ⏳ 排队\/在转 \d+ · ❌ 失败 1（发「小号」看每个号的）/);
  await dm(OWNER, '小号');
  assert.match(last('bot').text, /2\. （还没抓过/);
  assert.match(last('bot').text, /自动同步：每天 4 点/);
  jobCalls.length = 0;
  await dm(OWNER, '同步小号');
  assert.deepEqual(jobCalls[0][1], { chat_id: OWNER, mode: 'accounts', targets: [ALT2, ALT3], session: jobCalls[0][1].session });
  await dm(OWNER, '删除小号 2');
  assert.match(last('bot').text, /删掉了小号/);
  assert.deepEqual(JSON.parse(await L.getConfig('altAccounts')).map(a => a.sec), [ALT2]);
  await dm(OWNER, '删除小号 9');
  assert.match(last('bot').text, /没有这个编号/);
});

await test('自动同步：到点抓小号和登录账号，一天一次；可以改时间、关掉', async () => {
  const hour = new Date(Date.now() + 8 * 3600 * 1000).getUTCHours();
  await dm(OWNER, `自动同步 ${(hour + 1) % 24}`);
  assert.match(last('bot').text, new RegExp(`每天 ${(hour + 1) % 24} 点`));
  jobCalls.length = 0;
  await cron();
  assert.deepEqual(jobCalls.filter(c => c[0] === '/douyin/crawl'), []); // 还没到点
  await dm(OWNER, `自动同步 ${hour}`);
  await cron();
  const own = JSON.parse(await L.getConfig('dySession')).sec_uid;
  const crawls = jobCalls.filter(c => c[0] === '/douyin/crawl');
  assert.equal(crawls.length, 1);
  assert.equal(crawls[0][1].mode, 'accounts');
  assert.deepEqual(crawls[0][1].targets, [ALT2, own]);
  await cron();
  assert.equal(jobCalls.filter(c => c[0] === '/douyin/crawl').length, 1); // 今天发起过了
  // 云电脑忙：这次不算，下个 5 分钟再试
  await L.setConfig('autoSync', JSON.stringify({ on: true, hour, day: '' }));
  state.busy = '搜索';
  await cron();
  state.busy = '';
  assert.equal(JSON.parse(await L.getConfig('autoSync')).day, '');
  await dm(OWNER, '自动同步 关');
  jobCalls.length = 0;
  await L.setConfig('autoSync', JSON.stringify({ ...JSON.parse(await L.getConfig('autoSync')), day: '' }));
  await cron();
  assert.deepEqual(jobCalls.filter(c => c[0] === '/douyin/crawl'), []);
  await dm(OWNER, '自动同步 25');
  assert.match(last('bot').text, /0 到 23/);
});

await test('补全视频池：翻频道历史，只收视频的播放字段；登记过的不动；翻完告诉频道主', async () => {
  const A = { Authorization: 'Bearer ' + ADMIN };
  await channelPost({ message_id: 40, video: { file_id: 'VREG', file_size: 100, duration: 1, width: 1, height: 1, mime_type: 'video/mp4' } });
  const before = (await L.counts()).videos;
  // 流式服务翻出来的（40 已经登记过，带 file_id）
  state.channel = [
    { id: 5, size: 1000, duration: 3, width: 720, height: 1280, mime: 'video/mp4', date: 1600000000 },
    { id: 6, size: 30 * 1024 * 1024, duration: 60, width: 1080, height: 1920, mime: 'video/mp4', date: 1600000100, caption: '不该有的' },
    { id: 40, size: 1, duration: 1, width: 1, height: 1, mime: 'video/mp4', date: 1 },
  ];
  channelCalls.length = 0;
  reset();
  let r = await post('/admin/api/scan-channel', { reset: true }, A);
  const j = await r.json();
  assert.equal(j.done, true);
  assert.equal(j.added, 2);
  assert.equal((await L.counts()).videos, before + 2);
  assert.equal((await L.getVideo(40)).file_id, 'VREG'); // 登记过的不动
  const v5 = await L.getVideo(5);
  assert.deepEqual(Object.keys(v5).sort(), ['date', 'duration', 'file_id', 'height', 'id', 'mime', 'size', 'thumb', 'width']);
  assert.ok(!JSON.stringify(await L.getVideo(6)).includes('不该有的'));
  assert.match(last('bot').text, /视频池补全了：翻完频道历史，补进 2 条以前的视频/);
  // 没有 file_id 的小视频也走流式服务
  bigFiles.set(5, new Uint8Array(1000).fill(5));
  r = await call('/vf/5', { headers: { Range: 'bytes=0-9' } });
  assert.equal(r.status, 206);
  assert.deepEqual([...new Uint8Array(await r.arrayBuffer())], new Array(10).fill(5));
  // 翻完了：定时任务不再去翻
  channelCalls.length = 0;
  await cron();
  assert.equal(channelCalls.length, 0);
  // 分页：每次 500 条，翻到头为止
  state.channel = Array.from({ length: 1200 }, (_, i) => ({ id: 10000 + i, size: 10, duration: 1, width: 1, height: 1, mime: 'video/mp4', date: 1 }));
  channelCalls.length = 0;
  await post('/admin/api/scan-channel', { reset: true }, A);
  assert.deepEqual(channelCalls.map(c => c.after), [0, 10499, 10999]);
  assert.equal(JSON.parse(await L.getConfig('channelScan')).added, 1200);
  for (const v of [...state.channel, { id: 5 }, { id: 6 }, { id: 40 }]) await L.removeVideo(v.id);
});

await test('心碎：要网页口令；删掉频道原帖、拿出视频池、告诉频道主；机器人删不了让频道主账号删；都不行定时再删', async () => {
  const vid = (id) => channelPost({ message_id: id, video: { file_id: 'V' + id, file_size: 100, duration: 75, width: 720, height: 1280, mime_type: 'video/mp4' } });
  await vid(50);
  // 拿口令：每次换新的
  await dm(OWNER, '网页口令');
  const key1 = /#key=([0-9a-f]{48})/.exec(last('bot').text)[1];
  assert.match(last('bot').text, new RegExp(`${ORIGIN}/video#key=`));
  await dm(OWNER, '网页口令');
  const key = /#key=([0-9a-f]{48})/.exec(last('bot').text)[1];
  assert.notEqual(key, key1);
  // 没口令、旧口令：不删
  assert.equal((await post('/api/heartbreak', { id: 50 })).status, 403);
  assert.equal((await post('/api/heartbreak', { id: 50, key: key1 })).status, 403);
  assert.ok(await L.getVideo(50));
  // 机器人删得了
  reset();
  let r = await post('/api/heartbreak', { id: 50, key });
  assert.deepEqual(await r.json(), { ok: true, deleted: true });
  assert.deepEqual(sent.bot.filter(m => m.method === 'deleteMessage').map(m => [m.chat_id, m.message_id]), [[String(CHANNEL), 50]]);
  assert.equal(await L.getVideo(50), null);
  assert.match(last('bot').text, /💔 心碎：已删掉频道原帖 #50（1:15，720×1280）/);
  assert.deepEqual(await (await post('/api/heartbreak', { id: 50, key })).json(), { ok: true, gone: true });
  // 编辑帖子、翻历史都不回来
  await vid(50);
  assert.equal(await L.getVideo(50), null);
  assert.equal(await L.addScannedVideos([{ id: 50, file_id: '', size: 1, date: 1 }]), 0);
  // 机器人删不了：频道主账号删
  await vid(51);
  state.botDelete = 'fail';
  userDeletes.length = 0;
  r = await post('/api/heartbreak', { id: 51, key });
  assert.equal((await r.json()).deleted, true);
  assert.deepEqual(userDeletes, [51]);
  // 都删不了：先拿出视频池，定时任务再删
  await vid(52);
  state.userDelete = false;
  r = await post('/api/heartbreak', { id: 52, key });
  assert.equal((await r.json()).deleted, false);
  assert.equal(await L.getVideo(52), null);
  assert.match(last('bot').text, /频道原帖这会儿没删成，定时任务会接着删/);
  await dm(OWNER, '心碎');
  assert.match(last('bot').text, /#52 .*原帖还没删成/);
  assert.match(last('bot').text, /#51 /);
  state.userDelete = true;
  await cron();
  assert.deepEqual(JSON.parse(await L.getConfig('pendingDeletes')), []);
  state.botDelete = 'ok';
  // 一小时最多删 60 条
  for (let i = 0; i < 57; i++) { await L.upsertVideo({ id: 1000 + i, file_id: 'F', size: 1, date: 1, mime: 'video/mp4' }); await post('/api/heartbreak', { id: 1000 + i, key }); }
  await vid(53);
  assert.equal((await post('/api/heartbreak', { id: 53, key })).status, 429);
  assert.ok(await L.getVideo(53));
  await L.removeVideo(53);
  // 旧的「恢复」按钮不再管用
  await hook({ update_id: 7, callback_query: { id: 'cb2', from: { id: OWNER }, data: 'restore:50', message: { message_id: 33, chat: { id: OWNER } } } });
  assert.match(last('bot').text, /已经不用了/);
});

await test('网页', async () => {
  for (const p of ['/', '/video', '/admin']) {
    const r = await call(p);
    assert.equal(r.status, 200);
    assert.match(r.headers.get('Content-Type'), /text\/html/);
  }
  assert.equal((await call('/nope')).status, 404);
  assert.equal((await call('/tg-webhook')).status, 405);
});

console.log(`✓ ${n} 项测试全部通过`);
