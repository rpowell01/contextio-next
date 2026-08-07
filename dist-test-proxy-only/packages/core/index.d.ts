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
export { classifyRequest, extractSource, resolveTargetUrl, } from "./routing.js";
export { SENSITIVE_HEADERS, selectHeaders } from "./headers.js";
export { CONTEXT_LIMITS, MODEL_PRICING, estimateCost, getContextLimit, getKnownModels, } from "./models.js";
export { IMAGE_TOKEN_ESTIMATE, estimateTokens, countImageBlocks } from "./tokens.js";
export { extractResponseId, parseResponseUsage, parseStreamingTokens, estimateTokensFromText, ESTIMATED_TOKENS_PER_CHARACTER, type ParsedResponseUsage, } from "./response.js";
export { scanSecurity, scanRequestMessages, type AlertSeverity, type SecurityAlert, type SecurityResult, type SecuritySummary, } from "./security.js";
export { CREDENTIAL_PATTERNS, shannonEntropy, type CredentialPattern, } from "./security-patterns.js";
export { OUTPUT_BAN_SUBSTRINGS, scanBanSubstrings, scanRegex, extractUrls, scanUrls, scanDangerousCode, scanOutput, type OutputAlert, type OutputScanResult, } from "./output-scanner.js";
export { DEFAULT_OIDC_SCOPE } from "./types.js";
export { encrypt, decrypt, deriveKey, validateKey, } from "./crypto.js";
export type { ApiFormat, AuthType, CaptureData, EncryptionAtRestConfig, ExtractSourceResult, HeaderMap, JsonObject, JsonValue, OidcProviderConfig, Provider, ProviderConfig, ProvidersMap, ProxyConfig, ProxyPlugin, RateLimitConfig, RateLimiterBucketState, RateLimiterConfigSummary, RateLimiterMetrics, RetryConfig, RetryConfigWithProviders, RequestContext, ResolveTargetResult, ResponseContext, Upstreams, } from "./types.js";
export { SERVICE_IDENTIFIER, createErrorResponse, createSuccessResponse, createInfoResponse, addServiceIdentifier, hasServiceIdentifier, type ServiceResponseOptions, } from "./response-utils.js";
export { KNOWN_API_FORMATS, KNOWN_AUTH_TYPES, KNOWN_PROVIDERS, validateProviderConfig, validateRateLimitConfig, validateRetryConfig, validateProvidersMap, } from "./types.js";
//# sourceMappingURL=index.d.ts.map