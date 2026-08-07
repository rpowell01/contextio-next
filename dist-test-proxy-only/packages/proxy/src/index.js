/**
 * @contextio/proxy
 *
 * Pluggable HTTP reverse proxy for LLM APIs. Routes requests to Anthropic,
 * OpenAI, and Google upstreams. Plugins hook into the request/response
 * lifecycle for redaction, logging, or custom transforms.
 *
 * Depends only on Node.js built-ins and `@contextio/core`. Zero other
 * npm dependencies. Your API keys flow through this code, so it's
 * intentionally small and auditable.
 *
 * @packageDocumentation
 */
// Main API: create a proxy instance with start/stop lifecycle
export { createProxy } from "./proxy.js";
// Low-level handler for embedding in a custom HTTP server
export { createProxyHandler } from "./forward.js";
// Config resolution (env vars + overrides)
export { resolveConfig } from "./config.js";
export { resolveOidcConfig } from "./config.js";
// Admin API for management UI
export { createAdminHandler, enableLogCapture, getLogs, clearLogs, } from "./admin.js";
// Auth API for OIDC authentication
export { createAuthHandler, validateSession, requireAuth, getSessionId, } from "./auth.js";
// Rate limiter plugin
export { createRateLimiterPlugin, RateLimiterPlugin, } from "./rate-limiter.js";
// Retry plugin
export { createRetryPlugin, RetryPlugin, } from "./retry-plugin.js";
//# sourceMappingURL=index.js.map