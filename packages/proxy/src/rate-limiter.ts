/**
 * @contextio/proxy - Rate Limiter Plugin
 *
 * Sliding-window rate limiter with optional request queue for burst handling.
 * By default tracks state per provider (all sessions share one bucket per provider).
 * Supports per-provider configuration overrides and optional per-session isolation.
 */

import type { ProxyPlugin, RequestContext } from "@contextio/core";

/**
 * Strategy for generating rate limit keys.
 * - "provider": All sessions share the same bucket per provider (default).
 *   Use this when the proxy appears as a single client to upstream providers.
 * - "session-provider": Each session has its own bucket per provider.
 *   Use this for testing or when the proxy forwards client identity.
 * - "custom": Use the provided `keyGenerator` function.
 */
export type KeyStrategy = "provider" | "session-provider" | "custom";

/**
 * Configuration for the rate limiter plugin.
 *
 * Supports two formats for backward compatibility:
 * 1. Flat format (legacy): { maxRequests, windowMs, bufferCapacity, ... }
 * 2. Nested format (new): { defaults: { maxRequests, windowMs, bufferCapacity }, providers: {...} }
 *
 * The flat format is deprecated but still supported.
 */
export interface RateLimiterConfig {
  /**
   * Maximum number of requests allowed per window.
   * @default 60
   * @deprecated Use defaults.maxRequests instead
   */
  maxRequests?: number;

  /**
   * Time window in milliseconds for the rate limit.
   * @default 60000 (1 minute)
   * @deprecated Use defaults.windowMs instead
   */
  windowMs?: number;

  /**
   * Queue capacity for burst handling (requests waiting when limit is reached).
   * Does NOT increase the request limit — only allows queuing.
   * @default 10
   * @deprecated Use defaults.bufferCapacity instead
   */
  bufferCapacity?: number;

  /**
   * Default rate limit configuration.
   * Use this instead of the deprecated top-level fields.
   */
  defaults?: {
    /** Maximum number of requests allowed per window. @default 60 */
    maxRequests?: number;
    /** Time window in milliseconds for the rate limit. @default 60000 (1 minute) */
    windowMs?: number;
    /** Queue capacity for burst handling. @default 10 */
    bufferCapacity?: number;
  };

  /**
   * Per-provider rate limit configuration.
   * Overrides defaults for specific providers.
   * Keys are provider names (e.g., "openai", "nvidia", "anthropic").
   */
  providers?: Record<string, {
    /** Maximum number of requests allowed per window. */
    maxRequests?: number;
    /** Time window in milliseconds for the rate limit. */
    windowMs?: number;
    /** Queue capacity for burst handling. */
    bufferCapacity?: number;
  }>;

  /**
   * Strategy for generating rate limit keys.
   * @default "provider"
   */
  keyStrategy?: KeyStrategy;

  /**
   * Maximum number of unique session/provider buckets to track.
   * Prevents unbounded memory growth. Oldest buckets are evicted first (LRU).
   * @default 10000
   */
  maxEntries?: number;

  /**
   * Interval in milliseconds for cleaning up stale entries.
   * @default 300000 (5 minutes)
   */
  cleanupIntervalMs?: number;

  /**
   * Maximum time in milliseconds an entry can be inactive before being removed.
   * @default 600000 (10 minutes)
   */
  entryTtlMs?: number;

  /**
   * Whether to enable the rate limiter.
   * @default true
   */
  enabled?: boolean;

  /**
   * Custom key generator for rate limiting.
   * Only used when keyStrategy is "custom".
   * By default uses the provider name.
   */
  keyGenerator?: (ctx: RequestContext) => string;

  /**
   * Callback when a request is rate limited.
   * Useful for logging or metrics.
   */
  onRateLimited?: (ctx: RequestContext, retryAfterMs: number) => void;
}

/**
 * Internal state for a rate limit bucket.
 * Uses a sliding window of request timestamps for precise limiting.
 */
interface BucketState {
  /** Timestamps of requests in the current window (ms since epoch) */
  requestTimestamps: number[];
  /** Queue of waiting requests when limit is reached */
  queue: Array<{
    resolve: (value: RequestContext) => void;
    reject: (error: Error) => void;
    ctx: RequestContext;
    enqueuedAt: number;
  }>;
  /** Last access time for LRU eviction */
  lastAccessed: number;
  /** Timer for processing queued requests */
  queueTimer: NodeJS.Timeout | null;
}

/**
 * Default configuration values.
 */
const DEFAULT_MAX_REQUESTS = 60;
const DEFAULT_WINDOW_MS = 60_000; // 1 minute
const DEFAULT_BUFFER_CAPACITY = 10;
const DEFAULT_MAX_ENTRIES = 10_000;
const DEFAULT_CLEANUP_INTERVAL_MS = 300_000; // 5 minutes
const DEFAULT_ENTRY_TTL_MS = 600_000; // 10 minutes

/**
 * Generate a rate limit key using sessionId and provider.
 * This provides per-session isolation (legacy behavior).
 */
function sessionProviderKeyGenerator(ctx: RequestContext): string {
  const sessionId = ctx.sessionId ?? "__default__";
  const provider = ctx.provider ?? "unknown";
  return `${sessionId}:${provider}`;
}

/**
 * Generate the default rate limit key.
 *
 * By default, uses only the provider since all requests through the proxy
 * appear to come from a single source to the upstream provider.
 * Per-session limiting can be enabled via the `keyStrategy` config option.
 */
function defaultKeyGenerator(ctx: RequestContext): string {
  const provider = ctx.provider ?? "unknown";
  return provider;
}

/**
 * Internal resolved configuration (all values required, no optional fields).
 */
interface ResolvedRateLimiterConfig {
  maxRequests: number;
  windowMs: number;
  bufferCapacity: number;
  maxEntries: number;
  cleanupIntervalMs: number;
  entryTtlMs: number;
  enabled: boolean;
  keyGenerator: (ctx: RequestContext) => string;
  onRateLimited: (ctx: RequestContext, retryAfterMs: number) => void;
  providers: Record<string, {
    maxRequests: number;
    windowMs: number;
    bufferCapacity: number;
  }>;
}

/**
 * Rate limiter plugin class implementing a sliding-window algorithm.
 * Enforces a hard limit of maxRequests per windowMs with optional queue for burst handling.
 */
export class RateLimiterPlugin implements ProxyPlugin {
  name = "rate-limiter";

  private readonly config: ResolvedRateLimiterConfig;
  private readonly buckets = new Map<string, BucketState>();
  private cleanupTimer: NodeJS.Timeout | null = null;

  constructor(config: RateLimiterConfig = {}) {
    // Support both flat (legacy) and nested formats for backward compatibility
    // Flat: { maxRequests, windowMs, bufferCapacity, ... }
    // Nested: { defaults: { maxRequests, windowMs, bufferCapacity }, providers: {...}, ... }
    const defaults = config.defaults ?? {};
    const maxRequests = config.maxRequests ?? defaults.maxRequests ?? DEFAULT_MAX_REQUESTS;
    const windowMs = config.windowMs ?? defaults.windowMs ?? DEFAULT_WINDOW_MS;
    const bufferCapacity = config.bufferCapacity ?? defaults.bufferCapacity ?? DEFAULT_BUFFER_CAPACITY;
    const maxEntries = config.maxEntries ?? DEFAULT_MAX_ENTRIES;
    const cleanupIntervalMs = config.cleanupIntervalMs ?? DEFAULT_CLEANUP_INTERVAL_MS;
    const entryTtlMs = config.entryTtlMs ?? DEFAULT_ENTRY_TTL_MS;

    if (maxRequests <= 0) {
      throw new Error("maxRequests must be positive");
    }
    if (windowMs <= 0) {
      throw new Error("windowMs must be positive");
    }
    if (bufferCapacity < 0) {
      throw new Error("bufferCapacity must be non-negative");
    }
    if (maxEntries <= 0) {
      throw new Error("maxEntries must be positive");
    }
    if (cleanupIntervalMs <= 0) {
      throw new Error("cleanupIntervalMs must be positive");
    }
    if (entryTtlMs <= 0) {
      throw new Error("entryTtlMs must be positive");
    }

    // Parse per-provider config
    const providers: Record<string, { maxRequests: number; windowMs: number; bufferCapacity: number }> = {};
    if (config.providers) {
      for (const [provider, pConfig] of Object.entries(config.providers)) {
        providers[provider] = {
          maxRequests: pConfig.maxRequests ?? maxRequests,
          windowMs: pConfig.windowMs ?? windowMs,
          bufferCapacity: pConfig.bufferCapacity ?? bufferCapacity,
        };
      }
    }

    // Determine key generator based on keyStrategy
    let keyGenerator: (ctx: RequestContext) => string;
    const keyStrategy = config.keyStrategy ?? "provider";
    if (keyStrategy === "session-provider") {
      keyGenerator = config.keyGenerator ?? sessionProviderKeyGenerator;
    } else if (keyStrategy === "custom") {
      keyGenerator = config.keyGenerator ?? defaultKeyGenerator;
    } else {
      // "provider" (default) - share bucket across all sessions per provider
      keyGenerator = config.keyGenerator ?? defaultKeyGenerator;
    }

    this.config = {
      maxRequests,
      windowMs,
      bufferCapacity,
      maxEntries,
      cleanupIntervalMs,
      entryTtlMs,
      enabled: config.enabled ?? true,
      keyGenerator,
      onRateLimited: config.onRateLimited ?? (() => {}),
      providers,
    };

    this.startCleanupTimer();
  }

  /**
   * Get the rate limit config for a specific provider.
   * Falls back to defaults if provider not configured.
   */
  private getProviderConfig(provider: string): { maxRequests: number; windowMs: number; bufferCapacity: number } {
    const p = this.config.providers[provider];
    if (p) {
      return {
        maxRequests: p.maxRequests,
        windowMs: p.windowMs,
        bufferCapacity: p.bufferCapacity,
      };
    }
    // Fall back to defaults
    return {
      maxRequests: this.config.maxRequests,
      windowMs: this.config.windowMs,
      bufferCapacity: this.config.bufferCapacity,
    };
  }

  /**
   * Extract provider from bucket key.
   * With keyStrategy="provider" (default), key is just the provider name.
   * With keyStrategy="session-provider", key format is "sessionId:provider".
   */
  private getProviderFromKey(key: string): string {
    // If key contains a colon, it's the legacy/session-provider format
    const lastColonIndex = key.lastIndexOf(":");
    return lastColonIndex >= 0 ? key.slice(lastColonIndex + 1) : key;
  }

  /**
   * Start the periodic cleanup timer.
   */
  private startCleanupTimer(): void {
    if (this.cleanupTimer) return;

    this.cleanupTimer = setInterval(() => {
      this.cleanupStaleBuckets();
    }, this.config.cleanupIntervalMs);

    this.cleanupTimer.unref?.();
  }

  /**
   * Stop the periodic cleanup timer.
   */
  private stopCleanupTimer(): void {
    if (this.cleanupTimer) {
      clearInterval(this.cleanupTimer);
      this.cleanupTimer = null;
    }
  }

  /**
   * Clean up stale buckets and enforce maxEntries limit.
   */
  private cleanupStaleBuckets(): void {
    const now = Date.now();
    let cleaned = 0;

    for (const [key, bucket] of this.buckets) {
      if (now - bucket.lastAccessed > this.config.entryTtlMs) {
        this.rejectQueue(bucket, new Error("Rate limiter entry expired"));
        if (bucket.queueTimer) {
          clearTimeout(bucket.queueTimer);
        }
        this.buckets.delete(key);
        cleaned++;
      }
    }

    // Enforce maxEntries with LRU eviction
    if (this.buckets.size > this.config.maxEntries) {
      const entries = Array.from(this.buckets.entries())
        .sort((a, b) => a[1].lastAccessed - b[1].lastAccessed);

      const toRemove = entries.slice(0, this.buckets.size - this.config.maxEntries);
      for (const [key, bucket] of toRemove) {
        this.rejectQueue(bucket, new Error("Rate limiter evicted (maxEntries)"));
        if (bucket.queueTimer) {
          clearTimeout(bucket.queueTimer);
        }
        this.buckets.delete(key);
        cleaned++;
      }
    }

    if (cleaned > 0) {
      console.debug(`[rate-limiter] Cleaned up ${cleaned} stale bucket(s)`);
    }
  }

  /**
   * Reject all queued requests in a bucket.
   */
  private rejectQueue(bucket: BucketState, error: Error): void {
    for (const queued of bucket.queue) {
      queued.reject(error);
    }
    bucket.queue = [];
  }

  /**
   * Get or create a bucket for the given key.
   */
  private getBucket(key: string): BucketState {
    let bucket = this.buckets.get(key);
    const now = Date.now();

    if (!bucket) {
      // Enforce maxEntries limit with LRU eviction before creating new bucket
      this.enforceMaxEntries();

      bucket = {
        requestTimestamps: [],
        queue: [],
        lastAccessed: now,
        queueTimer: null,
      };
      this.buckets.set(key, bucket);
    }

    bucket.lastAccessed = now;

    // Move to end for LRU (delete and re-add)
    this.buckets.delete(key);
    this.buckets.set(key, bucket);

    return bucket;
  }

  /**
   * Enforce maxEntries limit by evicting LRU buckets.
   * Called when a new bucket would exceed the limit.
   */
  private enforceMaxEntries(): void {
    if (this.config.maxEntries <= 0) return;
    if (this.buckets.size < this.config.maxEntries) return;

    // Evict oldest entries
    const entries = Array.from(this.buckets.entries())
      .sort((a, b) => a[1].lastAccessed - b[1].lastAccessed);

    const toRemove = entries.slice(0, this.buckets.size - this.config.maxEntries + 1);
    for (const [key, bucket] of toRemove) {
      this.rejectQueue(bucket, new Error("Rate limiter evicted (maxEntries)"));
      if (bucket.queueTimer) {
        clearTimeout(bucket.queueTimer);
      }
      this.buckets.delete(key);
    }
  }

  /**
   * Remove expired timestamps from the sliding window.
   * Returns the number of valid requests in the current window.
   */
  private pruneWindow(bucket: BucketState, windowStart: number): number {
    // Filter timestamps to only those within the window
    const validTimestamps = bucket.requestTimestamps.filter(ts => ts >= windowStart);
    bucket.requestTimestamps = validTimestamps;
    return validTimestamps.length;
  }

  /**
   * Calculate milliseconds until the oldest request in the window expires.
   * Returns 0 if window is not full.
   */
  private calculateRetryAfter(bucket: BucketState, windowStart: number, maxRequests: number): number {
    const validCount = bucket.requestTimestamps.length;
    if (validCount < maxRequests) return 0;

    // Oldest request in the window determines when a slot opens up
    const oldestTimestamp = bucket.requestTimestamps[0];
    const msUntilExpiry = oldestTimestamp + (this.config.windowMs - (Date.now() - oldestTimestamp));
    // Actually: oldestTimestamp + windowMs - now = time until oldest leaves window
    const ms = (oldestTimestamp + this.config.windowMs) - Date.now();
    return Math.max(1, Math.ceil(ms));
  }

  /**
   * Schedule or update the queue processing timer.
   */
  private scheduleQueueTimer(bucket: BucketState, key: string): void {
    // Clear existing timer
    if (bucket.queueTimer) {
      clearTimeout(bucket.queueTimer);
      bucket.queueTimer = null;
    }

    if (bucket.queue.length === 0) {
      return;
    }

    const provider = this.getProviderFromKey(key);
    const pConfig = this.getProviderConfig(provider);
    const now = Date.now();
    const windowStart = now - pConfig.windowMs;

    // Prune and check if a slot is available
    this.pruneWindow(bucket, windowStart);

    if (bucket.requestTimestamps.length < pConfig.maxRequests) {
      // Slot available - process queue immediately
      this.processQueue(bucket, key);
      return;
    }

    // No slot yet - wait until oldest request expires
    const retryAfterMs = this.calculateRetryAfter(bucket, windowStart, pConfig.maxRequests);

    bucket.queueTimer = setTimeout(() => {
      bucket.queueTimer = null;
      this.processQueue(bucket, key);
    }, retryAfterMs);

    bucket.queueTimer.unref?.();
  }

  /**
   * Process waiting queue: admit as many requests as window allows.
   */
  private processQueue(bucket: BucketState, key: string): void {
    const now = Date.now();
    const provider = this.getProviderFromKey(key);
    const pConfig = this.getProviderConfig(provider);
    const windowStart = now - pConfig.windowMs;

    // Prune expired timestamps
    this.pruneWindow(bucket, windowStart);

    while (bucket.queue.length > 0 && bucket.requestTimestamps.length < pConfig.maxRequests) {
      const queued = bucket.queue.shift()!;
      bucket.requestTimestamps.push(now);
      queued.resolve(queued.ctx);
    }

    // If there are still waiters, schedule next check
    if (bucket.queue.length > 0) {
      this.scheduleQueueTimer(bucket, key);
    }
  }

  async onRequest(ctx: RequestContext): Promise<RequestContext> {
    if (!this.config.enabled) {
      return ctx;
    }

    const key = this.config.keyGenerator(ctx);
    const bucket = this.getBucket(key);

    const provider = this.getProviderFromKey(key);
    const pConfig = this.getProviderConfig(provider);
    const now = Date.now();
    const windowStart = now - pConfig.windowMs;

    // Prune expired timestamps
    const currentCount = this.pruneWindow(bucket, windowStart);

    // Try to admit request immediately
    if (currentCount < pConfig.maxRequests) {
      bucket.requestTimestamps.push(now);
      return ctx;
    }

    // Limit reached - check if we can queue
    if (bucket.queue.length < pConfig.bufferCapacity) {
      // Queue the request
      return new Promise<RequestContext>((resolve, reject) => {
        bucket.queue.push({ resolve, reject, ctx, enqueuedAt: now });
        this.scheduleQueueTimer(bucket, key);
      });
    }

    // Queue is full - rate limited
    const retryAfterMs = this.calculateRetryAfter(bucket, windowStart, pConfig.maxRequests);

    try {
      this.config.onRateLimited(ctx, retryAfterMs);
    } catch {
      // Ignore errors in rate limit callback
    }

    const error = new Error("Rate limit exceeded") as Error & {
      statusCode: number;
      retryAfter: number;
      rateLimitInfo: {
        limit: number;
        remaining: number;
        reset: number;
        retryAfter: number;
      };
    };
    error.statusCode = 429;
    error.retryAfter = retryAfterMs;
    error.rateLimitInfo = {
      limit: pConfig.maxRequests,
      remaining: 0,
      reset: Math.ceil((Date.now() + retryAfterMs) / 1000),
      retryAfter: retryAfterMs,
    };

    throw error;
  }

  /**
   * Get current bucket state for a key (for testing/inspection).
   */
  getBucketState(key: string): Readonly<BucketState> | undefined {
    return this.buckets.get(key);
  }

  /**
   * Get rate limiter configuration summary.
   */
  getConfigSummary(): {
    maxRequests: number;
    windowMs: number;
    bufferCapacity: number;
    maxEntries: number;
    enabled: boolean;
  } {
    return {
      maxRequests: this.config.maxRequests,
      windowMs: this.config.windowMs,
      bufferCapacity: this.config.bufferCapacity,
      maxEntries: this.config.maxEntries,
      enabled: this.config.enabled,
    };
  }

  /**
   * Get all bucket keys (for testing/inspection).
   */
  getAllKeys(): string[] {
    return Array.from(this.buckets.keys());
  }

  /**
   * Get all bucket states for metrics/monitoring.
   * Returns a serializable representation of all buckets.
   */
  getAllBucketStates(): Array<{
    key: string;
    tokens: number;
    maxTokens: number;
    bufferCapacity: number;
    queueLength: number;
    requestsInWindow: number;
  }> {
    const states: Array<{
      key: string;
      tokens: number;
      maxTokens: number;
      bufferCapacity: number;
      queueLength: number;
      requestsInWindow: number;
    }> = [];

    const now = Date.now();

    for (const [key, bucket] of this.buckets.entries()) {
      const provider = this.getProviderFromKey(key);
      const pConfig = this.getProviderConfig(provider);
      const windowStart = now - pConfig.windowMs;

      // Count requests in current window
      const requestsInWindow = this.pruneWindow({ ...bucket, requestTimestamps: [...bucket.requestTimestamps] }, windowStart);
      const maxTokens = pConfig.maxRequests; // For compatibility with existing metrics
      const tokens = Math.max(0, pConfig.maxRequests - requestsInWindow); // "Remaining" in window

      states.push({
        key,
        tokens,
        maxTokens,
        bufferCapacity: pConfig.bufferCapacity,
        queueLength: bucket.queue.length,
        requestsInWindow,
      });
    }

    return states;
  }

  /**
   * Clear all buckets (for testing).
   */
  clear(): void {
    for (const bucket of this.buckets.values()) {
      this.rejectQueue(bucket, new Error("Rate limiter cleared"));
      if (bucket.queueTimer) {
        clearTimeout(bucket.queueTimer);
      }
    }
    this.buckets.clear();
  }

  /**
   * Shutdown the rate limiter (stops cleanup timer).
   */
  shutdown(): void {
    this.stopCleanupTimer();
    this.clear();
  }
}

/**
 * Create a rate limiter plugin with sliding-window algorithm.
 *
 * @param config - Rate limiter configuration
 * @returns ProxyPlugin implementing rate limiting
 *
 * @example
 * ```typescript
 * import { createRateLimiterPlugin } from "@contextio/proxy";
 *
 * const rateLimiter = createRateLimiterPlugin({
 *   defaults: { maxRequests: 100, windowMs: 60_000, bufferCapacity: 20 },
 *   providers: {
 *     nvidia: { maxRequests: 40, windowMs: 60_000, bufferCapacity: 10 },
 *   },
 * });
 * ```
 */
export function createRateLimiterPlugin(config: RateLimiterConfig = {}): ProxyPlugin {
  const limiter = new RateLimiterPlugin(config);

  const plugin: ProxyPlugin = {
    name: "rate-limiter",
    onRequest: (ctx: RequestContext) => limiter.onRequest(ctx),
  };

  // Attach internal methods for testing/graceful shutdown
  (plugin as any)._internal = {
    getBucketState: (key: string) => limiter.getBucketState(key),
    getAllKeys: () => limiter.getAllKeys(),
    getAllBucketStates: () => limiter.getAllBucketStates(),
    getConfigSummary: () => limiter.getConfigSummary(),
    clear: () => limiter.clear(),
    shutdown: () => limiter.shutdown(),
  };

  return plugin;
}