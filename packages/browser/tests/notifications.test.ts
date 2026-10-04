import { describe, expect, it, vi } from "vitest";

import {
  requestNotificationPermission,
  showNotification,
} from "../src/notifications.js";
import { clearBadge, setBadge } from "../src/badge.js";
import {
  PermissionDeniedError,
  UnsupportedFeatureError,
} from "../src/errors.js";

describe("notification adapter", () => {
  it("returns granted when the injected Notification permission is granted", async () => {
    const runtime = {
      Notification: Object.assign(class Notification {}, {
        permission: "granted" as NotificationPermission,
        requestPermission: vi.fn(),
      }),
    };

    await expect(requestNotificationPermission(runtime)).resolves.toBe(
      "granted",
    );
    expect(runtime.Notification.requestPermission).not.toHaveBeenCalled();
  });

  it("throws PermissionDeniedError when permission is denied", async () => {
    const runtime = {
      Notification: Object.assign(class Notification {}, {
        permission: "denied" as NotificationPermission,
        requestPermission: vi.fn(),
      }),
    };

    await expect(requestNotificationPermission(runtime)).rejects.toBeInstanceOf(
      PermissionDeniedError,
    );
  });

  it("returns the default result when the permission request remains undecided", async () => {
    const runtime = {
      Notification: Object.assign(class Notification {}, {
        permission: "default" as NotificationPermission,
        requestPermission: vi.fn().mockResolvedValue("default"),
      }),
    };

    await expect(requestNotificationPermission(runtime)).resolves.toBe(
      "default",
    );
  });

  it("throws UnsupportedFeatureError when permission cannot be requested", async () => {
    const runtime = {
      Notification: Object.assign(class Notification {}, {
        permission: "default" as NotificationPermission,
      }),
    };

    await expect(requestNotificationPermission(runtime)).rejects.toBeInstanceOf(
      UnsupportedFeatureError,
    );
  });

  it("throws PermissionDeniedError when a permission request is denied", async () => {
    const runtime = {
      Notification: Object.assign(class Notification {}, {
        permission: "default" as NotificationPermission,
        requestPermission: vi.fn().mockResolvedValue("denied"),
      }),
    };

    await expect(requestNotificationPermission(runtime)).rejects.toBeInstanceOf(
      PermissionDeniedError,
    );
  });

  it("maps the payload to a foreground Notification instance", () => {
    const notification = { close: vi.fn() };
    const NotificationConstructor = vi.fn(function Notification(
      title: string,
      options?: NotificationOptions,
    ) {
      expect(title).toBe("Hello");
      expect(options).toEqual({
        body: "World",
        icon: "/icon.png",
        badge: "/badge.png",
        tag: "news",
        data: { id: 42 },
        actions: [{ action: "open", title: "Open" }],
        timestamp: 123,
        requireInteraction: true,
        silent: false,
      });
      return notification;
    });
    const runtime = { Notification: NotificationConstructor };

    expect(
      showNotification(
        {
          title: "Hello",
          body: "World",
          icon: "/icon.png",
          badge: "/badge.png",
          tag: "news",
          data: { id: 42 },
          actions: [{ action: "open", title: "Open" }],
          timestamp: 123,
          requireInteraction: true,
          silent: false,
          id: "notification-id",
          url: "/news",
        },
        runtime,
      ),
    ).toBe(notification);
    expect(NotificationConstructor).toHaveBeenCalledTimes(1);
  });

  it("throws UnsupportedFeatureError when Notification is unavailable", () => {
    expect(() => showNotification({ title: "Hello" }, {})).toThrow(
      UnsupportedFeatureError,
    );
  });
});

describe("badging adapter", () => {
  it("returns false when the Badging API is unavailable", async () => {
    await expect(setBadge(3, {})).resolves.toBe(false);
    await expect(clearBadge({})).resolves.toBe(false);
  });

  it("uses navigator Badging API before root APIs", async () => {
    const navigatorSet = vi.fn().mockResolvedValue(undefined);
    const navigatorClear = vi.fn().mockResolvedValue(undefined);
    const rootSet = vi.fn();
    const rootClear = vi.fn();
    const runtime = {
      navigator: { setAppBadge: navigatorSet, clearAppBadge: navigatorClear },
      setAppBadge: rootSet,
      clearAppBadge: rootClear,
    };

    await expect(setBadge(7, runtime)).resolves.toBe(true);
    await expect(clearBadge(runtime)).resolves.toBe(true);
    expect(navigatorSet).toHaveBeenCalledWith(7);
    expect(navigatorClear).toHaveBeenCalledTimes(1);
    expect(rootSet).not.toHaveBeenCalled();
    expect(rootClear).not.toHaveBeenCalled();
  });

  it("supports root Badging APIs when navigator does not expose them", async () => {
    const rootSet = vi.fn().mockResolvedValue(undefined);
    const rootClear = vi.fn().mockResolvedValue(undefined);
    const runtime = { setAppBadge: rootSet, clearAppBadge: rootClear };

    await expect(setBadge(undefined, runtime)).resolves.toBe(true);
    await expect(clearBadge(runtime)).resolves.toBe(true);
    expect(rootSet).toHaveBeenCalledWith();
    expect(rootClear).toHaveBeenCalledTimes(1);
  });

  it("falls back to root APIs when navigator properties are not functions", async () => {
    const rootSet = vi.fn(function (this: typeof runtime, count?: number) {
      expect(this).toBe(runtime);
      expect(count).toBe(4);
    });
    const rootClear = vi.fn(function (this: typeof runtime) {
      expect(this).toBe(runtime);
    });
    const runtime = {
      navigator: { setAppBadge: "unavailable", clearAppBadge: {} },
      setAppBadge: rootSet,
      clearAppBadge: rootClear,
    };

    await expect(setBadge(4, runtime)).resolves.toBe(true);
    await expect(clearBadge(runtime)).resolves.toBe(true);
    expect(rootSet).toHaveBeenCalledTimes(1);
    expect(rootClear).toHaveBeenCalledTimes(1);
  });
});
