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
export { createProxy } from "./proxy.js";
export type { ProxyInstance } from "./proxy.js";
export { createProxyHandler } from "./forward.js";
export type { ForwardOptions } from "./forward.js";
export { resolveConfig } from "./config.js";
export { resolveOidcConfig } from "./config.js";
export type { ResolvedProxyConfig } from "./config.js";
export { createAdminHandler, enableLogCapture, getLogs, clearLogs, } from "./admin.js";
export type { ProxyStatus, ProxyEnvVar, LogEntry, AdminOptions } from "./admin.js";
export { createAuthHandler, validateSession, requireAuth, getSessionId, } from "./auth.js";
export type { AuthSession, AuthOptions } from "./auth.js";
export { createRateLimiterPlugin, RateLimiterPlugin, type RateLimiterConfig, type KeyStrategy, } from "./rate-limiter.js";
export { createRetryPlugin, RetryPlugin, type RetryConfig, } from "./retry-plugin.js";
//# sourceMappingURL=index.d.ts.map