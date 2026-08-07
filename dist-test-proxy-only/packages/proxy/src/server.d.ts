#!/usr/bin/env node
/**
 * Standalone entry point for `@contextio/proxy`.
 *
 * Starts the proxy server and dynamically loads plugins from the
 * `CONTEXT_PROXY_PLUGINS` environment variable (comma-separated module
 * specifiers). Each module must export a ProxyPlugin or a factory
 * function that returns one.
 *
 * This file is the `context-proxy` binary defined in package.json.
 *
 * Minimal dependencies: @contextio/core and @contextio/logger.
 * API keys flow through this code; keeping imports small means the
 * entire proxy is auditable by reading a handful of packages.
 */
export {};
//# sourceMappingURL=server.d.ts.map