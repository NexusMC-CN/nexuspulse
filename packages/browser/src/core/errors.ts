export class UnsupportedFeatureError extends Error {
  constructor(message = "The requested feature is not supported") {
    super(message);
    this.name = "UnsupportedFeatureError";
  }
}

export class PermissionDeniedError extends Error {
  constructor(message = "Permission was denied") {
    super(message);
    this.name = "PermissionDeniedError";
  }
}

export class SubscriptionError extends Error {
  constructor(message = "Push subscription failed") {
    super(message);
    this.name = "SubscriptionError";
  }
}

export class ConnectionError extends Error {
  constructor(message = "WebSocket connection failed") {
    super(message);
    this.name = "ConnectionError";
  }
}

export class InvalidConfigurationError extends Error {
  constructor(message = "Invalid NexusPulse configuration") {
    super(message);
    this.name = "InvalidConfigurationError";
  }
}
