/**
 * Core types for the contextio proxy ecosystem.
 *
 * These are the public types that plugins and consumers depend on.
 * Zero external dependencies.
 */
/**
 * LLM API provider identifier.
 *
 * "chatgpt" is separate from "openai" because ChatGPT's backend API
 * (used by Codex subscriptions) has a different format from the
 * OpenAI platform API.
 */
export type Provider = "anthropic" | "openai" | "chatgpt" | "gemini" | "geminiCodeAssist" | "vertex" | "nvidia" | "openrouter" | "kilo" | "unknown";
/**
 * Wire format of the API request.
 *
 * Used to determine how to parse request/response bodies for token
 * usage, streaming events, and content extraction.
 */
export type ApiFormat = "anthropic-messages" | "chatgpt-backend" | "responses" | "chat-completions" | "gemini" | "raw" | "unknown";
/** All known ApiFormat values for runtime validation. */
export declare const KNOWN_API_FORMATS: readonly ["anthropic-messages", "chatgpt-backend", "responses", "chat-completions", "gemini", "raw", "unknown"];
/** All known AuthType values for runtime validation. */
export declare const KNOWN_AUTH_TYPES: readonly ["bearer", "api-key", "none"];
/** All known Provider values for runtime validation. */
export declare const KNOWN_PROVIDERS: readonly ["anthropic", "openai", "chatgpt", "gemini", "geminiCodeAssist", "vertex", "nvidia", "openrouter", "kilo", "unknown"];
export type JsonPrimitive = string | number | boolean | null;
export type JsonValue = JsonPrimitive | JsonObject | JsonValue[];
export type JsonObject = {
    [key: string]: JsonValue;
};
export type HeaderMap = Record<string, string | string[] | undefined>;
/**
 * Base URLs for each provider's API.
 *
 * The proxy prepends these to the request path when forwarding.
 * Configurable via environment variables or the ProxyConfig.
 */
export interface Upstreams {
    openai: string;
    anthropic: string;
    chatgpt: string;
    gemini: string;
    geminiCodeAssist: string;
    vertex: string;
    nvidia: string;
    openrouter: string;
    kilo: string;
}
/**
 * A complete request/response pair captured by the proxy.
 *
 * Written to disk as JSON by the logger plugin. Contains everything
 * needed to inspect, replay, or analyze an API call.
 */
export interface CaptureData {
    /** ISO-8601 timestamp when the request was received. */
    timestamp: string;
    /** Session ID from the URL path, or null if not tagged. */
    sessionId: string | null;
    /** HTTP method (always "POST" for LLM API calls). */
    method: string;
    /** Cleaned URL path (source tag stripped). */
    path: string;
    /** Source tool name extracted from the URL path (e.g. "claude", "gemini"). */
    source: string | null;
    /** Detected LLM provider. */
    provider: string;
    /** Detected API wire format. */
    apiFormat: string;
    /** The upstream URL the request was forwarded to. */
    targetUrl: string;
    /** Request headers with sensitive values (auth, API keys) stripped. */
    requestHeaders: Record<string, string>;
    /** Parsed JSON request body, or null if non-JSON. May contain redacted placeholders. */
    requestBody: JsonValue | null;
    /**
     * Original unmodified request body before plugin redaction.
     * Store with care: this field contains unredacted sensitive data and must
     * not be sent over untrusted channels or written to access-controlled logs.
     */
    originalRequestBody: JsonValue | null;
    /** Size of the raw request body in bytes. */
    requestBytes: number;
    /** HTTP status code from the upstream. */
    responseStatus: number;
    /** Response headers with sensitive values stripped. */
    responseHeaders: Record<string, string>;
    /** Raw response body (SSE text for streaming, JSON string for non-streaming). */
    responseBody: string;
    /** Whether the upstream returned a streaming (SSE) response. */
    responseIsStreaming: boolean;
    /** Size of the raw response body in bytes. */
    responseBytes: number;
    /** Unique capture filename assigned before plugin pipeline. Links redact-meta to capture. */
    captureId?: string;
    /** Redaction counts from the actual plugin actions that transformed the request. */
    redactionStats?: {
        totalRedactions: number;
        byRule: Record<string, number>;
    };
    /** Timing breakdown for the request lifecycle. */
    timings: {
        /** Time from receiving the request to finishing the upstream send. */
        send_ms: number;
        /** Time from send complete to first response byte (TTFB). */
        wait_ms: number;
        /** Time from first byte to last byte of the response. */
        receive_ms: number;
        /** Total wall-clock time. */
        total_ms: number;
    };
}
/**
 * Context passed to onRequest hooks.
 *
 * Plugins can modify `headers` and `body` to transform the request
 * before it is forwarded to the upstream provider.
 */
export interface RequestContext {
    provider: Provider | string;
    apiFormat: ApiFormat | string;
    path: string;
    source: string | null;
    sessionId: string | null;
    headers: HeaderMap;
    body: JsonValue | null;
    rawBody: Buffer;
    captureId?: string;
    /** Upstream URL the request was forwarded to — optional so that existing
     *  producers are not required to populate it. */
    targetUrl?: string;
    redactionStats?: {
        totalRedactions: number;
        byRule: Record<string, number>;
    };
}
/** Context passed to onResponse hooks. */
export interface ResponseContext {
    status: number;
    headers: HeaderMap;
    body: string;
    isStreaming: boolean;
    sessionId: string | null;
}
/**
 * A proxy plugin.
 *
 * Plugins run in array order. Request hooks form a pipeline: each
 * receives the output of the previous one. Capture hooks are
 * fire-and-forget; errors are logged but do not affect the client.
 */
export interface ProxyPlugin {
    name: string;
    /**
     * Transform the request before forwarding to the upstream provider.
     * Return the (possibly modified) context. Runs in pipeline order.
     */
    onRequest?: (ctx: RequestContext) => RequestContext | Promise<RequestContext>;
    /**
     * Transform the response before sending back to the client.
     * Only called for non-streaming responses.
     */
    onResponse?: (ctx: ResponseContext) => ResponseContext | Promise<ResponseContext>;
    /**
     * Transform a streaming (SSE) response chunk before sending to the client.
     * Called for each data chunk. Return the (possibly modified) chunk.
     * Plugins that need to handle split tokens should buffer internally.
     */
    onStreamChunk?: (chunk: Buffer, sessionId: string | null) => Buffer;
    /**
     * Called when a streaming response ends. Plugins can flush any
     * buffered data. Return null if nothing to flush.
     */
    onStreamEnd?: (sessionId: string | null) => Buffer | null;
    /**
     * Observe the completed request/response capture.
     * Fire-and-forget. Errors are logged but do not block the response.
     */
    onCapture?: (capture: CaptureData) => void | Promise<void>;
}
/**
 * Configuration for encrypting capture log files at rest.
 *
 * Actual encryption is implemented by the logger plugin; this interface
 * defines the shape of the config passed from the proxy.
 */
export interface EncryptionAtRestConfig {
    /** Whether encryption at rest is enabled. Defaults to false. */
    enabled: boolean;
    /** Key provider strategy. Defaults to 'env'. */
    keyProvider: "static" | "env" | "kms";
    /**
     * Raw encryption key bytes, used only when keyProvider is 'static'.
     * The consuming logger plugin is responsible for interpreting this value
     * (e.g. as a hex/base64-encoded key).
     */
    staticKey?: string;
    /** Environment variable name holding the encryption key. Defaults to 'CONTEXTIO_ENCRYPTION_KEY'. */
    keyEnvVar?: string;
    /** Encryption key length in bytes. Defaults to 32 (AES-256). */
    keyLength: number;
}
/** Default OIDC scopes requested during authentication. */
export declare const DEFAULT_OIDC_SCOPE: readonly ["openid", "profile", "email"];
/**
 * Configuration for a single OpenID Connect identity provider.
 *
 * Consumers should treat `sessionSecret` as sensitive and inject it
 * from a secrets manager or environment variable — never hard-code it.
 */
export interface OidcProviderConfig {
    /** OIDC issuer URL (e.g. `https://accounts.google.com`). */
    issuer: string;
    /** OAuth2 client identifier registered with the provider. */
    clientId: string;
    /** OAuth2 client secret. Treat as sensitive. */
    clientSecret: string;
    /** Redirect URI registered with the provider for the authorization callback. */
    callbackUrl: string;
    /**
     * OIDC scopes to request.
     *
     * @default ['openid', 'profile', 'email']
     */
    scope: string[];
    /** Secret used to sign/encrypt session cookies during the auth flow. */
    sessionSecret: string;
}
/**
 * Rate limiter configuration for a single provider.
 *
 * Uses a token bucket algorithm with a sliding window:
 * - `maxRequests`: Maximum requests allowed in the window
 * - `windowMs`: Time window in milliseconds
 * - `bufferCapacity`: Token bucket capacity (burst allowance)
 */
export interface RateLimitConfig {
    /** Maximum requests allowed within the time window. */
    maxRequests: number;
    /** Time window in milliseconds. */
    windowMs: number;
    /** Token bucket capacity for burst handling. */
    bufferCapacity: number;
}
/**
 * Retry configuration for a single provider.
 *
 * Uses exponential backoff with jitter:
 * - `maxRetries`: Maximum number of retry attempts
 * - `baseDelayMs`: Base delay in milliseconds between retries
 * - `maxDelayMs`: Maximum delay in milliseconds between retries
 * - `retryableStatuses`: HTTP status codes that should trigger a retry
 * - `jitterFactor`: Factor to randomize delay (0-1) to avoid thundering herd
 * - `maxStreamRetries`: Maximum retry attempts for streaming responses (SSE)
 * - `maxResponseBufferSize`: Maximum buffer size in bytes for streaming response buffering
 * - `enabled`: Whether streaming retry is enabled for this provider
 */
export interface RetryConfig {
    /** Maximum number of retry attempts. */
    maxRetries: number;
    /** Base delay in milliseconds between retries. */
    baseDelayMs: number;
    /** Maximum delay in milliseconds between retries. */
    maxDelayMs: number;
    /** HTTP status codes that should trigger a retry. */
    retryableStatuses: number[];
    /** Factor to randomize delay (0-1) to avoid thundering herd. */
    jitterFactor: number;
    /** Maximum retry attempts for streaming responses (SSE). Default: 3. */
    maxStreamRetries: number;
    /** Maximum buffer size in bytes for streaming response buffering. Default: 10485760 (10 MB). */
    maxResponseBufferSize: number;
    /** Whether streaming retry is enabled for this provider. Default: true. */
    enabled: boolean;
}
/**
 * Authentication type for a provider.
 */
export type AuthType = "bearer" | "api-key" | "none";
/**
 * Configuration for a single LLM provider.
 *
 * This is the canonical schema used by providers.json and the
 * providers management UI. All fields are required except where noted.
 */
export interface ProviderConfig {
    /** Unique provider identifier (key in providers map). */
    id: Provider;
    /** Human-readable display name. */
    name: string;
    /** Base URL for the provider's API. */
    upstreamUrl: string;
    /** Wire format of the provider's API. */
    apiFormat: ApiFormat;
    /** Authentication method. */
    authType: AuthType;
    /** Whether this provider is enabled. */
    enabled: boolean;
    /** Rate limiting configuration. */
    rateLimit: RateLimitConfig;
    /** Retry configuration. */
    retry: RetryConfig;
    /** Custom headers to include in requests to this provider. */
    customHeaders: Record<string, string>;
    /** Whether to allow clients to override the base URL via x-<provider>-baseurl header. */
    allowBaseUrlOverride: boolean;
    /** Header name to use for base URL override (e.g., "x-openai-baseurl"). */
    baseUrlOverrideHeader: string;
}
/**
 * Map of provider configurations keyed by provider ID.
 */
export type ProvidersMap = Record<Provider, ProviderConfig>;
/**
 * Validates a ProviderConfig object.
 *
 * @throws {Error} If validation fails, with a descriptive message.
 */
export declare function validateProviderConfig(config: ProviderConfig): void;
/**
 * Validates a RateLimitConfig object.
 *
 * @throws {Error} If validation fails, with a descriptive message.
 */
export declare function validateRateLimitConfig(config: RateLimitConfig): void;
/**
 * Validates a RetryConfig object.
 *
 * @throws {Error} If validation fails, with a descriptive message.
 */
export declare function validateRetryConfig(config: RetryConfig): void;
/**
 * Validates a ProvidersMap object.
 *
 * @throws {Error} If validation fails, with a descriptive message.
 */
export declare function validateProvidersMap(providers: ProvidersMap): void;
/**
 * Retry configuration with optional per-provider overrides.
 *
 * The `providers` map allows configuring different retry behavior for each
 * LLM provider (e.g., Anthropic may need different settings than OpenAI).
 * Provider-specific config is merged with global defaults at runtime.
 */
export interface RetryConfigWithProviders extends RetryConfig {
    /** Per-provider retry configuration overrides. */
    providers?: Partial<Record<Provider, Partial<RetryConfig>>>;
}
/**
 * Capture metadata stored in the database index.
 *
 * This is a lightweight index entry for fast querying. The full capture
 * data (request/response bodies, headers, etc.) remains in JSON files on disk
 * as the authoritative source of truth.
 */
export interface CaptureMetadata {
    /** Unique capture identifier (matches filename). */
    id: string;
    /** Session ID from the URL path, or null if not tagged. */
    sessionId?: string | null;
    /** Relative filepath to the capture JSON file on disk. */
    filepath: string;
    /** Timestamp when the request was received (epoch milliseconds). */
    timestamp: number;
    /** Request model name if detected. */
    requestModel?: string | null;
    /** Response model name if detected. */
    responseModel?: string | null;
    /** Number of prompt tokens (if available). */
    tokensPrompt?: number | null;
    /** Number of completion tokens (if available). */
    tokensCompletion?: number | null;
    /** Total request duration in milliseconds (if available). */
    durationMs?: number | null;
    /** Capture status: 'success', 'error', 'streaming', etc. */
    status: 'success' | 'error' | 'streaming' | string;
    /** When this metadata entry was created in the database (epoch milliseconds). */
    createdAt: number;
}
export interface ProxyConfig {
    port?: number;
    bindHost?: string;
    upstreams?: Partial<Upstreams>;
    allowTargetOverride?: boolean;
    strictUrlForwarding?: boolean;
    plugins?: ProxyPlugin[];
    loggerCaptureDir?: string;
    loggerCaptureMaxAgeMs?: number;
    loggerCaptureCleanupIntervalMs?: number;
    loggerCaptureCleanupEnabled?: boolean;
    /** Encryption-at-rest configuration forwarded to the logger plugin. */
    loggerEncryption?: EncryptionAtRestConfig;
    /** Optional OpenID Connect authentication configuration. */
    oidc?: OidcProviderConfig;
    /** Public-facing URL for the proxy (e.g., https://contextio.example.com).
     * Used for OIDC callback URLs when behind a reverse proxy.
     * If not set, computed from request headers (X-Forwarded-*, Host). */
    publicUrl?: string;
}
/**
 * Rate limiter bucket state for a specific provider/session combination.
 */
export interface RateLimiterBucketState {
    /** Unique key identifying the bucket (e.g., "sessionId:provider") */
    key: string;
    /** Current available tokens in the bucket */
    tokens: number;
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
 * Rate limiter configuration summary.
 */
export interface RateLimiterConfigSummary {
    /** Maximum requests allowed within the time window. */
    maxRequests: number;
    /** Time window in milliseconds. */
    windowMs: number;
    /** Token bucket capacity for burst handling. */
    bufferCapacity: number;
    /** Maximum number of buckets to track. */
    maxEntries: number;
    /** Whether the rate limiter is enabled. */
    enabled: boolean;
}
/**
 * Complete rate limiter metrics response.
 */
export interface RateLimiterMetrics {
    /** Rate limiter configuration */
    config: RateLimiterConfigSummary;
    /** Array of all bucket states */
    buckets: RateLimiterBucketState[];
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
export interface ExtractSourceResult {
    source: string | null;
    sessionId: string | null;
    cleanPath: string;
}
export interface ResolveTargetResult {
    targetUrl: string | undefined;
    provider: Provider;
    apiFormat: ApiFormat;
}
//# sourceMappingURL=types.d.ts.map