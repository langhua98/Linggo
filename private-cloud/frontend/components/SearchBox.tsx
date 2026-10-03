'use client';

import { useRouter, useSearchParams } from 'next/navigation';
import { useEffect, useState } from 'react';
import { IconSearch, IconX } from './Icons';

export default function SearchBox() {
  const router = useRouter();
  const params = useSearchParams();
  const q = params.get('q') || '';
  const [value, setValue] = useState(q);
  useEffect(() => setValue(q), [q]);

  const submit = (e: React.FormEvent) => {
    e.preventDefault();
    const v = value.trim();
    router.push(v ? `/files/?q=${encodeURIComponent(v)}` : '/files/');
  };

  return (
    <form onSubmit={submit} className="relative w-full max-w-xl">
      <IconSearch className="pointer-events-none absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-slate-400" />
      <input value={value} onChange={(e) => setValue(e.target.value)} placeholder="搜索文件名、文件夹或 SHA-256"
        className="input rounded-full bg-slate-100 pl-9 pr-9 dark:bg-slate-800" aria-label="搜索" />
      {value && (
        <button type="button" onClick={() => { setValue(''); if (q) router.push('/files/'); }}
          className="absolute right-2 top-1/2 -translate-y-1/2 rounded-full p-1 text-slate-400 hover:text-slate-700" aria-label="清除">
          <IconX className="h-4 w-4" />
        </button>
      )}
    </form>
  );
}
