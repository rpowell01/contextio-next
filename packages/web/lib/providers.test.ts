import { describe, it, before, after, beforeEach } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import Database from "better-sqlite3";

import { migrateProvidersArray } from "./providers.js";
import {
	getAllProviders,
	getProviderById,
	createProvider,
	updateProvider,
	deleteProvider,
	isDatabaseAvailable,
	type ProviderConfigInput,
} from "./providers.js";

import { closeDb, initDb } from "@contextio/core/db";

/**
 * Test database setup using a temporary file.
 * This ensures the production code uses our test database.
 */

let testDbDir: string;
let testDbPath: string;

// Setup test database
async function setupTestDb(): Promise<void> {
	// Create a temporary directory for our test database
	testDbDir = mkdtempSync(join(tmpdir(), "contextio-web-provider-test-"));
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

// Cleanup
async function teardownTestDb(): Promise<void> {
	closeDb();
	if (testDbDir) {
		rmSync(testDbDir, { recursive: true, force: true });
	}
	delete process.env.CONTEXTIO_DB_PATH;
}

function createProviderInput(overrides: Partial<ProviderConfigInput> = {}): ProviderConfigInput {
	const base: ProviderConfigInput = {
		id: `test-provider-${Date.now()}-${Math.random().toString(36).slice(2, 9)}`,
		name: "Test Provider",
		baseUrl: "https://test.provider/api",
		models: [],
		allowBaseUrlOverride: true,
		baseUrlOverrideHeader: "x-test-baseurl",
		apiFormat: "chat-completions",
		authType: "bearer",
		enabled: true,
		rateLimit: { maxRequests: 60, windowMs: 60000, bufferCapacity: 10 },
		retry: { maxRetries: 3, baseDelayMs: 1000, maxDelayMs: 30000, retryableStatuses: [429, 500, 502, 503, 504], jitterFactor: 0.2 },
		customHeaders: {},
	};
	return { ...base, ...overrides };
}

describe("migrateProvidersArray", () => {
	it("returns empty object for empty array", () => {
		const result = migrateProvidersArray([]);
		assert.deepEqual(result, {});
	});

	it("migrates a single valid provider entry", () => {
		const input = [
			{
				id: "openai",
				name: "OpenAI",
				baseUrl: "https://api.openai.com",
				models: ["gpt-4"],
				allowBaseUrlOverride: true,
				baseUrlOverrideHeader: "x-openai-baseurl",
				apiFormat: "chat-completions",
				authType: "bearer",
				enabled: true,
				rateLimit: { maxRequests: 60, windowMs: 60000, bufferCapacity: 10 },
				retry: { maxRetries: 3, baseDelayMs: 1000, maxDelayMs: 30000, retryableStatuses: [429, 500], jitterFactor: 0.2 },
				customHeaders: {},
			},
		];
		const result = migrateProvidersArray(input);
		assert.equal(Object.keys(result).length, 1);
		assert.ok(result["openai"], "should be keyed by provider id");
		// Field mapping: baseUrl -> upstreamUrl
		assert.equal(result["openai"].upstreamUrl, "https://api.openai.com");
		assert.equal(result["openai"].name, "OpenAI");
		assert.equal(result["openai"].apiFormat, "chat-completions");
		assert.equal(result["openai"].authType, "bearer");
		assert.equal(result["openai"].enabled, true);
		assert.equal(result["openai"].rateLimit.maxRequests, 60);
		assert.equal(result["openai"].retry.maxRetries, 3);
		assert.deepEqual(result["openai"].customHeaders, {});
		assert.equal(result["openai"].allowBaseUrlOverride, true);
		assert.equal(result["openai"].baseUrlOverrideHeader, "x-openai-baseurl");
	});

	it("migrates multiple valid provider entries", () => {
		const input = [
			{
				id: "openai",
				name: "OpenAI",
				baseUrl: "https://api.openai.com",
				models: [],
				allowBaseUrlOverride: true,
				baseUrlOverrideHeader: "x-openai-baseurl",
				apiFormat: "chat-completions",
				authType: "bearer",
				enabled: true,
				rateLimit: { maxRequests: 60, windowMs: 60000, bufferCapacity: 10 },
				retry: { maxRetries: 3, baseDelayMs: 1000, maxDelayMs: 30000, retryableStatuses: [429, 500], jitterFactor: 0.2 },
				customHeaders: {},
			},
			{
				id: "anthropic",
				name: "Anthropic",
				baseUrl: "https://api.anthropic.com",
				models: [],
				allowBaseUrlOverride: true,
				baseUrlOverrideHeader: "x-anthropic-baseurl",
				apiFormat: "anthropic-messages",
				authType: "bearer",
				enabled: true,
				rateLimit: { maxRequests: 60, windowMs: 60000, bufferCapacity: 10 },
				retry: { maxRetries: 3, baseDelayMs: 1000, maxDelayMs: 30000, retryableStatuses: [429, 500], jitterFactor: 0.2 },
				customHeaders: {},
			},
		];
		const result = migrateProvidersArray(input);
		assert.equal(Object.keys(result).length, 2);
		assert.ok(result["openai"], "should contain openai");
		assert.ok(result["anthropic"], "should contain anthropic");
		assert.equal(result["openai"].upstreamUrl, "https://api.openai.com");
		assert.equal(result["anthropic"].upstreamUrl, "https://api.anthropic.com");
	});

	it("skips invalid entries with missing id", () => {
		const input = [
			{
				id: "openai",
				name: "OpenAI",
				baseUrl: "https://api.openai.com",
				models: [],
				allowBaseUrlOverride: true,
				baseUrlOverrideHeader: "x-openai-baseurl",
				apiFormat: "chat-completions",
				authType: "bearer",
				enabled: true,
				rateLimit: { maxRequests: 60, windowMs: 60000, bufferCapacity: 10 },
				retry: { maxRetries: 3, baseDelayMs: 1000, maxDelayMs: 30000, retryableStatuses: [429, 500], jitterFactor: 0.2 },
				customHeaders: {},
			},
			{
				// Missing id
				name: "Invalid Provider",
				baseUrl: "https://example.com",
				models: [],
				allowBaseUrlOverride: true,
				baseUrlOverrideHeader: "x-invalid-baseurl",
				apiFormat: "chat-completions",
				authType: "bearer",
				enabled: true,
				rateLimit: { maxRequests: 60, windowMs: 60000, bufferCapacity: 10 },
				retry: { maxRetries: 3, baseDelayMs: 1000, maxDelayMs: 30000, retryableStatuses: [429, 500], jitterFactor: 0.2 },
				customHeaders: {},
			},
		];
		const result = migrateProvidersArray(input);
		assert.equal(Object.keys(result).length, 1);
		assert.ok(result["openai"], "should only contain the valid entry");
	});

	it("skips entries with invalid apiFormat", () => {
		const input = [
			{
				id: "openai",
				name: "OpenAI",
				baseUrl: "https://api.openai.com",
				models: [],
				allowBaseUrlOverride: true,
				baseUrlOverrideHeader: "x-openai-baseurl",
				apiFormat: "invalid-format",
				authType: "bearer",
				enabled: true,
				rateLimit: { maxRequests: 60, windowMs: 60000, bufferCapacity: 10 },
				retry: { maxRetries: 3, baseDelayMs: 1000, maxDelayMs: 30000, retryableStatuses: [429, 500], jitterFactor: 0.2 },
				customHeaders: {},
			},
		];
		const result = migrateProvidersArray(input);
		assert.equal(Object.keys(result).length, 0);
	});

	it("is idempotent: produces same output for same input", () => {
		const input = [
			{
				id: "openai",
				name: "OpenAI",
				baseUrl: "https://api.openai.com",
				models: ["gpt-4"],
				allowBaseUrlOverride: true,
				baseUrlOverrideHeader: "x-openai-baseurl",
				apiFormat: "chat-completions",
				authType: "bearer",
				enabled: true,
				rateLimit: { maxRequests: 60, windowMs: 60000, bufferCapacity: 10 },
				retry: { maxRetries: 3, baseDelayMs: 1000, maxDelayMs: 30000, retryableStatuses: [429, 500], jitterFactor: 0.2 },
				customHeaders: { "X-Custom": "value" },
			},
		];
		const result1 = migrateProvidersArray(input);
		const result2 = migrateProvidersArray(input);
		assert.deepEqual(result1, result2);
	});

	it("handles entries with default values for optional fields", () => {
		const input = [
			{
				id: "openai",
				name: "OpenAI",
				baseUrl: "https://api.openai.com",
				models: [],
				allowBaseUrlOverride: true,
				baseUrlOverrideHeader: "x-openai-baseurl",
				apiFormat: "chat-completions",
				authType: "api-key",
				enabled: false,
				rateLimit: { maxRequests: 20, windowMs: 60000, bufferCapacity: 5 },
				retry: { maxRetries: 1, baseDelayMs: 500, maxDelayMs: 5000, retryableStatuses: [502], jitterFactor: 0.5 },
				customHeaders: { Authorization: "Bearer test" },
			},
		];
		const result = migrateProvidersArray(input);
		assert.equal(Object.keys(result).length, 1);
		assert.equal(result["openai"].enabled, false);
		assert.equal(result["openai"].authType, "api-key");
		assert.equal(result["openai"].customHeaders["Authorization"], "Bearer test");
		assert.equal(result["openai"].baseUrlOverrideHeader, "x-openai-baseurl");
	});
});

describe("Database-backed provider functions", () => {
	before(async () => {
		await setupTestDb();
	});

	after(async () => {
		await teardownTestDb();
	});

	beforeEach(() => {
		clearProvidersTable();
	});

	describe("isDatabaseAvailable", () => {
		it("returns true when database is initialized and providers table exists", () => {
			assert.equal(isDatabaseAvailable(), true);
		});
	});

	describe("getAllProviders", () => {
		it("returns merged providers including defaults", async () => {
			const result = await getAllProviders();

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

			// All should have required metadata fields
			for (const p of result) {
				assert.ok(p.id);
				assert.ok(p.name);
				assert.ok(p.baseUrl);
				assert.ok(Array.isArray(p.models));
				assert.ok(typeof p.allowBaseUrlOverride === "boolean");
				assert.ok(p.baseUrlOverrideHeader);
				assert.ok(["default", "env", "file"].includes(p.source));
				assert.ok(typeof p.dynamic === "boolean");
			}
		});

		it("includes file-based providers created via createProvider", async () => {
			await createProvider(createProviderInput({
				id: "custom-provider-1",
				name: "Custom Provider",
				baseUrl: "https://custom.provider/api",
			}));

			const result = await getAllProviders();
			const custom = result.find(p => p.id === "custom-provider-1");
			assert.ok(custom, "custom provider should be in merged list");
			assert.equal(custom!.name, "Custom Provider");
			assert.equal(custom!.baseUrl, "https://custom.provider/api");
			assert.equal(custom!.source, "file");
			assert.equal(custom!.dynamic, true);
		});
	});

	describe("getProviderById", () => {
		it("returns provider metadata when found", async () => {
			await createProvider(createProviderInput({
				id: "get-by-id-test",
				name: "Get By ID Test",
				baseUrl: "https://getbyid.test/api",
			}));

			const result = await getProviderById("get-by-id-test");
			assert.ok(result !== null);
			assert.equal(result!.id, "get-by-id-test");
			assert.equal(result!.name, "Get By ID Test");
			assert.equal(result!.baseUrl, "https://getbyid.test/api");
			assert.equal(result!.source, "file");
			assert.equal(result!.dynamic, true);
		});

		it("returns null when not found", async () => {
			const result = await getProviderById("non-existent-id");
			assert.equal(result, null);
		});

		it("returns default provider when no file provider exists", async () => {
			const result = await getProviderById("openai");
			assert.ok(result !== null);
			assert.equal(result!.id, "openai");
			assert.equal(result!.source, "default");
			assert.equal(result!.dynamic, false);
		});
	});

	describe("createProvider", () => {
		it("creates a new provider and returns metadata", async () => {
			const input = createProviderInput({
				id: "create-test-1",
				name: "Create Test Provider",
				baseUrl: "https://create.test/api",
				models: ["model-a", "model-b"],
			});

			const result = await createProvider(input);
			assert.equal(result.id, "create-test-1");
			assert.equal(result.name, "Create Test Provider");
			assert.equal(result.baseUrl, "https://create.test/api");
			assert.equal(result.models.length, 2);
			assert.equal(result.source, "file");
			assert.equal(result.dynamic, true);
		});

		it("throws error when provider with same ID already exists", async () => {
			const input = createProviderInput({ id: "duplicate-create" });
			await createProvider(input);

			await assert.rejects(
				async () => await createProvider(input),
				/Provider with id "duplicate-create" already exists/
			);
		});

		it("validates required fields", async () => {
			await assert.rejects(
				async () => await createProvider({
					// Missing required fields
					name: "Invalid",
					baseUrl: "https://invalid.test/api",
				} as any),
				/Required/
			);
		});
	});

	describe("updateProvider", () => {
		it("updates an existing provider", async () => {
			await createProvider(createProviderInput({
				id: "update-test-1",
				name: "Original Name",
				baseUrl: "https://original.test/api",
			}));

			const result = await updateProvider("update-test-1", createProviderInput({
				id: "update-test-1",
				name: "Updated Name",
				baseUrl: "https://updated.test/api",
				models: ["updated-model"],
			}));

			assert.equal(result.id, "update-test-1");
			assert.equal(result.name, "Updated Name");
			assert.equal(result.baseUrl, "https://updated.test/api");
			assert.deepEqual(result.models, ["updated-model"]);
			assert.equal(result.source, "file");
			assert.equal(result.dynamic, true);
		});

		it("throws error when provider ID in body doesn't match URL parameter", async () => {
			await createProvider(createProviderInput({ id: "mismatch-test" }));

			await assert.rejects(
				async () => await updateProvider("mismatch-test", createProviderInput({ id: "different-id" })),
				/Provider id in URL \(mismatch-test\) does not match id in body \(different-id\)/
			);
		});

		it("throws error when provider not found", async () => {
			await assert.rejects(
				async () => await updateProvider("not-found", createProviderInput({ id: "not-found" })),
				/Provider with id "not-found" not found/
			);
		});
	});

	describe("deleteProvider", () => {
		it("deletes a user-created (file) provider", async () => {
			await createProvider(createProviderInput({ id: "delete-test-1" }));

			// Verify it exists
			const beforeDelete = await getProviderById("delete-test-1");
			assert.ok(beforeDelete !== null);
			assert.equal(beforeDelete!.source, "file");

			await deleteProvider("delete-test-1");

			const afterDelete = await getProviderById("delete-test-1");
			// Custom ID not in defaults should return null after deletion
			assert.equal(afterDelete, null);
		});

		it("throws error when trying to delete default provider", async () => {
			await assert.rejects(
				async () => await deleteProvider("openai"),
				/Cannot delete provider "openai": only user-created providers can be deleted/
			);
		});

		it("throws error when trying to delete non-existent custom provider", async () => {
			await assert.rejects(
				async () => await deleteProvider("non-existent-custom"),
				/Provider with id "non-existent-custom" not found/
			);
		});
	});
});