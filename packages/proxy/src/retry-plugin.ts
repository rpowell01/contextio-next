/**
 * @contextio/proxy - Retry Plugin
 *
 * Retry plugin for handling 429 and 5xx responses with exponential backoff.
 * Implements actual retry logic by buffering request bodies and headers,
 * and signaling retries through special response codes.
 */

import type { ProxyPlugin, RequestContext, ResponseContext, HeaderMap, JsonValue } from "@contextio/core";

/**
 * Configuration for the retry plugin.
 */
export interface RetryConfig {
  /**
   * Maximum number of retry attempts.
   * @default 3
   */
  maxRetries?: number;

  /**
   * Base delay in milliseconds for exponential backoff.
   * @default 500
   */
  baseDelayMs?: number;

  /**
   * Maximum delay in milliseconds between retries.
   * @default 30000 (30 seconds)
   */
  maxDelayMs?: number;

  /**
   * HTTP status codes that should trigger a retry.
   * @default [429, 500, 502, 503, 504]
   */
  retryableStatuses?: number[];

  /**
   * Jitter factor to add randomness to delay (0-1).
   * @default 0.1
   */
  jitterFactor?: number;

  /**
   * Whether to enable the retry plugin.
   * @default true
   */
  enabled?: boolean;
}

/**
 * Default configuration values.
 */
const DEFAULT_MAX_RETRIES = 3;
const DEFAULT_BASE_DELAY_MS = 500;
const DEFAULT_MAX_DELAY_MS = 30_000; // 30 seconds
const DEFAULT_RETRYABLE_STATUSES: number[] = [429, 500, 502, 503, 504];
const DEFAULT_JITTER_FACTOR = 0.1;

/**
 * Retry plugin class implementing exponential backoff with jitter.
 * Buffers request headers and body to enable actual retries.
 */
export class RetryPlugin implements ProxyPlugin {
  name = "retry";

  private readonly config: Required<RetryConfig>;
  // Map of requestId to { originalHeaders, originalBodyBuffer, originalBodyJson, timestamp, retryCount }
  private readonly requestStore = new Map<string, {
    originalHeaders: HeaderMap;
    originalBodyBuffer: Buffer;
    originalBodyJson: JsonValue | null;
    timestamp: number;
    retryCount: number;
  }>();
  // Cleanup timer for removing old entries
  private cleanupTimer: NodeJS.Timeout | null = null;

  constructor(config: RetryConfig = {}) {
    const maxRetries = config.maxRetries ?? DEFAULT_MAX_RETRIES;
    const baseDelayMs = config.baseDelayMs ?? DEFAULT_BASE_DELAY_MS;
    const maxDelayMs = config.maxDelayMs ?? DEFAULT_MAX_DELAY_MS;
    const retryableStatuses = config.retryableStatuses ?? DEFAULT_RETRYABLE_STATUSES;
    const jitterFactor = config.jitterFactor ?? DEFAULT_JITTER_FACTOR;

    if (maxRetries < 0) {
      throw new Error("maxRetries must be non-negative");
    }
    if (baseDelayMs <= 0) {
      throw new Error("baseDelayMs must be positive");
    }
    if (maxDelayMs <= 0) {
      throw new Error("maxDelayMs must be positive");
    }
    if (jitterFactor < 0 || jitterFactor > 1) {
      throw new Error("jitterFactor must be between 0 and 1");
    }

    this.config = {
      maxRetries,
      baseDelayMs,
      maxDelayMs,
      retryableStatuses,
      jitterFactor,
      enabled: config.enabled ?? true,
    };

    this.startCleanupTimer();
  }

  /**
   * Start the periodic cleanup timer.
   */
  private startCleanupTimer(): void {
    if (this.cleanupTimer) return;

    this.cleanupTimer = setInterval(() => {
      this.cleanupOldEntries();
    }, 60_000); // Clean up every minute

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
   * Clean up old entries to prevent memory growth.
   * Removes entries older than 10 minutes.
   */
  private cleanupOldEntries(): void {
    const now = Date.now();
    const maxAge = 10 * 60 * 1000; // 10 minutes
    let cleaned = 0;

    for (const [requestId, entry] of this.requestStore) {
      if (now - entry.timestamp > maxAge) {
        this.requestStore.delete(requestId);
        cleaned++;
      }
    }

    if (cleaned > 0) {
      // console.debug(`[retry] Cleaned up ${cleaned} old request(s)`);
    }
  }

  /**
   * Generate a unique request ID.
   * Uses a timestamp and random number to avoid collisions.
   */
  private generateRequestId(): string {
    const timestamp = Date.now();
    const random = Math.floor(Math.random() * 1_000_000)
      .toString()
      .padStart(6, "0");
    return `retry-${timestamp}-${random}`;
  }

  /**
   * Parse Retry-After header value (seconds or HTTP-date) to milliseconds.
   */
  private parseRetryAfter(headerValue: string | undefined): number | null {
    if (!headerValue) return null;

    // Try parsing as seconds first
    const seconds = parseInt(headerValue, 10);
    if (!isNaN(seconds)) {
      return seconds * 1000;
    }

    // Try parsing as HTTP-date
    const date = Date.parse(headerValue);
    if (!isNaN(date)) {
      const delay = date - Date.now();
      return delay > 0 ? delay : 0;
    }

    return null;
  }

  /**
   * Calculate delay with exponential backoff and jitter.
   */
  private calculateDelay(attempt: number): number {
    // Exponential backoff: baseDelay * (2 ^ attempt)
    const baseDelay = this.config.baseDelayMs * Math.pow(2, attempt);
    
    // Apply jitter: ± jitterFactor * baseDelay
    const jitterAmount = baseDelay * this.config.jitterFactor;
    const jitter = Math.random() * 2 * jitterAmount - jitterAmount;
    
    let delay = baseDelay + jitter;
    
    // Ensure delay is within bounds
    delay = Math.max(0, delay);
    delay = Math.min(delay, this.config.maxDelayMs);
    
    return Math.floor(delay);
  }

  /**
   * Check if a status code is retryable based on configuration.
   */
  private isRetryableStatus(status: number): boolean {
    return this.config.retryableStatuses.includes(status);
  }

  async onRequest(ctx: RequestContext): Promise<RequestContext> {
    // Request phase - buffer request data and add retry ID header
    
    // Skip if plugin is disabled
    if (!this.config.enabled) {
      return ctx;
    }

    // Check if this request already has a retry ID (indicating it's a retry attempt)
    const retryIdHeader = ctx.headers["x-retry-id"];
    let requestId: string;
    let isRetry = false;

    if (retryIdHeader && typeof retryIdHeader === 'string') {
      requestId = retryIdHeader;
      isRetry = true;
    } else if (Array.isArray(retryIdHeader) && retryIdHeader.length > 0) {
      requestId = retryIdHeader[0];
      isRetry = true;
    } else {
      // Generate a new request ID for this request
      requestId = this.generateRequestId();
      isRetry = false;
    }

    // If this is the first attempt, store the original request data
    if (!isRetry) {
      // Store original headers (we'll need to retry with these)
      const originalHeaders: HeaderMap = { ...ctx.headers };
      // Store original body data
      this.requestStore.set(requestId, {
        originalHeaders,
        originalBodyBuffer: ctx.rawBody,
        originalBodyJson: ctx.body,
        timestamp: Date.now(),
        retryCount: 0,
      });
    }
    // If it's a retry, we already have the data stored from the first attempt

    // Add the retry ID to headers so we can track it through the flow
    // We need to create a new headers object since HeaderMap might be read-only
    const newHeaders: HeaderMap = { ...ctx.headers };
    newHeaders["x-retry-id"] = requestId;

    // Return modified context with the retry ID header
    return {
      ...ctx,
      headers: newHeaders,
    };
  }

  async onResponse(ctx: ResponseContext): Promise<ResponseContext> {
    // Response phase - handle retries for non-streaming responses
    
    // Skip if plugin is disabled
    if (!this.config.enabled) {
      return ctx;
    }

    // Extract request ID from headers
    const retryIdHeader = ctx.headers["x-retry-id"];
    let requestId: string | null = null;

    if (retryIdHeader && typeof retryIdHeader === 'string') {
      requestId = retryIdHeader;
    } else if (Array.isArray(retryIdHeader) && retryIdHeader.length > 0) {
      requestId = retryIdHeader[0];
    }

    // If we can't track this request, pass through without modification
    if (!requestId) {
      return ctx;
    }

    // Get the stored request data
    const entry = this.requestStore.get(requestId);
    if (!entry) {
      // No data found - this shouldn't happen if we stored it in onRequest
      // But if it does, just pass through
      return ctx;
    }

    // Check if status code indicates success (less than 400)
    if (ctx.status < 400) {
      // Successful response - clean up and return
      this.requestStore.delete(requestId);
      return ctx;
    }

    // Check if status code is retryable
    if (!this.isRetryableStatus(ctx.status)) {
      // Not retryable - clean up and return response
      this.requestStore.delete(requestId);
      return ctx;
    }

    // Get current retry count
    const retryCount = entry.retryCount;
    
    // Check if we've exceeded max retries
    if (retryCount >= this.config.maxRetries) {
      // Max retries exceeded - clean up and return response
      this.requestStore.delete(requestId);
      return ctx;
    }

    // Calculate delay based on retry count and status code
    let delayMs = this.calculateDelay(retryCount);
    
    // For 429 status, check for Retry-After header
    if (ctx.status === 429) {
      const retryAfterHeader = ctx.headers["retry-after"];
      const retryAfterValue = typeof retryAfterHeader === 'string' 
        ? retryAfterHeader 
        : Array.isArray(retryAfterHeader) ? retryAfterHeader[0] : undefined;
      
      const retryAfterMs = this.parseRetryAfter(retryAfterValue);
      
      // Use Retry-After value if present and valid, otherwise use calculated backoff
      if (retryAfterMs !== null) {
        delayMs = retryAfterMs;
      }
      // Else, keep the calculated delayMs from exponential backoff
    }

    // Increment retry count for next attempt
    entry.retryCount = retryCount + 1;
    // Update timestamp to keep the entry fresh
    entry.timestamp = Date.now();

    // Apply delay before signaling retry
    if (delayMs > 0) {
      await this.delay(delayMs);
    }
    
    // Return a special response to signal that a retry should be performed
    // Status 599 is our internal retry signal (not a real HTTP status)
    // We include the request ID in the headers so we can match it in forward.ts
    const responseHeaders: HeaderMap = {
      ...ctx.headers,
      "x-retry-id": requestId, // Echo back the request ID for matching
    };
    
    return {
      status: 599, // Special retry signal
      headers: responseHeaders,
      body: "", // Empty body for the signal
      isStreaming: false,
      sessionId: ctx.sessionId
    };
  }

  /**
   * Delay execution for specified milliseconds.
   */
  private async delay(ms: number): Promise<void> {
    if (ms <= 0) return;
    return new Promise(resolve => setTimeout(resolve, ms));
  }

  onStreamChunk(chunk: Buffer, sessionId: string | null): Buffer {
    // For streaming responses, we pass through chunks unchanged
    // Implementing retry logic for streaming is complex and would require
    // buffering the entire stream, which may not be appropriate for all use cases.
    // For now, we maintain the existing behavior of not interfering with streams.
    return chunk;
  }

  onStreamEnd(sessionId: string | null): Buffer | null {
    // Stream end - no special processing needed for retry logic
    return null;
  }

  /**
   * Get the original request body buffer for testing/inspection.
   */
  getRequestBodyForTesting(requestId: string): Buffer | undefined {
    const entry = this.requestStore.get(requestId);
    return entry?.originalBodyBuffer;
  }

  /**
   * Get the original request body JSON for testing/inspection.
   */
  getRequestBodyJsonForTesting(requestId: string): JsonValue | null | undefined {
    const entry = this.requestStore.get(requestId);
    return entry?.originalBodyJson;
  }

  /**
   * Get the original request headers for testing/inspection.
   */
  getRequestHeadersForTesting(requestId: string): HeaderMap | undefined {
    const entry = this.requestStore.get(requestId);
    return entry?.originalHeaders;
  }

  /**
   * Get retry count for testing/inspection.
   */
  getRetryCountForTesting(requestId: string): number {
    const entry = this.requestStore.get(requestId);
    return entry?.retryCount ?? 0;
  }

  /**
   * Clear all buffered state (for testing).
   */
  clearForTesting(): void {
    this.requestStore.clear();
  }
}

/**
 * Create a retry plugin with exponential backoff and jitter.
 *
 * @param config - Retry configuration
 * @returns ProxyPlugin implementing retry logic
 *
 * @example
 * ```typescript
 * import { createRetryPlugin } from "@contextio/proxy";
 *
 * const retryPlugin = createRetryPlugin({
 *   maxRetries: 3,
 *   baseDelayMs: 500,
 *   maxDelayMs: 30000,
 *   retryableStatuses: [429, 500, 502, 503, 504],
 *   jitterFactor: 0.1,
 * });
 * ```
 */
export function createRetryPlugin(config: RetryConfig = {}): ProxyPlugin {
  const plugin = new RetryPlugin(config);
  const proxy: ProxyPlugin = {
    name: plugin.name,
    onRequest: (ctx: RequestContext) => plugin.onRequest(ctx),
    onResponse: (ctx: ResponseContext) => plugin.onResponse(ctx),
    onStreamChunk: (chunk: Buffer, sessionId: string | null) => 
      plugin.onStreamChunk(chunk, sessionId),
    onStreamEnd: (sessionId: string | null) => 
      plugin.onStreamEnd(sessionId),
  };
  
  // Attach internal methods for testing/graceful access to state
  // @ts-ignore
  (proxy as any)._internal = {
    getRequestBody: (requestId: string) => plugin.getRequestBodyForTesting(requestId),
    getRequestBodyJson: (requestId: string) => plugin.getRequestBodyJsonForTesting(requestId),
    getRequestHeaders: (requestId: string) => plugin.getRequestHeadersForTesting(requestId),
    getRetryCount: (requestId: string) => plugin.getRetryCountForTesting(requestId),
    clear: () => plugin.clearForTesting(),
  };
  
  return proxy;
}