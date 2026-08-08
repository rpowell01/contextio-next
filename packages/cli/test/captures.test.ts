/**
 * Integration tests for CLI capture commands with SQLite backend.
 *
 * Tests the capture commands (list, stats, search, reindex) using
 * the SQLite-backed implementations. Verifies that the CLI commands
 * produce expected output when backed by the database.
 */

import { describe, it, before, after, beforeEach } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import Database from "better-sqlite3";

import {
	runCapturesList,
	runCapturesStats,
	runCapturesSearch,
	runCapturesReindex,
} from "../dist/commands/captures.js";

import {
	listCaptureFilesSqlite,
	findLastSessionIdSqlite,
	loadSessionCapturesSqlite,
	getCaptureStats,
	searchCapturesSqlite,
	reindexCaptures,
	type CaptureMetadata,
} from "../dist/captures.js";

import { closeDb, initDb, getDb } from "@contextio/core/db";

// --- Fixture builder ---

function makeCaptureMetadata(overrides: Partial<CaptureMetadata> = {}): CaptureMetadata {
	const uniqueId = `${Date.now()}-${Math.random().toString(36).slice(2, 9)}`;
	const base: CaptureMetadata = {
		id: `capture-${uniqueId}`,
		sessionId: "session-123",
		filepath: `/captures/${uniqueId}.json`,
		timestamp: Date.now(),
		requestModel: "gpt-4",
		responseModel: "gpt-4",
		tokensPrompt: 100,
		tokensCompletion: 200,
		durationMs: 1500,
		status: "success",
		createdAt: Date.now(),
	};
	return { ...base, ...overrides };
}

// --- Test harness ---

let tmpHome: string;
let captureSubdir: string;
let testDbDir: string;
let testDbPath: string;

function setupTestDb(): void {
	// Create temp home for captures
	tmpHome = fs.mkdtempSync(join(tmpdir(), "ctxio-cli-captures-test-"));
	captureSubdir = join(tmpHome, ".contextio", "captures");
	// Note: intentionally NOT creating captureSubdir here to prevent
	// initDb() from scheduling background capture auto-migration.
	// Tests that need capture files will create the directory explicitly.
	process.env.HOME = tmpHome;

	// Create temp db
	testDbDir = fs.mkdtempSync(join(tmpdir(), "ctxio-cli-db-test-"));
	testDbPath = join(testDbDir, "test.db");
	process.env.CONTEXTIO_DB_PATH = testDbPath;

	// Close any existing connection
	closeDb();

	// Initialize the database
	initDb();

	// Verify database is set up
	const db = new Database(testDbPath);
	const tables = db.prepare("SELECT name FROM sqlite_master WHERE type='table'").all() as Array<{name: string}>;
	const tableNames = tables.map(t => t.name);
	assert.ok(tableNames.includes("captures_metadata"), "captures_metadata table should exist");
	db.close();
}

function teardownTestDb(): void {
	closeDb();
	if (testDbDir) {
		fs.rmSync(testDbDir, { recursive: true, force: true });
	}
	delete process.env.CONTEXTIO_DB_PATH;
	if (tmpHome) {
		fs.rmSync(tmpHome, { recursive: true, force: true });
	}
	delete process.env.HOME;
}

function clearDatabase(): void {
	const db = new Database(testDbPath);
	db.prepare("DELETE FROM captures_metadata").run();
	db.close();
}

function seedCaptures(count: number, sessionId?: string): CaptureMetadata[] {
	const captures: CaptureMetadata[] = [];
	for (let i = 0; i < count; i++) {
		const model = i % 3 === 0 ? "gpt-4" : i % 3 === 1 ? "gpt-3.5-turbo" : "claude-3";
		const capture = makeCaptureMetadata({
			id: `cli-test-${i}`,
			sessionId: sessionId ?? `session-${i % 5}`,
			timestamp: Date.now() - i * 1000,
			requestModel: model,
			responseModel: model,
			status: i % 4 === 0 ? "error" : "success",
		});
		captures.push(capture);
	}
	return captures;
}

function writeCaptureFiles(captures: CaptureMetadata[]): void {
	if (!fs.existsSync(captureSubdir)) {
		fs.mkdirSync(captureSubdir, { recursive: true });
	}
	captures.forEach((capture) => {
		const captureData = {
			timestamp: new Date(capture.timestamp).toISOString(),
			sessionId: capture.sessionId,
			captureId: capture.id,
			requestModel: capture.requestModel,
			responseModel: capture.responseModel,
			tokensPrompt: capture.tokensPrompt,
			tokensCompletion: capture.tokensCompletion,
			durationMs: capture.durationMs,
			status: capture.status,
			responseStatus: capture.status === "error" ? 500 : 200,
		};
		const filename = `${capture.id}.json`;
		fs.writeFileSync(join(captureSubdir, filename), JSON.stringify(captureData));
	});
}

// Capture console output for assertions (captures output even if function throws)
function captureConsole<T>(fn: () => Promise<T>): Promise<string> {
	const lines: string[] = [];
	const origLog = console.log;
	const origWarn = console.warn;
	const origError = console.error;
	console.log = (...args: unknown[]) => lines.push(args.map(String).join(" "));
	console.warn = (...args: unknown[]) => lines.push("[warn] " + args.map(String).join(" "));
	console.error = (...args: unknown[]) => lines.push("[error] " + args.map(String).join(" "));
	return fn()
		.finally(() => {
			console.log = origLog;
			console.warn = origWarn;
			console.error = origError;
		})
		.then(() => lines.join("\n"))
		.catch((err) => {
			// Return captured output even if function threw
			const output = lines.join("\n");
			throw Object.assign(err, { capturedOutput: output });
		});
}

// --- Tests ---

describe("CLI capture commands with SQLite backend", () => {
	before(() => {
		setupTestDb();
	});

	after(() => {
		teardownTestDb();
	});

	beforeEach(() => {
		clearDatabase();
		// Clear capture files to prevent stale files from previous tests
		if (fs.existsSync(captureSubdir)) {
			const files = fs.readdirSync(captureSubdir).filter(f => f.endsWith(".json"));
			for (const file of files) {
				fs.unlinkSync(join(captureSubdir, file));
			}
		}
	});

	describe("captures list", () => {
		it("lists files from SQLite index", async () => {
			const captures = seedCaptures(5);
			captures.forEach((c) => {
				const db = getDb();
				db.prepare(`
					INSERT INTO captures_metadata (id, session_id, filepath, timestamp, request_model, response_model, tokens_prompt, tokens_completion, duration_ms, status, created_at)
					VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
				`).run(c.id, c.sessionId, c.filepath, c.timestamp, c.requestModel, c.responseModel, c.tokensPrompt, c.tokensCompletion, c.durationMs, c.status, c.createdAt);
			});

			const out = await captureConsole(() => runCapturesList({}));

			assert.ok(out.includes("Found 5 capture(s)"));
			// Should list filepaths
			for (const c of captures) {
				assert.ok(out.includes(c.filepath), `expected ${c.filepath} in output`);
			}
		});

		it("respects limit option", async () => {
			const captures = seedCaptures(10);
			captures.forEach((c) => {
				const db = getDb();
				db.prepare(`
					INSERT INTO captures_metadata (id, session_id, filepath, timestamp, request_model, response_model, tokens_prompt, tokens_completion, duration_ms, status, created_at)
					VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
				`).run(c.id, c.sessionId, c.filepath, c.timestamp, c.requestModel, c.responseModel, c.tokensPrompt, c.tokensCompletion, c.durationMs, c.status, c.createdAt);
			});

			const out = await captureConsole(() => runCapturesList({ limit: "3" }));

			// Should only show 3 captures
			assert.ok(out.includes("Found 3 capture(s)"));
		});

		it("filters by session", async () => {
			const captures = seedCaptures(10);
			captures.forEach((c) => {
				const db = getDb();
				db.prepare(`
					INSERT INTO captures_metadata (id, session_id, filepath, timestamp, request_model, response_model, tokens_prompt, tokens_completion, duration_ms, status, created_at)
					VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
				`).run(c.id, c.sessionId, c.filepath, c.timestamp, c.requestModel, c.responseModel, c.tokensPrompt, c.tokensCompletion, c.durationMs, c.status, c.createdAt);
			});

			const out = await captureConsole(() => runCapturesList({ session: "session-0" }));

			// session-0 appears twice (captures 0 and 5)
			assert.ok(out.includes("Found 2 capture(s)"));
		});
	});

	describe("captures stats", () => {
		it("shows statistics from SQLite", async () => {
			const captures = seedCaptures(10);
			captures.forEach((c) => {
				const db = getDb();
				db.prepare(`
					INSERT INTO captures_metadata (id, session_id, filepath, timestamp, request_model, response_model, tokens_prompt, tokens_completion, duration_ms, status, created_at)
					VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
				`).run(c.id, c.sessionId, c.filepath, c.timestamp, c.requestModel, c.responseModel, c.tokensPrompt, c.tokensCompletion, c.durationMs, c.status, c.createdAt);
			});

			const out = await captureConsole(() => runCapturesStats());

			assert.ok(out.includes("Total captures: 10"));
			assert.ok(out.includes("Total sessions: 5"));
		});

		it("shows no captures message when database is empty", async () => {
			const out = await captureConsole(() => runCapturesStats());

			assert.ok(out.includes("Total captures: 0"));
			assert.ok(out.includes("Total sessions: 0"));
		});
	});

	describe("captures search", () => {
		it("searches by model", async () => {
			const captures = seedCaptures(10);
			captures.forEach((c) => {
				const db = getDb();
				db.prepare(`
					INSERT INTO captures_metadata (id, session_id, filepath, timestamp, request_model, response_model, tokens_prompt, tokens_completion, duration_ms, status, created_at)
					VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
				`).run(c.id, c.sessionId, c.filepath, c.timestamp, c.requestModel, c.responseModel, c.tokensPrompt, c.tokensCompletion, c.durationMs, c.status, c.createdAt);
			});

			const out = await captureConsole(() => runCapturesSearch({ model: "gpt-4" }));

			// gpt-4 appears for captures 0, 3, 6, 9 = 4 captures
			assert.ok(out.includes("Found 4 capture(s)"));
		});

		it("searches by status", async () => {
			const captures = seedCaptures(10);
			captures.forEach((c) => {
				const db = getDb();
				db.prepare(`
					INSERT INTO captures_metadata (id, session_id, filepath, timestamp, request_model, response_model, tokens_prompt, tokens_completion, duration_ms, status, created_at)
					VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
				`).run(c.id, c.sessionId, c.filepath, c.timestamp, c.requestModel, c.responseModel, c.tokensPrompt, c.tokensCompletion, c.durationMs, c.status, c.createdAt);
			});

			const out = await captureConsole(() => runCapturesSearch({ status: "error" }));

			// error appears for captures 0, 4, 8 = 3 captures
			assert.ok(out.includes("Found 3 capture(s)"));
		});

		it("shows no results message when no matches", async () => {
			const out = await captureConsole(() => runCapturesSearch({ model: "nonexistent-model" }));

			assert.ok(out.includes("No captures found matching criteria."));
		});

		it("respects limit option", async () => {
			const captures = seedCaptures(20);
			captures.forEach((c) => {
				const db = getDb();
				db.prepare(`
					INSERT INTO captures_metadata (id, session_id, filepath, timestamp, request_model, response_model, tokens_prompt, tokens_completion, duration_ms, status, created_at)
					VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
				`).run(c.id, c.sessionId, c.filepath, c.timestamp, c.requestModel, c.responseModel, c.tokensPrompt, c.tokensCompletion, c.durationMs, c.status, c.createdAt);
			});

			const out = await captureConsole(() => runCapturesSearch({ limit: "5" }));

			assert.ok(out.includes("Found 5 capture(s)"));
		});
	});

	describe("captures reindex", () => {
		it("reindexes captures from files to SQLite", async () => {
			const captures = seedCaptures(5);
			writeCaptureFiles(captures);

			const out = await captureConsole(() => runCapturesReindex({}));

			assert.ok(out.includes("Files scanned: 5"));
			assert.ok(out.includes("Indexed: 5"));
			assert.ok(out.includes("Skipped: 0"));
			assert.ok(out.includes("Failed: 0"));

			// Verify in database
			const db = new Database(testDbPath);
			const count = db.prepare("SELECT COUNT(*) as count FROM captures_metadata").get() as { count: number };
			assert.equal(count.count, 5);
			db.close();
		});

		it("skips already indexed captures on re-run", async () => {
			const captures = seedCaptures(5);
			writeCaptureFiles(captures);

			await captureConsole(() => runCapturesReindex({}));
			const out = await captureConsole(() => runCapturesReindex({}));

			assert.ok(out.includes("Files scanned: 5"));
			assert.ok(out.includes("Indexed: 0"));
			assert.ok(out.includes("Skipped: 5"));
		});

		it("reindexes with force option", async () => {
			const captures = seedCaptures(3);
			writeCaptureFiles(captures);

			await captureConsole(() => runCapturesReindex({}));

			// Modify files
			const modifiedCaptures = captures.map((c) => ({ ...c, status: "error" as const }));
			writeCaptureFiles(modifiedCaptures);

			const out = await captureConsole(() => runCapturesReindex({ force: true }));

			assert.ok(out.includes("Indexed: 3"));
			assert.ok(out.includes("Skipped: 0"));

			// Verify updated in database
			const db = new Database(testDbPath);
			const errorCount = db.prepare("SELECT COUNT(*) as count FROM captures_metadata WHERE status = 'error'").get() as { count: number };
			assert.equal(errorCount.count, 3);
			db.close();
		});

		it("reports errors for malformed files", async () => {
			writeCaptureFiles(seedCaptures(3));
			// Write a malformed file
			fs.writeFileSync(join(captureSubdir, "0001-bad.json"), "{ invalid json");

			let out = "";
			try {
				out = await captureConsole(() => runCapturesReindex({}));
			} catch (err: unknown) {
				out = (err as { capturedOutput: string }).capturedOutput;
			}

			assert.ok(out.includes("Failed: 1"));
			assert.ok(out.includes("0001-bad.json"));
		});
	});

	describe("SQLite fallback behavior", () => {
		it("falls back to file scan when database not initialized", async () => {
			closeDb();

			const out = await captureConsole(() => listCaptureFilesSqlite());

			// Should warn and fall back
			assert.ok(out.includes("[warn]"));
			assert.ok(out.includes("falling back to file scan"));
		});

		it("findLastSessionIdSqlite falls back when DB not initialized", async () => {
			closeDb();

			const out = await captureConsole(() => findLastSessionIdSqlite());

			assert.ok(out.includes("[warn]"));
			assert.ok(out.includes("falling back to file scan"));
		});

		it("loadSessionCapturesSqlite falls back when DB not initialized", async () => {
			closeDb();

			const out = await captureConsole(() => loadSessionCapturesSqlite("session-123"));

			assert.ok(out.includes("[warn]"));
			assert.ok(out.includes("falling back to file scan"));
		});
	});

	describe("Reindex with dryRun", () => {
		it("does not write to database in dryRun mode", async () => {
			const captures = seedCaptures(3);
			writeCaptureFiles(captures);

			const out = await captureConsole(() => runCapturesReindex({ dryRun: true }));

			assert.ok(out.includes("DRY RUN"));
			assert.ok(out.includes("Indexed: 3"));

			// Database should be empty
			const db = new Database(testDbPath);
			const count = db.prepare("SELECT COUNT(*) as count FROM captures_metadata").get() as { count: number };
			assert.equal(count.count, 0);
			db.close();
		});
	});

	describe("Migration from existing JSON data", () => {
		it("indexes existing capture files correctly", async () => {
			// Write some capture files
			const captures = seedCaptures(20);
			writeCaptureFiles(captures);

			const out = await captureConsole(() => runCapturesReindex({}));

			assert.ok(out.includes("Files scanned: 20"));
			assert.ok(out.includes("Indexed: 20"));

			// Verify all are in database
			const db = new Database(testDbPath);
			const count = db.prepare("SELECT COUNT(*) as count FROM captures_metadata").get() as { count: number };
			assert.equal(count.count, 20);
			db.close();
		});

		it("preserves metadata during migration", async () => {
			const captures = seedCaptures(3);
			writeCaptureFiles(captures);

			await runCapturesReindex({});

			// Query database to verify metadata
			const db = new Database(testDbPath);
			const rows = db.prepare("SELECT * FROM captures_metadata ORDER BY timestamp").all() as Array<{
				id: string;
				session_id: string;
				filepath: string;
				timestamp: number;
				request_model: string;
				response_model: string;
				tokens_prompt: number;
				tokens_completion: number;
				duration_ms: number;
				status: string;
			}>;
			db.close();

			assert.equal(rows.length, 3);
			assert.ok(["gpt-4", "gpt-3.5-turbo", "claude-3"].includes(rows[0].request_model));
			assert.ok(["success", "error"].includes(rows[0].status));
			assert.ok(rows[0].tokens_prompt >= 0);
			assert.ok(rows[0].tokens_completion >= 0);
		});
	});
});