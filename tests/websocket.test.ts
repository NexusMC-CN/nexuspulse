import { describe, expect, it, vi, beforeEach, afterEach } from "vitest";

import { ConnectionError } from "../src/errors.js";
import { WebSocketManager } from "../src/websocket.js";

type FakeSocket = {
  onopen: (() => void) | null;
  onmessage: ((event: { data: unknown }) => void) | null;
  onerror: (() => void) | null;
  onclose: (() => void) | null;
  close: ReturnType<typeof vi.fn>;
};

function fakeWebSocketConstructor() {
  const sockets: FakeSocket[] = [];
  const Constructor = vi.fn(function FakeWebSocket() {
    const socket: FakeSocket = {
      onopen: null,
      onmessage: null,
      onerror: null,
      onclose: null,
      close: vi.fn(),
    };
    sockets.push(socket);
    return socket;
  });
  return { Constructor, sockets };
}

describe("WebSocketManager", () => {
  beforeEach(() => vi.useFakeTimers());
  afterEach(() => vi.useRealTimers());

  it("opens a configured URL and protocols", async () => {
    const { Constructor, sockets } = fakeWebSocketConstructor();
    const manager = new WebSocketManager(
      { url: "wss://example.test", protocols: ["json"] },
      {},
      { WebSocket: Constructor },
    );

    const connecting = manager.connect();
    expect(manager.state).toBe("connecting");
    expect(Constructor).toHaveBeenCalledWith("wss://example.test", ["json"]);
    sockets[0].onopen?.();
    await expect(connecting).resolves.toBeUndefined();
    expect(manager.state).toBe("connected");
  });

  it("creates a fresh socket when connect is called after success", async () => {
    const { Constructor, sockets } = fakeWebSocketConstructor();
    const manager = new WebSocketManager(
      { url: "ws://example.test" },
      {},
      { WebSocket: Constructor },
    );

    const first = manager.connect();
    sockets[0].onopen?.();
    await first;
    const second = manager.connect();
    expect(Constructor).toHaveBeenCalledTimes(2);
    sockets[1].onopen?.();
    await expect(second).resolves.toBeUndefined();
  });

  it("ignores events from a socket after disconnect", async () => {
    const { Constructor, sockets } = fakeWebSocketConstructor();
    const onMessage = vi.fn();
    const onStateChange = vi.fn();
    const manager = new WebSocketManager(
      { url: "ws://example.test", decodeMessage: () => ({ title: "late" }) },
      { onMessage, onStateChange },
      { WebSocket: Constructor },
    );

    const connecting = manager.connect();
    manager.disconnect();
    sockets[0].onopen?.();
    sockets[0].onmessage?.({ data: "late" });
    sockets[0].onclose?.();
    await connecting;

    expect(manager.state).toBe("stopped");
    expect(onMessage).not.toHaveBeenCalled();
    expect(onStateChange).not.toHaveBeenCalledWith("connected");
  });

  it("decodes messages and ignores empty decoded values", async () => {
    const { Constructor, sockets } = fakeWebSocketConstructor();
    const onMessage = vi.fn();
    const decodeMessage = vi
      .fn()
      .mockReturnValueOnce({ title: "hello" })
      .mockReturnValueOnce(null);
    const manager = new WebSocketManager(
      { url: "ws://example.test", decodeMessage },
      { onMessage },
      { WebSocket: Constructor },
    );

    const connecting = manager.connect();
    sockets[0].onopen?.();
    await connecting;
    sockets[0].onmessage?.({ data: "first" });
    sockets[0].onmessage?.({ data: "second" });

    expect(decodeMessage).toHaveBeenNthCalledWith(1, "first");
    expect(onMessage).toHaveBeenCalledOnce();
    expect(onMessage).toHaveBeenCalledWith({ title: "hello" });
  });

  it("validates the default decoder and ignores malformed raw messages", async () => {
    const { Constructor, sockets } = fakeWebSocketConstructor();
    const onMessage = vi.fn();
    const manager = new WebSocketManager(
      { url: "ws://example.test" },
      { onMessage },
      { WebSocket: Constructor },
    );

    const connecting = manager.connect();
    sockets[0].onopen?.();
    await connecting;
    sockets[0].onmessage?.({ data: "not-json" });
    sockets[0].onmessage?.({ data: JSON.stringify({ body: "missing title" }) });
    sockets[0].onmessage?.({ data: JSON.stringify({ title: "  " }) });
    sockets[0].onmessage?.({ data: JSON.stringify({ title: "valid" }) });

    expect(onMessage).toHaveBeenCalledOnce();
    expect(onMessage).toHaveBeenCalledWith({ title: "valid" });
  });

  it("disconnects permanently and clears a pending reconnect", async () => {
    const { Constructor, sockets } = fakeWebSocketConstructor();
    const manager = new WebSocketManager(
      { url: "ws://example.test", reconnect: true },
      {},
      { WebSocket: Constructor },
    );
    const connecting = manager.connect();
    sockets[0].onopen?.();
    await connecting;
    sockets[0].onclose?.();
    manager.disconnect();
    await vi.advanceTimersByTimeAsync(1000);

    expect(Constructor).toHaveBeenCalledOnce();
    expect(manager.state).toBe("stopped");
  });

  it("reconnects with exponential delay capped at maxDelay", async () => {
    const { Constructor, sockets } = fakeWebSocketConstructor();
    const manager = new WebSocketManager(
      {
        url: "ws://example.test",
        reconnect: {
          initialDelay: 10,
          factor: 3,
          maxDelay: 20,
          maxAttempts: 3,
        },
      },
      {},
      { WebSocket: Constructor },
    );
    const first = manager.connect();
    sockets[0].onopen?.();
    await first;
    sockets[0].onclose?.();
    await vi.advanceTimersByTimeAsync(9);
    expect(Constructor).toHaveBeenCalledOnce();
    await vi.advanceTimersByTimeAsync(1);
    expect(Constructor).toHaveBeenCalledTimes(2);
    sockets[1].onopen?.();
    sockets[1].onclose?.();
    await vi.advanceTimersByTimeAsync(19);
    expect(Constructor).toHaveBeenCalledTimes(2);
    await vi.advanceTimersByTimeAsync(1);
    expect(Constructor).toHaveBeenCalledTimes(3);
  });

  it("reports exhausted reconnect attempts and stops", async () => {
    const { Constructor, sockets } = fakeWebSocketConstructor();
    const onError = vi.fn();
    const manager = new WebSocketManager(
      {
        url: "ws://example.test",
        reconnect: { initialDelay: 1, maxAttempts: 1 },
      },
      { onError },
      { WebSocket: Constructor },
    );
    const first = manager.connect();
    sockets[0].onopen?.();
    await first;
    sockets[0].onclose?.();
    await vi.advanceTimersByTimeAsync(1);
    expect(manager.state).toBe("stopped");
    expect(onError).toHaveBeenCalledWith(expect.any(ConnectionError));
  });

  it("settles a pending connect when an unopened socket exhausts reconnects", async () => {
    const { Constructor, sockets } = fakeWebSocketConstructor();
    const onError = vi.fn();
    const manager = new WebSocketManager(
      {
        url: "ws://example.test",
        reconnect: { initialDelay: 1, maxAttempts: 1 },
      },
      { onError },
      { WebSocket: Constructor },
    );

    const first = manager.connect();
    sockets[0].onclose?.();
    await expect(first).resolves.toBeUndefined();
    expect(manager.state).toBe("stopped");
    expect(onError).toHaveBeenCalledWith(expect.any(ConnectionError));

    const second = manager.connect();
    expect(Constructor).toHaveBeenCalledTimes(2);
    sockets[1].onopen?.();
    await expect(second).resolves.toBeUndefined();
  });

  it("ignores captured events after reconnect attempts are exhausted", async () => {
    const { Constructor, sockets } = fakeWebSocketConstructor();
    const onMessage = vi.fn();
    const onStateChange = vi.fn();
    const manager = new WebSocketManager(
      {
        url: "ws://example.test",
        reconnect: { maxAttempts: 1 },
        decodeMessage: () => ({ title: "late" }),
      },
      { onMessage, onStateChange },
      { WebSocket: Constructor },
    );

    const connecting = manager.connect();
    const lateOpen = sockets[0].onopen;
    const lateMessage = sockets[0].onmessage;
    sockets[0].onclose?.();
    await connecting;
    lateOpen?.();
    lateMessage?.({ data: "late" });

    expect(manager.state).toBe("stopped");
    expect(onMessage).not.toHaveBeenCalled();
    expect(onStateChange).not.toHaveBeenCalledWith("connected");
  });

  it("settles and stops when a socket closes without reconnect", async () => {
    const { Constructor, sockets } = fakeWebSocketConstructor();
    const manager = new WebSocketManager(
      { url: "ws://example.test" },
      {},
      { WebSocket: Constructor },
    );

    const connecting = manager.connect();
    sockets[0].onclose?.();

    await expect(connecting).resolves.toBeUndefined();
    expect(manager.state).toBe("stopped");
  });

  it("lets close schedule reconnect after a socket error", async () => {
    const { Constructor, sockets } = fakeWebSocketConstructor();
    const manager = new WebSocketManager(
      { url: "ws://example.test", reconnect: { initialDelay: 5 } },
      {},
      { WebSocket: Constructor },
    );

    const connecting = manager.connect();
    sockets[0].onerror?.();
    await connecting;
    sockets[0].onclose?.();
    await vi.advanceTimersByTimeAsync(5);

    expect(Constructor).toHaveBeenCalledTimes(2);
  });

  it("clears a scheduled reconnect when connect is called manually", async () => {
    const { Constructor, sockets } = fakeWebSocketConstructor();
    const manager = new WebSocketManager(
      { url: "ws://example.test", reconnect: { initialDelay: 10 } },
      {},
      { WebSocket: Constructor },
    );

    const first = manager.connect();
    sockets[0].onopen?.();
    await first;
    sockets[0].onclose?.();
    const manual = manager.connect();
    expect(Constructor).toHaveBeenCalledTimes(2);
    sockets[1].onopen?.();
    await manual;
    await vi.advanceTimersByTimeAsync(10);

    expect(Constructor).toHaveBeenCalledTimes(2);
  });

  it("maps missing constructors, socket errors, and decoder errors", async () => {
    const missingError = vi.fn();
    const missing = new WebSocketManager(
      { url: "ws://example.test" },
      { onError: missingError },
      {},
    );
    await expect(missing.connect()).resolves.toBeUndefined();
    expect(missingError).toHaveBeenCalledWith(expect.any(ConnectionError));

    const { Constructor, sockets } = fakeWebSocketConstructor();
    const onError = vi.fn();
    const manager = new WebSocketManager(
      {
        url: "ws://example.test",
        decodeMessage: () => {
          throw new Error("bad payload");
        },
      },
      { onError },
      { WebSocket: Constructor },
    );
    const connecting = manager.connect();
    sockets[0].onerror?.();
    sockets[0].onopen?.();
    await connecting;
    sockets[0].onmessage?.({ data: "bad" });
    expect(onError).toHaveBeenCalledWith(expect.any(ConnectionError));
  });

  it("completes a connect promise on socket error and can reconnect", async () => {
    const { Constructor, sockets } = fakeWebSocketConstructor();
    const onError = vi.fn();
    const manager = new WebSocketManager(
      { url: "ws://example.test" },
      { onError },
      { WebSocket: Constructor },
    );

    const first = manager.connect();
    sockets[0].onerror?.();
    await expect(first).resolves.toBeUndefined();
    const second = manager.connect();
    expect(Constructor).toHaveBeenCalledTimes(2);
    sockets[1].onopen?.();
    await expect(second).resolves.toBeUndefined();
    expect(onError).toHaveBeenCalledWith(expect.any(ConnectionError));
  });
});
