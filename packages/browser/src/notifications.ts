import type { NotificationAction, NotificationPayload } from "./types.js";
import { PermissionDeniedError, UnsupportedFeatureError } from "./errors.js";

type RuntimeRecord = Record<string, unknown>;

function asRecord(value: unknown): RuntimeRecord | undefined {
  return value !== null &&
    (typeof value === "object" || typeof value === "function")
    ? (value as RuntimeRecord)
    : undefined;
}

interface NotificationConstructor {
  new (title: string, options?: NotificationOptionsWithExtras): Notification;
  permission?: NotificationPermission;
  requestPermission?: () => Promise<NotificationPermission>;
}

type NotificationOptionsWithExtras = NotificationOptions & {
  actions?: NotificationAction[];
  timestamp?: number;
};

function getNotification(runtime: unknown): NotificationConstructor {
  const constructor = asRecord(runtime)?.Notification;
  if (typeof constructor !== "function") {
    throw new UnsupportedFeatureError("The Notification API is not supported");
  }
  return constructor as unknown as NotificationConstructor;
}

export async function requestNotificationPermission(
  runtime: unknown = globalThis,
): Promise<NotificationPermission> {
  const notification = getNotification(runtime);
  const permission = notification.permission;

  if (permission === "granted") {
    return permission;
  }
  if (permission === "denied") {
    throw new PermissionDeniedError();
  }
  if (typeof notification.requestPermission !== "function") {
    throw new UnsupportedFeatureError(
      "The Notification permission API is not supported",
    );
  }

  const result = await notification.requestPermission();
  if (result === "denied") {
    throw new PermissionDeniedError();
  }
  return result;
}

export function showNotification(
  payload: NotificationPayload,
  runtime: unknown = globalThis,
): Notification {
  const notification = getNotification(runtime);
  const options: NotificationOptionsWithExtras = {};

  if (payload.body !== undefined) options.body = payload.body;
  if (payload.icon !== undefined) options.icon = payload.icon;
  if (payload.badge !== undefined) options.badge = payload.badge;
  if (payload.tag !== undefined) options.tag = payload.tag;
  if (payload.data !== undefined) options.data = payload.data;
  if (payload.actions !== undefined) options.actions = payload.actions;
  if (payload.timestamp !== undefined) options.timestamp = payload.timestamp;
  if (payload.requireInteraction !== undefined) {
    options.requireInteraction = payload.requireInteraction;
  }
  if (payload.silent !== undefined) options.silent = payload.silent;

  return new notification(payload.title, options);
}
