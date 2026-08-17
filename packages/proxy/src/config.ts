/**
 * Proxy configuration resolution.
 *
 * Merges programmatic overrides with environment variables and applies
 * safe defaults. All upstream URLs, bind address, port, capture retention,
 * and feature flags are resolved here before the proxy starts.
 */

import fs from "node:fs";

import type { EncryptionAtRestConfig, OidcProviderConfig, ProxyConfig, Upstreams, Provider, RateLimitConfig, RetryConfig, ProvidersMap, ProviderConfig, ApiFormat, AuthType } from "@contextio/core";
import { DEFAULT_OIDC_SCOPE, validateRateLimitConfig, validateRetryConfig, KNOWN_API_FORMATS, KNOWN_AUTH_TYPES, KNOWN_PROVIDERS, validateProviderConfig } from "@contextio/core";
import { getAllProvidersFromDb, getSettings } from "@contextio/core/db";

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

/** Get providers file path, checking environment variable at call time for test flexibility. */
function getProvidersFilePath(): string {
  return process.env.PROVIDERS_FILE || "/app/custom-policy/providers.json";
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
  // Streaming retry settings per provider
  streamingRetry?: {
    [provider: string]: {
      enabled?: boolean;
      maxRetries?: number;
      maxBufferSizeMB?: number;
    };
  };
}

/** Cache for web UI settings to avoid repeated database reads. */
let cachedWebUISettings: WebUISettings | null = null;

/** Reset cached web UI settings (for test isolation). */
export function resetWebUISettingsCache(): void {
  cachedWebUISettings = null;
}

/** Read web UI settings from the database (with JSON file fallback for backward compatibility). */
function readWebUISettings(): WebUISettings {
  if (cachedWebUISettings !== null) {
    return cachedWebUISettings;
  }

  // First, try to read from the database
  try {
    const dbSettings = getSettings();
    if (dbSettings) {
      const result = {
        captureCleanupEnabled: dbSettings.captureCleanupEnabled,
        captureCleanupIntervalHours: dbSettings.captureCleanupIntervalHours,
        captureCleanupMaxAgeDays: dbSettings.captureCleanupMaxAgeDays,
        oidcEnabled: dbSettings.oidcEnabled,
        oidcPublicUrl: dbSettings.oidcPublicUrl,
        rateLimiter: dbSettings.rateLimiter,
        streamingRetry: dbSettings.streamingRetry,
      };
      console.log(`[config] read settings from database: ${JSON.stringify(result)}`);
      cachedWebUISettings = result;
      return result;
    }
  } catch (err) {
    console.log(`[config] failed to read settings from database, falling back to JSON file: ${err instanceof Error ? err.message : String(err)}`);
  }

  // Fallback to JSON file for backward compatibility (legacy migrations)
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
        streamingRetry: parsed.streamingRetry,
      };
      console.log(`[config] read settings.json from ${settingsPath}: ${JSON.stringify(result)}`);
      cachedWebUISettings = result;
      return result;
    } catch (err) {
      console.log(`[config] failed to read settings.json at ${settingsPath}: ${err instanceof Error ? err.message : String(err)}`);
    }
  }
  cachedWebUISettings = {};
  return {};
}

/**
 * Load provider configurations from SQLite database.
 *
 * Reads and validates providers from the database. Each provider must have all
 * required fields per the ProviderConfig schema. Invalid providers are skipped.
 * Providers with enabled=false are excluded from the returned map.
 * Falls back to providers.json for backward compatibility if database is empty.
 */
export function readProvidersConfig(filePath = getProvidersFilePath()): ProvidersMap {
  // Try to read from SQLite database first
  try {
    const dbProviders = getAllProvidersFromDb();
    
    // If database has providers, use them
    if (dbProviders.size > 0) {
      const result: ProvidersMap = {} as ProvidersMap;
      let loaded = 0;
      let skipped = 0;
      
      for (const [key, config] of dbProviders) {
        // Validate the provider config
        try {
          validateProviderConfig(config);
        } catch (validationError) {
          skipped++;
          console.warn(`[config] skip db provider[${key}]: validation failed - ${validationError instanceof Error ? validationError.message : String(validationError)}`);
          continue;
        }
        
        if (config.enabled === false) {
          skipped++;
          console.warn(`[config] skip db provider[${key}]: disabled by enabled=false`);
          continue;
        }
        
        result[key as Provider] = config;
        loaded++;
      }
      
      if (loaded > 0) {
        console.log(`[config] read providers from database: ${loaded} loaded, ${skipped} skipped, ${Object.keys(result).length} active`);
        return result;
      }
      console.log(`[config] database has providers but none are valid/enabled, falling back to providers.json`);
    }
  } catch (err) {
    console.log(`[config] failed to read providers from database, falling back to providers.json: ${err instanceof Error ? err.message : String(err)}`);
  }
  
  // Fallback to providers.json for backward compatibility
  return readProvidersConfigFromFile(filePath);
}

/**
 * Load provider configurations from providers.json file (legacy fallback).
 */
function readProvidersConfigFromFile(filePath: string): ProvidersMap {
  try {
    const data = fs.readFileSync(filePath, "utf8");
    const parsed = JSON.parse(data);
    const result: ProvidersMap = {} as ProvidersMap;

    let loaded = 0;
    let skipped = 0;
    const skipReasons: string[] = [];

    // Handle both object format (new) and array format (legacy)
    const entries = Array.isArray(parsed)
      ? parsed.map((item, index) => [String(index), item] as [string, unknown])
      : Object.entries(parsed);

    for (const [key, value] of entries) {
      if (typeof value !== "object" || value === null) {
        skipped++;
        const reason = `providers.json[${key}]: not an object`;
        skipReasons.push(reason);
        console.warn(`[config] skip ${reason}`);
        continue;
      }
      const config = value as Record<string, unknown>;
      const providerId = config.id as string;
      if (providerId !== key && !Array.isArray(parsed)) {
        // For object format, key must match id; for array format, id is the key
        skipped++;
        const reason = `providers.json[${key}]: id mismatch (expected ${key}, got ${providerId})`;
        skipReasons.push(reason);
        console.warn(`[config] skip ${reason}`);
        continue;
      }
      const finalKey = Array.isArray(parsed) ? providerId : key;
      if (typeof config.upstreamUrl !== "string") {
        skipped++;
        const reason = `providers.json[${finalKey}]: missing or non-string upstreamUrl`;
        skipReasons.push(reason);
        console.warn(`[config] skip ${reason}`);
        continue;
      }
      // Validate that the key is a known Provider before casting
      if (!isProvider(finalKey)) {
        skipped++;
        const reason = `providers.json[${finalKey}]: unknown provider`;
        skipReasons.push(reason);
        console.warn(`[config] skip ${reason}`);
        continue;
      }
      // Validate the full provider config using core validation
      try {
        validateProviderConfig(config as unknown as ProviderConfig);
      } catch (validationError) {
        skipped++;
        const reason = `providers.json[${finalKey}]: validation failed - ${validationError instanceof Error ? validationError.message : String(validationError)}`;
        skipReasons.push(reason);
        console.warn(`[config] skip ${reason}`);
        continue;
      }
      if (config.enabled === false) {
        // Disabled providers are intentionally skipped, not an error
        skipped++;
        console.warn(`[config] skip providers.json[${finalKey}]: disabled by enabled=false`);
        continue;
      }
      result[finalKey] = config as unknown as ProviderConfig;
      loaded++;
    }

    // If no providers were loaded, the file is empty or all entries were invalid
    if (loaded === 0) {
      const errorMsg = `No valid providers found in ${filePath}. Ensure providers.json contains valid provider configurations, or set upstream URLs via environment variables (UPSTREAM_<PROVIDER>_URL).`;
      console.error(`[config] ${errorMsg}`);
      throw new Error(errorMsg);
    }

    // If any providers were skipped for reasons other than being disabled, throw an error
    if (skipReasons.length > 0) {
      const errorMsg = `Failed to load ${skipReasons.length} provider(s) from ${filePath}: ${skipReasons.join("; ")}`;
      console.error(`[config] ${errorMsg}`);
      throw new Error(errorMsg);
    }

    // If we migrated from array format, write back the object format
    if (Array.isArray(parsed) && loaded > 0) {
      try {
        fs.writeFileSync(filePath, JSON.stringify(result, null, 2), "utf8");
        console.log(`[config] migrated providers.json from array format to object format`);
      } catch (writeErr) {
        console.warn(`[config] failed to write migrated providers.json: ${writeErr instanceof Error ? writeErr.message : String(writeErr)}`);
      }
    }

    console.log(`[config] read providers.json: ${loaded} providers loaded from file, ${skipped} skipped, ${Object.keys(result).length} active`);
    return result;
  } catch (err) {
    const errMsg = err instanceof Error ? err.message : String(err);
    console.error(`[config] failed to read providers.json at ${filePath}: ${errMsg}.`);
    // If file is missing or unreadable, throw a clear actionable error
    const nodeErr = err as NodeJS.ErrnoException;
    if (nodeErr.code === "ENOENT") {
      throw new Error(`No valid providers found in ${filePath}. Ensure providers.json contains valid provider configurations, or set upstream URLs via environment variables (UPSTREAM_<PROVIDER>_URL).`);
    }
    throw err;
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
  // Plugin enable flags
  plugins: {
    loggerEnabled: boolean;
    redactEnabled: boolean;
    rateLimiterEnabled: boolean;
    retryEnabled: boolean;
  };
}

/** Get the OIDC public URL from environment variables, falling back to null. */
export function getOidcPublicUrl(): string | null {
  // Priority: env vars > fallback > null
  return (
    // Environment variable (highest priority)
    process.env.CONTEXTIO_OIDC_PUBLIC_URL ||
    // Deprecated alias
    process.env.CONTEXTIO_PUBLIC_URL ||
    // No cross-package dependency fallback
    null
  );
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
 * - `CONTEXTIO_RETRY_<PROVIDER>_MAX_STREAM_RETRIES` - Max streaming retry attempts (default: 3)
 * - `CONTEXTIO_RETRY_<PROVIDER>_MAX_RESPONSE_BUFFER_SIZE` - Max streaming buffer in bytes (default: 10485760)
 * - `CONTEXTIO_RETRY_<PROVIDER>_STREAMING_RETRY_ENABLED` - Whether streaming retry is enabled (default: true)
 *
 * Legacy (deprecated) env vars:
 * - `OIDC_ISSUER`, `OIDC_CLIENT_ID`, `OIDC_CLIENT_SECRET`, `OIDC_SESSION_SECRET`, `OIDC_SCOPE`
 *   All must be set together to enable OIDC without CONTEXTIO_OIDC_ENABLED.
 * - `CONTEXTIO_PUBLIC_URL` - Deprecated alias for CONTEXTIO_OIDC_PUBLIC_URL
 */
export function resolveConfig(
  overrides?: ProxyConfig,
): ResolvedProxyConfig {
  const providersConfig = readProvidersConfig(process.env.PROVIDERS_FILE);

  // Build upstreams from providersConfig with env var overrides
  // Priority: env var > providersConfig > (no hardcoded fallbacks)
  const upstreams: Upstreams = {
    openai:
      process.env.UPSTREAM_OPENAI_URL ||
      providersConfig.openai?.upstreamUrl ||
      "",
    anthropic:
      process.env.UPSTREAM_ANTHROPIC_URL ||
      providersConfig.anthropic?.upstreamUrl ||
      "",
    chatgpt:
      process.env.UPSTREAM_CHATGPT_URL ||
      providersConfig.chatgpt?.upstreamUrl ||
      "",
    gemini:
      process.env.UPSTREAM_GEMINI_URL ||
      providersConfig.gemini?.upstreamUrl ||
      "",
    geminiCodeAssist:
      process.env.UPSTREAM_GEMINI_CODE_ASSIST_URL ||
      "",
    vertex:
      process.env.UPSTREAM_VERTEX_URL ||
      providersConfig.vertex?.upstreamUrl ||
      "",
    nvidia:
      process.env.UPSTREAM_NVIDIA_URL ||
      providersConfig.nvidia?.upstreamUrl ||
      "",
    kilo:
      process.env.UPSTREAM_KILO_URL ||
      providersConfig.kilo?.upstreamUrl ||
      "",
    openrouter:
      process.env.UPSTREAM_OPENROUTER_URL ||
      providersConfig.openrouter?.upstreamUrl ||
      "",
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

  // Apply programmatic upstream overrides (highest priority after env vars)
  const upstreamsWithOverrides: Upstreams = {
    ...upstreams,
    ...overrides?.upstreams,
  };

// Helper to convert camelCase to SNAKE_CASE
function toScreamingSnakeCase(str: string): string {
  return str
    .replace(/([a-z])([A-Z])/g, "$1_$2")
    .toUpperCase();
}

// Validate that all required upstreams are non-empty (after overrides applied)
// Only require upstreams for providers that are configured (enabled in providers.json or have env var)
const requiredUpstreams: (keyof Upstreams)[] = [
  "openai", "anthropic", "chatgpt", "gemini", "vertex", "nvidia", "kilo", "openrouter"
];
// geminiCodeAssist is optional - only validate if explicitly configured
for (const upstreamKey of requiredUpstreams) {
  if (!upstreamsWithOverrides[upstreamKey]) {
    const envVarName = `UPSTREAM_${toScreamingSnakeCase(upstreamKey)}_URL`;
    throw new Error(`Missing required upstream URL for provider "${upstreamKey}". Set ${envVarName} environment variable or configure the provider in providers.json`);
  }
  }

  const normalizedUpstreams: Upstreams = {
    openai: normalizeUpstreamUrl(upstreamsWithOverrides.openai),
    anthropic: normalizeUpstreamUrl(upstreamsWithOverrides.anthropic),
    chatgpt: normalizeUpstreamUrl(upstreamsWithOverrides.chatgpt),
    gemini: normalizeUpstreamUrl(upstreamsWithOverrides.gemini),
    geminiCodeAssist: normalizeUpstreamUrl(upstreamsWithOverrides.geminiCodeAssist),
    vertex: normalizeUpstreamUrl(upstreamsWithOverrides.vertex),
    nvidia: normalizeUpstreamUrl(upstreamsWithOverrides.nvidia),
    kilo: normalizeUpstreamUrl(upstreamsWithOverrides.kilo),
    openrouter: normalizeUpstreamUrl(upstreamsWithOverrides.openrouter),
  };

  const MIN_MAX_REQUESTS = 1;
  const MAX_MAX_REQUESTS = 10000;
  const MIN_WINDOW_MS = 100;
  const MAX_WINDOW_MS = 24 * 60 * 60 * 1000; // 24 hours
  const MIN_BUFFER_CAPACITY = 0;
  const MAX_BUFFER_CAPACITY = 10000;

  function parseRateLimitForProvider(
    provider: Provider,
    fileConfig: RateLimitConfig | undefined,
  ): RateLimitConfig {
    const prefix = `CONTEXTIO_RATE_LIMIT_${provider.toUpperCase()}`;
    const settingsRateLimit = readWebUISettings().rateLimiter?.[provider];

    // Use file config as base, no hardcoded fallbacks
    // If fileConfig is missing, env vars or settings must provide all required fields
    const effectiveFileConfig = fileConfig;

    const maxRequestsRaw = process.env[`${prefix}_MAX_REQUESTS`]
      ?? settingsRateLimit?.maxRequests?.toString()
      ?? effectiveFileConfig?.maxRequests?.toString();
    const windowMsRaw = process.env[`${prefix}_WINDOW_MS`]
      ?? settingsRateLimit?.windowMs?.toString()
      ?? effectiveFileConfig?.windowMs?.toString();
    const bufferCapacityRaw = process.env[`${prefix}_BUFFER`]
      ?? settingsRateLimit?.bufferCapacity?.toString()
      ?? effectiveFileConfig?.bufferCapacity?.toString();

    // For optional providers (geminiCodeAssist), provide sensible defaults if no config found
    const isOptionalProvider = provider === "geminiCodeAssist";
    const maxRequests = maxRequestsRaw !== undefined
      ? Number.parseInt(String(maxRequestsRaw), 10)
      : (isOptionalProvider ? 60 : (() => { throw new Error(`Rate limit config for provider "${provider}" missing maxRequests (no env var ${prefix}_MAX_REQUESTS, no settings, and no file config)`); })());
    const windowMs = windowMsRaw !== undefined
      ? Number.parseInt(String(windowMsRaw), 10)
      : (isOptionalProvider ? 60000 : (() => { throw new Error(`Rate limit config for provider "${provider}" missing windowMs (no env var ${prefix}_WINDOW_MS, no settings, and no file config)`); })());
    const bufferCapacity = bufferCapacityRaw !== undefined
      ? Number.parseInt(String(bufferCapacityRaw), 10)
      : (isOptionalProvider ? 10 : (() => { throw new Error(`Rate limit config for provider "${provider}" missing bufferCapacity (no env var ${prefix}_BUFFER, no settings, and no file config)`); })());

    if (!Number.isFinite(maxRequests) || !Number.isFinite(windowMs) || !Number.isFinite(bufferCapacity)) {
      throw new Error(`Rate limit config for provider "${provider}" contains non-numeric values`);
    }

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
    geminiCodeAssist: parseRateLimitForProvider("geminiCodeAssist", providersConfig.geminiCodeAssist?.rateLimit),
    vertex: parseRateLimitForProvider("vertex", providersConfig.vertex?.rateLimit),
    nvidia: parseRateLimitForProvider("nvidia", providersConfig.nvidia?.rateLimit),
    openrouter: parseRateLimitForProvider("openrouter", providersConfig.openrouter?.rateLimit),
    kilo: parseRateLimitForProvider("kilo", providersConfig.kilo?.rateLimit),
  };

  function resolveRetryForProvider(
    provider: Provider,
    fileConfig: RetryConfig | undefined,
  ): RetryConfig {
    const prefix = `CONTEXTIO_RETRY_${provider.toUpperCase()}`;
    // Use file config as base, env vars override, no hardcoded fallbacks
    // If fileConfig is missing, env vars must provide all required fields
    const isOptionalProvider = provider === "geminiCodeAssist";

    const maxRetries = (() => {
      const raw = process.env[`${prefix}_MAX_RETRIES`];
      if (raw === undefined) {
        if (!fileConfig) {
          if (isOptionalProvider) return 3;
          throw new Error(`Retry config for provider "${provider}" missing maxRetries (no env var ${prefix}_MAX_RETRIES and no file config)`);
        }
        return fileConfig.maxRetries;
      }
      const parsed = Number.parseInt(raw, 10);
      if (!Number.isFinite(parsed) || parsed < 0) {
        throw new Error(`Invalid ${prefix}_MAX_RETRIES="${raw}": must be a non-negative integer`);
      }
      return parsed;
    })();

    const baseDelayMs = (() => {
      const raw = process.env[`${prefix}_BASE_DELAY_MS`];
      if (raw === undefined) {
        if (!fileConfig) {
          if (isOptionalProvider) return 1000;
          throw new Error(`Retry config for provider "${provider}" missing baseDelayMs (no env var ${prefix}_BASE_DELAY_MS and no file config)`);
        }
        return fileConfig.baseDelayMs;
      }
      const parsed = Number.parseInt(raw, 10);
      if (!Number.isFinite(parsed) || parsed < 0) {
        throw new Error(`Invalid ${prefix}_BASE_DELAY_MS="${raw}": must be a non-negative integer`);
      }
      return parsed;
    })();

    const maxDelayMs = (() => {
      const raw = process.env[`${prefix}_MAX_DELAY_MS`];
      if (raw === undefined) {
        if (!fileConfig) {
          if (isOptionalProvider) return 30000;
          throw new Error(`Retry config for provider "${provider}" missing maxDelayMs (no env var ${prefix}_MAX_DELAY_MS and no file config)`);
        }
        return fileConfig.maxDelayMs;
      }
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
      if (raw === undefined) {
        if (!fileConfig) {
          if (isOptionalProvider) return [429, 500, 502, 503, 504];
          throw new Error(`Retry config for provider "${provider}" missing retryableStatuses (no env var ${prefix}_RETRYABLE_STATUSES and no file config)`);
        }
        return fileConfig.retryableStatuses;
      }
      const trimmed = raw.trim();
      if (trimmed === "") {
        if (!fileConfig) {
          if (isOptionalProvider) return [429, 500, 502, 503, 504];
          throw new Error(`Retry config for provider "${provider}" missing retryableStatuses (empty env var ${prefix}_RETRYABLE_STATUSES and no file config)`);
        }
        return fileConfig.retryableStatuses;
      }
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
      if (raw === undefined) {
        if (!fileConfig) {
          if (isOptionalProvider) return 0.2;
          throw new Error(`Retry config for provider "${provider}" missing jitterFactor (no env var ${prefix}_JITTER_FACTOR and no file config)`);
        }
        return fileConfig.jitterFactor;
      }
      const parsed = Number.parseFloat(raw);
      if (!Number.isFinite(parsed) || parsed < 0 || parsed > 1) {
        throw new Error(`Invalid ${prefix}_JITTER_FACTOR="${raw}": must be between 0 and 1`);
      }
      return parsed;
    })();

    const maxStreamRetries = (() => {
      const raw = process.env[`${prefix}_MAX_STREAM_RETRIES`];
      const settingsStreamRetry = readWebUISettings().streamingRetry?.[provider];
      if (raw !== undefined) {
        const parsed = Number.parseInt(raw, 10);
        if (!Number.isFinite(parsed) || parsed < 0 || parsed > 10) {
          throw new Error(`Invalid ${prefix}_MAX_STREAM_RETRIES="${raw}": must be an integer between 0 and 10`);
        }
        return parsed;
      }
      if (settingsStreamRetry?.maxRetries !== undefined) {
        const parsed = Number.isInteger(settingsStreamRetry.maxRetries) && settingsStreamRetry.maxRetries >= 0 && settingsStreamRetry.maxRetries <= 10
          ? settingsStreamRetry.maxRetries
          : 3;
        return parsed;
      }
      if (!fileConfig) {
        if (isOptionalProvider) return 3;
        throw new Error(`Retry config for provider "${provider}" missing maxStreamRetries (no env var ${prefix}_MAX_STREAM_RETRIES, no settings, and no file config)`);
      }
      return fileConfig.maxStreamRetries ?? 3;
    })();

    const maxResponseBufferSize = (() => {
      const raw = process.env[`${prefix}_MAX_RESPONSE_BUFFER_SIZE`];
      const settingsStreamRetry = readWebUISettings().streamingRetry?.[provider];
      if (raw !== undefined) {
        const parsed = Number.parseInt(raw, 10);
        if (!Number.isFinite(parsed) || parsed <= 0 || parsed > 100 * 1024 * 1024) {
          throw new Error(`Invalid ${prefix}_MAX_RESPONSE_BUFFER_SIZE="${raw}": must be a positive integer up to 100 MB (104857600 bytes)`);
        }
        return parsed;
      }
      if (settingsStreamRetry?.maxBufferSizeMB !== undefined) {
        const mb = Number.isInteger(settingsStreamRetry.maxBufferSizeMB) && settingsStreamRetry.maxBufferSizeMB >= 1 && settingsStreamRetry.maxBufferSizeMB <= 100
          ? settingsStreamRetry.maxBufferSizeMB
          : 10;
        return mb * 1024 * 1024;
      }
      if (!fileConfig) {
        if (isOptionalProvider) return 10 * 1024 * 1024; // 10 MB default
        throw new Error(`Retry config for provider "${provider}" missing maxResponseBufferSize (no env var ${prefix}_MAX_RESPONSE_BUFFER_SIZE, no settings, and no file config)`);
      }
      return fileConfig.maxResponseBufferSize ?? (10 * 1024 * 1024);
    })();

    const enabled = (() => {
      const raw = process.env[`${prefix}_STREAMING_RETRY_ENABLED`];
      const settingsStreamRetry = readWebUISettings().streamingRetry?.[provider];
      if (raw !== undefined) {
        return raw === "true";
      }
      if (settingsStreamRetry?.enabled !== undefined) {
        return settingsStreamRetry.enabled;
      }
      if (!fileConfig) {
        if (isOptionalProvider) return true;
        // Default to true if not specified
        return true;
      }
      return fileConfig.enabled ?? true;
    })();

    return {
      maxRetries,
      baseDelayMs,
      maxDelayMs,
      retryableStatuses,
      jitterFactor,
      maxStreamRetries,
      maxResponseBufferSize,
      enabled,
    };
  }

  const retry: Record<Provider, RetryConfig> = {
    openai: resolveRetryForProvider("openai", providersConfig.openai?.retry),
    anthropic: resolveRetryForProvider("anthropic", providersConfig.anthropic?.retry),
    chatgpt: resolveRetryForProvider("chatgpt", providersConfig.chatgpt?.retry),
    gemini: resolveRetryForProvider("gemini", providersConfig.gemini?.retry),
    geminiCodeAssist: resolveRetryForProvider("geminiCodeAssist", providersConfig.geminiCodeAssist?.retry),
    vertex: resolveRetryForProvider("vertex", providersConfig.vertex?.retry),
    nvidia: resolveRetryForProvider("nvidia", providersConfig.nvidia?.retry),
    openrouter: resolveRetryForProvider("openrouter", providersConfig.openrouter?.retry),
    kilo: resolveRetryForProvider("kilo", providersConfig.kilo?.retry),
  };

  // Plugin enable flags (default to true)
  const loggerEnabled = process.env.CONTEXTIO_ENABLE_LOGGER !== "false";
  const redactEnabled = process.env.CONTEXTIO_ENABLE_REDACT !== "false";
  const rateLimiterEnabled = process.env.CONTEXTIO_ENABLE_RATE_LIMITER !== "false";
  const retryEnabled = rateLimiterEnabled; // Retry is enabled when rate limiter is enabled

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
    plugins: {
      loggerEnabled,
      redactEnabled,
      rateLimiterEnabled,
      retryEnabled,
    },
  };
}
