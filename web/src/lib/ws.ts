// WebSocket con ping cada 25 s y reconexión con backoff exponencial.
import type { WsEvent } from './types';

export interface WsDeps {
  /** Devuelve la URL a usar (con token fresco) o lanza si no hay red/sesión. */
  url: () => Promise<string>;
  onEvent: (e: WsEvent) => void;
  onOpen: () => void;
  onState: (s: 'off' | 'connecting' | 'open') => void;
  WebSocketImpl?: typeof WebSocket;
}

export const PING_MS = 25_000;

export function backoffDelay(attempt: number, rand = Math.random()): number {
  const base = Math.min(30_000, 1000 * 2 ** Math.min(attempt, 5));
  return Math.round(base / 2 + (base / 2) * rand);
}

export class Socket {
  private ws: WebSocket | null = null;
  private ping: ReturnType<typeof setInterval> | null = null;
  private retry: ReturnType<typeof setTimeout> | null = null;
  private attempt = 0;
  private stopped = true;
  private connecting = false;

  constructor(private deps: WsDeps) {}

  start(): void {
    if (!this.stopped) return;
    this.stopped = false;
    void this.connect();
  }

  stop(): void {
    this.stopped = true;
    this.clearTimers();
    if (this.ws) {
      this.ws.onclose = null;
      this.ws.close();
      this.ws = null;
    }
    this.deps.onState('off');
  }

  /** Reconecta ya si está caído (al volver la red o la pestaña). */
  kick(): void {
    if (this.stopped || this.ws || this.connecting) return;
    if (this.retry) clearTimeout(this.retry);
    this.retry = null;
    this.attempt = 0;
    void this.connect();
  }

  get isOpen(): boolean {
    return this.ws?.readyState === 1;
  }

  private clearTimers(): void {
    if (this.ping) clearInterval(this.ping);
    if (this.retry) clearTimeout(this.retry);
    this.ping = null;
    this.retry = null;
  }

  private schedule(): void {
    if (this.stopped) return;
    const d = backoffDelay(this.attempt++);
    this.deps.onState('connecting');
    this.retry = setTimeout(() => {
      this.retry = null;
      void this.connect();
    }, d);
  }

  private async connect(): Promise<void> {
    if (this.stopped || this.connecting) return;
    this.connecting = true;
    this.deps.onState('connecting');
    let url: string;
    try {
      url = await this.deps.url();
    } catch {
      this.connecting = false;
      this.schedule();
      return;
    }
    if (this.stopped) {
      this.connecting = false;
      return;
    }
    const Impl = this.deps.WebSocketImpl ?? WebSocket;
    const ws = new Impl(url);
    this.ws = ws;
    ws.onopen = () => {
      this.connecting = false;
      this.attempt = 0;
      this.deps.onState('open');
      this.ping = setInterval(() => {
        if (ws.readyState === 1) ws.send(JSON.stringify({ type: 'ping' }));
      }, PING_MS);
      this.deps.onOpen();
    };
    ws.onmessage = ev => {
      try {
        this.deps.onEvent(JSON.parse(String(ev.data)) as WsEvent);
      } catch {
        /* mensaje no JSON: se ignora */
      }
    };
    ws.onclose = () => {
      this.connecting = false;
      if (this.ping) clearInterval(this.ping);
      this.ping = null;
      this.ws = null;
      this.schedule();
    };
    ws.onerror = () => {
      /* onclose llega después */
    };
  }
}
