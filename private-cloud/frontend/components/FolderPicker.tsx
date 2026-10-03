'use client';

import { useMemo, useState } from 'react';
import { childrenMap, useFolders } from './FolderTree';
import { IconChevron } from './Icons';
import { Modal } from './Modal';

/** 移动 / 复制时选目标文件夹。exclude：不能选的文件夹（移动文件夹时，它自己和它的子文件夹） */
export default function FolderPicker({ open, title, okText, exclude = [], onClose, onPick }: {
  open: boolean;
  title: string;
  okText: string;
  exclude?: number[];
  onClose: () => void;
  onPick: (folderId: number | null) => void;
}) {
  const folders = useFolders();
  const kids = useMemo(() => childrenMap(folders), [folders]);
  const [sel, setSel] = useState<number | null>(null);
  const [expanded, setExpanded] = useState<Set<number>>(new Set());
  const blocked = useMemo(() => {
    const out = new Set<number>();
    const stack = [...exclude];
    while (stack.length) {
      const id = stack.pop()!;
      out.add(id);
      for (const c of kids.get(id) || []) stack.push(c.id);
    }
    return out;
  }, [exclude, kids]);

  const render = (parent: number | null, depth: number): React.ReactNode =>
    (kids.get(parent) || []).filter((f) => !blocked.has(f.id)).map((f) => {
      const has = (kids.get(f.id) || []).some((c) => !blocked.has(c.id));
      const isOpen = expanded.has(f.id);
      return (
        <div key={f.id}>
          <div className={`flex items-center rounded-lg text-sm ${sel === f.id ? 'bg-sky-100 text-sky-800 dark:bg-sky-500/20 dark:text-sky-200' : 'hover:bg-slate-100 dark:hover:bg-slate-800'}`}
            style={{ paddingLeft: depth * 16 + 4 }}>
            <button className={`flex h-8 w-6 items-center justify-center text-slate-400 ${has ? '' : 'invisible'}`}
              onClick={() => setExpanded((s) => { const n = new Set(s); if (n.has(f.id)) n.delete(f.id); else n.add(f.id); return n; })}>
              <IconChevron className={`h-3.5 w-3.5 transition ${isOpen ? 'rotate-90' : ''}`} />
            </button>
            <button className="flex-1 truncate py-1.5 text-left" onClick={() => setSel(f.id)} onDoubleClick={() => onPick(f.id)}>📁 {f.name}</button>
          </div>
          {has && isOpen && render(f.id, depth + 1)}
        </div>
      );
    });

  return (
    <Modal open={open} onClose={onClose} title={title}>
      <div className="max-h-80 overflow-y-auto rounded-xl border border-slate-200 p-1 dark:border-slate-700">
        <button className={`w-full rounded-lg px-3 py-1.5 text-left text-sm ${sel === null ? 'bg-sky-100 text-sky-800 dark:bg-sky-500/20 dark:text-sky-200' : 'hover:bg-slate-100 dark:hover:bg-slate-800'}`}
          onClick={() => setSel(null)}>☁️ 我的云盘（根目录）</button>
        {render(null, 0)}
      </div>
      <div className="mt-5 flex justify-end gap-2">
        <button className="btn" onClick={onClose}>取消</button>
        <button className="btn-primary" onClick={() => onPick(sel)}>{okText}</button>
      </div>
    </Modal>
  );
}
