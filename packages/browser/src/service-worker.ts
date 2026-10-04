import {
  InvalidConfigurationError,
  UnsupportedFeatureError,
} from "./errors.js";
import type { NotificationAction, NotificationPayload } from "./types.js";

export interface NexusPulseWorkerClient {
  url: string;
  focus?: () => Promise<unknown> | unknown;
  postMessage?: (message: unknown) => void;
}

export interface NexusPulseWorkerScope {
  addEventListener(
    type: "push",
    listener: (event: NexusPulsePushEvent) => void,
  ): void;
  addEventListener(
    type: "notificationclick",
    listener: (event: NexusPulseNotificationClickEvent) => void,
  ): void;
  registration: {
    showNotification: (
      title: string,
      options?: NexusPulseNotificationOptions,
    ) => Promise<void>;
  };
  clients: {
    matchAll: (options?: {
      type?: "window";
      includeUncontrolled?: boolean;
    }) => Promise<NexusPulseWorkerClient[]>;
    openWindow: (url: string) => Promise<NexusPulseWorkerClient | undefined>;
  };
  location?: { origin?: string };
}

export interface NexusPulsePushEvent {
  data?: {
    json?: () => unknown;
    text?: () => string;
  } | null;
  waitUntil: (promise: Promise<unknown>) => void;
}

export interface NexusPulseNotificationClickEvent {
  action?: string;
  notification: {
    data?: unknown;
    close?: () => void;
  };
  waitUntil: (promise: Promise<unknown>) => void;
}

export interface NexusPulseNotificationOptions {
  body?: string;
  icon?: string;
  badge?: string;
  tag?: string;
  data?: unknown;
  actions?: NotificationAction[];
  timestamp?: number;
  requireInteraction?: boolean;
  silent?: boolean;
}

export interface NexusPulseServiceWorkerOptions {
  scope?: NexusPulseWorkerScope;
  allowedOrigins?: string[];
  decodePush?: (data: unknown) => NotificationPayload | null | undefined;
}

const CLICK_MESSAGE_TYPE = "nexuspulse:notification-click";

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object";
}

function defaultDecodePush(data: unknown): NotificationPayload | undefined {
  if (!isRecord(data) || typeof data.title !== "string" || !data.title) {
    return undefined;
  }
  return data as unknown as NotificationPayload;
}

async function readPushPayload(
  event: NexusPulsePushEvent,
  decode: (data: unknown) => NotificationPayload | null | undefined,
): Promise<NotificationPayload | undefined> {
  if (!event.data) return undefined;

  let value: unknown;
  if (typeof event.data.json === "function") {
    try {
      value = event.data.json();
    } catch {
      value = undefined;
    }
  }
  if (value === undefined && typeof event.data.text === "function") {
    try {
      const text = event.data.text();
      value = JSON.parse(text) as unknown;
    } catch {
      value = undefined;
    }
  }

  return decode(value) ?? undefined;
}

function notificationOptions(
  payload: NotificationPayload,
): NexusPulseNotificationOptions {
  const options: NexusPulseNotificationOptions = {};
  if (payload.body !== undefined) options.body = payload.body;
  if (payload.icon !== undefined) options.icon = payload.icon;
  if (payload.badge !== undefined) options.badge = payload.badge;
  if (payload.tag !== undefined) options.tag = payload.tag;
  if (payload.actions !== undefined) options.actions = payload.actions;
  if (payload.timestamp !== undefined) options.timestamp = payload.timestamp;
  if (payload.requireInteraction !== undefined) {
    options.requireInteraction = payload.requireInteraction;
  }
  if (payload.silent !== undefined) options.silent = payload.silent;

  if (payload.data !== undefined || payload.url !== undefined) {
    const data = isRecord(payload.data) ? { ...payload.data } : {};
    if (payload.url !== undefined) data.url = payload.url;
    options.data = Object.keys(data).length > 0 ? data : payload.data;
  }
  return options;
}

function originOf(value: string): string | undefined {
  try {
    return new URL(value).origin;
  } catch {
    return undefined;
  }
}

function resolveClickUrl(
  rawUrl: unknown,
  baseOrigin: string | undefined,
): URL | undefined {
  if (typeof rawUrl !== "string" || rawUrl.length === 0) return undefined;
  try {
    return new URL(rawUrl, baseOrigin);
  } catch {
    throw new InvalidConfigurationError(
      "Notification click URL must be a valid absolute or relative URL",
    );
  }
}

function isAllowedOrigin(
  url: URL,
  baseOrigin: string | undefined,
  allowedOrigins: string[],
): boolean {
  if (url.origin === baseOrigin) return true;
  return allowedOrigins.some((origin) => originOf(origin) === url.origin);
}

async function handlePush(
  scope: NexusPulseWorkerScope,
  event: NexusPulsePushEvent,
  decode: (data: unknown) => NotificationPayload | null | undefined,
): Promise<void> {
  const payload = await readPushPayload(event, decode);
  if (!payload) return;
  await scope.registration.showNotification(
    payload.title,
    notificationOptions(payload),
  );
}

async function handleNotificationClick(
  scope: NexusPulseWorkerScope,
  event: NexusPulseNotificationClickEvent,
  allowedOrigins: string[],
): Promise<void> {
  event.notification.close?.();

  const data = isRecord(event.notification.data)
    ? event.notification.data
    : undefined;
  const baseOrigin = scope.location?.origin;
  const targetUrl = resolveClickUrl(data?.url, baseOrigin);

  if (targetUrl && !isAllowedOrigin(targetUrl, baseOrigin, allowedOrigins)) {
    throw new InvalidConfigurationError(
      `Notification click URL uses a disallowed origin: ${targetUrl.origin}`,
    );
  }

  const clients = await scope.clients.matchAll({
    type: "window",
    includeUncontrolled: true,
  });
  const sameOriginClient = clients.find((client) => {
    if (!baseOrigin) return false;
    try {
      return new URL(client.url).origin === baseOrigin;
    } catch {
      return false;
    }
  });
  const matchingClient =
    sameOriginClient ??
    clients.find((client) => {
      if (!targetUrl) return false;
      try {
        return new URL(client.url).href === targetUrl.href;
      } catch {
        return false;
      }
    });

  if (matchingClient) {
    await matchingClient.focus?.();
    matchingClient.postMessage?.({
      type: CLICK_MESSAGE_TYPE,
      action: event.action,
      data: event.notification.data,
    });
    return;
  }

  if (targetUrl) {
    const openedClient = await scope.clients.openWindow(targetUrl.href);
    openedClient?.postMessage?.({
      type: CLICK_MESSAGE_TYPE,
      action: event.action,
      data: event.notification.data,
    });
  }
}

export function installNexusPulseServiceWorker(
  options: NexusPulseServiceWorkerOptions = {},
): void {
  const candidate = options.scope ?? globalThis;
  if (
    typeof (candidate as Partial<NexusPulseWorkerScope>).addEventListener !==
      "function" ||
    !(candidate as Partial<NexusPulseWorkerScope>).registration ||
    typeof (candidate as Partial<NexusPulseWorkerScope>).registration
      ?.showNotification !== "function" ||
    !(candidate as Partial<NexusPulseWorkerScope>).clients ||
    typeof (candidate as Partial<NexusPulseWorkerScope>).clients?.matchAll !==
      "function" ||
    typeof (candidate as Partial<NexusPulseWorkerScope>).clients?.openWindow !==
      "function"
  ) {
    throw new UnsupportedFeatureError(
      "The Service Worker notification APIs are not supported",
    );
  }

  const scope = candidate as NexusPulseWorkerScope;
  const decode = options.decodePush ?? defaultDecodePush;
  const allowedOrigins = options.allowedOrigins ?? [];
  scope.addEventListener("push", (event) => {
    event.waitUntil(handlePush(scope, event, decode));
  });
  scope.addEventListener("notificationclick", (event) => {
    event.waitUntil(handleNotificationClick(scope, event, allowedOrigins));
  });
}
