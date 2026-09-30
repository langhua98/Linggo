// 本地测试：模拟 KV 和 Telegram，逐条验证 worker.js 的各个路由
import assert from 'node:assert/strict';
import worker from './worker.js';

const TOKEN = '123:SECRET-BOT-TOKEN';
const HOOK = 'hook-secret';
const CHANNEL = -1003817921075;

function makeKV() {
  const m = new Map();
  return {
    m,
    async get(k, type) { const e = m.get(k); if (!e) return null; return type === 'json' ? JSON.parse(e.value) : e.value; },
    async put(k, value, opts = {}) {
      if (opts.metadata) assert.ok(new TextEncoder().encode(JSON.stringify(opts.metadata)).length <= 1024, 'metadata <= 1024 bytes');
      m.set(k, { value, metadata: opts.metadata });
    },
    async delete(k) { m.delete(k); },
    async list({ prefix, cursor }) {
      const keys = [...m.keys()].filter(k => k.startsWith(prefix)).sort();
      // 每页 2 条，逼出分页逻辑
      const start = cursor ? Number(cursor) : 0;
      const page = keys.slice(start, start + 2).map(name => ({ name, metadata: m.get(name).metadata }));
      const done = start + 2 >= keys.length;
      return { keys: page, list_complete: done, cursor: done ? '' : String(start + 2) };
    },
  };
}

const env = { TRACKS: makeKV(), TG_BOT_TOKEN: TOKEN, TG_WEBHOOK_SECRET: HOOK, CHANNEL_ID: String(CHANNEL), CHANNEL_USERNAME: 'xiaojumusic' };

// ── 模拟 Telegram ──
const FILE = new Uint8Array(1000).map((_, i) => i % 256);
const calls = [];
let getFileMode = 'ok';   // ok | big | fail
let expireOnce = false;   // 下一次下载回 404（模拟路径过期）
globalThis.fetch = async (input, init = {}) => {
  const url = String(input);
  const range = init.headers && (init.headers.Range || init.headers.range);
  calls.push({ url, range });
  if (url.includes('/getFile?')) {
    if (getFileMode === 'big') return Response.json({ ok: false, error_code: 400, description: 'Bad Request: file is too big' });
    if (getFileMode === 'fail') return Response.json({ ok: false, error_code: 400, description: 'Bad Request: wrong file_id' });
    return Response.json({ ok: true, result: { file_path: 'music/file_' + calls.length + '.mp3' } });
  }
  if (url.includes('/file/bot')) {
    if (expireOnce) { expireOnce = false; return new Response('Not Found', { status: 404 }); }
    if (range) {
      const [a, b] = range.replace('bytes=', '').split('-');
      const start = Number(a), end = b ? Number(b) : FILE.length - 1;
      return new Response(FILE.slice(start, end + 1), {
        status: 206,
        headers: { 'Content-Type': 'application/octet-stream', 'Content-Length': String(end - start + 1), 'Content-Range': `bytes ${start}-${end}/${FILE.length}` },
      });
    }
    return new Response(FILE, { headers: { 'Content-Type': 'application/octet-stream', 'Content-Length': String(FILE.length) } });
  }
  throw new Error('unexpected fetch ' + url);
};

const BASE = 'https://xiaoju-music.example.workers.dev';
const req = (path, init) => worker.fetch(new Request(BASE + path, init), env);
const hook = (update, secret = HOOK) => req('/tg-webhook', {
  method: 'POST', headers: { 'Content-Type': 'application/json', 'X-Telegram-Bot-Api-Secret-Token': secret }, body: JSON.stringify(update),
});
const chat = { id: CHANNEL, type: 'channel', username: 'xiaojumusic' };
const allText = [];
async function body(res) { const t = await res.clone().text(); allText.push(t, JSON.stringify([...res.headers])); return t; }

let n = 0;
async function t(name, fn) { await fn(); n++; console.log('ok', name); }

await t('webhook 密钥错误 → 403', async () => {
  const r = await hook({ channel_post: { message_id: 1, chat, audio: { file_id: 'x', file_size: 1 } } }, 'wrong');
  assert.equal(r.status, 403);
  assert.equal(env.TRACKS.m.size, 0);
});

await t('webhook 未配置密钥时拒绝一切', async () => {
  const saved = env.TG_WEBHOOK_SECRET; env.TG_WEBHOOK_SECRET = '';
  const r = await hook({ channel_post: { message_id: 1, chat, audio: { file_id: 'x' } } }, '');
  env.TG_WEBHOOK_SECRET = saved;
  assert.equal(r.status, 403);
});

await t('登记 audio', async () => {
  const r = await hook({ update_id: 1, channel_post: { message_id: 10, chat, date: 1700000000, caption: '🎧🎧', audio: {
    duration: 310, file_name: '舍得 2.mp3', mime_type: 'audio/mpeg', title: '舍得', performer: '张万森 @auvvip', file_id: 'F10', file_unique_id: 'U10', file_size: 12512950 } } });
  assert.equal(r.status, 200);
  const rec = JSON.parse(env.TRACKS.m.get('t:10').value);
  assert.equal(rec.title, '舍得'); assert.equal(rec.mime, 'audio/mpeg'); assert.equal(rec.file_id, 'F10');
  assert.equal(env.TRACKS.m.get('t:10').metadata.file_id, undefined, 'metadata 不带 file_id');
});

await t('m4a 按扩展名纠正 MIME', async () => {
  await hook({ channel_post: { message_id: 9, chat, audio: { duration: 36, file_name: '我太笨.m4a', mime_type: 'audio/mpeg', title: '我太笨', file_id: 'F9', file_size: 616820 } } });
  assert.equal(JSON.parse(env.TRACKS.m.get('t:9').value).mime, 'audio/mp4');
});

await t('wav 文件（document）登记，标题取文件名', async () => {
  await hook({ channel_post: { message_id: 5, chat, document: { file_name: 'Transformer interview .wav', mime_type: 'audio/x-wav', file_id: 'F5', file_size: 2739164 } } });
  const rec = JSON.parse(env.TRACKS.m.get('t:5').value);
  assert.equal(rec.title, 'Transformer interview'); assert.equal(rec.mime, 'audio/wav'); assert.equal(rec.kind, 'document');
});

await t('非音频文件、别的聊天、纯文字都忽略', async () => {
  const before = env.TRACKS.m.size;
  await hook({ channel_post: { message_id: 20, chat, document: { file_name: 'a.png', mime_type: 'image/png', file_id: 'P' } } });
  await hook({ channel_post: { message_id: 21, chat, document: { file_name: 'movie.mp4', mime_type: 'video/mp4', file_id: 'V' } } });
  await hook({ channel_post: { message_id: 22, chat: { id: -100999, type: 'channel' }, audio: { file_id: 'X' } } });
  await hook({ channel_post: { message_id: 23, chat, text: 'hello' } });
  await hook({ message: { message_id: 24, chat: { id: 5, type: 'private' }, audio: { file_id: 'Y' } } });
  const r = await req('/tg-webhook', { method: 'POST', headers: { 'X-Telegram-Bot-Api-Secret-Token': HOOK }, body: 'not json' });
  assert.equal(r.status, 200);
  assert.equal(env.TRACKS.m.size, before);
});

await t('语音消息登记为 audio/ogg', async () => {
  await hook({ channel_post: { message_id: 30, chat, voice: { duration: 5, mime_type: 'audio/ogg', file_id: 'F30', file_size: 5000 } } });
  const rec = JSON.parse(env.TRACKS.m.get('t:30').value);
  assert.equal(rec.title, '语音 #30'); assert.equal(rec.mime, 'audio/ogg');
});

await t('超长 emoji 标题的 metadata 不超 1024 字节', async () => {
  await hook({ channel_post: { message_id: 31, chat, audio: { title: '🎧'.repeat(300), performer: '🍊'.repeat(300), file_name: '😀'.repeat(200) + '.mp3', file_id: 'F31', file_size: 10 } } });
  const meta = env.TRACKS.m.get('t:31').metadata;
  assert.ok(new TextEncoder().encode(JSON.stringify(meta)).length <= 1000);
  assert.ok(!meta.title.includes('�'));
});

await t('超过 20 MB 的标记为 big', async () => {
  await hook({ channel_post: { message_id: 40, chat, audio: { title: '大文件', file_id: 'F40', file_size: 30 * 1024 * 1024 } } });
});

await t('编辑后不再是音频 → 删除', async () => {
  await hook({ edited_channel_post: { message_id: 31, chat, text: '改成文字了' } });
  assert.equal(env.TRACKS.m.has('t:31'), false);
});

await t('歌单：分页拼全、新的在前、带 big 标记、不含 file_id', async () => {
  const r = await req('/api/tracks');
  const d = JSON.parse(await body(r));
  assert.equal(r.headers.get('Access-Control-Allow-Origin'), '*');
  assert.equal(d.channel, 'xiaojumusic');
  assert.deepEqual(d.tracks.map(x => x.id), [40, 30, 10, 9, 5]);
  assert.equal(d.tracks[0].big, true); assert.equal(d.tracks[2].big, false);
  assert.ok(!JSON.stringify(d).includes('file_id'));
});

await t('音频：Range → 206，MIME 被改写，Range 透传给 Telegram', async () => {
  calls.length = 0;
  const r = await req('/a/10', { headers: { Range: 'bytes=0-99' } });
  assert.equal(r.status, 206);
  assert.equal(r.headers.get('Content-Type'), 'audio/mpeg');
  assert.equal(r.headers.get('Content-Range'), 'bytes 0-99/1000');
  assert.equal(r.headers.get('Content-Length'), '100');
  assert.equal(r.headers.get('Accept-Ranges'), 'bytes');
  assert.match(r.headers.get('Content-Disposition'), /^inline; filename="track-10\.mp3"; filename\*=UTF-8''%E8%88%8D%E5%BE%97%202\.mp3$/);
  const buf = new Uint8Array(await r.arrayBuffer());
  assert.equal(buf.length, 100); assert.equal(buf[99], 99);
  assert.equal(calls.filter(c => c.url.includes('/getFile')).length, 1);
  assert.equal(calls.find(c => c.url.includes('/file/bot')).range, 'bytes=0-99');
});

await t('第二次请求复用缓存的下载路径（不再 getFile）', async () => {
  calls.length = 0;
  const r = await req('/a/10.mp3', { headers: { Range: 'bytes=900-' } });
  assert.equal(r.status, 206);
  assert.equal(r.headers.get('Content-Range'), 'bytes 900-999/1000');
  assert.equal(calls.filter(c => c.url.includes('/getFile')).length, 0);
});

await t('无 Range → 200 整个文件；?dl=1 → attachment', async () => {
  const r = await req('/a/10?dl=1');
  assert.equal(r.status, 200);
  assert.equal((await r.arrayBuffer()).byteLength, 1000);
  assert.match(r.headers.get('Content-Disposition'), /^attachment;/);
});

await t('多段 Range 不转发，退回 200', async () => {
  calls.length = 0;
  const r = await req('/a/10', { headers: { Range: 'bytes=0-1,5-6' } });
  assert.equal(r.status, 200);
  assert.equal(calls.find(c => c.url.includes('/file/bot')).range, undefined);
});

await t('下载路径过期 → 重新 getFile 并重试一次', async () => {
  calls.length = 0; expireOnce = true;
  const r = await req('/a/10', { headers: { Range: 'bytes=0-9' } });
  assert.equal(r.status, 206);
  assert.equal(calls.filter(c => c.url.includes('/getFile')).length, 1);
  assert.equal(calls.filter(c => c.url.includes('/file/bot')).length, 2);
});

await t('HEAD 不打 Telegram，给出长度', async () => {
  calls.length = 0;
  const r = await req('/a/5', { method: 'HEAD' });
  assert.equal(r.status, 200);
  assert.equal(r.headers.get('Content-Type'), 'audio/wav');
  assert.equal(calls.length, 0);
});

await t('big 文件 → 413，不打 Telegram', async () => {
  calls.length = 0;
  const r = await req('/a/40');
  assert.equal(r.status, 413);
  assert.match(await body(r), /20 MB/);
  assert.equal(calls.length, 0);
});

await t('getFile 报 too big → 413；其它失败 → 502', async () => {
  getFileMode = 'big';
  let r = await req('/a/9');
  assert.equal(r.status, 413);
  getFileMode = 'fail';
  r = await req('/a/5');
  assert.equal(r.status, 502);
  await body(r);
  getFileMode = 'ok';
});

await t('404：不存在的歌、非法路径、未知路由', async () => {
  assert.equal((await req('/a/999')).status, 404);
  assert.equal((await req('/a/abc')).status, 404);
  assert.equal((await req('/a/1/../2')).status, 404);
  assert.equal((await req('/nope')).status, 404);
  assert.equal((await req('/tg-webhook')).status, 405);
  assert.equal((await req('/a/10', { method: 'POST' })).status, 405);
});

await t('播放页可以取到，且内嵌脚本能通过语法检查', async () => {
  const r = await req('/');
  const html = await body(r);
  assert.equal(r.headers.get('Content-Type'), 'text/html; charset=utf-8');
  assert.ok(html.includes('<audio id="audio"'));
  const script = html.split('<script>')[1].split('</script>')[0];
  new Function(script); // 语法错误会抛
  assert.ok(script.includes("replace(/@\\w+/g"), '正则里的反斜杠要原样保留');
});

await t('CORS 预检', async () => {
  const r = await req('/a/10', { method: 'OPTIONS' });
  assert.equal(r.status, 204);
  assert.match(r.headers.get('Access-Control-Allow-Headers'), /Range/);
});

await t('任何响应里都不出现机器人 token', async () => {
  assert.ok(allText.length > 0);
  for (const s of allText) assert.ok(!s.includes(TOKEN) && !s.includes('SECRET-BOT'), 'token leaked: ' + s.slice(0, 200));
});

console.log(`\n全部 ${n} 项通过`);
