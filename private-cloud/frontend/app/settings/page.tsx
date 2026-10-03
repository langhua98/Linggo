'use client';

import { useCallback, useEffect, useState } from 'react';
import AppShell, { useMe } from '@/components/AppShell';
import { useDialogs } from '@/components/Modal';
import { api } from '@/lib/api';
import { emit } from '@/lib/bus';
import { categoryLabel, formatDate, formatDateFull, formatSize } from '@/lib/format';
import type { Category } from '@/lib/types';

type Tab = 'account' | 'overview' | 'users' | 'tasks' | 'logs' | 'backup';

function Section({ title, children, desc }: { title: string; desc?: string; children: React.ReactNode }) {
  return (
    <section className="card p-5">
      <h2 className="font-semibold">{title}</h2>
      {desc && <p className="mt-1 text-sm text-slate-500">{desc}</p>}
      <div className="mt-4">{children}</div>
    </section>
  );
}

function Account() {
  const { toast } = useDialogs();
  const [oldPw, setOld] = useState('');
  const [newPw, setNew] = useState('');
  const [again, setAgain] = useState('');
  const submit = async (e: React.FormEvent) => {
    e.preventDefault();
    if (newPw !== again) return toast('两次输入的新密码不一致', 'error');
    try {
      await api('/api/auth/password', { method: 'POST', body: { old_password: oldPw, new_password: newPw } });
      toast('密码已修改，其他设备上的登录已失效');
      setOld(''); setNew(''); setAgain('');
    } catch (err: any) {
      toast(err.message, 'error');
    }
  };
  return (
    <Section title="修改密码" desc="修改后，其他设备上的登录会全部退出。">
      <form onSubmit={submit} className="max-w-sm space-y-3">
        <input className="input" type="password" placeholder="原密码" autoComplete="current-password" value={oldPw} onChange={(e) => setOld(e.target.value)} required />
        <input className="input" type="password" placeholder="新密码（至少 8 位）" autoComplete="new-password" minLength={8} value={newPw} onChange={(e) => setNew(e.target.value)} required />
        <input className="input" type="password" placeholder="再输一次新密码" autoComplete="new-password" minLength={8} value={again} onChange={(e) => setAgain(e.target.value)} required />
        <button className="btn-primary">保存</button>
      </form>
    </Section>
  );
}

function Stat({ label, value, sub }: { label: string; value: React.ReactNode; sub?: React.ReactNode }) {
  return (
    <div className="card p-4">
      <div className="text-xs text-slate-500">{label}</div>
      <div className="mt-1 text-2xl font-semibold tabular-nums">{value}</div>
      {sub && <div className="mt-0.5 text-xs text-slate-400">{sub}</div>}
    </div>
  );
}

function DailyChart({ daily }: { daily: { date: string; count: number; size: number }[] }) {
  // 最近 14 天每天新增文件数（单一系列：标题即图例，悬停看具体数字）
  const days: { date: string; count: number; size: number }[] = [];
  const map = new Map(daily.map((d) => [d.date, d]));
  for (let i = 13; i >= 0; i--) {
    const d = new Date();
    d.setDate(d.getDate() - i);
    const k = `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
    days.push(map.get(k) || { date: k, count: 0, size: 0 });
  }
  const max = Math.max(1, ...days.map((d) => d.count));
  const [hover, setHover] = useState<number | null>(null);
  return (
    <div>
      <div className="relative flex h-36 items-end gap-0.5 border-b border-slate-200 dark:border-slate-700">
        {days.map((d, i) => (
          <div key={d.date} className="flex h-full flex-1 cursor-default items-end justify-center"
            onMouseEnter={() => setHover(i)} onMouseLeave={() => setHover(null)}>
            <div className={`w-full max-w-6 rounded-t ${hover === i ? 'bg-sky-600' : 'bg-sky-500'}`}
              style={{ height: d.count ? `${Math.max(3, (d.count / max) * 100)}%` : 0 }} />
          </div>
        ))}
        {hover !== null && (
          <div className="pointer-events-none absolute -top-2 left-1/2 -translate-x-1/2 rounded-lg bg-slate-900 px-2.5 py-1 text-xs text-white shadow dark:bg-white dark:text-slate-900">
            {days[hover].date}：{days[hover].count} 个文件 · {formatSize(days[hover].size)}
          </div>
        )}
      </div>
      <div className="mt-1 flex justify-between text-xs text-slate-400">
        <span>{days[0].date.slice(5)}</span><span>今天</span>
      </div>
    </div>
  );
}

function Overview() {
  const [s, setS] = useState<any>(null);
  useEffect(() => { api('/api/admin/stats').then(setS).catch(() => {}); }, []);
  if (!s) return <div className="p-8 text-center text-sm text-slate-400">加载中…</div>;
  const types = Object.entries(s.by_type as Record<string, { count: number; size: number }>).sort((a, b) => b[1].size - a[1].size);
  return (
    <div className="space-y-4">
      <div className="grid grid-cols-2 gap-3 md:grid-cols-4">
        <Stat label="文件" value={s.files} sub={formatSize(s.total_size)} />
        <Stat label="Telegram 实际占用" value={formatSize(s.telegram_size)} sub={`${s.telegram_messages} 条消息（副本不重复计）`} />
        <Stat label="文件夹 / 回收站" value={`${s.folders} / ${s.trash}`} />
        <Stat label="用户" value={s.users} sub={`服务器临时文件 ${formatSize(s.staging_size)}`} />
      </div>
      <Section title="Telegram 存储">
        <div className="flex flex-wrap items-center gap-3 text-sm">
          <span className={`badge ${s.storage.connected ? 'bg-emerald-50 text-emerald-700 dark:bg-emerald-500/10 dark:text-emerald-300' : 'bg-rose-50 text-rose-700 dark:bg-rose-500/10 dark:text-rose-300'}`}>
            {s.storage.connected ? '● 已连接' : '● 未连接'}
          </span>
          <span className="text-slate-500">后端：{s.storage.backend === 'local' ? '本地模拟（开发模式）' : 'Telegram MTProto'}</span>
          <span className="text-slate-500">频道：{s.storage.chats.join('、') || '未配置'}</span>
        </div>
      </Section>
      <div className="grid gap-4 md:grid-cols-2">
        <Section title="最近 14 天新增文件"><DailyChart daily={s.daily} /></Section>
        <Section title="按类型">
          <table className="w-full text-sm">
            <tbody>
              {types.map(([k, v]) => (
                <tr key={k} className="border-b border-slate-100 last:border-0 dark:border-slate-800">
                  <td className="py-1.5">{categoryLabel[k as Category] || k}</td>
                  <td className="py-1.5 text-right tabular-nums text-slate-500">{v.count} 个</td>
                  <td className="py-1.5 text-right tabular-nums">{formatSize(v.size)}</td>
                </tr>
              ))}
              {!types.length && <tr><td className="py-2 text-slate-400">还没有文件</td></tr>}
            </tbody>
          </table>
          <div className="mt-4 text-xs text-slate-500">
            上传任务：{Object.entries(s.tasks).map(([k, v]) => `${k} ${v}`).join(' · ') || '无'}
          </div>
        </Section>
      </div>
    </div>
  );
}

function Users() {
  const { toast, prompt, confirm } = useDialogs();
  const { me } = useMe();
  const [users, setUsers] = useState<any[]>([]);
  const [form, setForm] = useState({ username: '', password: '', is_admin: false });
  const load = useCallback(() => { api('/api/admin/users').then((r) => setUsers(r.users)).catch(() => {}); }, []);
  useEffect(load, [load]);
  const patch = async (id: number, body: any, ok: string) => {
    try { await api(`/api/admin/users/${id}`, { method: 'PATCH', body }); toast(ok); } catch (e: any) { toast(e.message, 'error'); }
    load();
  };
  const create = async (e: React.FormEvent) => {
    e.preventDefault();
    try {
      await api('/api/admin/users', { method: 'POST', body: form });
      toast('用户已创建');
      setForm({ username: '', password: '', is_admin: false });
    } catch (err: any) { toast(err.message, 'error'); }
    load();
  };
  return (
    <div className="space-y-4">
      <Section title="用户" desc="每个用户只能看到自己的文件；查重也只在自己的文件里查。">
        <div className="overflow-x-auto">
          <table className="w-full text-sm">
            <thead className="text-left text-xs text-slate-500"><tr><th className="py-2">用户名</th><th>文件</th><th>最后登录</th><th>状态</th><th /></tr></thead>
            <tbody>
              {users.map((u) => (
                <tr key={u.id} className="border-t border-slate-100 dark:border-slate-800">
                  <td className="py-2">{u.username} {u.is_admin && <span className="badge bg-sky-50 text-sky-700 dark:bg-sky-500/10 dark:text-sky-300">管理员</span>}</td>
                  <td className="tabular-nums text-slate-500">{u.files} · {formatSize(u.size)}</td>
                  <td className="text-slate-500">{formatDate(u.last_login_at)}</td>
                  <td>{u.disabled ? <span className="text-rose-600">已停用</span> : '正常'}</td>
                  <td className="space-x-2 whitespace-nowrap text-right">
                    <button className="text-xs text-sky-600 hover:underline" onClick={async () => {
                      const pw = await prompt({ title: `重置 ${u.username} 的密码`, label: '新密码（至少 8 位）', okText: '重置' });
                      if (pw) patch(u.id, { password: pw }, '密码已重置');
                    }}>重置密码</button>
                    {u.id !== me?.id && (
                      <>
                        <button className="text-xs text-sky-600 hover:underline" onClick={() => patch(u.id, { is_admin: !u.is_admin }, '已更新')}>{u.is_admin ? '取消管理员' : '设为管理员'}</button>
                        <button className="text-xs text-rose-600 hover:underline" onClick={async () => {
                          if (u.disabled || await confirm({ title: `停用 ${u.username}？`, message: '停用后立即退出登录，文件保留。', okText: '停用', danger: true }))
                            patch(u.id, { disabled: !u.disabled }, u.disabled ? '已启用' : '已停用');
                        }}>{u.disabled ? '启用' : '停用'}</button>
                      </>
                    )}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </Section>
      <Section title="新建用户">
        <form onSubmit={create} className="flex flex-wrap items-center gap-2">
          <input className="input w-40" placeholder="用户名" value={form.username} onChange={(e) => setForm({ ...form, username: e.target.value })} required pattern="[A-Za-z0-9_.@\-]{2,64}" title="字母、数字、_ . @ -" />
          <input className="input w-48" type="password" placeholder="密码（至少 8 位）" minLength={8} value={form.password} onChange={(e) => setForm({ ...form, password: e.target.value })} required autoComplete="new-password" />
          <label className="flex items-center gap-1.5 text-sm"><input type="checkbox" className="accent-sky-600" checked={form.is_admin} onChange={(e) => setForm({ ...form, is_admin: e.target.checked })} />管理员</label>
          <button className="btn-primary">创建</button>
        </form>
      </Section>
    </div>
  );
}

function AllTasks() {
  const [tasks, setTasks] = useState<any[]>([]);
  const [status, setStatus] = useState('');
  useEffect(() => { api(`/api/admin/tasks?status=${status}`).then((r) => setTasks(r.tasks)).catch(() => {}); }, [status]);
  return (
    <Section title="全部上传任务" desc="所有用户最近 200 个任务。">
      <select className="input mb-3 w-40" value={status} onChange={(e) => setStatus(e.target.value)}>
        <option value="">全部状态</option>
        {['pending', 'queued', 'uploading', 'completed', 'failed', 'cancelled'].map((s) => <option key={s}>{s}</option>)}
      </select>
      <div className="overflow-x-auto">
        <table className="w-full text-sm">
          <thead className="text-left text-xs text-slate-500"><tr><th className="py-2">#</th><th>用户</th><th>文件</th><th>大小</th><th>状态</th><th>重试</th><th>时间</th></tr></thead>
          <tbody>
            {tasks.map((t) => (
              <tr key={t.id} className="border-t border-slate-100 align-top dark:border-slate-800">
                <td className="py-2 text-slate-400">{t.id}</td>
                <td>{t.user}</td>
                <td className="max-w-xs"><div className="truncate">{t.filename}</div>{t.error_message && <div className="break-all text-xs text-rose-600">{t.error_message}</div>}</td>
                <td className="whitespace-nowrap tabular-nums text-slate-500">{formatSize(t.file_size)}</td>
                <td className="whitespace-nowrap">{t.status}{t.status === 'uploading' ? ` ${t.progress}%` : ''}</td>
                <td className="tabular-nums">{t.retry_count}</td>
                <td className="whitespace-nowrap text-slate-500">{formatDate(t.created_at)}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </Section>
  );
}

function Logs() {
  const [logs, setLogs] = useState<any[]>([]);
  const [level, setLevel] = useState('');
  const [more, setMore] = useState(true);
  const load = useCallback(async (before?: number) => {
    const r = await api(`/api/admin/logs?level=${level}&limit=100${before ? `&before_id=${before}` : ''}`);
    setLogs((l) => (before ? [...l, ...r.logs] : r.logs));
    setMore(r.logs.length === 100);
  }, [level]);
  useEffect(() => { load().catch(() => {}); }, [load]);
  const color: Record<string, string> = { error: 'text-rose-600', warning: 'text-amber-600', info: 'text-slate-500' };
  return (
    <Section title="系统日志" desc="登录、上传、失败重试、删除、备份等操作记录。">
      <select className="input mb-3 w-40" value={level} onChange={(e) => setLevel(e.target.value)}>
        <option value="">全部级别</option><option value="info">info</option><option value="warning">warning</option><option value="error">error</option>
      </select>
      <div className="divide-y divide-slate-100 text-sm dark:divide-slate-800">
        {logs.map((l) => (
          <div key={l.id} className="grid grid-cols-[9.5rem_1fr] gap-2 py-1.5">
            <span className="text-xs tabular-nums text-slate-400">{formatDateFull(l.created_at)}</span>
            <span className="min-w-0 break-words">
              <span className={`mr-1.5 text-xs font-medium uppercase ${color[l.level] || ''}`}>{l.level}</span>
              <span className="mr-1.5 font-mono text-xs text-slate-500">{l.source}/{l.event}</span>
              {l.message}
              {(l.user || l.ip) && <span className="ml-1.5 text-xs text-slate-400">{[l.user, l.ip].filter(Boolean).join(' · ')}</span>}
            </span>
          </div>
        ))}
      </div>
      {more && logs.length > 0 && <button className="btn mt-3" onClick={() => load(logs[logs.length - 1].id)}>加载更多</button>}
    </Section>
  );
}

function Backup() {
  const { toast, confirm } = useDialogs();
  const [list, setList] = useState<any[]>([]);
  const [busy, setBusy] = useState(false);
  const [rebuild, setRebuild] = useState<any>(null);
  const load = useCallback(() => {
    api('/api/admin/backups').then((r) => setList(r.backups)).catch(() => {});
    api('/api/admin/rebuild').then(setRebuild).catch(() => {});
  }, []);
  useEffect(load, [load]);
  useEffect(() => {
    if (!rebuild?.running) return;
    const t = setInterval(() => api('/api/admin/rebuild').then((r) => {
      setRebuild(r);
      if (!r.running) emit('folders-changed');
    }), 2000);
    return () => clearInterval(t);
  }, [rebuild?.running]);

  const make = async (tg: boolean) => {
    setBusy(true);
    try {
      const r = await api(`/api/admin/backups?to_telegram=${tg}`, { method: 'POST' });
      toast(`备份完成：${r.files} 个文件记录${r.telegram ? '，已发到 Telegram' : ''}`);
    } catch (e: any) { toast(e.message, 'error'); }
    setBusy(false);
    load();
  };
  const startRebuild = async () => {
    if (!(await confirm({ title: '从 Telegram 重建索引？', message: '会把频道从第一条消息扫到最新一条，把数据库里没有记录、但带本系统元数据的文件补回到你的云盘（按原来的文件夹路径）。已有的记录不会重复添加。', okText: '开始' }))) return;
    try { setRebuild(await api('/api/admin/rebuild', { method: 'POST' })); } catch (e: any) { toast(e.message, 'error'); }
  };

  return (
    <div className="space-y-4">
      <Section title="数据库备份" desc="导出文件、文件夹、用户的全部记录（JSON，gzip 压缩）。服务器保留最近 20 份；也可以同时存一份到 Telegram 私有频道，服务器坏了也不丢。">
        <div className="flex flex-wrap gap-2">
          <button className="btn-primary" disabled={busy} onClick={() => make(false)}>立即备份</button>
          <button className="btn" disabled={busy} onClick={() => make(true)}>备份并发到 Telegram</button>
        </div>
        <div className="mt-4 divide-y divide-slate-100 text-sm dark:divide-slate-800">
          {list.map((b) => (
            <div key={b.name} className="flex items-center gap-3 py-2">
              <span className="flex-1 font-mono text-xs">{b.name}</span>
              <span className="text-xs text-slate-500">{formatSize(b.size)}</span>
              <a className="text-xs text-sky-600 hover:underline" href={`/api/admin/backups/${b.name}`}>下载</a>
            </div>
          ))}
          {!list.length && <div className="py-2 text-slate-400">还没有备份</div>}
        </div>
        <p className="mt-3 text-xs text-slate-500">恢复：在新服务器上用空数据库运行 <code>python -m backend.cli restore 备份文件.json.gz</code></p>
      </Section>
      <Section title="从 Telegram 重建索引" desc="每个文件在 Telegram 消息里都带着自己的元数据（文件名、大小、SHA-256、文件夹路径），数据库丢了也能从频道恢复文件列表。">
        <button className="btn" disabled={rebuild?.running} onClick={startRebuild}>{rebuild?.running ? '正在扫描…' : '开始重建'}</button>
        {rebuild && rebuild.started_at && (
          <div className="mt-3 text-sm text-slate-600 dark:text-slate-300">
            已扫描 {rebuild.scanned}{rebuild.latest ? ` / ${rebuild.latest}` : ''} 条消息，找到 {rebuild.found} 个文件，新增 {rebuild.added}，已存在 {rebuild.skipped}
            {rebuild.error && <div className="text-rose-600">出错：{rebuild.error}</div>}
            {!rebuild.running && rebuild.finished_at && !rebuild.error && <div className="text-emerald-600">完成</div>}
          </div>
        )}
      </Section>
    </div>
  );
}

function SettingsView() {
  const { me } = useMe();
  const [tab, setTab] = useState<Tab>('account');
  const tabs: [Tab, string][] = me?.is_admin
    ? [['account', '账号'], ['overview', '概览'], ['users', '用户'], ['tasks', '全部任务'], ['logs', '系统日志'], ['backup', '备份与恢复']]
    : [['account', '账号']];
  return (
    <div className="mx-auto max-w-5xl p-4 sm:p-6">
      <h1 className="mb-4 text-lg font-semibold">{me?.is_admin ? '设置与管理后台' : '设置'}</h1>
      <div className="mb-5 flex gap-1 overflow-x-auto border-b border-slate-200 dark:border-slate-800">
        {tabs.map(([k, label]) => (
          <button key={k} onClick={() => setTab(k)}
            className={`whitespace-nowrap border-b-2 px-3 py-2 text-sm ${tab === k ? 'border-sky-600 font-medium text-sky-700 dark:text-sky-300' : 'border-transparent text-slate-500 hover:text-slate-800 dark:hover:text-slate-200'}`}>
            {label}
          </button>
        ))}
      </div>
      {tab === 'account' && <Account />}
      {tab === 'overview' && <Overview />}
      {tab === 'users' && <Users />}
      {tab === 'tasks' && <AllTasks />}
      {tab === 'logs' && <Logs />}
      {tab === 'backup' && <Backup />}
    </div>
  );
}

export default function SettingsPage() {
  return <AppShell><SettingsView /></AppShell>;
}
