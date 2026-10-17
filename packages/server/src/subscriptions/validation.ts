import {
  EndpointValidationError,
  InvalidSubscriptionInputError,
} from "../errors.js";
import type {
  PushSubscriptionInput,
  PushSubscriptionRecord,
  SubscriptionValidationOptions,
} from "../types.js";

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

/** Validate client subscription input using a strict field allowlist. */
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
    } catch (cause) {
      // A thrown input error is still a policy execution failure, not a denial.
      throw new EndpointValidationError(
        "The subscription endpoint policy failed",
        {
          cause,
        },
      );
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

/** Project host storage records before applying the protocol field allowlist. */
export async function normalizeStoredPushSubscriptionRecord(
  subscription: PushSubscriptionRecord,
  userId: string,
  options: SubscriptionValidationOptions,
): Promise<PushSubscriptionRecord> {
  const normalized = await normalizePushSubscriptionInput(
    {
      endpoint: subscription.endpoint,
      expirationTime: subscription.expirationTime,
      keys: subscription.keys,
    },
    options,
  );
  return { id: subscription.id, userId, ...normalized };
}
