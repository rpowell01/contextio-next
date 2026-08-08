import { describe, it, before, after, beforeEach } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync, existsSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import Database from "better-sqlite3";

import {
	migrateProviders,
	previewProvidersMigration,
	getDefaultProvidersFile,
	type MigrateProvidersOptions,
	type MigrateProvidersResult,
} from "../dist/db/migrate-providers.js";

import { runMigrations } from "../dist/db/migrations.js";

import {
	createProvider,
	getProviderById,
	getAllProvidersFromDb,
	closeDb,
	initDb,
} from "../dist/db/index.js";

/**
 * Test database setup.
 */

let testDbDir: string;
let testDbPath: string;

function createTestProviderConfig(overrides: Record<string, unknown> = {}): Record<string, unknown> {
	const base = {
		id: `openai`,
		name: "Test Provider",
		upstreamUrl: "https://test.provider/api",
		apiFormat: "chat-completions",
		authType: "bearer",
		enabled: true,
		rateLimit: { maxRequests: 60, windowMs: 60000, bufferCapacity: 10 },
		retry: { maxRetries: 3, baseDelayMs: 1000, maxDelayMs: 30000, retryableStatuses: [429, 500, 502, 503, 504], jitterFactor: 0.2, maxStreamRetries: 3, maxResponseBufferSize: 10 * 1024 * 1024, enabled: true },
		customHeaders: {},
		allowBaseUrlOverride: true,
		baseUrlOverrideHeader: "x-test-baseurl",
	};
	return { ...base, ...overrides };
}

// Setup test database
async function setupTest(): Promise<void> {
	testDbDir = mkdtempSync(join(tmpdir(), "contextio-migrate-providers-test-"));
	testDbPath = join(testDbDir, "test.db");

	process.env.CONTEXTIO_DB_PATH = testDbPath;
	process.env.PROVIDERS_FILE = join(testDbDir, "providers.json");

	closeDb();
	initDb();
}

function clearProvidersTable(): void {
	const db = new Database(testDbPath);
	db.prepare("DELETE FROM providers").run();
	db.prepare("DELETE FROM schema_version").run();
	db.close();
	// Re-run migrations to restore default providers
	runMigrations();
}

// Cleanup
async function teardownTest(): Promise<void> {
	closeDb();
	if (testDbDir) {
		rmSync(testDbDir, { recursive: true, force: true });
	}
	delete process.env.CONTEXTIO_DB_PATH;
	delete process.env.PROVIDERS_FILE;
}

describe("migrate-providers.ts - Provider Migration", () => {
	before(async () => {
		await setupTest();
	});

	after(async () => {
		await teardownTest();
	});

	beforeEach(() => {
		clearProvidersTable();
	});

	describe("getDefaultProvidersFile", () => {
		it("returns PROVIDERS_FILE env var when set", () => {
			const customPath = "/custom/providers.json";
			process.env.PROVIDERS_FILE = customPath;
			assert.equal(getDefaultProvidersFile(), customPath);
			delete process.env.PROVIDERS_FILE;
		});

		it("falls back to /app/custom-policy/providers.json when env var not set", () => {
			delete process.env.PROVIDERS_FILE;
			assert.equal(getDefaultProvidersFile(), "/app/custom-policy/providers.json");
		});
	});

	describe("migrateProviders", () => {
		it("returns zero counts when providers file does not exist", () => {
			const result = migrateProviders({ providersFile: "/non/existent/providers.json" });
			
			assert.equal(result.imported, 0);
			assert.equal(result.updated, 0);
			assert.equal(result.skipped, 0);
			assert.equal(result.failed, 0);
			assert.equal(result.totalProviders, 0);
			assert.deepEqual(result.errors, []);
			assert.equal(result.backupPath, undefined);
		});

		it("imports providers from JSON object format", () => {
			const providersFile = join(testDbDir, "providers.json");
			const providersJson = {
				"openai": {
					id: "openai",
					name: "OpenAI Imported",
					upstreamUrl: "https://imported.openai.com",
					apiFormat: "chat-completions",
					authType: "bearer",
					enabled: true,
					rateLimit: { maxRequests: 60, windowMs: 60000, bufferCapacity: 10 },
					retry: { maxRetries: 3, baseDelayMs: 1000, maxDelayMs: 30000, retryableStatuses: [429, 500, 502, 503, 504], jitterFactor: 0.2, maxStreamRetries: 3, maxResponseBufferSize: 10 * 1024 * 1024, enabled: true },
					customHeaders: { "X-Imported": "true" },
					allowBaseUrlOverride: true,
					baseUrlOverrideHeader: "x-openai-baseurl",
				},
				"anthropic": {
					id: "anthropic",
					name: "Anthropic Imported",
					upstreamUrl: "https://imported.anthropic.com",
					apiFormat: "anthropic-messages",
					authType: "api-key",
					enabled: true,
					rateLimit: { maxRequests: 60, windowMs: 60000, bufferCapacity: 10 },
					retry: { maxRetries: 3, baseDelayMs: 1000, maxDelayMs: 30000, retryableStatuses: [429, 500, 502, 503, 504], jitterFactor: 0.2, maxStreamRetries: 3, maxResponseBufferSize: 10 * 1024 * 1024, enabled: true },
					customHeaders: {},
					allowBaseUrlOverride: true,
					baseUrlOverrideHeader: "x-anthropic-baseurl",
				},
			};
			writeFileSync(providersFile, JSON.stringify(providersJson, null, 2));

			const result = migrateProviders({ providersFile });
			
			assert.equal(result.totalProviders, 2);
			assert.equal(result.imported, 0);
			assert.equal(result.updated, 2);
			assert.equal(result.skipped, 0);
			assert.equal(result.failed, 0);
			
			const dbProviders = getAllProvidersFromDb();
			assert.ok(dbProviders.has("openai"));
			assert.ok(dbProviders.has("anthropic"));
			assert.equal(dbProviders.get("openai")!.source, "file");
			assert.equal(dbProviders.get("openai")!.dynamic, true);
			assert.equal(dbProviders.get("anthropic")!.customHeaders["X-Imported"], undefined);
		});

		it("imports providers from JSON array format", () => {
			const providersFile = join(testDbDir, "providers-array.json");
			const providersArray = [
				{
					id: "openai",
					name: "OpenAI Array",
					upstreamUrl: "https://array.openai.com",
					apiFormat: "chat-completions",
					authType: "bearer",
					enabled: true,
					rateLimit: { maxRequests: 60, windowMs: 60000, bufferCapacity: 10 },
					retry: { maxRetries: 3, baseDelayMs: 1000, maxDelayMs: 30000, retryableStatuses: [429, 500, 502, 503, 504], jitterFactor: 0.2, maxStreamRetries: 3, maxResponseBufferSize: 10 * 1024 * 1024, enabled: true },
					customHeaders: {},
					allowBaseUrlOverride: true,
					baseUrlOverrideHeader: "x-openai-baseurl",
				},
				{
					id: "anthropic",
					name: "Anthropic Array",
					upstreamUrl: "https://array.anthropic.com",
					apiFormat: "anthropic-messages",
					authType: "api-key",
					enabled: true,
					rateLimit: { maxRequests: 60, windowMs: 60000, bufferCapacity: 10 },
					retry: { maxRetries: 3, baseDelayMs: 1000, maxDelayMs: 30000, retryableStatuses: [429, 500, 502, 503, 504], jitterFactor: 0.2, maxStreamRetries: 3, maxResponseBufferSize: 10 * 1024 * 1024, enabled: true },
					customHeaders: {},
					allowBaseUrlOverride: true,
					baseUrlOverrideHeader: "x-anthropic-baseurl",
				},
			];
			writeFileSync(providersFile, JSON.stringify(providersArray, null, 2));

			const result = migrateProviders({ providersFile });
			
			assert.equal(result.totalProviders, 2);
			assert.equal(result.imported, 0);
			assert.equal(result.updated, 2);
			
			const dbProviders = getAllProvidersFromDb();
			assert.ok(dbProviders.has("openai"));
			assert.ok(dbProviders.has("anthropic"));
			assert.equal(dbProviders.get("openai")!.source, "file");
			assert.equal(dbProviders.get("anthropic")!.source, "file");
		});

		it("updates existing default providers with file source", () => {
			// Default providers are created by migrations during initDb()
			const initialCount = getAllProvidersFromDb().size;

			const providersFile = join(testDbDir, "providers.json");
			const providersJson = {
				openai: {
					id: "openai",
					name: "OpenAI from JSON",
					upstreamUrl: "https://json.openai.com",
					apiFormat: "chat-completions",
					authType: "bearer",
					enabled: true,
					rateLimit: { maxRequests: 60, windowMs: 60000, bufferCapacity: 10 },
					retry: { maxRetries: 3, baseDelayMs: 1000, maxDelayMs: 30000, retryableStatuses: [429, 500, 502, 503, 504], jitterFactor: 0.2, maxStreamRetries: 3, maxResponseBufferSize: 10 * 1024 * 1024, enabled: true },
					customHeaders: { "X-From-JSON": "true" },
					allowBaseUrlOverride: true,
					baseUrlOverrideHeader: "x-openai-baseurl",
				},
			};
			writeFileSync(providersFile, JSON.stringify(providersJson, null, 2));

			const result = migrateProviders({ providersFile });
			
			assert.equal(result.imported, 0);
			assert.equal(result.updated, 1);
			
			const dbProviders = getAllProvidersFromDb();
			const openai = dbProviders.get("openai")!;
			assert.equal(openai.upstreamUrl, "https://json.openai.com");
			assert.equal(openai.name, "OpenAI from JSON");
			assert.equal(openai.source, "file");
			assert.equal(openai.dynamic, true);
			assert.equal(openai.customHeaders["X-From-JSON"], "true");
		});

		it("skips existing file providers by default", () => {
			// First migrate openai from JSON to make it a file provider
			const providersFile = join(testDbDir, "providers.json");
			const initialJson = {
				openai: {
					id: "openai",
					name: "OpenAI from JSON",
					upstreamUrl: "https://json.openai.com",
					apiFormat: "chat-completions",
					authType: "bearer",
					enabled: true,
					rateLimit: { maxRequests: 60, windowMs: 60000, bufferCapacity: 10 },
					retry: { maxRetries: 3, baseDelayMs: 1000, maxDelayMs: 30000, retryableStatuses: [429, 500, 502, 503, 504], jitterFactor: 0.2, maxStreamRetries: 3, maxResponseBufferSize: 10 * 1024 * 1024, enabled: true },
					customHeaders: {},
					allowBaseUrlOverride: true,
					baseUrlOverrideHeader: "x-openai-baseurl",
				},
			};
			writeFileSync(providersFile, JSON.stringify(initialJson, null, 2));
			migrateProviders({ providersFile });

			// Now update the JSON file with different values
			const updatedJson = {
				openai: {
					id: "openai",
					name: "From JSON",
					upstreamUrl: "https://json.openai.com",
					apiFormat: "chat-completions",
					authType: "bearer",
					enabled: true,
					rateLimit: { maxRequests: 60, windowMs: 60000, bufferCapacity: 10 },
					retry: { maxRetries: 3, baseDelayMs: 1000, maxDelayMs: 30000, retryableStatuses: [429, 500, 502, 503, 504], jitterFactor: 0.2, maxStreamRetries: 3, maxResponseBufferSize: 10 * 1024 * 1024, enabled: true },
					customHeaders: {},
					allowBaseUrlOverride: true,
					baseUrlOverrideHeader: "x-openai-baseurl",
				},
			};
			writeFileSync(providersFile, JSON.stringify(updatedJson, null, 2));

			const result = migrateProviders({ providersFile });
			
			assert.equal(result.imported, 0);
			assert.equal(result.updated, 0);
			assert.equal(result.skipped, 1);
			
			const dbProviders = getAllProvidersFromDb();
			assert.equal(dbProviders.get("openai")!.name, "OpenAI from JSON");
			assert.equal(dbProviders.get("openai")!.upstreamUrl, "https://json.openai.com");
		});

		it("re-imports existing file providers when force option is true", () => {
			// First migrate openai from JSON to make it a file provider
			const providersFile = join(testDbDir, "providers.json");
			const initialJson = {
				openai: {
					id: "openai",
					name: "Original OpenAI",
					upstreamUrl: "https://original.openai.com",
					apiFormat: "chat-completions",
					authType: "bearer",
					enabled: true,
					rateLimit: { maxRequests: 60, windowMs: 60000, bufferCapacity: 10 },
					retry: { maxRetries: 3, baseDelayMs: 1000, maxDelayMs: 30000, retryableStatuses: [429, 500, 502, 503, 504], jitterFactor: 0.2, maxStreamRetries: 3, maxResponseBufferSize: 10 * 1024 * 1024, enabled: true },
					customHeaders: {},
					allowBaseUrlOverride: true,
					baseUrlOverrideHeader: "x-openai-baseurl",
				},
			};
			writeFileSync(providersFile, JSON.stringify(initialJson, null, 2));
			migrateProviders({ providersFile });

			// Now update with new values and force
			const updatedJson = {
				openai: {
					id: "openai",
					name: "From JSON Forced",
					upstreamUrl: "https://forced.openai.com",
					apiFormat: "chat-completions",
					authType: "bearer",
					enabled: true,
					rateLimit: { maxRequests: 60, windowMs: 60000, bufferCapacity: 10 },
					retry: { maxRetries: 3, baseDelayMs: 1000, maxDelayMs: 30000, retryableStatuses: [429, 500, 502, 503, 504], jitterFactor: 0.2, maxStreamRetries: 3, maxResponseBufferSize: 10 * 1024 * 1024, enabled: true },
					customHeaders: { "X-Forced": "true" },
					allowBaseUrlOverride: true,
					baseUrlOverrideHeader: "x-openai-baseurl",
				},
			};
			writeFileSync(providersFile, JSON.stringify(updatedJson, null, 2));

			const result = migrateProviders({ providersFile, force: true });
			
			assert.equal(result.imported, 0);
			assert.equal(result.updated, 1);
			assert.equal(result.skipped, 0);
			
			const dbProviders = getAllProvidersFromDb();
			assert.equal(dbProviders.get("openai")!.name, "From JSON Forced");
			assert.equal(dbProviders.get("openai")!.upstreamUrl, "https://forced.openai.com");
			assert.equal(dbProviders.get("openai")!.customHeaders["X-Forced"], "true");
		});

		it("validates required fields and fails gracefully", () => {
			const providersFile = join(testDbDir, "providers.json");
			const providersJson = {
				"anthropic": {
					id: "anthropic",
					name: "Invalid Provider",
					// Missing upstreamUrl
					apiFormat: "anthropic-messages",
					authType: "api-key",
				},
			};
			writeFileSync(providersFile, JSON.stringify(providersJson, null, 2));

			const result = migrateProviders({ providersFile });
			
			assert.equal(result.totalProviders, 1);
			assert.equal(result.failed, 1);
			assert.equal(result.imported, 0);
			assert.equal(result.errors.length, 1);
			assert.equal(result.errors[0].provider, "anthropic");
			assert.ok(result.errors[0].error.includes("missing upstreamUrl"));
		});

		it("preserves all field values including customHeaders, rateLimit, retry", () => {
			const providersFile = join(testDbDir, "providers.json");
			const providersJson = {
				"openai": {
					id: "openai",
					name: "Full Fields Provider",
					upstreamUrl: "https://full.provider/api",
					apiFormat: "anthropic-messages",
					authType: "api-key",
					enabled: false,
					rateLimit: { maxRequests: 100, windowMs: 120000, bufferCapacity: 20 },
					retry: { maxRetries: 5, baseDelayMs: 500, maxDelayMs: 60000, retryableStatuses: [429, 500], jitterFactor: 0.1, maxStreamRetries: 2, maxResponseBufferSize: 5 * 1024 * 1024, enabled: false },
					customHeaders: { "X-Custom": "value", "X-Another": "test" },
					allowBaseUrlOverride: false,
					baseUrlOverrideHeader: "x-full-baseurl",
				},
			};
			writeFileSync(providersFile, JSON.stringify(providersJson, null, 2));

			const result = migrateProviders({ providersFile });
			
			assert.equal(result.imported, 0);
			assert.equal(result.updated, 1);
			
			const dbProviders = getAllProvidersFromDb();
			const stored = dbProviders.get("openai")!;
			assert.equal(stored.apiFormat, "anthropic-messages");
			assert.equal(stored.authType, "api-key");
			assert.equal(stored.enabled, false);
			assert.equal(stored.rateLimit.maxRequests, 100);
			assert.equal(stored.rateLimit.windowMs, 120000);
			assert.equal(stored.rateLimit.bufferCapacity, 20);
			assert.equal(stored.retry.maxRetries, 5);
			assert.equal(stored.retry.baseDelayMs, 500);
			assert.equal(stored.retry.maxDelayMs, 60000);
			assert.deepEqual(stored.retry.retryableStatuses, [429, 500]);
			assert.equal(stored.retry.jitterFactor, 0.1);
			assert.equal(stored.retry.maxStreamRetries, 2);
			assert.equal(stored.retry.maxResponseBufferSize, 5 * 1024 * 1024);
			assert.equal(stored.retry.enabled, false);
			assert.deepEqual(stored.customHeaders, { "X-Custom": "value", "X-Another": "test" });
			assert.equal(stored.allowBaseUrlOverride, false);
			assert.equal(stored.baseUrlOverrideHeader, "x-full-baseurl");
		});

		it("creates backup file when createBackup is true (default)", () => {
			const providersFile = join(testDbDir, "providers.json");
			const providersJson = {
				"openai": {
					id: "openai",
					name: "Backup Test",
					upstreamUrl: "https://backup.test/api",
					apiFormat: "chat-completions",
					authType: "bearer",
				},
			};
			writeFileSync(providersFile, JSON.stringify(providersJson, null, 2));

			const result = migrateProviders({ providersFile, createBackup: true });
			
			assert.ok(result.backupPath);
			assert.ok(result.backupPath!.includes("providers.json.backup."));
			assert.ok(existsSync(result.backupPath!));
			
			// Verify backup content matches original
			const backupContent = readFileSync(result.backupPath!, "utf8");
			assert.equal(backupContent, JSON.stringify(providersJson, null, 2));
		});

		it("does not create backup when createBackup is false", () => {
			const providersFile = join(testDbDir, "providers.json");
			const providersJson = {
				"openai": {
					id: "openai",
					name: "No Backup Test",
					upstreamUrl: "https://nobackup.test/api",
					apiFormat: "chat-completions",
					authType: "bearer",
				},
			};
			writeFileSync(providersFile, JSON.stringify(providersJson, null, 2));

			const result = migrateProviders({ providersFile, createBackup: false });
			
			assert.equal(result.backupPath, undefined);
		});

		it("does not create backup in dryRun mode", () => {
			const providersFile = join(testDbDir, "providers.json");
			const providersJson = {
				"openai": {
					id: "openai",
					name: "DryRun Backup Test",
					upstreamUrl: "https://dryrun.test/api",
					apiFormat: "chat-completions",
					authType: "bearer",
				},
			};
			writeFileSync(providersFile, JSON.stringify(providersJson, null, 2));

			const result = migrateProviders({ providersFile, dryRun: true, createBackup: true });
			
			assert.equal(result.backupPath, undefined);
			assert.equal(result.imported, 0);
			assert.equal(result.updated, 1);
		});

		it("handles malformed JSON gracefully", () => {
			const providersFile = join(testDbDir, "providers.json");
			writeFileSync(providersFile, "{ invalid json }");

			const result = migrateProviders({ providersFile });
			
			assert.equal(result.totalProviders, 0);
			assert.equal(result.failed, 1);
			assert.equal(result.errors.length, 1);
			assert.equal(result.errors[0].provider, "all");
			assert.ok(result.errors[0].error.includes("Failed to parse"));
		});

		it("continues processing other providers when one fails", () => {
			const providersFile = join(testDbDir, "providers.json");
			const providersJson = {
				"openai": {
					id: "openai",
					name: "Valid Provider 1",
					upstreamUrl: "https://valid1.test/api",
					apiFormat: "chat-completions",
					authType: "bearer",
				},
				"anthropic": {
					id: "anthropic",
					name: "Invalid Provider",
					// Missing upstreamUrl
					apiFormat: "anthropic-messages",
					authType: "api-key",
				},
				"chatgpt": {
					id: "chatgpt",
					name: "Valid Provider 2",
					upstreamUrl: "https://valid2.test/api",
					apiFormat: "chat-completions",
					authType: "bearer",
				},
			};
			writeFileSync(providersFile, JSON.stringify(providersJson, null, 2));

			const result = migrateProviders({ providersFile });
			
			assert.equal(result.totalProviders, 3);
			assert.equal(result.imported, 0);
			assert.equal(result.updated, 2);
			assert.equal(result.failed, 1);
			assert.equal(result.errors.length, 1);
			assert.equal(result.errors[0].provider, "anthropic");
			
			const dbProviders = getAllProvidersFromDb();
			assert.ok(dbProviders.has("openai"));
			assert.ok(dbProviders.has("chatgpt"));
		});
	});

	describe("previewProvidersMigration", () => {
		it("returns preview without writing to database", () => {
			const providersFile = join(testDbDir, "providers.json");
			const providersJson = {
				"openai": {
					id: "openai",
					name: "Preview Provider 1",
					upstreamUrl: "https://preview1.test/api",
					apiFormat: "chat-completions",
					authType: "bearer",
				},
				"anthropic": {
					id: "anthropic",
					name: "Preview Provider 2",
					upstreamUrl: "https://preview2.test/api",
					apiFormat: "anthropic-messages",
					authType: "api-key",
				},
			};
			writeFileSync(providersFile, JSON.stringify(providersJson, null, 2));

			const result = previewProvidersMigration({ providersFile });
			
			assert.equal(result.totalProviders, 2);
			assert.equal(result.imported, 0);
			assert.equal(result.updated, 2);
			assert.equal(result.skipped, 0);
		assert.equal(result.failed, 0);
		
		// Database should be unchanged (default providers from migrations)
		const dbProviders = getAllProvidersFromDb();
		assert.equal(dbProviders.size, 9);
		});

		it("shows updated count for existing default providers", () => {
			// Default providers exist from initDb
			const providersFile = join(testDbDir, "providers.json");
			const providersJson = {
				openai: {
					id: "openai",
					name: "OpenAI from JSON",
					upstreamUrl: "https://json.openai.com",
					apiFormat: "chat-completions",
					authType: "bearer",
				},
			};
			writeFileSync(providersFile, JSON.stringify(providersJson, null, 2));

			const result = previewProvidersMigration({ providersFile });
			
			assert.equal(result.totalProviders, 1);
			assert.equal(result.imported, 0);
			assert.equal(result.updated, 1);
		});
	});

	describe("Field preservation", () => {
		it("preserves all field values when updating default providers", () => {
			const providersFile = join(testDbDir, "providers.json");
			const providersJson = {
				"openai": {
					id: "openai",
					name: "OpenAI Full Fields",
					upstreamUrl: "https://full.openai.com",
					apiFormat: "chat-completions",
					authType: "bearer",
					enabled: false,
					rateLimit: { maxRequests: 100, windowMs: 120000, bufferCapacity: 20 },
					retry: { maxRetries: 5, baseDelayMs: 500, maxDelayMs: 60000, retryableStatuses: [429, 500], jitterFactor: 0.1, maxStreamRetries: 2, maxResponseBufferSize: 5 * 1024 * 1024, enabled: false },
					customHeaders: { "X-Custom": "value", "X-Another": "test" },
					allowBaseUrlOverride: false,
					baseUrlOverrideHeader: "x-full-openai-baseurl",
				},
			};
			writeFileSync(providersFile, JSON.stringify(providersJson, null, 2));

			const result = migrateProviders({ providersFile });
			
			assert.equal(result.imported, 0);
			assert.equal(result.updated, 1);
			
			const provider = getProviderById("openai");
			assert.ok(provider !== null);
			assert.equal(provider!.name, "OpenAI Full Fields");
			assert.equal(provider!.upstreamUrl, "https://full.openai.com");
			assert.equal(provider!.apiFormat, "chat-completions");
			assert.equal(provider!.authType, "bearer");
			assert.equal(provider!.enabled, false);
			assert.equal(provider!.rateLimit.maxRequests, 100);
			assert.equal(provider!.rateLimit.windowMs, 120000);
			assert.equal(provider!.retry.maxRetries, 5);
			assert.deepEqual(provider!.retry.retryableStatuses, [429, 500]);
			assert.equal(provider!.retry.jitterFactor, 0.1);
			assert.deepEqual(provider!.customHeaders, { "X-Custom": "value", "X-Another": "test" });
			assert.equal(provider!.allowBaseUrlOverride, false);
			assert.equal(provider!.baseUrlOverrideHeader, "x-full-openai-baseurl");
		});

		it("handles missing optional fields with defaults", () => {
			const providersFile = join(testDbDir, "providers.json");
			const providersJson = {
				"openai": {
					id: "openai",
					name: "Minimal Provider",
					upstreamUrl: "https://minimal.test/api",
				},
			};
			writeFileSync(providersFile, JSON.stringify(providersJson, null, 2));

			const result = migrateProviders({ providersFile });
			
			assert.equal(result.imported, 0);
			assert.equal(result.updated, 1);
			
		const provider = getProviderById("openai");
		assert.ok(provider !== null);
		assert.equal(provider!.apiFormat, "unknown");
		assert.equal(provider!.authType, "none");
		assert.equal(provider!.enabled, true);
		assert.equal(provider!.rateLimit.maxRequests, 60);
		assert.equal(provider!.retry.maxRetries, 3);
		});
	});
});