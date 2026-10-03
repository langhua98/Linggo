'use client';

import Link from 'next/link';
import { usePathname, useSearchParams } from 'next/navigation';
import { createContext, Suspense, useCallback, useContext, useEffect, useRef, useState } from 'react';
import { api } from '@/lib/api';
import { formatSize } from '@/lib/format';
import type { Me } from '@/lib/types';
import FolderTree from './FolderTree';
import { IconCloud, IconMenu, IconSettings, IconTasks, IconTrash, IconUser, IconX } from './Icons';
import { DialogProvider } from './Modal';
import SearchBox from './SearchBox';
import UploadProgress from './UploadProgress';

const MeCtx = createContext<{ me: Me | null; reload: () => void }>({ me: null, reload: () => {} });
export const useMe = () => useContext(MeCtx);

function Sidebar({ me, onNavigate }: { me: Me | null; onNavigate?: () => void }) {
  const path = usePathname();
  const params = useSearchParams();
  const folder = params.get('folder');
  const current = path.startsWith('/files') && folder ? Number(folder) : null;
  const nav = [
    { href: '/files/', label: '我的云盘', icon: <IconCloud />, active: path.startsWith('/files') && !folder && !params.get('q') },
    { href: '/tasks/', label: '上传任务', icon: <IconTasks />, active: path.startsWith('/tasks') },
    { href: '/trash/', label: '回收站', icon: <IconTrash />, active: path.startsWith('/trash') },
    { href: '/settings/', label: me?.is_admin ? '设置与管理' : '设置', icon: <IconSettings />, active: path.startsWith('/settings') },
  ];
  return (
    <div className="flex h-full flex-col">
      <Link href="/files/" onClick={onNavigate} className="flex items-center gap-2 px-5 py-4">
        <span className="flex h-8 w-8 items-center justify-center rounded-xl bg-sky-600 text-white"><IconCloud className="h-5 w-5" /></span>
        <span className="font-semibold">私有云盘</span>
      </Link>
      <nav className="space-y-0.5 px-3">
        {nav.map((n) => (
          <Link key={n.href} href={n.href} onClick={onNavigate}
            className={`flex items-center gap-3 rounded-lg px-3 py-2 text-sm ${n.active ? 'bg-sky-50 font-medium text-sky-700 dark:bg-sky-500/10 dark:text-sky-300' : 'text-slate-600 hover:bg-slate-100 dark:text-slate-300 dark:hover:bg-slate-800'}`}>
            {n.icon}{n.label}
          </Link>
        ))}
      </nav>
      <div className="mt-4 px-5 text-xs font-medium uppercase tracking-wide text-slate-400">文件夹</div>
      <div className="mt-1 min-h-0 flex-1 overflow-y-auto px-2 pb-3">
        <FolderTree current={current} onNavigate={onNavigate} />
      </div>
      {me && (
        <div className="border-t border-slate-200 px-5 py-3 text-xs text-slate-500 dark:border-slate-800">
          {me.usage.file_count} 个文件 · {formatSize(me.usage.total_size)}
          <div className="mt-0.5 text-slate-400">存储在 Telegram 私有频道</div>
        </div>
      )}
    </div>
  );
}

function UserMenu({ me }: { me: Me | null }) {
  const [open, setOpen] = useState(false);
  const ref = useRef<HTMLDivElement>(null);
  useEffect(() => {
    const close = (e: MouseEvent) => ref.current && !ref.current.contains(e.target as Node) && setOpen(false);
    document.addEventListener('mousedown', close);
    return () => document.removeEventListener('mousedown', close);
  }, []);
  const logout = async () => {
    await api('/api/auth/logout', { method: 'POST' }).catch(() => {});
    location.href = '/login/';
  };
  return (
    <div className="relative" ref={ref}>
      <button onClick={() => setOpen(!open)} className="flex items-center gap-2 rounded-full py-1 pl-1 pr-3 text-sm hover:bg-slate-100 dark:hover:bg-slate-800">
        <span className="flex h-8 w-8 items-center justify-center rounded-full bg-slate-200 text-slate-600 dark:bg-slate-700 dark:text-slate-200"><IconUser className="h-4 w-4" /></span>
        <span className="hidden sm:inline">{me?.username}</span>
      </button>
      {open && (
        <div className="menu right-0 top-11">
          <div className="px-3 py-2 text-xs text-slate-400">{me?.is_admin ? '管理员' : '用户'} · {me?.username}</div>
          <Link href="/settings/" className="menu-item" onClick={() => setOpen(false)}><IconSettings className="h-4 w-4" />设置</Link>
          <button className="menu-item text-rose-600" onClick={logout}>退出登录</button>
        </div>
      )}
    </div>
  );
}

function Shell({ children }: { children: React.ReactNode }) {
  const [me, setMe] = useState<Me | null>(null);
  const [drawer, setDrawer] = useState(false);
  const reload = useCallback(() => {
    api<Me>('/api/auth/me').then(setMe).catch(() => {});
  }, []);
  useEffect(reload, [reload]);

  return (
    <MeCtx.Provider value={{ me, reload }}>
      <div className="flex h-dvh overflow-hidden">
        <aside className="hidden w-64 shrink-0 border-r border-slate-200 bg-white lg:block dark:border-slate-800 dark:bg-slate-900">
          <Sidebar me={me} />
        </aside>
        {drawer && (
          <div className="fixed inset-0 z-40 lg:hidden" onClick={() => setDrawer(false)}>
            <div className="absolute inset-0 bg-black/40" />
            <aside className="absolute inset-y-0 left-0 w-72 bg-white shadow-xl dark:bg-slate-900" onClick={(e) => e.stopPropagation()}>
              <button className="btn-icon absolute right-3 top-4" onClick={() => setDrawer(false)} aria-label="关闭菜单"><IconX /></button>
              <Sidebar me={me} onNavigate={() => setDrawer(false)} />
            </aside>
          </div>
        )}
        <div className="flex min-w-0 flex-1 flex-col">
          <header className="flex items-center gap-3 border-b border-slate-200 bg-white px-4 py-2.5 dark:border-slate-800 dark:bg-slate-900">
            <button className="btn-icon lg:hidden" onClick={() => setDrawer(true)} aria-label="菜单"><IconMenu /></button>
            <div className="flex flex-1 justify-center lg:justify-start"><SearchBox /></div>
            <UserMenu me={me} />
          </header>
          <main className="min-h-0 flex-1 overflow-y-auto">{children}</main>
        </div>
      </div>
      <UploadProgress />
    </MeCtx.Provider>
  );
}

export default function AppShell({ children }: { children: React.ReactNode }) {
  return (
    <DialogProvider>
      <Suspense fallback={null}>
        <Shell>{children}</Shell>
      </Suspense>
    </DialogProvider>
  );
}
