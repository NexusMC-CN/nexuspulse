import { describe, expect, it, vi } from "vitest";

import {
  ensureServiceWorkerRegistration,
  subscribePush,
  unsubscribePush,
} from "../src/push.js";
import {
  InvalidConfigurationError,
  PermissionDeniedError,
  SubscriptionError,
  UnsupportedFeatureError,
} from "../src/errors.js";

function registration(overrides: Record<string, unknown> = {}) {
  return {
    pushManager: {
      subscribe: vi.fn(),
      ...((overrides.pushManager as Record<string, unknown> | undefined) ?? {}),
    },
    ...overrides,
  } as unknown as ServiceWorkerRegistration;
}

describe("service worker and push adapter", () => {
  it("reuses a configured registration unchanged", async () => {
    const configured = registration();
    const runtime = { navigator: { serviceWorker: { register: vi.fn() } } };

    await expect(
      ensureServiceWorkerRegistration(
        { registration: configured, url: "/ignored.js" },
        runtime,
      ),
    ).resolves.toBe(configured);
    expect(runtime.navigator.serviceWorker.register).not.toHaveBeenCalled();
  });

  it("registers the configured worker URL and scope", async () => {
    const registered = registration();
    const register = vi.fn().mockResolvedValue(registered);
    const runtime = { navigator: { serviceWorker: { register } } };

    await expect(
      ensureServiceWorkerRegistration(
        { url: "/worker.js", scope: "/app/" },
        runtime,
      ),
    ).resolves.toBe(registered);
    expect(register).toHaveBeenCalledWith("/worker.js", { scope: "/app/" });
  });

  it("waits for navigator.serviceWorker.ready after a new registration", async () => {
    const registered = registration();
    const ready = registration();
    const register = vi.fn().mockResolvedValue(registered);
    const runtime = {
      navigator: { serviceWorker: { register, ready: Promise.resolve(ready) } },
    };

    await expect(
      ensureServiceWorkerRegistration({ url: "/worker.js" }, runtime),
    ).resolves.toBe(ready);
  });

  it("rejects a missing worker URL without a configured registration", async () => {
    await expect(
      ensureServiceWorkerRegistration({}, {}),
    ).rejects.toBeInstanceOf(InvalidConfigurationError);
  });

  it("rejects push subscription configuration without an application server key", async () => {
    const configured = registration();
    await expect(
      subscribePush({ serviceWorker: { registration: configured } }, {}),
    ).rejects.toBeInstanceOf(InvalidConfigurationError);
  });

  it("subscribes with the application key and options", async () => {
    const configured = registration();
    const subscription = { endpoint: "https://push.example.test" };
    const subscribe = vi
      .spyOn(configured.pushManager, "subscribe")
      .mockResolvedValue(subscription as unknown as PushSubscription);
    const key = "public-key";
    const subscribeOptions = { userVisibleOnly: true };

    await expect(
      subscribePush(
        {
          serviceWorker: { registration: configured },
          applicationServerKey: key,
          subscribeOptions,
        },
        { Notification: { permission: "granted" } },
      ),
    ).resolves.toBe(subscription);
    expect(subscribe).toHaveBeenCalledWith({
      ...subscribeOptions,
      applicationServerKey: key,
    });
  });

  it("defaults push subscriptions to userVisibleOnly", async () => {
    const configured = registration();
    const subscribe = vi
      .spyOn(configured.pushManager, "subscribe")
      .mockResolvedValue({} as PushSubscription);

    await subscribePush(
      {
        serviceWorker: { registration: configured },
        applicationServerKey: "key",
      },
      { Notification: { permission: "granted" } },
    );

    expect(subscribe).toHaveBeenCalledWith({
      userVisibleOnly: true,
      applicationServerKey: "key",
    });
  });

  it("maps an unavailable Push API to UnsupportedFeatureError", async () => {
    const configured = {
      pushManager: undefined,
    } as unknown as ServiceWorkerRegistration;
    await expect(
      subscribePush(
        {
          serviceWorker: { registration: configured },
          applicationServerKey: "key",
        },
        { Notification: { permission: "granted" } },
      ),
    ).rejects.toBeInstanceOf(UnsupportedFeatureError);
  });

  it("maps a rejected subscribe call to SubscriptionError", async () => {
    const configured = registration();
    vi.spyOn(configured.pushManager, "subscribe").mockRejectedValue(
      new Error("network failure"),
    );
    await expect(
      subscribePush(
        {
          serviceWorker: { registration: configured },
          applicationServerKey: "key",
        },
        { Notification: { permission: "granted" } },
      ),
    ).rejects.toBeInstanceOf(SubscriptionError);
  });

  it("maps denied notification permission to PermissionDeniedError", async () => {
    const configured = registration();
    await expect(
      subscribePush(
        {
          serviceWorker: { registration: configured },
          applicationServerKey: "key",
        },
        { Notification: { permission: "denied" } },
      ),
    ).rejects.toBeInstanceOf(PermissionDeniedError);
  });

  it("returns the underlying unsubscribe result", async () => {
    const unsubscribe = vi.fn().mockResolvedValue(true);
    const subscription = { unsubscribe } as unknown as PushSubscription;

    await expect(unsubscribePush(subscription)).resolves.toBe(true);
    expect(unsubscribe).toHaveBeenCalledTimes(1);
  });
});
