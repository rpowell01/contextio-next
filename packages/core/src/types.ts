/**
 * Core types for the contextio proxy ecosystem.
 *
 * These are the public types that plugins and consumers depend on.
 * Zero external dependencies.
 */

// --- Provider / API format ---

/**
 * LLM API provider identifier.
 *
 * "chatgpt" is separate from "openai" because ChatGPT's backend API
 * (used by Codex subscriptions) has a different format from the
 * OpenAI platform API.
 */
export type Provider =
  | "anthropic"
  | "openai"
  | "chatgpt"
  | "gemini"
  | "vertex"
  | "nvidia"
  | "openrouter"
  | "kilo"
  | "unknown";

/**
 * Wire format of the API request.
 *
 * Used to determine how to parse request/response bodies for token
 * usage, streaming events, and content extraction.
 */
export type ApiFormat =
  | "anthropic-messages"
  | "chatgpt-backend"
  | "responses"
  | "chat-completions"
  | "gemini"
  | "raw"
  | "unknown";

export type JsonPrimitive = string | number | boolean | null;
export type JsonValue = JsonPrimitive | JsonObject | JsonValue[];
export type JsonObject = { [key: string]: JsonValue };

export type HeaderMap = Record<string, string | string[] | undefined>;

// --- Upstream targets ---

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

// --- Capture data (the full request/response record) ---

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
  redactionStats?: { totalRedactions: number; byRule: Record<string, number> };
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

// --- Plugin system ---

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
  redactionStats?: { totalRedactions: number; byRule: Record<string, number> };
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
  onResponse?: (
    ctx: ResponseContext,
  ) => ResponseContext | Promise<ResponseContext>;

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

// --- Encryption at rest ---

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
// --- OIDC auth config ---

/** Default OIDC scopes requested during authentication. */
export const DEFAULT_OIDC_SCOPE = ["openid", "profile", "email"] as const;

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

// --- Rate limiter ---

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
}

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


// --- Proxy config ---

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

// --- Routing helpers (re-exported from routing.ts) ---

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
