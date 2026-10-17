import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { ConnectionError, createNexusPulse } from "../src/index.js";

function socketRuntime() {
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
    }
  }
  return { runtime: { WebSocket: Socket }, sockets };
}

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
      sockets[0].onopen?.();
      await connecting;
      pulse.on("statechange", (state) => {
        if (state === "connecting") pulse[cancel]();
      });

      sockets[0].onclose?.();
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
    sockets[0].onopen?.();
    await expect(connecting).resolves.toBeUndefined();

    expect(pulse.state).toBe("connected");
    pulse.dispose();
    expect(sockets[0].closed).toBe(true);
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
    sockets[0].onopen?.();
    await expect(replacement).resolves.toBeUndefined();
    expect(pulse.state).toBe("connected");
    pulse.dispose();
    expect(sockets[0].closed).toBe(true);
    expect(vi.getTimerCount()).toBe(0);
  });
});
