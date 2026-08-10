import { describe, it, before, after } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import Database from "better-sqlite3";

import {
	upsertRedactionMetadata,
	upsertRedactionMetadataBulk,
	getRedactionMetadataByCaptureId,
	getRedactionMetadataBySessionId,
	aggregateRedactionMetadataBySession,
	deleteRedactionMetadataByCaptureId,
	getRedactionAggregateStats,
	type RedactionMetadata,
	type RedactionMatch,
	type SessionRedactionAggregate,
} from "../dist/db/index.js";

import { closeDb, initDb } from "../dist/db/index.js";

/**
 * Test database setup using a temporary file.
 * This ensures the production code uses our test database.
 */

let testDbDir: string;
let testDbPath: string;

function getTestDbPath(): string {
	return testDbPath;
}

// Setup test database
async function setupTestDb(): Promise<void> {
	// Create a temporary directory for our test database
	testDbDir = mkdtempSync(join(tmpdir(), "contextio-redaction-test-"));
	testDbPath = join(testDbDir, "test.db");

	// Set environment variable so production code uses our test database
	process.env.CONTEXTIO_DB_PATH = testDbPath;

	// Close any existing connection
	closeDb();

	// Initialize the database (runs migrations)
	initDb();

	// Verify redaction_metadata table exists and has matches column
	const db = new Database(testDbPath);
	const schema = db.prepare("PRAGMA table_info(redaction_metadata)").all() as Array<{ name: string; notnull: number }>;
	const matchesCol = schema.find(c => c.name === 'matches');
	if (!matchesCol) {
		db.close();
		throw new Error("redaction_metadata table missing 'matches' column - migration 009 not applied!");
	}

	// Drop the trigger that overrides updated_at with second-precision timestamp
	// We manage timestamps in application code with millisecond precision
	db.prepare("DROP TRIGGER IF EXISTS trg_redaction_metadata_updated_at").run();
	db.close();
}

function clearRedactionTable(): void {
	const db = new Database(testDbPath);
	db.prepare("DELETE FROM redaction_metadata").run();
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

function createRedactionMetadata(overrides: Partial<RedactionMetadata> = {}): RedactionMetadata {
	const uniqueId = `${Date.now()}-${Math.random().toString(36).slice(2, 9)}`;
	const base: RedactionMetadata = {
		captureId: `capture-${uniqueId}`,
		sessionId: "session-123",
		ruleCounts: { email: 2, api_key: 1 },
		totalRedactions: 3,
		encrypted: false,
		createdAt: Date.now(),
		updatedAt: Date.now(),
		source: "test-proxy",
		provider: "anthropic",
		targetUrl: "https://api.anthropic.com/v1/messages",
		requestBytes: 1024,
		responseBytes: 2048,
		timings: { send_ms: 10, wait_ms: 500, receive_ms: 50, total_ms: 560 },
		totalInputTokens: 100,
		totalOutputTokens: 200,
		tokensPerSecond: 357.14,
		successCount: 1,
		errorCount: 0,
		model: "claude-3-opus",
		matches: [
			{ ruleId: "email", preValue: "john@example.com", postValue: "[EMAIL_REDACTED]", path: "requestBody.messages[0].content" },
			{ ruleId: "email", preValue: "jane@example.com", postValue: "[EMAIL_REDACTED]", path: "requestBody.messages[1].content" },
			{ ruleId: "api_key", preValue: "sk-abc123", postValue: "[API_KEY_REDACTED]", path: "requestBody.api_key" },
		],
	};
	return { ...base, ...overrides };
}

describe("redaction-repo.ts", () => {
	before(async () => {
		await setupTestDb();
	});

	after(async () => {
		await teardownTestDb();
	});

	describe("upsertRedactionMetadata", () => {
		it("inserts new redaction metadata", () => {
			clearRedactionTable();
			const meta = createRedactionMetadata();

			upsertRedactionMetadata(meta);

			const retrieved = getRedactionMetadataByCaptureId(meta.captureId);
			assert.ok(retrieved, "Metadata should be retrievable");
			assert.equal(retrieved!.captureId, meta.captureId);
			assert.equal(retrieved!.sessionId, meta.sessionId);
			assert.deepEqual(retrieved!.ruleCounts, meta.ruleCounts);
			assert.equal(retrieved!.totalRedactions, meta.totalRedactions);
			assert.equal(retrieved!.encrypted, meta.encrypted);
			assert.equal(retrieved!.source, meta.source);
			assert.equal(retrieved!.provider, meta.provider);
			assert.equal(retrieved!.targetUrl, meta.targetUrl);
			assert.equal(retrieved!.requestBytes, meta.requestBytes);
			assert.equal(retrieved!.responseBytes, meta.responseBytes);
			assert.deepEqual(retrieved!.timings, meta.timings);
			assert.equal(retrieved!.totalInputTokens, meta.totalInputTokens);
			assert.equal(retrieved!.totalOutputTokens, meta.totalOutputTokens);
			assert.equal(retrieved!.tokensPerSecond, meta.tokensPerSecond);
			assert.equal(retrieved!.successCount, meta.successCount);
			assert.equal(retrieved!.errorCount, meta.errorCount);
			assert.equal(retrieved!.model, meta.model);
			assert.deepEqual(retrieved!.matches, meta.matches);
		});

		it("updates existing redaction metadata", () => {
			clearRedactionTable();
			const meta = createRedactionMetadata();
			upsertRedactionMetadata(meta);

			// Update with new values
			const updatedMeta = {
				...meta,
				totalRedactions: 5,
				ruleCounts: { email: 3, api_key: 2 },
			};
			upsertRedactionMetadata(updatedMeta);

			const retrieved = getRedactionMetadataByCaptureId(meta.captureId);
			assert.equal(retrieved!.totalRedactions, 5);
			assert.deepEqual(retrieved!.ruleCounts, { email: 3, api_key: 2 });
			// updatedAt should be >= original createdAt (database sets its own timestamp on update)
			assert.ok(retrieved!.updatedAt >= retrieved!.createdAt, "updatedAt should be >= createdAt");
		});

		it("handles missing optional fields", () => {
			clearRedactionTable();
			const minimalMeta: RedactionMetadata = {
				captureId: "capture-minimal",
				sessionId: "session-min",
				ruleCounts: { ssn: 1 },
				totalRedactions: 1,
				encrypted: false,
				createdAt: Date.now(),
				updatedAt: Date.now(),
			};

			upsertRedactionMetadata(minimalMeta);

			const retrieved = getRedactionMetadataByCaptureId("capture-minimal");
			assert.ok(retrieved);
			assert.equal(retrieved!.sessionId, "session-min");
			assert.deepEqual(retrieved!.ruleCounts, { ssn: 1 });
			assert.equal(retrieved!.source, null);
			assert.equal(retrieved!.provider, null);
			assert.equal(retrieved!.targetUrl, null);
			assert.equal(retrieved!.matches, undefined);
		});

		it("handles null matches field", () => {
			clearRedactionTable();
			const meta = createRedactionMetadata({ matches: undefined });

			upsertRedactionMetadata(meta);

			const retrieved = getRedactionMetadataByCaptureId(meta.captureId);
			assert.ok(retrieved);
			assert.equal(retrieved!.matches, undefined);
		});
	});

	describe("upsertRedactionMetadataBulk", () => {
		it("inserts multiple metadata entries in a transaction", () => {
			clearRedactionTable();
			const metas = [
				createRedactionMetadata({ captureId: "bulk-1", sessionId: "session-bulk", totalRedactions: 1 }),
				createRedactionMetadata({ captureId: "bulk-2", sessionId: "session-bulk", totalRedactions: 2 }),
				createRedactionMetadata({ captureId: "bulk-3", sessionId: "session-bulk", totalRedactions: 3 }),
			];

			upsertRedactionMetadataBulk(metas);

			for (const meta of metas) {
				const retrieved = getRedactionMetadataByCaptureId(meta.captureId);
				assert.ok(retrieved, `Metadata for ${meta.captureId} should be retrievable`);
				assert.equal(retrieved!.totalRedactions, meta.totalRedactions);
			}
		});

		it("handles empty array", () => {
			clearRedactionTable();
			// Should not throw
			upsertRedactionMetadataBulk([]);
			const stats = getRedactionAggregateStats();
			assert.equal(stats.totalCaptures, 0);
		});
	});

	describe("getRedactionMetadataByCaptureId", () => {
		it("returns null for non-existent capture", () => {
			clearRedactionTable();
			const result = getRedactionMetadataByCaptureId("non-existent");
			assert.equal(result, null);
		});
	});

	describe("getRedactionMetadataBySessionId", () => {
		it("returns all metadata for a session", () => {
			clearRedactionTable();
			const sessionId = "test-session-456";
			const metas = [
				createRedactionMetadata({ captureId: "sess-cap-1", sessionId, totalRedactions: 2 }),
				createRedactionMetadata({ captureId: "sess-cap-2", sessionId, totalRedactions: 3 }),
			];
			for (const meta of metas) {
				upsertRedactionMetadata(meta);
			}

			const results = getRedactionMetadataBySessionId(sessionId);
			assert.equal(results.length, 2);
			assert.ok(results.every(r => r.sessionId === sessionId));
		});

		it("returns empty array for non-existent session", () => {
			clearRedactionTable();
			const results = getRedactionMetadataBySessionId("non-existent-session");
			assert.deepEqual(results, []);
		});
	});

	describe("aggregateRedactionMetadataBySession", () => {
		it("aggregates redaction counts by rule for a session", () => {
			clearRedactionTable();
			const sessionId = "agg-session-1";
			const metas = [
				createRedactionMetadata({ captureId: "agg-1", sessionId, ruleCounts: { email: 2, api_key: 1 }, totalRedactions: 3 }),
				createRedactionMetadata({ captureId: "agg-2", sessionId, ruleCounts: { email: 1, ssn: 2 }, totalRedactions: 3 }),
			];
			for (const meta of metas) {
				upsertRedactionMetadata(meta);
			}

			const aggregate = aggregateRedactionMetadataBySession(sessionId);
			assert.equal(aggregate.sessionId, sessionId);
			assert.equal(aggregate.totalCaptures, 2);
			assert.equal(aggregate.totalRedactions, 6);
			assert.deepEqual(aggregate.byRule, { email: 3, api_key: 1, ssn: 2 });
		});

		it("handles session with no captures", () => {
			clearRedactionTable();
			const aggregate = aggregateRedactionMetadataBySession("empty-session");
			assert.equal(aggregate.sessionId, "empty-session");
			assert.equal(aggregate.totalCaptures, 0);
			assert.equal(aggregate.totalRedactions, 0);
			assert.deepEqual(aggregate.byRule, {});
		});
	});

	describe("deleteRedactionMetadataByCaptureId", () => {
		it("deletes metadata for a capture", () => {
			clearRedactionTable();
			const meta = createRedactionMetadata();
			upsertRedactionMetadata(meta);

			deleteRedactionMetadataByCaptureId(meta.captureId);

			const result = getRedactionMetadataByCaptureId(meta.captureId);
			assert.equal(result, null);
		});
	});

	describe("getRedactionAggregateStats", () => {
		it("returns aggregate stats across all captures", () => {
			clearRedactionTable();
			const metas = [
				createRedactionMetadata({ captureId: "stats-1", sessionId: "s1", ruleCounts: { email: 2 }, totalRedactions: 2 }),
				createRedactionMetadata({ captureId: "stats-2", sessionId: "s2", ruleCounts: { api_key: 3 }, totalRedactions: 3 }),
			];
			for (const meta of metas) {
				upsertRedactionMetadata(meta);
			}

			const stats = getRedactionAggregateStats();
			assert.equal(stats.totalCaptures, 2);
			assert.equal(stats.totalRedactions, 5);
			assert.deepEqual(stats.byRule, { email: 2, api_key: 3 });
		});
	});

	describe("matches field integrity", () => {
		it("stores and retrieves complex match objects", () => {
			clearRedactionTable();
			const complexMatches: RedactionMatch[] = [
				{ ruleId: "email", preValue: "test@domain.com", postValue: "[EMAIL_REDACTED]", path: "body.user.email" },
				{ ruleId: "phone", preValue: "555-123-4567", postValue: "[PHONE_REDACTED]", path: "body.user.phone" },
				{ ruleId: "credit_card", preValue: "4111-1111-1111-1111", postValue: "[CREDIT_CARD_REDACTED]", path: "body.payment.card" },
			];
			const meta = createRedactionMetadata({ matches: complexMatches });

			upsertRedactionMetadata(meta);

			const retrieved = getRedactionMetadataByCaptureId(meta.captureId)!;
			assert.deepEqual(retrieved.matches, complexMatches);
		});

		it("handles empty matches array", () => {
			clearRedactionTable();
			const meta = createRedactionMetadata({ matches: [] });

			upsertRedactionMetadata(meta);

			const retrieved = getRedactionMetadataByCaptureId(meta.captureId)!;
			assert.deepEqual(retrieved.matches, []);
		});
	});
});