/**
 * OIDC configuration resolution for the auth handler.
 *
 * Reads CONTEXTIO_OIDC_* environment variables and provides a configurable
 * base URL for OIDC callback URL construction. Replaces hardcoded localhost
 * URLs with environment variable-based configuration or dynamic URL construction
 * based on the request context.
 *
 * Environment variables:
 *   - CONTEXTIO_OIDC_PUBLIC_URL: Public-facing URL (e.g., https://example.com)
 *     Used for OIDC callback URLs when behind a reverse proxy
 *   - CONTEXTIO_OIDC_ENABLED: Enable OIDC (e.g., "true")
 *   - OIDC_ISSUER: OIDC issuer URL (legacy env var)
 *   - OIDC_CLIENT_ID: OAuth2 client ID (legacy env var)
 *   - OIDC_CLIENT_SECRET: OAuth2 client secret (legacy env var)
 *   - OIDC_SESSION_SECRET: Session secret (legacy env var)
 */
/** Get the OIDC public URL from environment or settings, falling back to null. */
export declare function getOidcPublicUrl(): string | null;
/** Get the OIDC issuer URL, preferring CONTEXTIO_OIDC_ISSUER over legacy OIDC_ISSUER. */
export declare function getOidcIssuer(): string | null;
/** Get the OIDC client ID, preferring CONTEXTIO_OIDC_CLIENT_ID over legacy OIDC_CLIENT_ID. */
export declare function getOidcClientId(): string | null;
/** Get the OIDC client secret, preferring CONTEXTIO_OIDC_CLIENT_SECRET over legacy OIDC_CLIENT_SECRET. */
export declare function getOidcClientSecret(): string | null;
/** Get the OIDC session secret, preferring CONTEXTIO_OIDC_SESSION_SECRET over legacy OIDC_SESSION_SECRET. */
export declare function getOidcSessionSecret(): string | null;
/** Get the OIDC scope, merging CONTEXTIO_OIDC_SCOPE and legacy OIDC_SCOPE. */
export declare function getOidcScope(): string[];
/**
 * Construct the OIDC callback URL from the base URL and the fixed callback path.
 *
 * This replaces the hardcoded `${baseUrl}/auth/callback` pattern with a
 * configurable base URL that can be set via environment variables or derived
 * from the request context.
 *
 * @param baseUrl - The base URL to use for callback construction. If not provided,
 *   will attempt to read from CONTEXTIO_OIDC_PUBLIC_URL environment variable.
 * @returns The full callback URL (e.g., "https://example.com/auth/callback")
 * @throws Error if no public URL is configured
 */
export declare function getOidcCallbackUrl(baseUrl?: string): string;
/**
 * Resolve the full OIDC provider configuration from environment variables.
 *
 * This function centralizes the reading of OIDC environment variables and
 * provides a single point of configuration for the OIDC auth flow. It replaces
 * the scattered individual env var reads throughout the codebase with a single
 * configurable source that can be dynamically updated based on the request context.
 *
 * @returns OIDC provider configuration, or null if OIDC is not configured
 */
export declare function resolveOidcConfig(): import("@contextio/core").OidcProviderConfig | null;
//# sourceMappingURL=config.d.ts.map