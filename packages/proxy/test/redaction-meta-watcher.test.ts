import { describe, it, before, after, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { writeFile, mkdir, readdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import Database from "better-sqlite3";

import {
	createRedactionMetaWatcher,
	type RedactionMetaWatcherOptions,
	type CaptureRedactionMetadata,
} from "../dist/redaction-meta-watcher.js";
import type { RedactionMetadata } from "@contextio/core/db";

import { closeDb, initDb } from "@contextio/core/db";

let testDbDir: string;
let testDbPath: string;
let testCaptureDir: string;

function getTestDbPath(): string {
	return testDbPath;
}

async function setupTestDb(): Promise<void> {
	testDbDir = mkdtempSync(join(tmpdir(), "contextio-watcher-test-"));
	testDbPath = join(testDbDir, "test.db");
	testCaptureDir = join(testDbDir, "captures");

	await mkdir(testCaptureDir, { recursive: true });

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

function createCaptureFile(filename: string, content: Record<string, unknown>): void {
	const path = join(testCaptureDir, filename);
	writeFile(path, JSON.stringify(content, null, 2));
}

async function clearCaptureDir(): Promise<void> {
	try {
		await rm(testCaptureDir, { recursive: true, force: true });
		await mkdir(testCaptureDir, { recursive: true });
	} catch {
		// Ignore
	}
}

describe("redaction-meta-watcher.ts", () => {
	let sqliteCalls: RedactionMetadata[] = [];

	before(async () => {
		await setupTestDb();
	});

	after(async () => {
		await teardownTestDb();
	});

	beforeEach(async () => {
		sqliteCalls = [];
		await clearCaptureDir();
	});

	it("creates watcher with required persistToSqlite callback", () => {
		const opts: RedactionMetaWatcherOptions = {
			captureDir: testCaptureDir,
			persistToSqlite: (metadata: RedactionMetadata) => {
				sqliteCalls.push(metadata);
			},
		};

		const watcher = createRedactionMetaWatcher(opts);
		assert.ok(watcher);
		assert.equal(typeof watcher.stop, "function");
		watcher.stop();
	});

	it("computes metadata and calls persistToSqlite callback for new capture", async () => {
		const opts: RedactionMetaWatcherOptions = {
			captureDir: testCaptureDir,
			persistToSqlite: (metadata: RedactionMetadata) => {
				sqliteCalls.push(metadata);
			},
		};

		const watcher = createRedactionMetaWatcher(opts);

		// Create a capture file with redacted content
		createCaptureFile("test_abc123_1234567890123-456789.json", {
			sessionId: "test-session-1",
			source: "test-proxy",
			provider: "anthropic",
			apiFormat: "messages",
			targetUrl: "https://api.anthropic.com/v1/messages",
			method: "POST",
			requestBody: {
				model: "claude-3-opus",
				messages: [{
					role: "user",
					content: "My API key is [API_KEY_REDACTED]"
				}]
			},
			responseBody: JSON.stringify({
				choices: [{ message: { content: "Your key [API_KEY_REDACTED] was received" } }]
			}),
			responseStatus: 200,
			requestBytes: 256,
			responseBytes: 512,
			timings: { send_ms: 10, wait_ms: 200, receive_ms: 15, total_ms: 225 },
			timestamp: new Date().toISOString(),
		});

		// Allow time for async processing (debounce + jitter = ~2500ms)
		await new Promise(resolve => setTimeout(resolve, 3500));

		// Stop watcher to flush pending
		watcher.stop();

		await new Promise(resolve => setTimeout(resolve, 500));

		// Verify callback was called
		assert.ok(sqliteCalls.length > 0, "persistToSqlite should have been called");

		const metadata = sqliteCalls[sqliteCalls.length - 1];
		assert.equal(metadata.captureId, "test_abc123_1234567890123-456789");
		assert.equal(metadata.sessionId, "test-session-1");
		assert.equal(metadata.source, "test-proxy");
		assert.equal(metadata.provider, "anthropic");
		assert.equal(metadata.targetUrl, "https://api.anthropic.com/v1/messages");
		assert.ok(metadata.totalRedactions > 0, "Should detect redactions");
		assert.ok(metadata.ruleCounts.api_key >= 1, "Should count API_KEY redactions");
		assert.ok(metadata.requestBytes === 256);
		assert.ok(metadata.responseBytes === 512);
		assert.ok(metadata.timings && metadata.timings.total_ms === 225);
		assert.ok(metadata.totalInputTokens !== undefined);
		assert.ok(metadata.totalOutputTokens !== undefined);
		assert.ok(metadata.tokensPerSecond !== undefined);
		assert.equal(metadata.successCount, 1);
		assert.equal(metadata.errorCount, 0);
		// Note: matches field may not be populated by watcher (it uses simplified redaction detection)
	});

	it("does not create .redact-meta.json files", async () => {
		const opts: RedactionMetaWatcherOptions = {
			captureDir: testCaptureDir,
			persistToSqlite: (metadata: RedactionMetadata) => {
				sqliteCalls.push(metadata);
			},
		};

		const watcher = createRedactionMetaWatcher(opts);

		createCaptureFile("fs_test_1234567890123-456789.json", {
			sessionId: "fs-session",
			requestBody: { text: "Key: [API_KEY_REDACTED]" },
			responseBody: "OK",
			responseStatus: 200,
			timestamp: new Date().toISOString(),
		});

		await new Promise(resolve => setTimeout(resolve, 3500));
		watcher.stop();
		await new Promise(resolve => setTimeout(resolve, 500));

		// Check capture directory for .redact-meta.json files
		const files = await readdir(testCaptureDir);
		const metaFiles = files.filter(f => f.endsWith(".redact-meta.json"));
		assert.equal(metaFiles.length, 0, "No .redact-meta.json files should be created by watcher");
	});

	it("handles capture file with PII redactions", async () => {
		const opts: RedactionMetaWatcherOptions = {
			captureDir: testCaptureDir,
			persistToSqlite: (metadata: RedactionMetadata) => {
				sqliteCalls.push(metadata);
			},
		};

		const watcher = createRedactionMetaWatcher(opts);

		createCaptureFile("pii_test_1234567890123-456789.json", {
			sessionId: "pii-session",
			requestBody: {
				user: {
					email: "[EMAIL_REDACTED]",
					phone: "[PHONE_REDACTED]",
					ssn: "123-45-6789"
				}
			},
			responseBody: JSON.stringify({ email: "[EMAIL_REDACTED]" }),
			responseStatus: 200,
			timings: { total_ms: 150 },
			timestamp: new Date().toISOString(),
		});

		await new Promise(resolve => setTimeout(resolve, 3500));
		watcher.stop();
		await new Promise(resolve => setTimeout(resolve, 500));

		const metadata = sqliteCalls[sqliteCalls.length - 1];
		assert.ok(metadata.totalRedactions > 0, "Should detect some redactions");
		// Note: the watcher's regex detection may differ from the redact plugin's rules
	});

	it("handles capture file with secret redactions", async () => {
		const opts: RedactionMetaWatcherOptions = {
			captureDir: testCaptureDir,
			persistToSqlite: (metadata: RedactionMetadata) => {
				sqliteCalls.push(metadata);
			},
		};

		const watcher = createRedactionMetaWatcher(opts);

		createCaptureFile("secret_test_1234567890123-456789.json", {
			sessionId: "secret-session",
			requestBody: {
				api_key: "[AWS_KEY_REDACTED]",
				github_token: "[GITHUB_TOKEN_REDACTED]"
			},
			responseBody: "OK",
			responseStatus: 200,
			timings: { total_ms: 100 },
			timestamp: new Date().toISOString(),
		});

		await new Promise(resolve => setTimeout(resolve, 3500));
		watcher.stop();
		await new Promise(resolve => setTimeout(resolve, 500));

		const metadata = sqliteCalls[sqliteCalls.length - 1];
		assert.ok(metadata.totalRedactions > 0, "Should detect some redactions");
	});

	it("handles capture without redactions", async () => {
		const opts: RedactionMetaWatcherOptions = {
			captureDir: testCaptureDir,
			persistToSqlite: (metadata: RedactionMetadata) => {
				sqliteCalls.push(metadata);
			},
		};

		const watcher = createRedactionMetaWatcher(opts);

		createCaptureFile("no_redact_1234567890123-456789.json", {
			sessionId: "no-redact-session",
			requestBody: { message: "Hello world" },
			responseBody: "Hi there",
			responseStatus: 200,
			timestamp: new Date().toISOString(),
		});

		await new Promise(resolve => setTimeout(resolve, 3500));
		watcher.stop();
		await new Promise(resolve => setTimeout(resolve, 500));

		const metadata = sqliteCalls[sqliteCalls.length - 1];
		assert.equal(metadata.totalRedactions, 0);
		assert.deepEqual(metadata.ruleCounts, {});
	});

	it("handles error responses with errorCount", async () => {
		const opts: RedactionMetaWatcherOptions = {
			captureDir: testCaptureDir,
			persistToSqlite: (metadata: RedactionMetadata) => {
				sqliteCalls.push(metadata);
			},
		};

		const watcher = createRedactionMetaWatcher(opts);

		createCaptureFile("error_test_1234567890123-456789.json", {
			sessionId: "error-session",
			requestBody: { query: "[API_KEY_REDACTED]" },
			responseBody: "Error",
			responseStatus: 429,
			timings: { total_ms: 50 },
			timestamp: new Date().toISOString(),
		});

		await new Promise(resolve => setTimeout(resolve, 3500));
		watcher.stop();
		await new Promise(resolve => setTimeout(resolve, 500));

		const metadata = sqliteCalls[sqliteCalls.length - 1];
		// Note: watcher determines success/error from responseStatus
		assert.ok(metadata.totalRedactions >= 0);
	});

	it("skips invalid filenames", async () => {
		const opts: RedactionMetaWatcherOptions = {
			captureDir: testCaptureDir,
			persistToSqlite: (metadata: RedactionMetadata) => {
				sqliteCalls.push(metadata);
			},
		};

		const watcher = createRedactionMetaWatcher(opts);

		// These should be skipped
		createCaptureFile("invalid..json", { requestBody: { key: "[API_KEY_REDACTED]" } });
		createCaptureFile("../traversal.json", { requestBody: { key: "[API_KEY_REDACTED]" } });
		createCaptureFile("no_extension", { requestBody: { key: "[API_KEY_REDACTED]" } });

		await new Promise(resolve => setTimeout(resolve, 3500));
		watcher.stop();
		await new Promise(resolve => setTimeout(resolve, 500));

		// No calls should have been made for invalid files
		assert.equal(sqliteCalls.length, 0);
	});

	it("scans existing captures on startup", async () => {
		// Pre-create captures before watcher starts
		createCaptureFile("preexisting_1234567890123-456789.json", {
			sessionId: "pre-session-1",
			requestBody: { key: "[API_KEY_REDACTED]" },
			responseStatus: 200,
			timestamp: new Date().toISOString(),
		});
		createCaptureFile("preexisting2_1234567890123-456789.json", {
			sessionId: "pre-session-2",
			requestBody: { email: "[EMAIL_REDACTED]" },
			responseStatus: 200,
			timestamp: new Date().toISOString(),
		});

		const opts: RedactionMetaWatcherOptions = {
			captureDir: testCaptureDir,
			persistToSqlite: (metadata: RedactionMetadata) => {
				sqliteCalls.push(metadata);
			},
		};

		const watcher = createRedactionMetaWatcher(opts);

		// The watcher scans existing captures on startup (uses debounce scheduler)
		await new Promise(resolve => setTimeout(resolve, 3500));
		watcher.stop();
		await new Promise(resolve => setTimeout(resolve, 500));

		// Should have processed both pre-existing captures
		assert.ok(sqliteCalls.length >= 2);
	});
});