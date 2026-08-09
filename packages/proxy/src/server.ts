#!/usr/bin/env node

/**
 * Standalone entry point for `@contextio/proxy`.
 *
 * Starts the proxy server with built-in plugins controlled by environment variables:
 * - CONTEXTIO_ENABLE_LOGGER (default: true) - Enable logger plugin
 * - CONTEXTIO_ENABLE_REDACT (default: true) - Enable redact plugin
 * - CONTEXTIO_ENABLE_RATE_LIMITER (default: true) - Enable rate limiter plugin
 * - Retry plugin is enabled when rate limiter is enabled
 *
 * This file is the `context-proxy` binary defined in package.json.
 *
 * Minimal dependencies: @contextio/core and @contextio/logger.
 * API keys flow through this code; keeping imports small means the
 * entire proxy is auditable by reading a handful of packages.
 */

import type { EncryptionAtRestConfig, ProxyPlugin } from "@contextio/core";
import { createLoggerPlugin, decrypt } from "@contextio/logger";
import { createRateLimiterPlugin } from "./rate-limiter.js";
import { createRetryPlugin } from "./retry-plugin.js";
import { initDb } from "@contextio/core/db";

import { createProxy } from "./proxy.js";
import { resolveConfig } from "./config.js";

/** Build logger plugin from encryption config, or return null if disabled. */
function buildLoggerPlugin(encryption: EncryptionAtRestConfig): ProxyPlugin | null {
	// Log encryption at rest configuration status at container startup
	const encryptionEnabled = encryption.enabled;
	const keyProvider = encryption.keyProvider;
	const keyEnvVar = encryption.keyEnvVar ?? "CONTEXTIO_LOGGER_ENCRYPTION_KEY";
	const keyLength = encryption.keyLength;
	const hasStaticKey = !!encryption.staticKey;
	const envKeyValue = process.env[keyEnvVar];
	const hasEnvKey = !!envKeyValue;

console.log("[startup] Encryption at rest configuration:");
	console.log(`  enabled: ${encryptionEnabled}`);
	console.log(`  keyProvider: ${keyProvider}`);
	console.log(`  keyEnvVar: ${keyEnvVar}`);
	console.log(`  keyLength: ${keyLength} bytes`);
	console.log(`  staticKey provided: ${hasStaticKey}`);
	console.log(`  ${keyEnvVar} environment variable: ${hasEnvKey ? "SET" : "NOT SET"}`);

	if (!encryptionEnabled) {
		console.log("[startup] Encryption at rest is DISABLED");
		return null;
	}

	// Check if key material is available
	const keyAvailable = hasStaticKey || hasEnvKey;
	if (!keyAvailable) {
		console.error(
			`[startup] Encryption at rest is ENABLED but NO KEY MATERIAL is available! ` +
			`Set ${keyEnvVar} environment variable or provide staticKey.`
		);
	}

	try {
		const plugin = createLoggerPlugin({
			encryption: {
				enabled: encryption.enabled,
				keyProvider: encryption.keyProvider,
				staticKey: encryption.staticKey,
				keyEnvVar: encryption.keyEnvVar,
				keyLength: encryption.keyLength,
			},
		});
		console.log("[startup] Encryption at rest is ENABLED and logger plugin initialized");
		return plugin;
	} catch (err: unknown) {
		console.error(
			`Initializing logger plugin failed:`,
			err instanceof Error ? err.message : String(err),
		);
		process.exit(1);
	}
}

async function main(): Promise<void> {
	const resolved = resolveConfig();

	// Initialize database (runs migrations and seeds default providers)
	// Pass keyMaterial for encrypted capture auto-migration on fresh databases
	const keyMaterial = resolved.loggerEncryption.staticKey ?? process.env[resolved.loggerEncryption.keyEnvVar ?? "CONTEXTIO_LOGGER_ENCRYPTION_KEY"];
	initDb(decrypt, keyMaterial);
	const plugins: ProxyPlugin[] = [];

	// Check enable flags (default to true)
	const loggerEnabled = process.env.CONTEXTIO_ENABLE_LOGGER !== "false";
	const redactEnabled = process.env.CONTEXTIO_ENABLE_REDACT !== "false";
	const rateLimiterEnabled = process.env.CONTEXTIO_ENABLE_RATE_LIMITER !== "false";
	// Retry plugin is enabled when rate limiter is enabled
	const retryEnabled = rateLimiterEnabled;

	// Create rate-limiter plugin with resolved per-provider config
	// The config.rateLimiter has per-provider settings from database + env overrides
	const providers: Record<string, { maxRequests: number; windowMs: number; bufferCapacity: number }> = {};
	for (const [provider, rlConfig] of Object.entries(resolved.rateLimiter)) {
		providers[provider] = {
			maxRequests: rlConfig.maxRequests,
			windowMs: rlConfig.windowMs,
			bufferCapacity: rlConfig.bufferCapacity,
		};
	}

	const rateLimiterPlugin = createRateLimiterPlugin({
		defaults: {
			maxRequests: resolved.rateLimiter.openai.maxRequests,
			windowMs: resolved.rateLimiter.openai.windowMs,
			bufferCapacity: resolved.rateLimiter.openai.bufferCapacity,
		},
		providers,
		enabled: rateLimiterEnabled,
	});

	// Create retry plugin with resolved per-provider config
	const retryProviders: Record<string, { maxRetries: number; baseDelayMs: number; maxDelayMs: number; retryableStatuses: number[]; jitterFactor: number; maxStreamRetries: number; maxResponseBufferSize: number; enabled: boolean }> = {};
	for (const [provider, retryConfig] of Object.entries(resolved.retry)) {
		retryProviders[provider] = {
			maxRetries: retryConfig.maxRetries,
			baseDelayMs: retryConfig.baseDelayMs,
			maxDelayMs: retryConfig.maxDelayMs,
			retryableStatuses: retryConfig.retryableStatuses,
			jitterFactor: retryConfig.jitterFactor,
			maxStreamRetries: retryConfig.maxStreamRetries,
			maxResponseBufferSize: retryConfig.maxResponseBufferSize,
			enabled: retryConfig.enabled,
		};
	}

	const retryPlugin = createRetryPlugin({
		maxRetries: resolved.retry.openai.maxRetries,
		baseDelayMs: resolved.retry.openai.baseDelayMs,
		maxDelayMs: resolved.retry.openai.maxDelayMs,
		retryableStatuses: resolved.retry.openai.retryableStatuses,
		jitterFactor: resolved.retry.openai.jitterFactor,
		maxStreamRetries: resolved.retry.openai.maxStreamRetries,
		maxBufferSize: 10 * 1024 * 1024, // 10 MB global default
		enabled: retryEnabled && resolved.retry.openai.enabled,
		providers: retryProviders,
	});

	// Add built-in plugins first (order matters: rate-limiter before retry for proper metrics)
	if (rateLimiterEnabled) {
		plugins.push(rateLimiterPlugin);
		console.log(`Loaded plugin: rate-limiter (with per-provider config, enabled=${rateLimiterEnabled})`);
		for (const [provider, rlConfig] of Object.entries(resolved.rateLimiter)) {
			console.log(`  ${provider}: maxRequests=${rlConfig.maxRequests}, windowMs=${rlConfig.windowMs}, buffer=${rlConfig.bufferCapacity}`);
		}
	}

	if (retryEnabled) {
		plugins.push(retryPlugin);
		console.log(`Loaded plugin: retry (with per-provider config from database)`);
		for (const [provider, retryConfig] of Object.entries(resolved.retry)) {
			console.log(`  ${provider}: maxRetries=${retryConfig.maxRetries}, baseDelayMs=${retryConfig.baseDelayMs}, maxDelayMs=${retryConfig.maxDelayMs}, maxStreamRetries=${retryConfig.maxStreamRetries}, maxResponseBufferSize=${retryConfig.maxResponseBufferSize}, enabled=${retryConfig.enabled}`);
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

	// Construct logger plugin with encryption config if enabled
	if (loggerEnabled) {
		const loggerPlugin = buildLoggerPlugin(resolved.loggerEncryption);
		if (loggerPlugin) {
			plugins.push(loggerPlugin);
			console.log("[startup] Logger plugin enabled");
		} else {
			console.log("[startup] Logger plugin disabled (encryption not enabled)");
		}
	}

	const logTraffic = process.env.LOG_TRAFFIC === "true";
	const proxy = createProxy({ plugins, logTraffic });
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
	console.error("Fatal:", err instanceof Error ? err.message : String(err));
	process.exit(1);
});