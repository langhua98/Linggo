import type { Category } from '@/lib/types';

type P = { className?: string };
const base = (d: React.ReactNode, className = 'w-5 h-5') => (
  <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={1.8} strokeLinecap="round"
    strokeLinejoin="round" className={className} aria-hidden="true">{d}</svg>
);

export const IconFolder = ({ className }: P) => base(<path d="M3 7a2 2 0 0 1 2-2h4l2 2h8a2 2 0 0 1 2 2v8a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2z" />, className);
export const IconUpload = ({ className }: P) => base(<><path d="M12 16V4" /><path d="m6 10 6-6 6 6" /><path d="M4 20h16" /></>, className);
export const IconPlusFolder = ({ className }: P) => base(<><path d="M3 7a2 2 0 0 1 2-2h4l2 2h8a2 2 0 0 1 2 2v8a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2z" /><path d="M12 10v6M9 13h6" /></>, className);
export const IconRefresh = ({ className }: P) => base(<><path d="M20 11a8 8 0 0 0-14.9-3.9L4 8" /><path d="M4 4v4h4" /><path d="M4 13a8 8 0 0 0 14.9 3.9L20 16" /><path d="M20 20v-4h-4" /></>, className);
export const IconSearch = ({ className }: P) => base(<><circle cx="11" cy="11" r="7" /><path d="m20 20-3.5-3.5" /></>, className);
export const IconTrash = ({ className }: P) => base(<><path d="M4 7h16" /><path d="M10 11v6M14 11v6" /><path d="M6 7l1 12a2 2 0 0 0 2 2h6a2 2 0 0 0 2-2l1-12" /><path d="M9 7V4h6v3" /></>, className);
export const IconCloud = ({ className }: P) => base(<path d="M7 18a5 5 0 1 1 .9-9.9A6 6 0 0 1 19 10a4 4 0 0 1-1 8z" />, className);
export const IconSettings = ({ className }: P) => base(<><circle cx="12" cy="12" r="3" /><path d="M19.4 15a1.7 1.7 0 0 0 .3 1.8l.1.1a2 2 0 1 1-2.8 2.8l-.1-.1a1.7 1.7 0 0 0-1.8-.3 1.7 1.7 0 0 0-1 1.5V21a2 2 0 1 1-4 0v-.1a1.7 1.7 0 0 0-1.1-1.5 1.7 1.7 0 0 0-1.8.3l-.1.1a2 2 0 1 1-2.8-2.8l.1-.1a1.7 1.7 0 0 0 .3-1.8 1.7 1.7 0 0 0-1.5-1H3a2 2 0 1 1 0-4h.1a1.7 1.7 0 0 0 1.5-1.1 1.7 1.7 0 0 0-.3-1.8l-.1-.1a2 2 0 1 1 2.8-2.8l.1.1a1.7 1.7 0 0 0 1.8.3H9a1.7 1.7 0 0 0 1-1.5V3a2 2 0 1 1 4 0v.1a1.7 1.7 0 0 0 1 1.5 1.7 1.7 0 0 0 1.8-.3l.1-.1a2 2 0 1 1 2.8 2.8l-.1.1a1.7 1.7 0 0 0-.3 1.8V9a1.7 1.7 0 0 0 1.5 1H21a2 2 0 1 1 0 4h-.1a1.7 1.7 0 0 0-1.5 1z" /></>, className);
export const IconTasks = ({ className }: P) => base(<><path d="M9 6h11M9 12h11M9 18h11" /><path d="m3 6 1 1 2-2M3 12l1 1 2-2M3 18l1 1 2-2" /></>, className);
export const IconDots = ({ className }: P) => base(<><circle cx="12" cy="5" r="1" /><circle cx="12" cy="12" r="1" /><circle cx="12" cy="19" r="1" /></>, className);
export const IconX = ({ className }: P) => base(<path d="M6 6l12 12M18 6 6 18" />, className);
export const IconChevron = ({ className }: P) => base(<path d="m9 6 6 6-6 6" />, className);
export const IconDownload = ({ className }: P) => base(<><path d="M12 4v12" /><path d="m6 10 6 6 6-6" /><path d="M4 20h16" /></>, className);
export const IconUser = ({ className }: P) => base(<><circle cx="12" cy="8" r="4" /><path d="M4 21a8 8 0 0 1 16 0" /></>, className);
export const IconMenu = ({ className }: P) => base(<path d="M4 6h16M4 12h16M4 18h16" />, className);
export const IconRestore = ({ className }: P) => base(<><path d="M3 12a9 9 0 1 0 3-6.7L3 8" /><path d="M3 3v5h5" /></>, className);
export const IconArrowUp = ({ className }: P) => base(<path d="m6 15 6-6 6 6" />, className);
export const IconArrowDown = ({ className }: P) => base(<path d="m6 9 6 6 6-6" />, className);

const typeColor: Record<Category, string> = {
  video: 'text-rose-500 bg-rose-50 dark:bg-rose-500/10',
  image: 'text-emerald-500 bg-emerald-50 dark:bg-emerald-500/10',
  audio: 'text-violet-500 bg-violet-50 dark:bg-violet-500/10',
  document: 'text-sky-500 bg-sky-50 dark:bg-sky-500/10',
  archive: 'text-amber-500 bg-amber-50 dark:bg-amber-500/10',
  other: 'text-slate-500 bg-slate-100 dark:bg-slate-500/10',
};

const typePath: Record<Category, React.ReactNode> = {
  video: <><rect x="3" y="6" width="13" height="12" rx="2" /><path d="m16 10 5-3v10l-5-3" /></>,
  image: <><rect x="3" y="4" width="18" height="16" rx="2" /><circle cx="9" cy="10" r="2" /><path d="m21 16-5-5-9 9" /></>,
  audio: <><path d="M9 18V5l11-2v13" /><circle cx="6" cy="18" r="3" /><circle cx="17" cy="16" r="3" /></>,
  document: <><path d="M14 3H7a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h10a2 2 0 0 0 2-2V8z" /><path d="M14 3v5h5M9 13h6M9 17h6" /></>,
  archive: <><path d="M14 3H7a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h10a2 2 0 0 0 2-2V8z" /><path d="M14 3v5h5M11 6h1M11 9h1M11 12h1M10 15h3v3h-3z" /></>,
  other: <><path d="M14 3H7a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h10a2 2 0 0 0 2-2V8z" /><path d="M14 3v5h5" /></>,
};

export function FileTypeIcon({ category, size = 'md' }: { category: Category; size?: 'md' | 'lg' }) {
  const box = size === 'lg' ? 'w-16 h-16 rounded-2xl' : 'w-9 h-9 rounded-lg';
  const icon = size === 'lg' ? 'w-8 h-8' : 'w-5 h-5';
  return (
    <span className={`inline-flex shrink-0 items-center justify-center ${box} ${typeColor[category]}`}>
      {base(typePath[category], icon)}
    </span>
  );
}

export function FolderIcon({ size = 'md' }: { size?: 'md' | 'lg' }) {
  const box = size === 'lg' ? 'w-16 h-16 rounded-2xl' : 'w-9 h-9 rounded-lg';
  return (
    <span className={`inline-flex shrink-0 items-center justify-center ${box} bg-amber-50 text-amber-500 dark:bg-amber-500/10`}>
      <svg viewBox="0 0 24 24" className={size === 'lg' ? 'w-8 h-8' : 'w-5 h-5'} fill="currentColor" aria-hidden="true">
        <path d="M3 7a2 2 0 0 1 2-2h4l2 2h8a2 2 0 0 1 2 2v8a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2z" />
      </svg>
    </span>
  );
}
