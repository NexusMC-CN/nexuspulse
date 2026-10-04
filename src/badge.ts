type RuntimeRecord = Record<string, unknown>;

function asRecord(value: unknown): RuntimeRecord | undefined {
  return value !== null &&
    (typeof value === "object" || typeof value === "function")
    ? (value as RuntimeRecord)
    : undefined;
}

type SetBadge = (count?: number) => void | Promise<void>;
type ClearBadge = () => void | Promise<void>;

function getBadgingMethods(runtime: unknown): {
  set?: SetBadge;
  clear?: ClearBadge;
} {
  const root = asRecord(runtime);
  const navigator = asRecord(root?.navigator);
  const navigatorSet = navigator?.setAppBadge;
  const rootSet = root?.setAppBadge;
  const navigatorClear = navigator?.clearAppBadge;
  const rootClear = root?.clearAppBadge;

  return {
    set:
      typeof navigatorSet === "function"
        ? (navigatorSet as SetBadge).bind(navigator)
        : typeof rootSet === "function"
          ? (rootSet as SetBadge).bind(root)
          : undefined,
    clear:
      typeof navigatorClear === "function"
        ? (navigatorClear as ClearBadge).bind(navigator)
        : typeof rootClear === "function"
          ? (rootClear as ClearBadge).bind(root)
          : undefined,
  };
}

export async function setBadge(
  count?: number,
  runtime: unknown = globalThis,
): Promise<boolean> {
  const { set } = getBadgingMethods(runtime);
  if (!set) return false;
  if (count === undefined) {
    await set();
  } else {
    await set(count);
  }
  return true;
}

export async function clearBadge(
  runtime: unknown = globalThis,
): Promise<boolean> {
  const { clear } = getBadgingMethods(runtime);
  if (!clear) return false;
  await clear();
  return true;
}
