# NexusPulse

NexusPulse 提供浏览器通知运行时和配套的 Node.js 服务端能力，将 Notifications API、Push API、Service Worker、WebSocket 和 Badging API 接入应用的通知流程。

根据应用运行环境选择对应的包：

| npm 包                                                                                         | 用途                                                 | 使用文档                                        |
| ---------------------------------------------------------------------------------------------- | ---------------------------------------------------- | ----------------------------------------------- |
| [`@nexusmc-cn/nexuspulse`](https://www.npmjs.com/package/@nexusmc-cn/nexuspulse)               | 浏览器通知运行时，以及 Service Worker 和共享协议入口 | [浏览器包 README](./packages/browser/README.md) |
| [`@nexusmc-cn/nexuspulse-server`](https://www.npmjs.com/package/@nexusmc-cn/nexuspulse-server) | Node.js 服务端通知核心和可选的 Fastify 适配器        | [服务端包 README](./packages/server/README.md)  |

## 安装使用

在前端应用中安装浏览器包：

```bash
npm install @nexusmc-cn/nexuspulse
```

在 Node.js 服务端应用中安装服务端包及其共享协议依赖：

```bash
npm install @nexusmc-cn/nexuspulse-server @nexusmc-cn/nexuspulse
```

使用 `@nexusmc-cn/nexuspulse-server/fastify` 适配器时，额外安装 Fastify 5：

```bash
npm install fastify@5
```

具体接入示例见上表中的使用文档。服务端包将持久化、缓存、队列、Push 服务商配置和 WebSocket 连接状态交给宿主应用负责。

## 从旧包名迁移

使用旧版无 scope 包的项目，需要将依赖名称替换为对应的组织包，并同步更新 `import`、`import type` 和 `require` 中的包名：

| 旧名称                      | 新名称                                  |
| --------------------------- | --------------------------------------- |
| `nexuspulse`                | `@nexusmc-cn/nexuspulse`                |
| `nexuspulse/service-worker` | `@nexusmc-cn/nexuspulse/service-worker` |
| `nexuspulse/protocol`       | `@nexusmc-cn/nexuspulse/protocol`       |
| `nexuspulse-server`         | `@nexusmc-cn/nexuspulse-server`         |
| `nexuspulse-server/fastify` | `@nexusmc-cn/nexuspulse-server/fastify` |

迁移只调整 npm 包名和模块导入。HTTP 路径、Service Worker 文件名和 `nexuspulse:notification-click` 消息类型保持不变。

## 运行环境与接入说明

- 浏览器包提供 ESM、CommonJS 和 TypeScript 类型声明。SSR 环境可以安全导入和创建实例，浏览器相关方法应在客户端生命周期中调用。
- Notifications、Push 和 Service Worker 通常要求 HTTPS 或 `localhost`。通知权限应由用户点击等交互触发。
- 使用 Web Push 时，应用需要配置 VAPID 公钥、部署 Service Worker，并由服务端保存订阅和发送推送。
- 服务端核心不绑定 Web 框架。Fastify 适配器支持 Fastify 5，认证、持久化、Push 传输和 WebSocket 连接由应用提供。

完整示例见 [浏览器接入文档](./packages/browser/README.md) 和 [服务端接入文档](./packages/server/README.md)。

## 许可

[MIT](./LICENSE) © 2026 NexusMC-CN
