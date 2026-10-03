'use client';

import { forwardRef, useImperativeHandle, useRef, useState } from 'react';
import { IconUpload } from './Icons';

export interface UploadBoxHandle {
  open: () => void;
}

/** 包住文件列表区域：可以直接把文件拖进来；也提供 open() 给「上传」按钮调出文件选择框 */
const UploadBox = forwardRef<UploadBoxHandle, { onFiles: (files: File[]) => void; children: React.ReactNode; disabled?: boolean }>(
  function UploadBox({ onFiles, children, disabled }, ref) {
    const input = useRef<HTMLInputElement>(null);
    const [over, setOver] = useState(false);
    const depth = useRef(0);
    useImperativeHandle(ref, () => ({ open: () => input.current?.click() }));

    const hasFiles = (e: React.DragEvent) => Array.from(e.dataTransfer.types).includes('Files');
    return (
      <div className="relative min-h-full"
        onDragEnter={(e) => { if (disabled || !hasFiles(e)) return; e.preventDefault(); depth.current++; setOver(true); }}
        onDragOver={(e) => { if (!disabled && hasFiles(e)) e.preventDefault(); }}
        onDragLeave={() => { if (--depth.current <= 0) { depth.current = 0; setOver(false); } }}
        onDrop={(e) => {
          if (disabled || !hasFiles(e)) return;
          e.preventDefault();
          depth.current = 0;
          setOver(false);
          // 只收文件，拖进来的文件夹（没有 type、大小为 0 的项）跳过
          const files = Array.from(e.dataTransfer.files).filter((f) => f.type || f.size > 0);
          if (files.length) onFiles(files);
        }}>
        <input ref={input} type="file" multiple hidden
          onChange={(e) => { const fs = Array.from(e.target.files || []); e.target.value = ''; if (fs.length) onFiles(fs); }} />
        {children}
        {over && (
          <div className="pointer-events-none absolute inset-2 z-30 flex flex-col items-center justify-center gap-3 rounded-2xl border-2 border-dashed border-sky-500 bg-sky-50/90 text-sky-700 dark:bg-sky-950/90 dark:text-sky-300">
            <IconUpload className="h-10 w-10" />
            <div className="text-lg font-medium">松开即可上传到当前文件夹</div>
          </div>
        )}
      </div>
    );
  },
);

export default UploadBox;
