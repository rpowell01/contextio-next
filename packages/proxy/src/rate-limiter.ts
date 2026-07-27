/**
 * @contextio/proxy - Rate Limiter Plugin
 *
 * Token bucket rate limiter with optional burst buffer.
 * Tracks state per sessionId + provider combination.
 */

import type { ProxyPlugin, RequestContext } from "@contextio/core";

/**
 * Configuration for the rate limiter plugin.
 */
export interface RateLimiterConfig {
  /**
   * Maximum number of requests allowed per window.
   * @default 60
   */
  maxRequests?: number;

  /**
   * Time window in milliseconds for the rate limit.
   * @default 60000 (1 minute)
   */
  windowMs?: number;

  /**
   * Additional burst capacity beyond maxRequests.
   * Allows short bursts of traffic above the steady-state rate.
   * @default 10
   */
  bufferCapacity?: number;

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
   * By default uses `${sessionId}:${provider}`.
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
 */
interface BucketState {
  tokens: number;
  lastRefill: number;
  queue: Array<{
    resolve: (value: RequestContext) => void;
    reject: (error: Error) => void;
    ctx: RequestContext;
  }>;
  lastAccessed: number;
  refillTimer: NodeJS.Timeout | null;
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
const TOKEN_EPSILON = 1e-10; // Floating-point comparison epsilon

/**
 * Generate the default rate limit key from sessionId and provider.
 */
function defaultKeyGenerator(ctx: RequestContext): string {
  const sessionId = ctx.sessionId ?? "__default__";
  const provider = ctx.provider ?? "unknown";
  return `${sessionId}:${provider}`;
}

/**
 * Rate limiter plugin class implementing the token bucket algorithm.
 */
export class RateLimiterPlugin implements ProxyPlugin {
  name = "rate-limiter";

  private readonly config: Required<RateLimiterConfig>;
  private readonly buckets = new Map<string, BucketState>();
  private readonly refillRate: number;
  private cleanupTimer: NodeJS.Timeout | null = null;

  constructor(config: RateLimiterConfig = {}) {
    // Validate configuration
    const maxRequests = config.maxRequests ?? DEFAULT_MAX_REQUESTS;
    const windowMs = config.windowMs ?? DEFAULT_WINDOW_MS;
    const bufferCapacity = config.bufferCapacity ?? DEFAULT_BUFFER_CAPACITY;
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

    this.config = {
      maxRequests,
      windowMs,
      bufferCapacity,
      maxEntries,
      cleanupIntervalMs,
      entryTtlMs,
      enabled: config.enabled ?? true,
      keyGenerator: config.keyGenerator ?? defaultKeyGenerator,
      onRateLimited: config.onRateLimited ?? (() => {}),
    };

    this.refillRate = this.config.maxRequests / this.config.windowMs;
    this.startCleanupTimer();
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
        if (bucket.refillTimer) {
          clearTimeout(bucket.refillTimer);
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
        if (bucket.refillTimer) {
          clearTimeout(bucket.refillTimer);
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
        tokens: this.config.maxRequests,
        lastRefill: now,
        queue: [],
        lastAccessed: now,
        refillTimer: null,
      };
      this.buckets.set(key, bucket);
    }

    this.refillTokens(bucket, now);
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
      if (bucket.refillTimer) {
        clearTimeout(bucket.refillTimer);
      }
      this.buckets.delete(key);
    }
  }

  /**
   * Refill tokens based on elapsed time since last refill.
   */
  private refillTokens(bucket: BucketState, now: number): void {
    const elapsed = now - bucket.lastRefill;
    if (elapsed <= 0) return;

    const tokensToAdd = elapsed * this.refillRate;
    bucket.tokens = Math.min(
      this.config.maxRequests + this.config.bufferCapacity,
      bucket.tokens + tokensToAdd
    );
    bucket.lastRefill = now;
  }

  /**
   * Try to consume a token from the bucket.
   * Returns true if successful, false if no tokens available.
   */
  private tryConsumeToken(bucket: BucketState): boolean {
    if (bucket.tokens >= 1 - TOKEN_EPSILON) {
      bucket.tokens -= 1;
      return true;
    }
    return false;
  }

  /**
   * Calculate milliseconds until next token is available.
   */
  private calculateRetryAfter(bucket: BucketState): number {
    if (bucket.tokens >= 1 - TOKEN_EPSILON) return 0;

    const tokensNeeded = 1 - bucket.tokens;
    const msUntilToken = tokensNeeded / this.refillRate;
    return Math.ceil(msUntilToken);
  }

  /**
   * Schedule or update the refill timer for a bucket.
   * This timer fires when the next token becomes available.
   */
  private scheduleRefillTimer(bucket: BucketState): void {
    // Clear existing timer
    if (bucket.refillTimer) {
      clearTimeout(bucket.refillTimer);
      bucket.refillTimer = null;
    }

    // If there are tokens available, process queue immediately
    if (bucket.tokens >= 1 - TOKEN_EPSILON) {
      this.processQueue(bucket);
      return;
    }

    // If queue is empty, no need for timer
    if (bucket.queue.length === 0) {
      return;
    }

    // Calculate when next token will be available
    const retryAfterMs = this.calculateRetryAfter(bucket);

    bucket.refillTimer = setTimeout(() => {
      bucket.refillTimer = null;
      const now = Date.now();
      this.refillTokens(bucket, now);
      this.processQueue(bucket);
    }, retryAfterMs);

    bucket.refillTimer.unref?.();
  }

  /**
   * Process waiting queue: admit as many requests as tokens allow.
   */
  private processQueue(bucket: BucketState): void {
    while (bucket.queue.length > 0 && bucket.tokens >= 1 - TOKEN_EPSILON) {
      const queued = bucket.queue.shift()!;
      this.tryConsumeToken(bucket);
      queued.resolve(queued.ctx);
    }

    // If there are still waiters, schedule next refill timer
    if (bucket.queue.length > 0) {
      this.scheduleRefillTimer(bucket);
    }
  }

  async onRequest(ctx: RequestContext): Promise<RequestContext> {
    if (!this.config.enabled) {
      return ctx;
    }

    const key = this.config.keyGenerator(ctx);
    const bucket = this.getBucket(key);

    // Try to consume a token immediately
    if (this.tryConsumeToken(bucket)) {
      return ctx;
    }

    // No tokens available - check if we can queue
    if (bucket.queue.length < this.config.bufferCapacity) {
      // Queue the request
      return new Promise<RequestContext>((resolve, reject) => {
        bucket.queue.push({ resolve, reject, ctx });
        this.scheduleRefillTimer(bucket);
      });
    }

    // Queue is full - rate limited
    const retryAfterMs = this.calculateRetryAfter(bucket);

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
      limit: this.config.maxRequests,
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
   * Get all bucket keys (for testing/inspection).
   */
  getAllKeys(): string[] {
    return Array.from(this.buckets.keys());
  }

  /**
   * Clear all buckets (for testing).
   */
  clear(): void {
    for (const bucket of this.buckets.values()) {
      this.rejectQueue(bucket, new Error("Rate limiter cleared"));
      if (bucket.refillTimer) {
        clearTimeout(bucket.refillTimer);
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
 * Create a rate limiter plugin with token bucket algorithm.
 *
 * @param config - Rate limiter configuration
 * @returns ProxyPlugin implementing rate limiting
 *
 * @example
 * ```typescript
 * import { createRateLimiterPlugin } from "@contextio/proxy";
 *
 * const rateLimiter = createRateLimiterPlugin({
 *   maxRequests: 100,
 *   windowMs: 60_000,
 *   bufferCapacity: 20,
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
    clear: () => limiter.clear(),
    shutdown: () => limiter.shutdown(),
  };

  return plugin;
}