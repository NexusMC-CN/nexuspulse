import { describe, expect, it } from "vitest";
import Fastify from "fastify";
import websocket from "@fastify/websocket";
import { setImmediate } from "node:timers/promises";
import type WebSocket from "ws";
import { NotificationService } from "../src/index.js";
import { nexusPulseFastify } from "../src/fastify.js";

function deferred<T>() {
  let resolve!: (value: T | PromiseLike<T>) => void;
  const promise = new Promise<T>((complete) => {
    resolve = complete;
  });
  return { promise, resolve };
}

function createService() {
  return new NotificationService({
    store: {
      async upsert(userId, subscription) {
        return { ...subscription, id: "sub-1", userId };
      },
      async removeForUser() {
        return false;
      },
      async listByUser() {
        return [];
      },
    },
  });
}

describe("Fastify WebSocket authentication", () => {
  it("resolves the identity after the host preHandler authenticates the request", async () => {
    const app = Fastify();
    const received: { message: string; userId: string }[] = [];
    let socket: WebSocket | undefined;
    app.decorateRequest("user", null);
    app.addHook("preHandler", async (request) => {
      Object.assign(request, { user: { id: "host-user" } });
    });
    await app.register(websocket);
    await app.register(nexusPulseFastify, {
      service: createService(),
      resolveUserId: (request) => (request.user as { id: string } | null)?.id,
      websocket: {
        onWebSocket(connection, _request, userId) {
          (connection as WebSocket).on("message", (message) => {
            received.push({ message: message.toString(), userId });
          });
        },
      },
    });
    await app.ready();

    try {
      socket = await app.injectWS("/nexuspulse/websocket");
      socket.send("authenticated by the host");
      await expect
        .poll(() => received)
        .toEqual([
          { message: "authenticated by the host", userId: "host-user" },
        ]);
    } finally {
      socket?.terminate();
      await app.close();
    }
  });

  it("waits for authentication before upgrading and receives the earliest client message", async () => {
    const app = Fastify();
    const service = createService();
    const authenticating = deferred<void>();
    const identity = deferred<string>();
    const received: { message: string; userId: string }[] = [];
    let opened = false;
    let resolutionCount = 0;
    let delegatedService: NotificationService | undefined;
    let socket: WebSocket | undefined;
    await app.register(websocket);
    await app.register(nexusPulseFastify, {
      service,
      async resolveUserId() {
        resolutionCount++;
        authenticating.resolve();
        return identity.promise;
      },
      websocket: {
        path: "/socket",
        onWebSocket(connection, _request, userId, hostService) {
          delegatedService = hostService;
          (connection as WebSocket).on("message", (message) => {
            received.push({ message: message.toString(), userId });
          });
        },
      },
    });
    await app.ready();

    const connecting = app.injectWS(
      "/nexuspulse/socket",
      {},
      {
        onOpen(connection) {
          opened = true;
          connection.send("first message");
        },
      },
    );

    try {
      await authenticating.promise;
      await setImmediate();
      expect(opened).toBe(false);
      identity.resolve("user-1");
      socket = await connecting;
      await expect
        .poll(() => received)
        .toEqual([{ message: "first message", userId: "user-1" }]);
      expect(resolutionCount).toBe(1);
      expect(delegatedService).toBe(service);
    } finally {
      identity.resolve("user-1");
      socket ??= await connecting;
      socket.terminate();
      await app.close();
    }
  });

  it.each([null, undefined, ""])(
    "rejects an unauthenticated upgrade with HTTP 401 for identity %s",
    async (identity) => {
      const app = Fastify();
      let delegated = false;
      let socket: WebSocket | undefined;
      await app.register(websocket);
      await app.register(nexusPulseFastify, {
        service: createService(),
        resolveUserId: async () => identity,
        websocket: {
          onWebSocket() {
            delegated = true;
          },
        },
      });
      await app.ready();

      try {
        const connecting = app
          .injectWS("/nexuspulse/websocket")
          .then((client) => {
            socket = client;
            return client;
          });
        await expect(connecting).rejects.toThrow(
          "Unexpected server response: 401",
        );
        const response = await app.inject("/nexuspulse/websocket");
        expect(response.statusCode).toBe(401);
        expect(response.json()).toEqual({ error: "MissingUserError" });
        expect(delegated).toBe(false);
      } finally {
        socket?.terminate();
        await app.close();
      }
    },
  );

  it.each(["throw", "reject"])(
    "reports a resolver %s through the HTTP error lifecycle before upgrade",
    async (failure) => {
      const app = Fastify();
      const cause = new Error("Authentication store unavailable");
      const errors: Error[] = [];
      let delegated = false;
      let socket: WebSocket | undefined;
      app.addHook("onError", async (_request, _reply, error) => {
        errors.push(error);
      });
      await app.register(websocket);
      await app.register(nexusPulseFastify, {
        service: createService(),
        resolveUserId() {
          if (failure === "throw") throw cause;
          return Promise.reject(cause);
        },
        websocket: {
          onWebSocket() {
            delegated = true;
          },
        },
      });
      await app.ready();

      try {
        const connecting = app
          .injectWS("/nexuspulse/websocket")
          .then((client) => {
            socket = client;
            return client;
          });
        await expect(connecting).rejects.toThrow(
          "Unexpected server response: 500",
        );
        expect(errors).toEqual([cause]);
        expect(errors[0]).toBe(cause);
        expect(delegated).toBe(false);
      } finally {
        socket?.terminate();
        await app.close();
      }
    },
  );

  it("keeps the resolved identity bound to each concurrent upgrade", async () => {
    const app = Fastify();
    const firstWaiting = deferred<void>();
    const secondWaiting = deferred<void>();
    const firstIdentity = deferred<string>();
    const secondIdentity = deferred<string>();
    const received: { message: string; userId: string }[] = [];
    let firstConnection: Promise<WebSocket> | undefined;
    let secondConnection: Promise<WebSocket> | undefined;
    await app.register(websocket);
    await app.register(nexusPulseFastify, {
      service: createService(),
      resolveUserId(request) {
        const headers = request.headers as { authorization: string };
        if (headers.authorization === "first") {
          firstWaiting.resolve();
          return firstIdentity.promise;
        }
        secondWaiting.resolve();
        return secondIdentity.promise;
      },
      websocket: {
        onWebSocket(connection, _request, userId) {
          (connection as WebSocket).on("message", (message) => {
            received.push({ message: message.toString(), userId });
          });
        },
      },
    });
    await app.ready();

    try {
      firstConnection = app.injectWS("/nexuspulse/websocket", {
        headers: { authorization: "first" },
      });
      await firstWaiting.promise;
      secondConnection = app.injectWS("/nexuspulse/websocket", {
        headers: { authorization: "second" },
      });
      await secondWaiting.promise;
      firstIdentity.resolve("user-1");
      secondIdentity.resolve("user-2");
      const [first, second] = await Promise.all([
        firstConnection,
        secondConnection,
      ]);
      second.send("from second");
      await expect
        .poll(() => received)
        .toEqual([{ message: "from second", userId: "user-2" }]);

      first.send("from first");
      await expect
        .poll(() => received)
        .toEqual([
          { message: "from second", userId: "user-2" },
          { message: "from first", userId: "user-1" },
        ]);
    } finally {
      firstIdentity.resolve("user-1");
      secondIdentity.resolve("user-2");
      for (const connecting of [firstConnection, secondConnection]) {
        if (connecting) (await connecting).terminate();
      }
      await app.close();
    }
  });
});
