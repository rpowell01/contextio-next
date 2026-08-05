/**
 * @contextio/core
 *
 * Shared types, routing, and utility functions for the contextio ecosystem.
 * This is the contract layer: every other `@contextio/*` package depends on it.
 *
 * Zero npm dependencies. No HTTP server, no proxy handler. Just types and
 * pure functions.
 *
 * @packageDocumentation
 */

// Routing: provider detection, source extraction, upstream URL resolution
export {
  classifyRequest,
  extractSource,
  resolveTargetUrl,
} from "./routing.js";

// Header filtering: strip auth/secret headers before persisting captures
export { SENSITIVE_HEADERS, selectHeaders } from "./headers.js";

// Model metadata: pricing, context limits, known model list
export {
  CONTEXT_LIMITS,
  MODEL_PRICING,
  estimateCost,
  getContextLimit,
  getKnownModels,
} from "./models.js";

// Token estimation: cheap char-based approximation with image awareness
export { IMAGE_TOKEN_ESTIMATE, estimateTokens, countImageBlocks } from "./tokens.js";

// Response parsing: extract usage/tokens from streaming and non-streaming responses
export {
extractResponseId,
parseResponseUsage,
parseStreamingTokens,
estimateTokensFromText,
ESTIMATED_TOKENS_PER_CHARACTER,
type ParsedResponseUsage,
} from "./response.js";

// Input security: prompt injection and suspicious pattern detection
export {
  scanSecurity,
  scanRequestMessages,
  type AlertSeverity,
  type SecurityAlert,
  type SecurityResult,
  type SecuritySummary,
} from "./security.js";

// Security patterns: shared regex data for injection detection and credential scanning
export {
  CREDENTIAL_PATTERNS,
  shannonEntropy,
  type CredentialPattern,
} from "./security-patterns.js";

// Output security: jailbreak outputs, dangerous code, URL scanning
export {
  OUTPUT_BAN_SUBSTRINGS,
  scanBanSubstrings,
  scanRegex,
  extractUrls,
  scanUrls,
  scanDangerousCode,
  scanOutput,
  type OutputAlert,
  type OutputScanResult,
} from "./output-scanner.js";

// Default OIDC scopes
export { DEFAULT_OIDC_SCOPE } from "./types.js";

// Crypto utilities: encryption/decryption for capture files and redaction metadata
export {
  encrypt,
  decrypt,
  deriveKey,
  validateKey,
} from "./crypto.js";

// Core types used across all packages
export type {
  ApiFormat,
  AuthType,
  CaptureData,
  EncryptionAtRestConfig,
  ExtractSourceResult,
  HeaderMap,
  JsonObject,
  JsonValue,
  OidcProviderConfig,
  Provider,
  ProviderConfig,
  ProvidersMap,
  ProxyConfig,
  ProxyPlugin,
  RateLimitConfig,
  RateLimiterBucketState,
  RateLimiterConfigSummary,
  RateLimiterMetrics,
  RetryConfig,
  RetryConfigWithProviders,
  RequestContext,
  ResolveTargetResult,
  ResponseContext,
  Upstreams,
} from "./types.js";

// Response utilities: service identification for client-facing messages
export {
  SERVICE_IDENTIFIER,
  createErrorResponse,
  createSuccessResponse,
  createInfoResponse,
  addServiceIdentifier,
  hasServiceIdentifier,
  type ServiceResponseOptions,
} from "./response-utils.js";

// Provider validation functions and constants
export {
  KNOWN_API_FORMATS,
  KNOWN_AUTH_TYPES,
  KNOWN_PROVIDERS,
  validateProviderConfig,
  validateRateLimitConfig,
  validateRetryConfig,
  validateProvidersMap,
} from "./types.js";

// Database core: SQLite connection, migrations, and schema initialization
// Exported separately via `@contextio/core/db` to avoid pulling in better-sqlite3
// when importing types/utilities from the main entry point.
// export {
//   initDb,
//   runMigrations,
//   getDb,
//   closeDb,
//   isDbInitialized,
//   getDbPath,
//   getSchemaVersion,
//   getAppliedMigrations,
//   getPendingMigrations,
//   type Migration,
// } from "./db/index.js";
