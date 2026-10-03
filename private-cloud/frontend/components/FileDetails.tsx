'use client';

import { categoryLabel, formatDateFull, formatSize } from '@/lib/format';
import type { DriveFile } from '@/lib/types';

const statusText: Record<string, string> = { pending: '等待上传', uploading: '上传中', completed: '已完成', failed: '上传失败' };

export default function FileDetails({ file }: { file: DriveFile }) {
  const rows: [string, React.ReactNode][] = [
    ['文件名', file.filename],
    ['原始文件名', file.original_filename],
    ['位置', file.path || '/'],
    ['大小', `${formatSize(file.file_size)}（${file.file_size.toLocaleString()} 字节）`],
    ['类型', `${categoryLabel[file.category]} · ${file.mime_type}`],
    ['状态', statusText[file.status] + (file.status === 'uploading' ? ` ${file.upload_progress}%` : '')],
    ['SHA-256', <code key="sha" className="break-all text-xs">{file.sha256}</code>],
    ['上传时间', formatDateFull(file.created_at)],
    ['修改时间', formatDateFull(file.updated_at)],
    ['Telegram 频道', file.telegram_chat_id ?? '-'],
    ['Telegram 消息', file.telegram_message_id ?? '-'],
    ['Telegram File ID', file.telegram_file_id ? <code key="fid" className="break-all text-xs">{file.telegram_file_id}</code> : '-'],
  ];
  return (
    <dl className="grid grid-cols-[6.5rem_1fr] gap-x-3 gap-y-2 text-sm">
      {rows.map(([k, v]) => (
        <div key={k} className="contents">
          <dt className="text-slate-500">{k}</dt>
          <dd className="min-w-0 break-words">{v}</dd>
        </div>
      ))}
    </dl>
  );
}
