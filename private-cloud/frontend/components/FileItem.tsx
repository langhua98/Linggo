'use client';

import { useEffect, useRef, useState } from 'react';
import { categoryLabel, extOf, formatDate, formatSize } from '@/lib/format';
import type { DriveFile, Folder } from '@/lib/types';
import { FileTypeIcon, FolderIcon, IconDots } from './Icons';

export type Action = 'open' | 'preview' | 'download' | 'rename' | 'move' | 'copy' | 'delete' | 'details';
export type Entry = DriveFile | Folder;

const statusBadge: Record<string, [string, string]> = {
  pending: ['等待上传', 'bg-slate-100 text-slate-600 dark:bg-slate-800 dark:text-slate-300'],
  uploading: ['上传中', 'bg-violet-50 text-violet-700 dark:bg-violet-500/10 dark:text-violet-300'],
  completed: ['已存储', 'bg-emerald-50 text-emerald-700 dark:bg-emerald-500/10 dark:text-emerald-300'],
  failed: ['失败', 'bg-rose-50 text-rose-700 dark:bg-rose-500/10 dark:text-rose-300'],
};

function RowMenu({ entry, onAction }: { entry: Entry; onAction: (a: Action) => void }) {
  const [open, setOpen] = useState(false);
  const ref = useRef<HTMLDivElement>(null);
  useEffect(() => {
    if (!open) return;
    const close = (e: MouseEvent) => ref.current && !ref.current.contains(e.target as Node) && setOpen(false);
    document.addEventListener('mousedown', close);
    return () => document.removeEventListener('mousedown', close);
  }, [open]);
  const isFile = entry.type === 'file';
  const done = isFile && (entry as DriveFile).status === 'completed';
  const items: [Action, string, boolean?][] = isFile
    ? [['preview', '打开 / 预览'], ['download', '下载', !done && (entry as DriveFile).status !== 'pending'], ['rename', '重命名'], ['move', '移动到…'],
       ['copy', '复制到…', !done], ['details', '详细信息'], ['delete', (entry as DriveFile).status === 'completed' ? '删除' : '取消上传并删除']]
    : [['open', '打开'], ['rename', '重命名'], ['move', '移动到…'], ['delete', '删除']];
  return (
    <div className="relative" ref={ref}>
      <button className="btn-icon" onClick={(e) => { e.stopPropagation(); setOpen(!open); }} aria-label="更多操作"><IconDots className="h-4 w-4" /></button>
      {open && (
        <div className="menu right-0 top-9" onClick={(e) => e.stopPropagation()}>
          {items.map(([a, label, disabled]) => (
            <button key={a} disabled={disabled} className={`menu-item disabled:opacity-40 ${a === 'delete' ? 'text-rose-600' : ''}`}
              onClick={() => { setOpen(false); onAction(a); }}>{label}</button>
          ))}
        </div>
      )}
    </div>
  );
}

export default function FileItem({ entry, selected, onSelect, onAction, showPath }: {
  entry: Entry;
  selected: boolean;
  onSelect: (on: boolean, shift: boolean) => void;
  onAction: (a: Action) => void;
  showPath?: boolean;
}) {
  const isFile = entry.type === 'file';
  const f = entry as DriveFile;
  const name = isFile ? f.filename : (entry as Folder).name;
  const badge = isFile ? statusBadge[f.status] : null;
  return (
    <tr onClick={() => onAction(isFile ? 'preview' : 'open')}
      className={`group cursor-pointer border-b border-slate-100 last:border-0 dark:border-slate-800 ${selected ? 'bg-sky-50/70 dark:bg-sky-500/10' : 'hover:bg-slate-50 dark:hover:bg-slate-800/50'}`}>
      <td className="w-10 pl-4" onClick={(e) => e.stopPropagation()}>
        <input type="checkbox" checked={selected} onChange={(e) => onSelect(e.target.checked, (e.nativeEvent as MouseEvent).shiftKey)}
          className="h-4 w-4 rounded accent-sky-600" aria-label={`选择 ${name}`} />
      </td>
      <td className="py-2 pr-3">
        <div className="flex min-w-0 items-center gap-3">
          {isFile ? <FileTypeIcon category={f.category} /> : <FolderIcon />}
          <div className="min-w-0">
            <div className="truncate text-sm font-medium" title={name}>{name}</div>
            {showPath && entry.path !== undefined && <div className="truncate text-xs text-slate-400">{entry.path}</div>}
            {isFile && (f.status === 'uploading' || f.status === 'pending') && (
              <div className="mt-1 h-1 w-32 overflow-hidden rounded-full bg-slate-100 dark:bg-slate-800">
                <div className="h-full bg-violet-500 transition-all" style={{ width: `${Math.max(f.upload_progress, 3)}%` }} />
              </div>
            )}
            <div className="text-xs text-slate-400 sm:hidden">{isFile ? `${formatSize(f.file_size)} · ` : ''}{formatDate(entry.updated_at)}</div>
          </div>
        </div>
      </td>
      <td className="hidden w-28 text-sm text-slate-500 md:table-cell">{isFile ? `${categoryLabel[f.category]}${extOf(name) ? ' · ' + extOf(name) : ''}` : '文件夹'}</td>
      <td className="hidden w-24 text-sm text-slate-500 sm:table-cell">{isFile ? formatSize(f.file_size) : '-'}</td>
      <td className="hidden w-32 text-sm text-slate-500 sm:table-cell">{formatDate(entry.updated_at)}</td>
      <td className="hidden w-28 lg:table-cell">
        {badge && <span className={`badge ${badge[1]}`}>{badge[0]}{f.status === 'uploading' ? ` ${f.upload_progress}%` : ''}</span>}
      </td>
      <td className="w-12 pr-2" onClick={(e) => e.stopPropagation()}>
        <RowMenu entry={entry} onAction={onAction} />
      </td>
    </tr>
  );
}
