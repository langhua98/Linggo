'use client';

import type { SortKey } from '@/lib/types';
import FileItem, { type Action, type Entry } from './FileItem';
import { IconArrowDown, IconArrowUp } from './Icons';

export const keyOf = (e: Entry) => (e.type === 'file' ? `f:${e.id}` : `d:${e.id}`);

export default function FileList({ entries, selected, onSelect, onSelectAll, onAction, sort, order, onSort, showPath, empty }: {
  entries: Entry[];
  selected: Set<string>;
  onSelect: (e: Entry, on: boolean, shift: boolean) => void;
  onSelectAll: (on: boolean) => void;
  onAction: (e: Entry, a: Action) => void;
  sort?: SortKey;
  order?: 'asc' | 'desc';
  onSort?: (k: SortKey) => void;
  showPath?: boolean;
  empty?: React.ReactNode;
}) {
  const all = entries.length > 0 && entries.every((e) => selected.has(keyOf(e)));
  const Th = ({ k, children, className = '' }: { k?: SortKey; children: React.ReactNode; className?: string }) => (
    <th className={`py-2.5 text-left text-xs font-medium text-slate-500 ${className}`}>
      {k && onSort ? (
        <button className={`inline-flex items-center gap-0.5 hover:text-slate-800 dark:hover:text-slate-200 ${sort === k ? 'text-slate-800 dark:text-slate-200' : ''}`} onClick={() => onSort(k)}>
          {children}
          {sort === k && (order === 'asc' ? <IconArrowUp className="h-3.5 w-3.5" /> : <IconArrowDown className="h-3.5 w-3.5" />)}
        </button>
      ) : children}
    </th>
  );
  if (!entries.length) return <>{empty}</>;
  return (
    <table className="w-full table-fixed">
      <thead className="border-b border-slate-200 dark:border-slate-800">
        <tr>
          <th className="w-10 pl-4">
            <input type="checkbox" checked={all} onChange={(e) => onSelectAll(e.target.checked)} className="h-4 w-4 rounded accent-sky-600" aria-label="全选" />
          </th>
          <Th k="name">名称</Th>
          <Th k="type" className="hidden w-28 md:table-cell">类型</Th>
          <Th k="size" className="hidden w-24 sm:table-cell">大小</Th>
          <Th k="updated" className="hidden w-32 sm:table-cell">修改时间</Th>
          <Th className="hidden w-28 lg:table-cell">状态</Th>
          <th className="w-12" />
        </tr>
      </thead>
      <tbody>
        {entries.map((e) => (
          <FileItem key={keyOf(e)} entry={e} selected={selected.has(keyOf(e))} showPath={showPath}
            onSelect={(on, shift) => onSelect(e, on, shift)} onAction={(a) => onAction(e, a)} />
        ))}
      </tbody>
    </table>
  );
}
