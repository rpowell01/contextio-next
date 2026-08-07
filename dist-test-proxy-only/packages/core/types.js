/**
 * Core types for the contextio proxy ecosystem.
 *
 * These are the public types that plugins and consumers depend on.
 * Zero external dependencies.
 */
/** All known ApiFormat values for runtime validation. */
export const KNOWN_API_FORMATS = [
    "anthropic-messages",
    "chatgpt-backend",
    "responses",
    "chat-completions",
    "gemini",
    "raw",
    "unknown",
];
const _apiFormatExhaustive = true;
/** All known AuthType values for runtime validation. */
export const KNOWN_AUTH_TYPES = [
    "bearer",
    "api-key",
    "none",
];
const _authTypeExhaustive = true;
/** All known Provider values for runtime validation. */
export const KNOWN_PROVIDERS = [
    "anthropic",
    "openai",
    "chatgpt",
    "gemini",
    "geminiCodeAssist",
    "vertex",
    "nvidia",
    "openrouter",
    "kilo",
    "unknown",
];
const _providerExhaustive = true;
// --- OIDC auth config ---
/** Default OIDC scopes requested during authentication. */
export const DEFAULT_OIDC_SCOPE = ["openid", "profile", "email"];
/**
 * Validates a ProviderConfig object.
 *
 * @throws {Error} If validation fails, with a descriptive message.
 */
export function validateProviderConfig(config) {
    if (!config.id) {
        throw new Error("ProviderConfig.id is required");
    }
    if (!config.name) {
        throw new Error("ProviderConfig.name is required");
    }
    if (!config.upstreamUrl) {
        throw new Error("ProviderConfig.upstreamUrl is required");
    }
    try {
        new URL(config.upstreamUrl);
    }
    catch {
        throw new Error("ProviderConfig.upstreamUrl must be a valid URL");
    }
    if (!config.apiFormat) {
        throw new Error("ProviderConfig.apiFormat is required");
    }
    if (!KNOWN_API_FORMATS.includes(config.apiFormat)) {
        throw new Error(`ProviderConfig.apiFormat must be one of: ${KNOWN_API_FORMATS.join(", ")}`);
    }
    if (!KNOWN_AUTH_TYPES.includes(config.authType)) {
        throw new Error(`ProviderConfig.authType must be one of: ${KNOWN_AUTH_TYPES.join(", ")}`);
    }
    if (typeof config.enabled !== "boolean") {
        throw new Error("ProviderConfig.enabled must be a boolean");
    }
    if (!config.rateLimit) {
        throw new Error("ProviderConfig.rateLimit is required");
    }
    validateRateLimitConfig(config.rateLimit);
    if (!config.retry) {
        throw new Error("ProviderConfig.retry is required");
    }
    validateRetryConfig(config.retry);
    if (!config.customHeaders || typeof config.customHeaders !== "object" || Array.isArray(config.customHeaders)) {
        throw new Error("ProviderConfig.customHeaders must be an object");
    }
    for (const [key, value] of Object.entries(config.customHeaders)) {
        if (typeof key !== "string" || typeof value !== "string") {
            throw new Error("ProviderConfig.customHeaders must be Record<string, string>");
        }
    }
    // AllowBaseUrlOverride is optional, default to false for backwards compatibility
    const allowBaseUrlOverride = config.allowBaseUrlOverride ?? false;
    if (typeof allowBaseUrlOverride !== "boolean") {
        throw new Error("ProviderConfig.allowBaseUrlOverride must be a boolean");
    }
    // BaseUrlOverrideHeader is optional, default to standard header name
    const baseUrlOverrideHeader = config.baseUrlOverrideHeader ?? `x-${config.id}-baseurl`;
    if (typeof baseUrlOverrideHeader !== "string" || baseUrlOverrideHeader.trim() === "") {
        throw new Error("ProviderConfig.baseUrlOverrideHeader must be a non-empty string");
    }
}
/**
 * Validates a RateLimitConfig object.
 *
 * @throws {Error} If validation fails, with a descriptive message.
 */
export function validateRateLimitConfig(config) {
    if (typeof config.maxRequests !== "number" || Number.isNaN(config.maxRequests) || config.maxRequests < 0) {
        throw new Error("RateLimitConfig.maxRequests must be a non-negative number");
    }
    if (typeof config.windowMs !== "number" || Number.isNaN(config.windowMs) || config.windowMs <= 0) {
        throw new Error("RateLimitConfig.windowMs must be a positive number");
    }
    if (typeof config.bufferCapacity !== "number" || Number.isNaN(config.bufferCapacity) || config.bufferCapacity < 0) {
        throw new Error("RateLimitConfig.bufferCapacity must be a non-negative number");
    }
}
/**
 * Validates a RetryConfig object.
 *
 * @throws {Error} If validation fails, with a descriptive message.
 */
export function validateRetryConfig(config) {
    if (typeof config.maxRetries !== "number" || Number.isNaN(config.maxRetries) || config.maxRetries < 0) {
        throw new Error("RetryConfig.maxRetries must be a non-negative number");
    }
    if (typeof config.baseDelayMs !== "number" || Number.isNaN(config.baseDelayMs) || config.baseDelayMs < 0) {
        throw new Error("RetryConfig.baseDelayMs must be a non-negative number");
    }
    if (typeof config.maxDelayMs !== "number" || Number.isNaN(config.maxDelayMs) || config.maxDelayMs < 0) {
        throw new Error("RetryConfig.maxDelayMs must be a non-negative number");
    }
    if (config.maxDelayMs < config.baseDelayMs) {
        throw new Error("RetryConfig.maxDelayMs must be >= baseDelayMs");
    }
    if (!Array.isArray(config.retryableStatuses)) {
        throw new Error("RetryConfig.retryableStatuses must be an array");
    }
    for (const status of config.retryableStatuses) {
        if (typeof status !== "number" || Number.isNaN(status) || status < 100 || status > 599) {
            throw new Error("RetryConfig.retryableStatuses must contain valid HTTP status codes (100-599)");
        }
    }
    if (typeof config.jitterFactor !== "number" || Number.isNaN(config.jitterFactor) || config.jitterFactor < 0 || config.jitterFactor > 1) {
        throw new Error("RetryConfig.jitterFactor must be a number between 0 and 1");
    }
    if (typeof config.maxStreamRetries !== "number" || Number.isNaN(config.maxStreamRetries) || config.maxStreamRetries < 0 || config.maxStreamRetries > 10) {
        throw new Error("RetryConfig.maxStreamRetries must be a number between 0 and 10");
    }
    if (typeof config.maxResponseBufferSize !== "number" || Number.isNaN(config.maxResponseBufferSize) || config.maxResponseBufferSize <= 0 || config.maxResponseBufferSize > 100 * 1024 * 1024) {
        throw new Error("RetryConfig.maxResponseBufferSize must be a positive number up to 100 MB (104857600 bytes)");
    }
    if (typeof config.enabled !== "boolean") {
        throw new Error("RetryConfig.enabled must be a boolean");
    }
}
/**
 * Validates a ProvidersMap object.
 *
 * @throws {Error} If validation fails, with a descriptive message.
 */
export function validateProvidersMap(providers) {
    if (!providers || typeof providers !== "object") {
        throw new Error("ProvidersMap must be an object");
    }
    for (const [key, config] of Object.entries(providers)) {
        // Validate config first to catch missing id and other issues
        // with descriptive messages before checking key match
        try {
            validateProviderConfig(config);
        }
        catch (error) {
            throw new Error(`Provider '${key}': ${error instanceof Error ? error.message : String(error)}`);
        }
        // Then check that map key matches config.id
        if (key !== config.id) {
            throw new Error(`Provider map key '${key}' does not match config.id '${config.id}'`);
        }
    }
}
//# sourceMappingURL=types.js.map