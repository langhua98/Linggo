'use client';

import { useCallback, useEffect, useState } from 'react';
import AppShell, { useMe } from '@/components/AppShell';
import { FileTypeIcon, FolderIcon, IconRestore, IconTrash } from '@/components/Icons';
import { useDialogs } from '@/components/Modal';
import { api } from '@/lib/api';
import { emit } from '@/lib/bus';
import { formatDate, formatSize } from '@/lib/format';
import type { DriveFile, Folder } from '@/lib/types';

function TrashView() {
  const [data, setData] = useState<{ files: DriveFile[]; folders: Folder[] } | null>(null);
  const { toast, confirm } = useDialogs();
  const { reload: reloadMe } = useMe();
  const load = useCallback(() => {
    api('/api/trash').then(setData).catch((e) => toast(e.message, 'error'));
  }, [toast]);
  useEffect(load, [load]);

  const act = async (fn: () => Promise<any>, ok: string) => {
    try {
      await fn();
      toast(ok);
    } catch (e: any) {
      toast(e.message, 'error');
    }
    load();
    emit('folders-changed');
    reloadMe();
  };

  const purge = async (kind: 'files' | 'folders', id: number, name: string) => {
    if (await confirm({ title: `永久删除「${name}」？`, message: '会同时删除 Telegram 私有频道里对应的消息，无法恢复。', okText: '永久删除', danger: true }))
      act(() => api(`/api/trash/${kind}/${id}`, { method: 'DELETE' }), '已永久删除');
  };

  const empty = async () => {
    if (await confirm({ title: '清空回收站？', message: '回收站里所有文件会被永久删除，Telegram 里对应的消息也会删除，无法恢复。', okText: '清空', danger: true }))
      act(() => api('/api/trash', { method: 'DELETE' }), '回收站已清空');
  };

  const rows = data ? [...data.folders, ...data.files] : [];
  return (
    <div className="mx-auto max-w-5xl p-4 sm:p-6">
      <div className="mb-4 flex items-center gap-3">
        <h1 className="flex-1 text-lg font-semibold">回收站</h1>
        <button className="btn-danger" disabled={!rows.length} onClick={empty}><IconTrash className="h-4 w-4" />清空回收站</button>
      </div>
      <p className="mb-4 text-sm text-slate-500">删除的文件先放在这里，Telegram 里的文件还在。恢复会回到原来的位置（原文件夹不在了就回到根目录）。</p>
      <div className="card divide-y divide-slate-100 dark:divide-slate-800">
        {!data && <div className="p-12 text-center text-sm text-slate-400">加载中…</div>}
        {data && !rows.length && <div className="p-12 text-center text-sm text-slate-400">回收站是空的</div>}
        {rows.map((r) => {
          const isFile = r.type === 'file';
          const name = isFile ? (r as DriveFile).filename : (r as Folder).name;
          const kind = isFile ? 'files' : 'folders';
          return (
            <div key={`${r.type}${r.id}`} className="flex items-center gap-3 px-4 py-3">
              {isFile ? <FileTypeIcon category={(r as DriveFile).category} /> : <FolderIcon />}
              <div className="min-w-0 flex-1">
                <div className="truncate text-sm font-medium">{name}</div>
                <div className="truncate text-xs text-slate-400">
                  原位置 {r.path || '/'} · {isFile ? formatSize((r as DriveFile).file_size) + ' · ' : '文件夹及其内容 · '}删除于 {formatDate(r.deleted_at)}
                </div>
              </div>
              <button className="btn" onClick={() => act(() => api(`/api/${kind}/${r.id}/restore`, { method: 'POST' }), '已恢复')}>
                <IconRestore className="h-4 w-4" /><span className="hidden sm:inline">恢复</span>
              </button>
              <button className="btn text-rose-600" onClick={() => purge(kind, r.id, name)}>
                <IconTrash className="h-4 w-4" /><span className="hidden sm:inline">永久删除</span>
              </button>
            </div>
          );
        })}
      </div>
    </div>
  );
}

export default function TrashPage() {
  return <AppShell><TrashView /></AppShell>;
}
