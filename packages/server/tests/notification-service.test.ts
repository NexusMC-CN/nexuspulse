import { describe, expect, it, vi } from "vitest";
import {
  InvalidSubscriptionError,
  NotificationService,
  type PushSubscriptionRecord,
  type PushSubscriptionInput,
  type SubscriptionStore,
} from "../src/index.js";

function createStore(initial: PushSubscriptionRecord[] = []) {
  const records = [...initial];
  const store: SubscriptionStore = {
    async upsert(userId, subscription) {
      const existing = records.find(
        (record) =>
          record.userId === userId && record.endpoint === subscription.endpoint,
      );
      if (existing) {
        Object.assign(existing, subscription);
        return existing;
      }
      const record = {
        ...subscription,
        id: `sub-${records.length + 1}`,
        userId,
      };
      records.push(record);
      return record;
    },
    async removeForUser(userId, id) {
      const index = records.findIndex(
        (record) => record.id === id && record.userId === userId,
      );
      if (index < 0) return false;
      records.splice(index, 1);
      return true;
    },
    async listByUser(userId) {
      return records.filter((record) => record.userId === userId);
    },
  };
  return { store, records };
}

const subscription: PushSubscriptionInput = {
  endpoint: "https://push.example/subscription",
  keys: { p256dh: "p256dh", auth: "auth" },
};

describe("NotificationService", () => {
  it("upserts subscriptions through the injected store", async () => {
    const { store } = createStore();
    const service = new NotificationService({
      store,
      subscriptionValidation: {
        allowedEndpointOrigins: ["https://push.example"],
      },
    });

    const first = await service.subscribe("user-1", subscription);
    const second = await service.subscribe("user-1", subscription);

    expect(first.id).toBe(second.id);
    expect(await service.listSubscriptions("user-1")).toHaveLength(1);
  });

  it("sends selected channels and removes invalid push subscriptions", async () => {
    const existing: PushSubscriptionRecord = {
      ...subscription,
      id: "sub-1",
      userId: "user-1",
    };
    const { store, records } = createStore([existing]);
    const push = {
      send: vi.fn(async () => {
        throw new InvalidSubscriptionError("gone");
      }),
    };
    const realtime = { publish: vi.fn(async () => undefined) };
    const service = new NotificationService({
      store,
      push,
      realtime,
      subscriptionValidation: {
        allowedEndpointOrigins: ["https://push.example"],
      },
    });

    const result = await service.send(
      "user-1",
      { title: "Ready", body: "Done" },
      ["push", "websocket"],
    );

    expect(push.send).toHaveBeenCalledOnce();
    expect(realtime.publish).toHaveBeenCalledOnce();
    expect(result.push.removed).toBe(1);
    expect(result.websocket.sent).toBe(true);
    expect(records).toHaveLength(0);
  });

  it("reports unavailable transports without constructing platform storage", async () => {
    const { store } = createStore();
    const service = new NotificationService({
      store,
      subscriptionValidation: {
        allowedEndpointOrigins: ["https://push.example"],
      },
    });

    const result = await service.send("user-1", { title: "Ready" }, ["push"]);

    expect(result.push.sent).toBe(0);
    expect(result.push.skipped).toBe(true);
  });

  it("rejects empty notification titles and unknown channels", async () => {
    const { store } = createStore();
    const service = new NotificationService({ store });

    await expect(service.send("user-1", { title: " " })).rejects.toThrow(
      "A notification title is required",
    );
    await expect(
      service.send("user-1", { title: "Ready" }, ["email" as never]),
    ).rejects.toThrow("Unsupported notification channel");
  });

  it("reports cleanup and invalid-subscription callback failures", async () => {
    const existing: PushSubscriptionRecord = {
      ...subscription,
      id: "sub-1",
      userId: "user-1",
    };
    const store: SubscriptionStore = {
      upsert: vi.fn(),
      removeForUser: vi.fn(async () => {
        throw new Error("cleanup failed");
      }),
      listByUser: vi.fn(async () => [existing]),
    };
    const service = new NotificationService({
      store,
      push: {
        send: vi.fn(async () => {
          throw new InvalidSubscriptionError("gone");
        }),
      },
      subscriptionValidation: {
        allowedEndpointOrigins: ["https://push.example"],
      },
      onInvalidSubscription: async () => {
        throw new Error("audit failed");
      },
    });

    const result = await service.send("user-1", { title: "Ready" }, ["push"]);

    expect(result.push.failed).toBe(1);
    expect(result.push.removed).toBe(0);
    expect(result.push.errors).toHaveLength(3);
    expect(result.push.errors).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ message: "gone" }),
        expect.objectContaining({ message: "cleanup failed" }),
        expect.objectContaining({ message: "audit failed" }),
      ]),
    );
  });

  it("rejects empty user ids before calling host storage or transports", async () => {
    const { store } = createStore();
    const service = new NotificationService({ store });

    await expect(service.send("", { title: "Ready" })).rejects.toThrow(
      "A user id is required",
    );
    await expect(service.listSubscriptions(" ")).rejects.toThrow(
      "A user id is required",
    );
  });

  it("rejects injected fields, insecure endpoints, and private endpoints", async () => {
    const { store } = createStore();
    const service = new NotificationService({
      store,
      subscriptionValidation: {
        allowedEndpointOrigins: ["https://push.example"],
      },
    });

    await expect(
      service.subscribe("user-1", {
        ...subscription,
        role: "admin",
      } as PushSubscriptionInput & { role: string }),
    ).rejects.toThrow("Unsupported subscription field: role");
    await expect(
      service.subscribe("user-1", {
        ...subscription,
        endpoint: "http://push.example/subscription",
      }),
    ).rejects.toThrow("must use HTTPS");
    await expect(
      service.subscribe("user-1", {
        ...subscription,
        endpoint: "https://127.0.0.1/subscription",
      }),
    ).rejects.toThrow("Private or local");
  });

  it("allows a host-owned endpoint allowlist and stores a normalized copy", async () => {
    const { store } = createStore();
    const service = new NotificationService({
      store,
      subscriptionValidation: {
        allowedEndpointOrigins: ["https://127.0.0.1"],
      },
    });

    const saved = await service.subscribe("user-1", {
      endpoint: "https://127.0.0.1/subscription",
      keys: { p256dh: "p256dh", auth: "auth" },
    });
    expect(saved.endpoint).toBe("https://127.0.0.1/subscription");
  });

  it("limits push fanout concurrency and retries transient failures", async () => {
    const initial = Array.from({ length: 5 }, (_, index) => ({
      ...subscription,
      endpoint: `https://push.example/${index}`,
      id: `sub-${index}`,
      userId: "user-1",
    }));
    const { store } = createStore(initial);
    let active = 0;
    let maxActive = 0;
    const attempts = new Map<string, number>();
    const push = {
      send: vi.fn(async (record: PushSubscriptionRecord) => {
        active += 1;
        maxActive = Math.max(maxActive, active);
        await new Promise((resolve) => setTimeout(resolve, 2));
        active -= 1;
        const count = (attempts.get(record.id) ?? 0) + 1;
        attempts.set(record.id, count);
        if (count === 1) throw new Error("temporary");
      }),
    };
    const service = new NotificationService({
      store,
      push,
      subscriptionValidation: {
        allowedEndpointOrigins: ["https://push.example"],
      },
      pushDispatch: {
        concurrency: 2,
        retries: 1,
        retryDelayMs: 0,
      },
    });

    const result = await service.send("user-1", { title: "Ready" }, ["push"]);

    expect(maxActive).toBeLessThanOrEqual(2);
    expect(result.push.sent).toBe(5);
    expect(result.push.failed).toBe(0);
    expect(push.send).toHaveBeenCalledTimes(10);
  });

  it("records timed out deliveries after retry exhaustion", async () => {
    const { store } = createStore([
      { ...subscription, id: "sub-1", userId: "user-1" },
    ]);
    let signal: AbortSignal | undefined;
    const service = new NotificationService({
      store,
      push: {
        send: async (_subscription, _payload, requestSignal) => {
          signal = requestSignal;
          return new Promise<void>(() => undefined);
        },
      },
      subscriptionValidation: {
        allowedEndpointOrigins: ["https://push.example"],
      },
      pushDispatch: { timeoutMs: 5, retries: 0 },
    });

    const result = await service.send("user-1", { title: "Ready" }, ["push"]);

    expect(result.push.failed).toBe(1);
    expect(result.push.errors[0]).toMatchObject({
      name: "PushDeliveryTimeoutError",
    });
    expect(signal?.aborted).toBe(true);
  });

  it("does not send legacy records that fail endpoint policy", async () => {
    const push = { send: vi.fn(async () => undefined) };
    const { store } = createStore([
      {
        ...subscription,
        endpoint: "https://127.0.0.1/legacy",
        id: "sub-1",
        userId: "user-1",
      },
    ]);
    const service = new NotificationService({
      store,
      push,
      subscriptionValidation: {
        allowedEndpointOrigins: ["https://push.example"],
      },
    });

    const result = await service.send("user-1", { title: "Ready" }, ["push"]);

    expect(push.send).not.toHaveBeenCalled();
    expect(result.push.failed).toBe(1);
    expect(result.push.removed).toBe(1);
  });

  it("does not retry transport-classified invalid subscriptions", async () => {
    const { store } = createStore([
      { ...subscription, id: "sub-1", userId: "user-1" },
    ]);
    const send = vi.fn(async () => {
      throw new Error("gone");
    });
    const service = new NotificationService({
      store,
      push: { send, isInvalidError: () => true },
      subscriptionValidation: {
        allowedEndpointOrigins: ["https://push.example"],
      },
      pushDispatch: { retries: 3, retryDelayMs: 0 },
    });

    const result = await service.send("user-1", { title: "Ready" }, ["push"]);

    expect(send).toHaveBeenCalledOnce();
    expect(result.push.removed).toBe(1);
  });
});
