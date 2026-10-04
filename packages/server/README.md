# nexuspulse-server

`nexuspulse-server` provides the Node.js side of NexusPulse. The core is framework-agnostic; the Fastify integration is an optional `./fastify` entrypoint. Storage, caching, Push provider, queues, and WebSocket connection management remain application-owned dependencies.

## Install

```bash
npm install nexuspulse-server
```

## Core service

Inject a subscription store and the transports used by your application:

```ts
import { NotificationService } from "nexuspulse-server";

const service = new NotificationService({
  store: subscriptionStore,
  subscriptionValidation: {
    allowedEndpointOrigins: ["https://push.example"],
  },
  push: {
    async send(subscription, payload) {
      await webPush.sendNotification(subscription, JSON.stringify(payload));
    },
    isInvalidError(error) {
      return (
        error instanceof Error &&
        "statusCode" in error &&
        [404, 410].includes(Number(error.statusCode))
      );
    },
  },
  realtime: {
    publish: (userId, payload) => notificationHub.publish(userId, payload),
  },
});

await service.send(
  userId,
  {
    title: "Build complete",
    body: "Your build is ready.",
    url: "/builds/latest",
  },
  ["push", "websocket"],
);
```

`SubscriptionStore` defines `upsert`, `listByUser`, and `removeForUser`. `removeForUser` must be an atomic user-scoped delete; the service calls it directly so a stale list cannot turn a delete into a time-of-check/time-of-use race. This package does not create a database table, cache, queue, or in-memory store. The application can choose Prisma, Redis, a remote subscription service, or another implementation and control its consistency and retention policy.

Incoming subscriptions are copied into a strict allowlist (`endpoint`, `expirationTime`, and `keys`). Endpoints must be HTTPS, cannot contain credentials or fragments, and private/local addresses are rejected. The service requires `subscriptionValidation.allowedEndpointOrigins` or the asynchronous `validateEndpoint` callback before it accepts an endpoint. Use the callback when the host has a provider allowlist or DNS/IP egress policy; it is the boundary that prevents DNS rebinding and other network-level SSRF cases.

Push fanout is bounded and each attempt has a timeout. The transport receives an `AbortSignal` and should pass it to its HTTP client so timed-out requests can be cancelled. Configure `pushDispatch.concurrency`, `timeoutMs`, `retries`, and backoff values to match the Push provider. Invalid subscriptions are removed and are not retried by default; other failures are reported to the caller after the retry policy is exhausted.

When a Push transport reports an invalid subscription, the service removes it with `removeForUser` and includes the cleanup in the delivery report. Other transport failures are returned in the report so the caller can decide whether to retry or log them.

## Fastify adapter

Install Fastify when using the adapter:

```bash
npm install nexuspulse-server fastify
```

Import the optional entrypoint so the framework dependency is loaded only by applications that use it:

```ts
import { nexusPulseFastify } from "nexuspulse-server/fastify";

await fastify.register(nexusPulseFastify, {
  service,
  resolveUserId: (request) => (request.user as { id: string }).id,
  prefix: "/api/notifications",
});
```

Routes are `POST /subscriptions` and `DELETE /subscriptions/:id`. The resolver is required so the existing application's authentication and tenant rules remain authoritative. Deletion is an atomic user-scoped operation.

The adapter deliberately does not implement CSRF protection, rate limiting, body-size limits, authentication, or an error envelope. Register the host application's hooks/plugins and Fastify `bodyLimit` before registering this adapter. The host should also apply its own tenant authorization to `resolveUserId` and its own logging/metrics policy.

WebSocket upgrades are optional and application-owned. Supply a GET hook when the host integration needs one. The adapter registers the route with the Fastify WebSocket option and passes the upgraded socket to the callback:

```ts
await fastify.register(nexusPulseFastify, {
  service,
  resolveUserId: (request) => (request.user as { id: string }).id,
  websocket: {
    onWebSocket(socket, request, userId) {
      return websocketHost.accept(socket, request, { userId });
    },
  },
});
```

No broadcast route is registered. Sending notifications is a server-side application operation through `service.send`, where authorization and business rules can be applied before dispatch.

## Validation

```bash
npm run typecheck
npm test
npm run build
npm run format:check
```
