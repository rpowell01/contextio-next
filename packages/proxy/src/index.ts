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
export type { ProxyInstance } from "./proxy.js";

// Low-level handler for embedding in a custom HTTP server
export { createProxyHandler } from "./forward.js";
export type { ForwardOptions } from "./forward.js";

// Config resolution (env vars + overrides)
export { resolveConfig } from "./config.js";
export { resolveOidcConfig } from "./config.js";
export type { ResolvedProxyConfig } from "./config.js";

// Admin API for management UI
export {
  createAdminHandler,
  enableLogCapture,
  getLogs,
  clearLogs,
} from "./admin.js";
export type { ProxyStatus, ProxyEnvVar, LogEntry, AdminOptions } from "./admin.js";

// Auth API for OIDC authentication
export {
  createAuthHandler,
  validateSession,
  requireAuth,
  getSessionId,
} from "./auth.js";
export type { AuthSession, AuthOptions } from "./auth.js";

// Rate limiter plugin
export {
  createRateLimiterPlugin,
  RateLimiterPlugin,
  type RateLimiterConfig,
} from "./rate-limiter.js";

// Retry plugin
export {
  createRetryPlugin,
  RetryPlugin,
  type RetryConfig,
} from "./retry-plugin.js";
