'use client';

import { useState } from 'react';
import { api } from '@/lib/api';
import { IconCloud } from '@/components/Icons';

export default function LoginPage() {
  const [username, setUsername] = useState('');
  const [password, setPassword] = useState('');
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);

  const submit = async (e: React.FormEvent) => {
    e.preventDefault();
    setBusy(true);
    setError('');
    try {
      await api('/api/auth/login', { method: 'POST', body: { username, password } });
      const next = new URLSearchParams(location.search).get('next');
      // 只跳本站内的路径
      location.href = next && next.startsWith('/') && !next.startsWith('//') ? next : '/files/';
    } catch (err: any) {
      setError(err.message);
      setBusy(false);
    }
  };

  return (
    <div className="flex min-h-dvh items-center justify-center p-4">
      <form onSubmit={submit} className="card w-full max-w-sm p-8 shadow-sm">
        <div className="mb-6 flex flex-col items-center gap-3">
          <span className="flex h-12 w-12 items-center justify-center rounded-2xl bg-sky-600 text-white"><IconCloud className="h-7 w-7" /></span>
          <h1 className="text-xl font-semibold">私有云盘</h1>
          <p className="text-sm text-slate-500">登录后才能访问文件</p>
        </div>
        <label className="mb-1 block text-sm text-slate-600 dark:text-slate-300" htmlFor="u">用户名</label>
        <input id="u" className="input mb-4" autoComplete="username" value={username} onChange={(e) => setUsername(e.target.value)} autoFocus required />
        <label className="mb-1 block text-sm text-slate-600 dark:text-slate-300" htmlFor="p">密码</label>
        <input id="p" className="input" type="password" autoComplete="current-password" value={password} onChange={(e) => setPassword(e.target.value)} required />
        {error && <p className="mt-3 text-sm text-rose-600" role="alert">{error}</p>}
        <button className="btn-primary mt-6 w-full py-2" disabled={busy}>{busy ? '登录中…' : '登录'}</button>
      </form>
    </div>
  );
}
