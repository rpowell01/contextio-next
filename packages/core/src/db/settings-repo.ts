/**
 * Settings repository for SQLite-backed settings storage.
 * Replaces file-based settings.json with database operations.
 */

import { getDb } from "./connection.js";
import type { Provider, RateLimitConfig, StreamingRetryConfig } from "../types.js";
import fs from "node:fs";

// Re-export types from core types for consumers
export type { RateLimitConfig, StreamingRetryConfig };

/**
 * Database row type for settings table.
 * Matches the schema in 007_settings.sql
 */
export interface SettingsRow {
	id: string;
	log_dir: string;
	max_sessions: number;
	redact_preset: string;
	redact_reversible: number;
	redact_policy_file: string;
	encryption_at_rest: number;
	capture_cleanup_enabled: number;
	capture_cleanup_interval_hours: number;
	capture_cleanup_max_age_days: number;
	theme: string;
	oidc_enabled: number;
	oidc_public_url: string;
	show_page_load_time: number;
	detector_mode: string;
	detector_model_dir: string;
	detector_threshold: number;
	rate_limiter: string; // JSON blob
	streaming_retry: string; // JSON blob
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
	showPageLoadTime: boolean;
	detectorMode: "rules" | "llm" | "hybrid" | "auto";
	detectorModelDir: string;
	detectorThreshold: number;
	rateLimiter: Record<Provider, RateLimitConfig>;
	streamingRetry: Record<Provider, StreamingRetryConfig>;
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
	encryptionAtRest: false,
	captureCleanupEnabled: false,
	captureCleanupIntervalHours: 24,
	captureCleanupMaxAgeDays: 30,
	theme: "system",
	oidcEnabled: false,
	oidcPublicUrl: "",
	showPageLoadTime: false,
	detectorMode: "rules",
	detectorModelDir: "",
	detectorThreshold: 0.5,
	rateLimiter: DEFAULT_RATE_LIMITER,
	streamingRetry: DEFAULT_STREAMING_RETRY,
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
		encryptionAtRest: row.encryption_at_rest === 1,
		captureCleanupEnabled: row.capture_cleanup_enabled === 1,
		captureCleanupIntervalHours: row.capture_cleanup_interval_hours,
		captureCleanupMaxAgeDays: row.capture_cleanup_max_age_days,
		theme: row.theme as Settings["theme"],
		oidcEnabled: row.oidc_enabled === 1,
		oidcPublicUrl: row.oidc_public_url,
		showPageLoadTime: row.show_page_load_time === 1,
		detectorMode: row.detector_mode as Settings["detectorMode"],
		detectorModelDir: row.detector_model_dir,
		detectorThreshold: row.detector_threshold,
		rateLimiter: safeJsonParse(row.rate_limiter, DEFAULT_RATE_LIMITER),
		streamingRetry: safeJsonParse(row.streaming_retry, DEFAULT_STREAMING_RETRY),
	};
}

/**
 * Convert a Settings object to database column values for insert/update.
 */
function settingsToRow(settings: Settings): Omit<SettingsRow, "id" | "created_at" | "updated_at"> {
	return {
		log_dir: settings.logDir,
		max_sessions: settings.maxSessions,
		redact_preset: settings.redactPreset,
		redact_reversible: settings.redactReversible ? 1 : 0,
		redact_policy_file: settings.redactPolicyFile,
		encryption_at_rest: settings.encryptionAtRest ? 1 : 0,
		capture_cleanup_enabled: settings.captureCleanupEnabled ? 1 : 0,
		capture_cleanup_interval_hours: settings.captureCleanupIntervalHours,
		capture_cleanup_max_age_days: settings.captureCleanupMaxAgeDays,
		theme: settings.theme,
		oidc_enabled: settings.oidcEnabled ? 1 : 0,
		oidc_public_url: settings.oidcPublicUrl,
		show_page_load_time: settings.showPageLoadTime ? 1 : 0,
		detector_mode: settings.detectorMode,
		detector_model_dir: settings.detectorModelDir,
		detector_threshold: settings.detectorThreshold,
		rate_limiter: JSON.stringify(settings.rateLimiter),
		streaming_retry: JSON.stringify(settings.streamingRetry),
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
			encryption_at_rest, capture_cleanup_enabled, capture_cleanup_interval_hours,
			capture_cleanup_max_age_days, theme, oidc_enabled, oidc_public_url,
			show_page_load_time, detector_mode, detector_model_dir, detector_threshold,
			rate_limiter, streaming_retry
		) VALUES (
			'default', ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?
		)
		ON CONFLICT(id) DO UPDATE SET
			log_dir = excluded.log_dir,
			max_sessions = excluded.max_sessions,
			redact_preset = excluded.redact_preset,
			redact_reversible = excluded.redact_reversible,
			redact_policy_file = excluded.redact_policy_file,
			encryption_at_rest = excluded.encryption_at_rest,
			capture_cleanup_enabled = excluded.capture_cleanup_enabled,
			capture_cleanup_interval_hours = excluded.capture_cleanup_interval_hours,
			capture_cleanup_max_age_days = excluded.capture_cleanup_max_age_days,
			theme = excluded.theme,
			oidc_enabled = excluded.oidc_enabled,
			oidc_public_url = excluded.oidc_public_url,
			show_page_load_time = excluded.show_page_load_time,
			detector_mode = excluded.detector_mode,
			detector_model_dir = excluded.detector_model_dir,
			detector_threshold = excluded.detector_threshold,
			rate_limiter = excluded.rate_limiter,
			streaming_retry = excluded.streaming_retry
	`);

	try {
		stmt.run(
			row.log_dir,
			row.max_sessions,
			row.redact_preset,
			row.redact_reversible,
			row.redact_policy_file,
			row.encryption_at_rest,
			row.capture_cleanup_enabled,
			row.capture_cleanup_interval_hours,
			row.capture_cleanup_max_age_days,
			row.theme,
			row.oidc_enabled,
			row.oidc_public_url,
			row.show_page_load_time,
			row.detector_mode,
			row.detector_model_dir,
			row.detector_threshold,
			row.rate_limiter,
			row.streaming_retry
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
		encryptionAtRest: { envVar: "CONTEXTIO_LOGGER_ENCRYPTION_ENABLED", dynamic: false },
		captureCleanupEnabled: { envVar: "LOGGER_CAPTURE_CLEANUP_ENABLED", dynamic: false },
		captureCleanupIntervalHours: { envVar: "LOGGER_CAPTURE_CLEANUP_INTERVAL", dynamic: false },
		captureCleanupMaxAgeDays: { envVar: "LOGGER_CAPTURE_MAX_AGE", dynamic: false },
		theme: { envVar: "CONTEXTIO_THEME", dynamic: true },
		oidcEnabled: { envVar: "CONTEXTIO_OIDC_ENABLED", dynamic: false },
		oidcPublicUrl: { envVar: "CONTEXTIO_OIDC_PUBLIC_URL", dynamic: false },
		showPageLoadTime: { envVar: "", dynamic: true },
		detectorMode: { envVar: "REDACT_DETECTOR_MODE", dynamic: true },
		detectorModelDir: { envVar: "REDACT_DETECTOR_MODEL_DIR", dynamic: true },
		detectorThreshold: { envVar: "REDACT_DETECTOR_THRESHOLD", dynamic: true },
		rateLimiter: { envVar: "", dynamic: false },
		streamingRetry: { envVar: "", dynamic: false },
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

	return {
		logDir: getString("logDir", DEFAULT_SETTINGS.logDir),
		maxSessions: getNumber("maxSessions", DEFAULT_SETTINGS.maxSessions, 0, 10000),
		redactPreset: getEnum("redactPreset", ["secrets", "pii", "strict"], DEFAULT_SETTINGS.redactPreset),
		redactReversible: getBoolean("redactReversible", DEFAULT_SETTINGS.redactReversible),
		redactPolicyFile: getString("redactPolicyFile", DEFAULT_SETTINGS.redactPolicyFile),
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
		showPageLoadTime: getBoolean("showPageLoadTime", DEFAULT_SETTINGS.showPageLoadTime),
		detectorMode: getEnum("detectorMode", ["rules", "llm", "hybrid", "auto"], DEFAULT_SETTINGS.detectorMode),
		detectorModelDir: getString("detectorModelDir", DEFAULT_SETTINGS.detectorModelDir),
		detectorThreshold: getFloat("detectorThreshold", DEFAULT_SETTINGS.detectorThreshold, 0, 1),
		rateLimiter: parseRateLimiter("rateLimiter"),
		streamingRetry: parseStreamingRetry("streamingRetry"),
	};
}
