import { describe, expect, it, vi } from "vitest";

import {
  createNexusPulse,
  NexusPulse,
  InvalidConfigurationError,
} from "../src/index.js";

function notificationRuntime() {
  const shown = vi.fn(function Notification(this: unknown, title: string) {
    return { title, close: vi.fn() };
  });
  Object.assign(shown, {
    permission: "default" as NotificationPermission,
    requestPermission: vi.fn().mockResolvedValue("granted"),
  });
  return { Notification: shown };
}

function socketRuntime() {
  const sockets: Array<Record<string, any>> = [];
  const WebSocket = vi.fn(function FakeWebSocket() {
    const socket: Record<string, any> = {
      onopen: null,
      onmessage: null,
      onerror: null,
      onclose: null,
      close: vi.fn(),
    };
    sockets.push(socket);
    return socket;
  });
  return { runtime: { WebSocket }, sockets, WebSocket };
}

describe("NexusPulse runtime coordinator", () => {
  it("is SSR-safe at construction and exposes injected capabilities", () => {
    const runtime = {
      Notification: class Notification {},
      WebSocket: class {},
    };
    const pulse = createNexusPulse({}, runtime);

    expect(pulse).toBeInstanceOf(NexusPulse);
    expect(pulse.state).toBe("idle");
    expect(pulse.capabilities.notifications).toBe(true);
    expect(pulse.capabilities.webSocket).toBe(true);
  });

  it("initializes once, registers the configured worker, and emits lifecycle events", async () => {
    const register = vi.fn().mockResolvedValue({});
    const pulse = createNexusPulse(
      { serviceWorker: { url: "/worker.js", scope: "/app" } },
      { navigator: { serviceWorker: { register } } },
    );
    const states: string[] = [];
    const ready = vi.fn();
    pulse.on("statechange", (state) => states.push(state));
    pulse.on("ready", ready);

    await pulse.initialize();
    await pulse.initialize();

    expect(register).toHaveBeenCalledOnce();
    expect(states).toEqual(["initializing", "ready"]);
    expect(ready).toHaveBeenCalledOnce();
    expect(pulse.state).toBe("ready");
  });

  it("shares one in-flight initialization across concurrent callers", async () => {
    let resolveRegistration!: (registration: ServiceWorkerRegistration) => void;
    const registration = {} as ServiceWorkerRegistration;
    const register = vi.fn().mockImplementation(
      () =>
        new Promise<ServiceWorkerRegistration>((resolve) => {
          resolveRegistration = resolve;
        }),
    );
    const pulse = createNexusPulse(
      { serviceWorker: { url: "/worker.js" } },
      { navigator: { serviceWorker: { register } } },
    );
    const states: string[] = [];
    const ready = vi.fn();
    pulse.on("statechange", (state) => states.push(state));
    pulse.on("ready", ready);

    const first = pulse.initialize();
    const second = pulse.initialize();
    expect(second).toBe(first);
    expect(register).toHaveBeenCalledOnce();

    resolveRegistration(registration);
    await Promise.all([first, second]);

    expect(states).toEqual(["initializing", "ready"]);
    expect(ready).toHaveBeenCalledOnce();
  });

  it("clears a failed initialization so a later call can retry", async () => {
    const registration = {} as ServiceWorkerRegistration;
    const error = new Error("registration failed");
    const register = vi
      .fn()
      .mockRejectedValueOnce(error)
      .mockResolvedValueOnce(registration);
    const pulse = createNexusPulse(
      { serviceWorker: { url: "/worker.js" } },
      { navigator: { serviceWorker: { register } } },
    );

    await expect(pulse.initialize()).rejects.toBe(error);
    await expect(pulse.initialize()).resolves.toBeUndefined();

    expect(register).toHaveBeenCalledTimes(2);
    expect(pulse.state).toBe("ready");
  });

  it("reuses the registration returned by initialize for push subscription", async () => {
    const subscription = { unsubscribe: vi.fn().mockResolvedValue(true) };
    const registration = {
      pushManager: { subscribe: vi.fn().mockResolvedValue(subscription) },
    };
    const register = vi.fn().mockResolvedValue(registration);
    const pulse = createNexusPulse(
      {
        serviceWorker: { url: "/worker.js" },
        push: { applicationServerKey: "key" },
      },
      {
        navigator: { serviceWorker: { register } },
        Notification: { permission: "granted" },
      },
    );

    await pulse.initialize();
    await expect(pulse.subscribePush()).resolves.toBe(subscription);

    expect(register).toHaveBeenCalledOnce();
    expect(registration.pushManager.subscribe).toHaveBeenCalledOnce();
  });

  it("delegates permission and notification operations and emits events", async () => {
    const runtime = notificationRuntime();
    const pulse = createNexusPulse({}, runtime);
    const permissions: NotificationPermission[] = [];
    const notifications: unknown[] = [];
    pulse.on("permissionchange", (value) => permissions.push(value));
    pulse.on("notification", (value) => notifications.push(value));

    await expect(pulse.requestPermission()).resolves.toBe("granted");
    const payload = { title: "Hello", body: "World" };
    expect(pulse.notify(payload)).toMatchObject({ title: "Hello" });
    expect(permissions).toEqual(["granted"]);
    expect(notifications).toEqual([payload]);
  });

  it("subscribes and unsubscribes push using configured options", async () => {
    const subscription = { unsubscribe: vi.fn().mockResolvedValue(true) };
    const register = vi.fn().mockResolvedValue({
      pushManager: {
        subscribe: vi.fn().mockResolvedValue(subscription),
      },
    });
    const pulse = createNexusPulse(
      {
        push: { applicationServerKey: "key" },
        serviceWorker: { url: "/worker.js" },
      },
      {
        navigator: { serviceWorker: { register } },
        Notification: { permission: "granted" },
      },
    );
    const changes: unknown[] = [];
    pulse.on("subscriptionchange", (value) => changes.push(value));

    await expect(pulse.subscribePush()).resolves.toBe(subscription);
    await expect(
      pulse.unsubscribePush(subscription as unknown as PushSubscription),
    ).resolves.toBe(true);
    expect(changes).toEqual([subscription, null]);
  });

  it("uses and clears the current push subscription when unsubscribing without an argument", async () => {
    const subscription = { unsubscribe: vi.fn().mockResolvedValue(false) };
    const register = vi.fn().mockResolvedValue({
      pushManager: { subscribe: vi.fn().mockResolvedValue(subscription) },
    });
    const pulse = createNexusPulse(
      {
        push: { applicationServerKey: "key" },
        serviceWorker: { url: "/worker.js" },
      },
      {
        navigator: { serviceWorker: { register } },
        Notification: { permission: "granted" },
      },
    );
    const changes: unknown[] = [];
    pulse.on("subscriptionchange", (value) => changes.push(value));

    await pulse.subscribePush();
    await expect(pulse.unsubscribePush()).resolves.toBe(false);
    await expect(pulse.unsubscribePush()).resolves.toBe(false);

    expect(subscription.unsubscribe).toHaveBeenCalledOnce();
    expect(changes).toEqual([subscription, null, null]);
  });

  it("coordinates websocket lifecycle and emits message before notification", async () => {
    const { runtime, sockets } = socketRuntime();
    const notifications = notificationRuntime();
    const pulse = createNexusPulse(
      {
        webSocket: {
          url: "ws://example.test",
          decodeMessage: () => ({ title: "Ping" }),
        },
      },
      { ...runtime, ...notifications },
    );
    const events: string[] = [];
    pulse.on("message", () => events.push("message"));
    pulse.on("notification", () => events.push("notification"));
    const connected = vi.fn();
    const disconnected = vi.fn();
    pulse.on("connected", connected);
    pulse.on("disconnected", disconnected);

    const connecting = pulse.connect();
    sockets[0].onopen();
    await connecting;
    sockets[0].onmessage({ data: "payload" });
    pulse.disconnect();

    expect(events).toEqual(["message", "notification"]);
    expect(notifications.Notification).toHaveBeenCalledWith("Ping", {});
    expect(connected).toHaveBeenCalledOnce();
    expect(disconnected).toHaveBeenCalledOnce();
  });

  it("requires websocket configuration and reports badge errors", async () => {
    const pulse = createNexusPulse({}, {});
    const errors: Error[] = [];
    pulse.on("error", (value) => errors.push(value));
    await expect(pulse.connect()).rejects.toBeInstanceOf(
      InvalidConfigurationError,
    );
    expect(errors).toHaveLength(1);
    expect(errors[0]).toBeInstanceOf(InvalidConfigurationError);
    const error = new Error("badge failed");
    const setAppBadge = vi.fn().mockRejectedValue(error);
    const withBadge = createNexusPulse(
      { badge: { enabled: true } },
      { setAppBadge },
    );
    withBadge.on("error", (value) => errors.push(value));
    await expect(withBadge.setBadge(2)).rejects.toBe(error);
    expect(errors.at(-1)).toBe(error);
  });

  it("does not call badging APIs when badge support is disabled", async () => {
    const setAppBadge = vi.fn();
    const clearAppBadge = vi.fn();
    const pulse = createNexusPulse(
      { badge: { enabled: false } },
      { setAppBadge, clearAppBadge },
    );

    await expect(pulse.setBadge(2)).resolves.toBe(false);
    await expect(pulse.clearBadge()).resolves.toBe(false);
    expect(setAppBadge).not.toHaveBeenCalled();
    expect(clearAppBadge).not.toHaveBeenCalled();
  });

  it("disposes listeners and stops dispatch", () => {
    const pulse = createNexusPulse({}, {});
    const listener = vi.fn();
    pulse.on("statechange", listener);
    pulse.dispose();
    expect(pulse.state).toBe("stopped");
    expect(listener).not.toHaveBeenCalled();
    expect(pulse.on("statechange", listener)).toBeTypeOf("function");
  });

  it("does not revive a disposed instance when initialization resolves", async () => {
    let resolveRegistration!: (registration: ServiceWorkerRegistration) => void;
    const registrationPromise = new Promise<ServiceWorkerRegistration>(
      (resolve) => {
        resolveRegistration = resolve;
      },
    );
    const pulse = createNexusPulse(
      { serviceWorker: { url: "/worker.js" } },
      {
        navigator: {
          serviceWorker: {
            register: vi.fn().mockReturnValue(registrationPromise),
          },
        },
      },
    );

    const initialization = pulse.initialize();
    pulse.dispose();
    resolveRegistration({} as ServiceWorkerRegistration);

    await expect(initialization).resolves.toBeUndefined();
    expect(pulse.state).toBe("stopped");
  });

  it("unsubscribes individual listeners", async () => {
    const pulse = createNexusPulse({}, notificationRuntime());
    const listener = vi.fn();
    const unsubscribe = pulse.on("permissionchange", listener);
    unsubscribe();
    await pulse.requestPermission();
    expect(listener).not.toHaveBeenCalled();
  });
});
