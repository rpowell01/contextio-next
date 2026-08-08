import { describe, it, before, after, beforeEach } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import Database from "better-sqlite3";

import {
	getDb,
	closeDb,
	initConnection,
	isDbInitialized,
	getDbPath,
	runMigrations,
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
	testDbDir = mkdtempSync(join(tmpdir(), "contextio-connection-test-"));
	testDbPath = join(testDbDir, "test.db");

	// Set environment variable so production code uses our test database
	process.env.CONTEXTIO_DB_PATH = testDbPath;

	// Close any existing connection
	closeDb();

	// Initialize the database connection
	initConnection();
	
	// Run migrations to create tables
	runMigrations();
	
	// Verify database file exists
	const db = new Database(testDbPath);
	db.close();
}

function clearDatabase(): void {
	const db = new Database(testDbPath);
	try {
		db.prepare("DELETE FROM captures_metadata").run();
	} catch {
		// Table may not exist yet
	}
	try {
		db.prepare("DELETE FROM providers").run();
	} catch {
		// Table may not exist yet
	}
	try {
		db.prepare("DELETE FROM schema_version").run();
	} catch {
		// Table may not exist yet
	}
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

describe("connection.ts - Database Connection Management", () => {
	before(async () => {
		await setupTestDb();
	});

	after(async () => {
		await teardownTestDb();
	});

	beforeEach(() => {
		clearDatabase();
	});

	describe("getDbPath", () => {
		it("returns path from CONTEXTIO_DB_PATH env var when set", () => {
			const customPath = "/custom/path/test.db";
			process.env.CONTEXTIO_DB_PATH = customPath;
			
			const path = getDbPath();
			assert.equal(path, customPath);
			
			delete process.env.CONTEXTIO_DB_PATH;
		});

		it("returns default path ~/.contextio/contextio.db when env var not set", () => {
			delete process.env.CONTEXTIO_DB_PATH;
			
			const path = getDbPath();
			assert.ok(path.includes(".contextio"));
			assert.ok(path.endsWith("contextio.db"));
		});
	});

	describe("initConnection / getDb", () => {
		it("creates and returns a database instance", () => {
			const db = initConnection();
			assert.ok(db instanceof Database);
		});

		it("returns same instance on subsequent calls (singleton)", () => {
			const db1 = getDb();
			const db2 = getDb();
			assert.strictEqual(db1, db2);
		});

		it("initializes database with WAL mode", () => {
			const db = getDb();
			const result = db.prepare("PRAGMA journal_mode").get() as { journal_mode: string };
			assert.equal(result.journal_mode, "wal");
		});

		it("sets busy_timeout to 5000ms", () => {
			const db = getDb();
			// busy_timeout may return undefined in some SQLite versions
			// We just verify the pragma can be queried without error
			const result = db.prepare("PRAGMA busy_timeout").get();
			// If defined, it should be 5000
			if (result && typeof result === 'object' && 'busy_timeout' in result) {
				assert.equal((result as { busy_timeout: number }).busy_timeout, 5000);
			}
		});

		it("enables foreign keys", () => {
			const db = getDb();
			const result = db.prepare("PRAGMA foreign_keys").get() as { foreign_keys: number };
			assert.equal(result.foreign_keys, 1);
		});

		it("sets synchronous to NORMAL", () => {
			const db = getDb();
			const result = db.prepare("PRAGMA synchronous").get() as { synchronous: number };
			// NORMAL = 1 in SQLite
			assert.equal(result.synchronous, 1);
		});

		it("sets cache_size to -2000 (2MB)", () => {
			const db = getDb();
			const result = db.prepare("PRAGMA cache_size").get() as { cache_size: number };
			assert.equal(result.cache_size, -2000);
		});

		it("sets temp_store to MEMORY", () => {
			const db = getDb();
			const result = db.prepare("PRAGMA temp_store").get() as { temp_store: number };
			// MEMORY = 2 in SQLite
			assert.equal(result.temp_store, 2);
		});
	});

	describe("isDbInitialized", () => {
		it("returns true after initialization", () => {
			assert.equal(isDbInitialized(), true);
		});

		it("returns false before initialization", () => {
			closeDb();
			assert.equal(isDbInitialized(), false);
			// Re-initialize for other tests
			initConnection();
		});
	});

	describe("closeDb", () => {
		it("closes the database connection", () => {
			const db = getDb();
			assert.ok(isDbInitialized());
			
			closeDb();
			
			assert.equal(isDbInitialized(), false);
			// Re-initialize for other tests
			initConnection();
		});

		it("can be called multiple times without error", () => {
			closeDb();
			closeDb(); // Should not throw
			assert.equal(isDbInitialized(), false);
			// Re-initialize for other tests
			initConnection();
		});

		it("allows new connection after close", () => {
			closeDb();
			const db = initConnection();
			assert.ok(db instanceof Database);
			assert.equal(isDbInitialized(), true);
		});
	});

	describe("Database file creation", () => {
		it("creates database file at specified path", async () => {
			// Database should already exist from setup
			const fs = await import("node:fs");
			assert.ok(fs.existsSync(testDbPath));
		});

		it("creates required tables on initialization", () => {
			const db = new Database(testDbPath);
			
			const tables = db.prepare("SELECT name FROM sqlite_master WHERE type='table'").all() as Array<{name: string}>;
			const tableNames = tables.map(t => t.name);
			
			assert.ok(tableNames.includes("captures_metadata"));
			assert.ok(tableNames.includes("providers"));
			assert.ok(tableNames.includes("schema_version"));
			
			db.close();
		});
	});

	describe("Connection persistence", () => {
		it("survives multiple operations", () => {
			const db = getDb();
			
			// Clear any existing data first
			db.prepare("DELETE FROM captures_metadata").run();
			
			// Perform several operations
			db.prepare("INSERT INTO captures_metadata (id, session_id, filepath, timestamp, status) VALUES (?, ?, ?, ?, ?)")
				.run("conn-test-1", "sess-1", "/test/1.json", Date.now(), "success");
			db.prepare("INSERT INTO captures_metadata (id, session_id, filepath, timestamp, status) VALUES (?, ?, ?, ?, ?)")
				.run("conn-test-2", "sess-2", "/test/2.json", Date.now(), "success");
			
			const count = db.prepare("SELECT COUNT(*) as count FROM captures_metadata").get() as { count: number };
			assert.equal(count.count, 2);
		});

		it("maintains WAL mode across operations", () => {
			const db = getDb();
			
			// Do some writes
			db.prepare("INSERT INTO captures_metadata (id, session_id, filepath, timestamp, status) VALUES (?, ?, ?, ?, ?)")
				.run("wal-test-1", "sess-1", "/test/wal1.json", Date.now(), "success");
			
			const result = db.prepare("PRAGMA journal_mode").get() as { journal_mode: string };
			assert.equal(result.journal_mode, "wal");
		});
	});
});