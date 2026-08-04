/**
 * Provider repository for SQLite-backed provider storage.
 * Replaces file-based providers.json with database operations.
 */

import { getDb } from "./connection.js";
import type { ProviderConfig, Provider, AuthType, ApiFormat, RateLimitConfig, RetryConfig } from "../types.js";
import fs from "node:fs";

/**
 * Database row type for providers table.
 * Matches the schema in 001_initial_schema.sql
 */
export interface ProviderRow {
	id: string;
	name: string;
	upstream_url: string;
	api_format: string;
	auth_type: string;
	enabled: number;
	rate_limit_max_requests: number | null;
	rate_limit_window_ms: number | null;
	rate_limit_buffer_capacity: number | null;
	retry_max_retries: number | null;
	retry_base_delay_ms: number | null;
	retry_max_delay_ms: number | null;
	retry_retryable_statuses: string | null; // JSON array
	retry_jitter_factor: number | null;
	custom_headers: string | null; // JSON object
	allow_base_url_override: number;
	base_url_override_header: string | null;
	source: string;
	dynamic: number;
	created_at: number;
	updated_at: number;
}

/**
 * Default provider configurations (matching DEFAULT_PROVIDERS in web/lib/providers.ts)
 */
const DEFAULT_PROVIDER_CONFIGS: Omit<ProviderConfig, "rateLimit" | "retry" | "customHeaders" | "authType" | "apiFormat" | "enabled">[] = [
	{ id: "openai", name: "OpenAI", upstreamUrl: "https://api.openai.com", allowBaseUrlOverride: true, baseUrlOverrideHeader: "x-openai-baseurl" },
	{ id: "anthropic", name: "Anthropic", upstreamUrl: "https://api.anthropic.com", allowBaseUrlOverride: true, baseUrlOverrideHeader: "x-anthropic-baseurl" },
	{ id: "chatgpt", name: "ChatGPT", upstreamUrl: "https://chatgpt.com", allowBaseUrlOverride: true, baseUrlOverrideHeader: "x-chatgpt-baseurl" },
	{ id: "gemini", name: "Gemini", upstreamUrl: "https://generativelanguage.googleapis.com", allowBaseUrlOverride: true, baseUrlOverrideHeader: "x-gemini-baseurl" },
	{ id: "vertex", name: "Vertex AI", upstreamUrl: "https://us-central1-aiplatform.googleapis.com", allowBaseUrlOverride: true, baseUrlOverrideHeader: "x-vertex-baseurl" },
	{ id: "nvidia", name: "NVIDIA", upstreamUrl: "https://integrate.api.nvidia.com", allowBaseUrlOverride: true, baseUrlOverrideHeader: "x-nvidia-baseurl" },
	{ id: "openrouter", name: "OpenRouter", upstreamUrl: "https://openrouter.ai/api", allowBaseUrlOverride: true, baseUrlOverrideHeader: "x-openrouter-baseurl" },
	{ id: "kilo", name: "Kilo", upstreamUrl: "https://api.kilo.ai/api/gateway", allowBaseUrlOverride: true, baseUrlOverrideHeader: "x-kilo-baseurl" },
	{ id: "geminiCodeAssist", name: "Gemini Code Assist", upstreamUrl: "https://generativelanguage.googleapis.com", allowBaseUrlOverride: true, baseUrlOverrideHeader: "x-gemini-code-assist-baseurl" },
	{ id: "unknown", name: "Unknown", upstreamUrl: "https://unknown.provider", allowBaseUrlOverride: false, baseUrlOverrideHeader: "x-unknown-baseurl" },
];

/**
 * Default rate limit and retry configs
 */
const DEFAULT_RATE_LIMIT: RateLimitConfig = { maxRequests: 60, windowMs: 60000, bufferCapacity: 10 };
const DEFAULT_RETRY: RetryConfig = { maxRetries: 3, baseDelayMs: 1000, maxDelayMs: 30000, retryableStatuses: [429, 500, 502, 503, 504], jitterFactor: 0.2 };
const DEFAULT_AUTH_TYPE: AuthType = "none";
const DEFAULT_API_FORMAT: ApiFormat = "unknown";

/**
 * Convert a database row to a ProviderConfig object.
 */
function rowToProviderConfig(row: ProviderRow): ProviderConfig & { source: string; dynamic: boolean } {
	// Helper to safely parse JSON columns
	function safeJsonParse<T>(value: string | null, fallback: T): T {
		if (!value) return fallback;
		try {
			return JSON.parse(value) as T;
		} catch {
			return fallback;
		}
	}

	return {
		id: row.id as Provider,
		name: row.name,
		upstreamUrl: row.upstream_url,
		apiFormat: row.api_format as ApiFormat,
		authType: row.auth_type as AuthType,
		enabled: row.enabled === 1,
		rateLimit: {
			maxRequests: row.rate_limit_max_requests ?? DEFAULT_RATE_LIMIT.maxRequests,
			windowMs: row.rate_limit_window_ms ?? DEFAULT_RATE_LIMIT.windowMs,
			bufferCapacity: row.rate_limit_buffer_capacity ?? DEFAULT_RATE_LIMIT.bufferCapacity,
		},
		retry: {
			maxRetries: row.retry_max_retries ?? DEFAULT_RETRY.maxRetries,
			baseDelayMs: row.retry_base_delay_ms ?? DEFAULT_RETRY.baseDelayMs,
			maxDelayMs: row.retry_max_delay_ms ?? DEFAULT_RETRY.maxDelayMs,
			retryableStatuses: safeJsonParse(row.retry_retryable_statuses, DEFAULT_RETRY.retryableStatuses),
			jitterFactor: row.retry_jitter_factor ?? DEFAULT_RETRY.jitterFactor,
		},
		customHeaders: safeJsonParse(row.custom_headers, {}),
		allowBaseUrlOverride: row.allow_base_url_override === 1,
		baseUrlOverrideHeader: row.base_url_override_header ?? `x-${row.id}-baseurl`,
		source: row.source,
		dynamic: row.dynamic === 1,
	};
}

/**
 * Convert a ProviderConfig to database column values for insert/update.
 */
function providerConfigToRow(config: ProviderConfig): Omit<ProviderRow, "id" | "created_at" | "updated_at"> {
	return {
		name: config.name,
		upstream_url: config.upstreamUrl,
		api_format: config.apiFormat,
		auth_type: config.authType,
		enabled: config.enabled ? 1 : 0,
		rate_limit_max_requests: config.rateLimit.maxRequests,
		rate_limit_window_ms: config.rateLimit.windowMs,
		rate_limit_buffer_capacity: config.rateLimit.bufferCapacity,
		retry_max_retries: config.retry.maxRetries,
		retry_base_delay_ms: config.retry.baseDelayMs,
		retry_max_delay_ms: config.retry.maxDelayMs,
		retry_retryable_statuses: JSON.stringify(config.retry.retryableStatuses),
		retry_jitter_factor: config.retry.jitterFactor,
		custom_headers: JSON.stringify(config.customHeaders),
		allow_base_url_override: config.allowBaseUrlOverride ? 1 : 0,
		base_url_override_header: config.baseUrlOverrideHeader,
		source: "file",
		dynamic: 1,
	};
}

/**
 * Create a new provider in the database.
 * @throws {Error} If provider with the same ID already exists.
 */
export function createProvider(config: ProviderConfig): ProviderConfig {
	const db = getDb();
	const row = providerConfigToRow(config);

	const stmt = db.prepare(`
		INSERT INTO providers (
			id, name, upstream_url, api_format, auth_type, enabled,
			rate_limit_max_requests, rate_limit_window_ms, rate_limit_buffer_capacity,
			retry_max_retries, retry_base_delay_ms, retry_max_delay_ms,
			retry_retryable_statuses, retry_jitter_factor, custom_headers,
			allow_base_url_override, base_url_override_header, source, dynamic
		) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
	`);

	try {
		stmt.run(
			config.id,
			row.name,
			row.upstream_url,
			row.api_format,
			row.auth_type,
			row.enabled,
			row.rate_limit_max_requests,
			row.rate_limit_window_ms,
			row.rate_limit_buffer_capacity,
			row.retry_max_retries,
			row.retry_base_delay_ms,
			row.retry_max_delay_ms,
			row.retry_retryable_statuses,
			row.retry_jitter_factor,
			row.custom_headers,
			row.allow_base_url_override,
			row.base_url_override_header,
			row.source,
			row.dynamic
		);
	} catch (err) {
		if (err instanceof Error && err.message.includes("UNIQUE constraint failed")) {
			throw new Error(`Provider with id "${config.id}" already exists`);
		}
		throw err;
	}

	return config;
}

/**
 * Get a provider by ID from the database.
 * Returns null if not found.
 */
export function getProviderById(id: string): ProviderConfigWithMeta | null {
	const db = getDb();
	const row = db.prepare("SELECT * FROM providers WHERE id = ?").get(id) as ProviderRow | undefined;
	return row ? rowToProviderConfig(row) : null;
}

/**
 * ProviderConfig with source and dynamic fields from database.
 */
export interface ProviderConfigWithMeta extends ProviderConfig {
	source: string;
	dynamic: boolean;
}

/**
 * Get all providers from the database.
 * Returns a map keyed by provider ID.
 */
export function getAllProvidersFromDb(): Map<string, ProviderConfigWithMeta> {
	const db = getDb();
	const rows = db.prepare("SELECT * FROM providers").all() as ProviderRow[];
	const map = new Map<string, ProviderConfigWithMeta>();
	for (const row of rows) {
		map.set(row.id, rowToProviderConfig(row));
	}
	return map;
}

/**
 * Update an existing provider in the database.
 * @throws {Error} If provider with the given ID does not exist.
 */
export function updateProvider(id: string, config: ProviderConfig): ProviderConfig {
	if (config.id !== id) {
		throw new Error(`Provider id mismatch: URL has "${id}", body has "${config.id}"`);
	}

	const db = getDb();

	// Fetch existing provider to preserve source and dynamic fields
	const existingRow = db.prepare("SELECT source, dynamic FROM providers WHERE id = ?").get(id) as
		| { source: string; dynamic: number }
		| undefined;

	if (!existingRow) {
		throw new Error(`Provider with id "${id}" not found`);
	}

	const row = providerConfigToRow(config);

	const stmt = db.prepare(`
		UPDATE providers SET
			name = ?,
			upstream_url = ?,
			api_format = ?,
			auth_type = ?,
			enabled = ?,
			rate_limit_max_requests = ?,
			rate_limit_window_ms = ?,
			rate_limit_buffer_capacity = ?,
			retry_max_retries = ?,
			retry_base_delay_ms = ?,
			retry_max_delay_ms = ?,
			retry_retryable_statuses = ?,
			retry_jitter_factor = ?,
			custom_headers = ?,
			allow_base_url_override = ?,
			base_url_override_header = ?,
			source = ?,
			dynamic = ?
		WHERE id = ?
	`);

	const result = stmt.run(
		row.name,
		row.upstream_url,
		row.api_format,
		row.auth_type,
		row.enabled,
		row.rate_limit_max_requests,
		row.rate_limit_window_ms,
		row.rate_limit_buffer_capacity,
		row.retry_max_retries,
		row.retry_base_delay_ms,
		row.retry_max_delay_ms,
		row.retry_retryable_statuses,
		row.retry_jitter_factor,
		row.custom_headers,
		row.allow_base_url_override,
		row.base_url_override_header,
		existingRow.source,  // Preserve original source
		existingRow.dynamic, // Preserve original dynamic
		id
	);

	if (result.changes === 0) {
		throw new Error(`Provider with id "${id}" not found`);
	}

	return config;
}

/**
 * Delete a provider from the database.
 * @throws {Error} If provider with the given ID does not exist.
 */
export function deleteProvider(id: string): void {
	const db = getDb();
	const result = db.prepare("DELETE FROM providers WHERE id = ?").run(id);
	if (result.changes === 0) {
		throw new Error(`Provider with id "${id}" not found`);
	}
}

/**
 * Check if a provider exists in the database.
 */
export function providerExists(id: string): boolean {
	const db = getDb();
	const row = db.prepare("SELECT 1 FROM providers WHERE id = ?").get(id);
	return row !== undefined;
}

/**
 * Get all providers merged with defaults and environment variables.
 * This mirrors the logic in packages/web/lib/providers.ts getAllProviders().
 */
export interface MergedProvider {
	id: string;
	name: string;
	upstreamUrl: string;
	apiFormat: ApiFormat;
	authType: AuthType;
	enabled: boolean;
	rateLimit: RateLimitConfig;
	retry: RetryConfig;
	customHeaders: Record<string, string>;
	allowBaseUrlOverride: boolean;
	baseUrlOverrideHeader: string;
	source: "default" | "env" | "file";
	dynamic: boolean;
	models?: string[];
}

const ENV_PROVIDER_MAP: Record<string, string> = {
	openai: "UPSTREAM_OPENAI_URL",
	anthropic: "UPSTREAM_ANTHROPIC_URL",
	chatgpt: "UPSTREAM_CHATGPT_URL",
	gemini: "UPSTREAM_GEMINI_URL",
	geminiCodeAssist: "UPSTREAM_GEMINI_CODE_ASSIST_URL",
	vertex: "UPSTREAM_VERTEX_URL",
	nvidia: "UPSTREAM_NVIDIA_URL",
	openrouter: "UPSTREAM_OPENROUTER_URL",
	kilo: "UPSTREAM_KILO_URL",
};

function getEnvProviders(): MergedProvider[] {
	const providers: MergedProvider[] = [];
	for (const [id, envVar] of Object.entries(ENV_PROVIDER_MAP)) {
		const url = process.env[envVar];
		if (url) {
			providers.push({
				id,
				name: id.replace(/([A-Z])/g, " $1").replace(/^./, (s) => s.toUpperCase()).trim(),
				upstreamUrl: url.replace(/\/v1$/, ""),
				apiFormat: DEFAULT_API_FORMAT,
				authType: DEFAULT_AUTH_TYPE,
				enabled: true,
				rateLimit: DEFAULT_RATE_LIMIT,
				retry: DEFAULT_RETRY,
				customHeaders: {},
				allowBaseUrlOverride: true,
				baseUrlOverrideHeader: `x-${id}-baseurl`,
				source: "env",
				dynamic: false,
			});
		}
	}
	return providers;
}

export function getAllMergedProviders(): MergedProvider[] {
	const dbProviders = getAllProvidersFromDb();
	const merged = new Map<string, MergedProvider>();

	// 1. Default providers (lowest priority) - hardcoded defaults
	for (const def of DEFAULT_PROVIDER_CONFIGS) {
		merged.set(def.id, {
			...def,
			apiFormat: DEFAULT_API_FORMAT,
			authType: DEFAULT_AUTH_TYPE,
			enabled: true,
			rateLimit: DEFAULT_RATE_LIMIT,
			retry: DEFAULT_RETRY,
			customHeaders: {},
			source: "default",
			dynamic: false,
		});
	}

	// 2. Environment variable providers (medium priority) - override defaults
	for (const env of getEnvProviders()) {
		merged.set(env.id, env);
	}

	// 3. Database/file providers (highest priority) - only user-created providers override env
	// Default providers from DB (source="default") should NOT override env vars
	for (const [id, config] of dbProviders) {
		// Only user-created (file) providers override env/default
		if (config.source === "file" && config.dynamic) {
			merged.set(id, {
				...config,
				source: config.source as "default" | "env" | "file",
				dynamic: config.dynamic,
			});
		}
		// For default providers from DB, they're already covered by hardcoded defaults
		// Env providers already override them in step 2
	}

	return Array.from(merged.values());
}

/**
 * Initialize default providers in the database if they don't exist.
 * This ensures the database has baseline providers even if providers.json was never migrated.
 */
export function ensureDefaultProviders(): void {
	const db = getDb();
	const existing = getAllProvidersFromDb();

	for (const def of DEFAULT_PROVIDER_CONFIGS) {
		if (!existing.has(def.id)) {
			const config: ProviderConfig = {
				...def,
				apiFormat: DEFAULT_API_FORMAT,
				authType: DEFAULT_AUTH_TYPE,
				enabled: true,
				rateLimit: DEFAULT_RATE_LIMIT,
				retry: DEFAULT_RETRY,
				customHeaders: {},
			};
			createDefaultProvider(config);
		}
	}
}

/**
 * Create a default provider in the database with source="default" and dynamic=false.
 * Used by ensureDefaultProviders() to seed baseline providers.
 */
function createDefaultProvider(config: ProviderConfig): void {
	const db = getDb();
	const row = providerConfigToRow(config);

	const stmt = db.prepare(`
		INSERT INTO providers (
			id, name, upstream_url, api_format, auth_type, enabled,
			rate_limit_max_requests, rate_limit_window_ms, rate_limit_buffer_capacity,
			retry_max_retries, retry_base_delay_ms, retry_max_delay_ms,
			retry_retryable_statuses, retry_jitter_factor, custom_headers,
			allow_base_url_override, base_url_override_header, source, dynamic
		) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
	`);

	try {
		stmt.run(
			config.id,
			row.name,
			row.upstream_url,
			row.api_format,
			row.auth_type,
			row.enabled,
			row.rate_limit_max_requests,
			row.rate_limit_window_ms,
			row.rate_limit_buffer_capacity,
			row.retry_max_retries,
			row.retry_base_delay_ms,
			row.retry_max_delay_ms,
			row.retry_retryable_statuses,
			row.retry_jitter_factor,
			row.custom_headers,
			row.allow_base_url_override,
			row.base_url_override_header,
			"default", // source
			0        // dynamic
		);
	} catch (err) {
		if (err instanceof Error && err.message.includes("UNIQUE constraint failed")) {
			// Already exists, ignore
		} else {
			throw err;
		}
	}
}

/**
 * Import providers from a providers.json file into the database.
 * This is used for one-time migration from file-based to SQLite storage.
 * 
 * @param filePath - Path to the providers.json file (defaults to PROVIDERS_FILE env var or /app/custom-policy/providers.json)
 * @returns Number of providers imported
 */
export function importProvidersFromJson(filePath?: string): number {
	const providersFile = filePath || process.env.PROVIDERS_FILE || "/app/custom-policy/providers.json";
	
	if (!fs.existsSync(providersFile)) {
		console.log(`[provider-repo] No providers.json found at ${providersFile}, skipping import`);
		return 0;
	}
	
	try {
		const raw = fs.readFileSync(providersFile, "utf8");
		const parsed = JSON.parse(raw);
		
		let imported = 0;
		
		// Handle both array and object formats
		const entries = Array.isArray(parsed)
			? parsed.map((item: any, index: number) => [String(index), item] as [string, any])
			: Object.entries(parsed);
		
		for (const [key, value] of entries) {
			if (typeof value !== "object" || value === null) continue;
			
			const config = value as Record<string, unknown>;
			const providerId = config.id as string;
			const finalKey = Array.isArray(parsed) ? providerId : key;
			
			if (!providerId) continue;
			
			// Check if already exists
			if (providerExists(finalKey)) {
				console.log(`[provider-repo] Provider "${finalKey}" already exists in database, skipping`);
				continue;
			}
			
			// Build ProviderConfig from JSON
			const providerConfig: ProviderConfig = {
				id: finalKey as Provider,
				name: config.name as string || finalKey,
				upstreamUrl: config.upstreamUrl as string || "",
				apiFormat: (config.apiFormat as ApiFormat) || DEFAULT_API_FORMAT,
				authType: (config.authType as AuthType) || DEFAULT_AUTH_TYPE,
				enabled: config.enabled !== false,
				rateLimit: config.rateLimit as RateLimitConfig || DEFAULT_RATE_LIMIT,
				retry: config.retry as RetryConfig || DEFAULT_RETRY,
				customHeaders: config.customHeaders as Record<string, string> || {},
				allowBaseUrlOverride: (config.allowBaseUrlOverride as boolean) ?? true,
				baseUrlOverrideHeader: config.baseUrlOverrideHeader as string || `x-${finalKey}-baseurl`,
			};
			
			// Validate required fields
			if (!providerConfig.upstreamUrl) {
				console.warn(`[provider-repo] Skipping provider "${finalKey}": missing upstreamUrl`);
				continue;
			}
			
			try {
				createProvider(providerConfig);
				imported++;
				console.log(`[provider-repo] Imported provider "${finalKey}" from providers.json`);
			} catch (err) {
				console.warn(`[provider-repo] Failed to import provider "${finalKey}": ${err instanceof Error ? err.message : String(err)}`);
			}
		}
		
		return imported;
	} catch (err) {
		console.error(`[provider-repo] Failed to read/parse providers.json at ${providersFile}: ${err instanceof Error ? err.message : String(err)}`);
		return 0;
	}
}