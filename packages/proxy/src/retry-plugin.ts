/**
 * @contextio/proxy - Retry Plugin
 *
 * Retry plugin for handling 429 and 5xx responses with exponential backoff.
 * Implements actual retry logic by buffering request bodies and headers,
 * and signaling retries through special response codes.
 */

import type { ProxyPlugin, RequestContext, ResponseContext, HeaderMap, JsonValue, JsonObject, Provider, RetryConfig as CoreRetryConfig } from "@contextio/core";

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
 * Default configuration values.
 */
const DEFAULT_MAX_RETRIES = 3;
const DEFAULT_BASE_DELAY_MS = 500;
const DEFAULT_MAX_DELAY_MS = 30_000; // 30 seconds
const DEFAULT_RETRYABLE_STATUSES: number[] = [429, 500, 502, 503, 504];
const DEFAULT_JITTER_FACTOR = 0.1;
const DEFAULT_MAX_ENTRIES = 10_000;
const DEFAULT_CLEANUP_INTERVAL_MS = 60_000; // 1 minute
const DEFAULT_ENTRY_TTL_MS = 600_000; // 10 minutes
const DEFAULT_MAX_BUFFER_SIZE = 10 * 1024 * 1024; // 10 MB
const DEFAULT_MAX_STREAM_RETRIES = 3;

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
    maxStreamRetries: providerConfig.maxStreamRetries ?? globalConfig.maxStreamRetries,
    maxResponseBufferSize: providerConfig.maxResponseBufferSize ?? globalConfig.maxResponseBufferSize,
    enabled: providerConfig.enabled ?? globalConfig.enabled,
  };
}

/**
 * Internal request store entry type.
 */
interface RequestStoreEntry {
  originalHeaders: HeaderMap;
  originalBodyBuffer: Buffer;
  originalBodyJson: JsonValue | null;
  retryCount: number;
  captureId: string | undefined;
  requestId: string;
  provider: Provider | string;
  lastAccessed?: number;
}

/**
 * Internal type for tracking streaming response state across chunks.
 * Includes SSE parsing state, error detection, and pending retry information.
 */
interface StreamState {
  errorDetected: boolean;
  errorStatus: number | null;
  errorMessage: string | null;
  captureId: string | undefined;
  requestId: string;
  provider: Provider | string;
  timestamp: number;
  // Buffer for partial SSE field content split across chunks
  partialField: "data" | "event" | "id" | "retry" | null;
  partialContent: string;
  // SSE parsing state for multi-line data fields across chunk boundaries
  inDataField: boolean;
  dataBuffer: string;
  hasErrorEvent: boolean;
  // Full response buffer for streaming retry - accumulates all SSE chunks
  fullResponseBuffer: Buffer;
  maxBufferSize: number;
  bufferOverflow: boolean;
  // Original request body for retry
  originalRequestBody: Buffer | null;
  // Pending retry signal for streaming responses
  pendingRetry?: {
    retryId: string;
    captureId: string | undefined;
    originalBodyBuffer: Buffer;
    originalBodyJson: JsonValue | null;
    delayMs: number;
    modifiedBodyBuffer?: Buffer;
    detectedErrorType: 'nvidia' | 'http429' | 'provider-specific' | null;
  };
  // Streaming-specific retry count (separate from non-streaming retry count)
  streamRetryCount: number;
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
  private readonly maxEntries: number;
  private readonly cleanupIntervalMs: number;
  private readonly entryTtlMs: number;
  private readonly maxBufferSize: number;

  // Map of captureId (or requestId fallback) to RequestStoreEntry
  private readonly requestStore = new Map<string, RequestStoreEntry>();

  // Streaming state per session: tracks errors and retry info for streaming responses
  private readonly streamState = new Map<string, StreamState>();

  // Cleanup timer for removing old entries
  private cleanupTimer: NodeJS.Timeout | null = null;

  // Counter for NVIDIA worker retries (ResourceExhausted with "Worker local total request limit reached")
  private nvidiaWorkerRetryCount = 0;

  // Counter for upstream 429 responses per provider
  private upstream429Counts = new Map<string, number>();

  constructor(config: RetryConfig = {}) {
    const { providers, enabled, maxEntries, cleanupIntervalMs, entryTtlMs, maxBufferSize, ...globalConfig } = config;

    const maxRetries = globalConfig.maxRetries ?? DEFAULT_MAX_RETRIES;
    const baseDelayMs = globalConfig.baseDelayMs ?? DEFAULT_BASE_DELAY_MS;
    const maxDelayMs = globalConfig.maxDelayMs ?? DEFAULT_MAX_DELAY_MS;
    const retryableStatuses = globalConfig.retryableStatuses ?? DEFAULT_RETRYABLE_STATUSES;
    const jitterFactor = globalConfig.jitterFactor ?? DEFAULT_JITTER_FACTOR;
    const maxStreamRetries = globalConfig.maxStreamRetries ?? DEFAULT_MAX_STREAM_RETRIES;

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
    if (maxEntries !== undefined && maxEntries <= 0) {
      throw new Error("maxEntries must be positive");
    }
    if (cleanupIntervalMs !== undefined && cleanupIntervalMs <= 0) {
      throw new Error("cleanupIntervalMs must be positive");
    }
    if (entryTtlMs !== undefined && entryTtlMs <= 0) {
      throw new Error("entryTtlMs must be positive");
    }
    if (maxBufferSize !== undefined && maxBufferSize <= 0) {
      throw new Error("maxBufferSize must be positive");
    }
    if (maxStreamRetries < 0 || maxStreamRetries > 10) {
      throw new Error("maxStreamRetries must be between 0 and 10");
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
        if (providerConfig.maxStreamRetries !== undefined && (providerConfig.maxStreamRetries < 0 || providerConfig.maxStreamRetries > 10)) {
          throw new Error(`maxStreamRetries for provider "${providerKey}" must be between 0 and 10`);
        }
        if (providerConfig.maxResponseBufferSize !== undefined && (providerConfig.maxResponseBufferSize <= 0 || providerConfig.maxResponseBufferSize > 100 * 1024 * 1024)) {
          throw new Error(`maxResponseBufferSize for provider "${providerKey}" must be positive and <= 100 MB`);
        }
      }
    }

    // Check RATE_LIMITER_ENABLED env var since retry plugin is closely related to rate limiting
    const rateLimiterEnabled = process.env.RATE_LIMITER_ENABLED !== "false";
    
    this.globalConfig = {
      maxRetries,
      baseDelayMs,
      maxDelayMs,
      retryableStatuses,
      jitterFactor,
      maxStreamRetries,
      maxResponseBufferSize: maxBufferSize ?? DEFAULT_MAX_BUFFER_SIZE,
      enabled: enabled ?? rateLimiterEnabled ?? true,
    };
    this.providerConfigs = providers;
    this.maxEntries = maxEntries ?? DEFAULT_MAX_ENTRIES;
    this.cleanupIntervalMs = cleanupIntervalMs ?? DEFAULT_CLEANUP_INTERVAL_MS;
    this.entryTtlMs = entryTtlMs ?? DEFAULT_ENTRY_TTL_MS;
    this.maxBufferSize = maxBufferSize ?? DEFAULT_MAX_BUFFER_SIZE;

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
      this.cleanupStaleEntries();
    }, this.cleanupIntervalMs);

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
   * Shutdown the plugin and clean up resources.
   */
  shutdown(): void {
    this.stopCleanupTimer();
    this.requestStore.clear();
  }

  /**
   * Clean up stale entries and enforce maxEntries limit.
   * Combines TTL expiry and LRU eviction in a single pass.
   * Uses Map insertion order for O(1) LRU tracking (delete + set moves to end).
   */
  private cleanupStaleEntries(): void {
    const now = Date.now();
    let cleaned = 0;

    // First pass: remove entries older than TTL
    for (const [key, entry] of this.requestStore) {
      const lastAccessed = entry.lastAccessed ?? 0;
      if (now - lastAccessed > this.entryTtlMs) {
        this.requestStore.delete(key);
        cleaned++;
      }
    }

    // Second pass: enforce maxEntries using Map insertion order (LRU)
    // Entries at the beginning of the Map are the least recently used
    if (this.requestStore.size > this.maxEntries) {
      const toRemove = this.requestStore.size - this.maxEntries;
      const keysToRemove: string[] = [];
      
      for (const key of this.requestStore.keys()) {
        if (keysToRemove.length >= toRemove) break;
        keysToRemove.push(key);
      }
      
      for (const key of keysToRemove) {
        this.requestStore.delete(key);
        cleaned++;
      }
    }

    // Also clean up old stream state
    for (const [sessionId, state] of this.streamState) {
      if (now - state.timestamp > this.entryTtlMs) {
        this.streamState.delete(sessionId);
        cleaned++;
      }
    }

    if (cleaned > 0) {
      // console.debug(`[retry] Cleaned up ${cleaned} stale request(s)`);
    }
  }

  /**
   * Set an entry in the store, enforcing maxEntries limit only for new keys.
   * Updates LRU position by deleting and re-adding.
   */
  private setEntry(key: string, entry: RequestStoreEntry): void {
    const isNewKey = !this.requestStore.has(key);
    
    if (isNewKey) {
      // Only enforce maxEntries when adding a new key
      // The periodic cleanup handles eviction for existing keys
      if (this.requestStore.size >= this.maxEntries) {
        // Evict LRU entry (first in Map) to make room
        const firstKey = this.requestStore.keys().next().value;
        if (firstKey !== undefined) {
          this.requestStore.delete(firstKey);
        }
      }
    }
    
    entry.lastAccessed = Date.now();
    // Delete and re-add to move to end (most recently used)
    this.requestStore.delete(key);
    this.requestStore.set(key, entry);
  }

  /**
   * Get an entry from the store and update its LRU position.
   * Moves the entry to the end of the Map (most recently used).
   */
  private getEntry(key: string): RequestStoreEntry | undefined {
    const entry = this.requestStore.get(key);
    if (entry) {
      entry.lastAccessed = Date.now();
      // Move to end for LRU (delete + re-add)
      this.requestStore.delete(key);
      this.requestStore.set(key, entry);
    }
    return entry;
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
   * SSE parsing state for incremental chunk processing.
   */
  private initSseParseState() {
    return {
      inDataField: false,
      dataBuffer: "",
      hasErrorEvent: false,
      errorDetected: false,
      errorStatus: null as number | null,
      errorMessage: null as string | null,
    };
  }

  /**
   * Process a single SSE line, updating parse state and detecting errors.
   */
  private processSseLine(trimmed: string, state: { inDataField: boolean; dataBuffer: string; hasErrorEvent: boolean; errorDetected: boolean; errorStatus: number | null; errorMessage: string | null }): void {
    if (trimmed.startsWith("event:")) {
      // End any pending data field
      if (state.inDataField && state.dataBuffer.length > 0) {
        const result = this.checkDataForError(state.dataBuffer);
        if (result.isError) {
          state.errorDetected = true;
          state.errorStatus = result.status;
          state.errorMessage = result.message;
        }
        state.dataBuffer = "";
      }
      state.inDataField = false;

      const eventType = trimmed.slice(6).trim();
      if (eventType === "error") {
        state.hasErrorEvent = true;
      }
      return;
    }

    if (trimmed.startsWith("data:")) {
      state.inDataField = true;
      const dataContent = trimmed.slice(5).trim();
      if (state.dataBuffer.length > 0) state.dataBuffer += "\n";
      state.dataBuffer += dataContent;
      return;
    }

    // Empty line - end of data field (per SSE spec, only empty lines terminate events)
    if (state.inDataField && state.dataBuffer.length > 0 && trimmed === "") {
      const result = this.checkDataForError(state.dataBuffer);
      if (result.isError) {
        state.errorDetected = true;
        state.errorStatus = result.status;
        state.errorMessage = result.message;
      }
      // Also check for NVIDIA ResourceExhausted in the data buffer (envelope format)
      // This handles: { "name": "UnknownError", "data": { "message": "..." } }
      const nvidiaCheck = this.checkNvidiaResourceExhausted(state.dataBuffer);
      if (nvidiaCheck.isError) {
        state.errorDetected = true;
        state.errorStatus = 429; // NVIDIA ResourceExhausted is a rate limit error
        state.errorMessage = nvidiaCheck.message;
      }
      state.dataBuffer = "";
      state.inDataField = false;
    }
    // Other SSE fields (id:, retry:, etc.) don't terminate the data field
  }

  /**
   * Parse SSE (Server-Sent Events) chunk to detect error events.
   * Works on boundary-agnostic text - does not require \n\n separators.
   * Returns { isError: boolean, status: number | null, message: string | null }
   */
  private parseSseForError(chunk: Buffer): { isError: boolean; status: number | null; message: string | null } {
    const text = chunk.toString("utf8");
    // Normalize line endings (handles CRLF and standalone CR)
    const normalizedText = text.replace(/\r\n|\r/g, "\n");
    const lines = normalizedText.split("\n");
    const state = this.initSseParseState();

    for (const line of lines) {
      this.processSseLine(line.trim(), state);
    }

    // Check any remaining buffered data
    if (state.inDataField && state.dataBuffer.length > 0) {
      const result = this.checkDataForError(state.dataBuffer);
      if (result.isError) {
        return { isError: true, status: result.status, message: result.message };
      }
    }

    // If we had an explicit error event but no error in data, return generic error
    if (state.hasErrorEvent) {
      return { isError: true, status: null, message: "SSE error event detected" };
    }

    return { isError: state.errorDetected, status: state.errorStatus, message: state.errorMessage };
  }

  /**
   * Check a data field string for error patterns.
   * Handles multi-line data per SSE spec.
   */
  private checkDataForError(dataStr: string): { isError: boolean; status: number | null; message: string | null } {
    if (!dataStr || dataStr === "[DONE]") return { isError: false, status: null, message: null };
    
    try {
      const parsed = JSON.parse(dataStr);
      
      // Check for explicit error event in data (Anthropic style: { type: "error", error: {...} })
      if (parsed.type === "error" && parsed.error) {
        const err = parsed.error;
        const status = err.status ?? err.code ?? parsed.status ?? parsed.code ?? null;
        const message = err.message ?? JSON.stringify(err);
        return { isError: true, status: typeof status === 'number' ? status : null, message };
      }
      
      // Check for error object (OpenAI style: { error: {...} })
      if (parsed.error) {
        const err = parsed.error;
        const status = err.status ?? err.code ?? parsed.status ?? parsed.code ?? null;
        const message = err.message ?? (parsed.type === "error" ? err.type : JSON.stringify(err));
        return { isError: true, status: typeof status === 'number' ? status : null, message };
      }
      
      // Check for top-level status/code (generic error format)
      const topStatus = parsed.status ?? parsed.code ?? null;
      if (topStatus !== null && typeof topStatus === 'number' && topStatus >= 400) {
        const message = parsed.message ?? parsed.error?.message ?? JSON.stringify(parsed);
        return { isError: true, status: topStatus, message };
      }
    } catch {
      // Not valid JSON, not an error we can parse
    }
    
    return { isError: false, status: null, message: null };
  }

  /**
   * Check if a data field string contains NVIDIA ResourceExhausted error.
   * NVIDIA returns 200 OK with error in response body:
   * { "error": { "code": "ResourceExhausted", "message": "Worker local total request limit reached (32/32)" } }
   * Or wrapped in error envelope:
   * { "name": "UnknownError", "data": { "message": "\"ResourceExhausted: Worker local total request limit reached (32/32)\"" } }
   * Or as plain text followed by JSON (observed in some responses).
   */
  private checkNvidiaResourceExhausted(responseBody: string): { isError: boolean; message: string | null } {
    if (!responseBody) return { isError: false, message: null };

    // First, check raw body for the error pattern (handles plain text + JSON mixed responses)
    const rawLower = responseBody.toLowerCase();
    if (rawLower.includes("resourceexhausted") && rawLower.includes("worker local total request limit reached")) {
      // Extract the relevant error message for logging
      const match = responseBody.match(/ResourceExhausted[:\s].*worker local total request limit reached\s*\(\d+\/\d+\)/i);
      const message = match?.[0] ?? "ResourceExhausted: Worker local total request limit reached";
      return { isError: true, message };
    }

    try {
      const parsed = JSON.parse(responseBody);

      // Check for NVIDIA error format: { error: { code: "ResourceExhausted", message: "..." } }
      if (parsed.error && parsed.error.code === "ResourceExhausted") {
        const message = parsed.error.message ?? "ResourceExhausted";
        if (message.includes("Worker local total request limit reached")) {
          return { isError: true, message };
        }
      }

      // Also check for alternative format: { code: "ResourceExhausted", message: "..." }
      if (parsed.code === "ResourceExhausted" && parsed.message?.includes("Worker local total request limit reached")) {
        return { isError: true, message: parsed.message };
      }

      // Check for error envelope format: { name: "UnknownError", data: { message: "..." } }
      if (parsed.name === "UnknownError" && parsed.data && parsed.data.message) {
        const message = parsed.data.message;
        // Message may contain escaped quotes: "\"ResourceExhausted: Worker local total request limit reached (32/32)\""
        if (message.includes("ResourceExhausted") && message.includes("Worker local total request limit reached")) {
          return { isError: true, message };
        }
      }

    } catch {
      // Not valid JSON, but we already checked raw body above
    }

    return { isError: false, message: null };
  }

  /**
   * Append "continue" message to the request body's messages array for NVIDIA retry.
   * Returns the modified body as a Buffer, or null if the body structure is not compatible.
   */
  private appendContinueMessage(originalBodyJson: JsonValue | null): Buffer | null {
    if (!originalBodyJson || typeof originalBodyJson !== 'object' || Array.isArray(originalBodyJson)) {
      return null;
    }
    
    const body = originalBodyJson as JsonObject;
    
    // Check if body has messages array (OpenAI chat completions format)
    if (!body.messages || !Array.isArray(body.messages)) {
      return null;
    }
    
    // Create a deep copy of the body and append "continue" message
    const modifiedBody: JsonObject = { ...body };
    modifiedBody.messages = [...body.messages, { role: "user", content: "continue" }];
    
    try {
      return Buffer.from(JSON.stringify(modifiedBody), "utf8");
    } catch {
      return null;
    }
  }

  /**
   * Registry for provider-specific streaming retry body modifiers.
   * Key: provider name, Value: function that takes original body and returns modified body.
   */
  private streamRetryModifiers = new Map<string, (originalBodyJson: JsonValue | null) => Buffer | null>();

  /**
   * Register a custom streaming retry body modifier for a provider.
   * This allows extensible provider-specific retry logic.
   * 
   * @param provider - Provider identifier (e.g., "nvidia", "openai", "anthropic")
   * @param modifier - Function that takes original body JSON and returns modified body Buffer
   */
  registerStreamRetryModifier(provider: string, modifier: (originalBodyJson: JsonValue | null) => Buffer | null): void {
    this.streamRetryModifiers.set(provider.toLowerCase(), modifier);
  }

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
  private createRetryBody(
    originalBodyJson: JsonValue | null,
    errorType: 'nvidia' | 'http429' | 'provider-specific',
    provider: string,
    originalBodyBuffer?: Buffer
  ): Buffer | null {
    switch (errorType) {
      case 'nvidia':
        return this.appendContinueMessage(originalBodyJson);
      
      case 'http429':
        // For HTTP 429, retry with original body (no modification) - reuse buffer to avoid re-serialization
        return originalBodyBuffer ?? (originalBodyJson ? Buffer.from(JSON.stringify(originalBodyJson), "utf8") : null);
      
      case 'provider-specific': {
        // Check for registered custom modifier
        const modifier = this.streamRetryModifiers.get(provider.toLowerCase());
        if (modifier) {
          return modifier(originalBodyJson);
        }
        // No custom modifier registered - fall back to original body
        return originalBodyBuffer ?? (originalBodyJson ? Buffer.from(JSON.stringify(originalBodyJson), "utf8") : null);
      }
    }
  }

  /**
   * Get the storage key for a request (captureId or requestId).
   */
  private getStorageKey(captureId: string | undefined, requestId: string): string {
    return captureId ?? requestId;
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
      this.setEntry(storageKey, {
        originalHeaders,
        originalBodyBuffer: ctx.rawBody,
        originalBodyJson: ctx.body,
        retryCount: 0,
        captureId,
        requestId,
        provider: ctx.provider,
      });

      // Also initialize streaming state if we have a sessionId (for streaming responses)
      // The sessionId is used to track streaming state across chunks
      if (ctx.sessionId) {
        const providerConfig = this.getConfigForProvider(ctx.provider);
        const maxBufferSize = providerConfig.maxResponseBufferSize ?? this.maxBufferSize;
        this.streamState.set(ctx.sessionId, {
          errorDetected: false,
          errorStatus: null,
          errorMessage: null,
          captureId,
          requestId,
          provider: ctx.provider,
          timestamp: Date.now(),
          partialField: null,
          partialContent: "",
          inDataField: false,
          dataBuffer: "",
          hasErrorEvent: false,
          fullResponseBuffer: Buffer.alloc(0),
          maxBufferSize,
          bufferOverflow: false,
          originalRequestBody: ctx.rawBody,
          streamRetryCount: 0,
        });
      }
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
    const entry = this.getEntry(storageKey);
    if (!entry) {
      // No data found - this shouldn't happen if we stored it in onRequest
      // But if it does, just pass through
      return ctx;
    }

    // Get provider-specific configuration
    const config = this.getConfigForProvider(entry.provider);

// Skip if plugin is disabled for this provider
    if (!config.enabled) {
      // Clean up request store entry since we won't retry
      this.requestStore.delete(storageKey);
      // Also clean up streamState for non-streaming responses (streaming handled in onStreamEnd)
      if (!ctx.isStreaming && ctx.sessionId) {
        this.streamState.delete(ctx.sessionId);
      }
      return ctx;
    }

    // Check for NVIDIA ResourceExhausted error in response body (returns 200 with error in body)
    // Check for ALL providers since any provider might use NVIDIA NIM under the hood
    let nvidiaErrorDetected = false;
    let nvidiaErrorMessage: string | null = null;

    if (ctx.status < 400 && !ctx.isStreaming && ctx.body) {
      const nvidiaError = this.checkNvidiaResourceExhausted(ctx.body);
      if (nvidiaError.isError) {
        nvidiaErrorDetected = true;
        nvidiaErrorMessage = nvidiaError.message;
        console.debug(`[retry] NVIDIA ResourceExhausted detected for provider ${entry.provider}: ${nvidiaErrorMessage}`);
      }
    }

    if (!nvidiaErrorDetected && ctx.status < 400 && !ctx.isStreaming) {
      // Successful non-streaming response - clean up request store and stream state
      this.requestStore.delete(storageKey);
      if (ctx.sessionId) {
        this.streamState.delete(ctx.sessionId);
      }
      return ctx;
    }
    // If NVIDIA error detected, fall through to retry logic below

    // Check if status code is retryable OR if it's a NVIDIA ResourceExhausted error
    // nvidiaErrorDetected is set in the block above when we detect the error in 200 responses
    const isNvidiaErrorRetry = nvidiaErrorDetected;
    if (!this.isRetryableStatus(ctx.status, config) && !isNvidiaErrorRetry) {
      // Not retryable - clean up request store
      // Only clean up for non-streaming responses (streaming handled in onStreamEnd)
      if (!ctx.isStreaming) {
        this.requestStore.delete(storageKey);
        if (ctx.sessionId) {
          this.streamState.delete(ctx.sessionId);
        }
      }
      return ctx;
    }

    // Track upstream 429 responses for metrics
    // Do this BEFORE checking max retries so we track all 429s
    if (ctx.status === 429) {
      this.incrementUpstream429Count(entry.provider);
    }

    // Get current retry count
    const retryCount = entry.retryCount;
    
    // Check if we've exceeded max retries
    if (retryCount >= config.maxRetries) {
      // Max retries exceeded - clean up request store
      // Only clean up for non-streaming responses (streaming handled in onStreamEnd)
      if (!ctx.isStreaming) {
        this.requestStore.delete(storageKey);
        if (ctx.sessionId) {
          this.streamState.delete(ctx.sessionId);
        }
      }
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

    // Update entry with incremented retry count
    this.setEntry(storageKey, {
      ...entry,
      retryCount: retryCount + 1,
    });

    // For NVIDIA ResourceExhausted errors, create modified body with "continue" message
    let modifiedBodyBuffer: Buffer | null = null;
    if (isNvidiaErrorRetry) {
      modifiedBodyBuffer = this.appendContinueMessage(entry.originalBodyJson);
      if (modifiedBodyBuffer) {
        // Store modified body for retry
        this.setEntry(storageKey, {
          ...entry,
          retryCount: retryCount + 1,
          // @ts-ignore - adding modified body for NVIDIA retry
          modifiedBodyForRetry: modifiedBodyBuffer,
        });
        // Increment NVIDIA worker retry counter
        this.nvidiaWorkerRetryCount++;
        console.debug(`[retry] NVIDIA ResourceExhausted: created modified request body with "continue" message (total retries: ${this.nvidiaWorkerRetryCount})`);
      }
    }

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
    
    // For NVIDIA ResourceExhausted errors, indicate modified body is available
    if (isNvidiaErrorRetry) {
      responseHeaders["x-retry-modified-body"] = "true";
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

  /**
   * Handle streaming response chunk.
   * Detects SSE error events by scanning for data:/event: lines.
   * Works with forward.ts JSON boundary splitting.
   */
  onStreamChunk(chunk: Buffer, sessionId: string | null): Buffer {
    // If no sessionId, we can't track streaming state - pass through
    if (!sessionId) {
      return chunk;
    }

    let streamState = this.streamState.get(sessionId);
    if (!streamState) {
      // No stream state available for this session; pass through
      // (streamState is initialized in onRequest for all requests with sessionId)
      return chunk;
    }

    // Buffer the chunk for potential retry
    // Only buffer if we haven't detected an error yet (no point buffering after error)
    if (!streamState.errorDetected) {
      // Check if adding this chunk would exceed max buffer size
      const newSize = streamState.fullResponseBuffer.length + chunk.length;
      
      if (newSize > streamState.maxBufferSize) {
        // Buffer overflow - mark it and don't add this chunk
        streamState.bufferOverflow = true;
        console.debug(`[retry] Stream buffer overflow detected (max: ${streamState.maxBufferSize}, would be: ${newSize}). Buffering disabled.`);
      } else {
        // Append chunk to buffer
        streamState.fullResponseBuffer = Buffer.concat([streamState.fullResponseBuffer, chunk]);
      }
    }

    // Combine any partial field content from previous chunk with new chunk
    // If there's a partial field, prepend its prefix (data: , event: , etc.)
    const prefix = streamState.partialField ? streamState.partialField + ": " : "";
    const text = prefix + streamState.partialContent + chunk.toString("utf8");
    
    // Refresh timestamp to prevent premature cleanup by cleanupOldEntries
    streamState.timestamp = Date.now();
    
    // Also refresh requestStore entry timestamp for long-running streams
    const storageKey = this.getStorageKey(streamState.captureId, streamState.requestId);
    const requestEntry = this.requestStore.get(storageKey);
    if (requestEntry) {
      requestEntry.lastAccessed = Date.now();
    }
    
    // Normalize line endings (handles CRLF and standalone CR)
    const normalizedText = text.replace(/\r\n|\r/g, "\n");
    
    // Split into lines and process SSE format
    const lines = normalizedText.split("\n");
    
    // The last element might be incomplete - save it for next chunk
    // We need to check if the last line is a field prefix (data:, event:, etc.)
    // If so, we save the field type and content separately
    const lastLine = lines.pop() || "";
    const lastLineTrimmed = lastLine.trim();
    
    // Check if the last line looks like an SSE field start
    let partialField: "data" | "event" | "id" | "retry" | null = null;
    let partialContent = "";
    if (lastLineTrimmed.startsWith("data: ")) {
      partialField = "data";
      partialContent = lastLineTrimmed.slice(6).trim();
    } else if (lastLineTrimmed.startsWith("data:")) {
      partialField = "data";
      partialContent = lastLineTrimmed.slice(5).trim();
    } else if (lastLineTrimmed.startsWith("event: ")) {
      partialField = "event";
      partialContent = lastLineTrimmed.slice(7).trim();
    } else if (lastLineTrimmed.startsWith("event:")) {
      partialField = "event";
      partialContent = lastLineTrimmed.slice(6).trim();
    } else if (lastLineTrimmed.startsWith("id: ")) {
      partialField = "id";
      partialContent = lastLineTrimmed.slice(4).trim();
    } else if (lastLineTrimmed.startsWith("id:")) {
      partialField = "id";
      partialContent = lastLineTrimmed.slice(3).trim();
    } else if (lastLineTrimmed.startsWith("retry: ")) {
      partialField = "retry";
      partialContent = lastLineTrimmed.slice(7).trim();
    } else if (lastLineTrimmed.startsWith("retry:")) {
      partialField = "retry";
      partialContent = lastLineTrimmed.slice(6).trim();
    } else if (lastLine.length > 0) {
      // Non-empty line that doesn't match field patterns - could be continuation
      // If we were in a data field, continue it
      if (streamState.inDataField) {
        partialField = "data";
        // Only add newline separator if dataBuffer is non-empty
        partialContent = streamState.dataBuffer 
          ? streamState.dataBuffer + "\n" + lastLine.trim()
          : lastLine.trim();
        streamState.inDataField = false;
        streamState.dataBuffer = "";
      } else {
        // Unknown partial - just store as generic content
        partialField = "data";
        partialContent = lastLine;
      }
    }
    
    streamState.partialField = partialField;
    streamState.partialContent = partialContent;
    
    // Use streamState's persistent SSE parsing state for multi-line data fields across chunks
    // (inDataField and dataBuffer are always initialized in onRequest)
    const sseState = {
      inDataField: streamState.inDataField,
      dataBuffer: streamState.dataBuffer,
      hasErrorEvent: false,
      errorDetected: false,
      errorStatus: null as number | null,
      errorMessage: null as string | null,
    };
    
    // Process each complete line for SSE event/error detection
    for (const line of lines) {
      const trimmed = line.trim();
      this.processSseLine(trimmed, sseState);
    }
    
    // Persist SSE parsing state back to streamState for next chunk
    streamState.inDataField = sseState.inDataField;
    streamState.dataBuffer = sseState.dataBuffer;
    streamState.hasErrorEvent = streamState.hasErrorEvent || sseState.hasErrorEvent;
    
    // Merge SSE parse results into streamState, preserving existing specific errors
    if (sseState.errorDetected || sseState.hasErrorEvent) {
      // Only update if we don't already have a more specific error
      if (!streamState.errorDetected) {
        streamState.errorDetected = true;
        if (sseState.errorDetected) {
          streamState.errorStatus = sseState.errorStatus;
          streamState.errorMessage = sseState.errorMessage;
        } else if (sseState.hasErrorEvent) {
          // Generic SSE error event without specific error data
          streamState.errorStatus = null;
          streamState.errorMessage = "SSE error event detected";
        }
      } else if (sseState.errorDetected && streamState.errorStatus === null) {
        // Upgrade from generic to specific error if we have one
        streamState.errorStatus = sseState.errorStatus;
        streamState.errorMessage = sseState.errorMessage;
      }
    }

    // Also check for NVIDIA ResourceExhausted in the accumulated data buffer (envelope format)
    // This handles: { "name": "UnknownError", "data": { "message": "..." } }
    // which may not be caught by standard SSE error parsing
    if (streamState.dataBuffer && streamState.dataBuffer.length > 0) {
      const nvidiaCheck = this.checkNvidiaResourceExhausted(streamState.dataBuffer);
      if (nvidiaCheck.isError) {
        const shouldUpdate = !streamState.errorDetected ||
          (streamState.errorStatus === null);
        if (shouldUpdate) {
          streamState.errorDetected = true;
          streamState.errorStatus = 429; // NVIDIA ResourceExhausted is a rate limit error
          streamState.errorMessage = nvidiaCheck.message;
        }
      }
    }

    // Pass through the chunk to the client
    return chunk;
  }

  /**
   * Clean up both streamState and requestStore for a session.
   */
  private cleanupAllState(streamState: StreamState, sessionId: string): void {
    this.streamState.delete(sessionId);
    const storageKey = this.getStorageKey(streamState.captureId, streamState.requestId);
    this.requestStore.delete(storageKey);
  }

  /**
   * Handle streaming response end.
   * Detects SSE errors in the final chunk and cleans up state.
   * If no error detected, flushes the buffered response to client.
   * If error detected and retry is possible, signals retry and discards buffer.
   */
  onStreamEnd(sessionId: string | null): Buffer | null {
    if (!sessionId) {
      return null;
    }

    const streamState = this.streamState.get(sessionId);
    if (!streamState) {
      // No stream state to clean up
      return null;
    }

    // Flush any partial field content from the final chunk
    if (streamState.partialField && streamState.partialContent.length > 0) {
      // Reconstruct the final line and check for errors
      let finalLine = "";
      if (streamState.partialField === "data") {
        finalLine = "data: " + streamState.partialContent;
      } else if (streamState.partialField === "event") {
        finalLine = "event: " + streamState.partialContent;
      } else if (streamState.partialField === "id") {
        finalLine = "id: " + streamState.partialContent;
      } else if (streamState.partialField === "retry") {
        finalLine = "retry: " + streamState.partialContent;
      }

      if (finalLine) {
        const errorInfo = this.parseSseForError(Buffer.from(finalLine, "utf8"));
        if (errorInfo.isError) {
          // Only update if we don't have a more specific error (non-null status)
          // or if no error was previously detected
          const shouldUpdate = !streamState.errorDetected ||
            (errorInfo.status !== null && streamState.errorStatus === null);
          if (shouldUpdate) {
            streamState.errorDetected = true;
            streamState.errorStatus = errorInfo.status;
            streamState.errorMessage = errorInfo.message;
          }
        }
        // Also check for NVIDIA ResourceExhausted in the partial content (envelope format)
        const nvidiaCheck = this.checkNvidiaResourceExhausted(streamState.partialContent);
        if (nvidiaCheck.isError) {
          const shouldUpdate = !streamState.errorDetected ||
            (streamState.errorStatus === null);
          if (shouldUpdate) {
            streamState.errorDetected = true;
            streamState.errorStatus = 429; // NVIDIA ResourceExhausted is a rate limit error
            streamState.errorMessage = nvidiaCheck.message;
          }
        }
      }
      // Clear the partial content
      streamState.partialField = null;
      streamState.partialContent = "";
    }

    // Also flush any pending data buffer from persistent SSE parsing state
    if (streamState.inDataField && streamState.dataBuffer.length > 0) {
      const errorInfo = this.checkDataForError(streamState.dataBuffer);
      if (errorInfo.isError) {
        // Only update if we don't have a more specific error (non-null status)
        // or if no error was previously detected
        const shouldUpdate = !streamState.errorDetected ||
          (errorInfo.status !== null && streamState.errorStatus === null);
        if (shouldUpdate) {
          streamState.errorDetected = true;
          streamState.errorStatus = errorInfo.status;
          streamState.errorMessage = errorInfo.message;
        }
      }
      // Also check for NVIDIA ResourceExhausted in the data buffer (envelope format)
      // This handles: { "name": "UnknownError", "data": { "message": "..." } }
      const nvidiaCheck = this.checkNvidiaResourceExhausted(streamState.dataBuffer);
      if (nvidiaCheck.isError) {
        // Only update if we don't have a more specific error (non-null status)
        // or if no error was previously detected
        const shouldUpdate = !streamState.errorDetected ||
          (streamState.errorStatus === null);
        if (shouldUpdate) {
          streamState.errorDetected = true;
          streamState.errorStatus = 429; // NVIDIA ResourceExhausted is a rate limit error
          streamState.errorMessage = nvidiaCheck.message;
        }
      }
      streamState.dataBuffer = "";
      streamState.inDataField = false;
    }

    // Also check for hasErrorEvent that was set during onStreamChunk
    if (streamState.hasErrorEvent && !streamState.errorDetected) {
      streamState.errorDetected = true;
      streamState.errorStatus = null;
      streamState.errorMessage = "SSE error event detected";
    }

    // For observability, log the detected error state
    if (streamState.errorDetected) {
      console.debug(`[retry] Streaming error detected for session ${sessionId}:`, {
        status: streamState.errorStatus,
        message: streamState.errorMessage,
        hasErrorEvent: streamState.hasErrorEvent,
      });
    }

    // If an error was detected, check if we should retry
    if (streamState.errorDetected) {
      const storageKey = this.getStorageKey(streamState.captureId, streamState.requestId);
      const entry = this.requestStore.get(storageKey);
      if (entry) {
        const config = this.getConfigForProvider(entry.provider);

        // Track upstream 429 responses for metrics (streaming)
        if (streamState.errorStatus === 429) {
          this.incrementUpstream429Count(entry.provider);
        }

        // Determine error type for provider-aware retry logic
        let errorType: 'nvidia' | 'http429' | 'provider-specific' | null = null;
        
        // Check for NVIDIA ResourceExhausted error FIRST (regardless of errorStatus)
        // NVIDIA errors in streaming always set errorStatus = 429, so we must check errorMessage
        let isNvidiaError = false;
        if (streamState.errorMessage) {
          const nvidiaCheck = this.checkNvidiaResourceExhausted(streamState.errorMessage);
          if (nvidiaCheck.isError) {
            isNvidiaError = true;
            errorType = 'nvidia';
          }
        }
        
        // Check for HTTP 429 status (only if not NVIDIA)
        if (!isNvidiaError && streamState.errorStatus === 429) {
          errorType = 'http429';
        }
        
        // For other retryable errors, use provider-specific
        if (!errorType && streamState.errorStatus && config.retryableStatuses.includes(streamState.errorStatus)) {
          errorType = 'provider-specific';
        }

        // Use maxStreamRetries for streaming-specific retry limit
        const maxStreamRetries = config.maxStreamRetries ?? config.maxRetries;
        if (errorType && streamState.streamRetryCount < maxStreamRetries) {
          // Increment NVIDIA worker retry counter if this is a NVIDIA error (only when actually retrying)
          if (isNvidiaError) {
            this.nvidiaWorkerRetryCount++;
            console.debug(`[retry] NVIDIA ResourceExhausted detected in streaming for provider ${entry.provider}: ${streamState.errorMessage} (total retries: ${this.nvidiaWorkerRetryCount})`);
          }
          
          // Calculate delay for this retry
          let delayMs = this.calculateDelay(streamState.streamRetryCount, config);
          
          // For 429 status, check for Retry-After header (not available in streaming, but keep for consistency)
          if (streamState.errorStatus === 429) {
            // In streaming, we don't have Retry-After headers from the SSE stream itself
            // Use calculated backoff
          }
          
          // Create modified body based on error type and provider
          const modifiedBodyBuffer = errorType 
            ? this.createRetryBody(entry.originalBodyJson, errorType, entry.provider, entry.originalBodyBuffer)
            : null;
          
          // Increment streaming retry count in stream state
          streamState.streamRetryCount++;
          
          // Also increment the non-streaming retry count in request store for compatibility
          this.setEntry(storageKey, {
            ...entry,
            retryCount: entry.retryCount + 1,
            // @ts-ignore - adding modified body for streaming retry
            modifiedBodyForRetry: modifiedBodyBuffer,
          });
          
          // Store pending retry info for forward.ts to consume
          streamState.pendingRetry = {
            retryId: entry.requestId,
            captureId: entry.captureId,
            originalBodyBuffer: entry.originalBodyBuffer,
            originalBodyJson: entry.originalBodyJson,
            delayMs,
            modifiedBodyBuffer: modifiedBodyBuffer ?? undefined,
            detectedErrorType: errorType,
          };
          
          // Don't clean up state yet - forward.ts will consume the pending retry
          // and we clean up after the retry is handled
          // Discard the buffered response since we're retrying
          streamState.fullResponseBuffer = Buffer.alloc(0);
          return null;
        }
      }
    }

    // No retry needed - stream completed successfully
    // forward.ts already buffers the stream in streamBufferChunks and sends it to the client
    // We just clean up our internal buffer
    streamState.fullResponseBuffer = Buffer.alloc(0);

    // Clean up stream state and request store
    this.cleanupAllState(streamState, sessionId);
    
    // Return null - forward.ts handles sending the buffered response
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
   * Get the modified request body buffer for streaming retry (if available).
   * Can look up by captureId or requestId.
   */
  getModifiedBodyForRetry(key: string): Buffer | undefined {
    const entry = this.requestStore.get(key);
    // @ts-ignore - custom property for streaming retry
    return entry?.modifiedBodyForRetry;
  }

  /**
   * Get the total count of NVIDIA worker retries (ResourceExhausted with "Worker local total request limit reached").
   */
  getNvidiaWorkerRetryCount(): number {
    return this.nvidiaWorkerRetryCount;
  }

  /**
   * Get the count of upstream 429 responses per provider.
   * This tracks how many 429 status codes have been received from each upstream provider.
   * Useful for debugging rate limiting behavior.
   */
  getUpstream429Counts(): Record<string, number> {
    const counts: Record<string, number> = {};
    for (const [provider, count] of this.upstream429Counts.entries()) {
      counts[provider] = count;
    }
    return counts;
  }

  /**
   * Increment the upstream 429 counter for a specific provider.
   * Called from forward.ts after provider reclassification to ensure accurate tracking.
   */
  incrementUpstream429Count(provider: string): void {
    const currentCount = this.upstream429Counts.get(provider) || 0;
    this.upstream429Counts.set(provider, currentCount + 1);
  }

  /**
   * Get streaming error state for testing/inspection.
   * Returns the detected error info for a streaming session, if any.
   * Can look up by sessionId.
   */
  getStreamErrorForTesting(sessionId: string): { errorDetected: boolean; errorStatus: number | null; errorMessage: string | null; hasErrorEvent: boolean } | undefined {
    const entry = this.streamState.get(sessionId);
    if (!entry) return undefined;
    return {
      errorDetected: entry.errorDetected,
      errorStatus: entry.errorStatus,
      errorMessage: entry.errorMessage,
      hasErrorEvent: entry.hasErrorEvent,
    };
  }

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
  } | null {
    if (!sessionId) return null;
    
    const streamState = this.streamState.get(sessionId);
    if (!streamState || !streamState.pendingRetry) {
      return null;
    }
    
    const pendingRetry = streamState.pendingRetry;
    // Clear the pending retry
    streamState.pendingRetry = undefined;
    
    // Reset stream state error fields for the retry response
    // (Don't delete streamState - retries bypass onRequest, so we need it to persist)
    streamState.errorDetected = false;
    streamState.errorStatus = null;
    streamState.errorMessage = null;
    streamState.hasErrorEvent = false;
    streamState.partialField = null;
    streamState.partialContent = "";
    streamState.inDataField = false;
    streamState.dataBuffer = "";
    // Reset bufferOverflow flag for the retry attempt
    streamState.bufferOverflow = false;
    // Reset fullResponseBuffer for the retry attempt
    streamState.fullResponseBuffer = Buffer.alloc(0);
    
    // Refresh requestStore entry timestamp to prevent premature eviction during retry delay
    const storageKey = this.getStorageKey(streamState.captureId, streamState.requestId);
    const entry = this.requestStore.get(storageKey);
    if (entry) {
      entry.lastAccessed = Date.now();
    }
    
    // Note: requestStore is NOT cleared here - it's kept for the retry attempt
    
    return {
      retryId: pendingRetry.retryId,
      captureId: pendingRetry.captureId,
      originalBodyBuffer: pendingRetry.originalBodyBuffer,
      originalBodyJson: pendingRetry.originalBodyJson,
      delayMs: pendingRetry.delayMs,
      modifiedBodyBuffer: pendingRetry.modifiedBodyBuffer,
      detectedErrorType: pendingRetry.detectedErrorType ?? null,
    };
  }

  /**
   * Clear all buffered state (for testing).
   */
  clearForTesting(): void {
    this.requestStore.clear();
    this.streamState.clear();
    if (this.cleanupTimer) {
      clearInterval(this.cleanupTimer);
      this.cleanupTimer = null;
    }
  }

  /**
   * Get the buffered streaming response for a session (for testing/inspection).
   * Returns the concatenated buffer or null if no buffer exists.
   */
  getStreamBufferForTesting(sessionId: string): Buffer | null {
    const streamState = this.streamState.get(sessionId);
    if (!streamState || streamState.fullResponseBuffer.length === 0) {
      return null;
    }
    return streamState.fullResponseBuffer;
  }

  /**
   * Get the current buffer size for a streaming session (for testing/inspection).
   */
  getStreamBufferSizeForTesting(sessionId: string): number {
    const streamState = this.streamState.get(sessionId);
    return streamState?.fullResponseBuffer.length ?? 0;
  }
}

/**
 * Error detection result from provider-specific checkers.
 */
interface ErrorDetectionResult {
  isError: boolean;
  status: number | null;
  message: string | null;
  provider?: string;
  retryable?: boolean;
}

/**
 * Interface for provider-specific error detection.
 * Implement this to add support for new provider error formats.
 */
interface ProviderErrorDetector {
  /**
   * Unique identifier for this detector (e.g., "nvidia", "openai", "anthropic").
   */
  name: string;

  /**
   * Check if the response body/data contains a rate limit error.
   * @param data - The raw response data (string or Buffer)
   * @returns ErrorDetectionResult if error detected, null otherwise
   */
  detect(data: string | Buffer): ErrorDetectionResult | null;

  /**
   * Optional: Create a modified request body for retry.
   * For NVIDIA ResourceExhausted, this appends "continue" to messages.
   * @param originalBodyJson - The original request body as JSON
   * @returns Modified body buffer, or null if not applicable
   */
  createRetryBody?: (originalBodyJson: JsonValue | null) => Buffer | null;
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
    getModifiedBodyForRetry: (key: string) => plugin.getModifiedBodyForRetry(key),
    getNvidiaWorkerRetryCount: () => plugin.getNvidiaWorkerRetryCount(),
    getUpstream429Counts: () => plugin.getUpstream429Counts(),
    incrementUpstream429Count: (provider: string) => plugin.incrementUpstream429Count(provider),
    getStreamError: (sessionId: string) => plugin.getStreamErrorForTesting(sessionId),
    getAndConsumePendingStreamRetry: (sessionId: string | null) => plugin.getAndConsumePendingStreamRetry(sessionId),
    getStreamBuffer: (sessionId: string) => plugin.getStreamBufferForTesting(sessionId),
    getStreamBufferSize: (sessionId: string) => plugin.getStreamBufferSizeForTesting(sessionId),
    clear: () => plugin.clearForTesting(),
    shutdown: () => plugin.shutdown(),
  };

  return proxy;
}