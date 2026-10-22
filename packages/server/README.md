# `@nexusmc-cn/nexuspulse-server` 服务端包

`@nexusmc-cn/nexuspulse-server` 提供 `NexusPulse` 的 Node.js 服务端能力。核心部分不绑定框架，Fastify 集成通过可选的 `./fastify` 入口提供。存储、缓存、Push 服务商、队列和 WebSocket 连接管理由应用负责。

[npm 包页面](https://www.npmjs.com/package/@nexusmc-cn/nexuspulse-server) · [配套浏览器与协议包](https://www.npmjs.com/package/@nexusmc-cn/nexuspulse)

## 安装

```bash
npm install @nexusmc-cn/nexuspulse-server @nexusmc-cn/nexuspulse
```

`@nexusmc-cn/nexuspulse` 是必需的 peer dependency，服务端通过 `@nexusmc-cn/nexuspulse/protocol` 复用通知协议类型。Fastify 是可选依赖，仅使用适配器时需要安装。

原无 scope 包 `nexuspulse-server` 的使用方需要同时替换服务端包和共享协议包的依赖名称，并更新模块导入。HTTP 路径和应用集成接口保持不变。

## 核心服务

注入应用使用的订阅存储和传输实现：

```ts
import { NotificationService } from "@nexusmc-cn/nexuspulse-server";

const service = new NotificationService({
  store: subscriptionStore,
  subscriptionValidation: {
    allowedEndpointOrigins: ["https://push.example"],
  },
  push: {
    async send(subscription, payload, signal) {
      // 将 signal 传给实际使用的 HTTP 客户端；此处仅示意 Push SDK 调用。
      void signal;
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
    title: "构建完成",
    body: "你的构建已经可以使用。",
    url: "/builds/latest",
  },
  ["push", "websocket"],
);
```

## 文件上传结果通知

文件上传、结果持久化和文件访问授权由宿主应用负责。确认最终状态后，可以用同一通知协议发送结果：

```ts
const fileId = "file-123";
await service.send(userId, {
  title: "文件上传完成",
  body: "点击查看文件",
  url: `/files/${encodeURIComponent(fileId)}`,
  data: { kind: "file-upload", status: "completed", fileId },
});

const uploadId = "upload-123";
await service.send(userId, {
  title: "文件上传失败",
  body: "点击查看失败原因并重试",
  url: `/uploads/${encodeURIComponent(uploadId)}`,
  data: { kind: "file-upload", status: "failed", uploadId },
});
```

`data.fileId` 表示文件 ID，不应复用通知自身的 `id`。如果失败时尚未创建文件，则由宿主先保存以 `uploadId` 标识的失败记录，再发送含 `data.uploadId`、不含 `data.fileId` 的通知；已有文件 ID 时也可以附上 `data.fileId`。示例中的 `/uploads/:uploadId` 由宿主提供，详情页应从路径读取 `uploadId`，鉴权后展示失败原因或重试入口。`url` 宜使用稳定的详情页或失败记录页，避免通知保存期间链接失效。

`send()` 会独立尝试 Push 和 WebSocket；Push 订阅查询失败会写入 `result.push.errors` 并计为一次失败，不会阻断 WebSocket。返回的 `sent` 表示传输层调用成功，不代表用户已看到通知。上传结果应以宿主保存的业务状态为准。

`SubscriptionStore` 定义 `upsert`、`listByUser` 和 `removeForUser`。`removeForUser` 必须是按用户范围执行的原子删除；服务会直接调用它，避免过期列表造成检查与使用之间的竞态。此包不会创建数据库表、缓存、队列或内存存储。应用可以选择 Prisma、Redis、远程订阅服务或其他实现，并自行控制一致性和保留策略。

客户端提交的订阅仅接受严格白名单字段（`endpoint`、`expirationTime` 和 `keys`），未知字段会被拒绝。存储适配器返回的记录可以带有 `createdAt`、`updatedAt` 等元数据；投递前会单独提取协议字段，Push 传输只收到 `id`、`userId` 和通过校验的订阅字段。Endpoint 必须使用 HTTPS，不能包含凭据或片段，私有地址和本地地址会被拒绝。服务要求在接受 Endpoint 前配置 `subscriptionValidation.allowedEndpointOrigins` 或异步 `validateEndpoint` 回调。当宿主有服务商白名单或 DNS/IP 出站策略时，应使用该回调；它是阻止 DNS rebinding 和其他网络层 SSRF 风险的边界。

`validateEndpoint` 返回 `false` 表示确定拒绝该 Endpoint，订阅请求会报 `InvalidSubscriptionInputError`，投递时会清理对应记录。回调抛错或 Promise 拒绝表示策略执行失败（例如临时 DNS 故障），会统一包装为 `EndpointValidationError`，通过 `cause` 保留原始异常；即使回调主动抛出 `InvalidSubscriptionInputError`，也遵循此规则。此时不会调用 Push 传输或删除订阅，投递报告会记录 `failed` 和错误，宿主可在策略恢复后再次调用 `send`。订阅请求会向宿主传播该错误，默认 Fastify 响应为 500，便于稍后重试。

Push 扇出投递具有并发上限，每次尝试都有超时。传输实现会收到 `AbortSignal`，应将它传给 HTTP 客户端，以便取消超时请求。根据 Push 服务商配置 `pushDispatch.concurrency`、`timeoutMs`、`retries` 和退避参数。无效订阅会被删除，默认不会重试；其他失败会在重试策略耗尽后返回给调用方。

当 Push 传输报告订阅无效时，服务会通过 `removeForUser` 删除该订阅，并在投递报告中记录清理结果。其他传输失败也会返回在报告中，由调用方决定是否重试或记录日志。

## Fastify 适配器

使用适配器时安装 Fastify 5：

```bash
npm install @nexusmc-cn/nexuspulse-server @nexusmc-cn/nexuspulse fastify@5
```

从可选入口导入适配器，只有使用它的应用才会加载框架依赖：

```ts
import { nexusPulseFastify } from "@nexusmc-cn/nexuspulse-server/fastify";

await fastify.register(nexusPulseFastify, {
  service,
  resolveUserId: (request) => (request.user as { id: string }).id,
  prefix: "/api/notifications",
});
```

路由为 `POST /subscriptions` 和 `DELETE /subscriptions/:id`。必须提供用户解析器，以便现有应用的认证和租户规则继续作为权威来源。删除操作按用户范围原子执行。

适配器不会实现 CSRF 防护、限流、请求体大小限制、认证或错误响应封装。注册此适配器前，请先注册宿主应用的 hook/plugin，并配置 Fastify 的 `bodyLimit`。宿主还应在 `resolveUserId` 中执行租户授权，并使用自己的日志和指标策略。

WebSocket 升级是可选能力，由应用负责。需要 WebSocket 时，安装 `@fastify/websocket@11`，并在此适配器及 WebSocket 路由之前注册插件：

```bash
npm install @fastify/websocket@11
```

TypeScript 项目还需要安装 WebSocket 类型声明：

```bash
npm install -D @types/ws
```

适配器使用 Fastify 的 WebSocket 选项注册路由，并把升级后的 socket 传给回调：

```ts
import websocket from "@fastify/websocket";

await fastify.register(websocket);
await fastify.register(nexusPulseFastify, {
  service,
  resolveUserId: (request) => (request.user as { id: string }).id,
  websocket: {
    onWebSocket(socket, request, userId) {
      // accept 必须同步注册消息监听器。
      return websocketHost.accept(socket, request, { userId });
    },
  },
});
```

适配器在路由的 `preHandler` hook 中等待 `resolveUserId`。宿主的全局或插件 `preHandler` hook 会先执行，因此可以继续在其中填充 `request.user`；身份解析完成后才允许升级。缺少身份时返回 HTTP 401；解析器抛错或 Promise 拒绝会进入 Fastify 的 HTTP 错误处理流程，默认返回 500。身份每次请求只解析一次，并绑定到该请求，避免并发连接混用用户身份。

连接升级后会同步调用 `onWebSocket`。宿主必须在该回调或其调用的方法中同步注册 `message` 等监听器，再执行异步操作；若先 `await` 再注册监听器，期间到达的消息仍可能丢失。异步消息处理和消息监听器内的异常处理由宿主负责。详见 [Fastify WebSocket 生命周期与监听器要求](https://github.com/fastify/fastify-websocket#attaching-event-handlers)。

适配器不会注册广播路由。发送通知是服务端应用通过 `service.send` 执行的操作，应用可以在投递前应用授权和业务规则。

## 模块格式

核心入口和 `@nexusmc-cn/nexuspulse-server/fastify` 均提供 ESM、CommonJS、source map 和 TypeScript 类型声明。

## 许可

[MIT](./LICENSE) © 2026 NexusMC-CN
