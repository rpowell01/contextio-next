/**
 * @contextio/proxy - Retry Plugin
 *
 * Retry plugin for handling 429 and 5xx responses with exponential backoff.
 * Implements actual retry logic by buffering request bodies and headers,
 * and signaling retries through special response codes.
 */
import type { ProxyPlugin, RequestContext, ResponseContext, HeaderMap, JsonValue, Provider, RetryConfig as CoreRetryConfig } from "@contextio/core";
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
    /**
     * Maximum number of entries to keep in the request store.
     * When exceeded, least recently used entries are evicted.
     * @default 10000
     */
    maxEntries?: number;
    /**
     * Interval in milliseconds for periodic cleanup of stale entries.
     * @default 60000 (1 minute)
     */
    cleanupIntervalMs?: number;
    /**
     * Time-to-live in milliseconds for entries in the request store.
     * Entries older than this are removed during cleanup.
     * @default 600000 (10 minutes)
     */
    entryTtlMs?: number;
    /**
     * Maximum buffer size in bytes for streaming response buffering.
     * When exceeded, oldest chunks are discarded to prevent OOM.
     * @default 10485760 (10 MB)
     */
    maxBufferSize?: number;
}
/**
 * Retry plugin class implementing exponential backoff with jitter.
 * Buffers request headers and body to enable actual retries.
 * Supports per-provider configuration overrides.
 */
export declare class RetryPlugin implements ProxyPlugin {
    name: string;
    private readonly globalConfig;
    private readonly providerConfigs;
    private readonly maxEntries;
    private readonly cleanupIntervalMs;
    private readonly entryTtlMs;
    private readonly maxBufferSize;
    private readonly requestStore;
    private readonly streamState;
    private cleanupTimer;
    private nvidiaWorkerRetryCount;
    private upstream429Counts;
    constructor(config?: RetryConfig);
    /**
     * Get the effective retry config for a specific provider.
     * Merges global defaults with provider-specific overrides.
     */
    private getConfigForProvider;
    /**
     * Start the periodic cleanup timer.
     */
    private startCleanupTimer;
    /**
     * Stop the periodic cleanup timer.
     */
    private stopCleanupTimer;
    /**
     * Shutdown the plugin and clean up resources.
     */
    shutdown(): void;
    /**
     * Clean up stale entries and enforce maxEntries limit.
     * Combines TTL expiry and LRU eviction in a single pass.
     * Uses Map insertion order for O(1) LRU tracking (delete + set moves to end).
     */
    private cleanupStaleEntries;
    /**
     * Set an entry in the store, enforcing maxEntries limit only for new keys.
     * Updates LRU position by deleting and re-adding.
     */
    private setEntry;
    /**
     * Get an entry from the store and update its LRU position.
     * Moves the entry to the end of the Map (most recently used).
     */
    private getEntry;
    /**
     * Generate a unique request ID.
     * Uses a timestamp and random number to avoid collisions.
     */
    private generateRequestId;
    /**
     * SSE parsing state for incremental chunk processing.
     */
    private initSseParseState;
    /**
     * Process a single SSE line, updating parse state and detecting errors.
     */
    private processSseLine;
    /**
     * Parse SSE (Server-Sent Events) chunk to detect error events.
     * Works on boundary-agnostic text - does not require \n\n separators.
     * Returns { isError: boolean, status: number | null, message: string | null }
     */
    private parseSseForError;
    /**
     * Check a data field string for error patterns.
     * Handles multi-line data per SSE spec.
     */
    private checkDataForError;
    /**
     * Check if a data field string contains NVIDIA ResourceExhausted error.
     * NVIDIA returns 200 OK with error in response body:
     * { "error": { "code": "ResourceExhausted", "message": "Worker local total request limit reached (32/32)" } }
     * Or wrapped in error envelope:
     * { "name": "UnknownError", "data": { "message": "\"ResourceExhausted: Worker local total request limit reached (32/32)\"" } }
     * Or as plain text followed by JSON (observed in some responses).
     */
    private checkNvidiaResourceExhausted;
    /**
     * Check if a data field string contains rate limit indicators.
     * This handles cases where SSE stream has event: error with rate limit data
     * but no numeric HTTP status code.
     * Returns { isRateLimit: boolean, message: string | null }
     */
    private checkRateLimitInData;
    /**
     * Append "continue" message to the request body's messages array for NVIDIA retry.
     * Returns the modified body as a Buffer, or null if the body structure is not compatible.
     */
    private appendContinueMessage;
    /**
     * Registry for provider-specific streaming retry body modifiers.
     * Key: provider name, Value: function that takes original body and returns modified body.
     */
    private streamRetryModifiers;
    /**
     * Register a custom streaming retry body modifier for a provider.
     * This allows extensible provider-specific retry logic.
     *
     * @param provider - Provider identifier (e.g., "nvidia", "openai", "anthropic")
     * @param modifier - Function that takes original body JSON and returns modified body Buffer
     */
    registerStreamRetryModifier(provider: string, modifier: (originalBodyJson: JsonValue | null) => Buffer | null): void;
    /**
     * Create a retry body based on the detected error type and provider.
     * Dispatches to the appropriate modification strategy:
     * - NVIDIA ResourceExhausted: appends "continue" message
     * - HTTP 429: returns original body (standard backoff)
     * - Provider-specific: uses registered custom modifier
     *
     * @param originalBodyJson - Original request body as JSON
     * @param errorType - Type of error detected: 'nvidia', 'http429', or 'provider-specific'
     * @param provider - Provider identifier
     * @returns Modified body Buffer, or null if no modification needed/applicable
     */
    private createRetryBody;
    /**
     * Get the storage key for a request (captureId or requestId).
     */
    private getStorageKey;
    /**
     * Parse Retry-After header value (seconds or HTTP-date) to milliseconds.
     */
    private parseRetryAfter;
    /**
     * Calculate delay with exponential backoff and jitter.
     */
    private calculateDelay;
    /**
     * Check if a status code is retryable based on configuration.
     */
    private isRetryableStatus;
    onRequest(ctx: RequestContext): Promise<RequestContext>;
    onResponse(ctx: ResponseContext): Promise<ResponseContext>;
    /**
     * Delay execution for specified milliseconds.
     */
    private delay;
    /**
     * Handle streaming response chunk.
     * Detects SSE error events by scanning for data:/event: lines.
     * Works with forward.ts JSON boundary splitting.
     */
    onStreamChunk(chunk: Buffer, sessionId: string | null): Buffer;
    /**
     * Clean up both streamState and requestStore for a session.
     */
    private cleanupAllState;
    /**
     * Handle streaming response end.
     * Detects SSE errors in the final chunk and cleans up state.
     * If no error detected, flushes the buffered response to client.
     * If error detected and retry is possible, signals retry and discards buffer.
     */
    onStreamEnd(sessionId: string | null): Buffer | null;
    /**
     * Get the original request body buffer for testing/inspection.
     * Can look up by captureId or requestId.
     */
    getRequestBodyForTesting(key: string): Buffer | undefined;
    /**
     * Get the original request body JSON for testing/inspection.
     * Can look up by captureId or requestId.
     */
    getRequestBodyJsonForTesting(key: string): JsonValue | null | undefined;
    /**
     * Get the original request headers for testing/inspection.
     * Can look up by captureId or requestId.
     */
    getRequestHeadersForTesting(key: string): HeaderMap | undefined;
    /**
     * Get retry count for testing/inspection.
     * Can look up by captureId or requestId.
     */
    getRetryCountForTesting(key: string): number;
    /**
     * Get the modified request body buffer for streaming retry (if available).
     * Can look up by captureId or requestId.
     */
    getModifiedBodyForRetry(key: string): Buffer | undefined;
    /**
     * Get the total count of NVIDIA worker retries (ResourceExhausted with "Worker local total request limit reached").
     */
    getNvidiaWorkerRetryCount(): number;
    /**
     * Get the count of upstream 429 responses per provider.
     * This tracks how many 429 status codes have been received from each upstream provider.
     * Useful for debugging rate limiting behavior.
     */
    getUpstream429Counts(): Record<string, number>;
    /**
     * Increment the upstream 429 counter for a specific provider.
     * Called from forward.ts after provider reclassification to ensure accurate tracking.
     */
    incrementUpstream429Count(provider: string): void;
    /**
     * Get streaming error state for testing/inspection.
     * Returns the detected error info for a streaming session, if any.
     * Can look up by sessionId.
     */
    getStreamErrorForTesting(sessionId: string): {
        errorDetected: boolean;
        errorStatus: number | null;
        errorMessage: string | null;
        hasErrorEvent: boolean;
    } | undefined;
    /**
     * Get and consume a pending stream retry for a session.
     * Returns the retry info if available, null otherwise.
     * The pending retry is cleared after this call.
     */
    getAndConsumePendingStreamRetry(sessionId: string | null): {
        retryId: string;
        captureId: string | undefined;
        originalBodyBuffer: Buffer;
        originalBodyJson: JsonValue | null;
        delayMs: number;
        modifiedBodyBuffer?: Buffer;
        detectedErrorType: 'nvidia' | 'http429' | 'provider-specific' | null;
    } | null;
    /**
     * Clear all buffered state (for testing).
     */
    clearForTesting(): void;
    /**
     * Get the buffered streaming response for a session (for testing/inspection).
     * Returns the concatenated buffer or null if no buffer exists.
     */
    getStreamBufferForTesting(sessionId: string): Buffer | null;
    /**
     * Get the current buffer size for a streaming session (for testing/inspection).
     */
    getStreamBufferSizeForTesting(sessionId: string): number;
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
export declare function createRetryPlugin(config?: RetryConfig): ProxyPlugin;
//# sourceMappingURL=retry-plugin.d.ts.map