import { InvalidConfigurationError } from "./errors.js";

function originOf(value: string): string | undefined {
  try {
    const url = new URL(value);
    return url.protocol === "http:" || url.protocol === "https:"
      ? url.origin
      : undefined;
  } catch {
    return undefined;
  }
}

export function resolveNotificationUrl(
  rawUrl: unknown,
  baseOrigin: string | undefined,
  allowedOrigins: readonly string[],
): URL | undefined {
  if (typeof rawUrl !== "string" || rawUrl.length === 0) return undefined;

  let url: URL;
  try {
    url = new URL(rawUrl, baseOrigin);
  } catch {
    throw new InvalidConfigurationError(
      "Notification click URL must be a valid absolute or relative URL",
    );
  }

  if (
    (url.protocol !== "http:" && url.protocol !== "https:") ||
    (url.origin !== baseOrigin &&
      !allowedOrigins.some((origin) => originOf(origin) === url.origin))
  ) {
    throw new InvalidConfigurationError(
      `Notification click URL uses a disallowed origin: ${url.origin}`,
    );
  }

  return url;
}
