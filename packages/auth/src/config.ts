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

/**
 * Read web UI settings oidcPublicUrl from environment variables fallback.
 * Since we cannot import from the proxy package across packages,
 * we read oidcPublicUrl directly from env as a fallback.
 */
function readWebUISettingsOidcPublicUrl(): string {
  return process.env.CONTEXTIO_OIDC_PUBLIC_URL || process.env.CONTEXTIO_PUBLIC_URL || "";
}

/** Get the OIDC public URL from environment or settings, falling back to null. */
export function getOidcPublicUrl(): string | null {
  // Priority: env vars > fallback > null
  return (
    // Environment variable (highest priority)
    process.env.CONTEXTIO_OIDC_PUBLIC_URL ||
    // Deprecated alias
    process.env.CONTEXTIO_PUBLIC_URL ||
    // Fallback (no cross-package dependency)
    readWebUISettingsOidcPublicUrl() || null
  );
}

/** Get the OIDC issuer URL, preferring CONTEXTIO_OIDC_ISSUER over legacy OIDC_ISSUER. */
export function getOidcIssuer(): string | null {
  return (
    process.env.CONTEXTIO_OIDC_ISSUER || process.env.OIDC_ISSUER || null
  );
}

/** Get the OIDC client ID, preferring CONTEXTIO_OIDC_CLIENT_ID over legacy OIDC_CLIENT_ID. */
export function getOidcClientId(): string | null {
  return (
    process.env.CONTEXTIO_OIDC_CLIENT_ID || process.env.OIDC_CLIENT_ID || null
  );
}

/** Get the OIDC client secret, preferring CONTEXTIO_OIDC_CLIENT_SECRET over legacy OIDC_CLIENT_SECRET. */
export function getOidcClientSecret(): string | null {
  return (
    process.env.CONTEXTIO_OIDC_CLIENT_SECRET || process.env.OIDC_CLIENT_SECRET || null
  );
}

/** Get the OIDC session secret, preferring CONTEXTIO_OIDC_SESSION_SECRET over legacy OIDC_SESSION_SECRET. */
export function getOidcSessionSecret(): string | null {
  return (
    process.env.CONTEXTIO_OIDC_SESSION_SECRET || process.env.OIDC_SESSION_SECRET || null
  );
}

/** Get the OIDC scope, merging CONTEXTIO_OIDC_SCOPE and legacy OIDC_SCOPE. */
export function getOidcScope(): string[] {
  // Try CONTEXTIO_OIDC_SCOPE first, then legacy OIDC_SCOPE, then defaults
  const scopeString =
    process.env.CONTEXTIO_OIDC_SCOPE?.split(/\s+/).filter(Boolean) ||
    process.env.OIDC_SCOPE?.split(/\s+/).filter(Boolean) ||
    ["openid", "profile", "email"];

  return scopeString;
}

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
export function getOidcCallbackUrl(baseUrl?: string): string {
  const publicUrl = baseUrl || getOidcPublicUrl();
  if (!publicUrl) {
    throw new Error(
      "CONTEXTIO_OIDC_PUBLIC_URL must be set for OIDC callback URL construction",
    );
  }
  return `${publicUrl}/auth/callback`;
}

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
export function resolveOidcConfig(): import("@contextio/core").OidcProviderConfig | null {
  const issuer = getOidcIssuer();
  const clientId = getOidcClientId();
  const clientSecret = getOidcClientSecret();
  const sessionSecret = getOidcSessionSecret();
  const scope = getOidcScope();

  if (!issuer) {
    return null;
  }

  if (!clientId) {
    throw new Error("OIDC enabled but CONTEXTIO_OIDC_CLIENT_ID is not set");
  }
  if (!clientSecret) {
    throw new Error("OIDC enabled but CONTEXTIO_OIDC_CLIENT_SECRET is not set");
  }
  if (!sessionSecret) {
    throw new Error("OIDC enabled but CONTEXTIO_OIDC_SESSION_SECRET is not set");
  }
  if (sessionSecret.length < 32) {
    throw new Error("OIDC session secret must be at least 32 characters");
  }
  if (!issuer.startsWith("https://")) {
    throw new Error("OIDC issuer must use HTTPS");
  }

  return {
    issuer,
    clientId,
    clientSecret,
    callbackUrl: "", // Filled in by auth handler from baseUrl
    scope,
    sessionSecret,
  };
}