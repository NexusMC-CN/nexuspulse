import { describe, expect, it, vi } from "vitest";
import Fastify from "fastify";
import {
  NotificationService,
  type FastifyInstanceLike,
  type FastifyReplyLike,
  type PushSubscriptionRecord,
  type SubscriptionStore,
} from "../src/index.js";
import {
  createNexusPulseFastifyPlugin,
  nexusPulseFastify,
} from "../src/fastify.js";

type RegisteredHandler = (...args: unknown[]) => unknown;

function createFastify() {
  const routes = new Map<string, RegisteredHandler>();
  const fastify: FastifyInstanceLike = {
    post(path, handler) {
      routes.set(`POST ${path}`, handler as RegisteredHandler);
    },
    delete(path, handler) {
      routes.set(`DELETE ${path}`, handler as RegisteredHandler);
    },
    get(path, _options, handler) {
      routes.set(`GET ${path}`, handler as RegisteredHandler);
    },
    decorate(name, value) {
      (fastify as unknown as Record<string, unknown>)[name] = value;
    },
  };
  return { fastify, routes };
}

function reply() {
  const response = { status: 200, body: undefined as unknown };
  const result: FastifyReplyLike = {
    code(status) {
      response.status = status;
      return result;
    },
    send(body) {
      response.body = body;
      return body;
    },
  };
  return { result, response };
}

describe("createNexusPulseFastifyPlugin", () => {
  it("registers through the optional Fastify peer adapter", async () => {
    const records: PushSubscriptionRecord[] = [];
    const service = new NotificationService({
      store: {
        async upsert(userId, subscription) {
          const record = { ...subscription, id: "sub-1", userId };
          records.push(record);
          return record;
        },
        async removeForUser(userId, id) {
          const index = records.findIndex(
            (record) => record.userId === userId && record.id === id,
          );
          if (index < 0) return false;
          records.splice(index, 1);
          return true;
        },
        async listByUser(userId) {
          return records.filter((record) => record.userId === userId);
        },
      },
      subscriptionValidation: {
        allowedEndpointOrigins: ["https://push.example"],
      },
    });
    const app = Fastify();
    await app.register(nexusPulseFastify, {
      service,
      resolveUserId: () => "user-1",
    });
    const response = await app.inject({
      method: "POST",
      url: "/nexuspulse/subscriptions",
      payload: {
        endpoint: "https://push.example/subscription",
        keys: { p256dh: "p256dh", auth: "auth" },
      },
    });
    await app.close();

    expect(response.statusCode).toBe(201);
    expect(response.json()).toMatchObject({ id: "sub-1", userId: "user-1" });
  });

  it("registers authenticated subscription routes", async () => {
    const records: PushSubscriptionRecord[] = [];
    const listByUser = vi.fn(async (userId: string) =>
      records.filter((record) => record.userId === userId),
    );
    const store: SubscriptionStore = {
      async upsert(userId, subscription) {
        const record = { ...subscription, id: "sub-1", userId };
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
      listByUser,
    };
    const service = new NotificationService({
      store,
      subscriptionValidation: {
        allowedEndpointOrigins: ["https://push.example"],
      },
    });
    const { fastify, routes } = createFastify();
    await createNexusPulseFastifyPlugin({
      service,
      prefix: "/api/notifications",
      resolveUserId: (request) => String((request.user as { id: string }).id),
    })(fastify);

    const post = routes.get("POST /api/notifications/subscriptions");
    expect(post).toBeDefined();
    const postReply = reply();
    await post?.(
      {
        user: { id: "user-1" },
        body: {
          subscription: {
            endpoint: "https://push.example/subscription",
            keys: { p256dh: "p256dh", auth: "auth" },
          },
        },
      },
      postReply.result,
    );
    expect(postReply.response.status).toBe(201);
    expect(postReply.response.body).toMatchObject({
      id: "sub-1",
      userId: "user-1",
    });

    const remove = routes.get("DELETE /api/notifications/subscriptions/:id");
    const deleteReply = reply();
    await remove?.(
      { user: { id: "user-1" }, params: { id: "sub-1" } },
      deleteReply.result,
    );
    expect(deleteReply.response.status).toBe(204);
    expect(listByUser).not.toHaveBeenCalled();
  });

  it("returns 401 when the user resolver cannot authenticate a request", async () => {
    const service = new NotificationService({
      store: {
        upsert: vi.fn(),
        removeForUser: vi.fn(),
        listByUser: vi.fn(),
      },
    });
    const { fastify, routes } = createFastify();
    await createNexusPulseFastifyPlugin({
      service,
      resolveUserId: () => undefined,
    })(fastify);
    const postReply = reply();
    await routes.get("POST /nexuspulse/subscriptions")?.({}, postReply.result);
    expect(postReply.response.status).toBe(401);
  });

  it("delegates an optional websocket route to the host integration", async () => {
    const service = new NotificationService({
      store: {
        upsert: vi.fn(),
        removeForUser: vi.fn(),
        listByUser: vi.fn(),
      },
    });
    const { fastify, routes } = createFastify();
    const onWebSocket = vi.fn(async () => "accepted");
    await createNexusPulseFastifyPlugin({
      service,
      resolveUserId: () => "user-1",
      websocket: { path: "/socket", onWebSocket },
    })(fastify);

    const socket = { close: vi.fn() };
    await routes.get("GET /nexuspulse/socket")?.(socket, {});

    expect(onWebSocket).toHaveBeenCalledOnce();
    expect(onWebSocket).toHaveBeenCalledWith(socket, {}, "user-1", service);
  });

  it("closes unauthenticated websocket clients", async () => {
    const service = new NotificationService({
      store: {
        upsert: vi.fn(),
        removeForUser: vi.fn(),
        listByUser: vi.fn(),
      },
    });
    const { fastify, routes } = createFastify();
    await createNexusPulseFastifyPlugin({
      service,
      resolveUserId: () => undefined,
      websocket: { onWebSocket: vi.fn() },
    })(fastify);

    const socket = { close: vi.fn() };
    await routes.get("GET /nexuspulse/websocket")?.(socket, {});

    expect(socket.close).toHaveBeenCalledWith(1008, "Unauthorized");
  });

  it("normalizes a websocket path without a leading slash", async () => {
    const service = new NotificationService({
      store: {
        upsert: vi.fn(),
        removeForUser: vi.fn(),
        listByUser: vi.fn(),
      },
    });
    const { fastify, routes } = createFastify();
    await createNexusPulseFastifyPlugin({
      service,
      resolveUserId: () => "user-1",
      websocket: { path: "socket", onWebSocket: vi.fn() },
    })(fastify);

    expect(routes.has("GET /nexuspulse/socket")).toBe(true);
    expect(routes.has("GET /nexuspulsesocket")).toBe(false);
  });
});
