'use client';

import { useEffect, useState } from 'react';
import { fileUrl } from '@/lib/api';
import { formatSize, previewKind } from '@/lib/format';
import type { DriveFile } from '@/lib/types';
import FileDetails from './FileDetails';
import { FileTypeIcon, IconDownload, IconX } from './Icons';
import ImageViewer from './ImageViewer';
import { Modal } from './Modal';
import VideoPlayer from './VideoPlayer';

function TextPreview({ file }: { file: DriveFile }) {
  const [text, setText] = useState<string | null>(null);
  useEffect(() => {
    // 只取前 256 KB
    fetch(fileUrl(file.id, 'stream'), { headers: { Range: 'bytes=0-262143' }, credentials: 'same-origin' })
      .then((r) => r.text()).then(setText).catch(() => setText('读取失败'));
  }, [file.id]);
  return <pre className="max-h-[75vh] overflow-auto whitespace-pre-wrap break-words bg-slate-50 p-5 text-sm dark:bg-slate-950">{text ?? '加载中…'}</pre>;
}

export default function PreviewModal({ file, siblings, onClose, onChange }: {
  file: DriveFile | null;
  siblings: DriveFile[];
  onClose: () => void;
  onChange: (f: DriveFile) => void;
}) {
  if (!file) return null;
  const kind = file.status === 'completed' || file.status === 'pending' || file.status === 'uploading' ? previewKind(file.mime_type) : null;
  const images = siblings.filter((f) => previewKind(f.mime_type) === 'image');
  return (
    <Modal open onClose={onClose} wide bare>
      <div className="flex items-center gap-3 border-b border-slate-100 px-4 py-2.5 dark:border-slate-800">
        <div className="min-w-0 flex-1">
          <div className="truncate text-sm font-semibold">{file.filename}</div>
          <div className="text-xs text-slate-500">{formatSize(file.file_size)} · {file.mime_type}</div>
        </div>
        <a className="btn" href={fileUrl(file.id, 'download')}><IconDownload className="h-4 w-4" />下载</a>
        <button onClick={onClose} className="btn-icon" aria-label="关闭"><IconX /></button>
      </div>
      <div className="overflow-auto">
        {kind === 'video' && <VideoPlayer file={file} />}
        {kind === 'image' && <ImageViewer file={file} list={images} onChange={onChange} />}
        {kind === 'audio' && (
          <div className="flex flex-col items-center gap-6 p-10">
            <FileTypeIcon category="audio" size="lg" />
            <audio src={fileUrl(file.id, 'stream')} controls autoPlay className="w-full max-w-lg" />
          </div>
        )}
        {kind === 'pdf' && <iframe src={fileUrl(file.id, 'stream')} title={file.filename} className="h-[78vh] w-full bg-white" />}
        {kind === 'text' && <TextPreview file={file} />}
        {!kind && (
          <div className="grid gap-6 p-6 sm:grid-cols-[auto_1fr]">
            <div className="flex flex-col items-center gap-3">
              <FileTypeIcon category={file.category} size="lg" />
              <span className="text-xs text-slate-500">此类型不支持在线预览</span>
            </div>
            <FileDetails file={file} />
          </div>
        )}
      </div>
    </Modal>
  );
}
