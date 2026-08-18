import type { Provider } from "@contextio/core";

export type { Provider };

export interface RateLimitConfig {
  /** Maximum requests allowed within the time window. */
  maxRequests: number;
  /** Time window in milliseconds. */
  windowMs: number;
  /** Token bucket capacity for burst handling. */
  bufferCapacity: number;
}

export interface StreamingRetryConfig {
  /** Whether streaming retry is enabled. */
  enabled: boolean;
  /** Maximum retry attempts for streaming responses. */
  maxRetries: number;
  /** Maximum buffer size in MB for streaming response buffering. */
  maxBufferSizeMB: number;
}

export interface Settings {
  logDir: string;
  maxSessions: number;
  redactPreset: "secrets" | "pii" | "strict";
  redactReversible: boolean;
  redactPolicyFile: string;
  redactPolicyEnabled: boolean;
  redactPathsOnly: string[];
  redactPathsSkip: string[];
  /** List of redaction rule names to disable (e.g., ["url", "organization", "person"]) */
  redactDisabledRules: string[];
  encryptionAtRest: boolean;
  captureCleanupEnabled: boolean;
  captureCleanupIntervalHours: number;
  captureCleanupMaxAgeDays: number;
  theme:
    | "light"
    | "dark"
    | "system"
    | "high-contrast"
    | "material-light"
    | "material-dark"
    | "solarized-light"
    | "solarized-dark"
    | "dracula"
    | "nord"
    | "github-light"
    | "github-dark"
    | "one-dark"
    | "monokai";
  // OIDC Authentication settings
  oidcEnabled: boolean;
  oidcPublicUrl: string;
  // Display settings
  showPageLoadTime: boolean;
  // Detector settings
  detectorMode: "rules" | "llm" | "hybrid" | "auto";
  detectorModelName: string;
  detectorThreshold: number;
  // Rate limiter settings per provider
  rateLimiter: Record<Provider, RateLimitConfig>;
  // Streaming retry settings per provider
  streamingRetry: Record<Provider, StreamingRetryConfig>;
  // Feature flags
  enableLogger: boolean;
  enableRedact: boolean;
  enableRateLimiter: boolean;
  logTraffic: boolean;
  // Advanced rate limiter cache configuration
  rateLimiterMaxEntries: number;
  rateLimiterCleanupIntervalMs: number;
  rateLimiterEntryTtlMs: number;
  // Advanced streaming retry cache configuration
  retryMaxEntries: number;
  retryEntryTtlMs: number;
  retryCleanupIntervalMs: number;
  retryMaxBufferSize: number;
  retryMaxStreamRetries: number;
  // Proxy configuration
  proxyBindHost: string;
  proxyPort: number;
  proxyAllowTargetOverride: boolean;
  strictUrlForwarding: boolean;
  upstreamOpenAiUrl: string;
  upstreamAnthropicUrl: string;
  upstreamChatGptUrl: string;
  upstreamGeminiUrl: string;
  upstreamVertexUrl: string;
  upstreamNvidiaUrl: string;
  upstreamOpenRouterUrl: string;
  upstreamKiloUrl: string;
  upstreamGeminiCodeAssistUrl: string;
}

export type SettingSource =
  "settings-file" | "environment-variable" | "default";

export interface SettingMeta {
  source: SettingSource;
  envVar: string | null;
  // true = changes take effect immediately without a restart
  dynamic: boolean;
}

// Maps each persisted setting to its environment-variable override (if any) and
// whether changing it is applied dynamically or requires a restart.
export const SETTING_ENV_MAP: Record<
  keyof Settings,
  { envVar: string; dynamic: boolean }
> = {
  logDir: { envVar: "LOGGER_CAPTURE_DIR", dynamic: false },
  maxSessions: { envVar: "LOGGER_MAX_SESSIONS", dynamic: false },
  redactPreset: { envVar: "REDACT_PRESET", dynamic: true },
  redactReversible: { envVar: "REDACT_REVERSIBLE", dynamic: true },
  redactPolicyFile: { envVar: "REDACT_POLICY_FILE", dynamic: true },
  redactPolicyEnabled: { envVar: "REDACT_POLICY_ENABLED", dynamic: true },
  redactPathsOnly: { envVar: "REDACT_PATHS_ONLY", dynamic: true },
  redactPathsSkip: { envVar: "REDACT_PATHS_SKIP", dynamic: true },
  /** List of redaction rule names to disable (e.g., ["url", "organization", "person"]) */
  redactDisabledRules: { envVar: "REDACT_DISABLED_RULES", dynamic: true },
  encryptionAtRest: {
    envVar: "CONTEXTIO_LOGGER_ENCRYPTION_ENABLED",
    dynamic: false,
  },
  captureCleanupEnabled: {
    envVar: "LOGGER_CAPTURE_CLEANUP_ENABLED",
    dynamic: false,
  },
  captureCleanupIntervalHours: {
    envVar: "LOGGER_CAPTURE_CLEANUP_INTERVAL",
    dynamic: false,
  },
  captureCleanupMaxAgeDays: {
    envVar: "LOGGER_CAPTURE_MAX_AGE",
    dynamic: false,
  },
  theme: {
    envVar: "CONTEXTIO_THEME",
    dynamic: true,
  },
  oidcEnabled: {
    envVar: "CONTEXTIO_OIDC_ENABLED",
    dynamic: false,
  },
  oidcPublicUrl: {
    envVar: "CONTEXTIO_OIDC_PUBLIC_URL",
    dynamic: false,
  },
  showPageLoadTime: {
    envVar: "", // No env var override - controlled via settings UI only
    dynamic: true,
  },
  detectorMode: {
    envVar: "REDACT_DETECTOR_MODE",
    dynamic: true,
  },
  detectorModelName: {
    envVar: "REDACT_DETECTOR_MODEL_NAME",
    dynamic: true,
  },
  detectorThreshold: {
    envVar: "REDACT_DETECTOR_THRESHOLD",
    dynamic: true,
  },
  rateLimiter: {
    envVar: "", // No direct env var - configured via settings file/UI with per-provider keys
    dynamic: false,
  },
  streamingRetry: {
    envVar: "", // No direct env var - configured via settings file/UI with per-provider keys
    dynamic: false,
  },
  // Feature flags
  enableLogger: { envVar: "CONTEXTIO_ENABLE_LOGGER", dynamic: false },
  enableRedact: { envVar: "CONTEXTIO_ENABLE_REDACT", dynamic: false },
  enableRateLimiter: { envVar: "CONTEXTIO_ENABLE_RATE_LIMITER", dynamic: false },
  logTraffic: { envVar: "LOG_TRAFFIC", dynamic: false },
  // Advanced rate limiter cache configuration
  rateLimiterMaxEntries: { envVar: "CONTEXTIO_RATE_LIMIT_MAX_ENTRIES", dynamic: false },
  rateLimiterCleanupIntervalMs: { envVar: "CONTEXTIO_RATE_LIMIT_CLEANUP_INTERVAL_MS", dynamic: false },
  rateLimiterEntryTtlMs: { envVar: "CONTEXTIO_RATE_LIMIT_ENTRY_TTL_MS", dynamic: false },
  // Advanced streaming retry cache configuration
  retryMaxEntries: { envVar: "CONTEXTIO_RETRY_MAX_ENTRIES", dynamic: false },
  retryEntryTtlMs: { envVar: "CONTEXTIO_RETRY_ENTRY_TTL_MS", dynamic: false },
  retryCleanupIntervalMs: { envVar: "CONTEXTIO_RETRY_CLEANUP_INTERVAL_MS", dynamic: false },
  retryMaxBufferSize: { envVar: "CONTEXTIO_RETRY_MAX_BUFFER_SIZE", dynamic: false },
  retryMaxStreamRetries: { envVar: "CONTEXTIO_RETRY_MAX_STREAM_RETRIES", dynamic: false },
  // Proxy configuration
  proxyBindHost: { envVar: "CONTEXT_PROXY_BIND_HOST", dynamic: false },
  proxyPort: { envVar: "CONTEXT_PROXY_PORT", dynamic: false },
  proxyAllowTargetOverride: { envVar: "CONTEXT_PROXY_ALLOW_TARGET_OVERRIDE", dynamic: false },
  strictUrlForwarding: { envVar: "STRICT_URL_FORWARDING", dynamic: false },
  upstreamOpenAiUrl: { envVar: "UPSTREAM_OPENAI_URL", dynamic: false },
  upstreamAnthropicUrl: { envVar: "UPSTREAM_ANTHROPIC_URL", dynamic: false },
  upstreamChatGptUrl: { envVar: "UPSTREAM_CHATGPT_URL", dynamic: false },
  upstreamGeminiUrl: { envVar: "UPSTREAM_GEMINI_URL", dynamic: false },
  upstreamVertexUrl: { envVar: "UPSTREAM_VERTEX_URL", dynamic: false },
  upstreamNvidiaUrl: { envVar: "UPSTREAM_NVIDIA_URL", dynamic: false },
  upstreamOpenRouterUrl: { envVar: "UPSTREAM_OPENROUTER_URL", dynamic: false },
  upstreamKiloUrl: { envVar: "UPSTREAM_KILO_URL", dynamic: false },
  upstreamGeminiCodeAssistUrl: { envVar: "UPSTREAM_GEMINI_CODE_ASSIST_URL", dynamic: false },
};

/**
 * Override settings values with corresponding environment variables where defined.
 * Returns a new Settings object with env var values applied, together with the set
 * of keys whose env values were successfully applied. Treats numeric env vars as
 * their raw unit (hours / days) to stay consistent with the proxy config; string
 * and boolean fields are passed through directly.
 */
function strictInteger(raw: string): boolean {
  return /^\d+$/.test(raw);
}

export function applyEnvOverrides(settings: Settings): {
  settings: Settings;
  appliedKeys: Set<keyof Settings>;
} {
  const override: Partial<Settings> = {};
  const appliedKeys = new Set<keyof Settings>();
  (
    Object.entries(SETTING_ENV_MAP) as [
      keyof Settings,
      { envVar: string; dynamic: boolean },
    ][]
  ).forEach(([key, { envVar }]) => {
    const raw = process.env[envVar];
    if (raw === undefined) return;
    let accepted = false;
    switch (key) {
      case "logDir":
        override.logDir = raw;
        accepted = true;
        break;
      case "maxSessions": {
        const n = strictInteger(raw) ? Number.parseInt(raw, 10) : NaN;
        if (Number.isFinite(n) && n >= 0 && n <= 10000) {
          override.maxSessions = n;
          accepted = true;
        }
        break;
      }
      case "redactPreset":
        if (["secrets", "pii", "strict"].includes(raw)) {
          override.redactPreset = raw as "secrets" | "pii" | "strict";
          accepted = true;
        }
        break;
  case "redactReversible":
    if (raw === "true" || raw === "false") {
      override.redactReversible = raw === "true";
      accepted = true;
    }
    break;
  case "redactPolicyFile":
    override.redactPolicyFile = raw;
    accepted = true;
    break;
  case "redactPolicyEnabled":
    if (raw === "true" || raw === "false") {
      override.redactPolicyEnabled = raw === "true";
      accepted = true;
    }
    break;
  case "redactPathsOnly":
    try {
      override.redactPathsOnly = JSON.parse(raw);
      accepted = true;
    } catch {
      // Invalid JSON, ignore
    }
    break;
  case "redactPathsSkip":
    try {
      override.redactPathsSkip = JSON.parse(raw);
      accepted = true;
    } catch {
      // Invalid JSON, ignore
    }
    break;
  case "redactDisabledRules":
    try {
      override.redactDisabledRules = JSON.parse(raw);
      accepted = true;
    } catch {
      // Invalid JSON, ignore
    }
    break;
  case "encryptionAtRest":
        if (raw === "true" || raw === "false") {
          override.encryptionAtRest = raw === "true";
          accepted = true;
        }
        break;
      case "captureCleanupEnabled":
        if (raw === "true" || raw === "false") {
          override.captureCleanupEnabled = raw === "true";
          accepted = true;
        }
        break;
      case "captureCleanupIntervalHours": {
        const n = strictInteger(raw) ? Number.parseInt(raw, 10) : NaN;
        if (Number.isFinite(n) && n >= 1 && n <= 168) {
          override.captureCleanupIntervalHours = n;
          accepted = true;
        }
        break;
      }
      case "captureCleanupMaxAgeDays": {
        const n = strictInteger(raw) ? Number.parseInt(raw, 10) : NaN;
        if (Number.isFinite(n) && n >= 1 && n <= 365) {
          override.captureCleanupMaxAgeDays = n;
          accepted = true;
        }
        break;
      }
      case "theme":
        if (
          [
            "light",
            "dark",
            "system",
            "high-contrast",
            "material-light",
            "material-dark",
            "solarized-light",
            "solarized-dark",
            "dracula",
            "nord",
            "github-light",
            "github-dark",
            "one-dark",
            "monokai",
          ].includes(raw)
        ) {
          override.theme = raw as
            | "light"
            | "dark"
            | "system"
            | "high-contrast"
            | "material-light"
            | "material-dark"
            | "solarized-light"
            | "solarized-dark"
            | "dracula"
            | "nord"
            | "github-light"
            | "github-dark"
            | "one-dark"
            | "monokai";
          accepted = true;
        }
        break;
      case "oidcEnabled":
        if (raw === "true" || raw === "false") {
          override.oidcEnabled = raw === "true";
          accepted = true;
        }
        break;
      case "oidcPublicUrl":
        override.oidcPublicUrl = raw;
        accepted = true;
        break;
      case "detectorMode":
        if (["rules", "llm", "hybrid", "auto"].includes(raw)) {
          override.detectorMode = raw as "rules" | "llm" | "hybrid" | "auto";
          accepted = true;
        }
        break;
      case "detectorModelName":
        override.detectorModelName = raw;
        accepted = true;
        break;
      case "detectorThreshold": {
        const n = parseFloat(raw);
        if (!isNaN(n) && n >= 0 && n <= 1) {
          override.detectorThreshold = n;
          accepted = true;
        }
        break;
      }
      // Feature flags
      case "enableLogger":
        if (raw === "true" || raw === "false") {
          override.enableLogger = raw === "true";
          accepted = true;
        }
        break;
      case "enableRedact":
        if (raw === "true" || raw === "false") {
          override.enableRedact = raw === "true";
          accepted = true;
        }
        break;
      case "enableRateLimiter":
        if (raw === "true" || raw === "false") {
          override.enableRateLimiter = raw === "true";
          accepted = true;
        }
        break;
      case "logTraffic":
        if (raw === "true" || raw === "false") {
          override.logTraffic = raw === "true";
          accepted = true;
        }
        break;
      // Advanced rate limiter cache configuration
      case "rateLimiterMaxEntries": {
        const n = strictInteger(raw) ? Number.parseInt(raw, 10) : NaN;
        if (Number.isFinite(n) && n >= 100 && n <= 100000) {
          override.rateLimiterMaxEntries = n;
          accepted = true;
        }
        break;
      }
      case "rateLimiterCleanupIntervalMs": {
        const n = strictInteger(raw) ? Number.parseInt(raw, 10) : NaN;
        if (Number.isFinite(n) && n >= 1000 && n <= 3600000) {
          override.rateLimiterCleanupIntervalMs = n;
          accepted = true;
        }
        break;
      }
      case "rateLimiterEntryTtlMs": {
        const n = strictInteger(raw) ? Number.parseInt(raw, 10) : NaN;
        if (Number.isFinite(n) && n >= 1000 && n <= 86400000) {
          override.rateLimiterEntryTtlMs = n;
          accepted = true;
        }
        break;
      }
      // Advanced streaming retry cache configuration
      case "retryMaxEntries": {
        const n = strictInteger(raw) ? Number.parseInt(raw, 10) : NaN;
        if (Number.isFinite(n) && n >= 100 && n <= 100000) {
          override.retryMaxEntries = n;
          accepted = true;
        }
        break;
      }
      case "retryEntryTtlMs": {
        const n = strictInteger(raw) ? Number.parseInt(raw, 10) : NaN;
        if (Number.isFinite(n) && n >= 1000 && n <= 86400000) {
          override.retryEntryTtlMs = n;
          accepted = true;
        }
        break;
      }
      case "retryCleanupIntervalMs": {
        const n = strictInteger(raw) ? Number.parseInt(raw, 10) : NaN;
        if (Number.isFinite(n) && n >= 1000 && n <= 3600000) {
          override.retryCleanupIntervalMs = n;
          accepted = true;
        }
        break;
      }
      case "retryMaxBufferSize": {
        const n = strictInteger(raw) ? Number.parseInt(raw, 10) : NaN;
        if (Number.isFinite(n) && n >= 102400 && n <= 104857600) {
          override.retryMaxBufferSize = n;
          accepted = true;
        }
        break;
      }
      case "retryMaxStreamRetries": {
        const n = strictInteger(raw) ? Number.parseInt(raw, 10) : NaN;
        if (Number.isFinite(n) && n >= 0 && n <= 10) {
          override.retryMaxStreamRetries = n;
          accepted = true;
        }
        break;
      }
      // Proxy configuration
      case "proxyBindHost":
        override.proxyBindHost = raw;
        accepted = true;
        break;
      case "proxyPort": {
        const n = strictInteger(raw) ? Number.parseInt(raw, 10) : NaN;
        if (Number.isFinite(n) && n >= 1 && n <= 65535) {
          override.proxyPort = n;
          accepted = true;
        }
        break;
      }
      case "proxyAllowTargetOverride":
        if (raw === "true" || raw === "false") {
          override.proxyAllowTargetOverride = raw === "true";
          accepted = true;
        }
        break;
      case "strictUrlForwarding":
        if (raw === "true" || raw === "false") {
          override.strictUrlForwarding = raw === "true";
          accepted = true;
        }
        break;
      case "upstreamOpenRouterUrl":
        override.upstreamOpenRouterUrl = raw;
        accepted = true;
        break;
      case "upstreamOpenAiUrl":
        override.upstreamOpenAiUrl = raw;
        accepted = true;
        break;
      case "upstreamAnthropicUrl":
        override.upstreamAnthropicUrl = raw;
        accepted = true;
        break;
      case "upstreamChatGptUrl":
        override.upstreamChatGptUrl = raw;
        accepted = true;
        break;
      case "upstreamGeminiUrl":
        override.upstreamGeminiUrl = raw;
        accepted = true;
        break;
      case "upstreamVertexUrl":
        override.upstreamVertexUrl = raw;
        accepted = true;
        break;
      case "upstreamNvidiaUrl":
        override.upstreamNvidiaUrl = raw;
        accepted = true;
        break;
      case "upstreamKiloUrl":
        override.upstreamKiloUrl = raw;
        accepted = true;
        break;
      case "upstreamGeminiCodeAssistUrl":
        override.upstreamGeminiCodeAssistUrl = raw;
        accepted = true;
        break;
      default:
        break;
    }
    if (accepted) appliedKeys.add(key);
  });
  return { settings: { ...settings, ...override }, appliedKeys };
}

// Computes per-setting metadata: where the active value comes from, which env
// var overrides it, and whether it is applied dynamically.
export function getSettingMetadata(
  settings: Settings,
  appliedEnvKeys: Set<keyof Settings>,
): Record<keyof Settings, SettingMeta> {
  const meta = {} as Record<keyof Settings, SettingMeta>;
  (Object.keys(SETTING_ENV_MAP) as (keyof Settings)[]).forEach((key) => {
    const { envVar, dynamic } = SETTING_ENV_MAP[key];
    const effective = appliedEnvKeys.has(key);
    let source: SettingSource;
    if (effective) {
      source = "environment-variable";
    } else if (
      JSON.stringify(settings[key]) !== JSON.stringify(DEFAULT_SETTINGS[key])
    ) {
      source = "settings-file";
    } else {
      source = "default";
    }
    meta[key] = { source, envVar: effective ? envVar : null, dynamic };
  });
  return meta;
}

export const DEFAULT_SETTINGS: Settings = {
  logDir: "",
  maxSessions: 0,
  redactPreset: "pii",
  redactReversible: false,
  redactPolicyFile: "",
  redactPolicyEnabled: true,
  redactPathsOnly: ["messages[*].content"],
  redactPathsSkip: [
    "tools",
    "tool_calls",
    "toolChoice",
    "tool_choice",
    "functions",
    "function_call",
    "messages[*].tool_calls[*].id",
    "messages[*].tool_calls[*].function.name",
    "messages[*].tool_calls[*].function.arguments",
    "messages[*].tools[*].id",
    "messages[*].tools[*].function.name",
    "messages[*].tools[*].function.arguments",
    "messages[*].function_call.id",
    "messages[*].function_call.name",
    "messages[*].function_call.arguments",
    "tool_calls[*].id",
    "tool_calls[*].function.name",
    "tool_calls[*].function.arguments",
    "tools[*].id",
    "tools[*].function.name",
    "tools[*].function.arguments",
    "function_call.id",
    "function_call.name",
    "function_call.arguments",
    "messages[*].content[*].id",
    "messages[*].content[*].name",
    "messages[*].content[*].input",
    "messages[*].content[*].tool_use_id",
    "messages[*].content[*].content",
    "messages[*].content[*].thinking",
    "messages[*].content[*].signature",
    "messages[*].content[*].type",
    "content[*].id",
    "content[*].name",
    "content[*].input",
    "content[*].tool_use_id",
    "content[*].content",
    "content[*].thinking",
    "content[*].signature",
    "content[*].type",
  ],
  /** List of redaction rule names to disable (e.g., ["url", "organization", "person"]) */
  redactDisabledRules: [],
  encryptionAtRest: false,
  captureCleanupEnabled: true,
  captureCleanupIntervalHours: 24,
  captureCleanupMaxAgeDays: 30,
  theme: "system",
  oidcEnabled: false,
  oidcPublicUrl: "",
  showPageLoadTime: false,
  detectorMode: "rules",
  detectorModelName: "Xenova/bert-base-NER",
  detectorThreshold: 0.5,
  rateLimiter: {
    anthropic: { maxRequests: 60, windowMs: 60000, bufferCapacity: 10 },
    openai: { maxRequests: 60, windowMs: 60000, bufferCapacity: 10 },
    chatgpt: { maxRequests: 60, windowMs: 60000, bufferCapacity: 10 },
    gemini: { maxRequests: 60, windowMs: 60000, bufferCapacity: 10 },
    geminiCodeAssist: { maxRequests: 60, windowMs: 60000, bufferCapacity: 10 },
    vertex: { maxRequests: 60, windowMs: 60000, bufferCapacity: 10 },
    nvidia: { maxRequests: 60, windowMs: 60000, bufferCapacity: 10 },
    openrouter: { maxRequests: 60, windowMs: 60000, bufferCapacity: 10 },
    kilo: { maxRequests: 60, windowMs: 60000, bufferCapacity: 10 },
  },
  streamingRetry: {
    anthropic: { enabled: true, maxRetries: 3, maxBufferSizeMB: 10 },
    openai: { enabled: true, maxRetries: 3, maxBufferSizeMB: 10 },
    chatgpt: { enabled: true, maxRetries: 3, maxBufferSizeMB: 10 },
    gemini: { enabled: true, maxRetries: 3, maxBufferSizeMB: 10 },
    geminiCodeAssist: { enabled: true, maxRetries: 3, maxBufferSizeMB: 10 },
    vertex: { enabled: true, maxRetries: 3, maxBufferSizeMB: 10 },
    nvidia: { enabled: true, maxRetries: 3, maxBufferSizeMB: 10 },
    openrouter: { enabled: true, maxRetries: 3, maxBufferSizeMB: 10 },
    kilo: { enabled: true, maxRetries: 3, maxBufferSizeMB: 10 },
  },
  // Feature flags
  enableLogger: true,
  enableRedact: true,
  enableRateLimiter: true,
  logTraffic: false,
  // Advanced rate limiter cache configuration
  rateLimiterMaxEntries: 2000,
  rateLimiterCleanupIntervalMs: 60000,
  rateLimiterEntryTtlMs: 300000,
  // Advanced streaming retry cache configuration
  retryMaxEntries: 1000,
  retryEntryTtlMs: 300000,
  retryCleanupIntervalMs: 30000,
  retryMaxBufferSize: 5242880,
  retryMaxStreamRetries: 3,
  // Proxy configuration
  proxyBindHost: "0.0.0.0",
  proxyPort: 4040,
  proxyAllowTargetOverride: false,
  strictUrlForwarding: false,
  upstreamOpenAiUrl: "",
  upstreamAnthropicUrl: "",
  upstreamChatGptUrl: "",
  upstreamGeminiUrl: "",
  upstreamVertexUrl: "",
  upstreamNvidiaUrl: "",
  upstreamOpenRouterUrl: "",
  upstreamKiloUrl: "",
  upstreamGeminiCodeAssistUrl: "",
};

export function validateSettings(input: unknown): Settings {
  if (typeof input !== "object" || input === null) {
    throw new Error("Settings must be an object");
  }
  const obj = input as Record<string, unknown>;

  const validateString = (key: string, minLength = 0) => {
    const v = obj[key];
    if (typeof v !== "string" || v.length < minLength) {
      throw new Error(`Invalid ${key}: must be a non-empty string`);
    }
    return v;
  };

  const validateNumber = (key: string, min: number, max: number) => {
    const v = obj[key];
    if (typeof v !== "number" || !Number.isInteger(v) || v < min || v > max) {
      throw new Error(
        `Invalid ${key}: must be an integer between ${min} and ${max}`,
      );
    }
    return v;
  };

  const validateEnum = (key: string, allowed: string[]) => {
    const v = obj[key];
    if (typeof v !== "string" || !allowed.includes(v)) {
      throw new Error(`Invalid ${key}: must be one of ${allowed.join(", ")}`);
    }
    return v as "secrets" | "pii" | "strict";
  };

  const validateBoolean = (key: string) => {
    const v = obj[key];
    if (typeof v !== "boolean") {
      throw new Error(`Invalid ${key}: must be a boolean`);
    }
    return v;
  };

  return {
    logDir: validateString("logDir", 0),
    maxSessions: validateNumber("maxSessions", 0, 10000),
    redactPreset: validateEnum("redactPreset", ["secrets", "pii", "strict"]) as "secrets" | "pii" | "strict",
    redactReversible: validateBoolean("redactReversible"),
    redactPolicyFile: validateString("redactPolicyFile", 0),
    redactPolicyEnabled: validateBoolean("redactPolicyEnabled"),
    redactPathsOnly: (() => {
      const v = obj.redactPathsOnly;
      if (Array.isArray(v) && v.every(item => typeof item === "string")) {
        return v as string[];
      }
      return DEFAULT_SETTINGS.redactPathsOnly;
    })(),
    redactPathsSkip: (() => {
      const v = obj.redactPathsSkip;
      if (Array.isArray(v) && v.every(item => typeof item === "string")) {
        return v as string[];
      }
      return DEFAULT_SETTINGS.redactPathsSkip;
    })(),
    redactDisabledRules: (() => {
      const v = obj.redactDisabledRules;
      if (Array.isArray(v) && v.every(item => typeof item === "string")) {
        return v as string[];
      }
      return DEFAULT_SETTINGS.redactDisabledRules;
    })(),
    encryptionAtRest: validateBoolean("encryptionAtRest"),
    captureCleanupEnabled: validateBoolean("captureCleanupEnabled"),
    captureCleanupIntervalHours: validateNumber(
      "captureCleanupIntervalHours",
      1,
      168,
    ),
    captureCleanupMaxAgeDays: validateNumber(
      "captureCleanupMaxAgeDays",
      1,
      365,
    ),
    theme: validateEnum("theme", [
      "light",
      "dark",
      "system",
      "high-contrast",
      "material-light",
      "material-dark",
      "solarized-light",
      "solarized-dark",
      "dracula",
      "nord",
      "github-light",
      "github-dark",
      "one-dark",
      "monokai",
    ]) as
      | "light"
      | "dark"
      | "system"
      | "high-contrast"
      | "material-light"
      | "material-dark"
      | "solarized-light"
      | "solarized-dark"
      | "dracula"
      | "nord"
      | "github-light"
      | "github-dark"
      | "one-dark"
      | "monokai",
    oidcEnabled: validateBoolean("oidcEnabled"),
    oidcPublicUrl: validateString("oidcPublicUrl", 0),
    showPageLoadTime: validateBoolean("showPageLoadTime"),
    detectorMode: validateEnum("detectorMode", ["rules", "llm", "hybrid", "auto"]) as "rules" | "llm" | "hybrid" | "auto",
    detectorModelName: validateString("detectorModelName", 0),
    detectorThreshold: (() => {
      const v = obj.detectorThreshold;
      if (typeof v !== "number" || v < 0 || v > 1) {
        throw new Error(`Invalid detectorThreshold: must be a number between 0 and 1`);
      }
      return v;
    })(),
    rateLimiter: (() => {
      const rl = obj.rateLimiter;
      if (typeof rl !== "object" || rl === null) {
        return DEFAULT_SETTINGS.rateLimiter;
      }
      const rlObj = rl as Record<string, unknown>;
      const result = {} as Record<Provider, RateLimitConfig>;
      for (const provider of ["anthropic", "openai", "chatgpt", "gemini", "vertex", "nvidia", "openrouter", "kilo", "unknown"] as Provider[]) {
        const p = rlObj[provider];
        if (typeof p === "object" && p !== null) {
          const pObj = p as { maxRequests?: unknown; windowMs?: unknown; bufferCapacity?: unknown };
          const maxRequests = Number.isInteger(pObj.maxRequests) && pObj.maxRequests as number >= 1 && (pObj.maxRequests as number) <= 10000 ? pObj.maxRequests as number : 60;
          const windowMs = Number.isInteger(pObj.windowMs) && pObj.windowMs as number >= 100 && (pObj.windowMs as number) <= 24 * 60 * 60 * 1000 ? pObj.windowMs as number : 60000;
          const bufferCapacity = Number.isInteger(pObj.bufferCapacity) && pObj.bufferCapacity as number >= 0 && (pObj.bufferCapacity as number) <= 10000 ? pObj.bufferCapacity as number : 10;
          result[provider] = { maxRequests, windowMs, bufferCapacity };
        } else {
          result[provider] = { maxRequests: 60, windowMs: 60000, bufferCapacity: 10 };
        }
      }
      return result;
    })(),
    streamingRetry: (() => {
      const sr = obj.streamingRetry;
      if (typeof sr !== "object" || sr === null) {
        return DEFAULT_SETTINGS.streamingRetry;
      }
      const srObj = sr as Record<string, unknown>;
      const result = {} as Record<Provider, StreamingRetryConfig>;
      for (const provider of ["anthropic", "openai", "chatgpt", "gemini", "geminiCodeAssist", "vertex", "nvidia", "openrouter", "kilo", "unknown"] as Provider[]) {
        const p = srObj[provider];
        if (typeof p === "object" && p !== null) {
          const pObj = p as { enabled?: unknown; maxRetries?: unknown; maxBufferSizeMB?: unknown };
          const enabled = typeof pObj.enabled === "boolean" ? pObj.enabled : true;
          const maxRetries = Number.isInteger(pObj.maxRetries) && pObj.maxRetries as number >= 0 && (pObj.maxRetries as number) <= 10 ? pObj.maxRetries as number : 3;
          const maxBufferSizeMB = Number.isInteger(pObj.maxBufferSizeMB) && pObj.maxBufferSizeMB as number >= 1 && (pObj.maxBufferSizeMB as number) <= 100 ? pObj.maxBufferSizeMB as number : 10;
          result[provider] = { enabled, maxRetries, maxBufferSizeMB };
        } else {
          result[provider] = { enabled: true, maxRetries: 3, maxBufferSizeMB: 10 };
        }
      }
      return result;
    })(),
    // Feature flags
    enableLogger: validateBoolean("enableLogger"),
    enableRedact: validateBoolean("enableRedact"),
    enableRateLimiter: validateBoolean("enableRateLimiter"),
    logTraffic: validateBoolean("logTraffic"),
    // Advanced rate limiter cache configuration
    rateLimiterMaxEntries: validateNumber("rateLimiterMaxEntries", 100, 100000),
    rateLimiterCleanupIntervalMs: validateNumber("rateLimiterCleanupIntervalMs", 1000, 3600000),
    rateLimiterEntryTtlMs: validateNumber("rateLimiterEntryTtlMs", 1000, 86400000),
    // Advanced streaming retry cache configuration
    retryMaxEntries: validateNumber("retryMaxEntries", 100, 100000),
    retryEntryTtlMs: validateNumber("retryEntryTtlMs", 1000, 86400000),
    retryCleanupIntervalMs: validateNumber("retryCleanupIntervalMs", 1000, 3600000),
    retryMaxBufferSize: validateNumber("retryMaxBufferSize", 102400, 104857600),
    retryMaxStreamRetries: validateNumber("retryMaxStreamRetries", 0, 10),
    // Proxy configuration
    proxyBindHost: validateString("proxyBindHost", 0),
    proxyPort: validateNumber("proxyPort", 1, 65535),
    proxyAllowTargetOverride: validateBoolean("proxyAllowTargetOverride"),
    strictUrlForwarding: validateBoolean("strictUrlForwarding"),
    upstreamOpenAiUrl: validateString("upstreamOpenAiUrl", 0),
    upstreamAnthropicUrl: validateString("upstreamAnthropicUrl", 0),
    upstreamChatGptUrl: validateString("upstreamChatGptUrl", 0),
    upstreamGeminiUrl: validateString("upstreamGeminiUrl", 0),
    upstreamVertexUrl: validateString("upstreamVertexUrl", 0),
    upstreamNvidiaUrl: validateString("upstreamNvidiaUrl", 0),
    upstreamOpenRouterUrl: validateString("upstreamOpenRouterUrl", 0),
    upstreamKiloUrl: validateString("upstreamKiloUrl", 0),
    upstreamGeminiCodeAssistUrl: validateString("upstreamGeminiCodeAssistUrl", 0),
  };
}

export function mergeWithDefaults(partial: Partial<Settings>): Settings {
  return { ...DEFAULT_SETTINGS, ...partial };
}

export function validateSettingsLenient(input: unknown): Settings {
  if (typeof input !== "object" || input === null) {
    return DEFAULT_SETTINGS;
  }
  const obj = input as Record<string, unknown>;

  return {
    logDir:
      typeof obj.logDir === "string" && obj.logDir.length >= 1
        ? obj.logDir
        : DEFAULT_SETTINGS.logDir,
    maxSessions:
      typeof obj.maxSessions === "number" &&
      Number.isInteger(obj.maxSessions) &&
      obj.maxSessions >= 0 &&
      obj.maxSessions <= 10000
        ? obj.maxSessions
        : DEFAULT_SETTINGS.maxSessions,
    redactPreset:
      typeof obj.redactPreset === "string" &&
      ["secrets", "pii", "strict"].includes(obj.redactPreset)
        ? (obj.redactPreset as "secrets" | "pii" | "strict")
        : DEFAULT_SETTINGS.redactPreset,
  redactReversible:
    typeof obj.redactReversible === "boolean"
    ? obj.redactReversible
    : DEFAULT_SETTINGS.redactReversible,
  redactPolicyFile:
    typeof obj.redactPolicyFile === "string"
    ? obj.redactPolicyFile
    : DEFAULT_SETTINGS.redactPolicyFile,
  redactPolicyEnabled:
    typeof obj.redactPolicyEnabled === "boolean"
    ? obj.redactPolicyEnabled
    : DEFAULT_SETTINGS.redactPolicyEnabled,
  redactPathsOnly:
    Array.isArray(obj.redactPathsOnly) && obj.redactPathsOnly.every((item: unknown) => typeof item === "string")
      ? (obj.redactPathsOnly as string[])
      : DEFAULT_SETTINGS.redactPathsOnly,
  redactPathsSkip:
    Array.isArray(obj.redactPathsSkip) && obj.redactPathsSkip.every((item: unknown) => typeof item === "string")
      ? (obj.redactPathsSkip as string[])
      : DEFAULT_SETTINGS.redactPathsSkip,
  redactDisabledRules:
    Array.isArray(obj.redactDisabledRules) && obj.redactDisabledRules.every((item: unknown) => typeof item === "string")
      ? (obj.redactDisabledRules as string[])
      : DEFAULT_SETTINGS.redactDisabledRules,
  encryptionAtRest:
      typeof obj.encryptionAtRest === "boolean"
        ? obj.encryptionAtRest
        : DEFAULT_SETTINGS.encryptionAtRest,
    captureCleanupEnabled:
      typeof obj.captureCleanupEnabled === "boolean"
        ? obj.captureCleanupEnabled
        : DEFAULT_SETTINGS.captureCleanupEnabled,
    captureCleanupIntervalHours:
      typeof obj.captureCleanupIntervalHours === "number" &&
      Number.isInteger(obj.captureCleanupIntervalHours) &&
      obj.captureCleanupIntervalHours >= 1 &&
      obj.captureCleanupIntervalHours <= 168
        ? obj.captureCleanupIntervalHours
        : DEFAULT_SETTINGS.captureCleanupIntervalHours,
    captureCleanupMaxAgeDays:
      typeof obj.captureCleanupMaxAgeDays === "number" &&
      Number.isInteger(obj.captureCleanupMaxAgeDays) &&
      obj.captureCleanupMaxAgeDays >= 1 &&
      obj.captureCleanupMaxAgeDays <= 365
        ? obj.captureCleanupMaxAgeDays
        : DEFAULT_SETTINGS.captureCleanupMaxAgeDays,
    theme:
      typeof obj.theme === "string" &&
      [
        "light",
        "dark",
        "system",
        "high-contrast",
        "material-light",
        "material-dark",
        "solarized-light",
        "solarized-dark",
        "dracula",
        "nord",
        "github-light",
        "github-dark",
        "one-dark",
        "monokai",
      ].includes(obj.theme)
        ? (obj.theme as
            | "light"
            | "dark"
            | "system"
            | "high-contrast"
            | "material-light"
            | "material-dark"
            | "solarized-light"
            | "solarized-dark"
            | "dracula"
            | "nord"
            | "github-light"
            | "github-dark"
            | "one-dark"
            | "monokai")
        : DEFAULT_SETTINGS.theme,
    oidcEnabled:
      typeof obj.oidcEnabled === "boolean"
        ? obj.oidcEnabled
        : DEFAULT_SETTINGS.oidcEnabled,
    oidcPublicUrl:
      typeof obj.oidcPublicUrl === "string"
        ? obj.oidcPublicUrl
        : DEFAULT_SETTINGS.oidcPublicUrl,
    showPageLoadTime:
      typeof obj.showPageLoadTime === "boolean"
        ? obj.showPageLoadTime
        : DEFAULT_SETTINGS.showPageLoadTime,
    detectorMode:
      typeof obj.detectorMode === "string" &&
      ["rules", "llm", "hybrid", "auto"].includes(obj.detectorMode)
        ? (obj.detectorMode as "rules" | "llm" | "hybrid" | "auto")
        : DEFAULT_SETTINGS.detectorMode,
    detectorModelName:
      typeof obj.detectorModelName === "string"
        ? obj.detectorModelName
        : DEFAULT_SETTINGS.detectorModelName,
    detectorThreshold:
      typeof obj.detectorThreshold === "number" &&
      obj.detectorThreshold >= 0 &&
      obj.detectorThreshold <= 1
        ? obj.detectorThreshold
        : DEFAULT_SETTINGS.detectorThreshold,
    rateLimiter: (() => {
      const rl = obj.rateLimiter;
      if (typeof rl !== "object" || rl === null) {
        return DEFAULT_SETTINGS.rateLimiter;
      }
      const rlObj = rl as Record<string, unknown>;
      const result = {} as Record<Provider, RateLimitConfig>;
      for (const provider of ["anthropic", "openai", "chatgpt", "gemini", "geminiCodeAssist", "vertex", "nvidia", "openrouter", "kilo", "unknown"] as Provider[]) {
        const p = rlObj[provider];
        if (typeof p === "object" && p !== null) {
          const pObj = p as { maxRequests?: unknown; windowMs?: unknown; bufferCapacity?: unknown };
          const maxRequests = Number.isInteger(pObj.maxRequests) && pObj.maxRequests as number >= 1 && (pObj.maxRequests as number) <= 10000 ? pObj.maxRequests as number : 60;
          const windowMs = Number.isInteger(pObj.windowMs) && pObj.windowMs as number >= 100 && (pObj.windowMs as number) <= 24 * 60 * 60 * 1000 ? pObj.windowMs as number : 60000;
          const bufferCapacity = Number.isInteger(pObj.bufferCapacity) && pObj.bufferCapacity as number >= 0 && (pObj.bufferCapacity as number) <= 10000 ? pObj.bufferCapacity as number : 10;
          result[provider] = { maxRequests, windowMs, bufferCapacity };
        } else {
          result[provider] = DEFAULT_SETTINGS.rateLimiter[provider];
        }
      }
      return result;
    })(),
    streamingRetry: (() => {
      const sr = obj.streamingRetry;
      if (typeof sr !== "object" || sr === null) {
        return DEFAULT_SETTINGS.streamingRetry;
      }
      const srObj = sr as Record<string, unknown>;
      const result = {} as Record<Provider, StreamingRetryConfig>;
      for (const provider of ["anthropic", "openai", "chatgpt", "gemini", "geminiCodeAssist", "vertex", "nvidia", "openrouter", "kilo", "unknown"] as Provider[]) {
        const p = srObj[provider];
        if (typeof p === "object" && p !== null) {
          const pObj = p as { enabled?: unknown; maxRetries?: unknown; maxBufferSizeMB?: unknown };
          const enabled = typeof pObj.enabled === "boolean" ? pObj.enabled : true;
          const maxRetries = Number.isInteger(pObj.maxRetries) && pObj.maxRetries as number >= 0 && (pObj.maxRetries as number) <= 10 ? pObj.maxRetries as number : 3;
          const maxBufferSizeMB = Number.isInteger(pObj.maxBufferSizeMB) && pObj.maxBufferSizeMB as number >= 1 && (pObj.maxBufferSizeMB as number) <= 100 ? pObj.maxBufferSizeMB as number : 10;
          result[provider] = { enabled, maxRetries, maxBufferSizeMB };
        } else {
          result[provider] = DEFAULT_SETTINGS.streamingRetry[provider];
        }
      }
      return result;
    })(),
    // Feature flags
    enableLogger:
      typeof obj.enableLogger === "boolean"
        ? obj.enableLogger
        : DEFAULT_SETTINGS.enableLogger,
    enableRedact:
      typeof obj.enableRedact === "boolean"
        ? obj.enableRedact
        : DEFAULT_SETTINGS.enableRedact,
    enableRateLimiter:
      typeof obj.enableRateLimiter === "boolean"
        ? obj.enableRateLimiter
        : DEFAULT_SETTINGS.enableRateLimiter,
    logTraffic:
      typeof obj.logTraffic === "boolean"
        ? obj.logTraffic
        : DEFAULT_SETTINGS.logTraffic,
    // Advanced rate limiter cache configuration
    rateLimiterMaxEntries:
      typeof obj.rateLimiterMaxEntries === "number" &&
      Number.isInteger(obj.rateLimiterMaxEntries) &&
      obj.rateLimiterMaxEntries >= 100 &&
      obj.rateLimiterMaxEntries <= 100000
        ? obj.rateLimiterMaxEntries
        : DEFAULT_SETTINGS.rateLimiterMaxEntries,
    rateLimiterCleanupIntervalMs:
      typeof obj.rateLimiterCleanupIntervalMs === "number" &&
      Number.isInteger(obj.rateLimiterCleanupIntervalMs) &&
      obj.rateLimiterCleanupIntervalMs >= 1000 &&
      obj.rateLimiterCleanupIntervalMs <= 3600000
        ? obj.rateLimiterCleanupIntervalMs
        : DEFAULT_SETTINGS.rateLimiterCleanupIntervalMs,
    rateLimiterEntryTtlMs:
      typeof obj.rateLimiterEntryTtlMs === "number" &&
      Number.isInteger(obj.rateLimiterEntryTtlMs) &&
      obj.rateLimiterEntryTtlMs >= 1000 &&
      obj.rateLimiterEntryTtlMs <= 86400000
        ? obj.rateLimiterEntryTtlMs
        : DEFAULT_SETTINGS.rateLimiterEntryTtlMs,
    // Advanced streaming retry cache configuration
    retryMaxEntries:
      typeof obj.retryMaxEntries === "number" &&
      Number.isInteger(obj.retryMaxEntries) &&
      obj.retryMaxEntries >= 100 &&
      obj.retryMaxEntries <= 100000
        ? obj.retryMaxEntries
        : DEFAULT_SETTINGS.retryMaxEntries,
    retryEntryTtlMs:
      typeof obj.retryEntryTtlMs === "number" &&
      Number.isInteger(obj.retryEntryTtlMs) &&
      obj.retryEntryTtlMs >= 1000 &&
      obj.retryEntryTtlMs <= 86400000
        ? obj.retryEntryTtlMs
        : DEFAULT_SETTINGS.retryEntryTtlMs,
    retryCleanupIntervalMs:
      typeof obj.retryCleanupIntervalMs === "number" &&
      Number.isInteger(obj.retryCleanupIntervalMs) &&
      obj.retryCleanupIntervalMs >= 1000 &&
      obj.retryCleanupIntervalMs <= 3600000
        ? obj.retryCleanupIntervalMs
        : DEFAULT_SETTINGS.retryCleanupIntervalMs,
    retryMaxBufferSize:
      typeof obj.retryMaxBufferSize === "number" &&
      Number.isInteger(obj.retryMaxBufferSize) &&
      obj.retryMaxBufferSize >= 102400 &&
      obj.retryMaxBufferSize <= 104857600
        ? obj.retryMaxBufferSize
        : DEFAULT_SETTINGS.retryMaxBufferSize,
    retryMaxStreamRetries:
      typeof obj.retryMaxStreamRetries === "number" &&
      Number.isInteger(obj.retryMaxStreamRetries) &&
      obj.retryMaxStreamRetries >= 0 &&
      obj.retryMaxStreamRetries <= 10
        ? obj.retryMaxStreamRetries
        : DEFAULT_SETTINGS.retryMaxStreamRetries,
    // Proxy configuration
    proxyBindHost:
      typeof obj.proxyBindHost === "string"
        ? obj.proxyBindHost
        : DEFAULT_SETTINGS.proxyBindHost,
    proxyPort:
      typeof obj.proxyPort === "number" &&
      Number.isInteger(obj.proxyPort) &&
      obj.proxyPort >= 1 &&
      obj.proxyPort <= 65535
        ? obj.proxyPort
        : DEFAULT_SETTINGS.proxyPort,
    proxyAllowTargetOverride:
      typeof obj.proxyAllowTargetOverride === "boolean"
        ? obj.proxyAllowTargetOverride
        : DEFAULT_SETTINGS.proxyAllowTargetOverride,
    strictUrlForwarding:
      typeof obj.strictUrlForwarding === "boolean"
        ? obj.strictUrlForwarding
        : DEFAULT_SETTINGS.strictUrlForwarding,
    upstreamOpenAiUrl:
      typeof obj.upstreamOpenAiUrl === "string"
        ? obj.upstreamOpenAiUrl
        : DEFAULT_SETTINGS.upstreamOpenAiUrl,
    upstreamAnthropicUrl:
      typeof obj.upstreamAnthropicUrl === "string"
        ? obj.upstreamAnthropicUrl
        : DEFAULT_SETTINGS.upstreamAnthropicUrl,
    upstreamChatGptUrl:
      typeof obj.upstreamChatGptUrl === "string"
        ? obj.upstreamChatGptUrl
        : DEFAULT_SETTINGS.upstreamChatGptUrl,
    upstreamGeminiUrl:
      typeof obj.upstreamGeminiUrl === "string"
        ? obj.upstreamGeminiUrl
        : DEFAULT_SETTINGS.upstreamGeminiUrl,
    upstreamVertexUrl:
      typeof obj.upstreamVertexUrl === "string"
        ? obj.upstreamVertexUrl
        : DEFAULT_SETTINGS.upstreamVertexUrl,
    upstreamNvidiaUrl:
      typeof obj.upstreamNvidiaUrl === "string"
        ? obj.upstreamNvidiaUrl
        : DEFAULT_SETTINGS.upstreamNvidiaUrl,
    upstreamOpenRouterUrl:
      typeof obj.upstreamOpenRouterUrl === "string"
        ? obj.upstreamOpenRouterUrl
        : DEFAULT_SETTINGS.upstreamOpenRouterUrl,
    upstreamKiloUrl:
      typeof obj.upstreamKiloUrl === "string"
        ? obj.upstreamKiloUrl
        : DEFAULT_SETTINGS.upstreamKiloUrl,
    upstreamGeminiCodeAssistUrl:
      typeof obj.upstreamGeminiCodeAssistUrl === "string"
        ? obj.upstreamGeminiCodeAssistUrl
        : DEFAULT_SETTINGS.upstreamGeminiCodeAssistUrl,
  };
}
