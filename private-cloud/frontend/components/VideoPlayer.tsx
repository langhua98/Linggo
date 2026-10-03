'use client';

import { useState } from 'react';
import { fileUrl } from '@/lib/api';
import type { DriveFile } from '@/lib/types';

/** 视频走 /api/files/:id/stream，后端支持 Range，拖进度条只取需要的那一段 */
export default function VideoPlayer({ file }: { file: DriveFile }) {
  const [error, setError] = useState(false);
  if (error)
    return (
      <div className="flex h-64 flex-col items-center justify-center gap-3 text-sm text-slate-300">
        浏览器无法播放这个视频格式（{file.mime_type}）
        <a className="btn-primary" href={fileUrl(file.id, 'download')}>下载到本地播放</a>
      </div>
    );
  return (
    <video key={file.id} src={fileUrl(file.id, 'stream')} controls autoPlay playsInline preload="metadata"
      onError={() => setError(true)} className="max-h-[80vh] w-full bg-black" />
  );
}
