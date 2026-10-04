import type { NotificationPayload, WebSocketOptions } from "./types.js";
import { ConnectionError } from "./errors.js";

export type WebSocketState = "idle" | "connecting" | "connected" | "stopped";

export interface WebSocketManagerHandlers {
  onStateChange?: (state: WebSocketState) => void;
  onMessage?: (payload: NotificationPayload) => void;
  onError?: (error: ConnectionError) => void;
}

type SocketLike = {
  onopen: (() => void) | null;
  onmessage: ((event: { data: unknown }) => void) | null;
  onerror: (() => void) | null;
  onclose: (() => void) | null;
  close: () => void;
};

type WebSocketConstructor = new (
  url: string,
  protocols?: string | string[],
) => SocketLike;

const defaults = {
  maxAttempts: 3,
  initialDelay: 250,
  maxDelay: 10_000,
  factor: 2,
};

function asRecord(value: unknown): Record<string, unknown> | undefined {
  return value !== null &&
    (typeof value === "object" || typeof value === "function")
    ? (value as Record<string, unknown>)
    : undefined;
}

function defaultDecodeMessage(
  message: unknown,
): NotificationPayload | undefined {
  let value = message;
  if (typeof message === "string") {
    try {
      value = JSON.parse(message) as unknown;
    } catch {
      return undefined;
    }
  }
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    return undefined;
  }
  const record = value as Record<string, unknown>;
  if (typeof record.title !== "string" || record.title.trim().length === 0) {
    return undefined;
  }
  return record as unknown as NotificationPayload;
}

export class WebSocketManager {
  private current: SocketLike | undefined;
  private reconnectTimer: ReturnType<typeof setTimeout> | undefined;
  private reconnectAttempts = 1;
  private stopped = false;
  private pending: Promise<void> | undefined;
  private resolvePending: (() => void) | undefined;
  private rejectPending: ((error: ConnectionError) => void) | undefined;
  private generation = 0;

  constructor(
    private readonly options: WebSocketOptions,
    private readonly handlers: WebSocketManagerHandlers = {},
    private readonly runtime?: unknown,
  ) {}

  private currentState: WebSocketState = "idle";

  get state(): WebSocketState {
    return this.currentState;
  }

  private setState(state: WebSocketState): void {
    this.currentState = state;
    this.handlers.onStateChange?.(state);
  }

  private toConnectionError(error: unknown): ConnectionError {
    return error instanceof ConnectionError
      ? error
      : new ConnectionError(
          error instanceof Error
            ? error.message
            : "WebSocket connection failed",
        );
  }

  private reportError(error: unknown): ConnectionError {
    const connectionError = this.toConnectionError(error);
    this.handlers.onError?.(connectionError);
    return connectionError;
  }

  private settlePendingSuccess(): void {
    this.resolvePending?.();
    this.resolvePending = undefined;
    this.rejectPending = undefined;
    this.pending = undefined;
  }

  private settlePendingFailure(error: unknown): void {
    const connectionError = this.toConnectionError(error);
    this.rejectPending?.(connectionError);
    this.resolvePending = undefined;
    this.rejectPending = undefined;
    this.pending = undefined;
  }

  private detachCurrent(close: boolean): void {
    const socket = this.current;
    this.generation += 1;
    this.current = undefined;
    if (!socket) return;
    socket.onopen = null;
    socket.onmessage = null;
    socket.onerror = null;
    socket.onclose = null;
    if (close) socket.close();
  }

  private reconnectOptions() {
    const value = this.options.reconnect;
    if (!value) return undefined;
    return { ...defaults, ...(typeof value === "object" ? value : {}) };
  }

  private scheduleReconnect(): void {
    const config = this.reconnectOptions();
    if (!config || this.stopped) {
      this.stopped = true;
      this.detachCurrent(false);
      this.setState("stopped");
      this.settlePendingFailure(
        new ConnectionError("WebSocket connection stopped before opening"),
      );
      return;
    }
    if (this.reconnectAttempts >= config.maxAttempts) {
      this.stopped = true;
      this.detachCurrent(false);
      this.setState("stopped");
      const connectionError = new ConnectionError(
        "WebSocket reconnect attempts exhausted",
      );
      this.reportError(connectionError);
      this.settlePendingFailure(connectionError);
      return;
    }
    const delay = Math.min(
      config.maxDelay,
      config.initialDelay * Math.pow(config.factor, this.reconnectAttempts - 1),
    );
    this.reconnectAttempts += 1;
    this.reconnectTimer = setTimeout(() => {
      this.reconnectTimer = undefined;
      void this.open();
    }, delay);
  }

  private async open(): Promise<void> {
    if (this.stopped) return;
    const token = ++this.generation;
    this.setState("connecting");
    const root = this.runtime ?? globalThis;
    const constructor = asRecord(root)?.WebSocket;
    if (typeof constructor !== "function") {
      this.setState("stopped");
      const connectionError = this.reportError(
        new ConnectionError("The WebSocket API is not supported"),
      );
      this.settlePendingFailure(connectionError);
      return;
    }

    let socket: SocketLike;
    try {
      socket = new (constructor as unknown as WebSocketConstructor)(
        this.options.url,
        this.options.protocols,
      );
    } catch (error) {
      const connectionError = this.reportError(error);
      this.setState("stopped");
      this.settlePendingFailure(connectionError);
      return;
    }
    this.current = socket;
    socket.onopen = () => {
      if (this.stopped || this.generation !== token || this.current !== socket)
        return;
      this.setState("connected");
      this.settlePendingSuccess();
    };
    socket.onmessage = (event) => {
      if (this.stopped || this.generation !== token || this.current !== socket)
        return;
      try {
        const decode = this.options.decodeMessage ?? defaultDecodeMessage;
        const payload = decode(event.data);
        if (payload != null) this.handlers.onMessage?.(payload);
      } catch (error) {
        this.reportError(error);
      }
    };
    socket.onerror = () => {
      if (this.stopped || this.generation !== token || this.current !== socket)
        return;
      const connectionError = this.reportError(new ConnectionError());
      this.settlePendingFailure(connectionError);
      this.detachCurrent(false);
      this.scheduleReconnect();
    };
    socket.onclose = () => {
      if (this.stopped || this.generation !== token || this.current !== socket)
        return;
      const wasConnecting = this.currentState === "connecting";
      this.detachCurrent(false);
      if (wasConnecting) {
        const connectionError = new ConnectionError(
          "WebSocket closed before connection opened",
        );
        this.reportError(connectionError);
        this.settlePendingFailure(connectionError);
      }
      this.scheduleReconnect();
    };
  }

  connect(): Promise<void> {
    if (this.currentState === "connecting" && this.pending) return this.pending;
    if (this.reconnectTimer !== undefined) {
      clearTimeout(this.reconnectTimer);
      this.reconnectTimer = undefined;
    }
    if (this.current) {
      this.detachCurrent(true);
    }
    this.stopped = false;
    this.reconnectAttempts = 1;
    const pending = new Promise<void>((resolve, reject) => {
      this.resolvePending = resolve;
      this.rejectPending = reject;
    });
    this.pending = pending;
    void this.open();
    return pending;
  }

  disconnect(): void {
    this.stopped = true;
    if (this.reconnectTimer !== undefined) {
      clearTimeout(this.reconnectTimer);
      this.reconnectTimer = undefined;
    }
    this.detachCurrent(true);
    this.setState("stopped");
    this.settlePendingFailure(
      new ConnectionError("WebSocket disconnected before connection opened"),
    );
  }
}
