// ═══════════════════════════════════════════
//  SUPABASE — 轻量客户端（无 SDK，纯 fetch）
// ═══════════════════════════════════════════
const SB = (() => {
  const BASE = 'https://ueskojxtupmxwolzxdxa.supabase.co';
  const KEY  = 'sb_publishable_-hbkl0aTVPGCfSL8rk6WPQ_mzGQ52O-';
  let tok = null;

  function h(extra = {}) {
    return {
      'apikey': KEY,
      'Content-Type': 'application/json',
      ...(tok ? { 'Authorization': 'Bearer ' + tok } : {}),
      ...extra
    };
  }

  async function req(path, opts = {}) {
    const extra = opts.headers || {};
    delete opts.headers;
    const r = await fetch(BASE + path, { ...opts, headers: h(extra) });
    const text = await r.text();
    const d = text ? JSON.parse(text) : {};
    if (!r.ok) throw new Error(d.error_description || d.message || d.msg || '请求失败 ' + r.status);
    return d;
  }

  return {
    get accessToken(){ return tok; },

    async signIn(email, password) {
      const d = await req('/auth/v1/token?grant_type=password', {
        method: 'POST', body: JSON.stringify({ email, password })
      });
      tok = d.access_token;
      localStorage.setItem('sb_tok', tok);
      localStorage.setItem('sb_ref', d.refresh_token || '');
      return d.user;
    },

    async signUp(email, password) {
      const d = await req('/auth/v1/signup', {
        method: 'POST', body: JSON.stringify({ email, password })
      });
      if (d.access_token) {
        tok = d.access_token;
        localStorage.setItem('sb_tok', tok);
        localStorage.setItem('sb_ref', d.refresh_token || '');
      }
      return d.user || d;
    },

    async signOut() {
      try { await req('/auth/v1/logout', { method: 'POST' }); } catch(e) {}
      tok = null;
      localStorage.removeItem('sb_tok');
      localStorage.removeItem('sb_ref');
    },

    async restoreSession() {
      const saved = localStorage.getItem('sb_tok');
      if (!saved) return null;
      try {
        tok = saved;
        return await req('/auth/v1/user');
      } catch(e) {
        // 尝试 refresh token
        const ref = localStorage.getItem('sb_ref');
        if (!ref) { tok = null; localStorage.removeItem('sb_tok'); return null; }
        try {
          const d = await req('/auth/v1/token?grant_type=refresh_token', {
            method: 'POST', body: JSON.stringify({ refresh_token: ref })
          });
          tok = d.access_token;
          localStorage.setItem('sb_tok', tok);
          localStorage.setItem('sb_ref', d.refresh_token || '');
          return d.user;
        } catch(e2) {
          tok = null;
          localStorage.removeItem('sb_tok'); localStorage.removeItem('sb_ref');
          return null;
        }
      }
    },

    async selectVocab(userId) {
      return req(`/rest/v1/vocab?user_id=eq.${userId}&order=time.asc&select=word,meaning,sent,time`);
    },

    async upsertVocab(rows) {
      return req('/rest/v1/vocab', {
        method: 'POST',
        headers: { 'Prefer': 'resolution=merge-duplicates,return=minimal' },
        body: JSON.stringify(rows)
      });
    },

    async deleteVocab(userId, word) {
      return req(`/rest/v1/vocab?user_id=eq.${userId}&word=eq.${encodeURIComponent(word)}`, {
        method: 'DELETE'
      });
    },

    async rpc(fn) {
      return req(`/rest/v1/rpc/${fn}`, { method: 'POST', body: '{}' });
    },

    async selectUserBooks(userId) {
      return req(`/rest/v1/user_books?user_id=eq.${userId}&order=added_at.asc&select=id,title,author,year,url,mark,isbn,pal,cat`);
    },

    async insertUserBook(row) {
      return req('/rest/v1/user_books', {
        method: 'POST',
        headers: { 'Prefer': 'return=representation' },
        body: JSON.stringify(row)
      });
    },

    async deleteUserBook(id) {
      return req(`/rest/v1/user_books?id=eq.${id}`, { method: 'DELETE' });
    },

    async selectVocabProgress(userId, deck) {
      return req(`/rest/v1/vocab_progress?user_id=eq.${userId}&deck=eq.${deck}&select=word,next_review,correct_count,wrong_count,interval_ms`);
    },

    async upsertVocabProgress(userId, deck, word, data) {
      return req('/rest/v1/vocab_progress', {
        method: 'POST',
        headers: { 'Prefer': 'resolution=merge-duplicates,return=minimal' },
        body: JSON.stringify([{
          user_id: userId,
          deck,
          word,
          status: (data.correct||0) >= 3 ? 'known' : 'learning',
          next_review: new Date(data.nextReview).toISOString(),
          correct_count: data.correct||0,
          wrong_count: data.wrong||0,
          interval_ms: data.interval||0,
          last_seen: new Date().toISOString()
        }])
      });
    }
  };
})();

let currentUser = null;
