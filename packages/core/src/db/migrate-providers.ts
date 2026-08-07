/**
 * Migration utility for importing providers from providers.json into SQLite.
 * Reads the providers.json file, validates each provider config,
 * and inserts them as 'file' source providers.
 */

import fs from "node:fs";
import { join } from "node:path";

import type { 
	ProviderConfig, 
	Provider, 
	RateLimitConfig, 
	RetryConfig, 
	ApiFormat, 
	AuthType 
} from "../types.js";
import { validateProviderConfig, KNOWN_PROVIDERS, KNOWN_API_FORMATS, KNOWN_AUTH_TYPES } from "../types.js";
import { createProvider, updateProvider, getProviderById, getAllProvidersFromDb } from "./provider-repo.js";
import { getDb } from "./connection.js";

/** Options for the provider migration. */
export interface MigrateProvidersOptions {
	/** Custom providers.json file path (defaults to /app/custom-policy/providers.json or PROVIDERS_FILE env var). */
	providersFile?: string;
	/** Force re-import of already-imported providers. */
	force?: boolean;
	/** Dry run mode - preview changes without writing to database. */
	dryRun?: boolean;
	/** Create backup of providers.json before migration. */
	createBackup?: boolean;
}

/** Result of the provider migration. */
export interface MigrateProvidersResult {
	/** Number of providers imported (new). */
	imported: number;
	/** Number of providers updated (existing defaults replaced). */
	updated: number;
	/** Number of providers skipped (already exist as file/env and not forced). */
	skipped: number;
	/** Number of providers that failed validation or import. */
	failed: number;
	/** Total providers in source file. */
	totalProviders: number;
	/** List of failed providers with error messages. */
	errors: Array<{ provider: string; error: string }>;
	/** Path to backup file if created. */
	backupPath?: string;
}

/**
 * Get the default providers.json file path.
 * Uses PROVIDERS_FILE env var or falls back to /app/custom-policy/providers.json.
 */
export function getDefaultProvidersFile(): string {
	return process.env.PROVIDERS_FILE || "/app/custom-policy/providers.json";
}

/**
 * Create a backup of the providers.json file.
 */
function createProvidersBackup(filePath: string): string {
	const backupPath = `${filePath}.backup.${Date.now()}`;
	fs.copyFileSync(filePath, backupPath);
	console.log(`[migrate-providers] Created backup: ${backupPath}`);
	return backupPath;
}

/**
 * Parse providers from a JSON file.
 * Handles both array and object formats.
 */
function parseProvidersFile(filePath: string): Array<{ key: string; config: Record<string, unknown> }> {
	const raw = fs.readFileSync(filePath, "utf8");
	const parsed = JSON.parse(raw);

	const entries: Array<{ key: string; config: Record<string, unknown> }> = [];

	if (Array.isArray(parsed)) {
		for (let i = 0; i < parsed.length; i++) {
			const item = parsed[i];
			if (typeof item === "object" && item !== null) {
				entries.push({ key: String(i), config: item as Record<string, unknown> });
			}
		}
	} else if (typeof parsed === "object" && parsed !== null) {
		for (const [key, value] of Object.entries(parsed)) {
			if (typeof value === "object" && value !== null) {
				entries.push({ key, config: value as Record<string, unknown> });
			}
		}
	}

	return entries;
}

/**
 * Build a ProviderConfig from a parsed JSON object.
 */
function buildProviderConfig(key: string, config: Record<string, unknown>): ProviderConfig {
	const providerId = config.id as string || key;
	
	// Validate providerId against known providers
	if (!KNOWN_PROVIDERS.includes(providerId as Provider)) {
		throw new Error(`Unknown provider: ${providerId}. Must be one of: ${KNOWN_PROVIDERS.join(", ")}`);
	}
	
	// Default values (matching provider-repo.ts defaults)
	const DEFAULT_RATE_LIMIT = { maxRequests: 60, windowMs: 60000, bufferCapacity: 10 };
	const DEFAULT_RETRY = { 
		maxRetries: 3, 
		baseDelayMs: 1000, 
		maxDelayMs: 30000, 
		retryableStatuses: [429, 500, 502, 503, 504], 
		jitterFactor: 0.2, 
		maxStreamRetries: 3, 
		maxResponseBufferSize: 10 * 1024 * 1024, 
		enabled: true 
	};
	const DEFAULT_AUTH_TYPE = "none" as const;
	const DEFAULT_API_FORMAT = "unknown" as const;

	return {
		id: providerId as Provider,
		name: config.name as string || providerId,
		upstreamUrl: config.upstreamUrl as string || "",
		apiFormat: (KNOWN_API_FORMATS.includes(config.apiFormat as ApiFormat) ? config.apiFormat : DEFAULT_API_FORMAT) as ApiFormat,
		authType: (KNOWN_AUTH_TYPES.includes(config.authType as AuthType) ? config.authType : DEFAULT_AUTH_TYPE) as AuthType,
		enabled: (config.enabled as boolean) ?? true,
		rateLimit: (config.rateLimit && typeof config.rateLimit === "object" && "maxRequests" in config.rateLimit)
			? config.rateLimit as RateLimitConfig
			: DEFAULT_RATE_LIMIT,
		retry: (config.retry && typeof config.retry === "object" && "maxRetries" in config.retry)
			? config.retry as RetryConfig
			: DEFAULT_RETRY,
		customHeaders: config.customHeaders as Record<string, string> || {},
		allowBaseUrlOverride: (config.allowBaseUrlOverride as boolean) ?? true,
		baseUrlOverrideHeader: config.baseUrlOverrideHeader as string || `x-${providerId}-baseurl`,
	};
}

/**
 * Migrate providers from providers.json into SQLite database.
 * Reads the providers.json file, validates each provider config,
 * and inserts them as 'file' source providers.
 */
export function migrateProviders(options: MigrateProvidersOptions = {}): MigrateProvidersResult {
	const providersFile = options.providersFile || getDefaultProvidersFile();
	const force = options.force ?? false;
	const dryRun = options.dryRun ?? false;
	const createBackup = options.createBackup ?? true;

	const result: MigrateProvidersResult = {
		imported: 0,
		updated: 0,
		skipped: 0,
		failed: 0,
		totalProviders: 0,
		errors: [],
	};

	// Check if providers file exists
	if (!fs.existsSync(providersFile)) {
		console.log(`[migrate-providers] No providers.json found at ${providersFile}, skipping import`);
		return result;
	}

	// Create backup if requested
	if (createBackup && !dryRun) {
		try {
			result.backupPath = createProvidersBackup(providersFile);
		} catch (err) {
			console.warn(`[migrate-providers] Failed to create backup: ${err instanceof Error ? err.message : String(err)}`);
		}
	}

	// Parse providers
	let entries: Array<{ key: string; config: Record<string, unknown> }>;
	try {
		entries = parseProvidersFile(providersFile);
	} catch (err) {
		result.errors.push({
			provider: "all",
			error: `Failed to parse providers.json: ${err instanceof Error ? err.message : String(err)}`,
		});
		result.failed = 1;
		return result;
	}

	result.totalProviders = entries.length;
	console.log(`[migrate-providers] Found ${entries.length} providers in ${providersFile}`);

	if (entries.length === 0) {
		return result;
	}

	// Process each provider
	for (const { key, config } of entries) {
		try {
			// Build provider config
			const providerConfig = buildProviderConfig(key, config);
			const providerId = providerConfig.id;

			// Validate required fields
			if (!providerConfig.upstreamUrl) {
				throw new Error("missing upstreamUrl");
			}

			// Validate provider config
			validateProviderConfig(providerConfig);

			// Check if already exists
			const existingProvider = getProviderById(providerId);
			if (existingProvider) {
				if (!force) {
					// Skip if already exists and not forced
					if (existingProvider.source === "file" && existingProvider.dynamic) {
						result.skipped++;
						console.log(`[migrate-providers] Provider "${providerId}" already exists as file source, skipping`);
						continue;
					}
					// If it's a default provider, we'll update it
					if (existingProvider.source === "default") {
						console.log(`[migrate-providers] Provider "${providerId}" exists as default, will update with providers.json values`);
					} else {
						result.skipped++;
						console.log(`[migrate-providers] Provider "${providerId}" already exists with source="${existingProvider.source}", skipping`);
						continue;
					}
				}
				// If force=true, we'll update the existing provider regardless of source (file, env, or default)
			}
			
			if (!dryRun) {
				if (existingProvider) {
					// Update existing provider (default, file, or env)
					// For default providers, also change source to 'file' and dynamic to true
					// updateProvider preserves source/dynamic; default providers are reclassified to file via direct UPDATE below
					const db = getDb();
					db.transaction(() => {
						updateProvider(providerId, providerConfig);
						if (existingProvider.source === "default") {
							// updateProvider preserves source/dynamic, so we need a direct UPDATE
							db.prepare("UPDATE providers SET source = 'file', dynamic = 1 WHERE id = ?").run(providerId);
						}
					})();
					if (existingProvider.source === "default") {
						result.updated++;
						console.log(`[migrate-providers] Updated provider "${providerId}" from providers.json (default->file)`);
					} else {
						result.updated++;
						console.log(`[migrate-providers] Updated provider "${providerId}" from providers.json (source=${existingProvider.source})`);
					}
				} else {
					// Create new provider
					createProvider(providerConfig);
					result.imported++;
					console.log(`[migrate-providers] Imported provider "${providerId}"`);
				}
			} else {
				if (existingProvider) {
					if (existingProvider.source === "default" || force) {
						// Default providers or force=true: would update
						result.updated++;
					} else {
						// Already exists as file/env without force - count as skipped
						result.skipped++;
					}
				} else {
					result.imported++;
				}
			}

		} catch (err) {
			result.failed++;
			const providerId = config.id as string || key;
			result.errors.push({
				provider: providerId,
				error: err instanceof Error ? err.message : String(err),
			});
			console.warn(`[migrate-providers] Failed to import provider "${providerId}": ${err instanceof Error ? err.message : String(err)}`);
		}
	}

	console.log(`[migrate-providers] Complete: ${result.imported} imported, ${result.updated} updated, ${result.skipped} skipped, ${result.failed} failed`);
	return result;
}

/**
 * Get list of providers that would be imported/updated (dry run preview).
 */
export function previewProvidersMigration(options: MigrateProvidersOptions = {}): MigrateProvidersResult {
	return migrateProviders({ ...options, dryRun: true });
}