import {
  setBadge as setBadgeAdapter,
  clearBadge as clearBadgeAdapter,
} from "../badge/badge.js";
import { detectCapabilities } from "./capabilities.js";
import { InvalidConfigurationError, type ConnectionError } from "./errors.js";
import {
  requestNotificationPermission,
  showNotification,
} from "../notifications/notifications.js";
import { resolveNotificationUrl } from "../notifications/notification-url.js";
import {
  subscribePush as subscribePushAdapter,
  unsubscribePush as unsubscribePushAdapter,
} from "../push/push.js";
import { ensureServiceWorkerRegistration } from "../push/push.js";
import { WebSocketManager } from "../websocket/manager.js";
import type {
  Capabilities,
  NexusPulseEventMap,
  NexusPulseOptions,
  NexusPulseState,
  NotificationPayload,
} from "./types.js";

type Listener<K extends keyof NexusPulseEventMap> = (
  value: NexusPulseEventMap[K],
) => void;

type ListenerStore = {
  [K in keyof NexusPulseEventMap]: Set<Listener<K>>;
};

export class NexusPulse {
  private currentState: NexusPulseState = "idle";
  private readonly listeners: ListenerStore = {
    statechange: new Set(),
    ready: new Set(),
    permissionchange: new Set(),
    subscriptionchange: new Set(),
    message: new Set(),
    notification: new Set(),
    connected: new Set(),
    disconnected: new Set(),
    error: new Set(),
  };
  private initialized = false;
  private initializationPromise: Promise<void> | undefined;
  private disposed = false;
  private websocket?: WebSocketManager;
  private serviceWorkerRegistration?: ServiceWorkerRegistration;
  private pushSubscription: PushSubscription | undefined;
  private readonly runtime: unknown;

  constructor(
    private readonly options: NexusPulseOptions = {},
    runtime?: unknown,
  ) {
    this.runtime = runtime;
  }

  get capabilities(): Capabilities {
    return detectCapabilities(this.runtime ?? globalThis);
  }

  private runtimeForAdapters(): unknown {
    return this.runtime ?? globalThis;
  }

  get state(): NexusPulseState {
    return this.currentState;
  }

  on<K extends keyof NexusPulseEventMap>(
    event: K,
    listener: Listener<K>,
  ): () => void {
    if (this.disposed) return () => undefined;
    const listeners = this.listeners[event];
    listeners.add(listener);
    return () => listeners.delete(listener);
  }

  private emit<K extends keyof NexusPulseEventMap>(
    event: K,
    value: NexusPulseEventMap[K],
  ): void {
    if (this.disposed) return;
    for (const listener of this.listeners[event]) {
      try {
        listener(value);
      } catch (error) {
        if (event !== "error")
          this.emit(
            "error",
            error instanceof Error ? error : new Error(String(error)),
          );
      }
    }
  }

  private setState(state: NexusPulseState): void {
    this.currentState = state;
    this.emit("statechange", state);
  }

  initialize(): Promise<void> {
    if (this.disposed || this.initialized) return Promise.resolve();
    if (this.initializationPromise) return this.initializationPromise;

    let resolveInitialization!: () => void;
    let rejectInitialization!: (error: unknown) => void;
    const initialization = new Promise<void>((resolve, reject) => {
      resolveInitialization = resolve;
      rejectInitialization = reject;
    });
    this.initializationPromise = initialization;
    this.setState("initializing");

    void (async () => {
      try {
        if (this.options.serviceWorker) {
          this.serviceWorkerRegistration =
            await ensureServiceWorkerRegistration(
              this.options.serviceWorker,
              this.runtimeForAdapters() as any,
            );
        }
        if (this.disposed) {
          resolveInitialization();
          return;
        }
        this.initialized = true;
        this.setState("ready");
        this.emit("ready", undefined);
        resolveInitialization();
      } catch (error) {
        if (this.disposed) {
          resolveInitialization();
          return;
        }
        this.setState("error");
        this.emit(
          "error",
          error instanceof Error ? error : new Error(String(error)),
        );
        if (this.initializationPromise === initialization) {
          this.initializationPromise = undefined;
        }
        rejectInitialization(error);
      }
    })();

    return initialization;
  }

  async requestPermission(): Promise<NotificationPermission> {
    try {
      const permission = await requestNotificationPermission(
        this.runtimeForAdapters(),
      );
      this.emit("permissionchange", permission);
      return permission;
    } catch (error) {
      this.emit(
        "error",
        error instanceof Error ? error : new Error(String(error)),
      );
      throw error;
    }
  }

  notify(payload: NotificationPayload): Notification {
    try {
      const notification = showNotification(payload, this.runtimeForAdapters());
      const clickUrl = payload.url;
      if (clickUrl !== undefined) {
        notification.onclick = () => {
          try {
            const runtime = this.runtimeForAdapters() as {
              location?: { origin?: string; assign?: (url: string) => void };
              focus?: () => void;
            };
            const targetUrl = resolveNotificationUrl(
              clickUrl,
              runtime.location?.origin,
              this.options.security?.allowedOrigins ??
                this.options.allowedOrigins ??
                [],
            );
            if (!targetUrl) return;
            if (typeof runtime.location?.assign !== "function") {
              throw new InvalidConfigurationError(
                "Notification click navigation is not supported",
              );
            }
            runtime.focus?.();
            runtime.location.assign(targetUrl.href);
          } catch (error) {
            this.emit(
              "error",
              error instanceof Error ? error : new Error(String(error)),
            );
          }
        };
      }
      this.emit("notification", payload);
      return notification;
    } catch (error) {
      this.emit(
        "error",
        error instanceof Error ? error : new Error(String(error)),
      );
      throw error;
    }
  }

  async subscribePush(): Promise<PushSubscription> {
    try {
      const serviceWorker = this.serviceWorkerRegistration
        ? {
            ...this.options.serviceWorker,
            registration: this.serviceWorkerRegistration,
          }
        : this.options.serviceWorker;
      const subscription = await subscribePushAdapter(
        {
          ...this.options.push,
          ...(serviceWorker === undefined ? {} : { serviceWorker }),
        },
        this.runtimeForAdapters() as any,
      );
      this.pushSubscription = subscription;
      this.emit("subscriptionchange", subscription);
      return subscription;
    } catch (error) {
      this.emit(
        "error",
        error instanceof Error ? error : new Error(String(error)),
      );
      throw error;
    }
  }

  async unsubscribePush(subscription?: PushSubscription): Promise<boolean> {
    try {
      const target = subscription ?? this.pushSubscription;
      const result = target ? await unsubscribePushAdapter(target) : false;
      this.pushSubscription = undefined;
      this.emit("subscriptionchange", null);
      return result;
    } catch (error) {
      this.emit(
        "error",
        error instanceof Error ? error : new Error(String(error)),
      );
      throw error;
    }
  }

  async connect(): Promise<void> {
    if (!this.options.webSocket) {
      const error = new InvalidConfigurationError(
        "WebSocket configuration is required",
      );
      this.emit("error", error);
      throw error;
    }
    if (this.disposed) return;
    if (!this.websocket) {
      this.websocket = new WebSocketManager(
        this.options.webSocket,
        {
          onStateChange: (state) => {
            if (state === "connecting") this.setState("connecting");
            if (state === "connected") {
              this.setState("connected");
              this.emit("connected", undefined);
            }
            if (state === "stopped") {
              if (this.currentState !== "stopped") this.setState("ready");
              this.emit("disconnected", undefined);
            }
          },
          onMessage: (payload) => {
            this.emit("message", payload);
            if (this.options.webSocket?.autoNotify !== false) {
              try {
                this.notify(payload);
              } catch {
                /* notify already emitted the adapter error */
              }
            }
          },
          onError: (error: ConnectionError) => this.emit("error", error),
        },
        this.runtimeForAdapters(),
      );
    }
    await this.websocket.connect();
  }

  disconnect(): void {
    if (!this.websocket || this.disposed) return;
    this.websocket.disconnect();
  }

  async setBadge(count?: number): Promise<boolean> {
    if (this.options.badge?.enabled === false) return false;
    try {
      return await setBadgeAdapter(count, this.runtimeForAdapters());
    } catch (error) {
      this.emit(
        "error",
        error instanceof Error ? error : new Error(String(error)),
      );
      throw error;
    }
  }

  async clearBadge(): Promise<boolean> {
    if (this.options.badge?.enabled === false) return false;
    try {
      return await clearBadgeAdapter(this.runtimeForAdapters());
    } catch (error) {
      this.emit(
        "error",
        error instanceof Error ? error : new Error(String(error)),
      );
      throw error;
    }
  }

  dispose(): void {
    if (this.disposed) return;
    this.websocket?.disconnect();
    this.currentState = "stopped";
    this.disposed = true;
    for (const listeners of Object.values(this.listeners)) listeners.clear();
  }
}

export function createNexusPulse(
  options: NexusPulseOptions = {},
  runtime?: unknown,
): NexusPulse {
  return new NexusPulse(options, runtime);
}
