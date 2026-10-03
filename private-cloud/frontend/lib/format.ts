import type { Category } from './types';

export function formatSize(n: number | null | undefined) {
  if (n == null) return '-';
  if (n < 1024) return `${n} B`;
  const units = ['KB', 'MB', 'GB', 'TB'];
  let v = n / 1024;
  let i = 0;
  while (v >= 1024 && i < units.length - 1) {
    v /= 1024;
    i++;
  }
  return `${v >= 100 ? v.toFixed(0) : v.toFixed(1)} ${units[i]}`;
}

export function formatDate(iso: string | null | undefined) {
  if (!iso) return '-';
  const d = new Date(iso);
  const now = new Date();
  const pad = (x: number) => String(x).padStart(2, '0');
  const hm = `${pad(d.getHours())}:${pad(d.getMinutes())}`;
  if (d.toDateString() === now.toDateString()) return `今天 ${hm}`;
  const y = new Date(now);
  y.setDate(now.getDate() - 1);
  if (d.toDateString() === y.toDateString()) return `昨天 ${hm}`;
  const date = `${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
  return d.getFullYear() === now.getFullYear() ? `${date} ${hm}` : `${d.getFullYear()}-${date}`;
}

export function formatDateFull(iso: string | null | undefined) {
  if (!iso) return '-';
  return new Date(iso).toLocaleString('zh-CN', { hour12: false });
}

export const categoryLabel: Record<Category, string> = {
  video: '视频',
  image: '图片',
  audio: '音频',
  document: '文档',
  archive: '压缩包',
  other: '其他',
};

export function extOf(name: string) {
  const i = name.lastIndexOf('.');
  return i > 0 ? name.slice(i + 1).toUpperCase() : '';
}

/** 浏览器能直接播放 / 显示的类型 */
export function previewKind(mime: string): 'video' | 'audio' | 'image' | 'pdf' | 'text' | null {
  const m = (mime || '').toLowerCase();
  if (['video/mp4', 'video/webm', 'video/ogg', 'video/quicktime'].includes(m)) return 'video';
  if (m.startsWith('audio/')) return 'audio';
  if (['image/jpeg', 'image/png', 'image/gif', 'image/webp', 'image/avif', 'image/bmp'].includes(m)) return 'image';
  if (m === 'application/pdf') return 'pdf';
  if (m === 'text/plain') return 'text';
  return null;
}
