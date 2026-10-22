import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { ConnectionError, createNexusPulse } from "../src/index.js";
import { WebSocketManager } from "../src/websocket/manager.js";
import { atOrThrow } from "./at-or-throw.js";

function socketRuntime(closeEvent?: "sync") {
  const sockets: Socket[] = [];
  class Socket {
    onopen: (() => void) | null = null;
    onmessage: ((event: { data: unknown }) => void) | null = null;
    onerror: (() => void) | null = null;
    onclose: (() => void) | null = null;
    closed = false;

    constructor() {
      sockets.push(this);
    }

    close(): void {
      this.closed = true;
      if (closeEvent === "sync") this.onclose?.();
    }
  }
  return { runtime: { WebSocket: Socket }, sockets };
}

describe("WebSocket error cleanup", () => {
  beforeEach(() => vi.useFakeTimers());
  afterEach(() => vi.useRealTimers());

  it.each(["none", "sync", "delayed"] as const)(
    "closes an errored socket before retrying when close events are %s",
    async (closeEvent) => {
      const { runtime, sockets } = socketRuntime(
        closeEvent === "sync" ? "sync" : undefined,
      );
      const manager = new WebSocketManager(
        { url: "wss://example.test", reconnect: { initialDelay: 10 } },
        {},
        runtime,
      );
      const connecting = manager.connect();
      atOrThrow(sockets, 0).onopen?.();
      await connecting;
      const lateClose = atOrThrow(sockets, 0).onclose;
      const lateError = atOrThrow(sockets, 0).onerror;

      atOrThrow(sockets, 0).onerror?.();

      expect(atOrThrow(sockets, 0).closed).toBe(true);
      expect(vi.getTimerCount()).toBe(1);
      await vi.advanceTimersByTimeAsync(10);
      expect(sockets).toHaveLength(2);
      atOrThrow(sockets, 1).onopen?.();
      if (closeEvent === "delayed") lateClose?.();
      lateError?.();

      expect(manager.state).toBe("connected");
      expect(atOrThrow(sockets, 1).closed).toBe(false);
      expect(vi.getTimerCount()).toBe(0);
      await vi.advanceTimersByTimeAsync(1000);
      expect(sockets).toHaveLength(2);
      manager.disconnect();
    },
  );

  it.each([undefined, { maxAttempts: 1 }])(
    "closes an unopened errored socket when reconnect is %j",
    async (reconnect) => {
      const { runtime, sockets } = socketRuntime();
      const manager = new WebSocketManager(
        {
          url: "wss://example.test",
          ...(reconnect === undefined ? {} : { reconnect }),
        },
        {},
        runtime,
      );
      const rejected = expect(manager.connect()).rejects.toBeInstanceOf(
        ConnectionError,
      );
      const lateClose = atOrThrow(sockets, 0).onclose;

      atOrThrow(sockets, 0).onerror?.();
      await rejected;

      expect(atOrThrow(sockets, 0).closed).toBe(true);
      expect(manager.state).toBe("stopped");
      lateClose?.();
      await vi.advanceTimersByTimeAsync(1000);
      expect(sockets).toHaveLength(1);
      expect(vi.getTimerCount()).toBe(0);
    },
  );

  it("does not reconnect after an error listener disconnects", async () => {
    const { runtime, sockets } = socketRuntime();
    const manager = new WebSocketManager(
      { url: "wss://example.test", reconnect: { initialDelay: 10 } },
      { onError: () => manager.disconnect() },
      runtime,
    );
    const rejected = expect(manager.connect()).rejects.toBeInstanceOf(
      ConnectionError,
    );

    atOrThrow(sockets, 0).onerror?.();
    await rejected;
    await vi.advanceTimersByTimeAsync(1000);

    expect(manager.state).toBe("stopped");
    expect(atOrThrow(sockets, 0).closed).toBe(true);
    expect(sockets).toHaveLength(1);
    expect(vi.getTimerCount()).toBe(0);
  });

  it("keeps a replacement connection started synchronously by an error listener", async () => {
    const { runtime, sockets } = socketRuntime();
    let replacement: Promise<string> | undefined;
    let replacementState = "pending";
    const manager = new WebSocketManager(
      { url: "wss://example.test", reconnect: { initialDelay: 10 } },
      {
        onError: () => {
          manager.disconnect();
          replacement = manager.connect().then(
            () => (replacementState = "connected"),
            () => (replacementState = "rejected"),
          );
        },
      },
      runtime,
    );
    const rejected = expect(manager.connect()).rejects.toBeInstanceOf(
      ConnectionError,
    );

    atOrThrow(sockets, 0).onerror?.();
    await rejected;
    expect(atOrThrow(sockets, 0).closed).toBe(true);
    expect(sockets).toHaveLength(2);
    expect(replacementState).toBe("pending");
    atOrThrow(sockets, 1).onopen?.();

    await expect(replacement).resolves.toBe("connected");
    expect(manager.state).toBe("connected");
    expect(atOrThrow(sockets, 1).closed).toBe(false);
    expect(vi.getTimerCount()).toBe(0);
    await vi.advanceTimersByTimeAsync(1000);
    expect(sockets).toHaveLength(2);
    manager.disconnect();
  });

  it("keeps a replacement connection started by an unopened socket's close error listener", async () => {
    const { runtime, sockets } = socketRuntime();
    let replacement: Promise<string> | undefined;
    let replacementState = "pending";
    const manager = new WebSocketManager(
      { url: "wss://example.test", reconnect: { initialDelay: 10 } },
      {
        onError: () => {
          manager.disconnect();
          replacement = manager.connect().then(
            () => (replacementState = "connected"),
            () => (replacementState = "rejected"),
          );
        },
      },
      runtime,
    );
    const rejected = expect(manager.connect()).rejects.toBeInstanceOf(
      ConnectionError,
    );

    atOrThrow(sockets, 0).onclose?.();
    await rejected;

    expect(sockets).toHaveLength(2);
    expect(replacementState).toBe("pending");
    expect(vi.getTimerCount()).toBe(0);
    atOrThrow(sockets, 1).onopen?.();
    await expect(replacement).resolves.toBe("connected");
    expect(manager.state).toBe("connected");
    expect(atOrThrow(sockets, 1).closed).toBe(false);
    await vi.advanceTimersByTimeAsync(1000);
    expect(sockets).toHaveLength(2);
    manager.disconnect();
  });

  it.each([undefined, { maxAttempts: 1 }])(
    "keeps a replacement started by a stopped listener when reconnect is %j",
    async (reconnect) => {
      const { runtime, sockets } = socketRuntime();
      let replacement: Promise<string> | undefined;
      let replacementState = "pending";
      const manager = new WebSocketManager(
        {
          url: "wss://example.test",
          ...(reconnect === undefined ? {} : { reconnect }),
        },
        {
          onStateChange: (state) => {
            if (state === "stopped" && !replacement) {
              replacement = manager.connect().then(
                () => (replacementState = "connected"),
                () => (replacementState = "rejected"),
              );
            }
          },
          onError: () => {
            if (replacement) manager.disconnect();
          },
        },
        runtime,
      );
      const connecting = manager.connect();
      atOrThrow(sockets, 0).onopen?.();
      await connecting;

      atOrThrow(sockets, 0).onerror?.();
      await Promise.resolve();

      expect(sockets).toHaveLength(2);
      expect(replacementState).toBe("pending");
      expect(atOrThrow(sockets, 0).closed).toBe(true);
      expect(atOrThrow(sockets, 1).closed).toBe(false);
      expect(vi.getTimerCount()).toBe(0);
      atOrThrow(sockets, 1).onopen?.();
      await expect(replacement).resolves.toBe("connected");
      expect(manager.state).toBe("connected");
      await vi.advanceTimersByTimeAsync(1000);
      expect(sockets).toHaveLength(2);
      manager.disconnect();
    },
  );

  it("keeps a replacement started by an exhausted reconnect error listener", async () => {
    const { runtime, sockets } = socketRuntime();
    let replacement: Promise<string> | undefined;
    let replacementState = "pending";
    const manager = new WebSocketManager(
      { url: "wss://example.test", reconnect: { maxAttempts: 1 } },
      {
        onError: () => {
          if (manager.state !== "stopped") return;
          manager.disconnect();
          replacement = manager.connect().then(
            () => (replacementState = "connected"),
            () => (replacementState = "rejected"),
          );
        },
      },
      runtime,
    );
    const rejected = expect(manager.connect()).rejects.toBeInstanceOf(
      ConnectionError,
    );

    atOrThrow(sockets, 0).onerror?.();
    await rejected;

    expect(sockets).toHaveLength(2);
    expect(replacementState).toBe("pending");
    expect(atOrThrow(sockets, 0).closed).toBe(true);
    expect(atOrThrow(sockets, 1).closed).toBe(false);
    expect(vi.getTimerCount()).toBe(0);
    atOrThrow(sockets, 1).onopen?.();
    await expect(replacement).resolves.toBe("connected");
    expect(manager.state).toBe("connected");
    await vi.advanceTimersByTimeAsync(1000);
    expect(sockets).toHaveLength(2);
    manager.disconnect();
  });
});

describe("NexusPulse WebSocket cancellation", () => {
  beforeEach(() => vi.useFakeTimers());
  afterEach(() => vi.useRealTimers());

  it.each(["disconnect", "dispose"] as const)(
    "does not create a reconnect socket when a connecting listener calls %s",
    async (cancel) => {
      const { runtime, sockets } = socketRuntime();
      const pulse = createNexusPulse(
        {
          webSocket: {
            url: "wss://example.test",
            reconnect: { initialDelay: 10 },
          },
        },
        runtime,
      );
      const connecting = pulse.connect();
      atOrThrow(sockets, 0).onopen?.();
      await connecting;
      pulse.on("statechange", (state) => {
        if (state === "connecting") pulse[cancel]();
      });

      atOrThrow(sockets, 0).onclose?.();
      expect(vi.getTimerCount()).toBe(1);
      await vi.advanceTimersByTimeAsync(10);

      expect(sockets).toHaveLength(1);
      expect(pulse.state).toBe(cancel === "dispose" ? "stopped" : "ready");
      expect(vi.getTimerCount()).toBe(0);
      await vi.advanceTimersByTimeAsync(1000);
      expect(sockets).toHaveLength(1);
      pulse.dispose();
    },
  );

  it.each(["disconnect", "dispose"] as const)(
    "does not create the initial socket when a connecting listener calls %s",
    async (cancel) => {
      const { runtime, sockets } = socketRuntime();
      const pulse = createNexusPulse(
        { webSocket: { url: "wss://example.test", reconnect: true } },
        runtime,
      );
      pulse.on("statechange", (state) => {
        if (state === "connecting") pulse[cancel]();
      });

      await expect(pulse.connect()).rejects.toBeInstanceOf(ConnectionError);

      expect(sockets).toHaveLength(0);
      expect(vi.getTimerCount()).toBe(0);
      pulse.dispose();
    },
  );

  it("allows an explicit connection after a connecting listener disconnected", async () => {
    const { runtime, sockets } = socketRuntime();
    const pulse = createNexusPulse(
      { webSocket: { url: "wss://example.test", reconnect: true } },
      runtime,
    );
    const unsubscribe = pulse.on("statechange", (state) => {
      if (state === "connecting") pulse.disconnect();
    });
    await expect(pulse.connect()).rejects.toBeInstanceOf(ConnectionError);
    unsubscribe();

    const connecting = pulse.connect();
    expect(sockets).toHaveLength(1);
    atOrThrow(sockets, 0).onopen?.();
    await expect(connecting).resolves.toBeUndefined();

    expect(pulse.state).toBe("connected");
    pulse.dispose();
    expect(atOrThrow(sockets, 0).closed).toBe(true);
    expect(vi.getTimerCount()).toBe(0);
  });

  it("keeps a newer connection started synchronously by a connecting listener", async () => {
    const { runtime, sockets } = socketRuntime();
    const pulse = createNexusPulse(
      { webSocket: { url: "wss://example.test", reconnect: true } },
      runtime,
    );
    let replacement: Promise<void> | undefined;
    let replace = true;
    pulse.on("statechange", (state) => {
      if (state === "connecting" && replace) {
        replace = false;
        pulse.disconnect();
        replacement = pulse.connect();
      }
    });

    await expect(pulse.connect()).rejects.toBeInstanceOf(ConnectionError);

    expect(sockets).toHaveLength(1);
    atOrThrow(sockets, 0).onopen?.();
    await expect(replacement).resolves.toBeUndefined();
    expect(pulse.state).toBe("connected");
    pulse.dispose();
    expect(atOrThrow(sockets, 0).closed).toBe(true);
    expect(vi.getTimerCount()).toBe(0);
  });
});
