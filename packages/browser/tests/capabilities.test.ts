import { describe, expect, it } from "vitest";

import { detectCapabilities } from "../src/capabilities.js";
import {
  ConnectionError,
  InvalidConfigurationError,
  PermissionDeniedError,
  SubscriptionError,
  UnsupportedFeatureError,
} from "../src/errors.js";

describe("detectCapabilities", () => {
  it("is safe to call with an SSR runtime that has no browser globals", () => {
    expect(() => detectCapabilities({})).not.toThrow();
    expect(detectCapabilities({})).toEqual({
      notifications: false,
      push: false,
      serviceWorker: false,
      webSocket: false,
      badging: false,
    });
  });

  it("reports all supported capabilities from an injected browser runtime", () => {
    const runtime = {
      Notification: class Notification {},
      PushManager: class PushManager {},
      WebSocket: class WebSocket {},
      navigator: {
        serviceWorker: {},
        setAppBadge: () => undefined,
      },
    };

    expect(detectCapabilities(runtime)).toEqual({
      notifications: true,
      push: true,
      serviceWorker: true,
      webSocket: true,
      badging: true,
    });
  });

  it("reports notifications as unavailable when Notification is missing", () => {
    const runtime = {
      PushManager: class PushManager {},
      WebSocket: class WebSocket {},
      navigator: {
        serviceWorker: {},
        setAppBadge: () => undefined,
      },
    };

    expect(detectCapabilities(runtime).notifications).toBe(false);
    expect(detectCapabilities(runtime)).toMatchObject({
      push: true,
      serviceWorker: true,
      webSocket: true,
      badging: true,
    });
  });

  it("does not treat null service worker values as supported", () => {
    expect(
      detectCapabilities({
        navigator: { serviceWorker: null, setAppBadge: undefined },
        serviceWorker: null,
      }).serviceWorker,
    ).toBe(false);
  });
});

describe("NexusPulse errors", () => {
  it("exposes stable names for every public error class", () => {
    const errors = [
      new UnsupportedFeatureError(),
      new PermissionDeniedError(),
      new SubscriptionError(),
      new ConnectionError(),
      new InvalidConfigurationError(),
    ];

    expect(errors.map((error) => error.name)).toEqual([
      "UnsupportedFeatureError",
      "PermissionDeniedError",
      "SubscriptionError",
      "ConnectionError",
      "InvalidConfigurationError",
    ]);
    expect(errors.every((error) => error instanceof Error)).toBe(true);
  });
});
