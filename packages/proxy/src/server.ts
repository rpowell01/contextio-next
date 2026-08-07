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

import type { EncryptionAtRestConfig, ProxyPlugin } from "@contextio/core";
import { createLoggerPlugin, decrypt } from "@contextio/logger";
import { createRateLimiterPlugin } from "./rate-limiter.js";
import { createRetryPlugin } from "./retry-plugin.js";
import { initDb } from "@contextio/core/db";

import { createProxy } from "./proxy.js";
import { resolveConfig } from "./config.js";

/** Dynamically load plugins from the CONTEXT_PROXY_PLUGINS env var.
 *
 * Accepts comma-separated module specifiers (npm packages or file paths).
 * Each module can export either:
 * - A factory function (called with no args, must return a ProxyPlugin)
 * - A ProxyPlugin object directly
 */
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
				// Module exports a plugin directly
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

	// Create rate-limiter plugin with resolved per-provider config
	// The config.rateLimiter has per-provider settings from database + env overrides
	const rateLimiterEnabled = process.env.RATE_LIMITER_ENABLED !== "false";
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
		enabled: resolved.retry.openai.enabled,
		providers: retryProviders,
	});

	// Add built-in plugins first (order matters: rate-limiter before retry for proper metrics)
	plugins.push(rateLimiterPlugin, retryPlugin);
	console.log(`Loaded plugin: rate-limiter (with per-provider config, enabled=${rateLimiterEnabled})`);
	for (const [provider, rlConfig] of Object.entries(resolved.rateLimiter)) {
		console.log(`  ${provider}: maxRequests=${rlConfig.maxRequests}, windowMs=${rlConfig.windowMs}, buffer=${rlConfig.bufferCapacity}`);
	}
	console.log(`Loaded plugin: retry (with per-provider config from database)`);
	for (const [provider, retryConfig] of Object.entries(resolved.retry)) {
		console.log(`  ${provider}: maxRetries=${retryConfig.maxRetries}, baseDelayMs=${retryConfig.baseDelayMs}, maxDelayMs=${retryConfig.maxDelayMs}, maxStreamRetries=${retryConfig.maxStreamRetries}, maxResponseBufferSize=${retryConfig.maxResponseBufferSize}, enabled=${retryConfig.enabled}`);
	}

	const fromEnv = await loadPluginsFromEnv();
	// Replace any rate-limiter/retry plugin loaded from env with our properly configured ones
	const filteredFromEnv = fromEnv.filter(p => p.name !== "rate-limiter" && p.name !== "retry");
	plugins.push(...filteredFromEnv);

	// Construct logger plugin with encryption config if enabled
	const loggerPlugin = buildLoggerPlugin(resolved.loggerEncryption);
	if (loggerPlugin) {
		plugins.push(loggerPlugin);
		console.log("[startup] Logger encryption enabled");
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