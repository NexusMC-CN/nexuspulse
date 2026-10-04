# NexusPulse Workspace

This repository contains the NexusPulse browser runtime and its Node.js server companion.

- [`packages/browser`](./packages/browser): the published `nexuspulse` browser package.
- [`packages/server`](./packages/server): the server-side notification core and Fastify adapter.

Install dependencies once from the workspace root:

```bash
npm install
```

Run validation for both packages:

```bash
npm run check
npm run build
```

Package-specific publish checks remain available from each package directory. The server package intentionally leaves persistence, caching, queues, Push provider configuration, and WebSocket connection state to the host application.
