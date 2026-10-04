import type { Capabilities } from "./types.js";

type RuntimeRecord = Record<string, unknown>;

function asRecord(value: unknown): RuntimeRecord | undefined {
  return value !== null &&
    (typeof value === "object" || typeof value === "function")
    ? (value as RuntimeRecord)
    : undefined;
}

function isObject(value: unknown): boolean {
  return value !== null && typeof value === "object";
}

export function detectCapabilities(
  runtime: unknown = globalThis,
): Capabilities {
  const root = asRecord(runtime);
  const navigator = asRecord(root?.navigator);

  return {
    notifications: typeof root?.Notification === "function",
    push: typeof root?.PushManager === "function",
    serviceWorker:
      isObject(root?.serviceWorker) || isObject(navigator?.serviceWorker),
    webSocket: typeof root?.WebSocket === "function",
    badging:
      typeof root?.setAppBadge === "function" ||
      typeof navigator?.setAppBadge === "function",
  };
}
