import { API_URL } from './api';
import type { Pool, WSMessage } from './types';

type Listener = (pool: Pool) => void;

export class PoolStore {
  pool: Pool;
  private listeners = new Set<Listener>();
  private ws?: WebSocket;
  private reconnectTimer?: ReturnType<typeof setTimeout>;
  private closed = false;

  constructor(initial: Pool) {
    this.pool = initial;
  }

  subscribe(fn: Listener): () => void {
    this.listeners.add(fn);
    fn(this.pool);
    return () => {
      this.listeners.delete(fn);
    };
  }

  setPool(pool: Pool): void {
    this.pool = pool;
    this.notify();
  }

  connect(): void {
    if (this.ws || this.closed) return;
    const wsBase = API_URL.replace(/^http/, 'ws');
    const url = `${wsBase}/api/pools/${this.pool.id}/ws`;
    const ws = new WebSocket(url);
    this.ws = ws;

    ws.onmessage = (ev) => {
      try {
        const msg: WSMessage = JSON.parse(ev.data as string);
        if (msg.type === 'state') {
          this.pool = msg.pool;
          this.notify();
        }
      } catch {
        // ignore malformed messages
      }
    };

    ws.onclose = () => {
      this.ws = undefined;
      if (this.closed) return;
      this.reconnectTimer = setTimeout(() => this.connect(), 2000);
    };

    ws.onerror = () => {
      ws.close();
    };
  }

  disconnect(): void {
    this.closed = true;
    if (this.reconnectTimer) clearTimeout(this.reconnectTimer);
    this.ws?.close();
    this.ws = undefined;
  }

  private notify() {
    for (const fn of this.listeners) fn(this.pool);
  }
}
