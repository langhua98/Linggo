// ═══════════════════════════════════════════
//  NEURAL WORD ALIGNMENT WORKER  神经词对齐
//  SimAlign-style alignment: contextual token embeddings from a multilingual
//  MiniLM (paraphrase-multilingual-MiniLM-L12-v2, ~112 MB q8) → cosine
//  similarity matrix → mutual-argmax matching → English word ↔ Chinese char.
//  Runs entirely in-browser via WASM (transformers.js, ONNX Runtime Web),
//  off the main thread so inference never freezes the page.
// ═══════════════════════════════════════════
import { pipeline, env } from 'https://cdn.jsdelivr.net/npm/@huggingface/transformers@3.7.6';

env.allowLocalModels = false;        // fetch model from the HuggingFace hub
env.backends.onnx.wasm.numThreads = 1;

const SP = '▁';                 // SentencePiece word-boundary marker ▁

let extractor = null;

// ── subword tokens → [start,end) char spans in `original` (surface re-match) ──
function tokenCharSpans(tokens, original){
  const spans = [];
  const lower = original.toLowerCase();
  let p = 0;
  for(let tk of tokens){
    if(tk.startsWith(SP)) tk = tk.slice(1);
    if(tk === ''){ spans.push(null); continue; }       // lone ▁
    while(p < original.length && /\s/.test(original[p])) p++;
    const needle = tk.toLowerCase();
    let idx = lower.indexOf(needle, p);
    if(idx === -1) idx = lower.indexOf(needle);         // tolerate normalization drift
    if(idx === -1){ spans.push(null); continue; }
    spans.push([idx, idx + tk.length]);
    p = idx + tk.length;
  }
  return spans;
}

// English content words with char starts (mirrors injectWords / _enWords)
function enWords(sent){
  const out = []; let pos = 0;
  for(const part of sent.split(/(\s+)/)){
    if(/^\s+$/.test(part)){ pos += part.length; continue; }
    const m = part.match(/[a-zA-Z']+/);
    if(m){
      const w = m[0].toLowerCase().replace(/^'+|'+$/g, '');
      out.push({ w, cs: pos + part.indexOf(m[0]), len: m[0].length });
    }
    pos += part.length;
  }
  return out;
}

function l2norm(vec){
  let s = 0; for(const x of vec) s += x*x;
  s = Math.sqrt(s) || 1;
  const o = new Float64Array(vec.length);
  for(let i = 0; i < vec.length; i++) o[i] = vec[i]/s;
  return o;
}

const SKIP = new Set(['the','a','an','to','of']);
const isPunct = s => !/[一-鿿a-zA-Z0-9]/.test(s);   // 无中文/字母/数字 → 视为标点，不高亮

// emb: [T][D] token embeddings INCLUDING <s> … </s>; tokTexts excludes specials.
function alignFromEmbeddings(enSent, zhSent, enTok, enEmbAll, zhTok, zhEmbAll){
  const enEmb = enEmbAll.slice(1, 1 + enTok.length).map(l2norm);
  const zhEmb = zhEmbAll.slice(1, 1 + zhTok.length).map(l2norm);
  const Ne = enEmb.length, Nz = zhEmb.length;
  if(!Ne || !Nz) return [];

  const enSpans = tokenCharSpans(enTok, enSent);
  const zhSpans = tokenCharSpans(zhTok, zhSent);

  const sim = [];
  for(let i = 0; i < Ne; i++){
    const row = new Float64Array(Nz), a = enEmb[i];
    for(let j = 0; j < Nz; j++){
      let d = 0; const b = zhEmb[j];
      for(let k = 0; k < a.length; k++) d += a[k]*b[k];
      row[j] = d;
    }
    sim.push(row);
  }

  const fwd = new Int32Array(Ne), bwd = new Int32Array(Nz);
  for(let i = 0; i < Ne; i++){ let bj=0,bv=-2; for(let j=0;j<Nz;j++) if(sim[i][j]>bv){bv=sim[i][j];bj=j;} fwd[i]=bj; }
  for(let j = 0; j < Nz; j++){ let bi=0,bv=-2; for(let i=0;i<Ne;i++) if(sim[i][j]>bv){bv=sim[i][j];bi=i;} bwd[j]=bi; }

  const TH_MUTUAL = 0.25, TH_FWD = 0.45;
  const words = enWords(enSent);
  const wordCsForToken = ti => {
    const sp = enSpans[ti]; if(!sp) return null;
    const mid = (sp[0]+sp[1])/2;
    for(const w of words) if(mid >= w.cs && mid < w.cs + w.len) return SKIP.has(w.w) ? null : w.cs;
    return null;
  };

  const perWord = new Map();
  for(let i = 0; i < Ne; i++){
    const j = fwd[i], mutual = bwd[j] === i;
    if(!(mutual ? sim[i][j] >= TH_MUTUAL : sim[i][j] >= TH_FWD)) continue;
    const wc = wordCsForToken(i); if(wc == null) continue;
    const zs = zhSpans[j]; if(!zs) continue;
    if(isPunct(zhSent.slice(zs[0], zs[1]))) continue;
    if(!perWord.has(wc)) perWord.set(wc, []);
    perWord.get(wc).push([zs[0], zs[1]]);
  }

  const out = [];
  for(const [wc, ranges] of perWord){
    ranges.sort((a,b) => a[0]-b[0]);
    const merged = [];
    for(const r of ranges){
      const last = merged[merged.length-1];
      if(last && r[0] <= last[1] + 1) last[1] = Math.max(last[1], r[1]);
      else merged.push([r[0], r[1]]);
    }
    for(const [cs, ce] of merged) out.push({ en: wc, cs, ce });
  }
  out.sort((a,b) => a.en - b.en || a.cs - b.cs);
  return out;
}

async function embed(text){
  const toks = extractor.tokenizer.tokenize(text);
  const out  = await extractor(text, { pooling: 'none' });
  return { toks, emb: out.tolist()[0] };
}

let queue = Promise.resolve();        // serialize: concurrent session.run is unsafe

async function handle(msg){
  try{
    if(msg.type === 'load'){
      extractor = await pipeline('feature-extraction',
        'Xenova/paraphrase-multilingual-MiniLM-L12-v2', {
          dtype: 'q8',
          progress_callback: p => {
            if(p.status === 'progress' && p.file && p.file.endsWith('.onnx'))
              self.postMessage({ type: 'progress', progress: p.progress || 0 });
          }
        });
      self.postMessage({ type: 'ready' });
    } else if(msg.type === 'align'){
      const e = await embed(msg.en);
      const z = await embed(msg.zh);
      const align = alignFromEmbeddings(msg.en, msg.zh, e.toks, e.emb, z.toks, z.emb);
      self.postMessage({ type: 'result', id: msg.id, i: msg.i, align });
    }
  } catch(err){
    self.postMessage({ type: 'error', id: msg.id, message: String(err && err.message || err) });
  }
}

self.onmessage = e => { queue = queue.then(() => handle(e.data)); };
