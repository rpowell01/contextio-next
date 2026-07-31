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

import type { ProxyPlugin } from "@contextio/core";
import { createRateLimiterPlugin } from "./rate-limiter.js";
import { resolveConfig } from "./config.js";
import { createCombinedProxy } from "./combined-server.js";

async function loadPluginsFromEnv(): Promise<ProxyPlugin[]> {
  const pluginsEnv = process.env.CONTEXT_PROXY_PLUGINS;
  if (!pluginsEnv) return [];

  const specifiers = pluginsEnv
    .split(",")
    .map((s) => s.trim())
    .filter(Boolean);

  const plugins: ProxyPlugin[] = [];
  for (const specifier of specifiers) {
    try {
      const mod = await import(specifier);
      const factory = mod.default ?? mod;
      if (typeof factory === "function") {
        const plugin = factory();
        if (plugin && typeof plugin === "object" && plugin.name) {
          plugins.push(plugin);
          console.log(`Loaded plugin: ${plugin.name} (from ${specifier})`);
        } else {
          console.error(
            `Plugin "${specifier}": factory did not return a valid plugin object`,
          );
        }
      } else if (factory && typeof factory === "object" && factory.name) {
        plugins.push(factory);
        console.log(`Loaded plugin: ${factory.name} (from ${specifier})`);
      } else {
        console.error(
          `Plugin "${specifier}": module does not export a plugin or factory`,
        );
      }
    } catch (err: unknown) {
      console.error(
        `Failed to load plugin "${specifier}":`,
        err instanceof Error ? err.message : String(err),
      );
    }
  }

  return plugins;
}

async function main(): Promise<void> {
  // CSRF_SECRET is provided via environment variable (set by Coolify at runtime)
  if (process.env.CSRF_SECRET) {
    console.log("CSRF_SECRET found in environment");
  } else {
    console.warn("CSRF_SECRET not found - CSRF protection will fail in production");
  }

  // Resolve config first to get per-provider rate limit settings
  const config = resolveConfig();
  
  // Load plugins from env
  const plugins = await loadPluginsFromEnv();
  
  // Create rate-limiter plugin with resolved per-provider config
  // The config.rateLimiter has per-provider settings from database + env overrides
  const rateLimiterPlugin = createRateLimiterPlugin({
    defaults: {
      maxRequests: config.rateLimiter.openai.maxRequests,
      windowMs: config.rateLimiter.openai.windowMs,
      bufferCapacity: config.rateLimiter.openai.bufferCapacity,
    },
    // Use the provider-aware key generator (default uses sessionId:provider)
    // The plugin will use per-provider config via the keyGenerator
  });
  
  // Replace any rate-limiter plugin loaded from env with our properly configured one
  const filteredPlugins = plugins.filter(p => p.name !== "rate-limiter");
  filteredPlugins.push(rateLimiterPlugin);
  
  console.log(`Loaded plugin: rate-limiter (with per-provider config from database)`);
  for (const [provider, rlConfig] of Object.entries(config.rateLimiter)) {
    console.log(`  ${provider}: maxRequests=${rlConfig.maxRequests}, windowMs=${rlConfig.windowMs}, buffer=${rlConfig.bufferCapacity}`);
  }

  const logTraffic = process.env.LOG_TRAFFIC === "true";
  const proxy = createCombinedProxy({ plugins: filteredPlugins, logTraffic });
  await proxy.start();

  // Keep the process alive
  process.stdin.resume();

  let shuttingDown = false;
  const shutdown = (): void => {
    if (shuttingDown) return;
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