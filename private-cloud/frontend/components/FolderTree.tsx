'use client';

import Link from 'next/link';
import { useCallback, useEffect, useMemo, useState } from 'react';
import { api } from '@/lib/api';
import { on } from '@/lib/bus';
import type { Folder } from '@/lib/types';
import { IconChevron } from './Icons';

export function useFolders() {
  const [folders, setFolders] = useState<Folder[]>([]);
  const load = useCallback(() => {
    api<{ folders: Folder[] }>('/api/folders').then((r) => setFolders(r.folders)).catch(() => {});
  }, []);
  useEffect(() => {
    load();
    return on('folders-changed', load);
  }, [load]);
  return folders;
}

export function childrenMap(folders: Folder[]) {
  const m = new Map<number | null, Folder[]>();
  for (const f of folders) {
    const k = f.parent_id;
    if (!m.has(k)) m.set(k, []);
    m.get(k)!.push(f);
  }
  return m;
}

function ancestors(folders: Folder[], id: number | null) {
  const byId = new Map(folders.map((f) => [f.id, f]));
  const out = new Set<number>();
  let cur = id != null ? byId.get(id) : undefined;
  while (cur && cur.parent_id != null && !out.has(cur.parent_id)) {
    out.add(cur.parent_id);
    cur = byId.get(cur.parent_id);
  }
  return out;
}

export default function FolderTree({ current, onNavigate }: { current: number | null; onNavigate?: () => void }) {
  const folders = useFolders();
  const kids = useMemo(() => childrenMap(folders), [folders]);
  const [open, setOpen] = useState<Set<number>>(new Set());

  useEffect(() => {
    // 当前所在文件夹的上级自动展开
    const a = ancestors(folders, current);
    if (a.size) setOpen((o) => new Set([...o, ...a]));
  }, [folders, current]);

  const toggle = (id: number) =>
    setOpen((o) => {
      const n = new Set(o);
      if (n.has(id)) n.delete(id);
      else n.add(id);
      return n;
    });

  const render = (parent: number | null, depth: number): React.ReactNode =>
    (kids.get(parent) || []).map((f) => {
      const has = (kids.get(f.id) || []).length > 0;
      const isOpen = open.has(f.id);
      return (
        <div key={f.id}>
          <div className={`group flex items-center rounded-lg pr-2 text-sm ${current === f.id ? 'bg-sky-50 font-medium text-sky-700 dark:bg-sky-500/10 dark:text-sky-300' : 'hover:bg-slate-100 dark:hover:bg-slate-800'}`}
            style={{ paddingLeft: depth * 14 + 4 }}>
            <button onClick={() => has && toggle(f.id)} className={`flex h-7 w-6 shrink-0 items-center justify-center text-slate-400 ${has ? '' : 'invisible'}`}
              aria-label={isOpen ? '收起' : '展开'}>
              <IconChevron className={`h-3.5 w-3.5 transition ${isOpen ? 'rotate-90' : ''}`} />
            </button>
            <Link href={`/files/?folder=${f.id}`} onClick={onNavigate} className="flex min-w-0 flex-1 items-center gap-1.5 py-1.5">
              <svg viewBox="0 0 24 24" className="h-4 w-4 shrink-0 text-amber-400" fill="currentColor" aria-hidden="true">
                <path d="M3 7a2 2 0 0 1 2-2h4l2 2h8a2 2 0 0 1 2 2v8a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2z" />
              </svg>
              <span className="truncate">{f.name}</span>
            </Link>
          </div>
          {has && isOpen && render(f.id, depth + 1)}
        </div>
      );
    });

  if (!folders.length) return <p className="px-3 py-2 text-xs text-slate-400">还没有文件夹</p>;
  return <div className="space-y-0.5">{render(null, 0)}</div>;
}
