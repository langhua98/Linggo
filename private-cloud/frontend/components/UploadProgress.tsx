'use client';

import { useState, useSyncExternalStore } from 'react';
import { formatSize } from '@/lib/format';
import { uploads, type UploadItem } from '@/lib/upload';
import { IconArrowDown, IconArrowUp, IconX } from './Icons';

const label: Record<UploadItem['phase'], string> = {
  queued: '排队中',
  hashing: '计算 SHA-256',
  checking: '查重中',
  waiting: '等待上传',
  uploading: '上传到服务器',
  processing: '存入 Telegram',
  done: '上传完成',
  duplicate: '文件已经存在',
  failed: '上传失败',
  cancelled: '已取消',
};

function pct(it: UploadItem) {
  switch (it.phase) {
    case 'hashing': return it.hashPct;
    case 'uploading': return it.sendPct;
    case 'processing': return it.tgPct;
    case 'done': return 100;
    default: return 0;
  }
}

function Row({ it }: { it: UploadItem }) {
  const p = pct(it);
  const active = ['queued', 'hashing', 'checking', 'waiting', 'uploading', 'processing'].includes(it.phase);
  const color = it.phase === 'failed' ? 'bg-rose-500' : it.phase === 'done' ? 'bg-emerald-500' : it.phase === 'processing' ? 'bg-violet-500' : 'bg-sky-500';
  return (
    <li className="px-4 py-3">
      <div className="flex items-center gap-2">
        <div className="min-w-0 flex-1">
          <div className="truncate text-sm font-medium" title={it.name}>{it.name}</div>
          <div className={`text-xs ${it.phase === 'failed' ? 'text-rose-600' : 'text-slate-500'}`}>
            {formatSize(it.size)} · {it.linked ? '秒传完成（已有相同文件）' : label[it.phase]}
            {active && it.phase !== 'queued' && it.phase !== 'checking' && it.phase !== 'waiting' ? ` ${p}%` : ''}
          </div>
        </div>
        {active && <button className="text-xs text-slate-500 hover:text-rose-600" onClick={() => uploads.cancel(it.id)}>取消</button>}
        {it.phase === 'failed' && <button className="text-xs text-sky-600 hover:underline" onClick={() => uploads.retry(it.id)}>重新上传</button>}
        {!active && <button className="btn-icon h-6 w-6" onClick={() => uploads.dismiss(it.id)} aria-label="移除"><IconX className="h-3.5 w-3.5" /></button>}
      </div>
      {active && (
        <div className="mt-2 h-1.5 overflow-hidden rounded-full bg-slate-100 dark:bg-slate-800">
          <div className={`h-full rounded-full transition-all ${color}`} style={{ width: `${Math.max(p, 2)}%` }} />
        </div>
      )}
      {it.error && <div className="mt-1 break-all text-xs text-rose-600">{it.error}</div>}
      {it.phase === 'duplicate' && it.duplicate && (
        <div className="mt-2 rounded-lg bg-amber-50 p-2 text-xs text-amber-800 dark:bg-amber-500/10 dark:text-amber-300">
          {it.duplicate.in_trash ? '回收站里有相同内容的文件：' : '相同内容的文件已在：'}
          <span className="font-medium">{(it.duplicate.file.path || '/') + ' ' + it.duplicate.file.filename}</span>，不再重复上传。
          {!it.duplicate.in_trash && (
            <button className="ml-1 text-sky-600 hover:underline" onClick={() => uploads.linkDuplicate(it.id)}>仍在当前文件夹放一份（秒传）</button>
          )}
        </div>
      )}
    </li>
  );
}

export default function UploadProgress() {
  const items = useSyncExternalStore(uploads.subscribe, uploads.getSnapshot, uploads.getServerSnapshot);
  const [collapsed, setCollapsed] = useState(false);
  if (!items.length) return null;
  const active = items.filter((it) => !['done', 'duplicate', 'failed', 'cancelled'].includes(it.phase)).length;
  const failed = items.filter((it) => it.phase === 'failed').length;
  return (
    <div className="fixed bottom-4 right-4 z-40 w-[calc(100vw-2rem)] max-w-sm overflow-hidden rounded-2xl border border-slate-200 bg-white shadow-2xl dark:border-slate-700 dark:bg-slate-900">
      <div className="flex items-center gap-2 border-b border-slate-100 px-4 py-2.5 dark:border-slate-800">
        <div className="flex-1 text-sm font-semibold">
          {active ? `正在上传 ${active} 个文件` : failed ? `${failed} 个文件上传失败` : '上传完成'}
        </div>
        {!active && <button className="text-xs text-slate-500 hover:text-slate-800" onClick={() => uploads.clearFinished()}>清除</button>}
        <button className="btn-icon h-7 w-7" onClick={() => setCollapsed(!collapsed)} aria-label={collapsed ? '展开' : '收起'}>
          {collapsed ? <IconArrowUp className="h-4 w-4" /> : <IconArrowDown className="h-4 w-4" />}
        </button>
      </div>
      {!collapsed && <ul className="max-h-80 divide-y divide-slate-100 overflow-y-auto dark:divide-slate-800">{[...items].reverse().map((it) => <Row key={it.id} it={it} />)}</ul>}
    </div>
  );
}
