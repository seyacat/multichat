// Cliente REST con refresco automático del access token en 401.
import type { ApiError, Session } from './types';

export class HttpError extends Error {
  constructor(
    public status: number,
    public code: string,
    message: string,
  ) {
    super(message);
  }
}

export interface ApiDeps {
  base: () => string;
  getSession: () => Session | null;
  setSession: (s: Session) => void | Promise<void>;
  /** El refresh falló: la sesión ya no vale. */
  onAuthLost: () => void;
  fetch?: typeof fetch;
}

export interface UploadOptions {
  onProgress?: (fraction: number) => void;
  signal?: AbortSignal;
}

const SERVER_KEY = 'mc.server';

export function defaultServer(): string {
  const env = (import.meta.env?.VITE_API_BASE as string | undefined) ?? '';
  if (env) return env.replace(/\/+$/, '');
  if (typeof location === 'undefined') return 'http://localhost:8787';
  // Servida por el proxy en <base>/app/… (p. ej. detrás del túnel https://r.dotrino.com/<llave>/app/):
  // la API cuelga de <base>.
  const i = location.pathname.indexOf('/app/');
  return location.origin + (i > 0 ? location.pathname.slice(0, i) : '');
}

export function getServer(): string {
  try {
    const v = localStorage.getItem(SERVER_KEY);
    if (v) return v.replace(/\/+$/, '');
  } catch {
    /* sin localStorage */
  }
  return defaultServer();
}

export function setServer(url: string): void {
  try {
    const clean = url.trim().replace(/\/+$/, '');
    if (!clean || clean === defaultServer()) localStorage.removeItem(SERVER_KEY);
    else localStorage.setItem(SERVER_KEY, clean);
  } catch {
    /* sin localStorage */
  }
}

export function wsUrl(base: string, token: string): string {
  const u = new URL('/api/ws', base);
  u.protocol = u.protocol === 'https:' ? 'wss:' : 'ws:';
  u.searchParams.set('token', token);
  return u.toString();
}

async function parseError(res: Response): Promise<HttpError> {
  let body: Partial<ApiError> = {};
  try {
    body = (await res.json()) as Partial<ApiError>;
  } catch {
    /* cuerpo no JSON */
  }
  return new HttpError(res.status, body.error ?? 'internal', body.message ?? `Error HTTP ${res.status}`);
}

export type Api = ReturnType<typeof createApi>;

export function createApi(deps: ApiDeps) {
  const doFetch = deps.fetch ?? ((...a: Parameters<typeof fetch>) => fetch(...a));
  let refreshing: Promise<boolean> | null = null;

  async function refresh(): Promise<boolean> {
    if (refreshing) return refreshing;
    refreshing = (async () => {
      const s = deps.getSession();
      if (!s) return false;
      try {
        const res = await doFetch(`${deps.base()}/api/auth/refresh`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ refreshToken: s.refreshToken }),
        });
        if (!res.ok) {
          if (res.status === 401 || res.status === 403) {
            deps.onAuthLost();
          }
          return false;
        }
        await deps.setSession((await res.json()) as Session);
        return true;
      } catch {
        return false; // red caída: no cerramos sesión
      } finally {
        setTimeout(() => (refreshing = null), 0);
      }
    })();
    return refreshing;
  }

  async function raw(method: string, path: string, body?: unknown, auth = true): Promise<Response> {
    const send = () => {
      const headers: Record<string, string> = {};
      let payload: BodyInit | undefined;
      if (body instanceof FormData) payload = body;
      else if (body !== undefined) {
        headers['Content-Type'] = 'application/json';
        payload = JSON.stringify(body);
      }
      const s = deps.getSession();
      if (auth && s) headers.Authorization = `Bearer ${s.accessToken}`;
      return doFetch(`${deps.base()}${path}`, { method, headers, body: payload });
    };
    let res = await send();
    if (res.status === 401 && auth && deps.getSession()) {
      if (await refresh()) res = await send();
    }
    if (!res.ok) throw await parseError(res);
    return res;
  }

  async function json<T>(method: string, path: string, body?: unknown, auth = true): Promise<T> {
    const res = await raw(method, path, body, auth);
    if (res.status === 204) return undefined as T;
    const text = await res.text();
    return (text ? JSON.parse(text) : undefined) as T;
  }

  /** Subida multipart con progreso (XHR). */
  function upload<T>(path: string, form: FormData, opts: UploadOptions = {}): Promise<T> {
    const attempt = (): Promise<{ status: number; body: string }> =>
      new Promise((resolve, reject) => {
        const xhr = new XMLHttpRequest();
        xhr.open('POST', `${deps.base()}${path}`);
        const s = deps.getSession();
        if (s) xhr.setRequestHeader('Authorization', `Bearer ${s.accessToken}`);
        xhr.upload.onprogress = e => {
          if (e.lengthComputable) opts.onProgress?.(e.loaded / e.total);
        };
        xhr.onload = () => resolve({ status: xhr.status, body: xhr.responseText });
        xhr.onerror = () => reject(new HttpError(0, 'network', 'Error de red al subir el archivo'));
        xhr.onabort = () => reject(new HttpError(0, 'aborted', 'Subida cancelada'));
        opts.signal?.addEventListener('abort', () => xhr.abort());
        xhr.send(form);
      });
    return (async () => {
      let r = await attempt();
      if (r.status === 401 && (await refresh())) r = await attempt();
      if (r.status < 200 || r.status >= 300) {
        let b: Partial<ApiError> = {};
        try {
          b = JSON.parse(r.body) as Partial<ApiError>;
        } catch {
          /* no JSON */
        }
        throw new HttpError(r.status, b.error ?? 'internal', b.message ?? `Error HTTP ${r.status}`);
      }
      return JSON.parse(r.body) as T;
    })();
  }

  return {
    refresh,
    raw,
    get: <T>(path: string) => json<T>('GET', path),
    post: <T>(path: string, body?: unknown, auth = true) => json<T>('POST', path, body, auth),
    put: <T>(path: string, body?: unknown) => json<T>('PUT', path, body),
    patch: <T>(path: string, body?: unknown) => json<T>('PATCH', path, body),
    del: <T>(path: string) => json<T>('DELETE', path),
    upload,
    bytes: async (path: string) => new Uint8Array(await (await raw('GET', path)).arrayBuffer()),
  };
}
