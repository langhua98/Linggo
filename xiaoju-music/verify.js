// 审核机器人（@xiaojuverify_bot）：小橘搜到的抖音作品，转进视频频道前必须先在这里由频道主本人审核。
//
// 两个机器人各用各的 token、各收各的 webhook（Telegram 里机器人之间互相看不到消息），
// 数据交接走共享后端：同一个 Durable Object 里的审核任务表（config 键 rv:<任务号>、rvRows:<任务号>:<段>、rvIds）。
//
//   小橘 ──submitReview()──▶ 写任务（pending，完整清单）──▶ 审核机器人把清单私聊发给频道主
//   频道主在审核机器人里点「通过 / 不通过」──▶ 写回任务状态（approved / rejected）──▶ 通知小橘 onDecision(任务号)
//   小橘只认任务表里的状态：approved 才转；rejected / expired / paused 一条不转
//
// 任何一步出错都不默认通过：送不到审核机器人 → paused（暂停，等重新送审）；24 小时没审 → expired（超时，不转）。
//
// 令牌：频道主在小橘里发「审核机器人 <BotFather 给的令牌>」接上（存在 Durable Object 里，不进代码库；
// 部署时也可以用 secret VERIFY_BOT_TOKEN 覆盖）。接上时给审核机器人设 webhook：POST /verify-webhook，带独立的 secret。

const TG = 'https://api.telegram.org';
export const REVIEW_TTL_MS = 24 * 3600 * 1000;
const KEEP_TASKS = 30;
const ROWS_PER_KEY = 100;
const MSG_LIMIT = 3800;
const STATUS_TEXT = {
  pending: '⏳ 等你审核', approved: '✅ 审核通过', rejected: '❌ 审核没通过', expired: '⌛ 超时没审，不转', paused: '⏸ 暂停（没送到审核机器人）',
};

async function verifyToken(env, L) {
  return env.VERIFY_BOT_TOKEN || (await L.getConfig('verifyTok')) || '';
}

async function vtg(token, method, payload) {
  try {
    const res = await fetch(`${TG}/bot${token}/${method}`, {
      method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(payload),
    });
    return await res.json().catch(() => ({ ok: false, description: `HTTP ${res.status}` }));
  } catch (e) {
    return { ok: false, description: '连不上 Telegram' };
  }
}

function newId() {
  return Date.now().toString(36) + [...crypto.getRandomValues(new Uint8Array(3))].map(x => x.toString(16).padStart(2, '0')).join('');
}

// ── 任务表 ──
export async function getTask(L, id) {
  if (!/^[\w]{6,24}$/.test(String(id || ''))) return null;
  try {
    const t = JSON.parse((await L.getConfig('rv:' + id)) || 'null');
    return t && t.id === id ? t : null;
  } catch {
    return null;
  }
}

export async function saveTask(L, t) {
  await L.setConfig('rv:' + t.id, JSON.stringify(t));
}

// 审核时那一刻的作品数据（转发就用它，和审核看到的是同一批，不会被后来的搜索冲掉）
export async function taskRows(L, t) {
  const out = [];
  for (let k = 0; k < (t.rowKeys || 0); k++) {
    try { out.push(...JSON.parse((await L.getConfig(`rvRows:${t.id}:${k}`)) || '[]')); } catch {}
  }
  return out;
}

async function taskIds(L) {
  try {
    const a = JSON.parse((await L.getConfig('rvIds')) || '[]');
    return Array.isArray(a) ? a.filter(x => typeof x === 'string') : [];
  } catch {
    return [];
  }
}

// 小橘提交一批：items 是给人看的清单（作品号、链接、来源账号……），rows 是转发要用的完整作品数据（顺序同 items）
export async function createTask(L, { keywords, items, rows }) {
  const t = {
    id: newId(), keywords, createdAt: Date.now(), expiresAt: Date.now() + REVIEW_TTL_MS,
    status: 'pending', reason: '', items, rowKeys: 0, msgs: [], decidedAt: 0, transfer: '',
  };
  for (let i = 0; i < rows.length; i += ROWS_PER_KEY) {
    await L.setConfig(`rvRows:${t.id}:${t.rowKeys++}`, JSON.stringify(rows.slice(i, i + ROWS_PER_KEY)));
  }
  await saveTask(L, t);
  // 只留最近 30 个任务，旧的连同作品数据清掉
  const ids = [...(await taskIds(L)), t.id];
  for (const old of ids.slice(0, -KEEP_TASKS)) {
    const o = await getTask(L, old);
    for (let k = 0; k < ((o && o.rowKeys) || 0); k++) await L.setConfig(`rvRows:${old}:${k}`, '');
    await L.setConfig('rv:' + old, '');
  }
  await L.setConfig('rvIds', JSON.stringify(ids.slice(-KEEP_TASKS)));
  return t;
}

// ── 清单排版（审核机器人发给频道主的）──
function accountsOf(t) {
  const by = new Map();
  for (const x of t.items) {
    const k = x.sec || 'name:' + (x.account || '');  // 没拿到账号 id 的按昵称分开列，不混成一个号
    if (!by.has(k)) by.set(k, { sec: k, name: x.account, mine: x.mine, n: 0 });
    by.get(k).n++;
  }
  return [...by.values()].sort((a, b) => (b.mine - a.mine) || (b.n - a.n));
}

export function reviewMessages(t) {
  const accts = accountsOf(t);
  const head = [
    `🛂 审核单 ${t.id}`,
    `来源：小橘音乐机器人 · 抖音搜索「${t.keywords.join('、')}」`,
    `一共 ${t.items.length} 条，来自 ${accts.length} 个账号（👤 是你登记过的号，只作参考）：`,
    ...accts.map((a, i) => `${i + 1}. ${a.mine ? '👤' : ''}@${a.name || '（没名字）'}（${a.n} 条）${a.sec ? `\n   sec_uid: ${a.sec}` : '\n   （没拿到账号 id）'}`),
    '',
    '完整清单在下面，看完点最后一条的按钮。',
  ].join('\n');
  const lines = t.items.map((x, i) => [
    `${i + 1}. ${x.note ? '🖼' : '📹'} ${x.title}`,
    `   账号：${x.mine ? '👤' : ''}@${x.account || '（没名字）'}`,
    `   作品 ID：${x.id}`,
    `   链接：${x.link}`,
    ...(x.files && x.files.length ? [`   文件：${x.files[0]}${x.files.length > 1 ? `（另有 ${x.files.length - 1} 个）` : ''}`] : []),
  ].join('\n'));
  const out = [head];
  let chunk = '';
  for (const l of lines) {
    if (chunk && (chunk + '\n\n' + l).length > MSG_LIMIT) { out.push(chunk); chunk = l; }
    else chunk = chunk ? chunk + '\n\n' + l : l;
  }
  if (chunk) out.push(chunk);
  return out;
}

function decisionText(t) {
  const base = `🛂 审核单 ${t.id}（「${t.keywords.join('、')}」${t.items.length} 条）`;
  if (t.status === 'pending') {
    return `${base}\n\n上面这些都是你自己的账号、你有权转进「小橘视频」吗？\n· 全部是 → 点「✅ 通过」，小橘才会转这一批（不登记账号）\n· 只要有一条不是 → 点「❌ 不通过」，一条也不转，尊重原作者\n\n${Math.round(REVIEW_TTL_MS / 3600000)} 小时内不审就算超时，不转。`;
  }
  return `${base}\n\n${STATUS_TEXT[t.status] || t.status}${t.reason ? `：${t.reason}` : ''}`;
}

function decisionKeyboard(t) {
  return t.status === 'pending'
    ? { inline_keyboard: [[{ text: `✅ 通过，都是我的号（${t.items.length} 条）`, callback_data: `v:ok:${t.id}` }], [{ text: '❌ 不通过', callback_data: `v:no:${t.id}` }]] }
    : { inline_keyboard: [] };
}

// 把任务的完整清单发给频道主（审核机器人的私聊）。成功 → pending；任何一条没发出去 → paused（不默认通过）
export async function deliverTask(env, L, owner, t) {
  const token = await verifyToken(env, L);
  const fail = async why => {
    t.status = 'paused';
    t.reason = why;
    await saveTask(L, t);
    return { ok: false, why };
  };
  if (!token) return fail('还没接上审核机器人（在小橘里发「审核机器人 令牌」）');
  if (!owner) return fail('不知道频道主是谁');
  t.status = 'pending';
  t.reason = '';
  t.expiresAt = Date.now() + REVIEW_TTL_MS;
  t.msgs = [];
  for (const text of reviewMessages(t)) {
    const r = await vtg(token, 'sendMessage', { chat_id: owner, text, disable_web_page_preview: true });
    if (!r.ok) {
      return fail(/initiate|blocked|chat not found/i.test(r.description || '')
        ? `审核机器人还不能给你发消息，先去审核机器人那里点一下「开始」（${r.description}）`
        : `审核机器人发消息失败（${r.description || '未知原因'}）`);
    }
  }
  const r = await vtg(token, 'sendMessage', { chat_id: owner, text: decisionText(t), reply_markup: decisionKeyboard(t) });
  if (!r.ok) return fail(`审核机器人发审核按钮失败（${r.description || '未知原因'}）`);
  t.msgs = [r.result.message_id];
  await saveTask(L, t);
  return { ok: true };
}

// 超时的 pending 任务：改成 expired，按钮收掉，通知小橘（cron 每 30 分钟跑一次）
export async function expireTasks(env, L, owner, onDecision) {
  const token = await verifyToken(env, L);
  for (const id of await taskIds(L)) {
    const t = await getTask(L, id);
    if (!t || t.status !== 'pending' || Date.now() < t.expiresAt) continue;
    t.status = 'expired';
    t.decidedAt = Date.now();
    await saveTask(L, t);
    if (token && owner && t.msgs[0]) await vtg(token, 'editMessageText', { chat_id: owner, message_id: t.msgs[0], text: decisionText(t), reply_markup: decisionKeyboard(t) });
    await onDecision(t.id);
  }
}

// 在小橘里接上审核机器人：认令牌（getMe）、设 webhook、记下来
export async function connectVerifyBot(env, L, token, origin) {
  const me = await vtg(token, 'getMe', {});
  if (!me.ok || !me.result || !me.result.is_bot) return { ok: false, why: '这个令牌不对（Telegram 不认）' };
  const secret = [...crypto.getRandomValues(new Uint8Array(24))].map(x => x.toString(16).padStart(2, '0')).join('');
  const hook = await vtg(token, 'setWebhook', {
    url: `${origin}/verify-webhook`, secret_token: secret, allowed_updates: ['message', 'callback_query'], drop_pending_updates: true,
  });
  if (!hook.ok) return { ok: false, why: `设 webhook 没成（${hook.description || '未知原因'}）` };
  await L.setConfig('verifyTok', token);
  await L.setConfig('verifySecret', secret);
  await L.setConfig('verifyName', me.result.username || '');
  return { ok: true, name: me.result.username || '' };
}

export async function verifyName(L) {
  return (await L.getConfig('verifyName')) || 'xiaojuverify_bot';
}

export async function pendingTasks(L) {
  const out = [];
  for (const id of await taskIds(L)) {
    const t = await getTask(L, id);
    if (t && (t.status === 'pending' || t.status === 'paused')) out.push(t);
  }
  return out;
}

// ── 审核机器人的 webhook ──
// deps: { L, owner, onDecision(任务号) }
export async function verifyWebhook(request, env, deps) {
  const { L } = deps;
  const secret = await L.getConfig('verifySecret');
  const got = request.headers.get('X-Telegram-Bot-Api-Secret-Token') || '';
  if (!secret || got.length !== secret.length || got !== secret) return new Response('Forbidden', { status: 403 });
  const update = await request.json().catch(() => null);
  const token = await verifyToken(env, L);
  if (!update || !token) return new Response('ok');
  const owner = await deps.owner();
  if (update.callback_query) await onButton(env, deps, token, owner, update.callback_query);
  else if (update.message && update.message.chat && update.message.chat.type === 'private') await onMessage(env, deps, token, owner, update.message);
  return new Response('ok');
}

async function onMessage(env, deps, token, owner, m) {
  const chat = m.chat.id;
  if (!owner || !m.from || m.from.id !== owner) {
    return vtg(token, 'sendMessage', { chat_id: chat, text: '这是小橘视频频道主的私人审核机器人。' });
  }
  const list = await pendingTasks(deps.L);
  // 频道主第一次点「开始」（或随便发一句）：之前因为发不过来而暂停的审核单，现在补发
  const resent = [];
  for (const t of list.filter(x => x.status === 'paused')) {
    if ((await deliverTask(env, deps.L, owner, t)).ok) resent.push(t.id);
  }
  const waiting = (await pendingTasks(deps.L)).filter(t => t.status === 'pending');
  return vtg(token, 'sendMessage', {
    chat_id: chat,
    text: [
      '🛂 我是审核机器人：小橘搜到的抖音作品，先送到我这里，你确认都是你自己的号、你有权转，小橘才会转进「小橘视频」。',
      '不通过、超时（24 小时）、出错，都一条不转。',
      resent.length ? `\n补发了 ${resent.length} 张之前没送到的审核单：${resent.join('、')}` : '',
      waiting.length ? `\n现在等你审核的：${waiting.map(t => `${t.id}（「${t.keywords.join('、')}」${t.items.length} 条）`).join('、')}` : '\n现在没有等审核的。',
    ].filter(Boolean).join('\n'),
  });
}

async function onButton(env, deps, token, owner, cb) {
  const ack = text => vtg(token, 'answerCallbackQuery', { callback_query_id: cb.id, text: text || '' });
  if (!owner || !cb.from || cb.from.id !== owner) return ack('只有频道主能审核');
  const [kind, verdict, id] = String(cb.data || '').split(':');
  if (kind !== 'v') return ack();
  const t = await getTask(deps.L, id);
  if (!t) return ack('找不到这张审核单了');
  if (t.status !== 'pending') return ack(STATUS_TEXT[t.status] || '已经处理过了');
  if (Date.now() >= t.expiresAt) {
    t.status = 'expired';
  } else if (verdict === 'ok' || verdict === 'no') {
    t.status = verdict === 'ok' ? 'approved' : 'rejected';
  } else {
    return ack();
  }
  t.decidedAt = Date.now();
  t.decidedBy = cb.from.id;
  await saveTask(deps.L, t);
  await ack(t.status === 'approved' ? '通过了，交给小橘转' : t.status === 'rejected' ? '好，这批不转' : '超时了，这批不转');
  await vtg(token, 'editMessageText', { chat_id: cb.message.chat.id, message_id: cb.message.message_id, text: decisionText(t), reply_markup: decisionKeyboard(t) });
  // 审核结果已经写进共享的任务表；通知小橘去读（小橘只认表里的状态）
  await deps.onDecision(t.id);
}
