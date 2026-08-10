import { describe, it, before, after, beforeEach } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync, existsSync, unlinkSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import Database from "better-sqlite3";

import {
	importSettingsFromJson,
	getDefaultSettingsFile,
	closeDb,
	initDb,
	getSettings,
	upsertSettings,
	getSettingsWithMeta,
} from "../dist/db/index.js";

import { runMigrations } from "../dist/db/migrations.js";

/**
 * Test database and settings file setup for migration tests.
 */

let testDbDir: string;
let testDbPath: string;

function clearSettingsTable(): void {
	const db = new Database(testDbPath);
	try {
		db.prepare("DELETE FROM settings").run();
	} catch {
		// Table doesn't exist yet, ignore
	}
	db.close();
}

function clearSchemaVersionTable(): void {
	const db = new Database(testDbPath);
	try {
		db.prepare("DELETE FROM schema_version").run();
	} catch {
		// Table doesn't exist yet, ignore
	}
	db.close();
}

function resetDatabase(): void {
	clearSettingsTable();
	clearSchemaVersionTable();
	// Do NOT run migrations - let initDb() do it
}

function runMigrationsOnly(): void {
	runMigrations();
}

// Helper to get a fresh database for auto-migration tests
function freshDb(): void {
	resetDatabase();
	// Remove any existing settings.json to ensure clean state
	const settingsFile = join(testDbDir, "settings.json");
	try { unlinkSync(settingsFile); } catch { /* ignore if file doesn't exist */ }
	// initDb() will run migrations and auto-migration
}

// Helper to get an initialized (non-fresh) database
function initializedDb(): void {
	resetDatabase();
	runMigrationsOnly(); // Run migrations to populate schema_version
	// Now database is initialized (non-fresh)
}

// Setup test database - just create the directory and set env vars
async function setupTest(): Promise<void> {
	testDbDir = mkdtempSync(join(tmpdir(), "contextio-migrate-settings-test-"));
	testDbPath = join(testDbDir, "test.db");

	process.env.CONTEXTIO_DB_PATH = testDbPath;
	process.env.SETTINGS_FILE = join(testDbDir, "settings.json");

	closeDb();
	// Do NOT call initDb here - each test will set up its own database state
}

function createTestSettingsFile(overrides: Record<string, unknown> = {}): string {
	const base = {
		logDir: "/imported/logs",
		maxSessions: 100,
		redactPreset: "secrets",
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
		detectorModelDir: "/models",
		detectorThreshold: 0.75,
		rateLimiter: {
			anthropic: { maxRequests: 120, windowMs: 60000, bufferCapacity: 15 },
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
			anthropic: { enabled: false, maxRetries: 5, maxBufferSizeMB: 20 },
			openai: { enabled: true, maxRetries: 3, maxBufferSizeMB: 10 },
			chatgpt: { enabled: true, maxRetries: 3, maxBufferSizeMB: 10 },
			gemini: { enabled: true, maxRetries: 3, maxBufferSizeMB: 10 },
			geminiCodeAssist: { enabled: true, maxRetries: 3, maxBufferSizeMB: 10 },
			vertex: { enabled: true, maxRetries: 3, maxBufferSizeMB: 10 },
			nvidia: { enabled: true, maxRetries: 3, maxBufferSizeMB: 10 },
			openrouter: { enabled: true, maxRetries: 3, maxBufferSizeMB: 10 },
			kilo: { enabled: true, maxRetries: 3, maxBufferSizeMB: 10 },
		},
	};
	const content = { ...base, ...overrides };
	const filePath = join(testDbDir, "settings.json");
	writeFileSync(filePath, JSON.stringify(content, null, 2));
	return filePath;
}

// Cleanup
async function teardownTest(): Promise<void> {
	closeDb();
	if (testDbDir) {
		rmSync(testDbDir, { recursive: true, force: true });
	}
	delete process.env.CONTEXTIO_DB_PATH;
	delete process.env.SETTINGS_FILE;
}

describe("migrate-settings - Settings Auto-Migration (via initDb)", () => {
	before(async () => {
		await setupTest();
	});

	after(async () => {
		await teardownTest();
	});

	describe("Auto-migration runs on fresh database with existing settings.json", () => {
		it("imports settings.json when database is fresh and file exists", () => {
			// Fresh database - no migrations run yet
			freshDb();
			// Create settings.json AFTER freshDb()
			const settingsFile = createTestSettingsFile();
			assert.ok(existsSync(settingsFile));

			initDb();

			// Verify settings were imported
			const settings = getSettings();
			assert.ok(settings !== null);
			assert.equal(settings!.logDir, "/imported/logs");
			assert.equal(settings!.maxSessions, 100);
			assert.equal(settings!.redactPreset, "secrets");
			assert.equal(settings!.theme, "dracula");
			assert.equal(settings!.oidcEnabled, true);
			assert.equal(settings!.rateLimiter.anthropic.maxRequests, 120);
			assert.equal(settings!.streamingRetry.anthropic.enabled, false);
		});

		it("imports all fields correctly from settings.json", () => {
			freshDb();
			const settingsFile = createTestSettingsFile();
			
			initDb();

			const settings = getSettings();
			assert.ok(settings !== null);
			assert.equal(settings!.logDir, "/imported/logs");
			assert.equal(settings!.maxSessions, 100);
			assert.equal(settings!.redactPreset, "secrets");
			assert.equal(settings!.redactReversible, true);
			assert.equal(settings!.redactPolicyFile, "/custom/policy.json");
			assert.equal(settings!.encryptionAtRest, true);
			assert.equal(settings!.captureCleanupEnabled, false);
			assert.equal(settings!.captureCleanupIntervalHours, 48);
			assert.equal(settings!.captureCleanupMaxAgeDays, 60);
			assert.equal(settings!.theme, "dracula");
			assert.equal(settings!.oidcEnabled, true);
			assert.equal(settings!.oidcPublicUrl, "https://oidc.example.com");
			assert.equal(settings!.showPageLoadTime, true);
			assert.equal(settings!.detectorMode, "hybrid");
			assert.equal(settings!.detectorModelDir, "/models");
			assert.equal(settings!.detectorThreshold, 0.75);
		});

		it("imports rateLimiter and streamingRetry for all providers", () => {
			freshDb();
			const settingsFile = createTestSettingsFile();
			
			initDb();

			const settings = getSettings();
			assert.ok(settings !== null);
			
			// Check all 9 providers in rateLimiter
			const providers = ["anthropic", "openai", "chatgpt", "gemini", "geminiCodeAssist", "vertex", "nvidia", "openrouter", "kilo"];
			for (const provider of providers) {
				assert.ok(settings!.rateLimiter[provider as keyof typeof settings.rateLimiter]);
				assert.ok(typeof settings!.rateLimiter[provider as keyof typeof settings.rateLimiter].maxRequests === "number");
			}
			
			// Check all 9 providers in streamingRetry
			for (const provider of providers) {
				assert.ok(settings!.streamingRetry[provider as keyof typeof settings.streamingRetry]);
				assert.ok(typeof settings!.streamingRetry[provider as keyof typeof settings.streamingRetry].enabled === "boolean");
			}
		});
	});

	describe("Auto-migration is skipped if settings already exist in DB", () => {
		it("does not overwrite existing settings when initDb runs again", () => {
			// First initDb with settings.json
			freshDb();
			const settingsFile = createTestSettingsFile();
			
			initDb();

			// Modify the imported settings via upsertSettings
			upsertSettings({
				...getSettings()!,
				logDir: "/modified/after/import",
				maxSessions: 999,
			});

			// Run initDb again (simulating app restart)
			// Since schema_version exists, it's not a fresh DB
			initDb();

			// Settings should NOT be re-imported from file
			const settings = getSettings();
			assert.ok(settings !== null);
			assert.equal(settings!.logDir, "/modified/after/import");
			assert.equal(settings!.maxSessions, 999);
			// Other fields from original import should remain
			assert.equal(settings!.theme, "dracula");
			assert.equal(settings!.oidcEnabled, true);
		});

		it("preserves database settings when initDb runs on non-fresh database", () => {
			// First initDb without settings.json
			initializedDb();

			// Update settings in DB
			upsertSettings({
				...getSettings()!,
				logDir: "/db/configured",
				theme: "nord",
			});

			// Now create settings.json with DIFFERENT values
			const settingsFile = createTestSettingsFile({ logDir: "/file/configured", theme: "github-light" });
			
			// Run initDb again - should NOT import from file since DB already initialized
			initDb();

			const settings = getSettings();
			assert.ok(settings !== null);
			assert.equal(settings!.logDir, "/db/configured");
			assert.equal(settings!.theme, "nord");
			// Should NOT have file values
			assert.notEqual(settings!.logDir, "/file/configured");
			assert.notEqual(settings!.theme, "github-light");
		});
	});

	describe("Migration handles missing/invalid settings.json gracefully", () => {
		it("does not fail when settings.json does not exist", () => {
			// Fresh database, no settings.json file
			freshDb();
			initDb();

			// Should create default settings row
			const settings = getSettings();
			assert.ok(settings !== null);
			assert.equal(settings!.logDir, "");
			assert.equal(settings!.theme, "system");
			assert.equal(settings!.maxSessions, 0);
		});

		it("does not fail when settings.json contains invalid JSON", () => {
			const settingsFile = join(testDbDir, "settings.json");
			writeFileSync(settingsFile, "{ invalid json }");

			freshDb();
			initDb();

			// Should fall back to defaults
			const settings = getSettings();
			assert.ok(settings !== null);
			assert.equal(settings!.logDir, "");
			assert.equal(settings!.theme, "system");
		});

		it("does not fail when settings.json contains non-object JSON", () => {
			const settingsFile = join(testDbDir, "settings.json");
			writeFileSync(settingsFile, "[]");

			freshDb();
			initDb();

			// Should fall back to defaults
			const settings = getSettings();
			assert.ok(settings !== null);
			assert.equal(settings!.logDir, "");
			assert.equal(settings!.theme, "system");
		});

		it("handles partial settings.json with only some fields", () => {
			freshDb();
			const settingsFile = join(testDbDir, "settings.json");
			writeFileSync(settingsFile, JSON.stringify({ logDir: "/partial", theme: "monokai" }));

			initDb();

			const settings = getSettings();
			assert.ok(settings !== null);
			assert.equal(settings!.logDir, "/partial");
			assert.equal(settings!.theme, "monokai");
			// Other fields should be defaults
			assert.equal(settings!.maxSessions, 0);
			assert.equal(settings!.redactPreset, "pii");
		});
	});

	describe("Integration: End-to-end with SQLite", () => {
		it("settings API works end-to-end: import -> get -> upsert -> getWithMeta", () => {
			// 1. Start with fresh database and settings.json
			freshDb();
			const settingsFile = createTestSettingsFile({ logDir: "/e2e/test", maxSessions: 42 });
			
			initDb();

			// 2. Verify import worked
			let settings = getSettings();
			assert.ok(settings !== null);
			assert.equal(settings!.logDir, "/e2e/test");
			assert.equal(settings!.maxSessions, 42);

			// 3. Update via upsertSettings
			upsertSettings({ ...settings, maxSessions: 100, theme: "high-contrast" });

			// 4. Verify update worked
			settings = getSettings();
			assert.ok(settings !== null);
			assert.equal(settings!.maxSessions, 100);
			assert.equal(settings!.theme, "high-contrast");
			assert.equal(settings!.logDir, "/e2e/test"); // preserved

			// 5. Verify metadata
			const metaResult = getSettingsWithMeta();
			assert.equal(metaResult.meta.maxSessions.source, "settings-file");
			assert.equal(metaResult.meta.theme.source, "settings-file");
			assert.equal(metaResult.meta.logDir.source, "settings-file");
		});

		it("multiple initDb calls maintain settings correctly", () => {
			freshDb();
			const settingsFile = createTestSettingsFile({ logDir: "/multi/init", theme: "solarized-dark" });
			
			// First init
			initDb();
			
			let settings = getSettings();
			assert.ok(settings !== null);
			assert.equal(settings!.logDir, "/multi/init");
			assert.equal(settings!.theme, "solarized-dark");

			// Second init (app restart)
			initDb();
			
			settings = getSettings();
			assert.ok(settings !== null);
			assert.equal(settings!.logDir, "/multi/init");
			assert.equal(settings!.theme, "solarized-dark");

			// Third init
			initDb();
			
			settings = getSettings();
			assert.ok(settings !== null);
			assert.equal(settings!.logDir, "/multi/init");
			assert.equal(settings!.theme, "solarized-dark");
		});

		it("settings persist across database close/reopen", () => {
			freshDb();
			const settingsFile = createTestSettingsFile({ logDir: "/persist/test", maxSessions: 777 });
			
			initDb();

			// Modify settings
			upsertSettings({ ...getSettings()!, maxSessions: 888 });

			// Close and reopen
			closeDb();
			initDb();

			const settings = getSettings();
			assert.ok(settings !== null);
			assert.equal(settings!.logDir, "/persist/test");
			assert.equal(settings!.maxSessions, 888);
		});

		it("rateLimiter and streamingRetry JSON serialization works end-to-end", () => {
			freshDb();
			const settingsFile = createTestSettingsFile({
				rateLimiter: {
					anthropic: { maxRequests: 200, windowMs: 30000, bufferCapacity: 5 },
					openai: { maxRequests: 150, windowMs: 45000, bufferCapacity: 8 },
				},
				streamingRetry: {
					anthropic: { enabled: false, maxRetries: 1, maxBufferSizeMB: 5 },
					openai: { enabled: true, maxRetries: 10, maxBufferSizeMB: 50 },
				},
			});
			
			initDb();

			let settings = getSettings();
			assert.ok(settings !== null);
			assert.equal(settings!.rateLimiter.anthropic.maxRequests, 200);
			assert.equal(settings!.rateLimiter.anthropic.windowMs, 30000);
			assert.equal(settings!.rateLimiter.anthropic.bufferCapacity, 5);
			assert.equal(settings!.rateLimiter.openai.maxRequests, 150);
			
			assert.equal(settings!.streamingRetry.anthropic.enabled, false);
			assert.equal(settings!.streamingRetry.anthropic.maxRetries, 1);
			assert.equal(settings!.streamingRetry.openai.maxRetries, 10);
			assert.equal(settings!.streamingRetry.openai.maxBufferSizeMB, 50);

			// Update via upsertSettings
			const updated = { ...settings };
			updated.rateLimiter.anthropic.maxRequests = 300;
			updated.streamingRetry.openai.enabled = false;
			upsertSettings(updated);

			// Verify update
			settings = getSettings();
			assert.ok(settings !== null);
			assert.equal(settings!.rateLimiter.anthropic.maxRequests, 300);
			assert.equal(settings!.streamingRetry.openai.enabled, false);
		});

		it("works with getSettingsWithMeta after migration", () => {
			freshDb();
			// Create settings.json with only logDir and theme to test default fields
			const settingsFile = join(testDbDir, "settings.json");
			writeFileSync(settingsFile, JSON.stringify({ logDir: "/meta/test", theme: "material-light" }));
			
			initDb();

			const metaResult = getSettingsWithMeta();
			assert.ok(metaResult.settings !== null);
			assert.equal(metaResult.meta.logDir.source, "settings-file");
			assert.equal(metaResult.meta.theme.source, "settings-file");
			// maxSessions not in settings.json, should be default
			assert.equal(metaResult.meta.maxSessions.source, "default");
			
			// Default fields
			assert.equal(metaResult.meta.redactPreset.source, "default");
			assert.equal(metaResult.meta.oidcEnabled.source, "default");
		});

		it("appliedEnvKeys correctly marks env-sourced fields after migration", () => {
			freshDb();
			const settingsFile = createTestSettingsFile({ logDir: "/env/test", theme: "github-dark" });
			
			initDb();

			// Simulate env overrides being applied
			const metaResult = getSettingsWithMeta();
			const appliedEnvKeys = new Set<keyof typeof metaResult.settings>(["logDir", "oidcEnabled"]);
			const metaResultWithEnv = getSettingsWithMeta(appliedEnvKeys);
			
			assert.equal(metaResultWithEnv.meta.logDir.source, "environment-variable");
			assert.equal(metaResultWithEnv.meta.logDir.envVar, "LOGGER_CAPTURE_DIR");
			assert.equal(metaResultWithEnv.meta.oidcEnabled.source, "environment-variable");
			assert.equal(metaResultWithEnv.meta.oidcEnabled.envVar, "CONTEXTIO_OIDC_ENABLED");
			
			// File-sourced fields
			assert.equal(metaResultWithEnv.meta.theme.source, "settings-file");
			
			// Default fields (maxSessions was in settings.json)
			assert.equal(metaResultWithEnv.meta.maxSessions.source, "settings-file");
		});
	});
});

describe("importSettingsFromJson - Direct function tests", () => {
	before(async () => {
		await setupTest();
	});

	after(async () => {
		await teardownTest();
	});

	beforeEach(() => {
		// Reset database for each test
		resetDatabase();
		// Delete settings.json to prevent initDb auto-migration from importing it
		const settingsFile = join(testDbDir, "settings.json");
		try { unlinkSync(settingsFile); } catch { /* ignore */ }
		initDb(); // Run migrations to create tables
	});

	it("returns imported=true when file exists and is valid", () => {
		const settingsFile = createTestSettingsFile({ logDir: "/direct/import" });
		
		const result = importSettingsFromJson(settingsFile);
		
		assert.equal(result.imported, true);
		assert.equal(result.skipped, false);
		assert.equal(result.error, undefined);
	});

	it("returns skipped=true when file does not exist", () => {
		const result = importSettingsFromJson("/non/existent/settings.json");
		
		assert.equal(result.imported, false);
		assert.equal(result.skipped, true);
		assert.equal(result.error, "File not found");
	});

	it("returns error when file contains invalid JSON", () => {
		const settingsFile = join(testDbDir, "settings.json");
		writeFileSync(settingsFile, "{ invalid }");
		
		const result = importSettingsFromJson(settingsFile);
		
		assert.equal(result.imported, false);
		assert.equal(result.skipped, false);
		assert.ok(result.error !== undefined);
	});

	it("imports all settings fields correctly", () => {
		const settingsFile = createTestSettingsFile();
		
		const result = importSettingsFromJson(settingsFile);
		
		assert.equal(result.imported, true);
		
		const settings = getSettings();
		assert.ok(settings !== null);
		assert.equal(settings!.logDir, "/imported/logs");
		assert.equal(settings!.maxSessions, 100);
		assert.equal(settings!.redactPreset, "secrets");
		assert.equal(settings!.redactReversible, true);
		assert.equal(settings!.encryptionAtRest, true);
		assert.equal(settings!.captureCleanupEnabled, false);
		assert.equal(settings!.theme, "dracula");
		assert.equal(settings!.oidcEnabled, true);
		assert.equal(settings!.detectorMode, "hybrid");
		assert.equal(settings!.detectorThreshold, 0.75);
	});

	it("merges partial settings with defaults", () => {
		const settingsFile = join(testDbDir, "settings.json");
		writeFileSync(settingsFile, JSON.stringify({ logDir: "/partial", theme: "one-dark" }));
		
		const result = importSettingsFromJson(settingsFile);
		
		assert.equal(result.imported, true);
		
		const settings = getSettings();
		assert.ok(settings !== null);
		assert.equal(settings!.logDir, "/partial");
		assert.equal(settings!.theme, "one-dark");
		// Defaults
		assert.equal(settings!.maxSessions, 0);
		assert.equal(settings!.redactPreset, "pii");
	});
});