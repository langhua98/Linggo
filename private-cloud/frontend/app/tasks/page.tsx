'use client';

import { useCallback, useEffect, useState } from 'react';
import AppShell from '@/components/AppShell';
import { IconRefresh } from '@/components/Icons';
import { useDialogs } from '@/components/Modal';
import { api } from '@/lib/api';
import { formatDate, formatSize } from '@/lib/format';
import type { ServerTask } from '@/lib/types';

const statusInfo: Record<ServerTask['status'], [string, string]> = {
  pending: ['等待浏览器上传', 'bg-slate-100 text-slate-600 dark:bg-slate-800 dark:text-slate-300'],
  queued: ['排队中', 'bg-sky-50 text-sky-700 dark:bg-sky-500/10 dark:text-sky-300'],
  uploading: ['正在存入 Telegram', 'bg-violet-50 text-violet-700 dark:bg-violet-500/10 dark:text-violet-300'],
  completed: ['完成', 'bg-emerald-50 text-emerald-700 dark:bg-emerald-500/10 dark:text-emerald-300'],
  failed: ['失败', 'bg-rose-50 text-rose-700 dark:bg-rose-500/10 dark:text-rose-300'],
  cancelled: ['已取消', 'bg-slate-100 text-slate-500 dark:bg-slate-800 dark:text-slate-400'],
};

function TasksView() {
  const [tasks, setTasks] = useState<ServerTask[] | null>(null);
  const { toast } = useDialogs();
  const load = useCallback(() => {
    api<{ tasks: ServerTask[] }>('/api/upload/tasks').then((r) => setTasks(r.tasks)).catch((e) => toast(e.message, 'error'));
  }, [toast]);
  useEffect(load, [load]);
  const active = tasks?.some((t) => ['queued', 'uploading'].includes(t.status));
  useEffect(() => {
    if (!active) return;
    const t = setInterval(load, 2000);
    return () => clearInterval(t);
  }, [active, load]);

  const act = async (path: string, ok: string) => {
    try {
      await api(path, { method: 'POST' });
      toast(ok);
    } catch (e: any) {
      toast(e.message, 'error');
    }
    load();
  };

  return (
    <div className="mx-auto max-w-5xl p-4 sm:p-6">
      <div className="mb-4 flex items-center gap-2">
        <h1 className="flex-1 text-lg font-semibold">上传任务</h1>
        <button className="btn" onClick={() => act('/api/upload/tasks/clear', '已清除完成的任务')}>清除已完成</button>
        <button className="btn-icon" onClick={load} aria-label="刷新"><IconRefresh className="h-4 w-4" /></button>
      </div>
      <p className="mb-4 text-sm text-slate-500">
        文件先传到服务器，再由后台 Worker 存进 Telegram 私有频道。存入 Telegram 这一步在服务器上进行，关掉网页也会继续；失败会自动重试 3 次。
      </p>
      <div className="card divide-y divide-slate-100 dark:divide-slate-800">
        {!tasks && <div className="p-12 text-center text-sm text-slate-400">加载中…</div>}
        {tasks && !tasks.length && <div className="p-12 text-center text-sm text-slate-400">还没有上传任务</div>}
        {tasks?.map((t) => {
          const [label, cls] = statusInfo[t.status];
          const pct = t.status === 'pending' ? Math.floor((t.received_chunks * 100) / t.total_chunks) : t.progress;
          return (
            <div key={t.id} className="px-4 py-3">
              <div className="flex items-center gap-3">
                <div className="min-w-0 flex-1">
                  <div className="truncate text-sm font-medium">{t.filename}</div>
                  <div className="text-xs text-slate-400">
                    #{t.id} · {formatSize(t.file_size)} · {formatDate(t.created_at)}
                    {t.retry_count > 0 && ` · 已重试 ${t.retry_count} 次`}
                  </div>
                </div>
                <span className={`badge ${cls}`}>{label}{['uploading', 'pending'].includes(t.status) ? ` ${pct}%` : ''}</span>
                {['pending', 'queued', 'uploading', 'failed'].includes(t.status) && (
                  <button className="text-xs text-slate-500 hover:text-rose-600" onClick={() => act(`/api/upload/${t.id}/cancel`, '已取消')}>取消</button>
                )}
                {t.status === 'failed' && (
                  <button className="text-xs text-sky-600 hover:underline" onClick={() => act(`/api/upload/${t.id}/retry`, '已重新排队')}>重新上传</button>
                )}
              </div>
              {['uploading', 'pending', 'queued'].includes(t.status) && (
                <div className="mt-2 h-1.5 overflow-hidden rounded-full bg-slate-100 dark:bg-slate-800">
                  <div className="h-full bg-violet-500 transition-all" style={{ width: `${Math.max(pct, 2)}%` }} />
                </div>
              )}
              {t.status === 'pending' && <div className="mt-1 text-xs text-slate-400">在浏览器里重新选择同一个文件上传，会从断点继续</div>}
              {t.error_message && t.status !== 'cancelled' && <div className="mt-1 break-all text-xs text-rose-600">{t.error_message}</div>}
            </div>
          );
        })}
      </div>
    </div>
  );
}

export default function TasksPage() {
  return <AppShell><TasksView /></AppShell>;
}
