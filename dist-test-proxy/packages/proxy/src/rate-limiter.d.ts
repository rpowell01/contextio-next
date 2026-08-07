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
    /** Provider name (e.g., "openai", "nvidia") - stored separately for custom key generators */
    provider?: string;
    /** Session ID - stored separately for custom key generators */
    sessionId?: string;
}
/**
 * Rate limiter plugin class implementing a sliding-window algorithm.
 * Enforces a hard limit of maxRequests per windowMs with optional queue for burst handling.
 */
export declare class RateLimiterPlugin implements ProxyPlugin {
    name: string;
    private readonly config;
    private readonly buckets;
    private cleanupTimer;
    constructor(config?: RateLimiterConfig);
    /**
     * Get the rate limit config for a specific provider.
     * Falls back to defaults if provider not configured.
     */
    private getProviderConfig;
    /**
     * Extract provider from bucket key (fallback for old buckets without stored provider).
     * With keyStrategy="provider" (default), key is just the provider name.
     * With keyStrategy="session-provider", key format is "sessionId:provider".
     */
    private getProviderFromKey;
    /**
     * Start the periodic cleanup timer.
     */
    private startCleanupTimer;
    /**
     * Stop the periodic cleanup timer.
     */
    private stopCleanupTimer;
    /**
     * Clean up stale buckets and enforce maxEntries limit.
     */
    private cleanupStaleBuckets;
    /**
     * Reject all queued requests in a bucket.
     */
    private rejectQueue;
    /**
     * Get or create a bucket for the given key.
     */
    private getBucket;
    /**
     * Enforce maxEntries limit by evicting LRU buckets.
     * Called when a new bucket would exceed the limit.
     */
    private enforceMaxEntries;
    /**
     * Remove expired timestamps from the sliding window.
     * Returns the number of valid requests in the current window.
     */
    private pruneWindow;
    /**
     * Calculate milliseconds until the oldest request in the window expires.
     * Returns 0 if window is not full.
     */
    private calculateRetryAfter;
    /**
     * Schedule or update the queue processing timer.
     */
    private scheduleQueueTimer;
    /**
     * Process waiting queue: admit as many requests as window allows.
     */
    private processQueue;
    onRequest(ctx: RequestContext): Promise<RequestContext>;
    /**
     * Get current bucket state for a key (for testing/inspection).
     */
    getBucketState(key: string): Readonly<BucketState> | undefined;
    /**
     * Get rate limiter configuration summary.
     */
    getConfigSummary(): {
        maxRequests: number;
        windowMs: number;
        bufferCapacity: number;
        maxEntries: number;
        enabled: boolean;
    };
    /**
     * Get all bucket keys (for testing/inspection).
     */
    getAllKeys(): string[];
    /**
     * Get all bucket states for metrics/monitoring.
     * Returns a serializable representation of all buckets.
     * Does not mutate bucket state - computes metrics from a snapshot.
     */
    getAllBucketStates(): Array<{
        key: string;
        tokens: number;
        maxTokens: number;
        bufferCapacity: number;
        queueLength: number;
        lastAccessed: number;
        lastRefill: number;
        requestsInWindow: number;
        provider?: string;
        sessionId?: string;
    }>;
    /**
     * Clear all buckets (for testing).
     */
    clear(): void;
    /**
     * Shutdown the rate limiter (stops cleanup timer).
     */
    shutdown(): void;
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
export declare function createRateLimiterPlugin(config?: RateLimiterConfig): ProxyPlugin;
export {};
//# sourceMappingURL=rate-limiter.d.ts.map