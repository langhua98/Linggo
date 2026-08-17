// ═══════════════════════════════════════════
//  USER DECKS — 导入自备词表（本地-only）
// ═══════════════════════════════════════════
// 依赖（script.js 先加载）：openIDB/idbGet/idbSave/idbDelete、toast
// 依赖（index.html 结构先加载）：.vp-decks 容器（cet4/cet6/ogden 静态行之后插入用户词书行）
// 依赖顺序：本文件须在 ogden850.js 之后、srs.js 之前加载 ——
//   srs.js 的 getDeckWordList/updateVpStats 需要读本文件暴露的 userDecks / USER_DECK_CACHE / loadUserDeck。
//
// 存储分层（设计要点）：
//   词表正文（可能 7000+ 词、近 1MB JSON）→ IndexedDB，key = 'userdeck:'+id，
//     避免塞进 localStorage 挤爆 5MB 配额。
//   词书清单（id/name/count 等，很小）→ localStorage['userDecks']，
//     渲染 .vp-decks 列表时要同步读，放 IDB 需要 await 会让首屏渲染变复杂，不值得。
//   FSRS 复习进度沿用 srs.js 现成的 vp_<deck> key（deck='user:'+id），本文件不碰。

let userDecks = [];              // 清单：[{id, name, count, addedAt}]
const USER_DECK_CACHE = {};      // id → words[]，getDeckWordList 是同步函数，靠这层缓存兜住 IDB 的异步读

function loadUserDeckList(){
  try{ userDecks = JSON.parse(localStorage.getItem('userDecks')||'[]'); }
  catch(e){ userDecks = []; }
}
function saveUserDeckList(){
  localStorage.setItem('userDecks', JSON.stringify(userDecks));
}

async function loadUserDeck(id){
  if(USER_DECK_CACHE[id]) return USER_DECK_CACHE[id];
  try{
    const raw = await idbGet('userdeck:'+id);
    const words = raw ? JSON.parse(raw) : [];
    USER_DECK_CACHE[id] = words;
    return words;
  }catch(e){
    console.warn('loadUserDeck failed:', e);
    return [];
  }
}

// 宽容解析：JSON 数组 或 CSV/TSV。返回 {words, error}
function parseDeckFile(text, filename){
  const trimmed = (text||'').trim();
  if(!trimmed) return { words:[], error:'文件是空的' };

  // ── 先试 JSON ──
  if(trimmed[0] === '['){
    let arr;
    try{ arr = JSON.parse(trimmed); }
    catch(e){ return { words:[], error:'JSON 格式有误：' + e.message }; }
    if(!Array.isArray(arr)) return { words:[], error:'JSON 顶层必须是数组' };
    const words = [];
    for(const item of arr){
      if(!item || typeof item !== 'object') continue;
      const w  = String(item.w ?? item.word ?? '').trim();
      const ph = String(item.ph ?? item.phonetic ?? '').trim();
      const cn = String(item.cn ?? item.meaning ?? item.def ?? '').trim();
      if(!w || !cn) continue;
      const entry = { w, ph, cn };
      if(item.root) entry.root = item.root;   // 词族分组预留字段，原样保留
      words.push(entry);
    }
    if(!words.length) return { words:[], error:'JSON 里没有一条有效词条（需要 w/word 和 cn/meaning/def 字段）' };
    return { words, error:null };
  }

  // ── 否则按 CSV/TSV 处理 ──
  const lines = trimmed.split(/\r\n|\r|\n/).filter(l => l.trim() !== '');
  if(!lines.length) return { words:[], error:'文件是空的' };
  const firstLine = lines[0];
  const tabCount = (firstLine.match(/\t/g)||[]).length;
  const commaCount = (firstLine.match(/,/g)||[]).length;
  const sep = tabCount > commaCount ? '\t' : ',';

  let startIdx = 0;
  if(/单词|word/i.test(firstLine)) startIdx = 1;   // 首行是表头就跳过

  const words = [];
  for(let i = startIdx; i < lines.length; i++){
    const cols = lines[i].split(sep).map(c => c.trim().replace(/^"(.*)"$/, '$1'));
    if(!cols.length) continue;
    let w, ph, cn;
    if(cols.length >= 3){ w = cols[0]; ph = cols[1]; cn = cols[2]; }
    else if(cols.length === 2){ w = cols[0]; ph = ''; cn = cols[1]; }
    else continue;
    w = (w||'').trim(); ph = (ph||'').trim(); cn = (cn||'').trim();
    if(!w || !cn) continue;
    words.push({ w, ph, cn });
  }
  if(!words.length) return { words:[], error:'一条有效词条都没解析出来（每行至少需要「单词,释义」两列）' };
  return { words, error:null };
}

async function importDeckFile(file){
  let text;
  try{ text = await file.text(); }
  catch(e){ toast('读取文件失败'); return; }

  const { words, error } = parseDeckFile(text, file.name);
  if(error){ toast('导入失败：' + error); return; }

  const preview = words.slice(0, 3).map(w => `${w.w} - ${w.cn}`).join('\n');
  const ok = confirm(`共解析出 ${words.length} 个词条，导入前 3 条预览：\n${preview}\n\n确认导入？`);
  if(!ok) return;

  // 词书名取文件名去扩展名；重名追加 (2)/(3)...，不覆盖已有
  let name = file.name.replace(/\.[^.]+$/, '') || '我的词表';
  const existingNames = new Set(userDecks.map(d => d.name));
  if(existingNames.has(name)){
    let n = 2;
    while(existingNames.has(`${name} (${n})`)) n++;
    name = `${name} (${n})`;
  }

  const id = Date.now().toString(36);
  try{
    await idbSave('userdeck:'+id, JSON.stringify(words));
  }catch(e){
    toast('保存失败，请重试');
    return;
  }
  USER_DECK_CACHE[id] = words;
  userDecks.push({ id, name, count: words.length, addedAt: Date.now() });
  saveUserDeckList();
  renderUserDecks();
  if(typeof updateVpStats === 'function') updateVpStats();
  toast(`已导入 ${words.length} 词`);
}

async function deleteUserDeck(id){
  const deck = userDecks.find(d => d.id === id);
  if(!deck) return;
  if(!confirm(`删除词书《${deck.name}》？复习进度也会一并清除，无法恢复。`)) return;

  try{ await idbDelete('userdeck:'+id); }catch(e){}
  localStorage.removeItem('vp_user:'+id);
  delete USER_DECK_CACHE[id];
  userDecks = userDecks.filter(d => d.id !== id);
  saveUserDeckList();

  // 删的正是当前选中的词书：退回默认词库，同步高亮和统计
  const deckKey = 'user:'+id;
  if(typeof vpDeck !== 'undefined' && vpDeck === deckKey){
    vpDeck = 'cet4';
    document.querySelectorAll('.vp-deck').forEach(d => d.classList.toggle('on', d.dataset.deck === 'cet4'));
    if(typeof loadVpProgress === 'function') loadVpProgress(vpDeck);
  }
  renderUserDecks();
  if(typeof updateVpStats === 'function') updateVpStats();
}

// 词书 id → 显示名。srs.js 的闪卡标题要用（否则会把原始 id 大写后显示出来）
function userDeckName(id){
  const d = userDecks.find(x => x.id === id);
  return d ? d.name : '我的词书';
}

function renderUserDecks(){
  const container = document.querySelector('.vp-decks');
  if(!container) return;

  // 清掉旧的用户词书行，重新插
  container.querySelectorAll('.vp-deck-user').forEach(el => el.remove());

  userDecks.forEach(deck => {
    const deckKey = 'user:' + deck.id;
    const row = document.createElement('div');
    row.className = 'vp-deck vp-deck-user';
    row.dataset.deck = deckKey;

    const badge = document.createElement('div');
    badge.className = 'vp-dk-badge';
    const img = document.createElement('img');
    img.src = 'vendor/emoji/deck-mine.svg'; img.alt = ''; img.width = 52; img.height = 52;
    badge.appendChild(img);

    const info = document.createElement('div');
    info.className = 'vp-dk-info';
    const nameEl = document.createElement('div');
    nameEl.className = 'vp-dk-name';
    nameEl.textContent = deck.name;   // 用户输入内容，textContent 防 XSS
    const subEl = document.createElement('div');
    subEl.className = 'vp-dk-sub';
    subEl.id = deckKey + '-progress';
    // 未载入进缓存时用清单里记的 count 兜底，避免显示「0 词」；载入后 updateVpStats 会覆盖
    subEl.textContent = `共 ${deck.count} 词`;
    const barWrap = document.createElement('div');
    barWrap.className = 'vp-dk-bar';
    const barFill = document.createElement('div');
    barFill.className = 'vp-dk-bar-fill';
    barFill.id = deckKey + '-bar';
    barWrap.appendChild(barFill);
    info.appendChild(nameEl); info.appendChild(subEl); info.appendChild(barWrap);

    const delBtn = document.createElement('button');
    delBtn.className = 'vp-dk-del';
    delBtn.title = '删除';
    delBtn.textContent = '×';

    const check = document.createElement('div');
    check.className = 'vp-dk-check';
    check.textContent = '✓';

    row.appendChild(badge); row.appendChild(info); row.appendChild(delBtn); row.appendChild(check);
    // 直接追加到 .vp-decks 末尾即可：.vp-session 是这个容器的兄弟节点而非子节点，
    // 所以追加进来天然就排在静态词书行之后、「本次背」那一块之前
    container.appendChild(row);
  });

  // 若当前选中的词书是刚被删掉的（renderUserDecks 也可能在删除后调用），
  // 高亮状态已在 deleteUserDeck 里处理，这里不需要重复处理选中态。
  if(typeof vpDeck !== 'undefined'){
    container.querySelectorAll('.vp-deck').forEach(d => d.classList.toggle('on', d.dataset.deck === vpDeck));
  }
}

// ── 导入按钮 + 隐藏 file input ──
// 按钮插在 .vp-decks 之后（会被 renderUserDecks 排在用户词书行之后，因为它本身
// 在 .vp-decks 容器外，位于 .vp-decks 和 .vp-session 之间）
(function initImportUI(){
  const decksEl = document.querySelector('.vp-decks');
  if(!decksEl) return;

  const btn = document.createElement('button');
  btn.id = 'vp-import-btn';
  btn.type = 'button';
  btn.textContent = '＋ 导入我的词表';

  const input = document.createElement('input');
  input.type = 'file';
  input.id = 'vp-import-input';
  input.accept = '.json,.csv,.txt,.tsv';
  input.style.display = 'none';

  decksEl.insertAdjacentElement('afterend', input);
  decksEl.insertAdjacentElement('afterend', btn);

  btn.addEventListener('click', () => input.click());
  input.addEventListener('change', async () => {
    const file = input.files && input.files[0];
    input.value = '';   // 允许连续两次选同一个文件
    if(file) await importDeckFile(file);
  });
})();

// 删除按钮：事件委托绑在 .vp-decks 上（用户词书行是动态插入的）。
// srs.js 的选中态委托监听里已经用 closest('.vp-dk-del') 短路跳过了选中逻辑，
// 这里再 stopPropagation 兜底，防止两个监听器的执行顺序万一调换导致误选中。
document.querySelector('.vp-decks')?.addEventListener('click', e=>{
  const delBtn = e.target.closest('.vp-dk-del');
  if(!delBtn) return;
  e.stopPropagation();
  const row = delBtn.closest('.vp-deck');
  const id = row && row.dataset.deck && row.dataset.deck.startsWith('user:') ? row.dataset.deck.slice(5) : null;
  if(id) deleteUserDeck(id);
});

// 把所有用户词书的词表读进内存缓存，然后刷新一次统计。
// 不预载的话，词书页刚打开时 getDeckWordList 返回空数组，统计会显示「已掌握 0/0」。
// IDB 读一本 7000+ 词的词表实测约 8ms，全部预载的开销可以忽略。
async function preloadUserDecks(){
  if(!userDecks.length) return;
  for(const d of userDecks){
    try{ await loadUserDeck(d.id); }catch(e){ console.warn('预载词书失败', d.id, e); }
  }
  if(typeof updateVpStats === 'function') updateVpStats();
}

loadUserDeckList();
renderUserDecks();
// script.js（idbGet）和 srs.js（updateVpStats）都是本文件之后的独立 <script>，
// 微任务会在它们执行前就跑，所以必须等 DOMContentLoaded —— 那时全部脚本已就位
if(document.readyState === 'loading'){
  document.addEventListener('DOMContentLoaded', preloadUserDecks);
}else{
  preloadUserDecks();
}
