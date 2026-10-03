'use client';

import Link from 'next/link';
import { useRouter, useSearchParams } from 'next/navigation';
import { Suspense, useCallback, useEffect, useMemo, useRef, useState } from 'react';
import AppShell, { useMe } from '@/components/AppShell';
import FileDetails from '@/components/FileDetails';
import FileList, { keyOf } from '@/components/FileList';
import type { Action, Entry } from '@/components/FileItem';
import FolderPicker from '@/components/FolderPicker';
import { IconChevron, IconPlusFolder, IconRefresh, IconUpload, IconX } from '@/components/Icons';
import { Modal, useDialogs } from '@/components/Modal';
import PreviewModal from '@/components/PreviewModal';
import UploadBox, { type UploadBoxHandle } from '@/components/UploadBox';
import { api, fileUrl } from '@/lib/api';
import { emit } from '@/lib/bus';
import { categoryLabel } from '@/lib/format';
import type { Category, DriveFile, Folder, Listing, SortKey } from '@/lib/types';
import { uploads } from '@/lib/upload';

const TYPES: Category[] = ['video', 'image', 'audio', 'document', 'archive', 'other'];

function loadSort(): { sort: SortKey; order: 'asc' | 'desc' } {
  try {
    const v = JSON.parse(localStorage.getItem('pcd_sort') || '');
    if (v && v.sort && v.order) return v;
  } catch {}
  return { sort: 'name', order: 'asc' };
}

function download(id: number) {
  const a = document.createElement('a');
  a.href = fileUrl(id, 'download');
  a.rel = 'noopener';
  document.body.appendChild(a);
  a.click();
  a.remove();
}

function FilesView() {
  const router = useRouter();
  const params = useSearchParams();
  const folderParam = params.get('folder');
  const folderId = folderParam ? Number(folderParam) : null;
  const q = params.get('q') || '';
  const type = (params.get('type') || '') as Category | '';
  const searching = !!q || !!type;
  const { toast, confirm, prompt } = useDialogs();
  const { reload: reloadMe } = useMe();

  const [sortState, setSortState] = useState<{ sort: SortKey; order: 'asc' | 'desc' }>({ sort: 'name', order: 'asc' });
  useEffect(() => setSortState(loadSort()), []);
  const { sort, order } = sortState;

  const [listing, setListing] = useState<Listing | null>(null);
  const [results, setResults] = useState<{ files: DriveFile[]; folders: Folder[] } | null>(null);
  const [error, setError] = useState('');
  const [loading, setLoading] = useState(true);
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const [preview, setPreview] = useState<DriveFile | null>(null);
  const [details, setDetails] = useState<DriveFile | null>(null);
  const [picker, setPicker] = useState<{ mode: 'move' | 'copy'; entries: Entry[] } | null>(null);
  const lastClicked = useRef<string | null>(null);
  const uploadBox = useRef<UploadBoxHandle>(null);
  const reqId = useRef(0);

  const load = useCallback(async (quiet = false) => {
    const my = ++reqId.current;
    if (!quiet) setLoading(true);
    try {
      if (searching) {
        const r = await api(`/api/search?q=${encodeURIComponent(q)}&type=${type}&sort=${sort}&order=${order}`);
        if (my === reqId.current) setResults(r);
      } else {
        const r = await api<Listing>(`/api/files?${folderId ? `folder_id=${folderId}&` : ''}sort=${sort}&order=${order}`);
        if (my === reqId.current) setListing(r);
      }
      if (my === reqId.current) setError('');
    } catch (e: any) {
      if (my === reqId.current) setError(e.message);
    } finally {
      if (my === reqId.current) setLoading(false);
    }
  }, [searching, q, type, folderId, sort, order]);

  useEffect(() => {
    setSelected(new Set());
    load();
  }, [load]);

  // 上传完成 / 秒传成功 → 刷新列表
  useEffect(() => uploads.onFilesChanged(() => { load(true); reloadMe(); }), [load, reloadMe]);

  const entries: Entry[] = useMemo(() => {
    if (searching) return results ? [...results.folders, ...results.files] : [];
    return listing ? [...listing.folders, ...listing.files] : [];
  }, [searching, results, listing]);
  const files = entries.filter((e): e is DriveFile => e.type === 'file');

  // 有文件正在往 Telegram 传时，每 3 秒刷新一下进度
  const busy = files.some((f) => f.status === 'pending' || f.status === 'uploading');
  useEffect(() => {
    if (!busy) return;
    const t = setInterval(() => load(true), 3000);
    return () => clearInterval(t);
  }, [busy, load]);

  const setSort = (k: SortKey) => {
    const next = { sort: k, order: (sort === k && order === 'asc' ? 'desc' : 'asc') as 'asc' | 'desc' };
    setSortState(next);
    try { localStorage.setItem('pcd_sort', JSON.stringify(next)); } catch {}
  };

  const onFiles = (fs: File[]) => {
    if (searching) return toast('请先进入一个文件夹再上传', 'error');
    uploads.add(fs, folderId);
  };

  const newFolder = async () => {
    const name = await prompt({ title: '新建文件夹', label: '文件夹名称', value: '新建文件夹', okText: '创建' });
    if (!name) return;
    try {
      await api('/api/folders', { method: 'POST', body: { name, parent_id: folderId } });
      emit('folders-changed');
      load(true);
    } catch (e: any) {
      toast(e.message, 'error');
    }
  };

  const run = async (fn: () => Promise<any>, ok?: string) => {
    try {
      await fn();
      if (ok) toast(ok);
    } catch (e: any) {
      toast(e.message, 'error');
    }
    emit('folders-changed');
    load(true);
    reloadMe();
  };

  const action = async (e: Entry, a: Action) => {
    const isFile = e.type === 'file';
    const name = isFile ? (e as DriveFile).filename : (e as Folder).name;
    switch (a) {
      case 'open':
        router.push(`/files/?folder=${e.id}`);
        break;
      case 'preview':
        setPreview(e as DriveFile);
        break;
      case 'download':
        download(e.id);
        break;
      case 'details': {
        const full = await api<DriveFile>(`/api/files/${e.id}`).catch(() => e as DriveFile);
        setDetails(full);
        break;
      }
      case 'rename': {
        const v = await prompt({ title: '重命名', value: name, okText: '保存', selectStem: isFile });
        if (v && v !== name) run(() => api(`/api/${isFile ? 'files' : 'folders'}/${e.id}/rename`, { method: 'POST', body: { name: v } }));
        break;
      }
      case 'move':
      case 'copy':
        setPicker({ mode: a, entries: [e] });
        break;
      case 'delete': {
        const f = e as DriveFile;
        const unfinished = isFile && f.status !== 'completed';
        const ok = await confirm({
          title: unfinished ? '取消上传并删除？' : `删除「${name}」？`,
          message: unfinished ? '这个文件还没存进 Telegram，删除后不会进回收站。' : isFile ? '文件会移到回收站，可以恢复。' : '文件夹和里面的所有内容会移到回收站，可以恢复。',
          okText: '删除',
          danger: true,
        });
        if (ok) run(() => api(`/api/${isFile ? 'files' : 'folders'}/${e.id}`, { method: 'DELETE' }), unfinished ? '已删除' : '已移到回收站');
        break;
      }
    }
  };

  const selectedEntries = entries.filter((e) => selected.has(keyOf(e)));
  const select = (e: Entry, on: boolean, shift: boolean) => {
    const k = keyOf(e);
    const next = new Set(selected);
    if (shift && lastClicked.current) {
      const keys = entries.map(keyOf);
      const [a, b] = [keys.indexOf(lastClicked.current), keys.indexOf(k)].sort((x, y) => x - y);
      if (a >= 0) keys.slice(a, b + 1).forEach((x) => (on ? next.add(x) : next.delete(x)));
    } else if (on) next.add(k);
    else next.delete(k);
    lastClicked.current = k;
    setSelected(next);
  };

  const batch = async (act: 'delete' | 'move' | 'copy', target: number | null = null) => {
    const body = {
      action: act,
      file_ids: selectedEntries.filter((e) => e.type === 'file').map((e) => e.id),
      folder_ids: act === 'copy' ? [] : selectedEntries.filter((e) => e.type === 'folder').map((e) => e.id),
      target_folder_id: target,
    };
    try {
      const r = await api('/api/batch', { method: 'POST', body });
      if (r.errors.length) toast(`${r.done} 项成功，${r.errors.length} 项失败：${r.errors[0].error}`, 'error');
      else toast({ delete: `已移到回收站（${r.done} 项）`, move: `已移动 ${r.done} 项`, copy: `已复制 ${r.done} 个文件` }[act]);
    } catch (e: any) {
      toast(e.message, 'error');
    }
    setSelected(new Set());
    emit('folders-changed');
    load(true);
    reloadMe();
  };

  const pick = async (target: number | null) => {
    if (!picker) return;
    const { mode, entries: es } = picker;
    setPicker(null);
    if (es.length === 1 && !selected.has(keyOf(es[0]))) {
      const e = es[0];
      const kind = e.type === 'file' ? 'files' : 'folders';
      run(() => api(`/api/${kind}/${e.id}/${mode}`, { method: 'POST', body: { target_folder_id: target } }), mode === 'move' ? '已移动' : '已复制');
    } else {
      batch(mode, target);
    }
  };

  const setType = (t: Category | '') => {
    const p = new URLSearchParams();
    if (q) p.set('q', q);
    if (t) p.set('type', t);
    router.push(`/files/?${p.toString()}`);
  };

  const crumbs = listing?.path || [];
  return (
    <UploadBox ref={uploadBox} onFiles={onFiles} disabled={searching}>
      <div className="mx-auto max-w-6xl p-4 sm:p-6">
        <div className="mb-4 flex flex-wrap items-center gap-3">
          <div className="flex min-w-0 flex-1 items-center gap-1 text-lg font-semibold">
            {searching ? (
              <span className="truncate">{q ? `搜索「${q}」` : '按类型筛选'}</span>
            ) : (
              <>
                <Link href="/files/" className={crumbs.length ? 'text-slate-500 hover:text-slate-800 dark:hover:text-slate-200' : ''}>我的云盘</Link>
                {crumbs.map((c, i) => (
                  <span key={c.id} className="flex min-w-0 items-center gap-1">
                    <IconChevron className="h-4 w-4 shrink-0 text-slate-400" />
                    {i === crumbs.length - 1 ? <span className="truncate">{c.name}</span> : (
                      <Link href={`/files/?folder=${c.id}`} className="truncate text-slate-500 hover:text-slate-800 dark:hover:text-slate-200">{c.name}</Link>
                    )}
                  </span>
                ))}
              </>
            )}
          </div>
          {!searching && (
            <div className="flex items-center gap-2">
              <button className="btn-primary" onClick={() => uploadBox.current?.open()}><IconUpload className="h-4 w-4" />上传文件</button>
              <button className="btn" onClick={newFolder}><IconPlusFolder className="h-4 w-4" /><span className="hidden sm:inline">新建文件夹</span></button>
              <button className="btn-icon" onClick={() => load()} aria-label="刷新" title="刷新"><IconRefresh className={`h-4 w-4 ${loading ? 'animate-spin' : ''}`} /></button>
            </div>
          )}
        </div>

        {searching && (
          <div className="mb-4 flex flex-wrap gap-2">
            {(['', ...TYPES] as (Category | '')[]).map((t) => (
              <button key={t || 'all'} onClick={() => setType(t)}
                className={`rounded-full px-3 py-1 text-sm ${type === t ? 'bg-sky-600 text-white' : 'bg-white text-slate-600 ring-1 ring-slate-200 hover:bg-slate-50 dark:bg-slate-900 dark:text-slate-300 dark:ring-slate-700'}`}>
                {t ? categoryLabel[t] : '全部类型'}
              </button>
            ))}
          </div>
        )}

        {selected.size > 0 && (
          <div className="sticky top-0 z-20 mb-3 flex flex-wrap items-center gap-2 rounded-xl bg-sky-600 px-4 py-2 text-sm text-white shadow-lg">
            <span className="mr-auto">已选 {selected.size} 项</span>
            <button className="rounded-lg px-2 py-1 hover:bg-white/15" onClick={() => setPicker({ mode: 'move', entries: selectedEntries })}>移动</button>
            <button className="rounded-lg px-2 py-1 hover:bg-white/15 disabled:opacity-50" disabled={!selectedEntries.some((e) => e.type === 'file')}
              onClick={() => setPicker({ mode: 'copy', entries: selectedEntries })}>复制</button>
            <button className="rounded-lg px-2 py-1 hover:bg-white/15"
              onClick={async () => (await confirm({ title: `删除选中的 ${selected.size} 项？`, message: '会移到回收站，可以恢复。', okText: '删除', danger: true })) && batch('delete')}>删除</button>
            <button className="rounded-lg p-1 hover:bg-white/15" onClick={() => setSelected(new Set())} aria-label="取消选择"><IconX className="h-4 w-4" /></button>
          </div>
        )}

        {error && <div className="mb-4 rounded-xl bg-rose-50 p-3 text-sm text-rose-700 dark:bg-rose-500/10 dark:text-rose-300">{error}</div>}

        <div className="card overflow-visible">
          {loading && !entries.length ? (
            <div className="p-12 text-center text-sm text-slate-400">加载中…</div>
          ) : (
            <FileList entries={entries} selected={selected} onSelect={select}
              onSelectAll={(on) => setSelected(on ? new Set(entries.map(keyOf)) : new Set())}
              onAction={action} sort={sort} order={order} onSort={setSort} showPath={searching}
              empty={
                searching ? (
                  <div className="p-12 text-center text-sm text-slate-400">没有找到匹配的文件</div>
                ) : (
                  <button onClick={() => uploadBox.current?.open()} className="flex w-full flex-col items-center gap-3 p-16 text-slate-400 hover:text-sky-600">
                    <IconUpload className="h-10 w-10" />
                    <span className="text-sm">这里还是空的。点击选择文件，或者直接把文件拖进来</span>
                  </button>
                )
              } />
          )}
        </div>
      </div>

      <PreviewModal file={preview} siblings={files} onClose={() => setPreview(null)} onChange={setPreview} />
      <Modal open={!!details} onClose={() => setDetails(null)} title="详细信息">{details && <FileDetails file={details} />}</Modal>
      {picker && (
        <FolderPicker open title={picker.mode === 'move' ? '移动到' : '复制到'} okText={picker.mode === 'move' ? '移动到这里' : '复制到这里'}
          exclude={picker.mode === 'move' ? picker.entries.filter((e) => e.type === 'folder').map((e) => e.id) : []}
          onClose={() => setPicker(null)} onPick={pick} />
      )}
    </UploadBox>
  );
}

export default function FilesPage() {
  return (
    <AppShell>
      <Suspense fallback={null}>
        <FilesView />
      </Suspense>
    </AppShell>
  );
}
