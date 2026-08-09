#!/usr/bin/env node

/**
 * Combined entry point: Proxy + Next.js on single port (4040)
 *
 * This starts both the proxy server and Next.js web UI on a single port.
 * Routes:
 * - /admin/*      → Proxy admin API
 * - /chat/*, /v1/* → Proxy routing
 * - *             → Next.js app (web UI + /api/* endpoints)
 *
 * Built-in plugins controlled by environment variables:
 * - CONTEXTIO_ENABLE_LOGGER (default: true) - Enable logger plugin
 * - CONTEXTIO_ENABLE_REDACT (default: true) - Enable redact plugin
 * - CONTEXTIO_ENABLE_RATE_LIMITER (default: true) - Enable rate limiter plugin
 * - Retry plugin is enabled when rate limiter is enabled
 */

import type { ProxyPlugin } from "@contextio/core";
import { createRateLimiterPlugin } from "./rate-limiter.js";
import { createRetryPlugin } from "./retry-plugin.js";
import { resolveConfig } from "./config.js";
import { createCombinedProxy } from "./combined-server.js";
import { initDb } from "@contextio/core/db";
import { decrypt } from "@contextio/logger";

async function main(): Promise<void> {
	// Resolve config first to get encryption key material for database initialization
	const config = resolveConfig();

	// Initialize database (runs migrations and seeds default providers)
	// Pass keyMaterial for encrypted capture auto-migration on fresh databases
	const keyMaterial = config.loggerEncryption.staticKey ?? process.env[config.loggerEncryption.keyEnvVar ?? "CONTEXTIO_LOGGER_ENCRYPTION_KEY"];
	initDb(decrypt, keyMaterial);

	// CSRF_SECRET is provided via environment variable (set by Coolify at runtime)
  if (process.env.CSRF_SECRET) {
    console.log("CSRF_SECRET found in environment");
  } else {
    console.warn("CSRF_SECRET not found - CSRF protection will fail in production");
  }

	// Check enable flags (default to true)
	const loggerEnabled = process.env.CONTEXTIO_ENABLE_LOGGER !== "false";
	const redactEnabled = process.env.CONTEXTIO_ENABLE_REDACT !== "false";
	const rateLimiterEnabled = process.env.CONTEXTIO_ENABLE_RATE_LIMITER !== "false";
	// Retry plugin is enabled when rate limiter is enabled
	const retryEnabled = rateLimiterEnabled;

	const plugins: ProxyPlugin[] = [];

	// Create rate-limiter plugin with resolved per-provider config
	// The config.rateLimiter has per-provider settings from database + env overrides
	const providers: Record<string, { maxRequests: number; windowMs: number; bufferCapacity: number }> = {};
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
	const retryProviders: Record<string, { maxRetries: number; baseDelayMs: number; maxDelayMs: number; retryableStatuses: number[]; jitterFactor: number }> = {};
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
		enabled: retryEnabled,
	});

	// Add built-in plugins based on enable flags
	if (rateLimiterEnabled) {
		plugins.push(rateLimiterPlugin);
		console.log(`Loaded plugin: rate-limiter (with per-provider config from database, enabled=${rateLimiterEnabled})`);
		for (const [provider, rlConfig] of Object.entries(config.rateLimiter)) {
			console.log(`  ${provider}: maxRequests=${rlConfig.maxRequests}, windowMs=${rlConfig.windowMs}, buffer=${rlConfig.bufferCapacity}`);
		}
	}

	if (retryEnabled) {
		plugins.push(retryPlugin);
		console.log(`Loaded plugin: retry (with per-provider config from database)`);
		for (const [provider, retryConfig] of Object.entries(config.retry)) {
			console.log(`  ${provider}: maxRetries=${retryConfig.maxRetries}, baseDelayMs=${retryConfig.baseDelayMs}, maxDelayMs=${retryConfig.maxDelayMs}`);
		}
	}

	// Load redact plugin if enabled
	if (redactEnabled) {
		try {
			// Import redact factory directly (standard path)
			const redactModule = await import("@contextio/redact/factory");
			const redactFactory = redactModule.default ?? redactModule.createRedactPluginFactory ?? redactModule;
			if (typeof redactFactory === "function") {
				const redactPlugin = redactFactory();
				if (redactPlugin) {
					plugins.push(redactPlugin);
					console.log("Loaded plugin: redact (from @contextio/redact/factory)");
				} else {
					console.log("Redact plugin disabled (no configuration found)");
				}
			}
		} catch (err: unknown) {
			console.warn(
				`Failed to load redact plugin:`,
				err instanceof Error ? err.message : String(err),
			);
		}
	}

	// Note: Logger plugin is handled separately in the web UI for the combined entry point
	// The logger plugin runs as part of the capture system via the proxy core

	const logTraffic = process.env.LOG_TRAFFIC === "true";
	const proxy = createCombinedProxy({ plugins, logTraffic });
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