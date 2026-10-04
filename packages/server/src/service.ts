import {
  InvalidNotificationChannelError,
  InvalidNotificationPayloadError,
  InvalidSubscriptionInputError,
  PushDeliveryTimeoutError,
  isInvalidSubscriptionError,
} from "./errors.js";
import type {
  ChannelResult,
  NotificationChannel,
  NotificationPayload,
  NotificationSendResult,
  NotificationServiceOptions,
  PushDispatchOptions,
  PushSubscriptionInput,
  PushSubscriptionRecord,
  SubscriptionValidationOptions,
  SubscriptionStore,
} from "./types.js";

const DEFAULT_PUSH_DISPATCH: Required<
  Omit<PushDispatchOptions, "shouldRetry">
> = {
  concurrency: 8,
  timeoutMs: 10_000,
  retries: 2,
  retryDelayMs: 100,
  retryBackoffFactor: 2,
  maxRetryDelayMs: 2_000,
};

const MAX_ENDPOINT_LENGTH = 4_096;
const MAX_KEY_LENGTH = 4_096;
const SUBSCRIPTION_FIELDS = new Set(["endpoint", "expirationTime", "keys"]);
const KEY_FIELDS = new Set(["p256dh", "auth"]);

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function invalidSubscription(message: string): never {
  throw new InvalidSubscriptionInputError(message);
}

function parseIpv4(hostname: string): number[] | undefined {
  const parts = hostname.split(".");
  if (parts.length !== 4 || parts.some((part) => !/^\d{1,3}$/.test(part))) {
    return undefined;
  }
  const octets = parts.map(Number);
  return octets.every((octet) => octet <= 255) ? octets : undefined;
}

function isPrivateHostname(hostname: string): boolean {
  const host = hostname.toLowerCase().replace(/\.$/, "");
  if (
    host === "localhost" ||
    host.endsWith(".localhost") ||
    host.endsWith(".local") ||
    host.endsWith(".internal")
  ) {
    return true;
  }
  const ipv4 = parseIpv4(host);
  if (ipv4) {
    const [first, second] = ipv4;
    return (
      first === 0 ||
      first === 10 ||
      first === 127 ||
      (first === 100 && second >= 64 && second <= 127) ||
      (first === 169 && second === 254) ||
      (first === 172 && second >= 16 && second <= 31) ||
      (first === 192 && second === 168) ||
      (first === 198 && (second === 18 || second === 19)) ||
      first >= 224
    );
  }
  if (host.includes(":")) {
    const normalized = host.replace(/^\[|\]$/g, "");
    const mappedIpv4 = normalized.startsWith("::ffff:")
      ? parseIpv4(normalized.slice("::ffff:".length))
      : undefined;
    if (mappedIpv4) {
      return isPrivateHostname(mappedIpv4.join("."));
    }
    return (
      normalized === "::" ||
      normalized === "::1" ||
      normalized.startsWith("fe80:") ||
      normalized.startsWith("fc") ||
      normalized.startsWith("fd") ||
      normalized.startsWith("::ffff:")
    );
  }
  return false;
}

function normalizeDispatchOptions(
  options: PushDispatchOptions | undefined,
): Required<Omit<PushDispatchOptions, "shouldRetry">> &
  Pick<PushDispatchOptions, "shouldRetry"> {
  const candidate = options ?? {};
  const positiveInteger = (value: number | undefined, fallback: number) =>
    Number.isInteger(value) && (value as number) > 0
      ? (value as number)
      : fallback;
  const nonNegativeInteger = (value: number | undefined, fallback: number) =>
    Number.isInteger(value) && (value as number) >= 0
      ? (value as number)
      : fallback;
  const positiveNumber = (value: number | undefined, fallback: number) =>
    Number.isFinite(value) && (value as number) > 0
      ? (value as number)
      : fallback;
  return {
    concurrency: positiveInteger(
      candidate.concurrency,
      DEFAULT_PUSH_DISPATCH.concurrency,
    ),
    timeoutMs: positiveNumber(
      candidate.timeoutMs,
      DEFAULT_PUSH_DISPATCH.timeoutMs,
    ),
    retries: nonNegativeInteger(
      candidate.retries,
      DEFAULT_PUSH_DISPATCH.retries,
    ),
    retryDelayMs: positiveNumber(
      candidate.retryDelayMs,
      DEFAULT_PUSH_DISPATCH.retryDelayMs,
    ),
    retryBackoffFactor: positiveNumber(
      candidate.retryBackoffFactor,
      DEFAULT_PUSH_DISPATCH.retryBackoffFactor,
    ),
    maxRetryDelayMs: positiveNumber(
      candidate.maxRetryDelayMs,
      DEFAULT_PUSH_DISPATCH.maxRetryDelayMs,
    ),
    shouldRetry: candidate.shouldRetry,
  };
}

function validateEndpointOrigins(
  endpoint: URL,
  allowedEndpointOrigins: readonly string[] | undefined,
): boolean {
  if (!allowedEndpointOrigins?.length) return false;
  return allowedEndpointOrigins.some((origin) => {
    try {
      return new URL(origin).origin === endpoint.origin;
    } catch {
      invalidSubscription("Endpoint origin allowlist contains an invalid URL");
    }
  });
}

/** Validate and strip unrecognised subscription fields before persistence. */
export async function normalizePushSubscriptionInput(
  input: unknown,
  options: SubscriptionValidationOptions = {},
): Promise<PushSubscriptionInput> {
  if (!isRecord(input)) {
    invalidSubscription("A push subscription object is required");
  }
  const unknownField = Object.keys(input).find(
    (field) => !SUBSCRIPTION_FIELDS.has(field),
  );
  if (unknownField) {
    invalidSubscription(`Unsupported subscription field: ${unknownField}`);
  }
  if (typeof input.endpoint !== "string" || !input.endpoint.trim()) {
    invalidSubscription("A subscription endpoint is required");
  }
  if (input.endpoint.length > MAX_ENDPOINT_LENGTH) {
    invalidSubscription("The subscription endpoint is too long");
  }
  let endpoint: URL;
  try {
    endpoint = new URL(input.endpoint);
  } catch {
    invalidSubscription("The subscription endpoint must be a valid URL");
  }
  if (
    endpoint.protocol !== "https:" ||
    endpoint.username ||
    endpoint.password ||
    endpoint.hash
  ) {
    invalidSubscription(
      "The subscription endpoint must use HTTPS without credentials or a fragment",
    );
  }
  if (!options.allowedEndpointOrigins?.length && !options.validateEndpoint) {
    invalidSubscription(
      "Configure allowedEndpointOrigins or validateEndpoint before accepting subscription endpoints",
    );
  }
  const isAllowlisted = validateEndpointOrigins(
    endpoint,
    options.allowedEndpointOrigins,
  );
  if (isPrivateHostname(endpoint.hostname) && !isAllowlisted) {
    invalidSubscription(
      "Private or local subscription endpoints are not allowed",
    );
  }
  if (options.allowedEndpointOrigins?.length && !isAllowlisted) {
    invalidSubscription("The subscription endpoint origin is not allowed");
  }
  if (options.validateEndpoint) {
    let accepted = false;
    try {
      accepted = await options.validateEndpoint(endpoint);
    } catch {
      accepted = false;
    }
    if (!accepted) {
      invalidSubscription(
        "The subscription endpoint was rejected by host policy",
      );
    }
  }

  const normalized: PushSubscriptionInput = { endpoint: endpoint.toString() };
  if (input.expirationTime !== undefined && input.expirationTime !== null) {
    if (
      typeof input.expirationTime !== "number" ||
      !Number.isFinite(input.expirationTime) ||
      input.expirationTime < 0
    ) {
      invalidSubscription(
        "The subscription expirationTime must be a timestamp or null",
      );
    }
    normalized.expirationTime = input.expirationTime;
  } else if (input.expirationTime === null) {
    normalized.expirationTime = null;
  }
  if (input.keys !== undefined) {
    if (!isRecord(input.keys)) {
      invalidSubscription("The subscription keys must be an object");
    }
    const unknownKey = Object.keys(input.keys).find(
      (field) => !KEY_FIELDS.has(field),
    );
    if (unknownKey) {
      invalidSubscription(`Unsupported subscription key field: ${unknownKey}`);
    }
    const keys: Record<string, string> = {};
    for (const field of KEY_FIELDS) {
      const value = input.keys[field];
      if (typeof value !== "string" || !value.trim()) {
        invalidSubscription(
          `Subscription key ${field} must be a non-empty string`,
        );
      }
      if (value.length > MAX_KEY_LENGTH) {
        invalidSubscription(`Subscription key ${field} is too long`);
      }
      keys[field] = value;
    }
    normalized.keys = keys;
  }
  return normalized;
}

function emptyChannelResult(skipped: boolean): ChannelResult {
  return { sent: 0, failed: 0, removed: 0, skipped, errors: [] };
}

function assertUserId(userId: string): void {
  if (typeof userId !== "string" || !userId.trim()) {
    throw new InvalidSubscriptionInputError("A user id is required");
  }
}

export class NotificationService {
  private readonly store: SubscriptionStore;
  private readonly push: NotificationServiceOptions["push"];
  private readonly pushDispatch: ReturnType<typeof normalizeDispatchOptions>;
  private readonly subscriptionValidation: SubscriptionValidationOptions;
  private readonly realtime: NotificationServiceOptions["realtime"];
  private readonly onInvalidSubscription: NonNullable<
    NotificationServiceOptions["onInvalidSubscription"]
  >;

  constructor(options: NotificationServiceOptions) {
    this.store = options.store;
    this.push = options.push;
    this.pushDispatch = normalizeDispatchOptions(options.pushDispatch);
    this.subscriptionValidation = options.subscriptionValidation ?? {};
    this.realtime = options.realtime;
    this.onInvalidSubscription =
      options.onInvalidSubscription ?? (() => undefined);
  }

  async subscribe(
    userId: string,
    subscription: PushSubscriptionInput,
  ): Promise<PushSubscriptionRecord> {
    assertUserId(userId);
    const normalized = await normalizePushSubscriptionInput(
      subscription,
      this.subscriptionValidation,
    );
    return this.store.upsert(userId, normalized);
  }

  async unsubscribe(userId: string, id: string): Promise<boolean> {
    assertUserId(userId);
    if (!id) return false;
    return await this.store.removeForUser(userId, id);
  }

  async listSubscriptions(userId: string): Promise<PushSubscriptionRecord[]> {
    assertUserId(userId);
    return this.store.listByUser(userId);
  }

  async send(
    userId: string,
    payload: NotificationPayload,
    channels: NotificationChannel[] = ["push", "websocket"],
  ): Promise<NotificationSendResult> {
    assertUserId(userId);
    if (
      !payload ||
      typeof payload.title !== "string" ||
      !payload.title.trim()
    ) {
      throw new InvalidNotificationPayloadError(
        "A notification title is required",
      );
    }
    if (
      channels.some((channel) => channel !== "push" && channel !== "websocket")
    ) {
      throw new InvalidNotificationChannelError(
        "Unsupported notification channel",
      );
    }
    const requestedChannels = [...new Set(channels)];
    const result: NotificationSendResult = {
      userId,
      requestedChannels,
      push: emptyChannelResult(
        !requestedChannels.includes("push") || !this.push,
      ),
      websocket: {
        sent: false,
        failed: false,
        skipped: !requestedChannels.includes("websocket") || !this.realtime,
      },
    };

    if (requestedChannels.includes("push") && this.push) {
      result.push = await this.sendPush(userId, payload);
    }
    if (requestedChannels.includes("websocket") && this.realtime) {
      try {
        await this.realtime.publish(userId, payload);
        result.websocket.sent = true;
      } catch (error) {
        result.websocket.failed = true;
        result.websocket.error = error;
      }
    }
    return result;
  }

  private async sendPush(
    userId: string,
    payload: NotificationPayload,
  ): Promise<ChannelResult> {
    const result = emptyChannelResult(false);
    const subscriptions = await this.store.listByUser(userId);
    if (!subscriptions.length || !this.push) return result;
    let cursor = 0;
    const workerCount = Math.min(
      subscriptions.length,
      this.pushDispatch.concurrency,
    );
    const deliver = async () => {
      while (true) {
        const index = cursor++;
        const subscription = subscriptions[index];
        if (!subscription) return;
        let safeSubscription: PushSubscriptionRecord;
        try {
          const {
            id: _subscriptionId,
            userId: _recordUserId,
            ...subscriptionInput
          } = subscription;
          const normalized = await normalizePushSubscriptionInput(
            subscriptionInput,
            this.subscriptionValidation,
          );
          safeSubscription = {
            id: subscription.id,
            userId,
            ...normalized,
          };
        } catch (error) {
          result.failed += 1;
          result.errors.push(error);
          try {
            const removed = await this.store.removeForUser(
              userId,
              subscription.id,
            );
            if (removed) result.removed += 1;
          } catch (cleanupError) {
            result.errors.push(cleanupError);
          }
          continue;
        }
        try {
          await this.deliverPush(safeSubscription, payload);
          result.sent += 1;
        } catch (error) {
          result.failed += 1;
          result.errors.push(error);
          if (this.isInvalidPushError(error)) {
            try {
              const removed = await this.store.removeForUser(
                userId,
                subscription.id,
              );
              if (removed) result.removed += 1;
            } catch (cleanupError) {
              result.errors.push(cleanupError);
            }
            try {
              await this.onInvalidSubscription(subscription, error);
            } catch (callbackError) {
              result.errors.push(callbackError);
            }
          }
        }
      }
    };
    await Promise.all(Array.from({ length: workerCount }, () => deliver()));
    return result;
  }

  private isInvalidPushError(error: unknown): boolean {
    try {
      const custom = this.push?.isInvalidError?.(error);
      return custom === undefined ? isInvalidSubscriptionError(error) : custom;
    } catch {
      return isInvalidSubscriptionError(error);
    }
  }

  private async deliverPush(
    subscription: PushSubscriptionRecord,
    payload: NotificationPayload,
  ): Promise<void> {
    if (!this.push) return;
    for (let attempt = 0; ; attempt += 1) {
      const controller = new AbortController();
      try {
        await withTimeout(
          this.push.send(subscription, payload, controller.signal),
          this.pushDispatch.timeoutMs,
          () => controller.abort(),
        );
        return;
      } catch (error) {
        if (attempt >= this.pushDispatch.retries) throw error;
        let shouldRetry = !this.isInvalidPushError(error);
        if (this.pushDispatch.shouldRetry) {
          try {
            shouldRetry = this.pushDispatch.shouldRetry(error, attempt + 1);
          } catch {
            shouldRetry = false;
          }
        }
        if (!shouldRetry) throw error;
        const delay = Math.min(
          this.pushDispatch.retryDelayMs *
            this.pushDispatch.retryBackoffFactor ** attempt,
          this.pushDispatch.maxRetryDelayMs,
        );
        if (delay > 0) await sleep(delay);
      }
    }
  }
}

function sleep(milliseconds: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, milliseconds));
}

function withTimeout<T>(
  promise: Promise<T>,
  timeoutMs: number,
  onTimeout?: () => void,
): Promise<T> {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      onTimeout?.();
      reject(new PushDeliveryTimeoutError("Push delivery timed out"));
    }, timeoutMs);
    promise.then(
      (value) => {
        clearTimeout(timer);
        resolve(value);
      },
      (error: unknown) => {
        clearTimeout(timer);
        reject(error);
      },
    );
  });
}
