// ═══════════════════════════════════════════
//  FLASHCARD SYSTEM — SRS + Swipe + Animations
// ═══════════════════════════════════════════
// 依赖（script.js 先加载）：S, synth, getVoice, toast, closeVoc, addVocab, removeVocab, closeSidebar
// 依赖（sb.js 先加载）：SB, currentUser
// 依赖（词库文件先加载）：CET4, CET6, OGDEN850
function shuffle(arr){
  const a=[...arr];
  for(let i=a.length-1;i>0;i--){ const j=Math.floor(Math.random()*(i+1)); [a[i],a[j]]=[a[j],a[i]]; }
  return a;
}
const FC_CACHE = new Map(); // word → { ph, audioSrc, audioEl, pos, enDef }；FIFO 上限 200
const FC_CACHE_MAX = 200;

let fcDeck      = [];
let fcIdx       = 0;
let fcFlipped   = false;
let fcCounts    = { again:0, hard:0, good:0, easy:0 };
let fcTotal     = 0;
let fcOrigTotal = 0;   // session 开始时原始卡片数（不含 again 重排）
let fcDoneCount = 0;   // 已完成卡片数（非 again 评分的累计）
let fcSRS       = {};  // word → { nextReview, interval }
let fcMode      = 'book'; // 'book' | 'deck'
let fcFlipShadeTimer = null; // 翻转光影动效的清除计时器，防止快速连翻时动画卡住

// ── FSRS 调度（ts-fsrs，见 vendor/）──
// 记录里额外存一份 fsrs 卡片状态（含 stability/difficulty），
// nextReview/interval 两个旧字段保留不动 —— 组卡、云同步、按钮预览都还在用它们。
// 库按 licon.js / Hypher 的既有约定做降级守卫：vendor 脚本万一没加载，
// 闪卡退回固定间隔照常可用，而不是让整个 srs.js 在顶层抛错、整套背词功能消失。
const _FSRS_RATING  = { again:1, hard:2, good:3, easy:4 };   // = FSRS.Rating.Again/Hard/Good/Easy
const _FALLBACK_IV  = { again:10*60*1000, hard:86400000, good:3*86400000, easy:7*86400000 };
let _fsrsInst = null;
function _sched(){
  if(_fsrsInst) return _fsrsInst;
  if(typeof FSRS === 'undefined') return null;
  return (_fsrsInst = FSRS.fsrs());
}

// JSON 存回来的 due/last_review 是字符串，必须复活成 Date
function _reviveFsrsCard(rec){
  const c = rec && rec.fsrs;
  if(!c) return FSRS.createEmptyCard();
  return { ...c, due:new Date(c.due), last_review: c.last_review ? new Date(c.last_review) : undefined };
}
function _serializeFsrsCard(c){
  return { ...c, due:new Date(c.due).toISOString(),
           last_review: c.last_review ? new Date(c.last_review).toISOString() : undefined };
}

// 实际评分：喂入当前记录 + 评分，返回新的 nextReview/interval/fsrs 三个字段
function applyFsrs(rec, rating, nowMs){
  const s = _sched();
  if(!s){                                   // 降级：库没加载，退回固定间隔
    const iv = _FALLBACK_IV[rating] ?? _FALLBACK_IV.good;
    return { nextReview: nowMs + iv, interval: iv, fsrs: rec && rec.fsrs };
  }
  const now = new Date(nowMs);
  const nc  = s.next(_reviveFsrsCard(rec), now, _FSRS_RATING[rating] ?? _FSRS_RATING.good).card;
  const due = +new Date(nc.due);
  return { nextReview: due, interval: Math.max(0, due - nowMs), fsrs: _serializeFsrsCard(nc) };
}

// 按钮预览：一次性算出 again/hard/good/easy 四档的间隔（ms），供 showFcCard 显示
function previewFsrs(rec, nowMs){
  const s = _sched();
  if(!s) return { ..._FALLBACK_IV };         // 降级：库没加载，按钮显示固定间隔
  const now = new Date(nowMs);
  const rep = s.repeat(_reviveFsrsCard(rec), now);
  const out = {};
  for(const k in _FSRS_RATING){
    const it = rep[_FSRS_RATING[k]];
    out[k] = it ? Math.max(0, +new Date(it.card.due) - nowMs) : 0;
  }
  return out;
}
function fmtInterval(ms){
  const m = Math.round(ms/60000);
  if(m < 60)   return m + '分钟';
  const h = Math.round(ms/3600000);
  if(h < 24)   return h + '小时';
  const d = Math.round(ms/86400000);
  if(d < 30)   return d + '天';
  return Math.round(d/30) + '个月';
}

// ── Vocab deck progress
let vpProgress = {};  // word → { nextReview, correct, wrong }
let vpDeck     = 'cet4';
let vpCount    = 10;

function loadVpProgress(deck){
  // 同上：一次性迁移到 FSRS，用 vpVer 标记避免每次加载都重置。
  // 三个词库（cet4/cet6/ogden）共用一个标记，第一次加载任意词库时一并清空全部，
  // 避免只清了当前 deck、切换到另一个 deck 时又漏掉。
  if(localStorage.getItem('vpVer') !== 'fsrs1'){
    ['cet4','cet6','ogden'].forEach(d => localStorage.removeItem('vp_'+d));
    localStorage.setItem('vpVer', 'fsrs1');
  }
  try{ vpProgress = JSON.parse(localStorage.getItem('vp_'+deck)||'{}'); }catch(e){ vpProgress={}; }
}
function saveVpProgress(deck){
  localStorage.setItem('vp_'+deck, JSON.stringify(vpProgress));
}
async function syncVpFromSupabase(deck){
  if(!currentUser) return;
  try{
    const rows = await SB.selectVocabProgress(currentUser.id, deck);
    // 同 syncFcSRSFromSupabase：云端老记录没有 fsrs 字段，会被当新卡处理，这是升级后
    // "重置为新卡"的预期行为，不是 bug。
    rows.forEach(r=>{
      vpProgress[r.word] = { nextReview: new Date(r.next_review).getTime(), correct: r.correct_count||0, wrong: r.wrong_count||0, interval: r.interval_ms||0 };
    });
    saveVpProgress(deck);
  }catch(e){}
}
let _vpSyncWarnShown = false;
async function pushVpWord(deck, word){
  if(!currentUser) return;
  const p = vpProgress[word] || { nextReview: Date.now(), correct: 0, wrong: 0, interval: 0 };
  try{
    await SB.upsertVocabProgress(currentUser.id, deck, word, p);
  }catch(e){
    console.warn('pushVpWord failed:', e);
    if(!_vpSyncWarnShown){ _vpSyncWarnShown=true; toast('云端同步失败，进度已保存在本地'); }
  }
}

function loadSRS(){
  try{ fcSRS = JSON.parse(localStorage.getItem('fc_srs')||'{}'); }catch(e){ fcSRS={}; }
  // 一次性迁移：换算法（旧固定倍数 → FSRS）后老数据没有可比性，直接清空重来，
  // 用 fcSRSVer 标记避免每次加载都重置
  if(localStorage.getItem('fcSRSVer') !== 'fsrs1'){
    fcSRS = {};
    localStorage.removeItem('fc_srs');
    localStorage.setItem('fcSRSVer', 'fsrs1');
  }
}
function saveSRS(){
  localStorage.setItem('fc_srs', JSON.stringify(fcSRS));
}
async function syncFcSRSFromSupabase(){
  if(!currentUser) return;
  loadSRS();
  try{
    const rows = await SB.selectFcSRS(currentUser.id);
    rows.forEach(r => {
      const cloudNext = new Date(r.next_review).getTime();
      if(!isNaN(cloudNext)){
        const local = fcSRS[r.word];
        // 取云端与本地中较新的 nextReview
        // 注：云端拉回来的老记录没有 fsrs 字段，_reviveFsrsCard 会把它当新卡处理——
        // 这正是升级到 FSRS 后"重置为新卡"想要的效果，不是 bug，不需要特殊处理。
        if(!local || cloudNext > local.nextReview){
          fcSRS[r.word] = { nextReview: cloudNext, interval: r.interval_ms || 0 };
        }
      }
    });
    saveSRS();
  }catch(e){}
}
async function pushFcSRSWord(word){
  if(!currentUser) return;
  const data = fcSRS[word];
  if(!data) return;
  try{ await SB.upsertFcSRS(currentUser.id, word, data); }
  catch(e){ console.warn('pushFcSRS failed:', e); }
}
window._syncFcSRS = syncFcSRSFromSupabase;

function openFlashcard(){
  if(!S.vocab.length){ toast('生词本是空的，先去收藏一些单词！'); return; }
  loadSRS();
  closeVoc();

  // Build deck: due cards first, then new cards, shuffled within each group
  const now = Date.now();
  const due = S.vocab.filter(v => fcSRS[v.word] && fcSRS[v.word].nextReview <= now);
  const newW = S.vocab.filter(v => !fcSRS[v.word]);
  const later = S.vocab.filter(v => fcSRS[v.word] && fcSRS[v.word].nextReview > now);

  fcDeck = [...shuffle(due), ...shuffle(newW), ...shuffle(later)];
  fcIdx  = 0; fcFlipped = false;
  fcCounts = {again:0,hard:0,good:0,easy:0};
  fcTotal     = fcDeck.length;
  fcOrigTotal = fcDeck.length;
  fcDoneCount = 0;
  fcMode = 'book'; // 确保不被上一次词库练习的 'deck' 状态污染

  const fc = document.getElementById('flashcard');
  fc.style.display = '';     // 清除 closeFcAll/showFcResult 遗留的内联 display:none
  fc.classList.add('open');
  document.getElementById('fc-title').textContent = `生词本背诵 · ${fcTotal}词`;
  showFcCard(true);
}

async function showFcCard(instant){
  clearTimeout(fcAutoPlayTimer); fcAutoPlayTimer = null;
  if(fcIdx >= fcDeck.length){ showFcResult(); return; }
  const v = fcDeck[fcIdx];
  fcFlipped = false;

  const card    = document.getElementById('fc-card');
  const ratings = document.getElementById('fc-ratings');

  // Animate out (unless instant first card)
  // ✅ Only use opacity — never write style.transform here,
  //    so that .fc-card.flipped { transform: rotateY(180deg) } always wins
  if(!instant){
    card.style.transition = 'opacity .15s ease';
    card.style.opacity    = '0';
    card.style.transform  = '';   // clear any leftover swipe transform first
    await new Promise(r=>setTimeout(r,160));
  }

  // Reset flip & ratings
  card.style.transition = '';
  card.style.transform  = '';   // ensure CSS class is sole transform owner
  card.classList.remove('flipped','shake');
  ratings.classList.remove('show');
  document.getElementById('fc-swipe-tip')?.classList.remove('show');
  document.getElementById('fc-fb-front').classList.remove('show');
  document.getElementById('fc-fb-back').classList.remove('show');

  // Fill front
  document.getElementById('fc-word').textContent     = v.word;
  document.getElementById('fc-ph-front').textContent = v.ph || '';
  document.getElementById('fc-badge-row').innerHTML  = '';

  // Star button
  const starBtn = document.getElementById('fc-star');
  starBtn.classList.toggle('starred', S.vocab.some(x=>x.word===v.word));

  // Fill back
  document.getElementById('fc-back-word-txt').textContent = v.word;
  document.getElementById('fc-meaning').textContent = v.meaning || '—';
  document.getElementById('fc-ph-back').textContent  = v.ph || '';
  document.getElementById('fc-en-def').textContent   = '';
  document.getElementById('fc-sent').textContent     = v.sent ? v.sent.trim().slice(0,150) : '';

  // Progress
  const pct = fcOrigTotal ? (fcDoneCount/fcOrigTotal)*100 : 0;
  document.getElementById('fc-prog-fill').style.width = pct+'%';
  document.getElementById('fc-count').textContent = fcDoneCount+'/'+fcOrigTotal;

  // 卡组堆叠：按剩余张数切换虚影数量，数量要诚实
  const _left = Math.max(0, fcDeck.length - fcIdx - 1);
  const _stk = document.getElementById('fc-stack');
  if(_stk) _stk.className = 'fc-stack' + (_left === 0 ? ' n0' : _left === 1 ? ' n1' : '');

  // 动态更新评分按钮的时间标签：一次性向 FSRS 要四档预览（again 档也由 FSRS 给出，
  // 不再是写死的 10 分钟）
  const _rec = fcMode==='deck' ? vpProgress[v.word] : fcSRS[v.word];
  const _pv  = previewFsrs(_rec, Date.now());
  document.querySelector('#fc-again .fc-rbtn-time').textContent = fmtInterval(_pv.again);
  document.querySelector('#fc-hard .fc-rbtn-time').textContent  = fmtInterval(_pv.hard);
  document.querySelector('#fc-good .fc-rbtn-time').textContent  = fmtInterval(_pv.good);
  document.querySelector('#fc-easy .fc-rbtn-time').textContent  = fmtInterval(_pv.easy);

  // Fade in — opacity only; transform is 100% owned by CSS class
  card.style.transition = 'opacity .22s ease';
  card.style.opacity    = '1';

  // 记录卡片展示时间，fetchFcWord 完成后再触发自动播放
  fcCardShowTime = Date.now();
  fcAutoPlay = true;

  // Fetch dictionary data (async; also pre-buffers audio element)
  fetchFcWord(v.word, !!v.ph);
}

let fcCardShowTime  = 0;
let fcAutoPlay     = false;
let fcAutoPlayTimer = null;

async function fetchFcWord(word, skipPh=false){
  if(FC_CACHE.has(word)){
    applyFcCache(word, FC_CACHE.get(word), skipPh); return;
  }
  try{
    const r = await fetch(`https://api.dictionaryapi.dev/api/v2/entries/en/${encodeURIComponent(word)}`);
    if(!r.ok) throw new Error('dict ' + r.status);
    const e = (await r.json())[0];
    if(!e) throw new Error('no entry');
    const ph     = e.phonetics?.find(p=>p.text)?.text||'';
    const audioSrc = e.phonetics?.find(p=>p.audio?.length>0)?.audio||'';
    const pos    = e.meanings?.[0]?.partOfSpeech||'';
    const enDef  = e.meanings?.[0]?.definitions?.[0]?.definition||'';
    // 预缓冲音频，消除点击时的加载延迟
    let audioEl = null;
    if(audioSrc){
      audioEl = new Audio(audioSrc);
      audioEl.preload = 'auto';
      audioEl.load();
    }
    const data = {ph, audioSrc, audioEl, pos, enDef};
    FC_CACHE.set(word, data);
    if(FC_CACHE.size > FC_CACHE_MAX) FC_CACHE.delete(FC_CACHE.keys().next().value);
    applyFcCache(word, data, skipPh);
  }catch(e){
    // 网络失败：直接用 TTS 自动播放
    if(fcAutoPlay && document.getElementById('fc-word').textContent === word){
      fcAutoPlay = false;
      const delay = Math.max(0, 320 - (Date.now() - fcCardShowTime));
      fcAutoPlayTimer = setTimeout(() => fireFcPlay(word, null), delay);
    }
  }
}

function applyFcCache(word, data, skipPh=false){
  if(document.getElementById('fc-word').textContent !== word) return;
  if(data.ph && !skipPh){
    document.getElementById('fc-ph-front').textContent = data.ph;
    document.getElementById('fc-ph-back').textContent  = data.ph;
  }
  if(data.pos){
    const badge = document.createElement('span');
    badge.className = 'fc-badge fc-badge-pos';
    badge.textContent = data.pos;
    document.getElementById('fc-badge-row').appendChild(badge);
  }
  if(data.enDef)
    document.getElementById('fc-en-def').textContent = data.enDef;

  // 自动播放：等动画完成后触发（至少距卡片出现 320ms）
  if(fcAutoPlay){
    fcAutoPlay = false;
    const delay = Math.max(0, 320 - (Date.now() - fcCardShowTime));
    fcAutoPlayTimer = setTimeout(() => fireFcPlay(word, data), delay);
  }
}

// 统一播放函数：优先用预缓冲 Audio（readyState≥2 才用），否则 TTS
function fireFcPlay(word, data){
  if(document.getElementById('fc-word').textContent !== word) return;
  const btn = document.getElementById('fc-spk');
  btn.classList.add('spk-active');
  const done = () => btn.classList.remove('spk-active');
  const el = data?.audioEl;
  if(el && el.readyState >= 2){
    el.currentTime = 0;
    el.onended = done; el.onerror = done;
    el.play().catch(() => { speakWordFc(word); done(); });
  } else {
    speakWordFc(word); setTimeout(done, 1200);
  }
}

// TTS 播放：固定使用用户选定音源，不随机漂移
function speakWordFc(w){
  const u = new SpeechSynthesisUtterance(w);
  u.lang = S.accentUS ? 'en-US' : 'en-GB';
  u.rate = 0.85;
  const v = getVoice(); if(v) u.voice = v;
  synth.cancel(); synth.speak(u);
}

function flipFcCard(){
  const card    = document.getElementById('fc-card');
  const ratings = document.getElementById('fc-ratings');
  // 清除 showFcCard fade-in 遗留的 opacity transition，交回 CSS 翻转过渡
  card.style.transition = '';
  card.style.transform  = '';
  fcFlipped = !fcFlipped;
  card.classList.toggle('flipped', fcFlipped);

  // 翻转光影：接住光线的暗部一闪；快速连翻时先清掉上一次的计时器，避免动画卡住
  clearTimeout(fcFlipShadeTimer);
  card.classList.remove('flipping');
  void card.offsetWidth; // 强制 reflow，确保重新加 class 能重触发 animation
  card.classList.add('flipping');
  fcFlipShadeTimer = setTimeout(()=> card.classList.remove('flipping'), 480);

  if(fcFlipped){
    // 翻到背面：280ms 后显示评级按钮 + 滑动提示（滑动评分只在背面有效）
    setTimeout(()=> {
      ratings.classList.add('show');
      document.getElementById('fc-swipe-tip')?.classList.toggle('show', true);
    }, 280);
  } else {
    // 翻回正面：立刻隐藏评级按钮 + 滑动提示
    ratings.classList.remove('show');
    document.getElementById('fc-swipe-tip')?.classList.toggle('show', false);
  }
}

function rateFcCard(rating){
  if(!fcFlipped) return;
  markStudiedToday();
  const v   = fcDeck[fcIdx];
  const now = Date.now();

  // FSRS 调度：把当前记录（含上次的 fsrs 卡片状态）喂给算法，拿回新的 nextReview/interval/fsrs
  const rec = fcMode==='deck' ? vpProgress[v.word] : fcSRS[v.word];
  const nx  = applyFsrs(rec, rating, now);

  if(fcMode === 'deck'){
    const prev = vpProgress[v.word] || { correct:0, wrong:0, interval:0 };
    vpProgress[v.word] = {
      nextReview: nx.nextReview,
      interval:   nx.interval,
      fsrs:       nx.fsrs,
      correct: prev.correct + (rating !== 'again' ? 1 : 0),
      wrong:   prev.wrong   + (rating === 'again' ? 1 : 0)
    };
    saveVpProgress(vpDeck);
    pushVpWord(vpDeck, v.word);
  } else {
    fcSRS[v.word] = { nextReview: nx.nextReview, interval: nx.interval, fsrs: nx.fsrs, lastRating: rating };
    saveSRS();
    pushFcSRSWord(v.word);
  }
  fcCounts[rating]++;

  // Again：把卡片重新插入本轮靠后的位置（2~4 张之后）；最多扩充至原始牌组的 3 倍防无限增长
  if(rating === 'again'){
    if(fcDeck.length < fcOrigTotal * 3){
      const offset = 2 + Math.floor(Math.random() * 3);
      const reinsert = Math.min(fcIdx + 1 + offset, fcDeck.length);
      fcDeck.splice(reinsert, 0, {...v});
    }
  } else {
    fcDoneCount++;
  }

  // Feedback animation
  const isBad = rating === 'again' || rating === 'hard';
  const scene = document.getElementById('fc-card').closest('.fc-scene');
  if(isBad){
    // Shake the scene wrapper — never touch card's own transform
    scene.classList.add('shake');
    scene.addEventListener('animationend', ()=> scene.classList.remove('shake'), {once:true});
    const fb = document.getElementById('fc-fb-back');
    fb.textContent = '✗'; fb.style.background = 'rgba(220,38,38,.12)';
    fb.classList.add('show');
  } else {
    const fb = document.getElementById('fc-fb-back');
    fb.textContent = rating==='easy'?'★':'✓';
    fb.style.background = rating==='easy'?'rgba(37,99,235,.1)':'rgba(5,150,105,.1)';
    fb.classList.add('show');
  }

  setTimeout(()=> { fcIdx++; showFcCard(false); }, isBad ? 420 : 340);
}

function showFcResult(){
  document.getElementById('flashcard').classList.remove('open');
  document.getElementById('flashcard').style.display = 'none';
  const res = document.getElementById('fc-result');
  res.style.display = 'flex'; res.classList.add('open');

  const total = fcCounts.again+fcCounts.hard+fcCounts.good+fcCounts.easy;
  const known = fcCounts.good+fcCounts.easy;
  const pct   = total ? Math.round(known/total*100) : 0;

  const emoji = pct>=80?'🎉':pct>=50?'💪':'📚';
  document.getElementById('fc-res-emoji').textContent = emoji;
  document.getElementById('fc-res-sub').textContent   = `掌握率 ${pct}%`;
  // Celebrate a strong session (≥80% mastery)
  if(pct >= 80 && total > 0 && typeof confettiBurst === 'function'){
    setTimeout(() => confettiBurst({ y: window.innerHeight * 0.30 }), 220);
  }
  document.getElementById('fc-res-stats').innerHTML = `
    <div class="fc-stat" style="background:#FEE2E2">
      <div class="fc-stat-n" style="color:#DC2626">${fcCounts.again}</div>
      <div class="fc-stat-l" style="color:#DC2626">不认识</div>
    </div>
    <div class="fc-stat" style="background:#FEF3C7">
      <div class="fc-stat-n" style="color:#D97706">${fcCounts.hard}</div>
      <div class="fc-stat-l" style="color:#D97706">较难</div>
    </div>
    <div class="fc-stat" style="background:#D1FAE5">
      <div class="fc-stat-n" style="color:#059669">${fcCounts.good}</div>
      <div class="fc-stat-l" style="color:#059669">认识</div>
    </div>
    <div class="fc-stat" style="background:#DBEAFE">
      <div class="fc-stat-n" style="color:#2563EB">${fcCounts.easy}</div>
      <div class="fc-stat-l" style="color:#2563EB">很简单</div>
    </div>`;
}

function closeFcAll(){
  document.getElementById('flashcard').classList.remove('open');
  document.getElementById('flashcard').style.display = 'none';
  document.getElementById('fc-result').classList.remove('open');
  document.getElementById('fc-result').style.display = 'none';
  if(fcMode === 'deck') openVocabPanel();
}

// ── Card swipe gesture（Pointer Events：触屏 + 桌面鼠标统一处理）
// 拖拽位移施加在 .fc-scene 上，card 本身只做 rotateY 翻转，互不干扰
(()=>{
  const card = document.getElementById('fc-card');
  let sx=0, sy=0, dx=0, dy=0, moving=false, movedAny=false, dragging=false, downTarget=null, pid=null;
  let lastX=0, lastT=0, vx=0;   // vx: 横向速度，px/ms，用于识别"快速轻扫"

  // 判定距离：随卡片宽度自适应（原先写死 100px ≈ 卡宽 29%，偏大）
  function swipeDist(){
    const w = card.getBoundingClientRect().width || 350;
    return Math.max(56, w * 0.22);
  }

  // 拖动判定提示：跟手写入 --sw 与方向类；只在已翻面（会真的评分）时才给承诺
  function updateSwipeHint(scn){
    if(fcFlipped){
      const r = Math.min(1, Math.abs(dx)/swipeDist());
      scn.style.setProperty('--sw', r);
      scn.classList.toggle('sw-right', dx>0);
      scn.classList.toggle('sw-left', dx<0);
    } else {
      scn.style.setProperty('--sw', 0);
      scn.classList.remove('sw-right','sw-left');
    }
  }
  function clearSwipeHint(scn){
    scn.style.setProperty('--sw', 0);
    scn.classList.remove('sw-right','sw-left');
  }

  card.addEventListener('pointerdown', e=>{
    if(e.pointerType==='mouse' && e.button!==0) return; // 只响应左键
    sx=e.clientX; sy=e.clientY;
    dx=0; dy=0; moving=false; movedAny=false; dragging=true;
    downTarget=e.target; pid=e.pointerId;
    lastX=e.clientX; lastT=e.timeStamp||performance.now(); vx=0; // 重置速度，避免残留上一次拖动的速度
    // 注意：这里不能 setPointerCapture —— 一旦捕获，后续 pointer 事件连同 click
    // 都会重定向到卡片本身，卡上的发音/收藏按钮既收不到点击、又会被误判成"点卡片翻转"。
    // 捕获推迟到 pointermove 里真正判定为拖动之后再做。
    card.closest('.fc-scene').style.transition='none';
  });

  card.addEventListener('pointermove', e=>{
    if(!dragging) return;
    dx=e.clientX-sx;
    dy=e.clientY-sy;
    // 只要明显移动过（任意方向）就不再算"点按"：竖滑不评分，但也绝不能被当成点击去翻牌
    if(Math.abs(dx)>8 || Math.abs(dy)>8) movedAny=true;
    // 拇指自然滑动是弧线，横向严格大于纵向过苛；放宽到 70% 让弧线也能起手
    // （不能更松，否则会抢走背面长释义的纵向滚动）
    if(Math.abs(dx)<Math.abs(dy)*0.7 && !moving) return;
    if(Math.abs(dx)<6 && !moving) return;
    // 确认是拖动了才抢占指针：此后手指/鼠标滑出卡片也能继续收到事件，
    // 而单纯点按（never moving）全程不捕获，按钮的 click 照常派发
    if(!moving){ moving=true; try{ card.setPointerCapture(pid); }catch(err){} }
    const scn = card.closest('.fc-scene');
    scn.style.transform=`translateX(${dx}px) rotate(${dx*0.03}deg)`;
    updateSwipeHint(scn);
    // 更新横向速度（指数平滑，避免最后一帧抖动单独决定结果）
    const _t = e.timeStamp || performance.now();
    const _dt = _t - lastT;
    if(_dt > 0){
      const inst = (e.clientX - lastX) / _dt;
      vx = vx ? vx*0.7 + inst*0.3 : inst;
      lastX = e.clientX; lastT = _t;
    }
  });

  function endDrag(e){
    const scn = card.closest('.fc-scene');
    dragging=false;
    if(moving){ try{ card.releasePointerCapture(pid); }catch(err){} }
    if(!moving){
      scn.style.transition='';
      // 竖滑/斜滑没达到横向拖动门槛：什么都不做。若在这里翻牌，用户竖滑一下卡片就
      // 翻回正面，而正面滑动不评分 —— 表现就是"上下滑一下之后左右滑就不灵了"
      if(movedAny) return;
      // 用按下时的原始落点判断，而不是 e.target：结束事件的 target 可能已被指针捕获改写
      if(downTarget && downTarget.closest('button')) return;
      flipFcCard(); return;
    }
    const _far  = Math.abs(dx) > swipeDist();
    // 快速轻扫：速度够快且方向一致，即使位移不大也算数（真人最常用的手势）
    const _fast = Math.abs(vx) > 0.45 && Math.abs(dx) > 24 && Math.sign(vx) === Math.sign(dx);
    if((_far || _fast) && fcFlipped){
      // 滑出屏幕：scene 飞走
      const dir = dx>0?1:-1;
      scn.style.transition='transform .25s ease, opacity .25s ease';
      scn.style.transform =`translateX(${dir*110}%)`;
      scn.style.opacity   ='0';
      clearSwipeHint(scn);
      const rating = dx>0?'good':'again';
      setTimeout(()=>{
        scn.style.transition='none';
        scn.style.transform='';
        scn.style.opacity='1';
        rateFcCard(rating);
      }, 270);
    } else {
      bounceBack(scn);
    }
  }

  // 回弹：scene 归位即可，card 的 rotateY 由 CSS class 全程控制，无需修改；同时清掉拖动提示
  function bounceBack(scn){
    scn.style.transition='transform .35s cubic-bezier(.34,1.4,.64,1)';
    scn.style.transform='';
    clearSwipeHint(scn);
    setTimeout(()=>{ scn.style.transition=''; }, 380);
  }

  card.addEventListener('pointerup', endDrag);

  // 指针被系统中断（如来电、切窗口）：一律按回弹处理，不触发翻转/评分
  card.addEventListener('pointercancel', ()=>{
    dragging=false;
    bounceBack(card.closest('.fc-scene'));
  });
})();

// ── Button listeners
document.getElementById('voc-flash-btn').addEventListener('click', openFlashcard);
document.getElementById('fc-exit').addEventListener('click', closeFcAll);
document.getElementById('fc-again').addEventListener('click', ()=>rateFcCard('again'));
document.getElementById('fc-hard') .addEventListener('click', ()=>rateFcCard('hard'));
document.getElementById('fc-good') .addEventListener('click', ()=>rateFcCard('good'));
document.getElementById('fc-easy') .addEventListener('click', ()=>rateFcCard('easy'));

function playFcAudio(btn){
  clearTimeout(fcAutoPlayTimer); fcAutoPlayTimer = null;
  fcAutoPlay = false; // 阻止 API 延迟返回后再次触发自动播放
  const w = document.getElementById('fc-word').textContent;
  const d = FC_CACHE.get(w);
  btn.classList.add('spk-active');
  const done = () => btn.classList.remove('spk-active');
  const el = d?.audioEl;
  // readyState >= 2：浏览器已缓冲足够数据，可立即播放；否则同步走 TTS
  // 注意：TTS 必须在此同步调用（用户手势上下文），放入 .catch() 的异步回调 iOS 会静默拒绝
  if(el && el.readyState >= 2){
    el.currentTime = 0;
    el.onended = done; el.onerror = done;
    el.play().catch(() => { speakWordFc(w); done(); });
  } else {
    speakWordFc(w); setTimeout(done, 1200);
  }
}
document.getElementById('fc-spk').addEventListener('click', e=>{
  e.stopPropagation(); playFcAudio(e.currentTarget);
});
document.getElementById('fc-spk-back').addEventListener('click', e=>{
  e.stopPropagation();
  playFcAudio(e.currentTarget);
});
document.getElementById('fc-star').addEventListener('click', e=>{
  e.stopPropagation();
  const v=fcDeck[fcIdx];
  if(!v) return;
  const inV=S.vocab.some(x=>x.word===v.word);
  // 走 removeVocab/addVocab 而不是直接动 S.vocab：它们会一并清理 savedWords、
  // 刷新正文高亮、存盘并同步云端（直接 splice 会漏掉这些）
  if(inV){ removeVocab(v.word); toast('「'+v.word+'」已移出生词本'); }
  else   { addVocab(v.word, v.meaning||''); toast('「'+v.word+'」已加入生词本'); }
  e.currentTarget.classList.toggle('starred',!inV);
});

document.getElementById('fc-res-again').addEventListener('click', ()=>{
  document.getElementById('fc-result').classList.remove('open');
  document.getElementById('fc-result').style.display='none';
  if(fcMode === 'deck') startDeckSession();
  else openFlashcard();
});
document.getElementById('fc-res-back').addEventListener('click', ()=>{
  closeFcAll();
  if(fcMode !== 'deck'){
    document.getElementById('voc').classList.add('open');
    document.getElementById('overlay').classList.add('vis');
  }
});

// Keyboard shortcuts
document.addEventListener('keydown', e=>{
  if(!document.getElementById('flashcard').classList.contains('open')) return;
  if(e.code==='Space'||e.code==='ArrowUp'){ e.preventDefault(); flipFcCard(); }
  if(e.key==='1') rateFcCard('again');
  if(e.key==='2') rateFcCard('hard');
  if(e.key==='3') rateFcCard('good');
  if(e.key==='4') rateFcCard('easy');
  if(e.key==='Escape') closeFcAll();
});


// ═══════════════════════════════════════════
//  VOCAB DECK PANEL
// ═══════════════════════════════════════════
function openVocabPanel(){
  loadVpProgress(vpDeck);
  updateVpStats();
  updateStreakUI();
  document.getElementById('vocab-panel').style.display = 'block';
  document.getElementById('landing').style.display = 'none';
  document.getElementById('library').classList.remove('open');
  closeSidebar();
}

function closeVocabPanel(){
  document.getElementById('vocab-panel').style.display = 'none';
  document.getElementById('landing').style.display = '';
}

// ── STREAK
function loadStreak(){
  try{ return JSON.parse(localStorage.getItem('linggo_streak')||'{}'); }catch(e){ return {}; }
}
function markStudiedToday(){
  const today = new Date().toISOString().slice(0,10);
  const s = loadStreak();
  if(s.lastDate === today) return;
  const yesterday = new Date(Date.now()-86400000).toISOString().slice(0,10);
  const count = s.lastDate === yesterday ? (s.count||0)+1 : 1;
  localStorage.setItem('linggo_streak', JSON.stringify({ lastDate:today, count }));
  updateStreakUI();
}
function updateStreakUI(){
  const s = loadStreak();
  const el = document.getElementById('vp-streak');
  if(!el) return;
  if(s.count >= 1){
    document.getElementById('vp-streak-n').textContent = s.count;
    el.classList.add('show');
  } else {
    el.classList.remove('show');
  }
}

function getDeckWordList(deck){
  if(deck === 'cet4')  return typeof CET4     !== 'undefined' ? CET4     : [];
  if(deck === 'cet6')  return typeof CET6     !== 'undefined' ? CET6     : [];
  if(deck === 'ogden') return typeof OGDEN850 !== 'undefined' ? OGDEN850 : [];
  return [];
}

function updateVpStats(){
  const now = Date.now();
  ['cet4','cet6','ogden'].forEach(deck => {
    const wordList = getDeckWordList(deck);
    const total    = wordList.length;
    const prog = deck === vpDeck ? vpProgress : (() => {
      try{ return JSON.parse(localStorage.getItem('vp_'+deck)||'{}'); }catch(e){ return {}; }
    })();
    const newCount       = wordList.filter(w => !prog[w.w]).length;
    // 互斥分类：mastered 优先，due/scheduled 只算未掌握词
    const masteredCount  = wordList.filter(w => prog[w.w] && (prog[w.w].correct||0) >= 3).length;
    const dueCount       = wordList.filter(w => prog[w.w] && (prog[w.w].correct||0) < 3 && prog[w.w].nextReview <= now).length;
    const scheduledCount = wordList.filter(w => prog[w.w] && (prog[w.w].correct||0) < 3 && prog[w.w].nextReview > now).length;
    const pct = total > 0 ? Math.round(masteredCount / total * 100) : 0;
    const elId = deck + '-progress';
    const el = document.getElementById(elId);
    const scheduledStr = scheduledCount > 0 ? ` · <span style="color:#f59e0b">学习中 ${scheduledCount}</span>` : '';
    if(el) el.innerHTML =
      `新词 ${newCount}${scheduledStr} · 待复习 ${dueCount}<br>` +
      `<span style="color:var(--green-2,#16A34A);font-weight:700">已掌握 ${masteredCount}/${total}（${pct}%）</span>`;
    const barEl = document.getElementById(deck+'-bar');
    if(barEl) barEl.style.width = pct + '%';
  });
}

function startDeckSession(){
  _vpSyncWarnShown = false;
  const wordList = getDeckWordList(vpDeck);
  if(!wordList.length){ toast('词库加载失败'); return; }
  const now = Date.now();
  const due  = wordList.filter(w => vpProgress[w.w] && vpProgress[w.w].nextReview <= now);
  const newW = wordList.filter(w => !vpProgress[w.w]);
  const pool = [...shuffle(due), ...shuffle(newW)];

  fcDeck  = pool.slice(0, vpCount).map(w => ({ word:w.w, ph:w.ph, meaning:w.cn }));
  fcIdx   = 0; fcFlipped = false;
  fcCounts = {again:0,hard:0,good:0,easy:0};
  fcTotal     = fcDeck.length;
  fcOrigTotal = fcDeck.length;
  fcDoneCount = 0;
  fcMode  = 'deck';

  if(!fcDeck.length){ toast('今日没有待复习单词，明天再来！'); return; }

  document.getElementById('vocab-panel').style.display = 'none';
  const fc = document.getElementById('flashcard');
  fc.style.display = '';
  fc.classList.add('open');
  const deckLabel = vpDeck === 'ogden' ? 'Ogden 850' : vpDeck.toUpperCase().replace('CET','CET-');
  document.getElementById('fc-title').textContent = `${deckLabel} · ${fcTotal} 词`;
  document.getElementById('fc-res-back').textContent = '返回词库';
  showFcCard(true);
}

// ── Vocab panel event listeners
document.getElementById('deck-open-btn').addEventListener('click', openVocabPanel);
document.getElementById('vp-close').addEventListener('click', closeVocabPanel);
document.getElementById('vp-start').addEventListener('click', startDeckSession);

// Deck selector
document.querySelectorAll('.vp-deck').forEach(el=>{
  el.addEventListener('click', ()=>{
    document.querySelectorAll('.vp-deck').forEach(d=>d.classList.remove('on'));
    el.classList.add('on');
    vpDeck = el.dataset.deck;
    loadVpProgress(vpDeck);
    updateVpStats();
  });
});

// Session count selector
document.querySelectorAll('.vp-nb').forEach(btn=>{
  btn.addEventListener('click', ()=>{
    document.querySelectorAll('.vp-nb').forEach(b=>b.classList.remove('on'));
    btn.classList.add('on');
    vpCount = parseInt(btn.dataset.n, 10);
  });
});

// Sync from Supabase on login
window._syncVpProgress = async function(){
  await syncVpFromSupabase(vpDeck);
  if(document.getElementById('vocab-panel').style.display !== 'none') updateVpStats();
};
