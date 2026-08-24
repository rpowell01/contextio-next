/**
 * Client-safe type definitions for the web package.
 * These types are safe to use in client components because they don't depend on @contextio/core
 * which has server-only dependencies (better-sqlite3, fs, etc.).
 */

/**
 * Rate limiter bucket state for visualization
 */
export interface RateLimiterBucketState {
  /** Bucket identifier (e.g., provider name) */
  key: string;
  /** Current number of tokens in the bucket */
  tokens: number;
  /** Maximum capacity of the bucket */
  capacity: number;
  /** Maximum tokens (maxRequests + bufferCapacity) - total capacity */
  maxTokens: number;
  /** Buffer capacity (burst allowance) */
  bufferCapacity: number;
  /** Number of requests waiting in queue */
  queueLength: number;
  /** Number of requests made in the current window (resets at window boundary) */
  requestsInWindow: number;
  /** Provider name extracted from key */
  provider?: string;
  /** Session ID extracted from key */
  sessionId?: string;
}

/**
 * Rate limiter configuration summary
 */
export interface RateLimiterConfigSummary {
  /** Provider identifier */
  provider: string;
  /** Maximum requests allowed in the window */
  maxRequests: number;
  /** Time window in milliseconds */
  windowMs: number;
  /** Buffer capacity (can exceed maxRequests) */
  bufferCapacity: number;
  /** Whether rate limiting is enabled for this provider */
  enabled: boolean;
}

/**
 * Rate limiter metrics for monitoring
 */
export interface RateLimiterMetrics {
  /** Rate limiter configuration */
  config: RateLimiterConfigSummary;
  /** Per-provider bucket states */
  buckets: RateLimiterBucketState[];
  /** Global rate limiter state if applicable */
  global?: RateLimiterBucketState;
  /** Total number of active buckets */
  totalBuckets: number;
  /** Total number of queued requests across all buckets */
  totalQueued: number;
  /** Timestamp when metrics were collected */
  timestamp: string;
  /** Optional status code from the API */
  code?: string;
  /** Number of NVIDIA worker retries (ResourceExhausted with "Worker local total request limit reached") */
  nvidiaWorkerRetryCount?: number;
  /** Count of upstream 429 responses per provider */
  upstream429Counts?: Record<string, number>;
}

/**
 * Provider configuration for client display
 */
export interface Provider {
  /** Provider identifier */
  id: string;
  /** Human-readable provider name */
  name: string;
  /** API format (e.g., 'openai', 'anthropic') */
  apiFormat: string;
  /** Authentication type */
  authType: string;
  /** Whether the provider is enabled */
  enabled: boolean;
  /** Upstream URL (may be redacted for display) */
  upstreamUrl?: string;
  /** Rate limit configuration */
  rateLimit?: {
    maxRequests: number;
    windowMs: number;
    bufferCapacity: number;
  };
  /** Retry configuration */
  retry?: {
    maxRetries: number;
    baseDelayMs: number;
    maxDelayMs: number;
    retryableStatuses: number[];
    jitterFactor: number;
  };
}

/**
 * Retry metrics for a single provider
 */
export interface RetryProviderMetrics {
  /** Provider identifier */
  provider: string;
  /** Maximum retry attempts configured */
  maxRetries: number;
  /** Maximum response buffer size in MB */
  maxResponseBufferSizeMB: number;
  /** Non-streaming retry attempts */
  nonStreamingRetryAttempts: number;
  /** Streaming retry attempts */
  streamingRetryAttempts: number;
  /** Total retry attempts */
  totalRetryAttempts: number;
  /** Active streaming sessions */
  activeStreamingSessions: number;
  /** Current buffer usage in MB */
  currentBufferUsageMB: number;
  /** Maximum buffer usage in MB */
  maxBufferUsageMB: number;
  /** Buffer utilization percentage */
  bufferUtilizationPercent: number;
}

/**
 * Aggregated retry metrics totals
 */
export interface RetryMetricsTotals {
  /** Total non-streaming retry attempts */
  totalNonStreamingRetries: number;
  /** Total streaming retry attempts */
  totalStreamingRetries: number;
  /** Total retry attempts */
  totalRetryAttempts: number;
  /** Total active streaming sessions */
  totalActiveStreamingSessions: number;
  /** Total current buffer usage in MB */
  totalCurrentBufferUsageMB: number;
  /** Total maximum buffer usage in MB */
  totalMaxBufferUsageMB: number;
}

/**
 * Complete retry metrics response
 */
export interface RetryMetrics {
  /** Per-provider retry metrics */
  providers: RetryProviderMetrics[];
  /** Aggregated totals */
  totals: RetryMetricsTotals;
}