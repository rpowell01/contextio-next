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

import type { EncryptionAtRestConfig, ProxyPlugin } from "@contextio/core";
import { createRateLimiterPlugin } from "./rate-limiter.js";
import { createRetryPlugin } from "./retry-plugin.js";
import { resolveConfig } from "./config.js";
import { createCombinedProxy } from "./combined-server.js";
import { initDb } from "@contextio/core/db";
import { decrypt } from "@contextio/logger";
import { createLoggerPlugin } from "@contextio/logger";

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
		maxEntries: Number.parseInt(process.env.CONTEXTIO_RATE_LIMIT_MAX_ENTRIES || "2000", 10),
		cleanupIntervalMs: Number.parseInt(process.env.CONTEXTIO_RATE_LIMIT_CLEANUP_INTERVAL_MS || "60000", 10),
		entryTtlMs: Number.parseInt(process.env.CONTEXTIO_RATE_LIMIT_ENTRY_TTL_MS || "300000", 10),
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
		maxEntries: Number.parseInt(process.env.CONTEXTIO_RETRY_MAX_ENTRIES || "1000", 10),
		entryTtlMs: Number.parseInt(process.env.CONTEXTIO_RETRY_ENTRY_TTL_MS || "300000", 10),
		cleanupIntervalMs: Number.parseInt(process.env.CONTEXTIO_RETRY_CLEANUP_INTERVAL_MS || "30000", 10),
		maxBufferSize: Number.parseInt(process.env.CONTEXTIO_RETRY_MAX_BUFFER_SIZE || "5242880", 10),
		maxStreamRetries: Number.parseInt(process.env.CONTEXTIO_RETRY_MAX_STREAM_RETRIES || "3", 10),
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
				const redactPlugin = await redactFactory();
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

	// Load logger plugin if enabled
	if (loggerEnabled) {
		try {
			console.log("[startup] Encryption at rest configuration:");
			console.log(`  enabled: ${config.loggerEncryption.enabled}`);
			console.log(`  keyProvider: ${config.loggerEncryption.keyProvider}`);
			console.log(`  keyEnvVar: ${config.loggerEncryption.keyEnvVar ?? "CONTEXTIO_LOGGER_ENCRYPTION_KEY"}`);
			console.log(`  keyLength: ${config.loggerEncryption.keyLength} bytes`);
			console.log(`  staticKey provided: ${!!config.loggerEncryption.staticKey}`);
			console.log(`  ${config.loggerEncryption.keyEnvVar ?? "CONTEXTIO_LOGGER_ENCRYPTION_KEY"} environment variable: ${!!process.env[config.loggerEncryption.keyEnvVar ?? "CONTEXTIO_LOGGER_ENCRYPTION_KEY"] ? "SET" : "NOT SET"}`);

			if (config.loggerEncryption.enabled) {
				const keyProvider = config.loggerEncryption.keyProvider;
				const keyEnvVar = config.loggerEncryption.keyEnvVar ?? "CONTEXTIO_LOGGER_ENCRYPTION_KEY";
				const hasStaticKey = !!config.loggerEncryption.staticKey;
				const hasEnvKey = !!process.env[keyEnvVar];
				const keyAvailable = hasStaticKey || hasEnvKey;
				if (!keyAvailable) {
					console.error(
						`[startup] Encryption at rest is ENABLED but NO KEY MATERIAL is available! ` +
						`Set ${keyEnvVar} environment variable or provide staticKey.`
					);
				}
			}

			const loggerPlugin = createLoggerPlugin({
				captureDir: config.loggerCaptureDir,
				encryption: {
					enabled: config.loggerEncryption.enabled,
					keyProvider: config.loggerEncryption.keyProvider,
					staticKey: config.loggerEncryption.staticKey,
					keyEnvVar: config.loggerEncryption.keyEnvVar,
					keyLength: config.loggerEncryption.keyLength,
				},
			});
			plugins.push(loggerPlugin);
			console.log("[startup] Logger plugin enabled");
		} catch (err: unknown) {
			console.error(
				`Initializing logger plugin failed:`,
				err instanceof Error ? err.message : String(err),
			);
			process.exit(1);
		}
	}

	const logTraffic = process.env.LOG_TRAFFIC === "true";
	const proxy = createCombinedProxy({ plugins, logTraffic });
	await proxy.start();

	// Periodic garbage collection to prevent memory creep under sustained load
	// Only runs if --expose-gc flag is set (NODE_OPTIONS=--expose-gc)
	if (typeof global.gc === "function") {
		const GC_INTERVAL_MS = 30_000; // Check every 30 seconds (was 60s)
		const HEAP_THRESHOLD_MB = 512; // Trigger GC if heap exceeds 512MB (was 1GB)
		setInterval(() => {
			const usage = process.memoryUsage();
			const heapUsedMB = Math.round(usage.heapUsed / 1024 / 1024);
			if (heapUsedMB > HEAP_THRESHOLD_MB) {
				console.log(`[GC] Heap usage ${heapUsedMB}MB > ${HEAP_THRESHOLD_MB}MB, triggering GC`);
				global.gc!();
				// Log post-GC stats
				const after = process.memoryUsage();
				console.log(`[GC] Post-GC heap: ${Math.round(after.heapUsed / 1024 / 1024)}MB (freed ${heapUsedMB - Math.round(after.heapUsed / 1024 / 1024)}MB)`);
			}
		}, GC_INTERVAL_MS);
	} else if (process.env.NODE_OPTIONS?.includes("--expose-gc")) {
		console.warn("[GC] --expose-gc detected but global.gc not available (may need --expose-gc flag at startup)");
	}

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