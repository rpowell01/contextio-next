import { describe, it, before, after, beforeEach } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync, mkdirSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import Database from "better-sqlite3";

import {
	migrateCaptures,
	migrateCapturesSync,
	getDefaultCaptureDir,
	type MigrateCapturesOptions,
	type MigrateCapturesResult,
} from "../dist/db/migrate-captures.js";

import {
	upsertCapture,
	getCaptureById,
	getCaptureCount,
	closeDb,
	initDb,
} from "../dist/db/index.js";

/**
 * Test database and capture directory setup.
 */

let testDbDir: string;
let testDbPath: string;
let testCaptureDir: string;

function createCaptureFile(overrides: Record<string, unknown> = {}): Record<string, unknown> {
	const base = {
		timestamp: "2025-01-01T12:00:00.000Z",
		sessionId: "session-123",
		captureId: "capture-456",
		requestModel: "gpt-4",
		responseModel: "gpt-4",
		tokensPrompt: 100,
		tokensCompletion: 200,
		durationMs: 1500,
		status: "success",
		responseStatus: 200,
	};
	return { ...base, ...overrides };
}

// Setup test database and capture directory
async function setupTest(): Promise<void> {
	// Create a temporary directory for our test database
	testDbDir = mkdtempSync(join(tmpdir(), "contextio-migrate-captures-test-"));
	testDbPath = join(testDbDir, "test.db");
	testCaptureDir = join(testDbDir, "captures");
	mkdirSync(testCaptureDir, { recursive: true });

	// Set environment variables
	process.env.CONTEXTIO_DB_PATH = testDbPath;
	process.env.LOGGER_CAPTURE_DIR = testCaptureDir;

	// Close any existing connection
	closeDb();

	// Initialize the database
	initDb();
}

function clearCapturesTable(): void {
	const db = new Database(testDbPath);
	db.prepare("DELETE FROM captures_metadata").run();
	db.close();
}

function clearCaptureFiles(): void {
	if (existsSync(testCaptureDir)) {
		rmSync(testCaptureDir, { recursive: true, force: true });
	}
	mkdirSync(testCaptureDir, { recursive: true });
}

// Cleanup
async function teardownTest(): Promise<void> {
	closeDb();
	if (testDbDir) {
		rmSync(testDbDir, { recursive: true, force: true });
	}
	delete process.env.CONTEXTIO_DB_PATH;
	delete process.env.LOGGER_CAPTURE_DIR;
}

describe("migrate-captures.ts - Capture Migration", () => {
	before(async () => {
		await setupTest();
	});

	after(async () => {
		await teardownTest();
	});

	beforeEach(() => {
		clearCapturesTable();
		clearCaptureFiles();
		// Ensure LOGGER_CAPTURE_DIR is set for all tests
		process.env.LOGGER_CAPTURE_DIR = testCaptureDir;
	});

	describe("getDefaultCaptureDir", () => {
		it("returns LOGGER_CAPTURE_DIR when set", () => {
			const customDir = "/custom/capture/dir";
			process.env.LOGGER_CAPTURE_DIR = customDir;
			assert.equal(getDefaultCaptureDir(), customDir);
			// Restore for other tests
			process.env.LOGGER_CAPTURE_DIR = testCaptureDir;
		});

		it("falls back to ~/.contextio/captures when env var not set", () => {
			const previousDir = process.env.LOGGER_CAPTURE_DIR;
			delete process.env.LOGGER_CAPTURE_DIR;
			const dir = getDefaultCaptureDir();
			assert.ok(dir.includes(".contextio"));
			assert.ok(dir.endsWith("captures"));
			// Restore for other tests
			process.env.LOGGER_CAPTURE_DIR = previousDir;
		});
	});

	describe("migrateCapturesSync", () => {
		it("returns zero counts when capture directory does not exist", () => {
			clearCaptureFiles();
			rmSync(testCaptureDir, { recursive: true, force: true });
			
			const result = migrateCapturesSync();
			
			assert.equal(result.indexed, 0);
			assert.equal(result.skipped, 0);
			assert.equal(result.failed, 0);
			assert.equal(result.totalFiles, 0);
			assert.deepEqual(result.errors, []);
		});

		it("returns zero counts when capture directory is empty", () => {
			const result = migrateCapturesSync();
			
			assert.equal(result.indexed, 0);
			assert.equal(result.skipped, 0);
			assert.equal(result.failed, 0);
			assert.equal(result.totalFiles, 0);
		});

		it("indexes plaintext capture files", () => {
			const capture1 = createCaptureFile({ captureId: "cap-1", sessionId: "sess-1" });
			const capture2 = createCaptureFile({ captureId: "cap-2", sessionId: "sess-1" });
			
			writeFileSync(join(testCaptureDir, "cap-1.json"), JSON.stringify(capture1));
			writeFileSync(join(testCaptureDir, "cap-2.json"), JSON.stringify(capture2));
			
			const result = migrateCapturesSync();
			
			assert.equal(result.totalFiles, 2);
			assert.equal(result.indexed, 2);
			assert.equal(result.skipped, 0);
			assert.equal(result.failed, 0);
			
			// Verify in database
			const cap1 = getCaptureById("cap-1");
			const cap2 = getCaptureById("cap-2");
			assert.ok(cap1 !== null);
			assert.ok(cap2 !== null);
			assert.equal(cap1!.sessionId, "sess-1");
			assert.equal(cap2!.sessionId, "sess-1");
			assert.equal(cap1!.requestModel, "gpt-4");
			assert.equal(cap1!.tokensPrompt, 100);
		});

		it("skips already indexed captures by default (idempotency)", () => {
			const capture = createCaptureFile({ captureId: "cap-idempotent", sessionId: "sess-1" });
			writeFileSync(join(testCaptureDir, "cap-idempotent.json"), JSON.stringify(capture));
			
			// First migration
			const result1 = migrateCapturesSync();
			assert.equal(result1.indexed, 1);
			assert.equal(result1.skipped, 0);
			
			// Second migration without force
			const result2 = migrateCapturesSync();
			assert.equal(result2.indexed, 0);
			assert.equal(result2.skipped, 1);
			assert.equal(result2.totalFiles, 1);
		});

		it("re-indexes captures when force option is true", () => {
			const capture = createCaptureFile({ captureId: "cap-force", sessionId: "sess-1", tokensPrompt: 100 });
			writeFileSync(join(testCaptureDir, "cap-force.json"), JSON.stringify(capture));
			
			migrateCapturesSync();
			
			// Update the file with new data
			const updatedCapture = createCaptureFile({ captureId: "cap-force", sessionId: "sess-1", tokensPrompt: 200 });
			writeFileSync(join(testCaptureDir, "cap-force.json"), JSON.stringify(updatedCapture));
			
			// Migrate with force
			const result = migrateCapturesSync({ force: true });
			assert.equal(result.indexed, 1);
			assert.equal(result.skipped, 0);
			
			// Verify updated data
			const cap = getCaptureById("cap-force");
			assert.equal(cap!.tokensPrompt, 200);
		});

		it("handles captures with null/undefined sessionId", () => {
			const capture = createCaptureFile({ captureId: "cap-null-session", sessionId: null });
			writeFileSync(join(testCaptureDir, "cap-null-session.json"), JSON.stringify(capture));
			
			const result = migrateCapturesSync();
			
			assert.equal(result.indexed, 1);
			const cap = getCaptureById("cap-null-session");
			assert.ok(cap !== null);
			assert.equal(cap!.sessionId, undefined);
		});

		it("handles captures with missing optional fields", () => {
			const capture = createCaptureFile({ 
				captureId: "cap-minimal",
				requestModel: undefined,
				responseModel: undefined,
				tokensPrompt: undefined,
				tokensCompletion: undefined,
				durationMs: undefined,
				status: undefined,
			});
			writeFileSync(join(testCaptureDir, "cap-minimal.json"), JSON.stringify(capture));
			
			const result = migrateCapturesSync();
			
			assert.equal(result.indexed, 1);
			const cap = getCaptureById("cap-minimal");
			assert.ok(cap !== null);
			assert.equal(cap!.requestModel, undefined);
			assert.equal(cap!.responseModel, undefined);
			assert.equal(cap!.tokensPrompt, undefined);
			assert.equal(cap!.tokensCompletion, undefined);
			assert.equal(cap!.durationMs, undefined);
			// Default status when undefined and responseStatus not error
			assert.equal(cap!.status, "success");
		});

		it("infers error status from responseStatus >= 400", () => {
			const capture = createCaptureFile({ 
				captureId: "cap-error",
				status: undefined,
				responseStatus: 500,
			});
			writeFileSync(join(testCaptureDir, "cap-error.json"), JSON.stringify(capture));
			
			const result = migrateCapturesSync();
			
			assert.equal(result.indexed, 1);
			const cap = getCaptureById("cap-error");
			assert.equal(cap!.status, "error");
		});

		it("uses timings.total_ms when durationMs not present", () => {
			const capture = createCaptureFile({ 
				captureId: "cap-timings",
				durationMs: undefined,
				timings: { total_ms: 2500 },
			});
			writeFileSync(join(testCaptureDir, "cap-timings.json"), JSON.stringify(capture));
			
			const result = migrateCapturesSync();
			
			assert.equal(result.indexed, 1);
			const cap = getCaptureById("cap-timings");
			assert.equal(cap!.durationMs, 2500);
		});

		it("supports both tokensPrompt/tokens_prompt and tokensCompletion/tokens_completion", () => {
			const capture = createCaptureFile({ 
				captureId: "cap-underscore",
				tokensPrompt: undefined,
				tokensCompletion: undefined,
				tokens_prompt: 150,
				tokens_completion: 250,
			});
			writeFileSync(join(testCaptureDir, "cap-underscore.json"), JSON.stringify(capture));
			
			const result = migrateCapturesSync();
			
			assert.equal(result.indexed, 1);
			const cap = getCaptureById("cap-underscore");
			assert.equal(cap!.tokensPrompt, 150);
			assert.equal(cap!.tokensCompletion, 250);
		});

		it("ignores .tmp files", () => {
			const capture = createCaptureFile({ captureId: "cap-tmp" });
			writeFileSync(join(testCaptureDir, "cap-tmp.json"), JSON.stringify(capture));
			writeFileSync(join(testCaptureDir, "cap-tmp.json.tmp"), JSON.stringify(capture));
			
			const result = migrateCapturesSync();
			
			assert.equal(result.totalFiles, 1);
			assert.equal(result.indexed, 1);
		});

		it("respects maxFiles option", () => {
			for (let i = 1; i <= 5; i++) {
				const capture = createCaptureFile({ captureId: `cap-${i}` });
				writeFileSync(join(testCaptureDir, `cap-${i}.json`), JSON.stringify(capture));
			}
			
			const result = migrateCapturesSync({ maxFiles: 3 });
			
			assert.equal(result.totalFiles, 3);
			assert.equal(result.indexed, 3);
		});

		it("calls onProgress callback", () => {
			const capture = createCaptureFile({ captureId: "cap-progress" });
			writeFileSync(join(testCaptureDir, "cap-progress.json"), JSON.stringify(capture));
			
			let progressCalled = false;
			let progressProcessed = 0;
			let progressTotal = 0;
			
			migrateCapturesSync({
				onProgress: (processed: number, total: number) => {
					progressCalled = true;
					progressProcessed = processed;
					progressTotal = total;
				}
			});
			
			assert.ok(progressCalled);
			assert.equal(progressProcessed, 1);
			assert.equal(progressTotal, 1);
		});

		it("returns errors for malformed JSON files", () => {
			writeFileSync(join(testCaptureDir, "bad.json"), "{ invalid json");

			const result = migrateCapturesSync();
			
			assert.equal(result.totalFiles, 1);
			assert.equal(result.failed, 1);
			assert.equal(result.indexed, 0);
			assert.equal(result.errors.length, 1);
			assert.equal(result.errors[0].file, "bad.json");
			assert.ok(result.errors[0].error.length > 0, "should have an error message");
		});

		it("dryRun option does not write to database", () => {
			const capture = createCaptureFile({ captureId: "cap-dryrun" });
			writeFileSync(join(testCaptureDir, "cap-dryrun.json"), JSON.stringify(capture));
			
			const result = migrateCapturesSync({ dryRun: true });
			
			assert.equal(result.indexed, 1);
			assert.equal(getCaptureCount(), 0); // Should not be in database
		});
	});

	describe("migrateCaptures (async)", () => {
		it("indexes plaintext capture files", async () => {
			const capture = createCaptureFile({ captureId: "cap-async", sessionId: "sess-async" });
			writeFileSync(join(testCaptureDir, "cap-async.json"), JSON.stringify(capture));
			
			const result = await migrateCaptures({});
			
			assert.equal(result.totalFiles, 1);
			assert.equal(result.indexed, 1);
			assert.equal(result.skipped, 0);
			assert.equal(result.failed, 0);
			
			const cap = getCaptureById("cap-async");
			assert.ok(cap !== null);
			assert.equal(cap!.sessionId, "sess-async");
		});

		it("skips already indexed captures by default", async () => {
			const capture = createCaptureFile({ captureId: "cap-async-skip" });
			writeFileSync(join(testCaptureDir, "cap-async-skip.json"), JSON.stringify(capture));
			
			await migrateCaptures({});
			const result = await migrateCaptures({});
			
			assert.equal(result.indexed, 0);
			assert.equal(result.skipped, 1);
		});

		it("re-indexes with force option", async () => {
			const capture = createCaptureFile({ captureId: "cap-async-force", tokensPrompt: 100 });
			writeFileSync(join(testCaptureDir, "cap-async-force.json"), JSON.stringify(capture));
			
			await migrateCaptures({});
			
			const updatedCapture = createCaptureFile({ captureId: "cap-async-force", tokensPrompt: 200 });
			writeFileSync(join(testCaptureDir, "cap-async-force.json"), JSON.stringify(updatedCapture));
			
			const result = await migrateCaptures({ force: true });
			assert.equal(result.indexed, 1);
			assert.equal(result.skipped, 0);
			
			const cap = getCaptureById("cap-async-force");
			assert.equal(cap!.tokensPrompt, 200);
		});

		it("processes files in batches", async () => {
			// Create 150 files to test batching (batch size is 100)
			for (let i = 1; i <= 150; i++) {
				const capture = createCaptureFile({ captureId: `cap-batch-${i}` });
				writeFileSync(join(testCaptureDir, `cap-batch-${i}.json`), JSON.stringify(capture));
			}
			
			const result = await migrateCaptures({});
			
			assert.equal(result.totalFiles, 150);
			assert.equal(result.indexed, 150);
		});

		it("handles decryption function for encrypted captures", async () => {
			// Create an "encrypted" capture file
			const encryptedCapture = {
				ciphertext: "encrypted-data",
				salt: "salt",
				iv: "iv",
			};
			writeFileSync(join(testCaptureDir, "encrypted.json"), JSON.stringify(encryptedCapture));
			
			// Provide a mock decrypt function
			const decryptFn = async (encryptedJson: string, keyMaterial: string): Promise<string> => {
				// Return a valid plaintext capture
				return JSON.stringify(createCaptureFile({ captureId: "cap-decrypted" }));
			};
			
			const result = await migrateCaptures({ decryptFn, keyMaterial: "test-key" });
			
			assert.equal(result.totalFiles, 1);
			assert.equal(result.indexed, 1);
			assert.equal(result.failed, 0);
			
			const cap = getCaptureById("cap-decrypted");
			assert.ok(cap !== null);
		});

		it("fails gracefully when encrypted capture lacks decrypt function", async () => {
			const encryptedCapture = {
				ciphertext: "encrypted-data",
				salt: "salt",
				iv: "iv",
			};
			writeFileSync(join(testCaptureDir, "encrypted-no-decrypt.json"), JSON.stringify(encryptedCapture));
			
			const result = await migrateCaptures({});
			
			assert.equal(result.totalFiles, 1);
			assert.equal(result.failed, 1);
			assert.equal(result.indexed, 0);
			assert.ok(result.errors[0].error.includes("Encrypted capture but no decrypt function"));
		});

		it("dryRun option does not write to database", async () => {
			const capture = createCaptureFile({ captureId: "cap-async-dryrun" });
			writeFileSync(join(testCaptureDir, "cap-async-dryrun.json"), JSON.stringify(capture));
			
			const result = await migrateCaptures({ dryRun: true });
			
			assert.equal(result.indexed, 1);
			assert.equal(getCaptureCount(), 0);
		});

		it("uses custom captureDir when provided", async () => {
			const customDir = join(testDbDir, "custom-captures");
			mkdirSync(customDir, { recursive: true });
			
			const capture = createCaptureFile({ captureId: "cap-custom-dir" });
			writeFileSync(join(customDir, "cap-custom-dir.json"), JSON.stringify(capture));
			
			const result = await migrateCaptures({ captureDir: customDir });
			
			assert.equal(result.totalFiles, 1);
			assert.equal(result.indexed, 1);
			
			const cap = getCaptureById("cap-custom-dir");
			assert.ok(cap !== null);
		});
	});

	describe("Concurrent access scenarios", () => {
		it("handles multiple sequential migrations correctly", async () => {
			// First batch
			for (let i = 1; i <= 10; i++) {
				const capture = createCaptureFile({ captureId: `cap-seq-${i}` });
				writeFileSync(join(testCaptureDir, `cap-seq-${i}.json`), JSON.stringify(capture));
			}
			
			const result1 = await migrateCaptures({});
			assert.equal(result1.indexed, 10);
			
			// Second batch
			for (let i = 11; i <= 20; i++) {
				const capture = createCaptureFile({ captureId: `cap-seq-${i}` });
				writeFileSync(join(testCaptureDir, `cap-seq-${i}.json`), JSON.stringify(capture));
			}
			
			const result2 = await migrateCaptures({});
		assert.equal(result2.indexed, 10);
		assert.equal(result2.skipped, 10); // Files 1-10 already indexed, correctly skipped
			
			// Total should be 20
			assert.equal(getCaptureCount(), 20);
		});

		it("handles mixed new and existing files", async () => {
			// Initial files
			for (let i = 1; i <= 5; i++) {
				const capture = createCaptureFile({ captureId: `cap-mixed-${i}` });
				writeFileSync(join(testCaptureDir, `cap-mixed-${i}.json`), JSON.stringify(capture));
			}
			
			await migrateCaptures({});
			
			// Add more files
			for (let i = 6; i <= 10; i++) {
				const capture = createCaptureFile({ captureId: `cap-mixed-${i}` });
				writeFileSync(join(testCaptureDir, `cap-mixed-${i}.json`), JSON.stringify(capture));
			}
			
			const result = await migrateCaptures({});
			assert.equal(result.totalFiles, 10);
			assert.equal(result.indexed, 5); // Only new files
			assert.equal(result.skipped, 5); // Existing files
		});
	});

	describe("Large dataset handling", () => {
		it("handles 1000 capture files efficiently", async () => {
			// Create 1000 files
			for (let i = 1; i <= 1000; i++) {
				const capture = createCaptureFile({ 
					captureId: `cap-large-${i}`,
					sessionId: `session-${i % 100}`,
					timestamp: Date.now() - i * 1000,
				});
				writeFileSync(join(testCaptureDir, `cap-large-${i}.json`), JSON.stringify(capture));
			}
			
			const startTime = Date.now();
			const result = await migrateCaptures({});
			const elapsed = Date.now() - startTime;
			
			assert.equal(result.totalFiles, 1000);
			assert.equal(result.indexed, 1000);
			assert.equal(result.failed, 0);
			assert.ok(elapsed < 30000); // Should complete within 30 seconds
			
			console.log(`[perf] 1000 files indexed in ${elapsed}ms`);
		});
	});
});