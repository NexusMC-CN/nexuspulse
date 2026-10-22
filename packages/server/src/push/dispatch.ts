import {
  PushDeliveryTimeoutError,
  isInvalidSubscriptionError,
} from "../core/errors.js";
import type {
  NotificationPayload,
  PushDispatchOptions,
  PushSubscriptionRecord,
  PushTransport,
} from "../core/types.js";

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

export class PushDispatcher {
  readonly concurrency: number;
  private readonly options: ReturnType<typeof normalizeDispatchOptions>;

  constructor(
    private readonly transport: PushTransport,
    options?: PushDispatchOptions,
  ) {
    this.options = normalizeDispatchOptions(options);
    this.concurrency = this.options.concurrency;
  }

  isInvalidError(error: unknown): boolean {
    try {
      const custom = this.transport.isInvalidError?.(error);
      return custom === undefined ? isInvalidSubscriptionError(error) : custom;
    } catch {
      return isInvalidSubscriptionError(error);
    }
  }

  async deliver(
    subscription: PushSubscriptionRecord,
    payload: NotificationPayload,
  ): Promise<void> {
    for (let attempt = 0; ; attempt += 1) {
      const controller = new AbortController();
      try {
        await withTimeout(
          this.transport.send(subscription, payload, controller.signal),
          this.options.timeoutMs,
          () => controller.abort(),
        );
        return;
      } catch (error) {
        if (attempt >= this.options.retries) throw error;
        let shouldRetry = !this.isInvalidError(error);
        if (this.options.shouldRetry) {
          try {
            shouldRetry = this.options.shouldRetry(error, attempt + 1);
          } catch {
            shouldRetry = false;
          }
        }
        if (!shouldRetry) throw error;
        const delay = Math.min(
          this.options.retryDelayMs *
            this.options.retryBackoffFactor ** attempt,
          this.options.maxRetryDelayMs,
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
