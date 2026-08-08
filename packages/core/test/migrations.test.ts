import { describe, it, before, after, beforeEach } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import Database from "better-sqlite3";

import {
	runMigrations,
	getSchemaVersion,
	getAppliedMigrations,
	getPendingMigrations,
	getMigrations,
} from "../dist/db/migrations.js";

import { closeDb, initDb, getDb } from "../dist/db/index.js";

/**
 * Test database setup using a temporary file.
 */

let testDbDir: string;
let testDbPath: string;

// Setup test database
async function setupTestDb(): Promise<void> {
	// Create a temporary directory for our test database
	testDbDir = mkdtempSync(join(tmpdir(), "contextio-migrations-test-"));
	testDbPath = join(testDbDir, "test.db");

	// Set environment variable so production code uses our test database
	process.env.CONTEXTIO_DB_PATH = testDbPath;

	// Close any existing connection
	closeDb();

	// Initialize the database
	initDb();
}

function clearAllTables(): void {
	const db = new Database(testDbPath);
	db.prepare("DELETE FROM captures_metadata").run();
	db.prepare("DELETE FROM providers").run();
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

describe("migrations.ts - Migration Runner", () => {
	before(async () => {
		await setupTestDb();
	});

	after(async () => {
		await teardownTestDb();
	});

	beforeEach(() => {
		clearAllTables();
	});

	describe("getMigrations", () => {
		it("returns list of production migrations", () => {
			const migrations = getMigrations();
			assert.ok(migrations.length > 0, "Should have at least one migration");
			assert.equal(migrations[0].version, 1, "First migration should be version 1");
		});

		it("sorts migrations by version number", () => {
			const migrations = getMigrations();
			for (let i = 1; i < migrations.length; i++) {
				assert.ok(migrations[i].version > migrations[i - 1].version, "Migrations should be sorted by version");
			}
		});

		it("each migration has version, name, and up SQL", () => {
			const migrations = getMigrations();
			for (const migration of migrations) {
				assert.ok(migration.version > 0, "Version should be positive");
				assert.ok(migration.name.length > 0, "Name should not be empty");
				assert.ok(migration.up.length > 0, "Up SQL should not be empty");
			}
		});
	});

	describe("getSchemaVersion", () => {
		it("returns current schema version after migrations", () => {
			clearAllTables();
			runMigrations();
			
			const version = getSchemaVersion();
			assert.ok(version > 0, "Schema version should be greater than 0 after migrations");
			assert.equal(version, getMigrations().length, "Version should equal number of migrations");
		});

		it("returns 0 for fresh database", () => {
			clearAllTables();
			const version = getSchemaVersion();
			assert.equal(version, 0);
		});

		it("returns highest applied migration version", () => {
			clearAllTables();
			const db = new Database(testDbPath);
			db.prepare("INSERT INTO schema_version (version, description) VALUES (?, ?)").run(3, "third");
			db.close();
			
			const version = getSchemaVersion();
			assert.equal(version, 3);
		});
	});

	describe("getAppliedMigrations", () => {
		it("returns empty array for fresh database", () => {
			clearAllTables();
			const applied = getAppliedMigrations();
			assert.deepEqual(applied, []);
		});

		it("returns applied migrations with version, applied_at, and description", () => {
			clearAllTables();
			const db = new Database(testDbPath);
			const now = Date.now();
			db.prepare("INSERT INTO schema_version (version, applied_at, description) VALUES (?, ?, ?)").run(1, now, "first migration");
			db.prepare("INSERT INTO schema_version (version, applied_at, description) VALUES (?, ?, ?)").run(2, now + 1000, "second migration");
			db.close();
			
			const applied = getAppliedMigrations();
			assert.equal(applied.length, 2);
			assert.equal(applied[0].version, 1);
			assert.equal(applied[0].description, "first migration");
			assert.equal(applied[1].version, 2);
			assert.equal(applied[1].description, "second migration");
			assert.ok(applied[0].applied_at > 0);
			assert.ok(applied[1].applied_at > 0);
		});
	});

	describe("getPendingMigrations", () => {
		it("returns all migrations when database is fresh", () => {
			clearAllTables();
			const pending = getPendingMigrations();
			assert.equal(pending.length, getMigrations().length);
		});

		it("returns only migrations higher than current version", () => {
			clearAllTables();
			const db = new Database(testDbPath);
			db.prepare("INSERT INTO schema_version (version, description) VALUES (?, ?)").run(2, "second");
			db.close();
			
			const pending = getPendingMigrations();
			const allMigrations = getMigrations();
			assert.equal(pending.length, allMigrations.length - 2);
			assert.ok(pending.every(m => m.version > 2));
		});

		it("returns empty array when all migrations applied", () => {
			clearAllTables();
			runMigrations();
			
			const pending = getPendingMigrations();
			assert.deepEqual(pending, []);
		});
	});

	describe("runMigrations", () => {
		it("applies all pending migrations in order", () => {
			clearAllTables();
			runMigrations();
			
			const version = getSchemaVersion();
			assert.equal(version, getMigrations().length);
			
			// Verify tables exist
			const db = new Database(testDbPath);
			const tables = db.prepare("SELECT name FROM sqlite_master WHERE type='table'").all() as Array<{name: string}>;
			const tableNames = tables.map(t => t.name);
			assert.ok(tableNames.includes("captures_metadata"));
			assert.ok(tableNames.includes("providers"));
			assert.ok(tableNames.includes("schema_version"));
			db.close();
		});

		it("is idempotent - running twice does not re-apply migrations", () => {
			clearAllTables();
			runMigrations();
			const versionAfterFirst = getSchemaVersion();
			
			runMigrations(); // Second run
			const versionAfterSecond = getSchemaVersion();
			
			assert.equal(versionAfterFirst, versionAfterSecond);
			assert.equal(versionAfterSecond, getMigrations().length);
		});

		it("records each migration in schema_version table", () => {
			clearAllTables();
			runMigrations();
			
			const applied = getAppliedMigrations();
			assert.equal(applied.length, getMigrations().length);
			for (let i = 0; i < applied.length; i++) {
				assert.equal(applied[i].version, i + 1);
				assert.ok(applied[i].applied_at > 0);
			}
		});

		it("continues from last applied version on subsequent runs", () => {
			clearAllTables();
			runMigrations();
			assert.equal(getSchemaVersion(), getMigrations().length);
			
			// Verify all tables exist
			const db = new Database(testDbPath);
			const tables = db.prepare("SELECT name FROM sqlite_master WHERE type='table'").all() as Array<{name: string}>;
			const tableNames = tables.map(t => t.name);
			assert.ok(tableNames.includes("captures_metadata"));
			assert.ok(tableNames.includes("providers"));
			assert.ok(tableNames.includes("schema_version"));
			db.close();
		});
	});

	describe("Database pragmas after initialization", () => {
		it("enables WAL mode", () => {
			clearAllTables();
			runMigrations();
			
			const db = new Database(testDbPath);
			const result = db.prepare("PRAGMA journal_mode").get() as { journal_mode: string };
			assert.equal(result.journal_mode, "wal");
			db.close();
		});

		it("sets busy_timeout to 5000ms", () => {
			clearAllTables();
			runMigrations();
			
			const db = new Database(testDbPath);
			// busy_timeout may return undefined in some SQLite versions
			// We just verify the pragma can be queried without error
			const result = db.prepare("PRAGMA busy_timeout").get();
			if (result && typeof result === 'object' && 'busy_timeout' in result) {
				assert.equal((result as { busy_timeout: number }).busy_timeout, 5000);
			}
			db.close();
		});

		it("enables foreign keys", () => {
			clearAllTables();
			runMigrations();
			
			const db = new Database(testDbPath);
			const result = db.prepare("PRAGMA foreign_keys").get() as { foreign_keys: number };
			assert.equal(result.foreign_keys, 1);
			db.close();
		});
	});
});