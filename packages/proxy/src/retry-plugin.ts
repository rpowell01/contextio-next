/**
 * @contextio/proxy - Retry Plugin
 *
 * Retry plugin for handling 429 and 5xx responses with exponential backoff.
 * Implements actual retry logic by buffering request bodies and headers,
 * and signaling retries through special response codes.
 */

import type { ProxyPlugin, RequestContext, ResponseContext, HeaderMap, JsonValue, Provider, RetryConfig as CoreRetryConfig } from "@contextio/core";

/**
 * Internal retry config with enabled flag.
 * The core RetryConfig doesn't include 'enabled', but the plugin does.
 */
interface RetryConfigInternal extends CoreRetryConfig {
  enabled: boolean;
}

/**
 * Configuration for the retry plugin.
 * Supports global defaults with optional per-provider overrides.
 */
export interface RetryConfig extends Partial<CoreRetryConfig> {
  /**
   * Per-provider retry configuration overrides.
   * Provider-specific config is merged with global defaults at runtime.
   */
  providers?: Partial<Record<Provider, Partial<CoreRetryConfig>>>;

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
 * Merge global config with provider-specific overrides.
 * Returns a complete RetryConfigInternal for the given provider.
 */
function resolveConfigForProvider(
  globalConfig: RetryConfigInternal,
  providerConfigs: Partial<Record<Provider, Partial<CoreRetryConfig>>> | undefined,
  provider: string
): RetryConfigInternal {
  if (!providerConfigs) {
    return globalConfig;
  }
  // Type-safe lookup: only match known Provider values
  const providerKey = provider as Provider;
  // Use hasOwnProperty to avoid prototype pollution and ensure valid Provider enum value
  if (!Object.prototype.hasOwnProperty.call(providerConfigs, providerKey)) {
    return globalConfig;
  }
  const providerConfig = providerConfigs[providerKey];
  if (!providerConfig) {
    return globalConfig;
  }
  return {
    maxRetries: providerConfig.maxRetries ?? globalConfig.maxRetries,
    baseDelayMs: providerConfig.baseDelayMs ?? globalConfig.baseDelayMs,
    maxDelayMs: providerConfig.maxDelayMs ?? globalConfig.maxDelayMs,
    retryableStatuses: providerConfig.retryableStatuses ?? globalConfig.retryableStatuses,
    jitterFactor: providerConfig.jitterFactor ?? globalConfig.jitterFactor,
    // Provider config doesn't include 'enabled', fall back to global
    enabled: globalConfig.enabled,
  };
}

/**
 * Retry plugin class implementing exponential backoff with jitter.
 * Buffers request headers and body to enable actual retries.
 * Supports per-provider configuration overrides.
 */
export class RetryPlugin implements ProxyPlugin {
  name = "retry";

  private readonly globalConfig: RetryConfigInternal;
  private readonly providerConfigs: Partial<Record<Provider, Partial<CoreRetryConfig>>> | undefined;
  // Map of captureId (or requestId fallback) to { originalHeaders, originalBodyBuffer, originalBodyJson, timestamp, retryCount, captureId, requestId, provider }
  private readonly requestStore = new Map<string, {
    originalHeaders: HeaderMap;
    originalBodyBuffer: Buffer;
    originalBodyJson: JsonValue | null;
    timestamp: number;
    retryCount: number;
    captureId: string | undefined;
    requestId: string;
    provider: Provider | string;
  }>();
  // Cleanup timer for removing old entries
  private cleanupTimer: NodeJS.Timeout | null = null;

  constructor(config: RetryConfig = {}) {
    const { providers, enabled, ...globalConfig } = config;

    const maxRetries = globalConfig.maxRetries ?? DEFAULT_MAX_RETRIES;
    const baseDelayMs = globalConfig.baseDelayMs ?? DEFAULT_BASE_DELAY_MS;
    const maxDelayMs = globalConfig.maxDelayMs ?? DEFAULT_MAX_DELAY_MS;
    const retryableStatuses = globalConfig.retryableStatuses ?? DEFAULT_RETRYABLE_STATUSES;
    const jitterFactor = globalConfig.jitterFactor ?? DEFAULT_JITTER_FACTOR;

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

    // Validate provider-specific configs
    if (providers) {
      for (const [providerKey, providerConfig] of Object.entries(providers)) {
        if (!providerConfig) continue;
        if (providerConfig.maxRetries !== undefined && providerConfig.maxRetries < 0) {
          throw new Error(`maxRetries for provider "${providerKey}" must be non-negative`);
        }
        if (providerConfig.baseDelayMs !== undefined && providerConfig.baseDelayMs <= 0) {
          throw new Error(`baseDelayMs for provider "${providerKey}" must be positive`);
        }
        if (providerConfig.maxDelayMs !== undefined && providerConfig.maxDelayMs <= 0) {
          throw new Error(`maxDelayMs for provider "${providerKey}" must be positive`);
        }
        if (providerConfig.jitterFactor !== undefined && 
            (providerConfig.jitterFactor < 0 || providerConfig.jitterFactor > 1)) {
          throw new Error(`jitterFactor for provider "${providerKey}" must be between 0 and 1`);
        }
      }
    }

    this.globalConfig = {
      maxRetries,
      baseDelayMs,
      maxDelayMs,
      retryableStatuses,
      jitterFactor,
      enabled: enabled ?? true,
    };
    this.providerConfigs = providers;

    this.startCleanupTimer();
  }

  /**
   * Get the effective retry config for a specific provider.
   * Merges global defaults with provider-specific overrides.
   */
  private getConfigForProvider(provider: string): RetryConfigInternal {
    return resolveConfigForProvider(this.globalConfig, this.providerConfigs, provider);
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

    for (const [key, entry] of this.requestStore) {
      if (now - entry.timestamp > maxAge) {
        this.requestStore.delete(key);
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
  private calculateDelay(attempt: number, config: Required<CoreRetryConfig>): number {
    // Exponential backoff: baseDelay * (2 ^ attempt)
    const baseDelay = config.baseDelayMs * Math.pow(2, attempt);
    
    // Apply jitter: ± jitterFactor * baseDelay
    const jitterAmount = baseDelay * config.jitterFactor;
    const jitter = Math.random() * 2 * jitterAmount - jitterAmount;
    
    let delay = baseDelay + jitter;
    
    // Ensure delay is within bounds
    delay = Math.max(0, delay);
    delay = Math.min(delay, config.maxDelayMs);
    
    return Math.floor(delay);
  }

  /**
   * Check if a status code is retryable based on configuration.
   */
  private isRetryableStatus(status: number, config: Required<CoreRetryConfig>): boolean {
    return config.retryableStatuses.includes(status);
  }

  async onRequest(ctx: RequestContext): Promise<RequestContext> {
    // Request phase - buffer request data and add retry ID header
    
    // Skip if plugin is disabled globally
    if (!this.globalConfig.enabled) {
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

    // Use captureId as the primary tracking key if available
    const captureId = ctx.captureId;
    const storageKey = captureId ?? requestId;

    // If this is the first attempt, store the original request data
    if (!isRetry) {
      // Store original headers (we'll need to retry with these)
      const originalHeaders: HeaderMap = { ...ctx.headers };
      // Store original body data along with provider info
      this.requestStore.set(storageKey, {
        originalHeaders,
        originalBodyBuffer: ctx.rawBody,
        originalBodyJson: ctx.body,
        timestamp: Date.now(),
        retryCount: 0,
        captureId,
        requestId,
        provider: ctx.provider,
      });
    }
    // Note: Retry requests bypass the plugin pipeline (forward.ts calls doForward directly),
    // so onRequest is never invoked for retries. The entry is already stored under captureId
    // from the first attempt, and onResponse finds it via the x-contextio-capture-id header.

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
    
    // Extract captureId from headers (primary tracking key)
    const captureIdHeader = ctx.headers["x-contextio-capture-id"];
    let captureId: string | null = null;

    if (captureIdHeader && typeof captureIdHeader === 'string') {
      captureId = captureIdHeader;
    } else if (Array.isArray(captureIdHeader) && captureIdHeader.length > 0) {
      captureId = captureIdHeader[0];
    }

    // Also extract requestId as fallback
    const retryIdHeader = ctx.headers["x-retry-id"];
    let requestId: string | null = null;

    if (retryIdHeader && typeof retryIdHeader === 'string') {
      requestId = retryIdHeader;
    } else if (Array.isArray(retryIdHeader) && retryIdHeader.length > 0) {
      requestId = retryIdHeader[0];
    }

    // Use captureId as primary key, fallback to requestId
    const storageKey = captureId ?? requestId;

    // If we can't track this request, pass through without modification
    if (!storageKey) {
      return ctx;
    }

    // Get the stored request data
    const entry = this.requestStore.get(storageKey);
    if (!entry) {
      // No data found - this shouldn't happen if we stored it in onRequest
      // But if it does, just pass through
      return ctx;
    }

    // Get provider-specific configuration
    const config = this.getConfigForProvider(entry.provider);

    // Skip if plugin is disabled for this provider
    if (!config.enabled) {
      return ctx;
    }

    // Check if status code indicates success (less than 400)
    if (ctx.status < 400) {
      // Successful response - clean up and return
      this.requestStore.delete(storageKey);
      return ctx;
    }

    // Check if status code is retryable
    if (!this.isRetryableStatus(ctx.status, config)) {
      // Not retryable - clean up and return response
      this.requestStore.delete(storageKey);
      return ctx;
    }

    // Get current retry count
    const retryCount = entry.retryCount;
    
    // Check if we've exceeded max retries
    if (retryCount >= config.maxRetries) {
      // Max retries exceeded - clean up and return response
      this.requestStore.delete(storageKey);
      return ctx;
    }

    // Calculate delay based on retry count and status code
    let delayMs = this.calculateDelay(retryCount, config);
    
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
      "x-retry-id": entry.requestId, // Echo back the original request ID for matching
    };
    
    // Also propagate captureId if we have it
    if (entry.captureId) {
      responseHeaders["x-contextio-capture-id"] = entry.captureId;
    }

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
   * Can look up by captureId or requestId.
   */
  getRequestBodyForTesting(key: string): Buffer | undefined {
    const entry = this.requestStore.get(key);
    return entry?.originalBodyBuffer;
  }

  /**
   * Get the original request body JSON for testing/inspection.
   * Can look up by captureId or requestId.
   */
  getRequestBodyJsonForTesting(key: string): JsonValue | null | undefined {
    const entry = this.requestStore.get(key);
    return entry?.originalBodyJson;
  }

  /**
   * Get the original request headers for testing/inspection.
   * Can look up by captureId or requestId.
   */
  getRequestHeadersForTesting(key: string): HeaderMap | undefined {
    const entry = this.requestStore.get(key);
    return entry?.originalHeaders;
  }

  /**
   * Get retry count for testing/inspection.
   * Can look up by captureId or requestId.
   */
  getRetryCountForTesting(key: string): number {
    const entry = this.requestStore.get(key);
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
    getRequestBody: (key: string) => plugin.getRequestBodyForTesting(key),
    getRequestBodyJson: (key: string) => plugin.getRequestBodyJsonForTesting(key),
    getRequestHeaders: (key: string) => plugin.getRequestHeadersForTesting(key),
    getRetryCount: (key: string) => plugin.getRetryCountForTesting(key),
    clear: () => plugin.clearForTesting(),
  };
  
  return proxy;
}