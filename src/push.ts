import {
  InvalidConfigurationError,
  PermissionDeniedError,
  SubscriptionError,
  UnsupportedFeatureError,
} from "./errors.js";
import type { PushOptions, ServiceWorkerOptions } from "./types.js";

export interface PushAdapterOptions extends PushOptions {
  serviceWorker?: ServiceWorkerOptions;
}

type Runtime = {
  navigator?: {
    serviceWorker?: {
      register: (
        scriptURL: string,
        options?: RegistrationOptions,
      ) => Promise<ServiceWorkerRegistration>;
      ready?: Promise<ServiceWorkerRegistration>;
    };
  };
  Notification?: {
    permission?: NotificationPermission;
  };
};

export async function ensureServiceWorkerRegistration(
  options: ServiceWorkerOptions = {},
  runtime: Runtime = globalThis,
): Promise<ServiceWorkerRegistration> {
  if (options.registration !== undefined) {
    return options.registration;
  }
  if (!options.url) {
    throw new InvalidConfigurationError(
      "A service worker URL or registration is required",
    );
  }

  const serviceWorker = runtime.navigator?.serviceWorker;
  if (typeof serviceWorker?.register !== "function") {
    throw new UnsupportedFeatureError(
      "The Service Worker API is not supported",
    );
  }
  const registration = await serviceWorker.register(options.url, {
    scope: options.scope,
  });
  return serviceWorker.ready ?? registration;
}

export async function subscribePush(
  options: PushAdapterOptions,
  runtime: Runtime = globalThis,
): Promise<PushSubscription> {
  const registration = await ensureServiceWorkerRegistration(
    options.serviceWorker,
    runtime,
  );

  if (options.applicationServerKey === undefined) {
    throw new InvalidConfigurationError(
      "An application server key is required for push subscription",
    );
  }

  if (runtime.Notification?.permission === "denied") {
    throw new PermissionDeniedError();
  }

  const pushManager = registration.pushManager;
  if (!pushManager || typeof pushManager.subscribe !== "function") {
    throw new UnsupportedFeatureError("The Push API is not supported");
  }

  try {
    return await pushManager.subscribe({
      ...options.subscribeOptions,
      userVisibleOnly: options.subscribeOptions?.userVisibleOnly ?? true,
      applicationServerKey: options.applicationServerKey,
    });
  } catch (error) {
    throw new SubscriptionError(
      error instanceof Error ? error.message : "Push subscription failed",
    );
  }
}

export async function unsubscribePush(
  subscription: PushSubscription,
): Promise<boolean> {
  return subscription.unsubscribe();
}
