import { AsyncLocalStorage } from "node:async_hooks";

export interface RequestCache {
  captureCache: Map<string, Record<string, unknown>>;
}

/**
 * Singleton AsyncLocalStorage instance that provides a fresh
 * per-request cache. Each call to `withRequestCache()` creates a new
 * isolated Map; concurrent requests cannot read each other's entries.
 */
export const requestCacheStore = new AsyncLocalStorage<RequestCache>();

/**
 * Run a function inside a fresh request-scoped cache context.
 * The cache is automatically discarded when the callback completes.
 */
export function withRequestCache<T>(fn: () => T): T {
  return requestCacheStore.run({ captureCache: new Map() }, fn);
}

/**
 * Return the current request's capture cache. Throws if called outside
 * a `withRequestCache` boundary so the P1 silent-fallback bug cannot
 * hide in production.
 */
export function getCaptureCache(): Map<string, Record<string, unknown>> {
  const store = requestCacheStore.getStore();
  if (!store) {
    throw new Error(
      "getCaptureCache() called outside of request context — " +
      "call withRequestCache(() => ...) around this handler so readCaptureFile " +
      "can safely cache decrypted capture content.",
    );
  }
  return store.captureCache;
}
