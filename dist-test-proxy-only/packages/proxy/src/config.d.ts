/**
 * Proxy configuration resolution.
 *
 * Merges programmatic overrides with environment variables and applies
 * safe defaults. All upstream URLs, bind address, port, capture retention,
 * and feature flags are resolved here before the proxy starts.
 */
import type { EncryptionAtRestConfig, OidcProviderConfig, ProxyConfig, Upstreams, Provider, RateLimitConfig, RetryConfig, ProvidersMap } from "@contextio/core";
/**
 * Load provider configurations from SQLite database.
 *
 * Reads and validates providers from the database. Each provider must have all
 * required fields per the ProviderConfig schema. Invalid providers are skipped.
 * Providers with enabled=false are excluded from the returned map.
 * Falls back to providers.json for backward compatibility if database is empty.
 */
export declare function readProvidersConfig(filePath?: string): ProvidersMap;
/** Fully resolved config with all defaults applied. */
export interface ResolvedProxyConfig {
    upstreams: Upstreams;
    bindHost: string;
    port: number;
    allowTargetOverride: boolean;
    strictUrlForwarding: boolean;
    loggerCaptureDir: string;
    loggerCaptureMaxAgeMs: number;
    loggerCaptureCleanupIntervalMs: number;
    loggerCaptureCleanupEnabled: boolean;
    loggerEncryption: EncryptionAtRestConfig;
    oidc: OidcProviderConfig | null;
    publicUrl: string | null;
    rateLimiter: Record<Provider, RateLimitConfig>;
    retry: Record<Provider, RetryConfig>;
    providers: ProvidersMap;
}
/**
 * Resolve OIDC configuration from environment variables and overrides.
 *
 * Reads CONTEXTIO_OIDC_* environment variables. If OIDC is enabled but
 * required fields are missing, throws a descriptive error.
 *
 * Note: oidcEnabled and oidcPublicUrl can be set via web UI settings file
 * (/app/custom-policy/settings.json) but are overridden by environment variables.
 * Secrets (issuer, client_id, client_secret, session_secret) MUST come from env vars.
 */
export declare function resolveOidcConfig(overrides?: ProxyConfig): OidcProviderConfig | null;
/**
 * Resolve final proxy config from environment variables and overrides.
 *
 * Capture retention:
 * - `LOGGER_CAPTURE_DIR` overrides the capture directory
 * - `LOGGER_CAPTURE_MAX_AGE` enable time-based retention when > 0
 * - `LOGGER_CAPTURE_CLEANUP_INTERVAL` controls cleanup interval (milliseconds,
 *   default: 3600000)
 * - `LOGGER_CAPTURE_CLEANUP_ENABLED` allows disabling cleanup while keeping
 *   the config values in place
 *
 * Encryption:
 * - `CONTEXTIO_LOGGER_ENCRYPTION_ENABLED` toggles at-rest encryption (default
 *   false)
 * - `CONTEXTIO_LOGGER_ENCRYPTION_KEY` provides the key material when encryption
 *   is enabled without an explicit override.
 *
 * OIDC authentication:
 * - `CONTEXTIO_OIDC_ENABLED` - explicitly enable OIDC (e.g., "true")
 * - `CONTEXTIO_OIDC_ISSUER` - OIDC issuer URL (e.g., https://accounts.google.com)
 * - `CONTEXTIO_OIDC_CLIENT_ID` - OAuth2 client ID
 * - `CONTEXTIO_OIDC_CLIENT_SECRET` - OAuth2 client secret
 * - `CONTEXTIO_OIDC_SESSION_SECRET` - Secret for signing/encrypting session cookies
 * - `CONTEXTIO_OIDC_SCOPE` - Space-separated scopes (default: "openid profile email")
 * - `CONTEXTIO_OIDC_PUBLIC_URL` - Public-facing URL (e.g., https://contextio.example.com)
 *   Used for OIDC callback URLs when behind a reverse proxy
 *
 * Rate limiting:
 * - `CONTEXTIO_RATE_LIMIT_<PROVIDER>_MAX_REQUESTS` - Max requests per window (default: 60)
 * - `CONTEXTIO_RATE_LIMIT_<PROVIDER>_WINDOW_MS` - Time window in milliseconds (default: 60000)
 * - `CONTEXTIO_RATE_LIMIT_<PROVIDER>_BUFFER` - Token bucket capacity for bursts (default: 10)
 * Valid providers: openai, anthropic, chatgpt, gemini, vertex, nvidia, openrouter, kilo, unknown
 *
 * Retry:
 * - `CONTEXTIO_RETRY_<PROVIDER>_MAX_RETRIES` - Max retry attempts (default: 3)
 * - `CONTEXTIO_RETRY_<PROVIDER>_BASE_DELAY_MS` - Initial delay in ms (default: 1000)
 * - `CONTEXTIO_RETRY_<PROVIDER>_MAX_DELAY_MS` - Max delay cap in ms (default: 30000)
 * - `CONTEXTIO_RETRY_<PROVIDER>_RETRYABLE_STATUSES` - Comma-separated HTTP codes (default: 429,500,502,503,504)
 * - `CONTEXTIO_RETRY_<PROVIDER>_JITTER_FACTOR` - Jitter factor 0-1 (default: 0.2)
 * - `CONTEXTIO_RETRY_<PROVIDER>_MAX_STREAM_RETRIES` - Max streaming retry attempts (default: 3)
 * - `CONTEXTIO_RETRY_<PROVIDER>_MAX_RESPONSE_BUFFER_SIZE` - Max streaming buffer in bytes (default: 10485760)
 * - `CONTEXTIO_RETRY_<PROVIDER>_STREAMING_RETRY_ENABLED` - Whether streaming retry is enabled (default: true)
 *
 * Legacy (deprecated) env vars:
 * - `OIDC_ISSUER`, `OIDC_CLIENT_ID`, `OIDC_CLIENT_SECRET`, `OIDC_SESSION_SECRET`, `OIDC_SCOPE`
 *   All must be set together to enable OIDC without CONTEXTIO_OIDC_ENABLED.
 * - `CONTEXTIO_PUBLIC_URL` - Deprecated alias for CONTEXTIO_OIDC_PUBLIC_URL
 */
export declare function resolveConfig(overrides?: ProxyConfig): ResolvedProxyConfig;
//# sourceMappingURL=config.d.ts.map