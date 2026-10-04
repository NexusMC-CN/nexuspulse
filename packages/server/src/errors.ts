export class NexusPulseServerError extends Error {
  override readonly name: string = "NexusPulseServerError";

  constructor(message = "NexusPulse server error", options?: ErrorOptions) {
    super(message, options);
  }
}

export class InvalidSubscriptionError extends NexusPulseServerError {
  override readonly name = "InvalidSubscriptionError";
  readonly statusCode: number;

  constructor(
    message = "The push subscription is no longer valid",
    statusCode = 410,
  ) {
    super(message);
    this.statusCode = statusCode;
  }
}

export class MissingUserError extends NexusPulseServerError {
  override readonly name = "MissingUserError";
}

export class InvalidSubscriptionInputError extends NexusPulseServerError {
  override readonly name = "InvalidSubscriptionInputError";
}

export class InvalidNotificationPayloadError extends NexusPulseServerError {
  override readonly name = "InvalidNotificationPayloadError";
}

export class InvalidNotificationChannelError extends NexusPulseServerError {
  override readonly name = "InvalidNotificationChannelError";
}

export class PushDeliveryTimeoutError extends NexusPulseServerError {
  override readonly name = "PushDeliveryTimeoutError";
  readonly code = "PUSH_DELIVERY_TIMEOUT";
}

export function isInvalidSubscriptionError(error: unknown): boolean {
  if (error instanceof InvalidSubscriptionError) return true;
  if (!error || typeof error !== "object") return false;
  const candidate = error as { statusCode?: unknown; code?: unknown };
  return (
    candidate.statusCode === 404 ||
    candidate.statusCode === 410 ||
    candidate.code === "SUBSCRIPTION_GONE" ||
    candidate.code === "INVALID_SUBSCRIPTION"
  );
}
