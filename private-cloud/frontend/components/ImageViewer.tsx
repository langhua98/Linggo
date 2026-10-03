'use client';

import { useEffect, useState } from 'react';
import { fileUrl } from '@/lib/api';
import type { DriveFile } from '@/lib/types';
import { IconChevron } from './Icons';

export default function ImageViewer({ file, list, onChange }: { file: DriveFile; list: DriveFile[]; onChange: (f: DriveFile) => void }) {
  const [zoom, setZoom] = useState(false);
  const [loaded, setLoaded] = useState(false);
  const idx = list.findIndex((f) => f.id === file.id);
  const prev = idx > 0 ? list[idx - 1] : null;
  const next = idx >= 0 && idx < list.length - 1 ? list[idx + 1] : null;

  useEffect(() => {
    setLoaded(false);
    setZoom(false);
  }, [file.id]);
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'ArrowLeft' && prev) onChange(prev);
      if (e.key === 'ArrowRight' && next) onChange(next);
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [prev, next, onChange]);

  return (
    <div className={`relative flex min-h-64 items-center justify-center bg-black/95 ${zoom ? 'overflow-auto' : ''}`} style={{ height: '78vh' }}>
      {!loaded && <div className="absolute text-sm text-slate-400">加载中…</div>}
      {/* eslint-disable-next-line @next/next/no-img-element */}
      <img src={fileUrl(file.id, 'stream')} alt={file.filename} onLoad={() => setLoaded(true)} onClick={() => setZoom(!zoom)}
        className={zoom ? 'max-w-none cursor-zoom-out' : 'max-h-full max-w-full cursor-zoom-in object-contain'} />
      {prev && (
        <button onClick={() => onChange(prev)} className="absolute left-3 top-1/2 -translate-y-1/2 rounded-full bg-white/10 p-2 text-white hover:bg-white/20" aria-label="上一张">
          <IconChevron className="h-6 w-6 rotate-180" />
        </button>
      )}
      {next && (
        <button onClick={() => onChange(next)} className="absolute right-3 top-1/2 -translate-y-1/2 rounded-full bg-white/10 p-2 text-white hover:bg-white/20" aria-label="下一张">
          <IconChevron className="h-6 w-6" />
        </button>
      )}
      {list.length > 1 && idx >= 0 && <div className="absolute bottom-3 rounded-full bg-black/60 px-3 py-1 text-xs text-white">{idx + 1} / {list.length}</div>}
    </div>
  );
}
