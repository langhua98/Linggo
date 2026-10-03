export class ApiError extends Error {
  status: number;
  data: any;
  constructor(status: number, message: string, data?: any) {
    super(message);
    this.status = status;
    this.data = data;
  }
}

async function parse(res: Response) {
  const text = await res.text();
  let data: any = null;
  try {
    data = text ? JSON.parse(text) : null;
  } catch {
    data = { message: text };
  }
  if (!res.ok) {
    if (res.status === 401 && typeof window !== 'undefined' && !location.pathname.startsWith('/login')) {
      location.href = '/login/?next=' + encodeURIComponent(location.pathname + location.search);
    }
    const msg = (data && (data.message || data.detail)) || `请求失败（${res.status}）`;
    throw new ApiError(res.status, typeof msg === 'string' ? msg : JSON.stringify(msg), data);
  }
  return data;
}

export async function api<T = any>(path: string, opts: { method?: string; body?: any; signal?: AbortSignal } = {}): Promise<T> {
  const init: RequestInit = { method: opts.method || 'GET', credentials: 'same-origin', signal: opts.signal };
  if (opts.body !== undefined) {
    init.headers = { 'Content-Type': 'application/json' };
    init.body = JSON.stringify(opts.body);
  }
  return parse(await fetch(path, init));
}

export async function putBytes<T = any>(path: string, body: Blob, signal?: AbortSignal): Promise<T> {
  return parse(
    await fetch(path, {
      method: 'PUT',
      body,
      credentials: 'same-origin',
      headers: { 'Content-Type': 'application/octet-stream' },
      signal,
    }),
  );
}

export const fileUrl = (id: number, kind: 'stream' | 'download') => `/api/files/${id}/${kind}`;
