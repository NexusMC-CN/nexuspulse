# 更新记录

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
