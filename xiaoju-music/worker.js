// 小橘音乐 · Telegram 频道音频中转（Cloudflare Worker）
//
// 音频文件存在 Telegram 频道里，但网页没法直接播放 Telegram 的音乐文件。这个 Worker
// 在服务端持有机器人 token，把「频道消息号」换成浏览器能直接播放的地址：
//   GET  /              播放页
//   GET  /api/tracks    歌单 JSON（KV 里登记过的全部音频，新的在前）
//   GET  /a/<消息号>     音频流，透传 Range（iOS Safari 开始播放、拖进度条都要 206）
//   POST /tg-webhook    Telegram 推送频道新帖，音频自动登记进 KV
//
// 绑定：TRACKS（KV）、TG_BOT_TOKEN / TG_WEBHOOK_SECRET（secret）、
//       CHANNEL_ID / CHANNEL_USERNAME（普通变量）

const TG = 'https://api.telegram.org';
// 官方 Bot API 的 getFile 只能取 20 MB 以内的文件
const BOT_DOWNLOAD_LIMIT = 20 * 1024 * 1024;
// getFile 给的下载路径保证至少 1 小时有效，留 10 分钟余量
const PATH_TTL_MS = 50 * 60 * 1000;
const LIST_TTL_MS = 30 * 1000;
const TOO_BIG = '文件超过 20 MB，Telegram 机器人接口无法下载';
const UNAVAILABLE = 'Telegram 暂时取不到这个文件，请稍后再试';

const MIME_BY_EXT = {
  mp3: 'audio/mpeg', m4a: 'audio/mp4', mp4: 'audio/mp4', aac: 'audio/aac',
  flac: 'audio/flac', wav: 'audio/wav', ogg: 'audio/ogg', oga: 'audio/ogg',
  opus: 'audio/ogg', webm: 'audio/webm',
};

// 两个缓存都只活在单个 isolate 里，丢了无妨，只是省几次 getFile / KV list
const filePaths = new Map(); // 消息号 -> { path, exp }
let listCache = null;        // { body, exp }

class HttpError extends Error {
  constructor(status, message) {
    super(message);
    this.status = status;
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
      if (method !== 'GET' && method !== 'HEAD') return text('Method Not Allowed', 405);
      if (path === '/') {
        return new Response(method === 'HEAD' ? null : PAGE, {
          headers: { 'Content-Type': 'text/html; charset=utf-8', 'Cache-Control': 'no-cache' },
        });
      }
      if (path === '/api/tracks') return await trackList(env);
      const m = path.match(/^\/a\/(\d{1,10})(?:\.[a-z0-9]{1,5})?$/i);
      if (m) return await audio(request, env, Number(m[1]), url.searchParams.has('dl'));
      return text('Not Found', 404);
    } catch (e) {
      if (e instanceof HttpError) return text(e.message, e.status);
      return text('服务器出错了，请稍后再试', 500);
    }
  },
};

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
  const key = 't:' + post.message_id;
  const rec = toRecord(post);
  if (rec) await env.TRACKS.put(key, JSON.stringify(rec), { metadata: toMeta(rec) });
  else if (update.edited_channel_post) await env.TRACKS.delete(key); // 编辑后已不含音频
  listCache = null;
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

// 歌单只靠 list() 带出来的 metadata 拼，不逐条 get；KV 的 metadata 上限 1024 字节
function toMeta(rec) {
  const meta = {
    id: rec.id, kind: rec.kind, title: cut(rec.title, 80), performer: cut(rec.performer, 60),
    mime: rec.mime, size: rec.size, duration: rec.duration, date: rec.date,
  };
  if (byteLength(meta) > 1000) {
    meta.title = cut(meta.title, 30);
    meta.performer = cut(meta.performer, 20);
  }
  return meta;
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

// ── 歌单 ─────────────────────────────────────────────────────────

async function trackList(env) {
  const now = Date.now();
  if (!listCache || listCache.exp < now) {
    const tracks = [];
    let cursor = null;
    do {
      const opts = { prefix: 't:' };
      if (cursor) opts.cursor = cursor;
      const page = await env.TRACKS.list(opts);
      for (const k of page.keys) {
        if (k.metadata) tracks.push({ ...k.metadata, big: (k.metadata.size || 0) > BOT_DOWNLOAD_LIMIT });
      }
      cursor = page.list_complete ? null : page.cursor;
    } while (cursor);
    tracks.sort((a, b) => b.id - a.id);
    listCache = { body: JSON.stringify({ channel: env.CHANNEL_USERNAME || '', tracks }), exp: now + LIST_TTL_MS };
  }
  return new Response(listCache.body, {
    headers: cors({ 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'public, max-age=30' }),
  });
}

// ── 音频流 ───────────────────────────────────────────────────────

async function audio(request, env, id, download) {
  const rec = await env.TRACKS.get('t:' + id, 'json');
  if (!rec) throw new HttpError(404, '没有这首歌');

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
  if (rec.size > BOT_DOWNLOAD_LIMIT) throw new HttpError(413, TOO_BIG);

  // 只透传单段 Range；多段 Range 不转发，退回整个文件（200）
  const raw = (request.headers.get('Range') || '').trim();
  const range = /^bytes=(\d+-\d*|-\d+)$/.test(raw) ? raw : null;
  const res = await fetchFromTelegram(env, rec, range);
  if (![200, 206, 416].includes(res.status)) {
    if (res.body) res.body.cancel();
    throw new HttpError(502, UNAVAILABLE);
  }
  for (const h of ['Content-Length', 'Content-Range']) {
    const v = res.headers.get(h);
    if (v) headers[h] = v;
  }
  if (res.status === 416) headers['Cache-Control'] = 'no-store';
  return new Response(res.body, { status: res.status, headers });
}

async function fetchFromTelegram(env, rec, range) {
  for (let attempt = 0; ; attempt++) {
    const path = await filePath(env, rec, attempt > 0);
    const res = await fetch(`${TG}/file/bot${env.TG_BOT_TOKEN}/${path}`, { headers: range ? { Range: range } : {} });
    // 缓存的下载路径过期会回 4xx：重新 getFile 换个新路径，再试一次
    if (attempt === 0 && [401, 403, 404].includes(res.status)) {
      if (res.body) res.body.cancel();
      continue;
    }
    return res;
  }
}

async function filePath(env, rec, refresh) {
  const hit = filePaths.get(rec.id);
  if (hit && !refresh && hit.exp > Date.now()) return hit.path;

  const r = await fetch(`${TG}/bot${env.TG_BOT_TOKEN}/getFile?file_id=${encodeURIComponent(rec.file_id)}`);
  const j = await r.json().catch(() => null);
  if (!j || !j.ok || !j.result || !j.result.file_path) {
    const tooBig = /too big/i.test((j && j.description) || '');
    throw new HttpError(tooBig ? 413 : 502, tooBig ? TOO_BIG : UNAVAILABLE);
  }
  if (filePaths.size > 500) filePaths.clear();
  filePaths.set(rec.id, { path: j.result.file_path, exp: Date.now() + PATH_TTL_MS });
  return j.result.file_path;
}

function contentDisposition(rec, download) {
  const name = rec.name || rec.title + extFromMime(rec.mime);
  const fallback = 'track-' + rec.id + '.' + (extOf(name) || 'bin');
  // RFC 5987：encodeURIComponent 不转义 ' ( ) *，这里补上
  const encoded = encodeURIComponent(name).replace(/['()*]/g, c => '%' + c.charCodeAt(0).toString(16).toUpperCase());
  return `${download ? 'attachment' : 'inline'}; filename="${fallback}"; filename*=UTF-8''${encoded}`;
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

function byteLength(obj) {
  return new TextEncoder().encode(JSON.stringify(obj)).length;
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

// ── 播放页（客户端脚本里不用反引号和 ${，免得和外层模板字符串打架）──────

const PAGE = `<!doctype html>
<html lang="zh-CN">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1, viewport-fit=cover">
<title>小橘音乐</title>
<meta name="theme-color" content="#fffaf5" media="(prefers-color-scheme: light)">
<meta name="theme-color" content="#171412" media="(prefers-color-scheme: dark)">
<link rel="icon" href="data:image/svg+xml,<svg xmlns='http://www.w3.org/2000/svg' viewBox='0 0 100 100'><text y='.9em' font-size='90'>🍊</text></svg>">
<style>
:root{--bg:#fffaf5;--card:#fff;--text:#1c1917;--muted:#78716c;--line:#f0e6db;--accent:#ea580c;color-scheme:light}
@media (prefers-color-scheme:dark){:root{--bg:#171412;--card:#221d1a;--text:#f5f0eb;--muted:#a8a29e;--line:#2f2925;--accent:#fb923c;color-scheme:dark}}
*{box-sizing:border-box}
body{margin:0;background:var(--bg);color:var(--text);font:16px/1.5 -apple-system,BlinkMacSystemFont,"PingFang SC","Hiragino Sans GB","Microsoft YaHei",sans-serif;-webkit-text-size-adjust:100%}
header,main{max-width:720px;margin:0 auto;padding:0 16px}
header{padding-top:28px;padding-bottom:8px}
h1{font-size:24px;line-height:1.3;margin:0}
.sub{margin:4px 0 0;color:var(--muted);font-size:14px}
.sub a{color:var(--accent);text-decoration:none}
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
[hidden]{display:none!important}
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
  var tracks = [], cur = -1, channel = '';

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

  function render(){
    list.textContent = '';
    tracks.forEach(function(t, i){
      var li = el('li', 'track' + (t.big ? ' big' : ''));
      var btn = el('button', 'play');
      btn.type = 'button';
      btn.setAttribute('aria-label', '播放 ' + t.title);
      btn.appendChild(el('span', 'num', String(i + 1)));
      var info = el('span', 'info');
      info.appendChild(el('span', 'title', t.title));
      var sub = [artist(t.performer), mmss(t.duration), mb(t.size)].filter(Boolean).join(' · ');
      info.appendChild(el('span', 'meta', t.big ? '超过 20 MB，无法在网页播放' : sub));
      btn.appendChild(info);
      if(t.big) btn.disabled = true;
      btn.addEventListener('click', function(){ play(i); });
      li.appendChild(btn);
      var links = el('span', 'links');
      if(!t.big){
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

  function select(i){
    var t = tracks[i];
    cur = i;
    audio.src = '/a/' + t.id;
    nowTitle.textContent = t.title;
    nowArtist.textContent = artist(t.performer);
    player.hidden = false;
    document.title = t.title + ' · 小橘音乐';
    for(var k = 0; k < list.children.length; k++) list.children[k].classList.toggle('on', k === i);
    if('mediaSession' in navigator && typeof MediaMetadata !== 'undefined'){
      navigator.mediaSession.metadata = new MediaMetadata({ title: t.title, artist: artist(t.performer), album: '小橘音乐' });
    }
    history.replaceState(null, '', '#' + t.id);
  }

  function play(i){
    if(i < 0 || i >= tracks.length || tracks[i].big) return;
    if(i === cur && !audio.paused){ audio.pause(); return; }
    if(i !== cur) select(i);
    var p = audio.play();
    if(p && p.catch) p.catch(function(){});
  }

  function step(dir){
    for(var i = cur + dir; i >= 0 && i < tracks.length; i += dir){
      if(!tracks[i].big){ play(i); return; }
    }
  }

  audio.addEventListener('ended', function(){ step(1); });
  audio.addEventListener('error', function(){
    if(cur >= 0) nowArtist.textContent = '这首暂时播放不了，稍后再试';
  });
  if('mediaSession' in navigator){
    try {
      navigator.mediaSession.setActionHandler('previoustrack', function(){ step(-1); });
      navigator.mediaSession.setActionHandler('nexttrack', function(){ step(1); });
    } catch(e){}
  }

  function load(){
    statusEl.hidden = false;
    statusEl.textContent = '加载中…';
    fetch('/api/tracks').then(function(r){
      if(!r.ok) throw new Error(String(r.status));
      return r.json();
    }).then(function(d){
      tracks = d.tracks || [];
      channel = d.channel || '';
      if(channel) document.getElementById('tg').href = 'https://t.me/' + channel;
      document.getElementById('count').textContent = tracks.length ? ' · ' + tracks.length + ' 首' : '';
      if(!tracks.length){ statusEl.textContent = '频道里还没有音频'; return; }
      statusEl.hidden = true;
      render();
      // 分享链接 /#消息号：选中那首（浏览器不允许自动出声，需要再点一下播放）
      var want = Number(location.hash.slice(1));
      for(var i = 0; i < tracks.length; i++){
        if(tracks[i].id === want && !tracks[i].big){
          select(i);
          list.children[i].scrollIntoView({ block: 'center' });
          break;
        }
      }
    }).catch(function(){
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
