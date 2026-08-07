#!/usr/bin/env node
/**
 * Combined entry point: Proxy + Next.js on single port (4040)
 *
 * This starts both the proxy server and Next.js web UI on a single port.
 * Routes:
 * - /admin/*      → Proxy admin API
 * - /chat/*, /v1/* → Proxy routing
 * - *             → Next.js app (web UI + /api/* endpoints)
 */
import { createRateLimiterPlugin } from "./rate-limiter.js";
import { createRetryPlugin } from "./retry-plugin.js";
import { resolveConfig } from "./config.js";
import { createCombinedProxy } from "./combined-server.js";
import { initDb } from "@contextio/core/db";
import { decrypt } from "@contextio/logger";
async function loadPluginsFromEnv() {
    const pluginsEnv = process.env.CONTEXT_PROXY_PLUGINS;
    if (!pluginsEnv)
        return [];
    const specifiers = pluginsEnv
        .split(",")
        .map((s) => s.trim())
        .filter(Boolean);
    const plugins = [];
    for (const specifier of specifiers) {
        try {
            const mod = await import(specifier);
            const factory = mod.default ?? mod;
            if (typeof factory === "function") {
                const plugin = factory();
                if (plugin && typeof plugin === "object" && plugin.name) {
                    plugins.push(plugin);
                    console.log(`Loaded plugin: ${plugin.name} (from ${specifier})`);
                }
                else {
                    console.error(`Plugin "${specifier}": factory did not return a valid plugin object`);
                }
            }
            else if (factory && typeof factory === "object" && factory.name) {
                plugins.push(factory);
                console.log(`Loaded plugin: ${factory.name} (from ${specifier})`);
            }
            else {
                console.error(`Plugin "${specifier}": module does not export a plugin or factory`);
            }
        }
        catch (err) {
            console.error(`Failed to load plugin "${specifier}":`, err instanceof Error ? err.message : String(err));
        }
    }
    return plugins;
}
async function main() {
    // Initialize database (runs migrations and seeds default providers)
    initDb(decrypt);
    // CSRF_SECRET is provided via environment variable (set by Coolify at runtime)
    if (process.env.CSRF_SECRET) {
        console.log("CSRF_SECRET found in environment");
    }
    else {
        console.warn("CSRF_SECRET not found - CSRF protection will fail in production");
    }
    // Resolve config first to get per-provider rate limit settings
    const config = resolveConfig();
    // Load plugins from env
    const plugins = await loadPluginsFromEnv();
    // Check if rate limiter is globally disabled via environment variable
    const rateLimiterEnabled = process.env.RATE_LIMITER_ENABLED !== "false";
    // Create rate-limiter plugin with resolved per-provider config
    // The config.rateLimiter has per-provider settings from database + env overrides
    const providers = {};
    for (const [provider, rlConfig] of Object.entries(config.rateLimiter)) {
        providers[provider] = {
            maxRequests: rlConfig.maxRequests,
            windowMs: rlConfig.windowMs,
            bufferCapacity: rlConfig.bufferCapacity,
        };
    }
    const rateLimiterPlugin = createRateLimiterPlugin({
        defaults: {
            maxRequests: config.rateLimiter.openai.maxRequests,
            windowMs: config.rateLimiter.openai.windowMs,
            bufferCapacity: config.rateLimiter.openai.bufferCapacity,
        },
        providers,
        enabled: rateLimiterEnabled,
    });
    // Create retry plugin with resolved per-provider config
    const retryProviders = {};
    for (const [provider, retryConfig] of Object.entries(config.retry)) {
        retryProviders[provider] = {
            maxRetries: retryConfig.maxRetries,
            baseDelayMs: retryConfig.baseDelayMs,
            maxDelayMs: retryConfig.maxDelayMs,
            retryableStatuses: retryConfig.retryableStatuses,
            jitterFactor: retryConfig.jitterFactor,
        };
    }
    const retryPlugin = createRetryPlugin({
        maxRetries: config.retry.openai.maxRetries,
        baseDelayMs: config.retry.openai.baseDelayMs,
        maxDelayMs: config.retry.openai.maxDelayMs,
        retryableStatuses: config.retry.openai.retryableStatuses,
        jitterFactor: config.retry.openai.jitterFactor,
        providers: retryProviders,
    });
    // Replace any rate-limiter/retry plugin loaded from env with our properly configured ones
    const filteredPlugins = plugins.filter(p => p.name !== "rate-limiter" && p.name !== "retry");
    filteredPlugins.push(rateLimiterPlugin, retryPlugin);
    console.log(`Loaded plugin: rate-limiter (with per-provider config from database, enabled=${rateLimiterEnabled})`);
    for (const [provider, rlConfig] of Object.entries(config.rateLimiter)) {
        console.log(`  ${provider}: maxRequests=${rlConfig.maxRequests}, windowMs=${rlConfig.windowMs}, buffer=${rlConfig.bufferCapacity}`);
    }
    console.log(`Loaded plugin: retry (with per-provider config from database)`);
    for (const [provider, retryConfig] of Object.entries(config.retry)) {
        console.log(`  ${provider}: maxRetries=${retryConfig.maxRetries}, baseDelayMs=${retryConfig.baseDelayMs}, maxDelayMs=${retryConfig.maxDelayMs}`);
    }
    const logTraffic = process.env.LOG_TRAFFIC === "true";
    const proxy = createCombinedProxy({ plugins: filteredPlugins, logTraffic });
    await proxy.start();
    // Keep the process alive
    process.stdin.resume();
    let shuttingDown = false;
    const shutdown = () => {
        if (shuttingDown)
            return;
        shuttingDown = true;
        proxy.stop().then(() => process.exit(0));
    };
    process.on("SIGINT", shutdown);
    process.on("SIGTERM", shutdown);
}
main().catch((err) => {
    console.error("Fatal:", err);
    process.exit(1);
});
//# sourceMappingURL=combined-entry.js.map