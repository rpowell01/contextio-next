import { describe, it, before, after, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { mkdir, readdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import Database from "better-sqlite3";

import { createRedactPlugin, type RedactPluginConfig, type RedactionMetadata } from "../dist/index.js";

import { closeDb, initDb } from "@contextio/core/db";

let testDbDir: string;
let testDbPath: string;

function getTestDbPath(): string {
	return testDbPath;
}

async function setupTestDb(): Promise<void> {
	testDbDir = mkdtempSync(join(tmpdir(), "contextio-redact-sqlite-test-"));
	testDbPath = join(testDbDir, "test.db");

	process.env.CONTEXTIO_DB_PATH = testDbPath;
	closeDb();
	initDb();

	const db = new Database(testDbPath);
	const schema = db.prepare("PRAGMA table_info(redaction_metadata)").all() as Array<{ name: string }>;
	const matchesCol = schema.find(c => c.name === 'matches');
	if (!matchesCol) {
		db.close();
		throw new Error("redaction_metadata table missing 'matches' column");
	}
	db.close();
}

async function teardownTestDb(): Promise<void> {
	closeDb();
	if (testDbDir) {
		rmSync(testDbDir, { recursive: true, force: true });
	}
	delete process.env.CONTEXTIO_DB_PATH;
}

describe("redact plugin - SQLite integration", () => {
	let sqliteCalls: RedactionMetadata[] = [];

	before(async () => {
		await setupTestDb();
	});

	after(async () => {
		await teardownTestDb();
	});

	beforeEach(() => {
		sqliteCalls = [];
	});

	it("creates plugin with onRedactionMetadata callback", () => {
		const config: RedactPluginConfig = {
			preset: "pii",
			reversible: false,
			detectorMode: "rules",
			onRedactionMetadata: (metadata: RedactionMetadata) => {
				sqliteCalls.push(metadata);
			},
		};

		const plugin = createRedactPlugin(config);
		assert.ok(plugin);
		assert.equal(typeof plugin.onRequest, "function");
		// onResponse is only defined when reversible: true
		assert.equal(plugin.onResponse, undefined);
	});

	it("calls onRedactionMetadata callback with complete metadata", async () => {
		const config: RedactPluginConfig = {
			preset: "secrets",
			reversible: false,
			detectorMode: "rules",
			onRedactionMetadata: (metadata: RedactionMetadata) => {
				sqliteCalls.push(metadata);
			},
		};

		const plugin = createRedactPlugin(config);

		// Process request with API key - use a format that matches the api-key-prefixed pattern
		const requestBody = {
			model: "gpt-4",
			messages: [
				{ role: "user", content: "My API key is sk-abcdefghijklmnopqrst" }
			]
		};

		if (plugin.onRequest) {
			await plugin.onRequest({
				provider: "openai",
				apiFormat: "chat-completions",
				path: "/v1/chat/completions",
				source: "test-proxy",
				sessionId: "test-session-1",
				headers: { "content-type": "application/json" },
				body: requestBody,
				rawBody: Buffer.from(JSON.stringify(requestBody)),
				captureId: "test-capture-1",
				targetUrl: "https://api.openai.com/v1/chat/completions",
			} as any);
		}

		// Process response
		const responseBody = {
			choices: [{ message: { role: "assistant", content: "Your key sk-abcdefghijklmnopqrst has been received" } }]
		};

		if (plugin.onResponse) {
			await plugin.onResponse({
				status: 200,
				headers: { "content-type": "application/json" },
				body: JSON.stringify(responseBody),
				isStreaming: false,
				sessionId: "test-session-1",
			} as any);
		}

		// Verify callback was called
		assert.ok(sqliteCalls.length > 0, "onRedactionMetadata callback should have been called");

		const metadata = sqliteCalls[sqliteCalls.length - 1];
		assert.equal(metadata.captureId, "test-capture-1");
		assert.equal(metadata.sessionId, "test-session-1");
		assert.equal(metadata.source, "test-proxy");
		assert.equal(metadata.provider, "openai");
		assert.equal(metadata.targetUrl, "https://api.openai.com/v1/chat/completions");
		assert.ok(metadata.totalRedactions > 0, "Should have redacted at least one secret");
		assert.ok(Object.keys(metadata.ruleCounts).length > 0, "Should have rule counts");
		assert.ok(metadata.matches && metadata.matches.length > 0, "Should have matches array");
		assert.equal(metadata.successCount, 1);
		assert.equal(metadata.errorCount, 0);
	});

	it("calls onRedactionMetadata with correct rule counts for pii preset", async () => {
		const config: RedactPluginConfig = {
			preset: "pii",
			reversible: false,
			detectorMode: "rules",
			onRedactionMetadata: (metadata: RedactionMetadata) => {
				sqliteCalls.push(metadata);
			},
		};

		const plugin = createRedactPlugin(config);

		const requestBody = {
			user: {
				email: "john.doe@example.com",
				phone: "555-123-4567",
				ssn: "123-45-6789"
			}
		};

		if (plugin.onRequest) {
			await plugin.onRequest({
				provider: "test",
				apiFormat: "raw",
				path: "/test",
				source: "pii-test",
				sessionId: "pii-session-1",
				headers: { "content-type": "application/json" },
				body: requestBody,
				rawBody: Buffer.from(JSON.stringify(requestBody)),
				captureId: "pii-test-1",
				targetUrl: "https://test.com",
			} as any);
		}

		const responseBody = {
			user: { email: "jane.doe@example.com" }
		};

		if (plugin.onResponse) {
			await plugin.onResponse({
				status: 200,
				headers: { "content-type": "application/json" },
				body: JSON.stringify(responseBody),
				isStreaming: false,
				sessionId: "pii-session-1",
			} as any);
		}

		const metadata = sqliteCalls[sqliteCalls.length - 1];
		assert.ok(metadata.totalRedactions > 0, "Should have some redactions");
		assert.ok(Object.keys(metadata.ruleCounts).length > 0, "Should have rule counts");
		assert.equal(metadata.captureId, "pii-test-1");
		assert.equal(metadata.sessionId, "pii-session-1");
		assert.equal(metadata.source, "pii-test");
	});

	it("does not create .redact-meta.json files on filesystem", async () => {
		const captureDir = "/tmp/contextio-test-captures-" + Date.now();

		// Create temp directory
		await mkdir(captureDir, { recursive: true });

		const config: RedactPluginConfig = {
			preset: "secrets",
			reversible: false,
			detectorMode: "rules",
			onRedactionMetadata: (metadata: RedactionMetadata) => {
				sqliteCalls.push(metadata);
			},
		};

		const plugin = createRedactPlugin(config);

		const requestBody = { api_key: "sk-test123" };

		if (plugin.onRequest) {
			await plugin.onRequest({
				provider: "test",
				apiFormat: "raw",
				path: "/test",
				source: "test",
				sessionId: "fs-session",
				headers: { "content-type": "application/json" },
				body: requestBody,
				rawBody: Buffer.from(JSON.stringify(requestBody)),
				captureId: "fs-test-1",
				targetUrl: "https://test.com",
			} as any);
		}

		const responseBody = { result: "ok" };

		if (plugin.onResponse) {
			await plugin.onResponse({
				status: 200,
				headers: { "content-type": "application/json" },
				body: JSON.stringify(responseBody),
				isStreaming: false,
				sessionId: "fs-session",
			} as any);
		}

		// Check no .redact-meta.json files were created
		const files = await readdir(captureDir);
		const metaFiles = files.filter(f => f.endsWith(".redact-meta.json"));
		assert.equal(metaFiles.length, 0, "No .redact-meta.json files should be created");

		await rm(captureDir, { recursive: true, force: true });
	});
});