'use client';

import { createContext, useCallback, useContext, useEffect, useRef, useState } from 'react';
import { IconX } from './Icons';

export function Modal({ open, onClose, title, children, wide, bare }: {
  open: boolean;
  onClose: () => void;
  title?: React.ReactNode;
  children: React.ReactNode;
  wide?: boolean;
  bare?: boolean;
}) {
  useEffect(() => {
    if (!open) return;
    const onKey = (e: KeyboardEvent) => e.key === 'Escape' && onClose();
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [open, onClose]);
  if (!open) return null;
  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/50 p-4 backdrop-blur-sm"
      onMouseDown={(e) => e.target === e.currentTarget && onClose()}>
      <div role="dialog" aria-modal="true"
        className={`flex max-h-[92vh] w-full flex-col overflow-hidden rounded-2xl bg-white shadow-2xl dark:bg-slate-900 ${wide ? 'max-w-5xl' : 'max-w-md'}`}>
        {!bare && (
          <div className="flex items-center justify-between border-b border-slate-100 px-5 py-3 dark:border-slate-800">
            <h2 className="truncate text-base font-semibold">{title}</h2>
            <button onClick={onClose} className="btn-icon" aria-label="关闭"><IconX /></button>
          </div>
        )}
        <div className={bare ? 'min-h-0 flex-1' : 'min-h-0 flex-1 overflow-auto p-5'}>{children}</div>
      </div>
    </div>
  );
}

type ConfirmOpts = { title: string; message?: React.ReactNode; okText?: string; danger?: boolean };
type PromptOpts = { title: string; label?: string; value?: string; okText?: string; selectStem?: boolean };
type Toast = { id: number; text: string; kind: 'info' | 'error' };

interface Dialogs {
  confirm: (o: ConfirmOpts) => Promise<boolean>;
  prompt: (o: PromptOpts) => Promise<string | null>;
  toast: (text: string, kind?: 'info' | 'error') => void;
}

const Ctx = createContext<Dialogs | null>(null);
export const useDialogs = () => useContext(Ctx)!;

export function DialogProvider({ children }: { children: React.ReactNode }) {
  const [confirmState, setConfirm] = useState<(ConfirmOpts & { resolve: (v: boolean) => void }) | null>(null);
  const [promptState, setPrompt] = useState<(PromptOpts & { resolve: (v: string | null) => void }) | null>(null);
  const [toasts, setToasts] = useState<Toast[]>([]);
  const [value, setValue] = useState('');
  const inputRef = useRef<HTMLInputElement>(null);

  const confirm = useCallback((o: ConfirmOpts) => new Promise<boolean>((resolve) => setConfirm({ ...o, resolve })), []);
  const prompt = useCallback((o: PromptOpts) => new Promise<string | null>((resolve) => {
    setValue(o.value || '');
    setPrompt({ ...o, resolve });
  }), []);
  const toast = useCallback((text: string, kind: 'info' | 'error' = 'info') => {
    const id = Date.now() + Math.random();
    setToasts((t) => [...t, { id, text, kind }]);
    setTimeout(() => setToasts((t) => t.filter((x) => x.id !== id)), kind === 'error' ? 6000 : 3000);
  }, []);

  useEffect(() => {
    if (!promptState) return;
    const el = inputRef.current;
    if (!el) return;
    el.focus();
    const v = promptState.value || '';
    const dot = v.lastIndexOf('.');
    if (promptState.selectStem && dot > 0) el.setSelectionRange(0, dot);
    else el.select();
  }, [promptState]);

  const closeConfirm = (v: boolean) => {
    confirmState?.resolve(v);
    setConfirm(null);
  };
  const closePrompt = (v: string | null) => {
    promptState?.resolve(v);
    setPrompt(null);
  };

  return (
    <Ctx.Provider value={{ confirm, prompt, toast }}>
      {children}
      <Modal open={!!confirmState} onClose={() => closeConfirm(false)} title={confirmState?.title}>
        {confirmState?.message && <div className="mb-5 text-sm text-slate-600 dark:text-slate-300">{confirmState.message}</div>}
        <div className="flex justify-end gap-2">
          <button className="btn" onClick={() => closeConfirm(false)}>取消</button>
          <button autoFocus className={confirmState?.danger ? 'btn-danger' : 'btn-primary'} onClick={() => closeConfirm(true)}>
            {confirmState?.okText || '确定'}
          </button>
        </div>
      </Modal>
      <Modal open={!!promptState} onClose={() => closePrompt(null)} title={promptState?.title}>
        <form onSubmit={(e) => { e.preventDefault(); if (value.trim()) closePrompt(value.trim()); }}>
          {promptState?.label && <label className="mb-1 block text-sm text-slate-500">{promptState.label}</label>}
          <input ref={inputRef} className="input" value={value} onChange={(e) => setValue(e.target.value)} maxLength={255} />
          <div className="mt-5 flex justify-end gap-2">
            <button type="button" className="btn" onClick={() => closePrompt(null)}>取消</button>
            <button type="submit" className="btn-primary" disabled={!value.trim()}>{promptState?.okText || '确定'}</button>
          </div>
        </form>
      </Modal>
      <div className="pointer-events-none fixed left-1/2 top-4 z-[60] flex -translate-x-1/2 flex-col items-center gap-2">
        {toasts.map((t) => (
          <div key={t.id} role="status"
            className={`pointer-events-auto max-w-[90vw] rounded-xl px-4 py-2 text-sm shadow-lg ${t.kind === 'error' ? 'bg-rose-600 text-white' : 'bg-slate-900 text-white dark:bg-white dark:text-slate-900'}`}>
            {t.text}
          </div>
        ))}
      </div>
    </Ctx.Provider>
  );
}
