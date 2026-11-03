/** Client connections are disposable. Closing one never cancels server work. */
export interface WsEnvironment {
  createSocket: () => WebSocket;
  isOnline: () => boolean;
  onAuthFailure: () => void;
  reportError?: (error: unknown) => void;
  random?: () => number;
}

type WsHandler = (data: any) => void;

export class WsManager {
  private ws: WebSocket | null = null;
  private handlers = new Map<string, Set<WsHandler>>();
  private reconnectTimer: ReturnType<typeof setTimeout> | null = null;
  private openTimer: ReturnType<typeof setTimeout> | null = null;
  private reconnectDelay = 1000;
  private wanted = false;
  private readonly env: WsEnvironment;

  constructor(env: WsEnvironment) {
    this.env = env;
  }

  /** Only the authenticated application should start a connection. */
  connect(): void {
    this.wanted = true;
    this.clearReconnect();
    this.openSocket();
  }

  disconnect(): void {
    this.wanted = false;
    this.clearReconnect();
    this.dropSocket();
  }

  /** Recover a suspended mobile socket, without replaying commands. */
  reconnect(): void {
    if (!this.wanted) return;
    this.clearReconnect();
    this.dropSocket();
    this.reconnectDelay = 1000;
    this.openSocket();
  }

  networkChanged(online: boolean): void {
    if (online) {
      // OPEN can be stale after a radio/network change. Replace it too.
      this.reconnect();
    } else {
      this.clearReconnect();
      this.dropSocket();
    }
  }

  isConnected(): boolean {
    return this.ws?.readyState === 1;
  }

  send(data: object): boolean {
    if (!this.isConnected()) return false;
    try {
      this.ws!.send(JSON.stringify(data));
      return true;
    } catch (error) {
      this.env.reportError?.(error);
      this.reconnect();
      return false;
    }
  }

  on(type: string, handler: WsHandler): () => void {
    if (!this.handlers.has(type)) this.handlers.set(type, new Set());
    this.handlers.get(type)!.add(handler);
    return () => {
      const listeners = this.handlers.get(type);
      listeners?.delete(handler);
      if (!listeners?.size) this.handlers.delete(type);
    };
  }

  private emit(type: string, data: any): void {
    // One failed subscriber must not block snapshots for other subscribers.
    for (const handler of [...(this.handlers.get(type) ?? [])]) {
      try {
        handler(data);
      } catch (error) {
        this.env.reportError?.(error);
      }
    }
  }

  private openSocket(): void {
    if (!this.wanted || !this.env.isOnline()) return;
    if (this.ws && this.ws.readyState <= 1) return;
    let ws: WebSocket;
    try {
      ws = this.env.createSocket();
    } catch (error) {
      this.env.reportError?.(error);
      this.scheduleReconnect();
      return;
    }
    this.ws = ws;
    this.openTimer = setTimeout(() => {
      if (this.ws !== ws || ws.readyState !== 0) return;
      this.dropSocket();
      this.scheduleReconnect();
    }, 15000);

    ws.onopen = () => {
      if (this.ws !== ws || !this.wanted) return;
      this.clearOpenTimer();
      this.reconnectDelay = 1000;
      this.emit('connected', {});
    };
    ws.onmessage = (event) => {
      if (this.ws !== ws || !this.wanted) return;
      try {
        const data = JSON.parse(event.data);
        if (data && typeof data.type === 'string') this.emit(data.type, data);
      } catch {
        // Malformed frames are not commands, and are never replayed.
      }
    };
    ws.onclose = (event) => {
      if (this.ws !== ws) return;
      this.ws = null;
      this.clearOpenTimer();
      if (event.code === 1008 || event.code === 4001) {
        this.wanted = false;
        this.clearReconnect();
        this.emit('disconnected', {});
        this.env.onAuthFailure();
        return;
      }
      this.emit('disconnected', {});
      this.scheduleReconnect();
    };
    ws.onerror = () => {
      if (this.ws !== ws) return;
      this.dropSocket();
      this.scheduleReconnect();
    };
  }

  private dropSocket(): void {
    const ws = this.ws;
    this.ws = null;
    this.clearOpenTimer();
    // Detach first: a delayed close/error from this socket must not affect
    // its replacement, or reconnect after explicit logout.
    if (ws) {
      ws.onopen = null;
      ws.onmessage = null;
      ws.onclose = null;
      ws.onerror = null;
      try {
        ws.close();
      } catch (error) {
        this.env.reportError?.(error);
      }
      this.emit('disconnected', {});
    }
  }

  private clearReconnect(): void {
    if (this.reconnectTimer) clearTimeout(this.reconnectTimer);
    this.reconnectTimer = null;
  }

  private clearOpenTimer(): void {
    if (this.openTimer) clearTimeout(this.openTimer);
    this.openTimer = null;
  }

  private scheduleReconnect(): void {
    if (!this.wanted || !this.env.isOnline() || this.reconnectTimer) return;
    const jitter = 0.8 + (this.env.random?.() ?? Math.random()) * 0.4;
    const delay = Math.min(30000, Math.round(this.reconnectDelay * jitter));
    this.reconnectDelay = Math.min(30000, this.reconnectDelay * 2);
    this.reconnectTimer = setTimeout(() => {
      this.reconnectTimer = null;
      this.openSocket();
    }, delay);
  }
}

/** Bind once per application; cleanup also supports hot-module replacement. */
export function bindConnectionLifecycle(
  manager: WsManager,
  win: Window,
  doc: Document,
  now: () => number = Date.now,
): () => void {
  let hiddenAt: number | null = doc.hidden ? now() : null;
  const online = () => manager.networkChanged(true);
  const offline = () => manager.networkChanged(false);
  const visibility = () => {
    if (doc.hidden) {
      hiddenAt = now();
      return;
    }
    const wasSuspended = hiddenAt !== null && now() - hiddenAt >= 5000;
    hiddenAt = null;
    if (wasSuspended || !manager.isConnected()) manager.reconnect();
  };
  const pageshow = (event: PageTransitionEvent) => {
    if (event.persisted) {
      hiddenAt = null;
      manager.reconnect();
    }
  };
  win.addEventListener('online', online);
  win.addEventListener('offline', offline);
  win.addEventListener('pageshow', pageshow);
  doc.addEventListener('visibilitychange', visibility);
  return () => {
    win.removeEventListener('online', online);
    win.removeEventListener('offline', offline);
    win.removeEventListener('pageshow', pageshow);
    doc.removeEventListener('visibilitychange', visibility);
  };
}
