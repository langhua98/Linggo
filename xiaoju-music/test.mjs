// 本地测试：Node 自带的 SQLite 模拟 Durable Object，再模拟 Telegram 和切片服务，逐条验证 worker.js
import assert from 'node:assert/strict';
import { register } from 'node:module';
import { DatabaseSync } from 'node:sqlite';

register('./test/hooks.mjs', import.meta.url);
const { default: worker, Library } = await import('./worker.js');

const TOKEN = '123:SECRET-BOT-TOKEN';
const HOOK = 'hook-secret';
const ADMIN = 'admin-key-123';
const SKEY = 'splitter-key-456';
const SPLITTER = 'https://splitter.example';
const CHANNEL = -1003817921075;
const STORAGE = '-1009999999999';
const MB = 1024 * 1024;
const PART = 19 * MB;
const LIMIT = 20 * MB;

// ── 模拟 Durable Object（SQLite + 结构化克隆，和 RPC 一样不共享引用）──
function makeSql() {
  const db = new DatabaseSync(':memory:');
  return { exec: (query, ...params) => { const rows = db.prepare(query).all(...params).map(r => ({ ...r })); return { toArray: () => rows }; } };
}
async function makeLibrary(env) {
  let ready;
  const ctx = { storage: { sql: makeSql() }, blockConcurrencyWhile(fn) { ready = fn(); return ready; } };
  const lib = new Library(ctx, env);
  await ready;
  return new Proxy({}, {
    get: (_, name) => name === 'then' ? undefined : async (...args) => structuredClone(await lib[name](...structuredClone(args))),
  });
}
// 旧版的 KV：每页只给 1 条，逼出分页
function makeKV(records) {
  const m = new Map(records.map(r => ['t:' + r.id, JSON.stringify(r)]));
  return {
    async get(k, type) { const v = m.get(k); return v == null ? null : type === 'json' ? JSON.parse(v) : v; },
    async list({ prefix, cursor }) {
      const keys = [...m.keys()].filter(k => k.startsWith(prefix)).sort();
      const start = cursor ? Number(cursor) : 0;
      const done = start + 1 >= keys.length;
      return { keys: keys.slice(start, start + 1).map(name => ({ name })), list_complete: done, cursor: done ? '' : String(start + 1) };
    },
  };
}

// ── 模拟 Telegram 和切片服务 ──
const files = new Map(); // file_id -> 字节
let seq = 0;
const addFile = bytes => { const id = 'F' + (++seq); files.set(id, bytes); return id; };
const bytesOf = (n, seed) => { const b = new Uint8Array(n); for (let i = 0; i < n; i++) b[i] = (i * 7 + seed + (i >> 12)) & 255; return b; };
const calls = [];
const sent = [];
const jobs = [];
const mode = { getFile: 'ok', expireOnce: false, splitter: 'ok', send: 'ok' };

globalThis.fetch = async (input, init = {}) => {
  const url = String(input);
  const headers = new Headers(init.headers || {});
  calls.push({ url, range: headers.get('Range') });
  if (url.startsWith(SPLITTER)) {
    if (mode.splitter === 'down') throw new TypeError('fetch failed');
    assert.equal(url, SPLITTER + '/split');
    assert.equal(headers.get('X-Key'), SKEY);
    jobs.push(JSON.parse(init.body));
    return Response.json({ accepted: true }, { status: mode.splitter === 'error' ? 500 : 200 });
  }
  assert.ok(url.startsWith('https://api.telegram.org/'), 'unexpected fetch ' + url);
  let m;
  if ((m = url.match(/\/bot[^/]+\/getFile\?file_id=(.+)$/))) {
    const f = files.get(decodeURIComponent(m[1]));
    if (!f) return Response.json({ ok: false, error_code: 400, description: 'Bad Request: invalid file_id' });
    if (mode.getFile === 'fail') return Response.json({ ok: false, error_code: 500, description: 'Internal Server Error' });
    if (f.length > LIMIT) return Response.json({ ok: false, error_code: 400, description: 'Bad Request: file is too big' });
    return Response.json({ ok: true, result: { file_path: 'music/' + m[1] + '.bin' } });
  }
  if ((m = url.match(/\/file\/bot[^/]+\/music\/(.+)\.bin$/))) {
    if (mode.expireOnce) { mode.expireOnce = false; return new Response('Not Found', { status: 404 }); }
    const f = files.get(m[1]);
    const range = headers.get('Range');
    if (!range) return new Response(f, { headers: { 'Content-Length': String(f.length) } });
    const [a, b] = range.replace('bytes=', '').split('-');
    const start = Number(a), end = b ? Number(b) : f.length - 1;
    return new Response(f.slice(start, end + 1), {
      status: 206, headers: { 'Content-Length': String(end - start + 1), 'Content-Range': `bytes ${start}-${end}/${f.length}` },
    });
  }
  if (url.endsWith('/sendDocument')) {
    const fd = await new Response(init.body, { headers: { 'Content-Type': headers.get('Content-Type') } }).formData();
    if (mode.send === '429') {
      return Response.json({ ok: false, error_code: 429, description: 'Too Many Requests: retry after 7', parameters: { retry_after: 7 } }, { status: 429 });
    }
    const doc = fd.get('document');
    const bytes = new Uint8Array(await doc.arrayBuffer());
    const id = addFile(bytes);
    sent.push({ chat_id: fd.get('chat_id'), caption: fd.get('caption'), name: doc.name, quiet: fd.get('disable_notification'), raw: fd.get('disable_content_type_detection') });
    return Response.json({ ok: true, result: { message_id: 1000 + seq, document: { file_id: id, file_unique_id: 'U' + id, file_name: doc.name, file_size: bytes.length } } });
  }
  throw new Error('unexpected fetch ' + url);
};

// ── 被测环境 ──
const oldTracks = [
  { id: 4, kind: 'audio', file_id: addFile(bytesOf(3000, 4)), file_unique_id: 'U4', title: '谁', performer: '张万森 @auvvip', name: '张万森 谁.mp3', mime: 'audio/mpeg', size: 3000, duration: 291, date: 1, caption: '' },
  { id: 12, kind: 'audio', file_id: 'BIG12', file_unique_id: 'U12', title: '抖音热播 Vol.12', performer: '', name: 'vol12.mp3', mime: 'audio/mpeg', size: 288727066, duration: 7209, date: 2, caption: '' },
];
const env = {
  TG_BOT_TOKEN: TOKEN, TG_WEBHOOK_SECRET: HOOK, ADMIN_KEY: ADMIN, SPLITTER_KEY: SKEY, SPLITTER_URL: SPLITTER + '/',
  CHANNEL_ID: String(CHANNEL), CHANNEL_USERNAME: 'xiaojumusic', BOT_USERNAME: 'xiaoju_music_bot', TRACKS: makeKV(oldTracks),
};
const lib = await makeLibrary(env);
env.LIB = { idFromName: n => n, get: () => lib };
const waits = [];
const ctx = { waitUntil: p => waits.push(p) };
const settle = async () => { while (waits.length) await waits.shift(); };

const BASE = 'https://xiaoju-music.example.workers.dev';
const req = (path, init) => worker.fetch(new Request(BASE + path, init), env, ctx);
const hook = (update, secret = HOOK) => req('/tg-webhook', {
  method: 'POST', headers: { 'Content-Type': 'application/json', 'X-Telegram-Bot-Api-Secret-Token': secret }, body: JSON.stringify(update),
});
const admin = (action, payload, key = ADMIN) => req('/admin/api/' + action, payload === undefined
  ? { headers: { Authorization: 'Bearer ' + key } }
  : { method: 'POST', headers: { Authorization: 'Bearer ' + key, 'Content-Type': 'application/json' }, body: JSON.stringify(payload) });
const putPart = (track, index, count, bytes) => req(`/admin/api/part?track=${track}&index=${index}&count=${count}`, {
  method: 'POST', headers: { Authorization: 'Bearer ' + ADMIN, 'Content-Type': 'application/octet-stream', 'Content-Length': String(bytes.length) }, body: bytes,
});
const chat = { id: CHANNEL, type: 'channel', username: 'xiaojumusic', title: '小橘🍊音乐' };
const audioPost = (id, extra = {}) => ({ message_id: id, chat, date: 1700000000 + id, audio: { file_name: `song${id}.mp3`, mime_type: 'audio/mpeg', title: '歌' + id, file_unique_id: 'U' + id, ...extra } });

const seen = []; // 所有响应的开头和头部，最后查有没有泄露
async function bytes(res) {
  const b = new Uint8Array(await res.arrayBuffer());
  seen.push(new TextDecoder().decode(b.slice(0, 4000)) + JSON.stringify([...res.headers]));
  return b;
}
const textOf = async res => new TextDecoder().decode(await bytes(res));
const jsonOf = async res => JSON.parse(await textOf(res));
const publicTracks = async () => (await jsonOf(await req('/api/tracks'))).tracks;
const adminState = async () => jsonOf(await admin('state'));
const find = (list, id) => list.find(t => t.id === id);
const tgCalls = () => calls.filter(c => c.url.startsWith('https://api.telegram.org/'));

let n = 0;
async function t(name, fn) { await fn(); await settle(); n++; console.log('ok', name); }

// ─────────────────────────────────────────────────────────────

await t('第一次启动把 KV 里的旧歌单迁进来（分页读全），大文件标成等待处理', async () => {
  const list = await publicTracks();
  assert.deepEqual(list.map(x => x.id), [12, 4]);
  assert.equal(find(list, 4).playable, true);
  assert.equal(find(list, 4).downloadable, true);
  assert.equal(find(list, 12).playable, false);
  assert.equal(find(list, 12).status, 'pending');
  assert.ok(!JSON.stringify(list).includes('file_id') && !JSON.stringify(list).includes('note'));
});

await t('webhook：密钥错误 403；登记 mp3、m4a（纠正类型）、wav 文件、语音；非音频和别的聊天忽略', async () => {
  assert.equal((await hook({ channel_post: audioPost(5) }, 'wrong')).status, 403);
  await hook({ channel_post: audioPost(9, { file_id: addFile(bytesOf(5000, 9)), file_size: 5000, performer: '更多音乐 @auvvip' }) });
  await hook({ channel_post: audioPost(10, { file_name: '我太笨.m4a', file_id: addFile(bytesOf(100, 1)), file_size: 100 }) });
  await hook({ channel_post: { message_id: 11, chat, document: { file_name: 'Transformer interview .wav', mime_type: 'audio/x-wav', file_id: addFile(bytesOf(200, 2)), file_unique_id: 'U11', file_size: 200 } } });
  await hook({ channel_post: { message_id: 13, chat, voice: { duration: 5, mime_type: 'audio/ogg', file_id: addFile(bytesOf(50, 3)), file_unique_id: 'U13', file_size: 50 } } });
  await hook({ channel_post: { message_id: 14, chat, document: { file_name: 'a.png', mime_type: 'image/png', file_id: 'P', file_size: 9 } } });
  await hook({ channel_post: { message_id: 15, chat, document: { file_name: 'm.mp4', mime_type: 'video/mp4', file_id: 'V', file_size: 9 } } });
  await hook({ channel_post: { message_id: 16, chat, text: 'hello' } });
  await hook({ message: { message_id: 17, chat: { id: 5, type: 'private' }, audio: { file_id: 'Y' } } });
  const list = await publicTracks();
  assert.deepEqual(list.map(x => x.id), [13, 12, 11, 10, 9, 4]);
  assert.equal(find(list, 10).mime, 'audio/mp4');
  assert.equal(find(list, 11).title, 'Transformer interview');
  assert.equal(find(list, 11).mime, 'audio/wav');
  assert.equal(find(list, 13).title, '语音 #13');
});

await t('别的频道的帖子、机器人进出频道：只记下频道，不登记歌', async () => {
  await hook({ channel_post: { message_id: 1, chat: { id: -100555, type: 'channel', title: '别人的频道' }, text: 'hi' } });
  await hook({ my_chat_member: { chat: { id: Number(STORAGE), type: 'channel', title: '小橘仓库' }, new_chat_member: { status: 'administrator' } } });
  await hook({ my_chat_member: { chat: { id: -100777, type: 'channel', title: '只是成员' }, new_chat_member: { status: 'member' } } });
  await hook({ my_chat_member: { chat, new_chat_member: { status: 'administrator' } } }); // 主频道自己不算
  const s = await adminState();
  assert.equal(s.storage, null);
  assert.deepEqual(s.chats.map(c => c.id).sort(), ['-100555', '-100777', STORAGE].sort());
  assert.equal((await publicTracks()).length, 6);
});

await t('管理接口要密钥，且不带 CORS 头', async () => {
  assert.equal((await admin('state', undefined, 'wrong')).status, 401);
  assert.equal((await req('/admin/api/state')).status, 401);
  const r = await admin('state');
  assert.equal(r.status, 200);
  assert.equal(r.headers.get('Access-Control-Allow-Origin'), null);
  const s = await jsonOf(r);
  assert.equal(s.bot, 'xiaoju_music_bot');
  assert.equal(s.splitter, true);
  assert.equal(s.partSize, PART);
  assert.equal(find(s.tracks, 12).note, '');
});

await t('没设仓库：大文件只标等待，不派活；手动上传返回 409', async () => {
  await hook({ channel_post: audioPost(22, { file_id: 'BIG22', file_size: 40 * MB }) });
  assert.equal(jobs.length, 0);
  assert.equal(find(await publicTracks(), 22).status, 'pending');
  const r = await putPart(22, 0, 3, new Uint8Array(10));
  assert.equal(r.status, 409);
  assert.match((await jsonOf(r)).error, /仓库/);
});

await t('设仓库：没见过的、机器人不是管理员的都拒绝', async () => {
  assert.equal((await admin('storage', { id: '-100404' })).status, 400);
  assert.equal((await admin('storage', { id: '-100777' })).status, 400);
  assert.equal((await admin('storage', { id: STORAGE })).status, 200);
  const s = await adminState();
  assert.deepEqual(s.storage, { id: STORAGE, title: '小橘仓库' });
  assert.ok(!s.chats.some(c => c.id === STORAGE));
});

await t('重新自动处理 → 派活给切片服务（带频道、仓库、分片大小），状态变成已派出', async () => {
  assert.equal((await admin('retry', { track: 4 })).status, 400); // 小文件不需要处理
  assert.equal((await admin('retry', { track: 22 })).status, 200);
  await settle();
  assert.deepEqual(jobs.at(-1), { track: 22, size: 40 * MB, file_unique_id: 'U22', channel: 'xiaojumusic', storage: STORAGE, part_size: PART });
  const s = find((await adminState()).tracks, 22);
  assert.equal(s.status, 'queued');
  assert.equal(s.attempts, 1);
});

await t('新的大文件一到就派活；切片服务没响应就记下原因、状态不变', async () => {
  await hook({ channel_post: audioPost(23, { file_id: 'BIG23', file_size: 25 * MB }) });
  await settle();
  assert.equal(jobs.at(-1).track, 23);
  mode.splitter = 'down';
  await hook({ channel_post: audioPost(24, { file_id: 'BIG24', file_size: 21 * MB }) });
  await settle();
  mode.splitter = 'ok';
  const s = find((await adminState()).tracks, 24);
  assert.equal(s.status, 'pending');
  assert.match(s.note, /没响应/);
  assert.equal(s.attempts, 0);
});

await t('定时任务：补派还没派出去的；失败按退避重试；卡住的重新派；最多派 5 次', async () => {
  const before = jobs.length;
  await worker.scheduled({}, env, ctx);
  assert.deepEqual(jobs.slice(before).map(j => j.track).sort((a, b) => a - b), [12, 24]);
  const now = Date.now();
  await admin('status', { track: 23, status: 'failed', note: '下载中断' });
  assert.ok(!(await lib.claim(now)).some(j => j.track === 23), '刚失败，还在退避');
  assert.ok((await lib.claim(now + 11 * 60 * 1000)).some(j => j.track === 23), '退避 10 分钟后重试');
  assert.ok(!(await lib.claim(now + 20 * 60 * 1000)).some(j => j.track === 22), '已派出 20 分钟，不算卡住');
  assert.ok((await lib.claim(now + 31 * 60 * 1000)).some(j => j.track === 22), '已派出 31 分钟没进展，算卡住');
  for (let i = 0; i < 4; i++) await lib.kicked(23, true, '');
  await admin('status', { track: 23, status: 'failed', note: '又失败了' });
  assert.ok(!(await lib.claim(now + 99 * 3600 * 1000)).some(j => j.track === 23), '派满 5 次就不再自动派');
  assert.equal((await admin('retry', { track: 23 })).status, 200); // 手动「重新自动处理」清零重来
  await settle();
  assert.equal(find((await adminState()).tracks, 23).attempts, 1);
});

await t('处理中：播放返回 503，歌单显示处理中；进度只给管理页看', async () => {
  await admin('status', { track: 22, status: 'processing', note: '3/3' });
  const r = await req('/a/22');
  assert.equal(r.status, 503);
  assert.match(await textOf(r), /正在切片/);
  assert.equal(find(await publicTracks(), 22).status, 'processing');
  assert.equal(find((await adminState()).tracks, 22).note, '3/3');
  await admin('status', { track: 22, status: 'weird', note: 'x' }); // 不认识的状态忽略
  assert.equal(find((await adminState()).tracks, 22).status, 'processing');
});

// 一个 2 片满 + 1 片零头的大文件（约 39.8 MB）
const BIG = bytesOf(2 * PART + 1000, 11);
const N = BIG.length;
const same = (got, from, to) => { assert.equal(got.length, to - from); assert.ok(Buffer.from(got).equals(Buffer.from(BIG.subarray(from, to))), `bytes ${from}-${to} 不一致`); };

await t('手动上传三片：请求体原样转成 multipart 发到仓库频道', async () => {
  await hook({ channel_post: audioPost(30, { file_id: 'BIG30', file_size: N, duration: 2000 }) });
  const parts = [];
  for (let i = 0; i < 3; i++) {
    const r = await putPart(30, i, 3, BIG.subarray(i * PART, Math.min(N, (i + 1) * PART)));
    assert.equal(r.status, 200);
    parts.push(await jsonOf(r));
  }
  assert.deepEqual(parts.map(p => p.size), [PART, PART, 1000]);
  assert.deepEqual(sent.slice(-3).map(s => [s.chat_id, s.caption, s.name, s.quiet, s.raw]), [
    [STORAGE, '#t30 1/3', 't30-p1of3.bin', 'true', 'true'],
    [STORAGE, '#t30 2/3', 't30-p2of3.bin', 'true', 'true'],
    [STORAGE, '#t30 3/3', 't30-p3of3.bin', 'true', 'true'],
  ]);
  const bad = await admin('commit', { track: 30, size: N + 1, parts });
  assert.equal(bad.status, 400);
  assert.match((await jsonOf(bad)).error, /大小/);
  assert.equal((await admin('commit', { track: 30, size: N, parts })).status, 200);
  const s = find(await publicTracks(), 30);
  assert.equal(s.playable, true);
  assert.equal(s.parts, 3);
  assert.equal(s.downloadable, true);
});

await t('拼接播放：各种 Range 都和原文件逐字节相同', async () => {
  const get = range => req('/a/30', range ? { headers: { Range: range } } : undefined);
  let r = await get('bytes=0-1');
  assert.equal(r.status, 206);
  assert.equal(r.headers.get('Content-Range'), `bytes 0-1/${N}`);
  assert.equal(r.headers.get('Content-Type'), 'audio/mpeg');
  same(await bytes(r), 0, 2);

  r = await get(`bytes=${PART - 10}-${PART + 9}`); // 跨一个分片边界
  assert.equal(r.status, 206);
  assert.equal(r.headers.get('Content-Length'), '20');
  same(await bytes(r), PART - 10, PART + 10);

  r = await get(`bytes=${PART - 5}-${2 * PART + 4}`); // 跨两个边界
  same(await bytes(r), PART - 5, 2 * PART + 5);

  r = await get(`bytes=${PART + 5}-`); // 从中间到结尾
  assert.equal(r.headers.get('Content-Range'), `bytes ${PART + 5}-${N - 1}/${N}`);
  same(await bytes(r), PART + 5, N);

  r = await get('bytes=-100'); // 最后 100 字节
  assert.equal(r.headers.get('Content-Range'), `bytes ${N - 100}-${N - 1}/${N}`);
  same(await bytes(r), N - 100, N);

  calls.length = 0;
  r = await get(null); // 整个文件
  assert.equal(r.status, 200);
  assert.equal(r.headers.get('Content-Length'), String(N));
  same(await bytes(r), 0, N);
  assert.ok(tgCalls().length <= 6, '3 片最多 6 个子请求，实际 ' + tgCalls().length);

  r = await get('bytes=0-1,5-6'); // 多段 Range 不支持，给整个文件
  assert.equal(r.status, 200);
  await bytes(r);

  r = await get(`bytes=${N}-`);
  assert.equal(r.status, 416);
  assert.equal(r.headers.get('Content-Range'), `bytes */${N}`);

  r = await req('/a/30', { method: 'HEAD' });
  assert.equal(r.headers.get('Content-Length'), String(N));
});

await t('一次最多拼 16 片：超出的范围少给（206），整个文件的下载拒绝', async () => {
  const pieces = Array.from({ length: 20 }, (_, i) => bytesOf(10, 100 + i));
  const all = Buffer.concat(pieces.map(p => Buffer.from(p)));
  await lib.upsertTrack({ id: 40, kind: 'audio', file_id: 'unused', file_unique_id: 'U40', title: '很多片', performer: '', name: 'many.mp3',
    mime: 'audio/mpeg', size: 200, duration: 1, date: 1, caption: '', parts: pieces.map(p => ({ file_id: addFile(p), size: 10 })) });
  let r = await req('/a/40', { headers: { Range: 'bytes=0-' } });
  assert.equal(r.status, 206);
  assert.equal(r.headers.get('Content-Range'), 'bytes 0-159/200');
  assert.ok(Buffer.from(await bytes(r)).equals(all.subarray(0, 160)));
  r = await req('/a/40', { headers: { Range: 'bytes=150-199' } });
  assert.ok(Buffer.from(await bytes(r)).equals(all.subarray(150, 200)));
  r = await req('/a/40');
  assert.equal(r.status, 413);
  assert.match(await textOf(r), /原帖/);
  assert.equal(find((await adminState()).tracks, 40).downloadable, false);
});

await t('登记校验：分片超限拒绝；大小和频道不一致要 force，force 后按新大小和类型播放', async () => {
  await hook({ channel_post: audioPost(31, { file_id: 'BIG31', file_size: 21 * MB }) });
  const part = await jsonOf(await putPart(31, 0, 1, bytesOf(1000, 5)));
  assert.equal((await admin('commit', { track: 31, size: 21 * MB + 1, parts: [{ file_id: 'x', size: 21 * MB + 1 }] })).status, 400);
  assert.equal((await admin('commit', { track: 31, size: 1000, parts: [part] })).status, 400);
  assert.equal((await admin('commit', { track: 31, size: 1000, parts: [part], force: true, mime: 'audio/flac' })).status, 200);
  const r = await req('/a/31', { headers: { Range: 'bytes=0-9' } });
  assert.equal(r.status, 206);
  assert.equal(r.headers.get('Content-Type'), 'audio/flac');
  assert.equal(r.headers.get('Content-Range'), 'bytes 0-9/1000');
  await bytes(r);
});

await t('上传分片的参数检查：参数错 400、超过 19 MB 413、Telegram 限速 429 并带重试秒数', async () => {
  assert.equal((await putPart(30, 3, 3, new Uint8Array(5))).status, 400);
  assert.equal((await putPart(30, 0, 3, new Uint8Array(PART + 1))).status, 413);
  mode.send = '429';
  const r = await putPart(30, 0, 3, new Uint8Array(5));
  mode.send = 'ok';
  assert.equal(r.status, 429);
  assert.equal((await jsonOf(r)).retryAfter, 7);
});

await t('编辑帖子：同一个文件保留分片；换了文件就重新处理', async () => {
  await hook({ edited_channel_post: { ...audioPost(30, { file_id: 'BIG30', file_size: N }), caption: '改了说明' } });
  let s = find((await adminState()).tracks, 30);
  assert.equal(s.status, 'ok');
  assert.equal(s.parts, 3);
  const before = jobs.length;
  await hook({ edited_channel_post: audioPost(30, { file_id: 'BIG30B', file_unique_id: 'U30B', file_size: 30 * MB }) });
  await settle();
  s = find((await adminState()).tracks, 30);
  assert.equal(s.status, 'queued');
  assert.equal(s.parts, 0);
  assert.equal(jobs.length, before + 1);
});

await t('编辑成纯文字 → 移除；管理页也能移除', async () => {
  await hook({ edited_channel_post: { message_id: 13, chat, text: '不是音频了' } });
  assert.equal((await admin('remove', { track: 4 })).status, 200);
  const ids = (await publicTracks()).map(x => x.id);
  assert.ok(!ids.includes(13) && !ids.includes(4));
  assert.equal((await req('/a/4')).status, 404);
});

await t('单个小文件：Range 透传；下载路径过期重取；Telegram 故障 502', async () => {
  const f9 = files.get(JSON.parse(JSON.stringify(await lib.getTrack(9))).file_id);
  let r = await req('/a/9', { headers: { Range: 'bytes=10-109' } });
  assert.equal(r.status, 206);
  assert.ok(Buffer.from(await bytes(r)).equals(Buffer.from(f9.subarray(10, 110))));
  calls.length = 0;
  mode.expireOnce = true;
  r = await req('/a/9', { headers: { Range: 'bytes=0-9' } });
  assert.equal(r.status, 206);
  await bytes(r);
  assert.equal(tgCalls().filter(c => c.url.includes('/getFile')).length, 1);
  assert.equal(tgCalls().filter(c => c.url.includes('/file/bot')).length, 2);
  mode.getFile = 'fail';
  r = await req('/a/11');
  mode.getFile = 'ok';
  assert.equal(r.status, 502);
  await textOf(r);
  r = await req('/a/10?dl=1');
  assert.match(r.headers.get('Content-Disposition'), /^attachment; filename="track-10\.m4a"; filename\*=UTF-8''%E6%88%91%E5%A4%AA%E7%AC%A8\.m4a$/);
  await bytes(r);
});

await t('路由：404、405、CORS 预检', async () => {
  assert.equal((await req('/a/999')).status, 404);
  assert.equal((await req('/a/abc')).status, 404);
  assert.equal((await req('/nope')).status, 404);
  assert.equal((await req('/tg-webhook')).status, 405);
  assert.equal((await req('/a/9', { method: 'POST' })).status, 405);
  assert.equal((await admin('nope', {})).status, 404);
  const r = await req('/a/9', { method: 'OPTIONS' });
  assert.equal(r.status, 204);
  assert.match(r.headers.get('Access-Control-Allow-Headers'), /Range/);
});

await t('播放页和管理页都能取到，内嵌脚本能通过语法检查', async () => {
  for (const path of ['/', '/admin']) {
    const r = await req(path);
    assert.equal(r.headers.get('Content-Type'), 'text/html; charset=utf-8');
    const html = await textOf(r);
    new Function(html.split('<script>')[1].split('</script>')[0]); // 语法错误会抛
  }
  assert.equal((await req('/admin')).headers.get('X-Robots-Tag'), 'noindex');
});

await t('任何响应里都不出现机器人 token、管理密钥、切片服务密钥', async () => {
  assert.ok(seen.length > 20);
  for (const s of seen) {
    for (const secret of [TOKEN, 'SECRET-BOT', ADMIN, SKEY]) assert.ok(!s.includes(secret), 'leaked: ' + s.slice(0, 200));
  }
});

console.log(`\n全部 ${n} 项通过`);
