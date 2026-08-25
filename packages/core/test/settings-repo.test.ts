import { describe, it, before, after, beforeEach } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync, unlinkSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import Database from "better-sqlite3";

import {
	getSettings,
	upsertSettings,
	getSettingsWithMeta,
	importSettingsFromJson,
	getDefaultSettingsFile,
	closeDb,
	initDb,
	type Settings,
	type ImportSettingsResult,
} from "../dist/db/index.js";

/**
 * Test database setup using a temporary file.
 * This ensures the production code uses our test database.
 */

let testDbDir: string;
let testDbPath: string;

// Setup test database
async function setupTestDb(): Promise<void> {
	// Create a temporary directory for our test database
	testDbDir = mkdtempSync(join(tmpdir(), "contextio-settings-test-"));
	testDbPath = join(testDbDir, "test.db");

	// Set environment variable so production code uses our test database
	process.env.CONTEXTIO_DB_PATH = testDbPath;
	process.env.SETTINGS_FILE = join(testDbDir, "settings.json");

	// Close any existing connection
	closeDb();

	// Initialize the database (runs migrations)
	initDb();

	// Verify settings table exists
	const db = new Database(testDbPath);
	const tables = db.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name='settings'").get();
	if (!tables) {
		db.close();
		throw new Error("settings table not created - migrations not applied correctly!");
	}
	db.close();
}

function clearSettingsTable(): void {
	const db = new Database(testDbPath);
	db.prepare("DELETE FROM settings").run();
	db.close();
}

function clearSchemaVersionTable(): void {
	const db = new Database(testDbPath);
	db.prepare("DELETE FROM schema_version").run();
	db.close();
}

// Cleanup
async function teardownTestDb(): Promise<void> {
	closeDb();
	if (testDbDir) {
		rmSync(testDbDir, { recursive: true, force: true });
	}
	delete process.env.CONTEXTIO_DB_PATH;
	delete process.env.SETTINGS_FILE;
}

function createTestSettings(overrides: Partial<Settings> = {}): Settings {
	const base: Settings = {
		logDir: "",
		maxSessions: 0,
		redactPreset: "pii",
		redactReversible: false,
		redactPolicyFile: "",
		redactPathsOnly: ["messages[*].content"],
		redactPathsSkip: [],
		encryptionAtRest: false,
		captureCleanupEnabled: true,
		captureCleanupIntervalHours: 24,
		captureCleanupMaxAgeDays: 30,
		theme: "system",
		oidcEnabled: false,
		oidcPublicUrl: "",
		showPageLoadTime: false,
		detectorMode: "rules",
		detectorModelName: "Xenova/bert-base-NER",
		detectorThreshold: 0.5,
		rateLimiter: {
			anthropic: { maxRequests: 60, windowMs: 60000, bufferCapacity: 10 },
			openai: { maxRequests: 60, windowMs: 60000, bufferCapacity: 10 },
			chatgpt: { maxRequests: 60, windowMs: 60000, bufferCapacity: 10 },
			gemini: { maxRequests: 60, windowMs: 60000, bufferCapacity: 10 },
			geminiCodeAssist: { maxRequests: 60, windowMs: 60000, bufferCapacity: 10 },
			vertex: { maxRequests: 60, windowMs: 60000, bufferCapacity: 10 },
			nvidia: { maxRequests: 60, windowMs: 60000, bufferCapacity: 10 },
			openrouter: { maxRequests: 60, windowMs: 60000, bufferCapacity: 10 },
			kilo: { maxRequests: 60, windowMs: 60000, bufferCapacity: 10 },
		},
		streamingRetry: {
			anthropic: { enabled: true, maxRetries: 3, maxBufferSizeMB: 10 },
			openai: { enabled: true, maxRetries: 3, maxBufferSizeMB: 10 },
			chatgpt: { enabled: true, maxRetries: 3, maxBufferSizeMB: 10 },
			gemini: { enabled: true, maxRetries: 3, maxBufferSizeMB: 10 },
			geminiCodeAssist: { enabled: true, maxRetries: 3, maxBufferSizeMB: 10 },
			vertex: { enabled: true, maxRetries: 3, maxBufferSizeMB: 10 },
			nvidia: { enabled: true, maxRetries: 3, maxBufferSizeMB: 10 },
			openrouter: { enabled: true, maxRetries: 3, maxBufferSizeMB: 10 },
			kilo: { enabled: true, maxRetries: 3, maxBufferSizeMB: 10 },
		},
		// Feature flags (default true)
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
		proxyBindHost: "[IP_ADDRESS_1786835330040]",
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
	return { ...base, ...overrides };
}

describe("settings-repo.ts", () => {
	before(async () => {
		await setupTestDb();
	});

	after(async () => {
		await teardownTestDb();
	});

	beforeEach(() => {
		clearSettingsTable();
		clearSchemaVersionTable();
		// Delete settings.json to prevent initDb auto-migration from importing it
		const settingsFile = join(testDbDir, "settings.json");
		try { unlinkSync(settingsFile); } catch { /* ignore */ }
		// Re-run migrations to restore default settings row
		initDb();
	});

	describe("getSettings", () => {
		it("returns null on fresh database before migrations run", () => {
			// Clear both tables to simulate truly fresh database
			clearSettingsTable();
			clearSchemaVersionTable();
			
			const result = getSettings();
			assert.equal(result, null);
		});

		it("returns default settings after migrations create the default row", () => {
			// initDb() in beforeEach already ran migrations and created default row
			const result = getSettings();
			
			assert.ok(result !== null);
			assert.equal(result!.logDir, "");
			assert.equal(result!.maxSessions, 0);
			assert.equal(result!.redactPreset, "pii");
			assert.equal(result!.redactReversible, false);
			assert.equal(result!.theme, "system");
			assert.equal(result!.oidcEnabled, false);
			assert.equal(result!.detectorMode, "rules");
			assert.ok(result!.rateLimiter);
			assert.ok(result!.streamingRetry);
			// There are 9 providers: anthropic, openai, chatgpt, gemini, geminiCodeAssist, vertex, nvidia, openrouter, kilo
			assert.equal(Object.keys(result!.rateLimiter).length, 9);
			assert.equal(Object.keys(result!.streamingRetry).length, 9);
		});

		it("returns updated settings after upsertSettings", () => {
			const customSettings = createTestSettings({
				logDir: "/custom/logs",
				maxSessions: 100,
				theme: "dark",
				oidcEnabled: true,
			});
			upsertSettings(customSettings);

			const result = getSettings();
			assert.ok(result !== null);
			assert.equal(result!.logDir, "/custom/logs");
			assert.equal(result!.maxSessions, 100);
			assert.equal(result!.theme, "dark");
			assert.equal(result!.oidcEnabled, true);
		});
	});

	describe("upsertSettings", () => {
		it("inserts settings correctly on first call", () => {
			const customSettings = createTestSettings({
				logDir: "/test/logs",
				maxSessions: 50,
				redactPreset: "secrets",
			});
			upsertSettings(customSettings);

			const result = getSettings();
			assert.ok(result !== null);
			assert.equal(result!.logDir, "/test/logs");
			assert.equal(result!.maxSessions, 50);
			assert.equal(result!.redactPreset, "secrets");
		});

		it("updates settings correctly on subsequent calls", () => {
			const initialSettings = createTestSettings({
				logDir: "/initial/logs",
				maxSessions: 10,
			});
			upsertSettings(initialSettings);

			const updatedSettings = createTestSettings({
				logDir: "/updated/logs",
				maxSessions: 20,
				theme: "light",
			});
			upsertSettings(updatedSettings);

			const result = getSettings();
			assert.ok(result !== null);
			assert.equal(result!.logDir, "/updated/logs");
			assert.equal(result!.maxSessions, 20);
			assert.equal(result!.theme, "light");
			// Ensure other fields retain their default values
			assert.equal(result!.redactPreset, "pii");
		});

		it("correctly serializes rateLimiter as JSON", () => {
			const customRateLimiter = {
				anthropic: { maxRequests: 100, windowMs: 120000, bufferCapacity: 20 },
				openai: { maxRequests: 80, windowMs: 60000, bufferCapacity: 15 },
				chatgpt: { maxRequests: 60, windowMs: 60000, bufferCapacity: 10 },
				gemini: { maxRequests: 60, windowMs: 60000, bufferCapacity: 10 },
				geminiCodeAssist: { maxRequests: 60, windowMs: 60000, bufferCapacity: 10 },
				vertex: { maxRequests: 60, windowMs: 60000, bufferCapacity: 10 },
				nvidia: { maxRequests: 60, windowMs: 60000, bufferCapacity: 10 },
				openrouter: { maxRequests: 60, windowMs: 60000, bufferCapacity: 10 },
				kilo: { maxRequests: 60, windowMs: 60000, bufferCapacity: 10 },
			};
			const customSettings = createTestSettings({ rateLimiter: customRateLimiter });
			upsertSettings(customSettings);

			// Verify directly in database
			const db = new Database(testDbPath);
			const row = db.prepare("SELECT rate_limiter FROM settings WHERE id = 'default'").get() as { rate_limiter: string } | undefined;
			db.close();

			assert.ok(row !== undefined);
			const parsed = JSON.parse(row!.rate_limiter);
			assert.equal(parsed.anthropic.maxRequests, 100);
			assert.equal(parsed.anthropic.windowMs, 120000);
			assert.equal(parsed.anthropic.bufferCapacity, 20);
			assert.equal(parsed.openai.maxRequests, 80);
			assert.equal(parsed.openai.bufferCapacity, 15);
		});

		it("correctly serializes streamingRetry as JSON", () => {
			const customStreamingRetry = {
				anthropic: { enabled: false, maxRetries: 5, maxBufferSizeMB: 20 },
				openai: { enabled: true, maxRetries: 2, maxBufferSizeMB: 5 },
				chatgpt: { enabled: true, maxRetries: 3, maxBufferSizeMB: 10 },
				gemini: { enabled: true, maxRetries: 3, maxBufferSizeMB: 10 },
				geminiCodeAssist: { enabled: true, maxRetries: 3, maxBufferSizeMB: 10 },
				vertex: { enabled: true, maxRetries: 3, maxBufferSizeMB: 10 },
				nvidia: { enabled: true, maxRetries: 3, maxBufferSizeMB: 10 },
				openrouter: { enabled: true, maxRetries: 3, maxBufferSizeMB: 10 },
				kilo: { enabled: true, maxRetries: 3, maxBufferSizeMB: 10 },
			};
			const customSettings = createTestSettings({ streamingRetry: customStreamingRetry });
			upsertSettings(customSettings);

			// Verify directly in database
			const db = new Database(testDbPath);
			const row = db.prepare("SELECT streaming_retry FROM settings WHERE id = 'default'").get() as { streaming_retry: string } | undefined;
			db.close();

			assert.ok(row !== undefined);
			const parsed = JSON.parse(row!.streaming_retry);
			assert.equal(parsed.anthropic.enabled, false);
			assert.equal(parsed.anthropic.maxRetries, 5);
			assert.equal(parsed.anthropic.maxBufferSizeMB, 20);
			assert.equal(parsed.openai.enabled, true);
			assert.equal(parsed.openai.maxRetries, 2);
			assert.equal(parsed.openai.maxBufferSizeMB, 5);
		});

		it("handles all settings fields correctly", () => {
			const customSettings = createTestSettings({
				logDir: "/full/test/logs",
				maxSessions: 500,
				redactPreset: "strict",
				redactReversible: true,
				redactPolicyFile: "/custom/policy.json",
				encryptionAtRest: true,
				captureCleanupEnabled: false,
				captureCleanupIntervalHours: 48,
				captureCleanupMaxAgeDays: 60,
				theme: "dracula",
				oidcEnabled: true,
				oidcPublicUrl: "https://oidc.example.com",
				showPageLoadTime: true,
				detectorMode: "hybrid",
				detectorModelName: "/models",
				detectorThreshold: 0.75,
			});
			upsertSettings(customSettings);

			const result = getSettings();
			assert.ok(result !== null);
			assert.equal(result!.logDir, "/full/test/logs");
			assert.equal(result!.maxSessions, 500);
			assert.equal(result!.redactPreset, "strict");
			assert.equal(result!.redactReversible, true);
			assert.equal(result!.redactPolicyFile, "/custom/policy.json");
			assert.equal(result!.encryptionAtRest, true);
			assert.equal(result!.captureCleanupEnabled, false);
			assert.equal(result!.captureCleanupIntervalHours, 48);
			assert.equal(result!.captureCleanupMaxAgeDays, 60);
			assert.equal(result!.theme, "dracula");
			assert.equal(result!.oidcEnabled, true);
			assert.equal(result!.oidcPublicUrl, "https://oidc.example.com");
			assert.equal(result!.showPageLoadTime, true);
			assert.equal(result!.detectorMode, "hybrid");
			assert.equal(result!.detectorModelName, "/models");
			assert.equal(result!.detectorThreshold, 0.75);
		});
	});

	describe("importSettingsFromJson", () => {
		it("returns skipped when settings.json does not exist", () => {
			const result = importSettingsFromJson("/non/existent/path/settings.json");
			
			assert.equal(result.imported, false);
			assert.equal(result.skipped, true);
			assert.equal(result.error, "File not found");
		});

		it("imports settings from valid JSON file", () => {
			const settingsFile = join(testDbDir, "settings.json");
			const settingsJson = {
				logDir: "/imported/logs",
				maxSessions: 200,
				redactPreset: "secrets",
				theme: "github-dark",
				oidcEnabled: true,
				oidcPublicUrl: "https://imported.oidc.com",
				rateLimiter: {
					anthropic: { maxRequests: 120, windowMs: 60000, bufferCapacity: 15 },
					openai: { maxRequests: 60, windowMs: 60000, bufferCapacity: 10 },
				},
				streamingRetry: {
					anthropic: { enabled: false, maxRetries: 1, maxBufferSizeMB: 5 },
					openai: { enabled: true, maxRetries: 3, maxBufferSizeMB: 10 },
				},
			};
			writeFileSync(settingsFile, JSON.stringify(settingsJson, null, 2));

			const result = importSettingsFromJson(settingsFile);
			
			assert.equal(result.imported, true);
			assert.equal(result.skipped, false);
			assert.equal(result.error, undefined);

			const settings = getSettings();
			assert.ok(settings !== null);
			assert.equal(settings!.logDir, "/imported/logs");
			assert.equal(settings!.maxSessions, 200);
			assert.equal(settings!.redactPreset, "secrets");
			assert.equal(settings!.theme, "github-dark");
			assert.equal(settings!.oidcEnabled, true);
			assert.equal(settings!.oidcPublicUrl, "https://imported.oidc.com");
			assert.equal(settings!.rateLimiter.anthropic.maxRequests, 120);
			assert.equal(settings!.rateLimiter.anthropic.bufferCapacity, 15);
			assert.equal(settings!.streamingRetry.anthropic.enabled, false);
			assert.equal(settings!.streamingRetry.anthropic.maxRetries, 1);
		});

		it("merges partial settings with defaults", () => {
			const settingsFile = join(testDbDir, "settings.json");
			// Only provide a few fields
			const settingsJson = {
				logDir: "/partial/logs",
				theme: "nord",
			};
			writeFileSync(settingsFile, JSON.stringify(settingsJson, null, 2));

			const result = importSettingsFromJson(settingsFile);
			
			assert.equal(result.imported, true);

			const settings = getSettings();
			assert.ok(settings !== null);
			assert.equal(settings!.logDir, "/partial/logs");
			assert.equal(settings!.theme, "nord");
			// Other fields should be defaults
			assert.equal(settings!.maxSessions, 0);
			assert.equal(settings!.redactPreset, "pii");
			assert.equal(settings!.oidcEnabled, false);
		});

		it("handles invalid JSON gracefully", () => {
			const settingsFile = join(testDbDir, "settings.json");
			writeFileSync(settingsFile, "{ invalid json }");

			const result = importSettingsFromJson(settingsFile);
			
			assert.equal(result.imported, false);
			assert.equal(result.skipped, false);
			assert.ok(result.error !== undefined);
			assert.ok(result.error!.includes("Failed to parse") || result.error!.includes("JSON"));
		});

		it("handles non-object JSON gracefully", () => {
			const settingsFile = join(testDbDir, "settings.json");
			writeFileSync(settingsFile, "[]");

			const result = importSettingsFromJson(settingsFile);
			
			// Should fall back to defaults without error
			assert.equal(result.imported, true);
			
			const settings = getSettings();
			assert.ok(settings !== null);
			assert.equal(settings!.logDir, "");
			assert.equal(settings!.theme, "system");
		});

		it("uses defaults for out-of-range numeric fields", () => {
			const settingsFile = join(testDbDir, "settings.json");
			const settingsJson = {
				maxSessions: 20000, // Above max of 10000
				captureCleanupIntervalHours: 200, // Above max of 168
				captureCleanupMaxAgeDays: 500, // Above max of 365
				detectorThreshold: 1.5, // Above max of 1
			};
			writeFileSync(settingsFile, JSON.stringify(settingsJson, null, 2));

			const result = importSettingsFromJson(settingsFile);
			assert.equal(result.imported, true);

			const settings = getSettings();
			assert.ok(settings !== null);
			// Should fall back to defaults for out-of-range values
			assert.equal(settings!.maxSessions, 0); // default
			assert.equal(settings!.captureCleanupIntervalHours, 24); // default
			assert.equal(settings!.captureCleanupMaxAgeDays, 30); // default
			assert.equal(settings!.detectorThreshold, 0.5); // default
		});

		it("validates enum fields and uses defaults for invalid values", () => {
			const settingsFile = join(testDbDir, "settings.json");
			const settingsJson = {
				redactPreset: "invalid-preset",
				theme: "invalid-theme",
				detectorMode: "invalid-mode",
			};
			writeFileSync(settingsFile, JSON.stringify(settingsJson, null, 2));

			const result = importSettingsFromJson(settingsFile);
			assert.equal(result.imported, true);

			const settings = getSettings();
			assert.ok(settings !== null);
			assert.equal(settings!.redactPreset, "pii"); // default
			assert.equal(settings!.theme, "system"); // default
			assert.equal(settings!.detectorMode, "rules"); // default
		});

		it("parses rateLimiter with partial provider configs", () => {
			const settingsFile = join(testDbDir, "settings.json");
			const settingsJson = {
				rateLimiter: {
					anthropic: { maxRequests: 200, windowMs: 30000, bufferCapacity: 5 },
					// Only anthropic provided, others should use defaults
				},
			};
			writeFileSync(settingsFile, JSON.stringify(settingsJson, null, 2));

			const result = importSettingsFromJson(settingsFile);
			assert.equal(result.imported, true);

			const settings = getSettings();
			assert.ok(settings !== null);
			assert.equal(settings!.rateLimiter.anthropic.maxRequests, 200);
			assert.equal(settings!.rateLimiter.anthropic.windowMs, 30000);
			assert.equal(settings!.rateLimiter.anthropic.bufferCapacity, 5);
			// Other providers should have defaults
			assert.equal(settings!.rateLimiter.openai.maxRequests, 60);
			assert.equal(settings!.rateLimiter.openai.windowMs, 60000);
		});

		it("parses streamingRetry with partial provider configs", () => {
			const settingsFile = join(testDbDir, "settings.json");
			const settingsJson = {
				streamingRetry: {
					openai: { enabled: false, maxRetries: 10, maxBufferSizeMB: 50 },
					// Only openai provided, others should use defaults
				},
			};
			writeFileSync(settingsFile, JSON.stringify(settingsJson, null, 2));

			const result = importSettingsFromJson(settingsFile);
			assert.equal(result.imported, true);

			const settings = getSettings();
			assert.ok(settings !== null);
			assert.equal(settings!.streamingRetry.openai.enabled, false);
			assert.equal(settings!.streamingRetry.openai.maxRetries, 10);
			assert.equal(settings!.streamingRetry.openai.maxBufferSizeMB, 50);
			// Other providers should have defaults
			assert.equal(settings!.streamingRetry.anthropic.enabled, true);
			assert.equal(settings!.streamingRetry.anthropic.maxRetries, 3);
		});

		it("uses defaults for out-of-range rateLimiter values", () => {
			const settingsFile = join(testDbDir, "settings.json");
			const settingsJson = {
				rateLimiter: {
					anthropic: { 
						maxRequests: 15000, // Above max 10000
						windowMs: 50, // Below min 100
						bufferCapacity: -5, // Below min 0
					},
				},
			};
			writeFileSync(settingsFile, JSON.stringify(settingsJson, null, 2));

			const result = importSettingsFromJson(settingsFile);
			assert.equal(result.imported, true);

			const settings = getSettings();
			assert.ok(settings !== null);
			// Should use defaults for invalid values
			assert.equal(settings!.rateLimiter.anthropic.maxRequests, 60); // default
			assert.equal(settings!.rateLimiter.anthropic.windowMs, 60000); // default
			assert.equal(settings!.rateLimiter.anthropic.bufferCapacity, 10); // default
		});

		it("uses defaults for out-of-range streamingRetry values", () => {
			const settingsFile = join(testDbDir, "settings.json");
			const settingsJson = {
				streamingRetry: {
					openai: { 
						maxRetries: 15, // Above max 10
						maxBufferSizeMB: 150, // Above max 100
					},
				},
			};
			writeFileSync(settingsFile, JSON.stringify(settingsJson, null, 2));

			const result = importSettingsFromJson(settingsFile);
			assert.equal(result.imported, true);

			const settings = getSettings();
			assert.ok(settings !== null);
			// Should use defaults for invalid values
			assert.equal(settings!.streamingRetry.openai.maxRetries, 3); // default
			assert.equal(settings!.streamingRetry.openai.maxBufferSizeMB, 10); // default
		});
	});

	describe("getSettingsWithMeta", () => {
		it("returns settings with metadata for each field", () => {
			const result = getSettingsWithMeta();

			assert.ok(result.settings !== null);
			assert.ok(result.meta);

			// Check all expected fields have metadata
			const expectedFields: (keyof Settings)[] = [
				"logDir", "maxSessions", "redactPreset", "redactReversible",
				"redactPolicyFile", "encryptionAtRest", "captureCleanupEnabled",
				"captureCleanupIntervalHours", "captureCleanupMaxAgeDays",
				"theme", "oidcEnabled", "oidcPublicUrl", "showPageLoadTime",
				"detectorMode", "detectorModelName", "detectorThreshold",
				"rateLimiter", "streamingRetry",
				// Feature flags
				"enableLogger", "enableRedact", "enableRateLimiter", "logTraffic",
				// Advanced rate limiter cache configuration
				"rateLimiterMaxEntries", "rateLimiterCleanupIntervalMs", "rateLimiterEntryTtlMs",
				// Advanced streaming retry cache configuration
				"retryMaxEntries", "retryEntryTtlMs", "retryCleanupIntervalMs",
				"retryMaxBufferSize", "retryMaxStreamRetries",
				// Proxy configuration
				"proxyBindHost", "proxyPort", "proxyAllowTargetOverride",
				"strictUrlForwarding", "upstreamOpenAiUrl", "upstreamAnthropicUrl",
				"upstreamChatGptUrl", "upstreamGeminiUrl", "upstreamVertexUrl",
				"upstreamNvidiaUrl", "upstreamOpenRouterUrl", "upstreamKiloUrl",
				"upstreamGeminiCodeAssistUrl",
			];

			for (const field of expectedFields) {
				assert.ok(field in result.meta, `Missing metadata for ${field}`);
				assert.ok(["settings-file", "environment-variable", "default"].includes(result.meta[field].source));
				assert.ok(typeof result.meta[field].dynamic === "boolean");
			}
		});

		it("marks all fields as 'default' when no env vars or settings file applied", () => {
			const result = getSettingsWithMeta();
			
			for (const [key, meta] of Object.entries(result.meta)) {
				assert.equal(meta.source, "default", `Field ${key} should be 'default'`);
				assert.equal(meta.envVar, null);
			}
		});

		it("marks fields as 'environment-variable' when appliedEnvKeys provided", () => {
			const appliedEnvKeys = new Set<keyof Settings>(["logDir", "theme", "oidcEnabled"]);
			const result = getSettingsWithMeta(appliedEnvKeys);
			
			assert.equal(result.meta.logDir.source, "environment-variable");
			assert.equal(result.meta.logDir.envVar, "LOGGER_CAPTURE_DIR");
			assert.equal(result.meta.theme.source, "environment-variable");
			assert.equal(result.meta.theme.envVar, "CONTEXTIO_THEME");
			assert.equal(result.meta.oidcEnabled.source, "environment-variable");
			assert.equal(result.meta.oidcEnabled.envVar, "CONTEXTIO_OIDC_ENABLED");
			
			// Other fields should still be default
			assert.equal(result.meta.maxSessions.source, "default");
			assert.equal(result.meta.redactPreset.source, "default");
		});

		it("marks fields as 'settings-file' when they differ from defaults", () => {
			const customSettings = createTestSettings({
				logDir: "/custom/logs",
				theme: "dark",
				maxSessions: 100,
			});
			upsertSettings(customSettings);
			
			const result = getSettingsWithMeta();
			
			assert.equal(result.meta.logDir.source, "settings-file");
			assert.equal(result.meta.theme.source, "settings-file");
			assert.equal(result.meta.maxSessions.source, "settings-file");
			
			// Fields still at defaults
			assert.equal(result.meta.redactPreset.source, "default");
			assert.equal(result.meta.oidcEnabled.source, "default");
		});

		it("correctly identifies rateLimiter and streamingRetry source", () => {
			// Default should be 'default'
			let result = getSettingsWithMeta();
			assert.equal(result.meta.rateLimiter.source, "default");
			assert.equal(result.meta.streamingRetry.source, "default");
			
			// After custom upsert
			const customSettings = createTestSettings({
				rateLimiter: {
					anthropic: { maxRequests: 100, windowMs: 60000, bufferCapacity: 10 },
					openai: { maxRequests: 60, windowMs: 60000, bufferCapacity: 10 },
					chatgpt: { maxRequests: 60, windowMs: 60000, bufferCapacity: 10 },
					gemini: { maxRequests: 60, windowMs: 60000, bufferCapacity: 10 },
					geminiCodeAssist: { maxRequests: 60, windowMs: 60000, bufferCapacity: 10 },
					vertex: { maxRequests: 60, windowMs: 60000, bufferCapacity: 10 },
					nvidia: { maxRequests: 60, windowMs: 60000, bufferCapacity: 10 },
					openrouter: { maxRequests: 60, windowMs: 60000, bufferCapacity: 10 },
					kilo: { maxRequests: 60, windowMs: 60000, bufferCapacity: 10 },
				},
				streamingRetry: {
					anthropic: { enabled: true, maxRetries: 3, maxBufferSizeMB: 10 },
					openai: { enabled: true, maxRetries: 3, maxBufferSizeMB: 10 },
					chatgpt: { enabled: true, maxRetries: 3, maxBufferSizeMB: 10 },
					gemini: { enabled: true, maxRetries: 3, maxBufferSizeMB: 10 },
					geminiCodeAssist: { enabled: true, maxRetries: 3, maxBufferSizeMB: 10 },
					vertex: { enabled: true, maxRetries: 3, maxBufferSizeMB: 10 },
					nvidia: { enabled: true, maxRetries: 3, maxBufferSizeMB: 10 },
					openrouter: { enabled: true, maxRetries: 3, maxBufferSizeMB: 10 },
					kilo: { enabled: true, maxRetries: 3, maxBufferSizeMB: 10 },
				},
			});
			// Change one value to make it different from defaults
			customSettings.rateLimiter.anthropic.maxRequests = 200;
			upsertSettings(customSettings);
			
			result = getSettingsWithMeta();
			assert.equal(result.meta.rateLimiter.source, "settings-file");
			assert.equal(result.meta.streamingRetry.source, "default"); // unchanged
		});
	});

	describe("getDefaultSettingsFile", () => {
		it("returns SETTINGS_FILE env var when set", () => {
			const customPath = "/custom/settings.json";
			process.env.SETTINGS_FILE = customPath;
			assert.equal(getDefaultSettingsFile(), customPath);
			delete process.env.SETTINGS_FILE;
		});

		it("falls back to /app/custom-policy/settings.json when env var not set", () => {
			delete process.env.SETTINGS_FILE;
			assert.equal(getDefaultSettingsFile(), "/app/custom-policy/settings.json");
		});
	});

	describe("Integration: Full settings workflow", () => {
		it("imports settings.json, then upsertSettings, then getSettingsWithMeta", () => {
			// 1. Import from JSON
			const settingsFile = join(testDbDir, "settings.json");
			const settingsJson = {
				logDir: "/workflow/logs",
				theme: "material-dark",
				oidcEnabled: true,
			};
			writeFileSync(settingsFile, JSON.stringify(settingsJson, null, 2));
			
			const importResult = importSettingsFromJson(settingsFile);
			assert.equal(importResult.imported, true);
			
			let settings = getSettings();
			assert.ok(settings !== null);
			assert.equal(settings!.logDir, "/workflow/logs");
			assert.equal(settings!.theme, "material-dark");
			assert.equal(settings!.oidcEnabled, true);
			
			// 2. Update via upsertSettings - only change specific fields
			const updatedSettings = { ...settings, logDir: "/workflow/updated", maxSessions: 500 };
			upsertSettings(updatedSettings);
			
			settings = getSettings();
			assert.ok(settings !== null);
			assert.equal(settings!.logDir, "/workflow/updated");
			assert.equal(settings!.maxSessions, 500);
			assert.equal(settings!.theme, "material-dark"); // preserved from import
			assert.equal(settings!.oidcEnabled, true); // preserved from import
			
			// 3. Get with metadata
			const metaResult = getSettingsWithMeta();
			assert.equal(metaResult.meta.logDir.source, "settings-file");
			assert.equal(metaResult.meta.maxSessions.source, "settings-file");
			assert.equal(metaResult.meta.theme.source, "settings-file");
			assert.equal(metaResult.meta.oidcEnabled.source, "settings-file");
		});

		it("handles SQLite persistence across initDb calls", () => {
			// Insert custom settings
			const customSettings = createTestSettings({
				logDir: "/persistent/logs",
				maxSessions: 999,
			});
			upsertSettings(customSettings);
			
			// Close and reinitialize
			closeDb();
			initDb();
			
			// Settings should persist
			const settings = getSettings();
			assert.ok(settings !== null);
			assert.equal(settings!.logDir, "/persistent/logs");
			assert.equal(settings!.maxSessions, 999);
		});
	});
});