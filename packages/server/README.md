# nexuspulse-server

`nexuspulse-server` provides the Node.js side of NexusPulse. It is framework-agnostic at its core and includes a Fastify adapter. Storage, caching, Push provider, and WebSocket connection management remain application-owned dependencies.

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

`SubscriptionStore` defines `upsert`, `listByUser`, and `removeForUser`. This package does not create a database table, cache, queue, or in-memory store. The application can choose Prisma, Redis, a remote subscription service, or another implementation and control its consistency and retention policy.

When a Push transport reports an invalid subscription, the service removes it with `removeForUser` and includes the cleanup in the delivery report. Other transport failures are returned in the report so the caller can decide whether to retry or log them.

## Fastify adapter

The adapter uses structural Fastify types and has no runtime Fastify dependency. It registers subscription routes under `/nexuspulse` by default:

```ts
import { createNexusPulseFastifyPlugin } from "nexuspulse-server";

await fastify.register(
  createNexusPulseFastifyPlugin({
    service,
    resolveUserId: (request) => request.user.id,
    prefix: "/api/notifications",
  }),
);
```

Routes are `POST /subscriptions` and `DELETE /subscriptions/:id`. The resolver is required so the existing application's authentication and tenant rules remain authoritative. Delete requests are checked against the authenticated user's subscriptions before removal.

WebSocket upgrades are optional and application-owned. Supply a GET hook when the host integration needs one. The adapter registers the route with the Fastify WebSocket option and passes the upgraded socket to the callback:

```ts
createNexusPulseFastifyPlugin({
  service,
  resolveUserId: (request) => request.user.id,
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
