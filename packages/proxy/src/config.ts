/**
 * Proxy configuration resolution.
 *
 * Merges programmatic overrides with environment variables and applies
 * safe defaults. All upstream URLs, bind address, port, capture retention,
 * and feature flags are resolved here before the proxy starts.
 */

import fs from "node:fs";

import type { EncryptionAtRestConfig, OidcProviderConfig, ProxyConfig, Upstreams, Provider, RateLimitConfig, RetryConfig, ProvidersMap, ProviderConfig, ApiFormat, AuthType } from "@contextio/core";
import { DEFAULT_OIDC_SCOPE, validateRateLimitConfig, validateRetryConfig, KNOWN_API_FORMATS, KNOWN_AUTH_TYPES } from "@contextio/core";

/** Known provider identifiers for runtime validation. */
const KNOWN_PROVIDERS = [
  "anthropic",
  "openai",
  "chatgpt",
  "gemini",
  "vertex",
  "nvidia",
  "openrouter",
  "kilo",
  "unknown",
] as const satisfies readonly Provider[];

/** Type predicate to check if a string is a valid Provider. */
function isProvider(value: string): value is Provider {
  return KNOWN_PROVIDERS.includes(value as Provider);
}

/** Normalize an upstream URL by stripping a trailing `/v1` so callers do not
 * double-prefix API paths. Empty values pass through intact.
 */
function normalizeUpstreamUrl(url: string): string {
  if (!url || typeof url !== "string") {
    return url;
  }
  return url.replace(/\/v1$/, "");
}

/**
 * Merge user provider config with defaults, validating each field individually.
 * Invalid fields fall back to defaults instead of rejecting the entire provider.
 */
function mergeProviderConfig(
  defaultConfig: ProviderConfig,
  userConfig: Record<string, unknown>,
  providerKey: Provider,
): ProviderConfig {
  const merged: ProviderConfig = { ...defaultConfig };

  // Validate and merge id
  if (typeof userConfig.id === "string" && userConfig.id === providerKey) {
    merged.id = userConfig.id;
  }

  // Validate and merge name
  if (typeof userConfig.name === "string" && userConfig.name.trim() !== "") {
    merged.name = userConfig.name;
  }

  // Validate and merge upstreamUrl
  if (typeof userConfig.upstreamUrl === "string") {
    try {
      new URL(userConfig.upstreamUrl);
      merged.upstreamUrl = userConfig.upstreamUrl;
    } catch {
      // Invalid URL, keep default
    }
  }

  // Validate and merge apiFormat
  if (typeof userConfig.apiFormat === "string" && KNOWN_API_FORMATS.includes(userConfig.apiFormat as ApiFormat)) {
    merged.apiFormat = userConfig.apiFormat as ApiFormat;
  }

  // Validate and merge authType
  if (typeof userConfig.authType === "string" && KNOWN_AUTH_TYPES.includes(userConfig.authType as AuthType)) {
    merged.authType = userConfig.authType as AuthType;
  }

  // Validate and merge enabled
  if (typeof userConfig.enabled === "boolean") {
    merged.enabled = userConfig.enabled;
  }

  // Validate and merge rateLimit (field by field)
  if (userConfig.rateLimit && typeof userConfig.rateLimit === "object" && !Array.isArray(userConfig.rateLimit)) {
    const userRateLimit = userConfig.rateLimit as Record<string, unknown>;
    const mergedRateLimit: RateLimitConfig = { ...defaultConfig.rateLimit };

    if (typeof userRateLimit.maxRequests === "number" && Number.isFinite(userRateLimit.maxRequests) && userRateLimit.maxRequests >= 0) {
      mergedRateLimit.maxRequests = userRateLimit.maxRequests;
    }
    if (typeof userRateLimit.windowMs === "number" && Number.isFinite(userRateLimit.windowMs) && userRateLimit.windowMs > 0) {
      mergedRateLimit.windowMs = userRateLimit.windowMs;
    }
    if (typeof userRateLimit.bufferCapacity === "number" && Number.isFinite(userRateLimit.bufferCapacity) && userRateLimit.bufferCapacity >= 0) {
      mergedRateLimit.bufferCapacity = userRateLimit.bufferCapacity;
    }

    try {
      validateRateLimitConfig(mergedRateLimit);
      merged.rateLimit = mergedRateLimit;
    } catch {
      // Keep default rateLimit
    }
  }

  // Validate and merge retry (field by field)
  if (userConfig.retry && typeof userConfig.retry === "object" && !Array.isArray(userConfig.retry)) {
    const userRetry = userConfig.retry as Record<string, unknown>;
    const mergedRetry: RetryConfig = { ...defaultConfig.retry };

    // Track which fields the user explicitly provided (and are valid)
    const userProvidedBaseDelayMs =
      typeof userRetry.baseDelayMs === "number" && Number.isFinite(userRetry.baseDelayMs) && userRetry.baseDelayMs >= 0;
    const userProvidedMaxDelayMs =
      typeof userRetry.maxDelayMs === "number" && Number.isFinite(userRetry.maxDelayMs) && userRetry.maxDelayMs >= 0;

    // Apply valid individual fields first
    if (typeof userRetry.maxRetries === "number" && Number.isFinite(userRetry.maxRetries) && userRetry.maxRetries >= 0) {
      mergedRetry.maxRetries = userRetry.maxRetries;
    }
    if (userProvidedBaseDelayMs) {
      mergedRetry.baseDelayMs = userRetry.baseDelayMs as number;
    }
    if (userProvidedMaxDelayMs) {
      mergedRetry.maxDelayMs = userRetry.maxDelayMs as number;
    }
    // Check cross-field constraint on the MERGED result (user values + defaults)
    // If violated, revert ONLY the user-provided field(s) that cause the violation
    if (mergedRetry.maxDelayMs < mergedRetry.baseDelayMs) {
      // Constraint violated: maxDelayMs < baseDelayMs
      // Revert user-provided fields that contribute to the violation
      if (userProvidedMaxDelayMs) {
        mergedRetry.maxDelayMs = defaultConfig.retry.maxDelayMs;
      }
      if (userProvidedBaseDelayMs) {
        mergedRetry.baseDelayMs = defaultConfig.retry.baseDelayMs;
      }
    }
    if (Array.isArray(userRetry.retryableStatuses)) {
      const statuses = userRetry.retryableStatuses;
      let allValid = true;
      for (const status of statuses) {
        if (typeof status !== "number" || !Number.isFinite(status) || status < 100 || status > 599) {
          allValid = false;
          break;
        }
      }
      if (allValid) {
        mergedRetry.retryableStatuses = statuses as number[];
      }
    }
    if (typeof userRetry.jitterFactor === "number" && Number.isFinite(userRetry.jitterFactor) && userRetry.jitterFactor >= 0 && userRetry.jitterFactor <= 1) {
      mergedRetry.jitterFactor = userRetry.jitterFactor;
    }

    try {
      validateRetryConfig(mergedRetry);
      merged.retry = mergedRetry;
    } catch {
      // Keep default retry
    }
  }

  // Validate and merge customHeaders
  if (userConfig.customHeaders && typeof userConfig.customHeaders === "object" && !Array.isArray(userConfig.customHeaders)) {
    const userHeaders = userConfig.customHeaders as Record<string, unknown>;
    const mergedHeaders: Record<string, string> = {};
    let headersValid = true;
    for (const [key, value] of Object.entries(userHeaders)) {
      if (typeof key === "string" && typeof value === "string") {
        mergedHeaders[key] = value;
      } else {
        headersValid = false;
        break;
      }
    }
    if (headersValid) {
      merged.customHeaders = mergedHeaders;
    }
  }

  return merged;
}

/** Web UI settings interface for capture cleanup and OIDC settings. */
interface WebUISettings {
  captureCleanupEnabled?: boolean;
  captureCleanupIntervalHours?: number;
  captureCleanupMaxAgeDays?: number;
  // OIDC settings (non-sensitive, can be configured via UI)
  oidcEnabled?: boolean;
  oidcPublicUrl?: string;
  // Rate limiter settings per provider
  rateLimiter?: {
    [provider: string]: {
      maxRequests?: number;
      windowMs?: number;
      bufferCapacity?: number;
    };
  };
}

/** Read web UI settings from the JSON file. */
function readWebUISettings(): WebUISettings {
  // Check local development path first, then Docker path
  const homePath = process.env.HOME || process.env.USERPROFILE;
  const localSettingsPath = homePath ? `${homePath}/.contextio-next/settings.json` : null;
  const dockerSettingsPath = "/app/custom-policy/settings.json";

  const paths = [localSettingsPath, dockerSettingsPath].filter(Boolean) as string[];

  for (const settingsPath of paths) {
    try {
      const data = fs.readFileSync(settingsPath, "utf8");
      const parsed = JSON.parse(data);
      const result = {
        captureCleanupEnabled: parsed.captureCleanupEnabled,
        captureCleanupIntervalHours: parsed.captureCleanupIntervalHours,
        captureCleanupMaxAgeDays: parsed.captureCleanupMaxAgeDays,
        oidcEnabled: parsed.oidcEnabled,
        oidcPublicUrl: parsed.oidcPublicUrl,
        rateLimiter: parsed.rateLimiter,
      };
      console.log(`[config] read settings.json from ${settingsPath}: ${JSON.stringify(result)}`);
      return result;
    } catch (err) {
      console.log(`[config] failed to read settings.json at ${settingsPath}: ${err instanceof Error ? err.message : String(err)}`);
    }
  }
  return {};
}

const PROVIDERS_FILE = "/app/custom-policy/providers.json";

const DEFAULT_PROVIDERS_CONFIG: ProvidersMap = {
  anthropic: {
    id: "anthropic",
    name: "Anthropic",
    upstreamUrl: "https://api.anthropic.com",
    apiFormat: "anthropic-messages",
    authType: "bearer",
    enabled: true,
    rateLimit: { maxRequests: 60, windowMs: 60_000, bufferCapacity: 10 },
    retry: {
      maxRetries: 3,
      baseDelayMs: 1000,
      maxDelayMs: 30_000,
      retryableStatuses: [429, 500, 502, 503, 504],
      jitterFactor: 0.2,
    },
    customHeaders: {},
    allowBaseUrlOverride: true,
    baseUrlOverrideHeader: "x-anthropic-baseurl",
  },
  openai: {
    id: "openai",
    name: "OpenAI",
    upstreamUrl: "https://api.openai.com",
    apiFormat: "chat-completions",
    authType: "bearer",
    enabled: true,
    rateLimit: { maxRequests: 60, windowMs: 60_000, bufferCapacity: 10 },
    retry: {
      maxRetries: 3,
      baseDelayMs: 1000,
      maxDelayMs: 30_000,
      retryableStatuses: [429, 500, 502, 503, 504],
      jitterFactor: 0.2,
    },
    customHeaders: {},
    allowBaseUrlOverride: true,
    baseUrlOverrideHeader: "x-openai-baseurl",
  },
  chatgpt: {
    id: "chatgpt",
    name: "ChatGPT",
    upstreamUrl: "https://chatgpt.com",
    apiFormat: "chatgpt-backend",
    authType: "bearer",
    enabled: true,
    rateLimit: { maxRequests: 60, windowMs: 60_000, bufferCapacity: 10 },
    retry: {
      maxRetries: 3,
      baseDelayMs: 1000,
      maxDelayMs: 30_000,
      retryableStatuses: [429, 500, 502, 503, 504],
      jitterFactor: 0.2,
    },
    customHeaders: {},
    allowBaseUrlOverride: true,
    baseUrlOverrideHeader: "x-chatgpt-baseurl",
  },
  gemini: {
    id: "gemini",
    name: "Gemini",
    upstreamUrl: "https://generativelanguage.googleapis.com",
    apiFormat: "gemini",
    authType: "api-key",
    enabled: true,
    rateLimit: { maxRequests: 60, windowMs: 60_000, bufferCapacity: 10 },
    retry: {
      maxRetries: 3,
      baseDelayMs: 1000,
      maxDelayMs: 30_000,
      retryableStatuses: [429, 500, 502, 503, 504],
      jitterFactor: 0.2,
    },
    customHeaders: {},
    allowBaseUrlOverride: true,
    baseUrlOverrideHeader: "x-gemini-baseurl",
  },
  vertex: {
    id: "vertex",
    name: "Vertex AI",
    upstreamUrl: "https://us-central1-aiplatform.googleapis.com",
    apiFormat: "gemini",
    authType: "api-key",
    enabled: true,
    rateLimit: { maxRequests: 60, windowMs: 60_000, bufferCapacity: 10 },
    retry: {
      maxRetries: 3,
      baseDelayMs: 1000,
      maxDelayMs: 30_000,
      retryableStatuses: [429, 500, 502, 503, 504],
      jitterFactor: 0.2,
    },
    customHeaders: {},
    allowBaseUrlOverride: true,
    baseUrlOverrideHeader: "x-vertex-baseurl",
  },
  nvidia: {
    id: "nvidia",
    name: "NVIDIA",
    upstreamUrl: "https://integrate.api.nvidia.com",
    apiFormat: "chat-completions",
    authType: "bearer",
    enabled: true,
    rateLimit: { maxRequests: 20, windowMs: 60_000, bufferCapacity: 5 },
    retry: {
      maxRetries: 3,
      baseDelayMs: 1000,
      maxDelayMs: 30_000,
      retryableStatuses: [429, 500, 502, 503, 504],
      jitterFactor: 0.2,
    },
    customHeaders: {},
    allowBaseUrlOverride: true,
    baseUrlOverrideHeader: "x-nvidia-baseurl",
  },
  openrouter: {
    id: "openrouter",
    name: "OpenRouter",
    upstreamUrl: "https://openrouter.ai/api",
    apiFormat: "chat-completions",
    authType: "bearer",
    enabled: true,
    rateLimit: { maxRequests: 60, windowMs: 60_000, bufferCapacity: 10 },
    retry: {
      maxRetries: 3,
      baseDelayMs: 1000,
      maxDelayMs: 30_000,
      retryableStatuses: [429, 500, 502, 503, 504],
      jitterFactor: 0.2,
    },
    customHeaders: {},
    allowBaseUrlOverride: true,
    baseUrlOverrideHeader: "x-openrouter-baseurl",
  },
  kilo: {
    id: "kilo",
    name: "Kilo",
    upstreamUrl: "https://api.kilo.ai/api/gateway",
    apiFormat: "chat-completions",
    authType: "bearer",
    enabled: true,
    rateLimit: { maxRequests: 60, windowMs: 60_000, bufferCapacity: 10 },
    retry: {
      maxRetries: 3,
      baseDelayMs: 1000,
      maxDelayMs: 30_000,
      retryableStatuses: [429, 500, 502, 503, 504],
      jitterFactor: 0.2,
    },
    customHeaders: {},
    allowBaseUrlOverride: true,
    baseUrlOverrideHeader: "x-kilo-baseurl",
  },
  unknown: {
    id: "unknown",
    name: "Unknown",
    upstreamUrl: "https://unknown.provider",
    apiFormat: "unknown",
    authType: "none",
    enabled: true,
    rateLimit: { maxRequests: 60, windowMs: 60_000, bufferCapacity: 10 },
    retry: {
      maxRetries: 3,
      baseDelayMs: 1000,
      maxDelayMs: 30_000,
      retryableStatuses: [429, 500, 502, 503, 504],
      jitterFactor: 0.2,
    },
    customHeaders: {},
    allowBaseUrlOverride: false,
    baseUrlOverrideHeader: "x-unknown-baseurl",
  },
};

/**
 * Load provider configurations from /app/custom-policy/providers.json.
 *
 * If the file is missing or invalid, falls back to built-in defaults.
 * Invalid fields in a provider entry fall back to defaults individually.
 * Providers with enabled=false are excluded from the returned map.
 */
export function readProvidersConfig(filePath = PROVIDERS_FILE): ProvidersMap {
  try {
    const data = fs.readFileSync(filePath, "utf8");
    const parsed = JSON.parse(data);
    const result: ProvidersMap = { ...DEFAULT_PROVIDERS_CONFIG };

    let loaded = 0;
    let skipped = 0;
    for (const [key, value] of Object.entries(parsed)) {
      if (typeof value !== "object" || value === null) {
        skipped++;
        console.warn(`[config] skip providers.json[${key}]: not an object`);
        continue;
      }
      const config = value as Record<string, unknown>;
      if (config.id !== key) {
        skipped++;
        console.warn(`[config] skip providers.json[${key}]: id mismatch (expected ${key}, got ${config.id})`);
        continue;
      }
      if (typeof config.upstreamUrl !== "string") {
        skipped++;
        console.warn(`[config] skip providers.json[${key}]: missing or non-string upstreamUrl`);
        continue;
      }
      // Validate that the key is a known Provider before casting
      if (!isProvider(key)) {
        skipped++;
        console.warn(`[config] skip providers.json[${key}]: unknown provider`);
        continue;
      }
      const providerKey = key;
      const defaultConfig = DEFAULT_PROVIDERS_CONFIG[providerKey];
      if (!defaultConfig) {
        skipped++;
        console.warn(`[config] skip providers.json[${key}]: unknown provider`);
        continue;
      }
      // Merge user config with defaults, validating each field individually
      const mergedConfig = mergeProviderConfig(defaultConfig, config, providerKey);
      if (mergedConfig.enabled === false) {
        skipped++;
        console.warn(`[config] skip providers.json[${key}]: disabled by enabled=false`);
        continue;
      }
      result[providerKey] = mergedConfig;
      loaded++;
    }

    // Remove any providers from defaults that were explicitly disabled in file
    for (const [key, value] of Object.entries(parsed)) {
      if (typeof value === "object" && value !== null) {
        const config = value as Record<string, unknown>;
        if (config.id === key && config.enabled === false && isProvider(key) && result[key]) {
          delete result[key];
        }
      }
    }

    console.log(`[config] read providers.json: ${loaded} providers loaded from file, ${skipped} skipped, ${Object.keys(result).length} active (file entries replace defaults per provider)`);
    return result;
  } catch (err) {
    console.error(`[config] failed to read providers.json at ${filePath}: ${err instanceof Error ? err.message : String(err)}. Using built-in defaults.`);
    return { ...DEFAULT_PROVIDERS_CONFIG };
  }
}

/** Fallback to web UI settings for capture cleanup config. */
function getCaptureCleanupMaxAgeMs(): number {
  const raw = process.env.LOGGER_CAPTURE_MAX_AGE ?? readWebUISettings().captureCleanupMaxAgeDays?.toString();
  const parsed = raw ? Number.parseInt(raw, 10) : 0;
  return Number.isFinite(parsed) ? parsed * 24 * 60 * 60 * 1000 : 0;
}

function getCaptureCleanupIntervalMs(): number {
  const raw = process.env.LOGGER_CAPTURE_CLEANUP_INTERVAL ?? readWebUISettings().captureCleanupIntervalHours?.toString() ?? "24";
  const parsed = Number.parseInt(raw, 10);
  return Number.isFinite(parsed) && parsed > 0
    ? parsed * 60 * 60 * 1000
    : 24 * 60 * 60 * 1000;
}

function getCaptureCleanupEnabled(maxAgeMs: number): boolean {
  const envEnabled = process.env.LOGGER_CAPTURE_CLEANUP_ENABLED;
  if (envEnabled !== undefined) return envEnabled === "true";
  const settingsEnabled = readWebUISettings().captureCleanupEnabled;
  if (settingsEnabled !== undefined) return settingsEnabled;
  return maxAgeMs > 0;
}

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
export function resolveOidcConfig(
  overrides?: ProxyConfig,
): OidcProviderConfig | null {
  const settings = readWebUISettings();

  const enabled = overrides?.oidc?.issuer
    || process.env.CONTEXTIO_OIDC_ENABLED === "true"
    || settings.oidcEnabled === true
    || (process.env.OIDC_ISSUER && process.env.OIDC_CLIENT_ID && process.env.OIDC_CLIENT_SECRET && process.env.OIDC_SESSION_SECRET);

  console.log(`[config] OIDC resolve: enabled=${enabled}`);
  console.log(`[config] env.CONTEXTIO_OIDC_ENABLED=${process.env.CONTEXTIO_OIDC_ENABLED}`);
  console.log(`[config] settings.oidcEnabled=${settings.oidcEnabled}`);
  console.log(`[config] hasLegacyCreds=${!!(process.env.OIDC_ISSUER && process.env.OIDC_CLIENT_ID && process.env.OIDC_CLIENT_SECRET && process.env.OIDC_SESSION_SECRET)}`);
  console.log(`[config] env.CONTEXTIO_OIDC_ISSUER=${process.env.CONTEXTIO_OIDC_ISSUER ? 'SET' : 'NOT SET'}`);
  console.log(`[config] env.CONTEXTIO_OIDC_CLIENT_ID=${process.env.CONTEXTIO_OIDC_CLIENT_ID ? 'SET' : 'NOT SET'}`);
  console.log(`[config] env.CONTEXTIO_OIDC_PUBLIC_URL=${process.env.CONTEXTIO_OIDC_PUBLIC_URL || 'NOT SET'}`);
  console.log(`[config] settings.oidcPublicUrl=${settings.oidcPublicUrl || 'NOT SET'}`);

  if (!enabled) {
    return null;
  }

  const issuer = overrides?.oidc?.issuer || process.env.CONTEXTIO_OIDC_ISSUER || process.env.OIDC_ISSUER;
  const clientId = overrides?.oidc?.clientId || process.env.CONTEXTIO_OIDC_CLIENT_ID || process.env.OIDC_CLIENT_ID;
  const clientSecret = overrides?.oidc?.clientSecret || process.env.CONTEXTIO_OIDC_CLIENT_SECRET || process.env.OIDC_CLIENT_SECRET;
  const sessionSecret = overrides?.oidc?.sessionSecret || process.env.CONTEXTIO_OIDC_SESSION_SECRET || process.env.OIDC_SESSION_SECRET;
  const scope = overrides?.oidc?.scope
    || process.env.CONTEXTIO_OIDC_SCOPE?.split(/\s+/).filter(Boolean)
    || process.env.OIDC_SCOPE?.split(/\s+/).filter(Boolean)
    || [...DEFAULT_OIDC_SCOPE];

  if (!issuer) {
    throw new Error("OIDC enabled but CONTEXTIO_OIDC_ISSUER is not set");
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

  console.log(`[config] OIDC configured: issuer=${issuer}, clientId=${clientId}, scope=${scope.join(" ")}`);

  return {
    issuer,
    clientId,
    clientSecret,
    callbackUrl: "", // Filled in by auth handler from baseUrl
    scope,
    sessionSecret,
  };
}

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
 *
 * Legacy (deprecated) env vars:
 * - `OIDC_ISSUER`, `OIDC_CLIENT_ID`, `OIDC_CLIENT_SECRET`, `OIDC_SESSION_SECRET`, `OIDC_SCOPE`
 *   All must be set together to enable OIDC without CONTEXTIO_OIDC_ENABLED.
 * - `CONTEXTIO_PUBLIC_URL` - Deprecated alias for CONTEXTIO_OIDC_PUBLIC_URL
 */
export function resolveConfig(
  overrides?: ProxyConfig,
): ResolvedProxyConfig {
  const providersConfig = readProvidersConfig();

  const defaultUpstreams: Upstreams = {
    openai:
      process.env.UPSTREAM_OPENAI_URL ||
      providersConfig.openai?.upstreamUrl ||
      "https://api.openai.com",
    anthropic:
      process.env.UPSTREAM_ANTHROPIC_URL ||
      providersConfig.anthropic?.upstreamUrl ||
      "https://api.anthropic.com",
    chatgpt:
      process.env.UPSTREAM_CHATGPT_URL ||
      providersConfig.chatgpt?.upstreamUrl ||
      "https://chatgpt.com",
    gemini:
      process.env.UPSTREAM_GEMINI_URL ||
      providersConfig.gemini?.upstreamUrl ||
      "https://generativelanguage.googleapis.com",
    geminiCodeAssist:
      process.env.UPSTREAM_GEMINI_CODE_ASSIST_URL ||
      "https://cloudcode-pa.googleapis.com",
    vertex:
      process.env.UPSTREAM_VERTEX_URL ||
      providersConfig.vertex?.upstreamUrl ||
      "https://us-central1-aiplatform.googleapis.com",
    nvidia:
      process.env.UPSTREAM_NVIDIA_URL ||
      providersConfig.nvidia?.upstreamUrl ||
      "https://integrate.api.nvidia.com",
    kilo:
      process.env.UPSTREAM_KILO_URL ||
      providersConfig.kilo?.upstreamUrl ||
      "https://api.kilo.ai/api/gateway",
    openrouter:
      process.env.UPSTREAM_OPENROUTER_URL ||
      providersConfig.openrouter?.upstreamUrl ||
      "https://openrouter.ai/api",
  };

  const bindHost =
    overrides?.bindHost ||
    process.env.CONTEXT_PROXY_BIND_HOST ||
    "127.0.0.1";

  const port =
    overrides?.port ??
    parseInt(process.env.CONTEXT_PROXY_PORT || "4040", 10);

  const allowTargetOverride =
    overrides?.allowTargetOverride ??
    process.env.CONTEXT_PROXY_ALLOW_TARGET_OVERRIDE === "1";

  const strictUrlForwarding =
    overrides?.strictUrlForwarding ??
    process.env.STRICT_URL_FORWARDING === "true";

  const loggerCaptureDir =
    overrides?.loggerCaptureDir ||
    process.env.LOGGER_CAPTURE_DIR ||
    `${process.env.HOME || process.env.USERPROFILE || "~"}/.contextio/captures`;

  const loggerCaptureMaxAgeMs = overrides?.loggerCaptureMaxAgeMs ?? getCaptureCleanupMaxAgeMs();

  const loggerCaptureCleanupIntervalMs = overrides?.loggerCaptureCleanupIntervalMs ?? getCaptureCleanupIntervalMs();

  const loggerCaptureCleanupEnabled = overrides?.loggerCaptureCleanupEnabled ?? getCaptureCleanupEnabled(loggerCaptureMaxAgeMs);

  console.log(`[config] capture cleanup: enabled=${loggerCaptureCleanupEnabled}, maxAgeDays=${loggerCaptureMaxAgeMs / (24 * 60 * 60 * 1000)}, intervalHours=${loggerCaptureCleanupIntervalMs / (60 * 60 * 1000)}`);

  const loggerEncryption: EncryptionAtRestConfig = {
    enabled:
      overrides?.loggerEncryption?.enabled ??
      process.env.CONTEXTIO_LOGGER_ENCRYPTION_ENABLED === "true",
    keyProvider: overrides?.loggerEncryption?.keyProvider ?? "env",
    staticKey: overrides?.loggerEncryption?.staticKey,
    keyEnvVar:
      overrides?.loggerEncryption?.keyEnvVar ??
      "CONTEXTIO_LOGGER_ENCRYPTION_KEY",
    keyLength: overrides?.loggerEncryption?.keyLength ?? 32,
  };

  const oidc = resolveOidcConfig(overrides);

  const publicUrl =
    overrides?.publicUrl ||
    process.env.CONTEXTIO_OIDC_PUBLIC_URL ||
    process.env.CONTEXTIO_PUBLIC_URL || // deprecated alias
    readWebUISettings().oidcPublicUrl ||
    null;

  console.log(
    `[config] publicUrl resolved: overrides.publicUrl=${overrides?.publicUrl}, env.CONTEXTIO_OIDC_PUBLIC_URL=${process.env.CONTEXTIO_OIDC_PUBLIC_URL}, settings.oidcPublicUrl=${readWebUISettings().oidcPublicUrl}, final=${publicUrl}`,
  );

  const upstreams: Upstreams = {
    ...defaultUpstreams,
    ...overrides?.upstreams,
  };

  const normalizedUpstreams: Upstreams = {
    openai: normalizeUpstreamUrl(upstreams.openai),
    anthropic: normalizeUpstreamUrl(upstreams.anthropic),
    chatgpt: normalizeUpstreamUrl(upstreams.chatgpt),
    gemini: normalizeUpstreamUrl(upstreams.gemini),
    geminiCodeAssist: normalizeUpstreamUrl(upstreams.geminiCodeAssist),
    vertex: normalizeUpstreamUrl(upstreams.vertex),
    nvidia: normalizeUpstreamUrl(upstreams.nvidia),
    kilo: normalizeUpstreamUrl(upstreams.kilo),
    openrouter: normalizeUpstreamUrl(upstreams.openrouter),
  };

  const MIN_MAX_REQUESTS = 1;
  const MAX_MAX_REQUESTS = 10000;
  const MIN_WINDOW_MS = 100;
  const MAX_WINDOW_MS = 24 * 60 * 60 * 1000; // 24 hours
  const MIN_BUFFER_CAPACITY = 0;
  const MAX_BUFFER_CAPACITY = 10000;

  const defaultRateLimit: RateLimitConfig = {
    maxRequests: 60,
    windowMs: 60_000,
    bufferCapacity: 10,
  };

  // NVIDIA NIM has stricter upstream limits - use conservative default
  const nvidiaDefaultRateLimit: RateLimitConfig = {
    maxRequests: 20,
    windowMs: 60_000,
    bufferCapacity: 5,
  };

  function parseRateLimitForProvider(
    provider: Provider,
    fileConfig: RateLimitConfig | undefined,
  ): RateLimitConfig {
    const prefix = `CONTEXTIO_RATE_LIMIT_${provider.toUpperCase()}`;
    const settingsRateLimit = readWebUISettings().rateLimiter?.[provider];

    const fallback =
      provider === "nvidia" ? nvidiaDefaultRateLimit : defaultRateLimit;
    const effectiveFileConfig = fileConfig ?? fallback;

    const maxRequestsRaw = process.env[`${prefix}_MAX_REQUESTS`]
      ?? settingsRateLimit?.maxRequests?.toString()
      ?? effectiveFileConfig.maxRequests;
    const windowMsRaw = process.env[`${prefix}_WINDOW_MS`]
      ?? settingsRateLimit?.windowMs?.toString()
      ?? effectiveFileConfig.windowMs;
    const bufferCapacityRaw = process.env[`${prefix}_BUFFER`]
      ?? settingsRateLimit?.bufferCapacity?.toString()
      ?? effectiveFileConfig.bufferCapacity;

    const maxRequests = Number.parseInt(String(maxRequestsRaw), 10);
    const windowMs = Number.parseInt(String(windowMsRaw), 10);
    const bufferCapacity = Number.parseInt(String(bufferCapacityRaw), 10);

    validateRateLimitConfig({ maxRequests, windowMs, bufferCapacity });

    return { maxRequests, windowMs, bufferCapacity };
  }

  function validateRateLimitConfig(config: RateLimitConfig): void {
    if (!Number.isFinite(config.maxRequests) || config.maxRequests < MIN_MAX_REQUESTS || config.maxRequests > MAX_MAX_REQUESTS) {
      throw new Error(
        `Rate limiter maxRequests must be a finite number between ${MIN_MAX_REQUESTS} and ${MAX_MAX_REQUESTS} (got: ${config.maxRequests})`,
      );
    }
    if (!Number.isFinite(config.windowMs) || config.windowMs < MIN_WINDOW_MS || config.windowMs > MAX_WINDOW_MS) {
      throw new Error(
        `Rate limiter windowMs must be a finite number between ${MIN_WINDOW_MS} and ${MAX_WINDOW_MS} (got: ${config.windowMs})`,
      );
    }
    if (!Number.isFinite(config.bufferCapacity) || config.bufferCapacity < MIN_BUFFER_CAPACITY || config.bufferCapacity > MAX_BUFFER_CAPACITY) {
      throw new Error(
        `Rate limiter bufferCapacity must be a finite number between ${MIN_BUFFER_CAPACITY} and ${MAX_BUFFER_CAPACITY} (got: ${config.bufferCapacity})`,
      );
    }
  }

  const rateLimiter: Record<Provider, RateLimitConfig> = {
    openai: parseRateLimitForProvider("openai", providersConfig.openai?.rateLimit),
    anthropic: parseRateLimitForProvider("anthropic", providersConfig.anthropic?.rateLimit),
    chatgpt: parseRateLimitForProvider("chatgpt", providersConfig.chatgpt?.rateLimit),
    gemini: parseRateLimitForProvider("gemini", providersConfig.gemini?.rateLimit),
    vertex: parseRateLimitForProvider("vertex", providersConfig.vertex?.rateLimit),
    nvidia: parseRateLimitForProvider("nvidia", providersConfig.nvidia?.rateLimit),
    openrouter: parseRateLimitForProvider("openrouter", providersConfig.openrouter?.rateLimit),
    kilo: parseRateLimitForProvider("kilo", providersConfig.kilo?.rateLimit),
    unknown: parseRateLimitForProvider("unknown", providersConfig.unknown?.rateLimit),
  };

  function resolveRetryForProvider(
    provider: Provider,
    fileConfig: RetryConfig | undefined,
  ): RetryConfig {
    const prefix = `CONTEXTIO_RETRY_${provider.toUpperCase()}`;
    const effectiveConfig = fileConfig ?? DEFAULT_PROVIDERS_CONFIG[provider].retry;

    const maxRetries = (() => {
      const raw = process.env[`${prefix}_MAX_RETRIES`];
      if (raw === undefined) return effectiveConfig.maxRetries;
      const parsed = Number.parseInt(raw, 10);
      if (!Number.isFinite(parsed) || parsed < 0) {
        throw new Error(`Invalid ${prefix}_MAX_RETRIES="${raw}": must be a non-negative integer`);
      }
      return parsed;
    })();

    const baseDelayMs = (() => {
      const raw = process.env[`${prefix}_BASE_DELAY_MS`];
      if (raw === undefined) return effectiveConfig.baseDelayMs;
      const parsed = Number.parseInt(raw, 10);
      if (!Number.isFinite(parsed) || parsed < 0) {
        throw new Error(`Invalid ${prefix}_BASE_DELAY_MS="${raw}": must be a non-negative integer`);
      }
      return parsed;
    })();

    const maxDelayMs = (() => {
      const raw = process.env[`${prefix}_MAX_DELAY_MS`];
      if (raw === undefined) return effectiveConfig.maxDelayMs;
      const parsed = Number.parseInt(raw, 10);
      if (!Number.isFinite(parsed) || parsed < 0) {
        throw new Error(`Invalid ${prefix}_MAX_DELAY_MS="${raw}": must be a non-negative integer`);
      }
      return parsed;
    })();

    if (baseDelayMs > maxDelayMs) {
      throw new Error(`Retry ${prefix} invalid: baseDelayMs (${baseDelayMs}) must be <= maxDelayMs (${maxDelayMs})`);
    }

    const retryableStatuses = (() => {
      const raw = process.env[`${prefix}_RETRYABLE_STATUSES`];
      if (raw === undefined) return effectiveConfig.retryableStatuses;
      const trimmed = raw.trim();
      if (trimmed === "") return effectiveConfig.retryableStatuses;
      const parsed = trimmed
        .split(",")
        .map((s) => s.trim())
        .filter(Boolean)
        .map((s) => Number.parseInt(s, 10));
      for (const val of parsed) {
        if (!Number.isFinite(val) || val < 100 || val > 599) {
          throw new Error(`Invalid ${prefix}_RETRYABLE_STATUSES="${raw}": statuses must be valid HTTP codes (100-599)`);
        }
      }
      return parsed;
    })();

    const jitterFactor = (() => {
      const raw = process.env[`${prefix}_JITTER_FACTOR`];
      if (raw === undefined) return effectiveConfig.jitterFactor;
      const parsed = Number.parseFloat(raw);
      if (!Number.isFinite(parsed) || parsed < 0 || parsed > 1) {
        throw new Error(`Invalid ${prefix}_JITTER_FACTOR="${raw}": must be between 0 and 1`);
      }
      return parsed;
    })();

    return {
      maxRetries,
      baseDelayMs,
      maxDelayMs,
      retryableStatuses,
      jitterFactor,
    };
  }

  const retry: Record<Provider, RetryConfig> = {
    openai: resolveRetryForProvider("openai", providersConfig.openai?.retry),
    anthropic: resolveRetryForProvider("anthropic", providersConfig.anthropic?.retry),
    chatgpt: resolveRetryForProvider("chatgpt", providersConfig.chatgpt?.retry),
    gemini: resolveRetryForProvider("gemini", providersConfig.gemini?.retry),
    vertex: resolveRetryForProvider("vertex", providersConfig.vertex?.retry),
    nvidia: resolveRetryForProvider("nvidia", providersConfig.nvidia?.retry),
    openrouter: resolveRetryForProvider("openrouter", providersConfig.openrouter?.retry),
    kilo: resolveRetryForProvider("kilo", providersConfig.kilo?.retry),
    unknown: resolveRetryForProvider("unknown", providersConfig.unknown?.retry),
  };

  return {
    upstreams: normalizedUpstreams,
    bindHost,
    port,
    allowTargetOverride,
    strictUrlForwarding,
    loggerCaptureDir,
    loggerCaptureMaxAgeMs,
    loggerCaptureCleanupIntervalMs,
    loggerCaptureCleanupEnabled,
    loggerEncryption,
    oidc,
    publicUrl,
    rateLimiter,
    retry,
    providers: providersConfig,
  };
}
