# NexusPulse

NexusPulse 是一个浏览器端 TypeScript 通知运行时，将 Notifications API、Push API、Service Worker、WebSocket 和 Badging API 统一到一个生命周期中。

## 安装

```bash
npm install nexuspulse
```

包提供两个入口：

- `nexuspulse`：应用窗口中的 `NexusPulse` 运行时和各个适配器。
- `nexuspulse/service-worker`：在 Service Worker 文件中安装 Push 和通知点击处理器。

## 最小接入

```ts
import { createNexusPulse } from "nexuspulse";

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
  console.log("notification shown", payload.id);
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
import { installNexusPulseServiceWorker } from "nexuspulse/service-worker";

installNexusPulseServiceWorker();
```

将产物部署到与页面同源的 `/nexuspulse-sw.js`，然后把相同路径传给 `serviceWorker.url`。Push 数据应为 JSON 格式的 `NotificationPayload`，例如：

```json
{
  "title": "构建完成",
  "body": "点击查看构建结果",
  "url": "/builds/latest",
  "data": { "buildId": "build-123" }
}
```

通知点击时，NexusPulse 会优先查找并聚焦已有窗口，再向该窗口发送 `nexuspulse:notification-click` 消息；没有匹配窗口时才打开允许的 URL。默认只允许当前页面同源地址。如确实需要跳转到其他源，应在 Service Worker 安装器中显式配置 `allowedOrigins`，并在服务端限制可发送的 URL。

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

WebSocket 消息通过 `decodeMessage` 归一化为 `NotificationPayload`：

```ts
const pulse = createNexusPulse({
  webSocket: {
    url: "wss://example.test/notifications",
    decodeMessage(message) {
      const value = JSON.parse(String(message)) as {
        title: string;
        body?: string;
      };
      return { title: value.title, body: value.body };
    },
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
  console.log(payload.title);
});

pulse.disconnect();
```

默认不自动重连。配置 `reconnect` 后使用指数退避，达到 `maxAttempts` 会发出 `error` 事件并停止连接。

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

## 构建与验证

```bash
npm run typecheck
npm test
npm run build
npm run package:smoke
npm pack --dry-run
```

构建会生成 ESM、CommonJS、source map 和声明文件，并为 `nexuspulse` 与 `nexuspulse/service-worker` 两个入口分别生成产物。
