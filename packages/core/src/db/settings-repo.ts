/**
 * Settings repository for SQLite-backed settings storage.
 * Replaces file-based settings.json with database operations.
 */

import { getDb } from "./connection.js";
import type { Provider, RateLimitConfig, StreamingRetryConfig } from "../types.js";
import fs from "node:fs";

/** Default redaction configuration per provider. */
const DEFAULT_REDACT_PROVIDERS: Record<Provider, boolean> = {
	anthropic: true,
	openai: true,
	chatgpt: true,
	gemini: true,
	geminiCodeAssist: true,
	vertex: true,
	nvidia: true,
	openrouter: true,
	kilo: true,
};

/**
 * Get the default settings.json file path.
 * Uses SETTINGS_FILE env var or falls back to /app/custom-policy/settings.json.
 */
export function getDefaultSettingsFile(): string {
	return process.env.SETTINGS_FILE || "/app/custom-policy/settings.json";
}

// Re-export types from core types for consumers
export type { RateLimitConfig, StreamingRetryConfig };

/**
 * Database row type for settings table.
 * Matches the schema in 007_settings.sql + 014 migration
 */
export interface SettingsRow {
	id: string;
	log_dir: string;
	max_sessions: number;
	redact_preset: string;
	redact_reversible: number;
	redact_policy_file: string;
	redact_policy_enabled: number;
	encryption_at_rest: number;
	capture_cleanup_enabled: number;
	capture_cleanup_interval_hours: number;
	capture_cleanup_max_age_days: number;
	theme: string;
	oidc_enabled: number;
	oidc_public_url: string;
	oidc_issuer: string;
	show_page_load_time: number;
	feedback_store_enabled: number;
	feedback_store_type: string;
	feedback_store_path: string;
	detector_mode: string;
	detector_model_name: string;
	detector_threshold: number;
	redact_paths_only: string | null; // JSON array of path strings
	redact_paths_skip: string | null; // JSON array of path strings
	redact_disabled_rules: string | null; // JSON array of disabled rule names
	rate_limiter: string; // JSON blob
	streaming_retry: string; // JSON blob
	redact_providers: string; // JSON blob
	// Feature flags (migration 014)
	enable_logger: number;
	enable_redact: number;
	enable_rate_limiter: number;
	log_traffic: number;
	// Advanced rate limiter cache configuration (migration 014)
	rate_limiter_max_entries: number;
	rate_limiter_cleanup_interval_ms: number;
	rate_limiter_entry_ttl_ms: number;
	// Advanced streaming retry cache configuration (migration 014)
	retry_max_entries: number;
	retry_entry_ttl_ms: number;
	retry_cleanup_interval_ms: number;
	retry_max_buffer_size: number;
	retry_max_stream_retries: number;
	// Proxy configuration (migration 014)
	proxy_bind_host: string;
	proxy_port: number;
	proxy_allow_target_override: number;
	strict_url_forwarding: number;
	upstream_openai_url: string;
	upstream_anthropic_url: string;
	upstream_chatgpt_url: string;
	upstream_gemini_url: string;
	upstream_vertex_url: string;
	upstream_nvidia_url: string;
	upstream_openrouter_url: string;
	upstream_kilo_url: string;
	upstream_gemini_code_assist_url: string;
	created_at: number;
	updated_at: number;
}

/**
 * Settings interface (defined locally for database layer, mirrors web/lib/settings.ts)
 * Matches packages/web/lib/settings.ts
 */
export interface Settings {
	logDir: string;
	maxSessions: number;
	redactPreset: "secrets" | "pii" | "strict";
	redactReversible: boolean;
	redactPolicyFile: string;
	redactPolicyEnabled: boolean;
	redactPathsOnly: string[]; // JSON array of path strings for "only" filtering
	redactPathsSkip: string[]; // JSON array of path strings for "skip" filtering
	/** List of redaction rule names to disable (e.g., ["url", "organization", "person"]) */
	redactDisabledRules: string[];
	encryptionAtRest: boolean;
	captureCleanupEnabled: boolean;
	captureCleanupIntervalHours: number;
	captureCleanupMaxAgeDays: number;
	theme:
		| "light"
		| "dark"
		| "system"
		| "high-contrast"
		| "material-light"
		| "material-dark"
		| "solarized-light"
		| "solarized-dark"
		| "dracula"
		| "nord"
		| "github-light"
		| "github-dark"
		| "one-dark"
		| "monokai";
	oidcEnabled: boolean;
	oidcPublicUrl: string;
	oidcIssuer: string;
	showPageLoadTime: boolean;
	detectorMode: "rules" | "llm" | "hybrid" | "auto";
	detectorModelName: string;
	detectorThreshold: number;
	rateLimiter: Record<Provider, RateLimitConfig>;
	streamingRetry: Record<Provider, StreamingRetryConfig>;
	// Redaction enabled per provider (true = redact this provider)
	redactProviders: Record<Provider, boolean>;
	// Feature flags
	enableLogger: boolean;
	enableRedact: boolean;
	enableRateLimiter: boolean;
	logTraffic: boolean;
	// Feedback store settings (for false positive management)
	feedbackStoreEnabled: boolean;
	feedbackStoreType: "sqlite" | "memory";
	feedbackStorePath: string;
	// Advanced rate limiter cache configuration
	rateLimiterMaxEntries: number;
	rateLimiterCleanupIntervalMs: number;
	rateLimiterEntryTtlMs: number;
	// Advanced streaming retry cache configuration
	retryMaxEntries: number;
	retryEntryTtlMs: number;
	retryCleanupIntervalMs: number;
	retryMaxBufferSize: number;
	retryMaxStreamRetries: number;
	// Proxy configuration
	proxyBindHost: string;
	proxyPort: number;
	proxyAllowTargetOverride: boolean;
	strictUrlForwarding: boolean;
	upstreamOpenAiUrl: string;
	upstreamAnthropicUrl: string;
	upstreamChatGptUrl: string;
	upstreamGeminiUrl: string;
	upstreamVertexUrl: string;
	upstreamNvidiaUrl: string;
	upstreamOpenRouterUrl: string;
	upstreamKiloUrl: string;
	upstreamGeminiCodeAssistUrl: string;
}

/**
 * Metadata about where a setting value originated.
 */
export type SettingSource = "settings-file" | "environment-variable" | "default";

export interface SettingMeta {
	source: SettingSource;
	envVar: string | null;
	dynamic: boolean;
}

/**
 * Result of importing settings from a JSON file.
 */
export interface ImportSettingsResult {
	imported: boolean;
	skipped: boolean;
	error?: string;
}

/**
 * Default rate limiter configuration per provider.
 */
const DEFAULT_RATE_LIMITER: Record<Provider, RateLimitConfig> = {
	anthropic: { maxRequests: 60, windowMs: 60000, bufferCapacity: 10 },
	openai: { maxRequests: 60, windowMs: 60000, bufferCapacity: 10 },
	chatgpt: { maxRequests: 60, windowMs: 60000, bufferCapacity: 10 },
	gemini: { maxRequests: 60, windowMs: 60000, bufferCapacity: 10 },
	geminiCodeAssist: { maxRequests: 60, windowMs: 60000, bufferCapacity: 10 },
	vertex: { maxRequests: 60, windowMs: 60000, bufferCapacity: 10 },
	nvidia: { maxRequests: 60, windowMs: 60000, bufferCapacity: 10 },
	openrouter: { maxRequests: 60, windowMs: 60000, bufferCapacity: 10 },
	kilo: { maxRequests: 60, windowMs: 60000, bufferCapacity: 10 },
};

/**
 * Default streaming retry configuration per provider.
 */
const DEFAULT_STREAMING_RETRY: Record<Provider, StreamingRetryConfig> = {
	anthropic: { enabled: true, maxRetries: 3, maxBufferSizeMB: 10 },
	openai: { enabled: true, maxRetries: 3, maxBufferSizeMB: 10 },
	chatgpt: { enabled: true, maxRetries: 3, maxBufferSizeMB: 10 },
	gemini: { enabled: true, maxRetries: 3, maxBufferSizeMB: 10 },
	geminiCodeAssist: { enabled: true, maxRetries: 3, maxBufferSizeMB: 10 },
	vertex: { enabled: true, maxRetries: 3, maxBufferSizeMB: 10 },
	nvidia: { enabled: true, maxRetries: 3, maxBufferSizeMB: 10 },
	openrouter: { enabled: true, maxRetries: 3, maxBufferSizeMB: 10 },
	kilo: { enabled: true, maxRetries: 3, maxBufferSizeMB: 10 },
};

/**
 * Default settings object (matching DEFAULT_SETTINGS from web/lib/settings.ts)
 */
const DEFAULT_SETTINGS: Settings = {
	logDir: "",
	maxSessions: 0,
	redactPreset: "pii",
	redactReversible: false,
	redactPolicyFile: "",
	redactPolicyEnabled: true,
	redactPathsOnly: ["messages[*].content"],
	redactPathsSkip: [
		"tools",
		"tool_calls",
		"toolChoice",
		"tool_choice",
		"functions",
		"function_call",
		"messages[*].tool_calls[*].id",
		"messages[*].tool_calls[*].function.name",
		"messages[*].tool_calls[*].function.arguments",
		"messages[*].tools[*].id",
		"messages[*].tools[*].function.name",
		"messages[*].tools[*].function.arguments",
		"messages[*].function_call.id",
		"messages[*].function_call.name",
		"messages[*].function_call.arguments",
		"tool_calls[*].id",
		"tool_calls[*].function.name",
		"tool_calls[*].function.arguments",
		"tools[*].id",
		"tools[*].function.name",
		"tools[*].function.arguments",
		"function_call.id",
		"function_call.name",
		"function_call.arguments",
		"messages[*].content[*].id",
		"messages[*].content[*].name",
		"messages[*].content[*].input",
		"messages[*].content[*].tool_use_id",
		"messages[*].content[*].content",
		"messages[*].content[*].thinking",
		"messages[*].content[*].signature",
		"messages[*].content[*].type",
		"content[*].id",
		"content[*].name",
		"content[*].input",
		"content[*].tool_use_id",
		"content[*].content",
		"content[*].thinking",
		"content[*].signature",
		"content[*].type",
	],
	/** List of redaction rule names to disable (e.g., ["url", "organization", "person"]) */
	redactDisabledRules: [],
	encryptionAtRest: false,
	captureCleanupEnabled: true,
	captureCleanupIntervalHours: 24,
	captureCleanupMaxAgeDays: 30,
	theme: "system",
	oidcEnabled: false,
	oidcPublicUrl: "",
	oidcIssuer: "",
	showPageLoadTime: false,
	feedbackStoreEnabled: true,
	feedbackStoreType: "sqlite",
	feedbackStorePath: "",
	detectorMode: "rules",
	detectorModelName: "Xenova/bert-base-NER",
	detectorThreshold: 0.5,
	rateLimiter: DEFAULT_RATE_LIMITER,
	streamingRetry: DEFAULT_STREAMING_RETRY,
	// Feature flags
	enableLogger: true,
	enableRedact: true,
	enableRateLimiter: true,
	logTraffic: false,
	// Advanced rate limiter cache configuration
	rateLimiterMaxEntries: 2000,
	rateLimiterCleanupIntervalMs: 60000,
	rateLimiterEntryTtlMs: 300000,
	// Advanced streaming retry cache configuration
	retryMaxEntries: 1000,
	retryEntryTtlMs: 300000,
	retryCleanupIntervalMs: 30000,
	retryMaxBufferSize: 5242880,
	retryMaxStreamRetries: 3,
	// Redaction enabled per provider
	redactProviders: {
		anthropic: true,
		openai: true,
		chatgpt: true,
		gemini: true,
		geminiCodeAssist: true,
		vertex: true,
		nvidia: true,
		openrouter: true,
		kilo: true,
	},
	// Proxy configuration
	proxyBindHost: "0.0.0.0",
	proxyPort: 4040,
	proxyAllowTargetOverride: false,
	strictUrlForwarding: false,
	upstreamOpenAiUrl: "",
	upstreamAnthropicUrl: "",
	upstreamChatGptUrl: "",
	upstreamGeminiUrl: "",
	upstreamVertexUrl: "",
	upstreamNvidiaUrl: "",
	upstreamOpenRouterUrl: "",
	upstreamKiloUrl: "",
	upstreamGeminiCodeAssistUrl: "",
};

/**
 * Convert a database row to a Settings object.
 */
function rowToSettings(row: SettingsRow): Settings {
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
		logDir: row.log_dir,
		maxSessions: row.max_sessions,
		redactPreset: row.redact_preset as Settings["redactPreset"],
		redactReversible: row.redact_reversible === 1,
		redactPolicyFile: row.redact_policy_file,
		redactPolicyEnabled: row.redact_policy_enabled === 1,
		redactPathsOnly: safeJsonParse<string[]>(row.redact_paths_only, DEFAULT_SETTINGS.redactPathsOnly),
		redactPathsSkip: safeJsonParse<string[]>(row.redact_paths_skip, DEFAULT_SETTINGS.redactPathsSkip),
		redactDisabledRules: safeJsonParse<string[]>(row.redact_disabled_rules, DEFAULT_SETTINGS.redactDisabledRules),
		encryptionAtRest: row.encryption_at_rest === 1,
		captureCleanupEnabled: row.capture_cleanup_enabled === 1,
		captureCleanupIntervalHours: row.capture_cleanup_interval_hours,
		captureCleanupMaxAgeDays: row.capture_cleanup_max_age_days,
		theme: row.theme as Settings["theme"],
		oidcEnabled: row.oidc_enabled === 1,
		oidcPublicUrl: row.oidc_public_url,
		oidcIssuer: row.oidc_issuer,
		showPageLoadTime: row.show_page_load_time === 1,
		feedbackStoreEnabled: row.feedback_store_enabled === 1,
		feedbackStoreType: row.feedback_store_type as Settings["feedbackStoreType"],
		feedbackStorePath: row.feedback_store_path,
		detectorMode: row.detector_mode as Settings["detectorMode"],
		detectorModelName: row.detector_model_name,
		detectorThreshold: row.detector_threshold,
		rateLimiter: safeJsonParse(row.rate_limiter, DEFAULT_RATE_LIMITER),
		streamingRetry: safeJsonParse(row.streaming_retry, DEFAULT_STREAMING_RETRY),
		redactProviders: safeJsonParse(row.redact_providers, DEFAULT_REDACT_PROVIDERS),
		// Feature flags (migration 014)
		enableLogger: row.enable_logger === 1,
		enableRedact: row.enable_redact === 1,
		enableRateLimiter: row.enable_rate_limiter === 1,
		logTraffic: row.log_traffic === 1,
		// Advanced rate limiter cache configuration (migration 014)
		rateLimiterMaxEntries: row.rate_limiter_max_entries,
		rateLimiterCleanupIntervalMs: row.rate_limiter_cleanup_interval_ms,
		rateLimiterEntryTtlMs: row.rate_limiter_entry_ttl_ms,
		// Advanced streaming retry cache configuration (migration 014)
		retryMaxEntries: row.retry_max_entries,
		retryEntryTtlMs: row.retry_entry_ttl_ms,
		retryCleanupIntervalMs: row.retry_cleanup_interval_ms,
		retryMaxBufferSize: row.retry_max_buffer_size,
		retryMaxStreamRetries: row.retry_max_stream_retries,
		// Proxy configuration (migration 014)
		proxyBindHost: row.proxy_bind_host,
		proxyPort: row.proxy_port,
		proxyAllowTargetOverride: row.proxy_allow_target_override === 1,
		strictUrlForwarding: row.strict_url_forwarding === 1,
		upstreamOpenAiUrl: row.upstream_openai_url || "",
		upstreamAnthropicUrl: row.upstream_anthropic_url || "",
		upstreamChatGptUrl: row.upstream_chatgpt_url || "",
		upstreamGeminiUrl: row.upstream_gemini_url || "",
		upstreamVertexUrl: row.upstream_vertex_url || "",
		upstreamNvidiaUrl: row.upstream_nvidia_url || "",
		upstreamOpenRouterUrl: row.upstream_openrouter_url || "",
		upstreamKiloUrl: row.upstream_kilo_url || "",
		upstreamGeminiCodeAssistUrl: row.upstream_gemini_code_assist_url || "",
	};
}

/**
 * Convert a Settings object to database column values for insert/update.
 * Uses DEFAULT_SETTINGS as fallback for any missing/undefined keys to satisfy NOT NULL constraints.
 */
function settingsToRow(settings: Partial<Settings>): Omit<SettingsRow, "id" | "created_at" | "updated_at"> {
	// Merge with defaults to ensure all required fields are present
	const merged: Settings = { ...DEFAULT_SETTINGS, ...settings };

	return {
		log_dir: merged.logDir,
		max_sessions: merged.maxSessions,
		redact_preset: merged.redactPreset,
		redact_reversible: merged.redactReversible ? 1 : 0,
		redact_policy_file: merged.redactPolicyFile,
		redact_policy_enabled: merged.redactPolicyEnabled ? 1 : 0,
		redact_paths_only: JSON.stringify(merged.redactPathsOnly),
		redact_paths_skip: JSON.stringify(merged.redactPathsSkip),
		encryption_at_rest: merged.encryptionAtRest ? 1 : 0,
		capture_cleanup_enabled: merged.captureCleanupEnabled ? 1 : 0,
		capture_cleanup_interval_hours: merged.captureCleanupIntervalHours,
		capture_cleanup_max_age_days: merged.captureCleanupMaxAgeDays,
		theme: merged.theme,
		oidc_enabled: merged.oidcEnabled ? 1 : 0,
		oidc_public_url: merged.oidcPublicUrl,
		oidc_issuer: merged.oidcIssuer,
		show_page_load_time: merged.showPageLoadTime ? 1 : 0,
		feedback_store_enabled: merged.feedbackStoreEnabled ? 1 : 0,
		feedback_store_type: merged.feedbackStoreType,
		feedback_store_path: merged.feedbackStorePath,
		detector_mode: merged.detectorMode,
		detector_model_name: merged.detectorModelName,
		detector_threshold: merged.detectorThreshold,
		rate_limiter: JSON.stringify(merged.rateLimiter),
		streaming_retry: JSON.stringify(merged.streamingRetry),
		redact_providers: JSON.stringify(merged.redactProviders),
		// Feature flags (migration 014)
		enable_logger: merged.enableLogger ? 1 : 0,
		enable_redact: merged.enableRedact ? 1 : 0,
		enable_rate_limiter: merged.enableRateLimiter ? 1 : 0,
		log_traffic: merged.logTraffic ? 1 : 0,
		// Advanced rate limiter cache configuration (migration 014)
		rate_limiter_max_entries: merged.rateLimiterMaxEntries,
		rate_limiter_cleanup_interval_ms: merged.rateLimiterCleanupIntervalMs,
		rate_limiter_entry_ttl_ms: merged.rateLimiterEntryTtlMs,
		// Advanced streaming retry cache configuration (migration 014)
		retry_max_entries: merged.retryMaxEntries,
		retry_entry_ttl_ms: merged.retryEntryTtlMs,
		retry_cleanup_interval_ms: merged.retryCleanupIntervalMs,
		retry_max_buffer_size: merged.retryMaxBufferSize,
		retry_max_stream_retries: merged.retryMaxStreamRetries,
		// Proxy configuration (migration 014)
		proxy_bind_host: merged.proxyBindHost,
		proxy_port: merged.proxyPort,
		proxy_allow_target_override: merged.proxyAllowTargetOverride ? 1 : 0,
		strict_url_forwarding: merged.strictUrlForwarding ? 1 : 0,
		upstream_openai_url: merged.upstreamOpenAiUrl,
		upstream_anthropic_url: merged.upstreamAnthropicUrl,
		upstream_chatgpt_url: merged.upstreamChatGptUrl,
		upstream_gemini_url: merged.upstreamGeminiUrl,
		upstream_vertex_url: merged.upstreamVertexUrl,
		upstream_nvidia_url: merged.upstreamNvidiaUrl,
		upstream_openrouter_url: merged.upstreamOpenRouterUrl,
		upstream_kilo_url: merged.upstreamKiloUrl,
		upstream_gemini_code_assist_url: merged.upstreamGeminiCodeAssistUrl,
		redact_disabled_rules: JSON.stringify(merged.redactDisabledRules),
	};
}

/**
 * Deep equality check for settings values.
 * Avoids JSON.stringify key ordering issues.
 */
function deepEqual(a: unknown, b: unknown): boolean {
	if (a === b) return true;
	// Handle NaN (NaN !== NaN, but they should be considered equal for our purposes)
	if (typeof a === "number" && typeof b === "number" && Number.isNaN(a) && Number.isNaN(b)) return true;
	if (a === null || b === null) return false;
	if (typeof a !== "object" || typeof b !== "object") return false;

	// Handle arrays vs objects
	const isArrayA = Array.isArray(a);
	const isArrayB = Array.isArray(b);
	if (isArrayA !== isArrayB) return false;

	if (isArrayA) {
		// Both are arrays
		const arrA = a as unknown[];
		const arrB = b as unknown[];
		if (arrA.length !== arrB.length) return false;
		for (let i = 0; i < arrA.length; i++) {
			if (!deepEqual(arrA[i], arrB[i])) return false;
		}
		return true;
	}

	// Both are plain objects
	const keysA = Object.keys(a as Record<string, unknown>);
	const keysB = Object.keys(b as Record<string, unknown>);
	if (keysA.length !== keysB.length) return false;

	for (const key of keysA) {
		if (!keysB.includes(key)) return false;
		if (!deepEqual((a as Record<string, unknown>)[key], (b as Record<string, unknown>)[key])) return false;
	}
	return true;
}

/**
 * Get settings from the database.
 * Returns null if not found (should not happen since migration creates default row).
 */
export function getSettings(): Settings | null {
	const db = getDb();
	const row = db.prepare("SELECT * FROM settings WHERE id = 'default'").get() as SettingsRow | undefined;
	return row ? rowToSettings(row) : null;
}

/**
 * Insert or update settings in the database.
 * Uses UPSERT pattern with ON CONFLICT.
 */
export function upsertSettings(settings: Settings): void {
	const db = getDb();
	const row = settingsToRow(settings);

	const stmt = db.prepare(`
		INSERT INTO settings (
			id, log_dir, max_sessions, redact_preset, redact_reversible, redact_policy_file,
			redact_policy_enabled, redact_paths_only, redact_paths_skip, redact_disabled_rules,
			redact_providers,
			encryption_at_rest, capture_cleanup_enabled, capture_cleanup_interval_hours,
			capture_cleanup_max_age_days, theme, oidc_enabled, oidc_public_url, oidc_issuer,
			show_page_load_time, feedback_store_enabled, feedback_store_type, feedback_store_path,
			detector_mode, detector_model_name, detector_threshold,
			rate_limiter, streaming_retry,
			enable_logger, enable_redact, enable_rate_limiter, log_traffic,
			rate_limiter_max_entries, rate_limiter_cleanup_interval_ms, rate_limiter_entry_ttl_ms,
			retry_max_entries, retry_entry_ttl_ms, retry_cleanup_interval_ms, retry_max_buffer_size, retry_max_stream_retries,
			proxy_bind_host, proxy_port, proxy_allow_target_override, strict_url_forwarding,
			upstream_openrouter_url, upstream_openai_url, upstream_anthropic_url, upstream_chatgpt_url,
			upstream_gemini_url, upstream_vertex_url, upstream_nvidia_url, upstream_kilo_url,
			upstream_gemini_code_assist_url
		) VALUES (
			'default', ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?
		)
		ON CONFLICT(id) DO UPDATE SET
			log_dir = excluded.log_dir,
			max_sessions = excluded.max_sessions,
			redact_preset = excluded.redact_preset,
			redact_reversible = excluded.redact_reversible,
			redact_policy_file = excluded.redact_policy_file,
			redact_policy_enabled = excluded.redact_policy_enabled,
			redact_paths_only = excluded.redact_paths_only,
			redact_paths_skip = excluded.redact_paths_skip,
			redact_disabled_rules = excluded.redact_disabled_rules,
			redact_providers = excluded.redact_providers,
			encryption_at_rest = excluded.encryption_at_rest,
			capture_cleanup_enabled = excluded.capture_cleanup_enabled,
			capture_cleanup_interval_hours = excluded.capture_cleanup_interval_hours,
			capture_cleanup_max_age_days = excluded.capture_cleanup_max_age_days,
			theme = excluded.theme,
			oidc_enabled = excluded.oidc_enabled,
			oidc_public_url = excluded.oidc_public_url,
			oidc_issuer = excluded.oidc_issuer,
			show_page_load_time = excluded.show_page_load_time,
			feedback_store_enabled = excluded.feedback_store_enabled,
			feedback_store_type = excluded.feedback_store_type,
			feedback_store_path = excluded.feedback_store_path,
			detector_mode = excluded.detector_mode,
			detector_model_name = excluded.detector_model_name,
			detector_threshold = excluded.detector_threshold,
			rate_limiter = excluded.rate_limiter,
			streaming_retry = excluded.streaming_retry,
			enable_logger = excluded.enable_logger,
			enable_redact = excluded.enable_redact,
			enable_rate_limiter = excluded.enable_rate_limiter,
			log_traffic = excluded.log_traffic,
			rate_limiter_max_entries = excluded.rate_limiter_max_entries,
			rate_limiter_cleanup_interval_ms = excluded.rate_limiter_cleanup_interval_ms,
			rate_limiter_entry_ttl_ms = excluded.rate_limiter_entry_ttl_ms,
			retry_max_entries = excluded.retry_max_entries,
			retry_entry_ttl_ms = excluded.retry_entry_ttl_ms,
			retry_cleanup_interval_ms = excluded.retry_cleanup_interval_ms,
			retry_max_buffer_size = excluded.retry_max_buffer_size,
			retry_max_stream_retries = excluded.retry_max_stream_retries,
			proxy_bind_host = excluded.proxy_bind_host,
			proxy_port = excluded.proxy_port,
			proxy_allow_target_override = excluded.proxy_allow_target_override,
			strict_url_forwarding = excluded.strict_url_forwarding,
			upstream_openrouter_url = excluded.upstream_openrouter_url,
			upstream_openai_url = excluded.upstream_openai_url,
			upstream_anthropic_url = excluded.upstream_anthropic_url,
			upstream_chatgpt_url = excluded.upstream_chatgpt_url,
			upstream_gemini_url = excluded.upstream_gemini_url,
			upstream_vertex_url = excluded.upstream_vertex_url,
			upstream_nvidia_url = excluded.upstream_nvidia_url,
			upstream_kilo_url = excluded.upstream_kilo_url,
			upstream_gemini_code_assist_url = excluded.upstream_gemini_code_assist_url
	`);

	try {
		stmt.run(
			row.log_dir,
			row.max_sessions,
			row.redact_preset,
			row.redact_reversible,
			row.redact_policy_file,
			row.redact_policy_enabled,
			row.redact_paths_only,
			row.redact_paths_skip,
			row.redact_disabled_rules,
			row.redact_providers,
			row.encryption_at_rest,
			row.capture_cleanup_enabled,
			row.capture_cleanup_interval_hours,
			row.capture_cleanup_max_age_days,
			row.theme,
			row.oidc_enabled,
			row.oidc_public_url,
			row.oidc_issuer,
			row.show_page_load_time,
			row.feedback_store_enabled,
			row.feedback_store_type,
			row.feedback_store_path,
			row.detector_mode,
			row.detector_model_name,
			row.detector_threshold,
			row.rate_limiter,
			row.streaming_retry,
			row.enable_logger,
			row.enable_redact,
			row.enable_rate_limiter,
			row.log_traffic,
			row.rate_limiter_max_entries,
			row.rate_limiter_cleanup_interval_ms,
			row.rate_limiter_entry_ttl_ms,
			row.retry_max_entries,
			row.retry_entry_ttl_ms,
			row.retry_cleanup_interval_ms,
			row.retry_max_buffer_size,
			row.retry_max_stream_retries,
			row.proxy_bind_host,
			row.proxy_port,
			row.proxy_allow_target_override,
			row.strict_url_forwarding,
			row.upstream_openrouter_url,
			row.upstream_openai_url,
			row.upstream_anthropic_url,
			row.upstream_chatgpt_url,
			row.upstream_gemini_url,
			row.upstream_vertex_url,
			row.upstream_nvidia_url,
			row.upstream_kilo_url,
			row.upstream_gemini_code_assist_url
		);
	} catch (err) {
		// Preserve original error stack trace for debugging
		throw err instanceof Error ? err : new Error(String(err));
	}
}

/**
 * Get settings with metadata about source (file, env, default).
 * Note: This returns metadata based on current settings vs defaults.
 * Environment variable overrides are applied at a higher level (web/lib/settings.ts).
 * 
 * @param appliedEnvKeys - Optional set of keys that have env var overrides applied.
 *   If provided, this is used to determine "environment-variable" source.
 *   If not provided, the function uses a conservative fallback that checks
 *   if env vars are set AND non-empty (to avoid false positives for numeric/enum fields).
 */
export function getSettingsWithMeta(appliedEnvKeys?: Set<keyof Settings>): { settings: Settings; meta: Record<keyof Settings, SettingMeta> } {
	const settings = getSettings() ?? DEFAULT_SETTINGS;

	// Import the metadata functions from the shared settings module logic
	// Since we can't easily import from web/, we replicate the metadata logic here
	const SETTING_ENV_MAP: Record<keyof Settings, { envVar: string; dynamic: boolean }> = {
		logDir: { envVar: "LOGGER_CAPTURE_DIR", dynamic: false },
		maxSessions: { envVar: "LOGGER_MAX_SESSIONS", dynamic: false },
		redactPreset: { envVar: "REDACT_PRESET", dynamic: true },
		redactReversible: { envVar: "REDACT_REVERSIBLE", dynamic: true },
		redactPolicyFile: { envVar: "REDACT_POLICY_FILE", dynamic: true },
		redactPolicyEnabled: { envVar: "REDACT_POLICY_ENABLED", dynamic: true },
		redactPathsOnly: { envVar: "REDACT_PATHS_ONLY", dynamic: true },
		redactPathsSkip: { envVar: "REDACT_PATHS_SKIP", dynamic: true },
		redactDisabledRules: { envVar: "REDACT_DISABLED_RULES", dynamic: true },
		encryptionAtRest: { envVar: "CONTEXTIO_LOGGER_ENCRYPTION_ENABLED", dynamic: false },
		captureCleanupEnabled: { envVar: "LOGGER_CAPTURE_CLEANUP_ENABLED", dynamic: false },
		captureCleanupIntervalHours: { envVar: "LOGGER_CAPTURE_CLEANUP_INTERVAL", dynamic: false },
		captureCleanupMaxAgeDays: { envVar: "LOGGER_CAPTURE_MAX_AGE", dynamic: false },
		theme: { envVar: "CONTEXTIO_THEME", dynamic: true },
		oidcEnabled: { envVar: "CONTEXTIO_OIDC_ENABLED", dynamic: false },
		oidcPublicUrl: { envVar: "CONTEXTIO_OIDC_PUBLIC_URL", dynamic: false },
		oidcIssuer: { envVar: "CONTEXTIO_OIDC_ISSUER", dynamic: false },
		showPageLoadTime: { envVar: "", dynamic: true },
		feedbackStoreEnabled: { envVar: "REDACT_FEEDBACK_STORE_ENABLED", dynamic: false },
		feedbackStoreType: { envVar: "REDACT_FEEDBACK_STORE_TYPE", dynamic: false },
		feedbackStorePath: { envVar: "REDACT_FEEDBACK_STORE_PATH", dynamic: false },
		detectorMode: { envVar: "REDACT_DETECTOR_MODE", dynamic: true },
		detectorModelName: { envVar: "REDACT_DETECTOR_MODEL_NAME", dynamic: true },
		detectorThreshold: { envVar: "REDACT_DETECTOR_THRESHOLD", dynamic: true },
	rateLimiter: { envVar: "", dynamic: false },
	streamingRetry: { envVar: "", dynamic: false },
	redactProviders: { envVar: "", dynamic: false },
	// Feature flags
		enableLogger: { envVar: "CONTEXTIO_ENABLE_LOGGER", dynamic: false },
		enableRedact: { envVar: "CONTEXTIO_ENABLE_REDACT", dynamic: false },
		enableRateLimiter: { envVar: "CONTEXTIO_ENABLE_RATE_LIMITER", dynamic: false },
		logTraffic: { envVar: "LOG_TRAFFIC", dynamic: false },
		// Advanced rate limiter cache configuration
		rateLimiterMaxEntries: { envVar: "CONTEXTIO_RATE_LIMIT_MAX_ENTRIES", dynamic: false },
		rateLimiterCleanupIntervalMs: { envVar: "CONTEXTIO_RATE_LIMIT_CLEANUP_INTERVAL_MS", dynamic: false },
		rateLimiterEntryTtlMs: { envVar: "CONTEXTIO_RATE_LIMIT_ENTRY_TTL_MS", dynamic: false },
		// Advanced streaming retry cache configuration
		retryMaxEntries: { envVar: "CONTEXTIO_RETRY_MAX_ENTRIES", dynamic: false },
		retryEntryTtlMs: { envVar: "CONTEXTIO_RETRY_ENTRY_TTL_MS", dynamic: false },
		retryCleanupIntervalMs: { envVar: "CONTEXTIO_RETRY_CLEANUP_INTERVAL_MS", dynamic: false },
		retryMaxBufferSize: { envVar: "CONTEXTIO_RETRY_MAX_BUFFER_SIZE", dynamic: false },
		retryMaxStreamRetries: { envVar: "CONTEXTIO_RETRY_MAX_STREAM_RETRIES", dynamic: false },
		// Proxy configuration
		proxyBindHost: { envVar: "CONTEXT_PROXY_BIND_HOST", dynamic: false },
		proxyPort: { envVar: "CONTEXT_PROXY_PORT", dynamic: false },
		proxyAllowTargetOverride: { envVar: "CONTEXT_PROXY_ALLOW_TARGET_OVERRIDE", dynamic: false },
		strictUrlForwarding: { envVar: "STRICT_URL_FORWARDING", dynamic: false },
		upstreamOpenAiUrl: { envVar: "UPSTREAM_OPENAI_URL", dynamic: false },
		upstreamAnthropicUrl: { envVar: "UPSTREAM_ANTHROPIC_URL", dynamic: false },
		upstreamChatGptUrl: { envVar: "UPSTREAM_CHATGPT_URL", dynamic: false },
		upstreamGeminiUrl: { envVar: "UPSTREAM_GEMINI_URL", dynamic: false },
		upstreamVertexUrl: { envVar: "UPSTREAM_VERTEX_URL", dynamic: false },
		upstreamNvidiaUrl: { envVar: "UPSTREAM_NVIDIA_URL", dynamic: false },
		upstreamOpenRouterUrl: { envVar: "UPSTREAM_OPENROUTER_URL", dynamic: false },
		upstreamKiloUrl: { envVar: "UPSTREAM_KILO_URL", dynamic: false },
		upstreamGeminiCodeAssistUrl: { envVar: "UPSTREAM_GEMINI_CODE_ASSIST_URL", dynamic: false },
	};

	const meta = {} as Record<keyof Settings, SettingMeta>;
	(Object.keys(SETTING_ENV_MAP) as (keyof Settings)[]).forEach((key) => {
		const { envVar, dynamic } = SETTING_ENV_MAP[key];
		let effectiveEnv = false;
		if (appliedEnvKeys) {
			effectiveEnv = appliedEnvKeys.has(key);
		} else if (envVar) {
			// Conservative fallback: only treat as env-sourced if the env var is
			// set to a non-empty string. This avoids false positives for numeric/enum
			// fields where empty strings would be rejected by applyEnvOverrides.
			const raw = process.env[envVar];
			effectiveEnv = raw !== undefined && raw !== "";
		}
		let source: SettingSource;
		if (effectiveEnv) {
			source = "environment-variable";
		} else if (!deepEqual(settings[key], DEFAULT_SETTINGS[key])) {
			source = "settings-file";
		} else {
			source = "default";
		}
		meta[key] = { source, envVar: effectiveEnv ? envVar : null, dynamic };
	});

	return { settings, meta };
}

/**
 * Import settings from a settings.json file into the database.
 * This is used for one-time migration from file-based to SQLite storage.
 *
 * @param filePath - Path to the settings.json file
 * @returns ImportSettingsResult indicating success, skip, or error
 */
export function importSettingsFromJson(filePath: string): ImportSettingsResult {
	if (!fs.existsSync(filePath)) {
		console.log(`[settings-repo] No settings.json found at ${filePath}, skipping import`);
		return { imported: false, skipped: true, error: "File not found" };
	}

	try {
		const raw = fs.readFileSync(filePath, "utf8");
		const parsed = JSON.parse(raw);

		// Validate and merge with defaults
		const settings = validateAndMergeSettings(parsed);

		// Upsert to database
		upsertSettings(settings);
		console.log(`[settings-repo] Imported settings from ${filePath}`);
		return { imported: true, skipped: false };
	} catch (err) {
		const errorMsg = err instanceof Error ? err.message : String(err);
		console.error(`[settings-repo] Failed to read/parse settings.json at ${filePath}: ${errorMsg}`);
		return { imported: false, skipped: false, error: errorMsg };
	}
}

/**
 * Validate and merge partial settings with defaults.
 * Mirrors the logic from web/lib/settings.ts validateSettingsLenient.
 */
function validateAndMergeSettings(input: unknown): Settings {
	if (typeof input !== "object" || input === null) {
		return DEFAULT_SETTINGS;
	}

	const obj = input as Record<string, unknown>;

	// Helper validators
	const getString = (key: string, defaultVal: string) => {
		const v = obj[key];
		return typeof v === "string" ? v : defaultVal;
	};

	const getNumber = (key: string, defaultVal: number, min: number, max: number) => {
		const v = obj[key];
		if (typeof v === "number" && Number.isInteger(v) && v >= min && v <= max) {
			return v;
		}
		return defaultVal;
	};

	const getBoolean = (key: string, defaultVal: boolean) => {
		const v = obj[key];
		return typeof v === "boolean" ? v : defaultVal;
	};

	const getEnum = <T extends string>(key: string, allowed: T[], defaultVal: T) => {
		const v = obj[key];
		if (typeof v === "string" && allowed.includes(v as T)) {
			return v as T;
		}
		return defaultVal;
	};

	const getFloat = (key: string, defaultVal: number, min: number, max: number) => {
		const v = obj[key];
		if (typeof v === "number" && !Number.isNaN(v) && v >= min && v <= max) {
			return v;
		}
		return defaultVal;
	};

	// Parse rateLimiter
	const parseRateLimiter = (key: string): Record<Provider, RateLimitConfig> => {
		const rl = obj[key];
		if (typeof rl !== "object" || rl === null) {
			return DEFAULT_RATE_LIMITER;
		}
		const rlObj = rl as Record<string, unknown>;
		const result = {} as Record<Provider, RateLimitConfig>;
		for (const provider of ["anthropic", "openai", "chatgpt", "gemini", "vertex", "nvidia", "openrouter", "kilo", "geminiCodeAssist"] as Provider[]) {
			const p = rlObj[provider];
			if (typeof p === "object" && p !== null) {
				const pObj = p as { maxRequests?: unknown; windowMs?: unknown; bufferCapacity?: unknown };
				const maxRequests = Number.isInteger(pObj.maxRequests) && (pObj.maxRequests as number) >= 1 && (pObj.maxRequests as number) <= 10000 ? pObj.maxRequests as number : 60;
				const windowMs = Number.isInteger(pObj.windowMs) && (pObj.windowMs as number) >= 100 && (pObj.windowMs as number) <= 24 * 60 * 60 * 1000 ? pObj.windowMs as number : 60000;
				const bufferCapacity = Number.isInteger(pObj.bufferCapacity) && (pObj.bufferCapacity as number) >= 0 && (pObj.bufferCapacity as number) <= 10000 ? pObj.bufferCapacity as number : 10;
				result[provider] = { maxRequests, windowMs, bufferCapacity };
			} else {
				result[provider] = DEFAULT_RATE_LIMITER[provider];
			}
		}
		return result;
	};

	// Parse streamingRetry
	const parseStreamingRetry = (key: string): Record<Provider, StreamingRetryConfig> => {
		const sr = obj[key];
		if (typeof sr !== "object" || sr === null) {
			return DEFAULT_STREAMING_RETRY;
		}
		const srObj = sr as Record<string, unknown>;
		const result = {} as Record<Provider, StreamingRetryConfig>;
		for (const provider of ["anthropic", "openai", "chatgpt", "gemini", "geminiCodeAssist", "vertex", "nvidia", "openrouter", "kilo"] as Provider[]) {
			const p = srObj[provider];
			if (typeof p === "object" && p !== null) {
				const pObj = p as { enabled?: unknown; maxRetries?: unknown; maxBufferSizeMB?: unknown };
				const enabled = typeof pObj.enabled === "boolean" ? pObj.enabled : true;
				const maxRetries = Number.isInteger(pObj.maxRetries) && (pObj.maxRetries as number) >= 0 && (pObj.maxRetries as number) <= 10 ? pObj.maxRetries as number : 3;
				const maxBufferSizeMB = Number.isInteger(pObj.maxBufferSizeMB) && (pObj.maxBufferSizeMB as number) >= 1 && (pObj.maxBufferSizeMB as number) <= 100 ? pObj.maxBufferSizeMB as number : 10;
				result[provider] = { enabled, maxRetries, maxBufferSizeMB };
			} else {
				result[provider] = DEFAULT_STREAMING_RETRY[provider];
			}
		}
		return result;
	};

	// Parse redactProviders
	const parseRedactProviders = (key: string): Record<Provider, boolean> => {
		const rp = obj[key];
		if (typeof rp !== "object" || rp === null) {
			return DEFAULT_REDACT_PROVIDERS;
		}
		const rpObj = rp as Record<string, unknown>;
		const result = {} as Record<Provider, boolean>;
		for (const provider of ["anthropic", "openai", "chatgpt", "gemini", "geminiCodeAssist", "vertex", "nvidia", "openrouter", "kilo"] as Provider[]) {
			const v = rpObj[provider];
			result[provider] = typeof v === "boolean" ? v : true;
		}
		return result;
	};

	// Helper to parse JSON array of strings
	const parseStringArray = (key: string, defaultVal: string[]): string[] => {
		const v = obj[key];
		if (!v) return defaultVal;
		// If it's already an array (from object input), validate it
		if (Array.isArray(v) && v.every(item => typeof item === "string")) {
			return v as string[];
		}
		// If it's a string, try to parse as JSON
		if (typeof v === "string") {
			try {
				const parsed = JSON.parse(v);
				if (Array.isArray(parsed) && parsed.every(item => typeof item === "string")) {
					return parsed as string[];
				}
				return defaultVal;
			} catch {
				return defaultVal;
			}
		}
		return defaultVal;
	};

	return {
		logDir: getString("logDir", DEFAULT_SETTINGS.logDir),
		maxSessions: getNumber("maxSessions", DEFAULT_SETTINGS.maxSessions, 0, 10000),
		redactPreset: getEnum("redactPreset", ["secrets", "pii", "strict"], DEFAULT_SETTINGS.redactPreset),
		redactReversible: getBoolean("redactReversible", DEFAULT_SETTINGS.redactReversible),
		redactPolicyFile: getString("redactPolicyFile", DEFAULT_SETTINGS.redactPolicyFile),
		redactPolicyEnabled: getBoolean("redactPolicyEnabled", DEFAULT_SETTINGS.redactPolicyEnabled),
		redactPathsOnly: parseStringArray("redactPathsOnly", DEFAULT_SETTINGS.redactPathsOnly),
		redactPathsSkip: parseStringArray("redactPathsSkip", DEFAULT_SETTINGS.redactPathsSkip),
		redactDisabledRules: parseStringArray("redactDisabledRules", DEFAULT_SETTINGS.redactDisabledRules),
		encryptionAtRest: getBoolean("encryptionAtRest", DEFAULT_SETTINGS.encryptionAtRest),
		captureCleanupEnabled: getBoolean("captureCleanupEnabled", DEFAULT_SETTINGS.captureCleanupEnabled),
		captureCleanupIntervalHours: getNumber("captureCleanupIntervalHours", DEFAULT_SETTINGS.captureCleanupIntervalHours, 1, 168),
		captureCleanupMaxAgeDays: getNumber("captureCleanupMaxAgeDays", DEFAULT_SETTINGS.captureCleanupMaxAgeDays, 1, 365),
		theme: getEnum("theme", [
			"light", "dark", "system", "high-contrast", "material-light", "material-dark",
			"solarized-light", "solarized-dark", "dracula", "nord", "github-light", "github-dark",
			"one-dark", "monokai"
		], DEFAULT_SETTINGS.theme),
		oidcEnabled: getBoolean("oidcEnabled", DEFAULT_SETTINGS.oidcEnabled),
		oidcPublicUrl: getString("oidcPublicUrl", DEFAULT_SETTINGS.oidcPublicUrl),
		oidcIssuer: getString("oidcIssuer", DEFAULT_SETTINGS.oidcIssuer),
		showPageLoadTime: getBoolean("showPageLoadTime", DEFAULT_SETTINGS.showPageLoadTime),
		feedbackStoreEnabled: getBoolean("feedbackStoreEnabled", DEFAULT_SETTINGS.feedbackStoreEnabled),
		feedbackStoreType: getEnum("feedbackStoreType", ["sqlite", "memory"], DEFAULT_SETTINGS.feedbackStoreType),
		feedbackStorePath: getString("feedbackStorePath", DEFAULT_SETTINGS.feedbackStorePath),
		detectorMode: getEnum("detectorMode", ["rules", "llm", "hybrid", "auto"], DEFAULT_SETTINGS.detectorMode),
		detectorModelName: getString("detectorModelName", DEFAULT_SETTINGS.detectorModelName),
		detectorThreshold: getFloat("detectorThreshold", DEFAULT_SETTINGS.detectorThreshold, 0, 1),
		rateLimiter: parseRateLimiter("rateLimiter"),
		streamingRetry: parseStreamingRetry("streamingRetry"),
		redactProviders: parseRedactProviders("redactProviders"),
		// Feature flags
		enableLogger: getBoolean("enableLogger", DEFAULT_SETTINGS.enableLogger),
		enableRedact: getBoolean("enableRedact", DEFAULT_SETTINGS.enableRedact),
		enableRateLimiter: getBoolean("enableRateLimiter", DEFAULT_SETTINGS.enableRateLimiter),
		logTraffic: getBoolean("logTraffic", DEFAULT_SETTINGS.logTraffic),
		// Advanced rate limiter cache configuration
		rateLimiterMaxEntries: getNumber("rateLimiterMaxEntries", DEFAULT_SETTINGS.rateLimiterMaxEntries, 1, 100000),
		rateLimiterCleanupIntervalMs: getNumber("rateLimiterCleanupIntervalMs", DEFAULT_SETTINGS.rateLimiterCleanupIntervalMs, 1000, 86400000),
		rateLimiterEntryTtlMs: getNumber("rateLimiterEntryTtlMs", DEFAULT_SETTINGS.rateLimiterEntryTtlMs, 1000, 86400000),
		// Advanced streaming retry cache configuration
		retryMaxEntries: getNumber("retryMaxEntries", DEFAULT_SETTINGS.retryMaxEntries, 1, 100000),
		retryEntryTtlMs: getNumber("retryEntryTtlMs", DEFAULT_SETTINGS.retryEntryTtlMs, 1000, 86400000),
		retryCleanupIntervalMs: getNumber("retryCleanupIntervalMs", DEFAULT_SETTINGS.retryCleanupIntervalMs, 1000, 86400000),
		retryMaxBufferSize: getNumber("retryMaxBufferSize", DEFAULT_SETTINGS.retryMaxBufferSize, 1024, 100 * 1024 * 1024),
		retryMaxStreamRetries: getNumber("retryMaxStreamRetries", DEFAULT_SETTINGS.retryMaxStreamRetries, 0, 100),
		// Proxy configuration
		proxyBindHost: getString("proxyBindHost", DEFAULT_SETTINGS.proxyBindHost),
		proxyPort: getNumber("proxyPort", DEFAULT_SETTINGS.proxyPort, 1, 65535),
		proxyAllowTargetOverride: getBoolean("proxyAllowTargetOverride", DEFAULT_SETTINGS.proxyAllowTargetOverride),
		strictUrlForwarding: getBoolean("strictUrlForwarding", DEFAULT_SETTINGS.strictUrlForwarding),
		upstreamOpenAiUrl: getString("upstreamOpenAiUrl", DEFAULT_SETTINGS.upstreamOpenAiUrl),
		upstreamAnthropicUrl: getString("upstreamAnthropicUrl", DEFAULT_SETTINGS.upstreamAnthropicUrl),
		upstreamChatGptUrl: getString("upstreamChatGptUrl", DEFAULT_SETTINGS.upstreamChatGptUrl),
		upstreamGeminiUrl: getString("upstreamGeminiUrl", DEFAULT_SETTINGS.upstreamGeminiUrl),
		upstreamVertexUrl: getString("upstreamVertexUrl", DEFAULT_SETTINGS.upstreamVertexUrl),
		upstreamNvidiaUrl: getString("upstreamNvidiaUrl", DEFAULT_SETTINGS.upstreamNvidiaUrl),
		upstreamOpenRouterUrl: getString("upstreamOpenRouterUrl", DEFAULT_SETTINGS.upstreamOpenRouterUrl),
		upstreamKiloUrl: getString("upstreamKiloUrl", DEFAULT_SETTINGS.upstreamKiloUrl),
		upstreamGeminiCodeAssistUrl: getString("upstreamGeminiCodeAssistUrl", DEFAULT_SETTINGS.upstreamGeminiCodeAssistUrl),
	};
}
