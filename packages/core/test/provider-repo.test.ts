import { describe, it, before, after, beforeEach } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import Database from "better-sqlite3";

import {
	createProvider,
	getProviderById,
	getAllProvidersFromDb,
	updateProvider,
	deleteProvider,
	providerExists,
	getAllMergedProviders,
	importProvidersFromJson,
	closeDb,
	initDb,
	getDb,
} from "../dist/db/index.js";
import type { ProviderConfig } from "@contextio/core";

/**
 * Test database setup using a temporary file.
 * This ensures the production code uses our test database.
 */

let testDbDir: string;
let testDbPath: string;

// Setup test database
async function setupTestDb(): Promise<void> {
	// Create a temporary directory for our test database
	testDbDir = mkdtempSync(join(tmpdir(), "contextio-provider-test-"));
	testDbPath = join(testDbDir, "test.db");

	// Set environment variable so production code uses our test database
	process.env.CONTEXTIO_DB_PATH = testDbPath;

	// Close any existing connection
	closeDb();

	// Initialize the database (runs migrations)
	initDb();

	// Verify providers table exists
	const db = new Database(testDbPath);
	const tables = db.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name='providers'").get();
	if (!tables) {
		db.close();
		throw new Error("providers table not created - migrations not applied correctly!");
	}
	db.close();
}

function clearProvidersTable(): void {
	const db = new Database(testDbPath);
	db.prepare("DELETE FROM providers").run();
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
}

// Test-specific ProviderConfig with string id (allows any test ID)
interface TestProviderConfig extends Omit<ProviderConfig, "id"> {
	id: string;
}

function createProviderConfig(overrides: Partial<TestProviderConfig> = {}): TestProviderConfig {
	const base: TestProviderConfig = {
		id: `test-provider-${Date.now()}-${Math.random().toString(36).slice(2, 9)}`,
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

describe("provider-repo.ts", () => {
	before(async () => {
		await setupTestDb();
	});

	after(async () => {
		await teardownTestDb();
	});

	beforeEach(() => {
		clearProvidersTable();
	});

	describe("createProvider", () => {
		it("creates a new provider in the database", () => {
			const config = createProviderConfig({ id: "create-test-1" });
			const result = createProvider(config);

			assert.equal(result.id, config.id);
			assert.equal(result.name, config.name);
			assert.equal(result.upstreamUrl, config.upstreamUrl);

			// Verify it's in the database
			const dbProviders = getAllProvidersFromDb();
			assert.ok(dbProviders.has(config.id));
			const stored = dbProviders.get(config.id)!;
			assert.equal(stored.id, config.id);
			assert.equal(stored.name, config.name);
			assert.equal(stored.source, "file");
			assert.equal(stored.dynamic, true);
		});

		it("throws error when provider with same ID already exists", () => {
			const config = createProviderConfig({ id: "duplicate-test-1" });
			createProvider(config);

			assert.throws(
				() => createProvider(config),
				/Provider with id "duplicate-test-1" already exists/
			);
		});

		it("stores all provider fields correctly including rateLimit, retry, customHeaders", () => {
			const config = createProviderConfig({
				id: "full-fields-test",
				name: "Full Fields Provider",
				upstreamUrl: "https://full.provider/api",
				apiFormat: "anthropic-messages",
				authType: "api-key",
				enabled: false,
				rateLimit: { maxRequests: 100, windowMs: 120000, bufferCapacity: 20 },
				retry: { maxRetries: 5, baseDelayMs: 500, maxDelayMs: 60000, retryableStatuses: [429, 500], jitterFactor: 0.1 },
				customHeaders: { "X-Custom": "value" },
				allowBaseUrlOverride: false,
				baseUrlOverrideHeader: "x-custom-baseurl",
			});
			createProvider(config);

			const dbProviders = getAllProvidersFromDb();
			const stored = dbProviders.get(config.id)!;

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
			assert.deepEqual(stored.customHeaders, { "X-Custom": "value" });
			assert.equal(stored.allowBaseUrlOverride, false);
			assert.equal(stored.baseUrlOverrideHeader, "x-custom-baseurl");
		});
	});

	describe("getProviderById", () => {
		it("returns provider when found", () => {
			const config = createProviderConfig({ id: "get-by-id-1" });
			createProvider(config);

			const result = getProviderById("get-by-id-1");
			assert.ok(result !== null);
			assert.equal(result!.id, "get-by-id-1");
			assert.equal(result!.name, config.name);
			assert.equal(result!.source, "file");
			assert.equal(result!.dynamic, true);
		});

		it("returns null when not found", () => {
			const result = getProviderById("non-existent-id");
			assert.equal(result, null);
		});
	});

	describe("getAllProvidersFromDb", () => {
		it("returns empty map when database is empty", () => {
			const result = getAllProvidersFromDb();
			assert.equal(result.size, 0);
		});

		it("returns all providers as a map keyed by ID", () => {
			const config1 = createProviderConfig({ id: "all-1", name: "Provider 1" });
			const config2 = createProviderConfig({ id: "all-2", name: "Provider 2" });
			createProvider(config1);
			createProvider(config2);

			const result = getAllProvidersFromDb();
			assert.equal(result.size, 2);
			assert.ok(result.has("all-1"));
			assert.ok(result.has("all-2"));
			assert.equal(result.get("all-1")!.name, "Provider 1");
			assert.equal(result.get("all-2")!.name, "Provider 2");
		});
	});

	describe("updateProvider", () => {
		it("updates an existing provider", () => {
			const config = createProviderConfig({ id: "update-test-1", name: "Original Name" });
			createProvider(config);

			const updatedConfig = createProviderConfig({
				id: "update-test-1",
				name: "Updated Name",
				upstreamUrl: "https://updated.provider/api",
			});
			const result = updateProvider("update-test-1", updatedConfig);

			assert.equal(result.name, "Updated Name");
			assert.equal(result.upstreamUrl, "https://updated.provider/api");

			const dbProviders = getAllProvidersFromDb();
			const stored = dbProviders.get("update-test-1")!;
			assert.equal(stored.name, "Updated Name");
			assert.equal(stored.upstreamUrl, "https://updated.provider/api");
		});

		it("preserves source and dynamic fields from original provider", () => {
			// Create a default provider directly in DB
			const db = getDb();
			db.prepare(`
				INSERT INTO providers (
					id, name, upstream_url, api_format, auth_type, enabled,
					rate_limit_max_requests, rate_limit_window_ms, rate_limit_buffer_capacity,
					retry_max_retries, retry_base_delay_ms, retry_max_delay_ms,
					retry_retryable_statuses, retry_jitter_factor, custom_headers,
					allow_base_url_override, base_url_override_header, source, dynamic
				) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
			`).run(
				"preserve-test", "Preserve Test", "https://preserve.test/api", "unknown", "none", 1,
				60, 60000, 10,
				3, 1000, 30000,
				'[429, 500, 502, 503, 504]', 0.2, '{}',
				1, 'x-preserve-baseurl', "default", 0
			);

			const updatedConfig = createProviderConfig({
				id: "preserve-test",
				name: "Updated Preserve Test",
				upstreamUrl: "https://updated.preserve.test/api",
			});
			updateProvider("preserve-test", updatedConfig);

			const dbProviders = getAllProvidersFromDb();
			const stored = dbProviders.get("preserve-test")!;
			assert.equal(stored.source, "default");
			assert.equal(stored.dynamic, false);
			assert.equal(stored.name, "Updated Preserve Test");
		});

		it("throws error when provider ID in config doesn't match URL parameter", () => {
			const config = createProviderConfig({ id: "mismatch-test-1" });
			createProvider(config);

			const updatedConfig = createProviderConfig({ id: "different-id" });
			assert.throws(
				() => updateProvider("mismatch-test-1", updatedConfig),
				/Provider id mismatch: URL has "mismatch-test-1", body has "different-id"/
			);
		});

		it("throws error when provider not found", () => {
			const config = createProviderConfig({ id: "not-found-test" });
			assert.throws(
				() => updateProvider("not-found-test", config),
				/Provider with id "not-found-test" not found/
			);
		});
	});

	describe("deleteProvider", () => {
		it("deletes an existing provider", () => {
			const config = createProviderConfig({ id: "delete-test-1" });
			createProvider(config);

			assert.ok(providerExists("delete-test-1"));

			deleteProvider("delete-test-1");

			assert.equal(providerExists("delete-test-1"), false);
			assert.equal(getProviderById("delete-test-1"), null);
		});

		it("throws error when provider not found", () => {
			assert.throws(
				() => deleteProvider("non-existent-id"),
				/Provider with id "non-existent-id" not found/
			);
		});
	});

	describe("providerExists", () => {
		it("returns true for existing provider", () => {
			const config = createProviderConfig({ id: "exists-test-1" });
			createProvider(config);

			assert.equal(providerExists("exists-test-1"), true);
		});

		it("returns false for non-existing provider", () => {
			assert.equal(providerExists("non-existent-id"), false);
		});
	});

	describe("getAllMergedProviders", () => {
		it("returns default providers when database is empty", () => {
			const result = getAllMergedProviders();

			// Should have all default providers
			assert.ok(result.length >= 10);
			const ids = result.map(p => p.id);
			assert.ok(ids.includes("openai"));
			assert.ok(ids.includes("anthropic"));
			assert.ok(ids.includes("chatgpt"));
			assert.ok(ids.includes("gemini"));
			assert.ok(ids.includes("vertex"));
			assert.ok(ids.includes("nvidia"));
			assert.ok(ids.includes("openrouter"));
			assert.ok(ids.includes("kilo"));
			assert.ok(ids.includes("geminiCodeAssist"));
			assert.ok(ids.includes("unknown"));

			// All should have source="default" and dynamic=false
			for (const p of result) {
				assert.equal(p.source, "default");
				assert.equal(p.dynamic, false);
			}
		});

		it("environment variable providers override defaults", () => {
			process.env.UPSTREAM_OPENAI_URL = "https://env.openai.com";
			process.env.UPSTREAM_ANTHROPIC_URL = "https://env.anthropic.com";

			try {
				const result = getAllMergedProviders();
				const openai = result.find(p => p.id === "openai")!;
				const anthropic = result.find(p => p.id === "anthropic")!;

				assert.equal(openai.upstreamUrl, "https://env.openai.com");
				assert.equal(openai.source, "env");
				assert.equal(openai.dynamic, false);
				assert.equal(anthropic.upstreamUrl, "https://env.anthropic.com");
				assert.equal(anthropic.source, "env");
			} finally {
				delete process.env.UPSTREAM_OPENAI_URL;
				delete process.env.UPSTREAM_ANTHROPIC_URL;
			}
		});

		it("file/database providers override environment variable providers", () => {
			process.env.UPSTREAM_OPENAI_URL = "https://env.openai.com";

			try {
				const config = createProviderConfig({
					id: "openai",
					name: "Custom OpenAI",
					upstreamUrl: "https://file.openai.com",
				});
				createProvider(config);

				const result = getAllMergedProviders();
				const openai = result.find(p => p.id === "openai")!;

				assert.equal(openai.upstreamUrl, "https://file.openai.com");
				assert.equal(openai.source, "file");
				assert.equal(openai.dynamic, true);
				assert.equal(openai.name, "Custom OpenAI");
			} finally {
				delete process.env.UPSTREAM_OPENAI_URL;
			}
		});

		it("default providers from database do NOT override env vars", () => {
			process.env.UPSTREAM_OPENAI_URL = "https://env.openai.com";

			try {
				// Create a default provider directly in DB (source="default", dynamic=0)
				const db = getDb();
				db.prepare(`
					INSERT INTO providers (
						id, name, upstream_url, api_format, auth_type, enabled,
						rate_limit_max_requests, rate_limit_window_ms, rate_limit_buffer_capacity,
						retry_max_retries, retry_base_delay_ms, retry_max_delay_ms,
						retry_retryable_statuses, retry_jitter_factor, custom_headers,
						allow_base_url_override, base_url_override_header, source, dynamic
					) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
				`).run(
					"openai", "DB Default OpenAI", "https://db.openai.com", "unknown", "none", 1,
					60, 60000, 10,
					3, 1000, 30000,
					'[429, 500, 502, 503, 504]', 0.2, '{}',
					1, 'x-db-openai-baseurl', "default", 0
				);

				const result = getAllMergedProviders();
				const openai = result.find(p => p.id === "openai")!;

				// Env should still win over DB default
				assert.equal(openai.upstreamUrl, "https://env.openai.com");
				assert.equal(openai.source, "env");
} finally {
			delete process.env.UPSTREAM_OPENAI_URL;
		}
	});
});

describe("importProvidersFromJson", () => {
		it("returns 0 when providers.json does not exist", () => {
			const count = importProvidersFromJson("/non/existent/path/providers.json");
			assert.equal(count, 0);
		});

		it("imports providers from JSON file", () => {
			const jsonPath = join(testDbDir, "providers.json");
			const providersJson = {
				"imported-1": {
					id: "imported-1",
					name: "Imported Provider 1",
					upstreamUrl: "https://imported1.provider/api",
					apiFormat: "chat-completions",
					authType: "bearer",
					enabled: true,
					rateLimit: { maxRequests: 60, windowMs: 60000, bufferCapacity: 10 },
					retry: { maxRetries: 3, baseDelayMs: 1000, maxDelayMs: 30000, retryableStatuses: [429, 500, 502, 503, 504], jitterFactor: 0.2, maxStreamRetries: 3, maxResponseBufferSize: 10 * 1024 * 1024, enabled: true },
					customHeaders: {},
					allowBaseUrlOverride: true,
					baseUrlOverrideHeader: "x-imported1-baseurl",
				},
				"imported-2": {
					id: "imported-2",
					name: "Imported Provider 2",
					upstreamUrl: "https://imported2.provider/api",
					apiFormat: "anthropic-messages",
					authType: "api-key",
					enabled: true,
					rateLimit: { maxRequests: 60, windowMs: 60000, bufferCapacity: 10 },
					retry: { maxRetries: 3, baseDelayMs: 1000, maxDelayMs: 30000, retryableStatuses: [429, 500, 502, 503, 504], jitterFactor: 0.2, maxStreamRetries: 3, maxResponseBufferSize: 10 * 1024 * 1024, enabled: true },
					customHeaders: { "X-Imported": "true" },
					allowBaseUrlOverride: true,
					baseUrlOverrideHeader: "x-imported2-baseurl",
				},
			};
			writeFileSync(jsonPath, JSON.stringify(providersJson, null, 2));

			const count = importProvidersFromJson(jsonPath);
			assert.equal(count, 2);

			const dbProviders = getAllProvidersFromDb();
			assert.ok(dbProviders.has("imported-1"));
			assert.ok(dbProviders.has("imported-2"));
			assert.equal(dbProviders.get("imported-1")!.source, "file");
			assert.equal(dbProviders.get("imported-1")!.dynamic, true);
			assert.equal(dbProviders.get("imported-2")!.source, "file");
			assert.equal(dbProviders.get("imported-2")!.dynamic, true);
			assert.equal(dbProviders.get("imported-2")!.customHeaders["X-Imported"], "true");
		});

		it("updates existing default providers with file source", () => {
			// Default providers are created by migrations during initDb()
			const initialCount = getAllProvidersFromDb().size;

			const jsonPath = join(testDbDir, "providers.json");
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
			writeFileSync(jsonPath, JSON.stringify(providersJson, null, 2));

			const count = importProvidersFromJson(jsonPath);
			assert.equal(count, 1);

			const dbProviders = getAllProvidersFromDb();
			const openai = dbProviders.get("openai")!;
			assert.equal(openai.upstreamUrl, "https://json.openai.com");
			assert.equal(openai.name, "OpenAI from JSON");
			assert.equal(openai.source, "file");
			assert.equal(openai.dynamic, true);
			assert.equal(openai.customHeaders["X-From-JSON"], "true");
		});

		it("skips existing file providers", () => {
			// Create a file provider first
			const config = createProviderConfig({ id: "skip-test", name: "Original" });
			createProvider(config);

			const jsonPath = join(testDbDir, "providers.json");
			const providersJson = {
				"skip-test": {
					id: "skip-test",
					name: "From JSON",
					upstreamUrl: "https://json.skip.test/api",
					apiFormat: "chat-completions",
					authType: "bearer",
					enabled: true,
					rateLimit: { maxRequests: 60, windowMs: 60000, bufferCapacity: 10 },
					retry: { maxRetries: 3, baseDelayMs: 1000, maxDelayMs: 30000, retryableStatuses: [429, 500, 502, 503, 504], jitterFactor: 0.2, maxStreamRetries: 3, maxResponseBufferSize: 10 * 1024 * 1024, enabled: true },
					customHeaders: {},
					allowBaseUrlOverride: true,
					baseUrlOverrideHeader: "x-skip-baseurl",
				},
			};
			writeFileSync(jsonPath, JSON.stringify(providersJson, null, 2));

			const count = importProvidersFromJson(jsonPath);
			assert.equal(count, 0);

			const dbProviders = getAllProvidersFromDb();
			assert.equal(dbProviders.get("skip-test")!.name, "Original");
			assert.equal(dbProviders.get("skip-test")!.upstreamUrl, config.upstreamUrl);
		});

		it("handles array format providers.json", () => {
			const jsonPath = join(testDbDir, "providers-array.json");
			const providersArray = [
				{
					id: "array-1",
					name: "Array Provider 1",
					upstreamUrl: "https://array1.provider/api",
					apiFormat: "chat-completions",
					authType: "bearer",
					enabled: true,
					rateLimit: { maxRequests: 60, windowMs: 60000, bufferCapacity: 10 },
					retry: { maxRetries: 3, baseDelayMs: 1000, maxDelayMs: 30000, retryableStatuses: [429, 500, 502, 503, 504], jitterFactor: 0.2, maxStreamRetries: 3, maxResponseBufferSize: 10 * 1024 * 1024, enabled: true },
					customHeaders: {},
					allowBaseUrlOverride: true,
					baseUrlOverrideHeader: "x-array1-baseurl",
				},
				{
					id: "array-2",
					name: "Array Provider 2",
					upstreamUrl: "https://array2.provider/api",
					apiFormat: "anthropic-messages",
					authType: "api-key",
					enabled: true,
					rateLimit: { maxRequests: 60, windowMs: 60000, bufferCapacity: 10 },
					retry: { maxRetries: 3, baseDelayMs: 1000, maxDelayMs: 30000, retryableStatuses: [429, 500, 502, 503, 504], jitterFactor: 0.2, maxStreamRetries: 3, maxResponseBufferSize: 10 * 1024 * 1024, enabled: true },
					customHeaders: {},
					allowBaseUrlOverride: true,
					baseUrlOverrideHeader: "x-array2-baseurl",
				},
			];
			writeFileSync(jsonPath, JSON.stringify(providersArray, null, 2));

			const count = importProvidersFromJson(jsonPath);
			assert.equal(count, 2);

			const dbProviders = getAllProvidersFromDb();
			assert.ok(dbProviders.has("array-1"));
			assert.ok(dbProviders.has("array-2"));
			assert.equal(dbProviders.get("array-1")!.source, "file");
			assert.equal(dbProviders.get("array-2")!.source, "file");
		});
	});
});

