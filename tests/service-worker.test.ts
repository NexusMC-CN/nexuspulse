import { describe, expect, it, vi } from "vitest";

import {
  installNexusPulseServiceWorker,
  type NexusPulseWorkerScope,
} from "../src/service-worker.js";

type Listener = (event: Record<string, any>) => void;

function createScope() {
  const listeners = new Map<string, Listener>();
  const showNotification = vi.fn().mockResolvedValue(undefined);
  const matchAll = vi.fn().mockResolvedValue([]);
  const openWindow = vi.fn().mockResolvedValue(undefined);
  const scope = {
    location: { origin: "https://app.example.test" },
    registration: { showNotification },
    clients: { matchAll, openWindow },
    addEventListener: vi.fn((type: string, listener: Listener) => {
      listeners.set(type, listener);
    }),
  };

  return {
    scope: scope as unknown as NexusPulseWorkerScope,
    listeners,
    showNotification,
    matchAll,
    openWindow,
  };
}

function dispatch(
  listeners: Map<string, Listener>,
  type: string,
  event: Record<string, any>,
) {
  const listener = listeners.get(type);
  if (!listener) throw new Error(`Missing ${type} listener`);
  listener(event);
}

describe("NexusPulse service worker entry", () => {
  it("shows a notification for a JSON push payload", async () => {
    const { scope, listeners, showNotification } = createScope();
    installNexusPulseServiceWorker({ scope });

    const waitUntil = vi.fn((promise: Promise<unknown>) => promise);
    dispatch(listeners, "push", {
      data: { json: () => ({ title: "Build complete", body: "Ready" }) },
      waitUntil,
    });

    await waitUntil.mock.results[0]?.value;
    expect(showNotification).toHaveBeenCalledWith("Build complete", {
      body: "Ready",
    });
  });

  it("focuses a matching same-origin window and posts a click message", async () => {
    const { scope, listeners, matchAll, openWindow } = createScope();
    const client = {
      url: "https://app.example.test/inbox",
      focus: vi.fn().mockResolvedValue(undefined),
      postMessage: vi.fn(),
    };
    matchAll.mockResolvedValue([client]);
    installNexusPulseServiceWorker({ scope });

    const waitUntil = vi.fn((promise: Promise<unknown>) => promise);
    dispatch(listeners, "notificationclick", {
      notification: {
        close: vi.fn(),
        data: { url: "/inbox", id: "n-1" },
      },
      waitUntil,
    });

    await waitUntil.mock.results[0]?.value;
    expect(client.focus).toHaveBeenCalledOnce();
    expect(client.postMessage).toHaveBeenCalledWith({
      type: "nexuspulse:notification-click",
      action: undefined,
      data: { url: "/inbox", id: "n-1" },
    });
    expect(openWindow).not.toHaveBeenCalled();
  });

  it("reuses any same-origin window before opening a different notification URL", async () => {
    const { scope, listeners, matchAll, openWindow } = createScope();
    const client = {
      url: "https://app.example.test/",
      focus: vi.fn().mockResolvedValue(undefined),
      postMessage: vi.fn(),
    };
    matchAll.mockResolvedValue([client]);
    installNexusPulseServiceWorker({ scope });

    const waitUntil = vi.fn((promise: Promise<unknown>) => promise);
    dispatch(listeners, "notificationclick", {
      notification: {
        close: vi.fn(),
        data: { url: "/inbox", id: "n-2" },
      },
      waitUntil,
    });

    await waitUntil.mock.results[0]?.value;
    expect(client.focus).toHaveBeenCalledOnce();
    expect(client.postMessage).toHaveBeenCalledWith({
      type: "nexuspulse:notification-click",
      action: undefined,
      data: { url: "/inbox", id: "n-2" },
    });
    expect(openWindow).not.toHaveBeenCalled();
  });

  it("opens an allowed same-origin URL when no matching window exists", async () => {
    const { scope, listeners, openWindow } = createScope();
    installNexusPulseServiceWorker({ scope });

    const waitUntil = vi.fn((promise: Promise<unknown>) => promise);
    dispatch(listeners, "notificationclick", {
      notification: {
        close: vi.fn(),
        data: { url: "/settings" },
      },
      waitUntil,
    });

    await waitUntil.mock.results[0]?.value;
    expect(openWindow).toHaveBeenCalledWith(
      "https://app.example.test/settings",
    );
  });

  it("rejects disallowed cross-origin notification URLs", async () => {
    const { scope, listeners, openWindow } = createScope();
    installNexusPulseServiceWorker({ scope });

    const waitUntil = vi.fn((promise: Promise<unknown>) => promise);
    dispatch(listeners, "notificationclick", {
      notification: {
        close: vi.fn(),
        data: { url: "https://evil.example.test/phishing" },
      },
      waitUntil,
    });

    await expect(waitUntil.mock.results[0]?.value).rejects.toThrow(
      /disallowed origin/i,
    );
    expect(openWindow).not.toHaveBeenCalled();
  });

  it("opens an explicitly allowed cross-origin URL", async () => {
    const { scope, listeners, openWindow } = createScope();
    installNexusPulseServiceWorker({
      scope,
      allowedOrigins: ["https://docs.example.test"],
    });

    const waitUntil = vi.fn((promise: Promise<unknown>) => promise);
    dispatch(listeners, "notificationclick", {
      notification: {
        close: vi.fn(),
        data: { url: "https://docs.example.test/guide" },
      },
      waitUntil,
    });

    await waitUntil.mock.results[0]?.value;
    expect(openWindow).toHaveBeenCalledWith("https://docs.example.test/guide");
  });
});
