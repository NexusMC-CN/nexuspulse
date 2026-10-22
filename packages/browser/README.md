# NexusPulse

NexusPulse 是一个浏览器端 TypeScript 通知运行时，将 Notifications API、Push API、Service Worker、WebSocket 和 Badging API 统一到一个生命周期中。

[npm 包页面](https://www.npmjs.com/package/@nexusmc-cn/nexuspulse) · [配套服务端包](https://www.npmjs.com/package/@nexusmc-cn/nexuspulse-server)

## 安装

```bash
npm install @nexusmc-cn/nexuspulse
```

原无 scope 包 `nexuspulse` 的使用方需要将依赖名称和模块导入改为 `@nexusmc-cn/nexuspulse`；Service Worker 文件名和通知点击消息类型保持不变。

包提供三个入口：

- `@nexusmc-cn/nexuspulse`：应用窗口中的 `NexusPulse` 运行时和各个适配器。
- `@nexusmc-cn/nexuspulse/service-worker`：在 Service Worker 文件中安装 Push 和通知点击处理器。
- `@nexusmc-cn/nexuspulse/protocol`：浏览器与服务端共享的 `NotificationPayload` 和 `NotificationAction` 协议类型。

## 最小接入

```ts
import { createNexusPulse } from "@nexusmc-cn/nexuspulse";

const pulse = createNexusPulse({
  serviceWorker: { url: "/nexuspulse-sw.js" },
  push: { applicationServerKey: vapidPublicKey },
  webSocket: {
    url: "wss://example.test/notifications",
    reconnect: { maxAttempts: 5 },
  },
});

await pulse.initialize();
await pulse.requestPermission();

pulse.on("notification", (payload) => {
  console.log("通知已展示", payload.id);
});

await pulse.notify({
  title: "构建完成",
  body: "你的构建已经可以下载。",
  url: "/builds/latest",
});
```

`createNexusPulse()` 和导入包本身不会访问浏览器全局对象。将初始化放在浏览器生命周期中调用；`initialize()` 会按配置注册 Service Worker 并把状态变为 `ready`。调用 `dispose()` 会断开 WebSocket、释放订阅状态并移除事件监听器。

## Service Worker

在应用自己的构建流程中创建 Service Worker 文件：

```ts
// src/nexuspulse-sw.ts
import { installNexusPulseServiceWorker } from "@nexusmc-cn/nexuspulse/service-worker";

installNexusPulseServiceWorker();
```

将产物部署到与页面同源的 `/nexuspulse-sw.js`，然后把相同路径传给 `serviceWorker.url`。Push 数据应为 JSON 格式的 `NotificationPayload`，例如：

`NotificationPayload` 和 `NotificationAction` 也可以从 `@nexusmc-cn/nexuspulse/protocol` 导入；服务端包复用这组协议类型，避免两端维护不同定义。

```json
{
  "title": "构建完成",
  "body": "点击查看构建结果",
  "url": "/builds/latest",
  "data": { "buildId": "build-123" }
}
```

Push 通知点击时，如果 Service Worker 能枚举到已打开的目标页面，NexusPulse 会聚焦该窗口并发送 `nexuspulse:notification-click` 消息；否则直接打开 `url`，并向新窗口尝试发送点击消息。跨源页面即使已打开也不会被 `clients.matchAll()` 枚举到。页面应根据 URL 加载内容，不依赖点击消息一定送达。没有 `url` 时会聚焦已有同源窗口。默认只允许当前页面同源地址。如确实需要跳转到其他源，应在 Service Worker 安装器中显式配置 `allowedOrigins`，并在服务端限制可发送的 URL。

```ts
installNexusPulseServiceWorker({
  allowedOrigins: ["https://app.example.test"],
});
```

## Push 和 VAPID

```ts
await pulse.requestPermission();
const subscription = await pulse.subscribePush();

// 将 subscription.toJSON() 发送到你自己的后端保存。
console.log(subscription.toJSON());
```

`applicationServerKey` 是服务端 VAPID 公钥，可以传 `BufferSource` 或字符串。NexusPulse 不保存 VAPID 私钥，也不定义服务端推送协议；服务端应自行保存订阅信息并使用 Web Push 服务发送消息。取消订阅：

```ts
await pulse.unsubscribePush();
```

订阅前需要已注册的 Service Worker、通知权限和浏览器 Push API。没有配置 `serviceWorker.url` 或已有 `registration` 时，`subscribePush()` 会抛出 `InvalidConfigurationError`。

## WebSocket

WebSocket 消息默认按 JSON 解码为 `NotificationPayload`，并保留 `data` 和顶层 `url`：

```ts
const pulse = createNexusPulse({
  webSocket: {
    url: "wss://example.test/notifications",
    reconnect: {
      maxAttempts: 3,
      initialDelay: 250,
      maxDelay: 10_000,
      factor: 2,
    },
  },
});

await pulse.connect();
pulse.on("message", (payload) => {
  console.log("收到消息", payload.title);
});

pulse.disconnect();
```

服务端消息格式不同时可配置 `decodeMessage`；转换时需保留 `data` 和顶层 `url`，否则文件 ID、上传 ID 和点击链接会丢失。

WebSocket 收到通知后会自动展示前台系统通知。顶层 `url` 会写入通知的 `data.url`，点击时由当前页面打开该地址；默认只允许同源 URL。跨源文件详情页还需在窗口端配置 `security.allowedOrigins`，并为 Push 点击单独配置上文的 Service Worker `allowedOrigins`。成功通知的文件 ID 应放在 `data.fileId`；失败时尚无文件 ID，可用 `data.uploadId` 和失败详情页 `url`。通知 `id` 不代替文件 ID 或上传 ID。

```ts
const pulse = createNexusPulse({
  security: { allowedOrigins: ["https://files.example.test"] },
  webSocket: { url: "wss://example.test/notifications" },
});
```

默认不自动重连。配置 `reconnect` 后使用指数退避，达到 `maxAttempts` 会发出 `error` 事件并停止连接。`connect()` 只会在连接成功后 resolve；初始连接失败、连接在打开前关闭或主动断开时会 reject `ConnectionError`。

## Badging API

```ts
await pulse.setBadge(3);
await pulse.clearBadge();
```

`setBadge()` 和 `clearBadge()` 返回 `Promise<boolean>`。浏览器不支持 Badging API 时返回 `false`，不会阻断通知流程；也可以用 `badge: { enabled: false }` 完全关闭徽章调用。

## 权限、安全与 SSR

- Notifications、Push 和 Service Worker 通常要求安全上下文（HTTPS 或 `localhost`），并应在用户手势触发的流程中请求权限。
- Service Worker 的 URL 和作用域必须与部署位置匹配；页面刷新后可以继续复用已有 registration。
- `NotificationPermission` 被拒绝时，权限请求和 Push 订阅会抛出 `PermissionDeniedError`；能力不存在会抛出 `UnsupportedFeatureError`。
- 应用可以通过 `on("statechange", ...)`、`on("permissionchange", ...)`、`on("subscriptionchange", ...)` 和 `on("error", ...)` 观察运行时状态。
- SSR 环境可以安全导入和创建实例，但浏览器相关方法应只在客户端调用。

## 模块格式

三个入口均提供 ESM、CommonJS、source map 和 TypeScript 类型声明，可由应用的构建工具按模块格式解析。
