// ═══════════════════════════════════════════
//  FLASHCARD SYSTEM — SRS + Swipe + Animations
// ═══════════════════════════════════════════
// 依赖（script.js 先加载）：S, synth, getVoice, toast, closeVoc, addVocab, removeVocab, closeSidebar
// 依赖（sb.js 先加载）：SB, currentUser
// 依赖（词库文件先加载）：CET4, CET6, OGDEN850
const SRS_INTERVALS = { again: 10*60*1000, hard: 86400000, good: 3*86400000, easy: 7*86400000 };
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

// ── 动态间隔计算（类 Anki：间隔随正确次数成倍增长）
function calcNextInterval(rating, prevInterval){
  if(rating === 'again') return SRS_INTERVALS.again;
  if(rating === 'hard')  return Math.round(Math.max(SRS_INTERVALS.hard, (prevInterval || SRS_INTERVALS.hard)  * 1.2));
  if(rating === 'good')  return Math.round(Math.max(SRS_INTERVALS.good, (prevInterval || SRS_INTERVALS.good)  * 2.5));
  if(rating === 'easy')  return Math.round(Math.max(SRS_INTERVALS.easy, (prevInterval || SRS_INTERVALS.easy)  * 4.0));
  return SRS_INTERVALS.good;
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
  try{ vpProgress = JSON.parse(localStorage.getItem('vp_'+deck)||'{}'); }catch(e){ vpProgress={}; }
}
function saveVpProgress(deck){
  localStorage.setItem('vp_'+deck, JSON.stringify(vpProgress));
}
async function syncVpFromSupabase(deck){
  if(!currentUser) return;
  try{
    const rows = await SB.selectVocabProgress(currentUser.id, deck);
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

  // 动态更新评分按钮的时间标签
  const _prevIv = fcMode==='deck'
    ? (vpProgress[v.word]?.interval || 0)
    : (fcSRS[v.word]?.interval || 0);
  document.querySelector('#fc-again .fc-rbtn-time').textContent = fmtInterval(SRS_INTERVALS.again);
  document.querySelector('#fc-hard .fc-rbtn-time').textContent  = fmtInterval(calcNextInterval('hard', _prevIv));
  document.querySelector('#fc-good .fc-rbtn-time').textContent  = fmtInterval(calcNextInterval('good', _prevIv));
  document.querySelector('#fc-easy .fc-rbtn-time').textContent  = fmtInterval(calcNextInterval('easy', _prevIv));

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
  if(fcFlipped){
    // 翻到背面：280ms 后显示评级按钮
    setTimeout(()=> ratings.classList.add('show'), 280);
  } else {
    // 翻回正面：立刻隐藏评级按钮
    ratings.classList.remove('show');
  }
}

function rateFcCard(rating){
  if(!fcFlipped) return;
  markStudiedToday();
  const v   = fcDeck[fcIdx];
  const now = Date.now();

  // 动态间隔（基于上次间隔成倍增长）
  const prevInterval = fcMode==='deck'
    ? (vpProgress[v.word]?.interval || 0)
    : (fcSRS[v.word]?.interval || 0);
  const interval = calcNextInterval(rating, prevInterval);

  if(fcMode === 'deck'){
    const prev = vpProgress[v.word] || { correct:0, wrong:0, interval:0 };
    vpProgress[v.word] = {
      nextReview: now + interval,
      interval,
      correct: prev.correct + (rating !== 'again' ? 1 : 0),
      wrong:   prev.wrong   + (rating === 'again' ? 1 : 0)
    };
    saveVpProgress(vpDeck);
    pushVpWord(vpDeck, v.word);
  } else {
    fcSRS[v.word] = { nextReview: now + interval, interval, lastRating: rating };
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
      <div class="fc-stat-l" style="color:#DC2626">Again</div>
    </div>
    <div class="fc-stat" style="background:#FEF3C7">
      <div class="fc-stat-n" style="color:#D97706">${fcCounts.hard}</div>
      <div class="fc-stat-l" style="color:#D97706">Hard</div>
    </div>
    <div class="fc-stat" style="background:#D1FAE5">
      <div class="fc-stat-n" style="color:#059669">${fcCounts.good}</div>
      <div class="fc-stat-l" style="color:#059669">Good</div>
    </div>
    <div class="fc-stat" style="background:#DBEAFE">
      <div class="fc-stat-n" style="color:#2563EB">${fcCounts.easy}</div>
      <div class="fc-stat-l" style="color:#2563EB">Easy</div>
    </div>`;
}

function closeFcAll(){
  document.getElementById('flashcard').classList.remove('open');
  document.getElementById('flashcard').style.display = 'none';
  document.getElementById('fc-result').classList.remove('open');
  document.getElementById('fc-result').style.display = 'none';
  if(fcMode === 'deck') openVocabPanel();
}

// ── Card swipe gesture
// 拖拽位移施加在 .fc-scene 上，card 本身只做 rotateY 翻转，互不干扰
(()=>{
  const card = document.getElementById('fc-card');
  let sx=0, sy=0, dx=0, moving=false;

  card.addEventListener('touchstart', e=>{
    sx=e.touches[0].clientX; sy=e.touches[0].clientY;
    dx=0; moving=false;
    card.closest('.fc-scene').style.transition='none';
  },{passive:true});

  card.addEventListener('touchmove', e=>{
    dx=e.touches[0].clientX-sx;
    const dy=e.touches[0].clientY-sy;
    if(Math.abs(dx)<Math.abs(dy) && !moving) return;
    if(Math.abs(dx)<10 && !moving) return;
    moving=true;
    card.closest('.fc-scene').style.transform=`translateX(${dx}px) rotate(${dx*0.03}deg)`;
  },{passive:true});

  card.addEventListener('touchend', (e)=>{
    const scn = card.closest('.fc-scene');
    if(!moving){
      scn.style.transition='';
      if(e.target.closest('button')) return;
      flipFcCard(); return;
    }
    if(Math.abs(dx)>100 && fcFlipped){
      // 滑出屏幕：scene 飞走
      const dir = dx>0?1:-1;
      scn.style.transition='transform .25s ease, opacity .25s ease';
      scn.style.transform =`translateX(${dir*110}%)`;
      scn.style.opacity   ='0';
      const rating = dx>0?'good':'again';
      setTimeout(()=>{
        scn.style.transition='none';
        scn.style.transform='';
        scn.style.opacity='1';
        rateFcCard(rating);
      }, 270);
    } else {
      // 回弹：scene 归位即可，card 的 rotateY 由 CSS class 全程控制，无需修改
      scn.style.transition='transform .35s cubic-bezier(.34,1.4,.64,1)';
      scn.style.transform='';
      setTimeout(()=>{ scn.style.transition=''; }, 380);
    }
  },{passive:true});

  // 桌面端点击翻转（排除按钮）
  card.addEventListener('click', (e)=>{
    if(e.target.closest('button')) return;
    if(window.matchMedia('(pointer:fine)').matches) flipFcCard();
  });
})();

// 翻转胶囊按钮
document.getElementById('fc-flip-cta').addEventListener('click', (e)=>{
  e.stopPropagation();
  flipFcCard();
});

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
