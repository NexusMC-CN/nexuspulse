# 更新记录

## 0.1.3 — 2026-10-28

### `@nexusmc-cn/nexuspulse`

- WebSocket 前台通知可携带详情页链接，点击后按同源或窗口端允许来源规则打开页面；顶层 `allowedOrigins` 保留为 `security.allowedOrigins` 的兼容别名。
- 文件上传成功通知可携带 `data.fileId`，失败通知可携带 `data.uploadId` 和失败详情页链接。
- 新增 `webSocket.autoNotify` 选项。设为 `false` 时仍触发 `message` 事件，但不自动显示系统通知；默认行为保持不变。
- 按核心运行时、通知、Push、徽标和 WebSocket 分目录整理浏览器源码，保留现有包入口。
- 启用 `noUncheckedIndexedAccess` 和 `exactOptionalPropertyTypes`，收紧事件监听器与可选属性的类型约束，并补充协议类型的 `import type` 用法。

### `@nexusmc-cn/nexuspulse-server`

- Push 查询失败时仍继续尝试 WebSocket，并在结果中记录失败。
- 按核心类型、通知服务和 Fastify 集成整理内部源码目录，保留现有包入口与公开导出。

### 工程

- 新增 Ubuntu 和 Windows、Node.js 22 和 24 的 CI 检查，覆盖构建、类型检查、测试、格式检查及两个包的打包验证。
- 用 `.gitattributes` 固定文本文件为 LF 换行，避免 Windows 检出后格式检查误报。
- 将开发工具更新至 TypeScript 6、tsup 9、Vitest 5 和 Node.js 26 类型声明。
- 更新 Fastify 开发依赖及其依赖锁定版本，处理依赖审计提示。

### 验证

- 干净安装、依赖审计、类型检查、格式检查和双包构建通过；全量 127 项测试通过。
- 两个实际压缩包分别包含 23 和 19 个文件，在独立目录安装后，ESM/CommonJS 入口及 TypeScript 6、Node.js 24 类型声明下的 NodeNext 类型检查通过。

## 0.1.2 — 2026-10-17

### `@nexusmc-cn/nexuspulse`

- Service Worker Push 通知可携带详情页链接，点击后按同源或允许来源规则打开页面。
- 修复 WebSocket 发生 `error` 后旧连接未主动关闭的问题，移除事件处理器并关闭旧连接后再安排重连。
- 连接错误、提前关闭或重连终止的回调中同步重新连接时，旧流程不再误结算新连接或额外安排重连。

### `@nexusmc-cn/nexuspulse-server`

- 将 Fastify WebSocket 身份解析移到升级前，避免异步鉴权期间丢失客户端消息；未认证请求在 HTTP 阶段返回 401。
- 升级后同步调用宿主的 `onWebSocket`，便于立即注册消息监听器。

### npm 包信息

- 两个包均补充仓库地址、仓库内目录、使用文档主页和问题反馈地址。
- 添加 MIT 许可证声明，并在仓库和两个 npm 安装包中包含完整许可文本。
- 按浏览器通知、Web Push、Service Worker、WebSocket 和 Fastify 等实际功能补充搜索关键词，并完善服务端包描述。

## 0.1.1 — 2026-10-17

### `@nexusmc-cn/nexuspulse`

- 修复 WebSocket 在 `connecting` 状态回调中调用 `disconnect()` 或 `dispose()` 后仍创建连接的问题。
- 保留取消后手动重新连接的能力，防止已取消的连接操作覆盖新连接。
- 将连接管理实现整理到 `websocket/` 目录，保留原有公开入口。

### `@nexusmc-cn/nexuspulse-server`

- 修复 Endpoint 策略执行异常导致有效 Push 订阅被删除的问题。异常现在通过 `EndpointValidationError` 保留原始 `cause`，订阅保留，策略恢复后可重新发送。
- 修复存储记录包含 `createdAt`、`updatedAt` 等元数据时误删有效订阅的问题。投递前仅提取协议字段，客户端输入仍执行严格白名单校验。
- 将订阅校验和 Push 投递分别整理到 `subscriptions/`、`push/` 目录，保留原有公开入口。
- 将浏览器包的 peer dependency 最低版本更新为 `^0.1.1`。

### 验证

- 新增 13 项测试，全量 98 项测试通过。
- 类型、格式、ESM/CommonJS 构建和浏览器包冒烟检查通过。
