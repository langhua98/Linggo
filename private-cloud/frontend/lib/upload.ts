'use client';

// 上传管理：算 SHA-256 → 问服务器有没有重复 → 分片上传（可断点续传）→ 等 Worker 传到 Telegram。
// 全局单例，页面切换不丢；用 useSyncExternalStore 订阅。

import { createSHA256 } from 'hash-wasm';
import { api, ApiError, putBytes } from './api';
import type { DriveFile, ServerTask } from './types';

export type Phase =
  | 'queued' // 排队等算指纹
  | 'hashing' // 正在算 SHA-256
  | 'checking' // 问服务器查重
  | 'waiting' // 等上传名额
  | 'uploading' // 分片传到服务器
  | 'processing' // 服务器正往 Telegram 传
  | 'done'
  | 'duplicate' // 已存在，没上传
  | 'failed'
  | 'cancelled';

export interface UploadItem {
  id: string;
  name: string;
  size: number;
  folderId: number | null;
  phase: Phase;
  hashPct: number;
  sendPct: number;
  tgPct: number;
  taskId?: number;
  sha256?: string;
  error?: string;
  duplicate?: { file: DriveFile; in_trash: boolean };
  linked?: boolean;
  retryCount?: number;
}

const HASH_BLOCK = 8 * 1024 * 1024;
const CHUNK_PARALLEL = 3;
const MAX_FILES_SENDING = 2;
const ACTIVE: Phase[] = ['queued', 'hashing', 'checking', 'waiting', 'uploading', 'processing'];

class Slots {
  private used = 0;
  private waiters: (() => void)[] = [];
  constructor(private max: number) {}
  async take() {
    if (this.used < this.max) {
      this.used++;
      return;
    }
    await new Promise<void>((r) => this.waiters.push(r));
    this.used++;
  }
  give() {
    this.used--;
    const next = this.waiters.shift();
    if (next) next();
  }
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

class UploadManager {
  private items: UploadItem[] = [];
  private files = new Map<string, File>();
  private aborts = new Map<string, AbortController>();
  private listeners = new Set<() => void>();
  private changeListeners = new Set<() => void>();
  private hashSlots = new Slots(1);
  private sendSlots = new Slots(MAX_FILES_SENDING);
  private seq = 0;

  subscribe = (fn: () => void) => {
    this.listeners.add(fn);
    return () => {
      this.listeners.delete(fn);
    };
  };
  getSnapshot = () => this.items;
  getServerSnapshot = () => this.items;

  /** 文件列表需要刷新时（某个文件传完、秒传成功） */
  onFilesChanged(fn: () => void) {
    this.changeListeners.add(fn);
    return () => {
      this.changeListeners.delete(fn);
    };
  }

  private emit() {
    this.items = [...this.items];
    this.listeners.forEach((l) => l());
  }
  private filesChanged() {
    this.changeListeners.forEach((l) => l());
  }
  private patch(id: string, p: Partial<UploadItem>) {
    this.items = this.items.map((it) => (it.id === id ? { ...it, ...p } : it));
    this.listeners.forEach((l) => l());
  }
  private get(id: string) {
    return this.items.find((it) => it.id === id);
  }

  /** 关页面会打断的上传（processing 已在服务器上，关页面不影响） */
  hasActive() {
    return this.items.some((it) => ACTIVE.includes(it.phase) && it.phase !== 'processing');
  }

  add(files: File[], folderId: number | null) {
    for (const f of files) {
      const id = `u${Date.now()}-${this.seq++}`;
      this.files.set(id, f);
      this.items.push({ id, name: f.name, size: f.size, folderId, phase: 'queued', hashPct: 0, sendPct: 0, tgPct: 0 });
      this.run(id);
    }
    this.emit();
  }

  private async run(id: string) {
    const file = this.files.get(id);
    if (!file) return;
    const ctrl = new AbortController();
    this.aborts.set(id, ctrl);
    try {
      if (file.size === 0) throw new Error('空文件不能上传');
      let sha = this.get(id)?.sha256;
      if (!sha) {
        await this.hashSlots.take();
        try {
          if (ctrl.signal.aborted) return;
          this.patch(id, { phase: 'hashing' });
          sha = await this.hash(id, file, ctrl.signal);
          this.patch(id, { sha256: sha });
        } finally {
          this.hashSlots.give();
        }
      }
      if (ctrl.signal.aborted) return;
      await this.createAndSend(id, file, sha, false, ctrl);
    } catch (e: any) {
      if (ctrl.signal.aborted) return;
      this.patch(id, { phase: 'failed', error: e?.message || String(e) });
    }
  }

  private async hash(id: string, file: File, signal: AbortSignal) {
    const h = await createSHA256();
    h.init();
    let last = 0;
    for (let off = 0; off < file.size; off += HASH_BLOCK) {
      if (signal.aborted) throw new Error('已取消');
      const buf = new Uint8Array(await file.slice(off, off + HASH_BLOCK).arrayBuffer());
      h.update(buf);
      const pct = Math.floor(((off + buf.length) * 100) / file.size);
      if (pct !== last) {
        last = pct;
        this.patch(id, { hashPct: pct });
      }
    }
    return h.digest('hex');
  }

  private async createAndSend(id: string, file: File, sha: string, link: boolean, ctrl: AbortController) {
    const it = this.get(id)!;
    this.patch(id, { phase: 'checking', error: undefined });
    const res = await api('/api/upload/create', {
      method: 'POST',
      body: {
        filename: it.name,
        file_size: it.size,
        mime_type: file.type,
        sha256: sha,
        folder_id: it.folderId,
        link_if_duplicate: link,
      },
    });
    if (res.duplicate) {
      if (res.linked) {
        this.patch(id, { phase: 'done', linked: true, sendPct: 100, tgPct: 100 });
        this.filesChanged();
      } else {
        this.patch(id, { phase: 'duplicate', duplicate: { file: res.file, in_trash: res.in_trash } });
      }
      return;
    }
    const task: ServerTask = res.task;
    this.patch(id, { taskId: task.id });
    this.filesChanged(); // 列表里先出现一条「上传中」
    if (task.status === 'pending') {
      this.patch(id, { phase: 'waiting' });
      await this.sendSlots.take();
      try {
        if (ctrl.signal.aborted) return;
        await this.sendChunks(id, file, task, ctrl.signal);
      } finally {
        this.sendSlots.give();
      }
      if (ctrl.signal.aborted) return;
      await api(`/api/upload/${task.id}/complete`, { method: 'POST' });
    }
    this.patch(id, { phase: 'processing', sendPct: 100 });
    await this.poll(id, task.id, ctrl.signal);
  }

  private async sendChunks(id: string, file: File, task: ServerTask, signal: AbortSignal) {
    this.patch(id, { phase: 'uploading' });
    const done = new Set(task.received || []);
    const todo: number[] = [];
    for (let i = 0; i < task.total_chunks; i++) if (!done.has(i)) todo.push(i);
    let sentBytes = 0;
    for (const i of done) sentBytes += Math.min(task.chunk_size, file.size - i * task.chunk_size);
    const progress = () => this.patch(id, { sendPct: Math.floor((sentBytes * 100) / file.size) });
    progress();

    const worker = async () => {
      while (todo.length) {
        if (signal.aborted) return;
        const i = todo.shift()!;
        const blob = file.slice(i * task.chunk_size, (i + 1) * task.chunk_size);
        for (let attempt = 1; ; attempt++) {
          try {
            await putBytes(`/api/upload/${task.id}/chunks/${i}`, blob, signal);
            break;
          } catch (e: any) {
            if (signal.aborted) return;
            const fatal = e instanceof ApiError && [400, 401, 403, 404, 409, 410, 413].includes(e.status);
            if (fatal || attempt >= 5) throw e;
            await sleep(1000 * 2 ** attempt); // 网络抖动：2s 4s 8s 16s 后重试
          }
        }
        sentBytes += blob.size;
        progress();
      }
    };
    await Promise.all(Array.from({ length: Math.min(CHUNK_PARALLEL, todo.length || 1) }, worker));
  }

  private async poll(id: string, taskId: number, signal: AbortSignal) {
    let errors = 0;
    while (!signal.aborted) {
      await sleep(1500);
      if (signal.aborted) return;
      let t: ServerTask;
      try {
        t = await api(`/api/upload/${taskId}/status`);
        errors = 0;
      } catch (e) {
        if (++errors > 20) throw e;
        continue;
      }
      if (t.status === 'completed') {
        this.patch(id, { phase: 'done', tgPct: 100 });
        this.filesChanged();
        return;
      }
      if (t.status === 'failed' || t.status === 'cancelled') {
        this.patch(id, { phase: t.status, error: t.error_message || undefined, retryCount: t.retry_count });
        this.filesChanged();
        return;
      }
      this.patch(id, {
        tgPct: t.progress,
        retryCount: t.retry_count,
        error: t.retry_count && t.error_message ? `第 ${t.retry_count} 次失败，自动重试中：${t.error_message}` : undefined,
      });
    }
  }

  cancel(id: string) {
    const it = this.get(id);
    if (!it) return;
    this.aborts.get(id)?.abort();
    if (it.taskId && ACTIVE.includes(it.phase)) {
      api(`/api/upload/${it.taskId}/cancel`, { method: 'POST' })
        .catch(() => {})
        .finally(() => this.filesChanged());
    }
    this.patch(id, { phase: 'cancelled' });
  }

  /** 失败后重试：服务器那边失败的让 Worker 重新传；浏览器这边失败的从断点继续传 */
  async retry(id: string) {
    const it = this.get(id);
    const file = this.files.get(id);
    if (!it || !file) return;
    const ctrl = new AbortController();
    this.aborts.set(id, ctrl);
    try {
      if (it.taskId && it.phase === 'failed' && it.sendPct === 100) {
        try {
          await api(`/api/upload/${it.taskId}/retry`, { method: 'POST' });
          this.patch(id, { phase: 'processing', error: undefined, tgPct: 0 });
          await this.poll(id, it.taskId, ctrl.signal);
          return;
        } catch (e) {
          if (!(e instanceof ApiError && e.status === 410)) throw e;
          // 服务器临时文件已清理：重新从头传
        }
      }
      this.patch(id, { phase: 'queued', error: undefined, taskId: undefined });
      if (it.sha256) await this.createAndSend(id, file, it.sha256, false, ctrl);
      else await this.run(id);
    } catch (e: any) {
      if (!ctrl.signal.aborted) this.patch(id, { phase: 'failed', error: e?.message || String(e) });
    }
  }

  /** 查重命中后，选择「仍在这里放一份」：不重新上传，直接指向已有的那份 */
  async linkDuplicate(id: string) {
    const it = this.get(id);
    const file = this.files.get(id);
    if (!it || !file || !it.sha256) return;
    const ctrl = new AbortController();
    try {
      await this.createAndSend(id, file, it.sha256, true, ctrl);
    } catch (e: any) {
      this.patch(id, { phase: 'failed', error: e?.message || String(e) });
    }
  }

  dismiss(id: string) {
    this.items = this.items.filter((it) => it.id !== id);
    this.files.delete(id);
    this.aborts.delete(id);
    this.emit();
  }

  clearFinished() {
    for (const it of this.items) if (!ACTIVE.includes(it.phase) && it.phase !== 'failed') this.files.delete(it.id);
    this.items = this.items.filter((it) => ACTIVE.includes(it.phase) || it.phase === 'failed');
    this.emit();
  }
}

export const uploads = new UploadManager();

if (typeof window !== 'undefined') {
  window.addEventListener('beforeunload', (e) => {
    if (uploads.hasActive()) {
      e.preventDefault();
      e.returnValue = '';
    }
  });
}
