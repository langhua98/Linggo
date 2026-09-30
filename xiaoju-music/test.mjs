// 本地测试：Node 自带的 SQLite 模拟 Durable Object，再模拟 Telegram 和流式服务，逐条验证 worker.js
import assert from 'node:assert/strict';
import { register } from 'node:module';
import { DatabaseSync } from 'node:sqlite';

register('./test/hooks.mjs', import.meta.url);
const { default: worker, Library } = await import('./worker.js');

const TOKEN = '123:SECRET-BOT-TOKEN';
const HOOK = 'hook-secret';
const ADMIN = 'admin-key-123';
const SKEY = 'streamer-key-456';
const STREAMER = 'https://streamer.example';
const CHANNEL = -1003817921075;
const MB = 1024 * 1024;
const LIMIT = 20 * MB;

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
// 更早版本的 KV：每页只给 1 条，逼出分页
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

// ── 模拟 Telegram（小文件）和流式服务（大文件）──
const files = new Map();   // file_id -> 字节（Bot API 能取的小文件）
const bigFiles = new Map(); // 消息号 -> 字节（只有流式服务取得到）
let seq = 0;
const addFile = bytes => { const id = 'F' + (++seq); files.set(id, bytes); return id; };
const bytesOf = (n, seed) => { const b = new Uint8Array(n); for (let i = 0; i < n; i++) b[i] = (i * 7 + seed + (i >> 12)) & 255; return b; };
const calls = [];
const mode = { getFile: 'ok', expireOnce: false, streamer: 'ok' };

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
  if ((m = url.match(/^https:\/\/streamer\.example\/stream\/(\d+)$/))) {
    if (mode.streamer === 'down') throw new TypeError('fetch failed');
    if (mode.streamer === 'starting') return new Response('<html>Space is starting</html>', { headers: { 'Content-Type': 'text/html' } });
    if (mode.streamer === '502') return new Response('Bad Gateway', { status: 502 });
    assert.equal(headers.get('X-Key'), SKEY);
    const f = bigFiles.get(Number(m[1]));
    if (!f) return new Response('Not Found', { status: 404 });
    if (mode.streamer === 'short') return new Response(f.slice(0, 10), { status: headers.get('Range') ? 206 : 200, headers: { 'Content-Length': '10' } });
    return serve(f, headers.get('Range'), { 'Content-Type': 'application/octet-stream' });
  }
  assert.ok(url.startsWith('https://api.telegram.org/'), 'unexpected fetch ' + url);
  if ((m = url.match(/\/bot[^/]+\/getFile\?file_id=(.+)$/))) {
    const f = files.get(decodeURIComponent(m[1]));
    if (!f) return Response.json({ ok: false, error_code: 400, description: 'Bad Request: invalid file_id' });
    if (mode.getFile === 'fail') return Response.json({ ok: false, error_code: 500, description: 'Internal Server Error' });
    return Response.json({ ok: true, result: { file_path: 'music/' + m[1] + '.bin' } });
  }
  if ((m = url.match(/\/file\/bot[^/]+\/music\/(.+)\.bin$/))) {
    if (mode.expireOnce) { mode.expireOnce = false; return new Response('Not Found', { status: 404 }); }
    return serve(files.get(m[1]), headers.get('Range'));
  }
  throw new Error('unexpected fetch ' + url);
};

// ── 被测环境 ──
const oldTracks = [
  { id: 4, kind: 'audio', file_id: addFile(bytesOf(3000, 4)), file_unique_id: 'U4', title: '谁', performer: '张万森 @auvvip', name: '张万森 谁.mp3', mime: 'audio/mpeg', size: 3000, duration: 291, date: 1, caption: '' },
  { id: 12, kind: 'audio', file_id: 'BIG12', file_unique_id: 'U12', title: '抖音热播 Vol.12', performer: '', name: 'vol12.mp3', mime: 'audio/mpeg', size: 25 * MB, duration: 7209, date: 2, caption: '' },
];
bigFiles.set(12, bytesOf(25 * MB, 12));
const env = {
  TG_BOT_TOKEN: TOKEN, TG_WEBHOOK_SECRET: HOOK, ADMIN_KEY: ADMIN, STREAMER_KEY: SKEY, STREAMER_URL: STREAMER + '/',
  CHANNEL_ID: String(CHANNEL), CHANNEL_USERNAME: 'xiaojumusic', TRACKS: makeKV(oldTracks),
};
const lib = await makeLibrary(env);
env.LIB = { idFromName: n => n, get: () => lib };

const BASE = 'https://xiaoju-music.example.workers.dev';
const req = (path, init) => worker.fetch(new Request(BASE + path, init), env);
const hook = (update, secret = HOOK) => req('/tg-webhook', {
  method: 'POST', headers: { 'Content-Type': 'application/json', 'X-Telegram-Bot-Api-Secret-Token': secret }, body: JSON.stringify(update),
});
const admin = (action, payload, key = ADMIN) => req('/admin/api/' + action, payload === undefined
  ? { headers: { Authorization: 'Bearer ' + key } }
  : { method: 'POST', headers: { Authorization: 'Bearer ' + key, 'Content-Type': 'application/json' }, body: JSON.stringify(payload) });
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
const find = (list, id) => list.find(t => t.id === id);
const same = (got, src, from, to) => { assert.equal(got.length, to - from); assert.ok(Buffer.from(got).equals(Buffer.from(src.subarray(from, to))), `bytes ${from}-${to} 不一致`); };

let n = 0;
async function t(name, fn) { await fn(); n++; console.log('ok', name); }

// ─────────────────────────────────────────────────────────────

await t('第一次启动把 KV 里的旧歌单迁进来（分页读全）；大文件在流式服务开着时可以播', async () => {
  const list = await publicTracks();
  assert.deepEqual(list.map(x => x.id), [12, 4]);
  assert.deepEqual([find(list, 4).big, find(list, 4).playable], [false, true]);
  assert.deepEqual([find(list, 12).big, find(list, 12).playable], [true, true]);
  assert.ok(!JSON.stringify(list).includes('file_id'));
});

await t('切片那一版的数据库：歌搬进 songs，状态列、chats 表、仓库配置都清掉，不再从 KV 重搬', async () => {
  const db = new DatabaseSync(':memory:');
  db.exec(`CREATE TABLE tracks (id INTEGER PRIMARY KEY, rec TEXT NOT NULL, status TEXT NOT NULL, note TEXT NOT NULL DEFAULT '',
    attempts INTEGER NOT NULL DEFAULT 0, updated INTEGER NOT NULL DEFAULT 0)`);
  db.exec('CREATE TABLE chats (id TEXT PRIMARY KEY, title TEXT NOT NULL, status TEXT NOT NULL, updated INTEGER NOT NULL)');
  db.exec('CREATE TABLE config (k TEXT PRIMARY KEY, v TEXT NOT NULL)');
  db.prepare('INSERT INTO tracks VALUES (?, ?, ?, ?, ?, ?)').run(7, JSON.stringify({ ...oldTracks[0], id: 7, title: '旧版里的歌' }), 'ok', '', 0, 5);
  db.prepare('INSERT INTO tracks VALUES (?, ?, ?, ?, ?, ?)').run(51, JSON.stringify({ ...oldTracks[1], id: 51 }), 'pending', '没响应', 0, 6);
  db.exec("INSERT INTO chats VALUES ('-100999', '小橘仓库', 'administrator', 1)");
  db.exec("INSERT INTO config VALUES ('migrated', '1'), ('storage', '-100999'), ('storageTitle', '小橘仓库')");
  const old = await makeLibrary({ TRACKS: makeKV(oldTracks) }, db);
  assert.deepEqual((await old.listTracks()).map(x => x.id), [51, 7]); // 没有再从 KV 搬 4 和 12
  const tables = db.prepare("SELECT name FROM sqlite_master WHERE type = 'table' ORDER BY name").all().map(r => r.name);
  assert.deepEqual(tables, ['config', 'songs']);
  assert.deepEqual(db.prepare('SELECT k FROM config').all().map(r => r.k), ['migrated']);
  await makeLibrary({}, db); // 再启动一次：什么都不用做，也不报错
  assert.equal((await old.getTrack(7)).title, '旧版里的歌');
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
  await hook({ channel_post: { message_id: 17, chat: { id: -100555, type: 'channel' }, audio: { file_id: 'X', file_size: 1 } } });
  await hook({ message: { message_id: 18, chat: { id: 5, type: 'private' }, audio: { file_id: 'Y' } } });
  const list = await publicTracks();
  assert.deepEqual(list.map(x => x.id), [13, 12, 11, 10, 9, 4]);
  assert.equal(find(list, 10).mime, 'audio/mp4');
  assert.equal(find(list, 11).title, 'Transformer interview');
  assert.equal(find(list, 11).mime, 'audio/wav');
  assert.equal(find(list, 13).title, '语音 #13');
});

await t('大文件：Range 原样转给流式服务（带密钥），返回的字节和原文件一致', async () => {
  const src = bigFiles.get(12);
  const N = src.length;
  calls.length = 0;
  let r = await req('/a/12', { headers: { Range: 'bytes=0-1' } });
  assert.equal(r.status, 206);
  assert.equal(r.headers.get('Content-Range'), `bytes 0-1/${N}`);
  assert.equal(r.headers.get('Content-Type'), 'audio/mpeg');
  same(await bytes(r), src, 0, 2);
  assert.deepEqual(calls.map(c => [c.url, c.range, c.key]), [[STREAMER + '/stream/12', 'bytes=0-1', SKEY]]);
  assert.ok(!calls.some(c => c.url.includes('api.telegram.org')), '大文件不走 Bot API');

  r = await req('/a/12', { headers: { Range: `bytes=${N - 1000}-` } });
  assert.equal(r.headers.get('Content-Range'), `bytes ${N - 1000}-${N - 1}/${N}`);
  same(await bytes(r), src, N - 1000, N);

  r = await req('/a/12', { headers: { Range: 'bytes=-5' } });
  assert.equal(calls.at(-1).range, `bytes=${N - 5}-${N - 1}`); // 转发的是算好的绝对范围
  same(await bytes(r), src, N - 5, N);

  calls.length = 0;
  r = await req('/a/12?dl=1'); // 整个下载：不带 Range，200
  assert.equal(r.status, 200);
  assert.equal(calls[0].range, null);
  assert.equal(r.headers.get('Content-Length'), String(N));
  assert.match(r.headers.get('Content-Disposition'), /^attachment;/);
  same(await bytes(r), src, 0, N);

  r = await req('/a/12', { headers: { Range: `bytes=${N}-` } });
  assert.equal(r.status, 416);
  assert.equal(r.headers.get('Content-Range'), `bytes */${N}`);
  r = await req('/a/12', { method: 'HEAD' });
  assert.equal(r.headers.get('Content-Length'), String(N));
});

await t('流式服务在休眠：连不上、回「正在启动」网页、回 502 都算正在唤醒（503 + Retry-After）', async () => {
  for (const m of ['down', 'starting', '502']) {
    mode.streamer = m;
    const r = await req('/a/12', { headers: { Range: 'bytes=0-1' } });
    assert.equal(r.status, 503, m);
    assert.equal(r.headers.get('Retry-After'), '15');
    assert.match(await textOf(r), /唤醒/);
  }
  mode.streamer = 'short'; // 给的字节数不对：不能当音频转出去
  let r = await req('/a/12', { headers: { Range: 'bytes=0-99' } });
  assert.equal(r.status, 502);
  await textOf(r);
  mode.streamer = 'ok';
  bigFiles.delete(12); // 频道里的帖子被删了
  r = await req('/a/12', { headers: { Range: 'bytes=0-1' } });
  assert.equal(r.status, 404);
  assert.match(await textOf(r), /找不到/);
  bigFiles.set(12, bytesOf(25 * MB, 12));
});

await t('没配流式服务：大文件标成不能播放，请求返回 503 说明原因；小文件不受影响', async () => {
  const saved = env.STREAMER_URL;
  env.STREAMER_URL = '';
  await hook({ channel_post: audioPost(20, { file_id: 'BIG20', file_size: 21 * MB }) }); // 顺便清掉歌单缓存
  const list = await publicTracks();
  assert.equal(find(list, 20).playable, false);
  assert.equal(find(list, 12).playable, false);
  assert.equal(find(list, 9).playable, true);
  const r = await req('/a/12');
  assert.equal(r.status, 503);
  assert.equal(r.headers.get('Retry-After'), null);
  assert.match(await textOf(r), /暂时不能/);
  const s = await jsonOf(await admin('state'));
  assert.equal(s.streamer, false);
  env.STREAMER_URL = saved;
  await hook({ channel_post: audioPost(20, { file_id: 'BIG20', file_size: 21 * MB }) });
  assert.equal(find(await publicTracks(), 20).playable, true);
});

await t('小文件：Range 透传；下载路径过期重取；Telegram 故障 502；多段 Range 给整个文件', async () => {
  const f9 = files.get((await lib.getTrack(9)).file_id);
  let r = await req('/a/9', { headers: { Range: 'bytes=10-109' } });
  assert.equal(r.status, 206);
  assert.equal(r.headers.get('Content-Range'), 'bytes 10-109/5000');
  same(await bytes(r), f9, 10, 110);
  calls.length = 0;
  mode.expireOnce = true;
  r = await req('/a/9', { headers: { Range: 'bytes=0-9' } });
  assert.equal(r.status, 206);
  await bytes(r);
  assert.equal(calls.filter(c => c.url.includes('/getFile')).length, 1);
  assert.equal(calls.filter(c => c.url.includes('/file/bot')).length, 2);
  r = await req('/a/9', { headers: { Range: 'bytes=0-1,5-6' } });
  assert.equal(r.status, 200);
  same(await bytes(r), f9, 0, 5000);
  mode.getFile = 'fail';
  r = await req('/a/11');
  mode.getFile = 'ok';
  assert.equal(r.status, 502);
  await textOf(r);
  r = await req('/a/10?dl=1');
  assert.match(r.headers.get('Content-Disposition'), /^attachment; filename="track-10\.m4a"; filename\*=UTF-8''%E6%88%91%E5%A4%AA%E7%AC%A8\.m4a$/);
  await bytes(r);
});

await t('编辑成纯文字 → 移除；管理页也能移除；管理接口要密钥且不带 CORS 头', async () => {
  await hook({ edited_channel_post: { message_id: 13, chat, text: '不是音频了' } });
  assert.equal((await admin('state', undefined, 'wrong')).status, 401);
  assert.equal((await req('/admin/api/state')).status, 401);
  const r = await admin('state');
  assert.equal(r.headers.get('Access-Control-Allow-Origin'), null);
  const s = await jsonOf(r);
  assert.equal(s.streamer, true);
  assert.equal(find(s.tracks, 12).big, true);
  assert.equal((await admin('remove', { track: 'x' })).status, 400);
  assert.equal((await admin('remove', { track: 4 })).status, 200);
  const ids = (await publicTracks()).map(x => x.id);
  assert.ok(!ids.includes(13) && !ids.includes(4));
  assert.equal((await req('/a/4')).status, 404);
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

await t('任何响应里都不出现机器人 token、管理密钥、流式服务密钥', async () => {
  assert.ok(seen.length > 20);
  for (const s of seen) {
    for (const secret of [TOKEN, 'SECRET-BOT', ADMIN, SKEY]) assert.ok(!s.includes(secret), 'leaked: ' + s.slice(0, 200));
  }
});

console.log(`\n全部 ${n} 项通过`);
