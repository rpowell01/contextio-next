import { describe, it, before, after } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import Database from "better-sqlite3";

import {
  upsertCapture,
  upsertCaptures,
  getCaptureById,
  getCapturesBySession,
  getRecentCaptures,
  getCapturesByDateRange,
  deleteCapture,
  getCaptureCount,
  getStats,
  searchCaptures,
  type CaptureMetadata,
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
  testDbDir = mkdtempSync(join(tmpdir(), "contextio-test-"));
  testDbPath = join(testDbDir, "test.db");
  
  // Set environment variable so production code uses our test database
  process.env.CONTEXTIO_DB_PATH = testDbPath;
  
  // Close any existing connection
  closeDb();
  
  // Initialize the database (runs migrations)
  initDb();
  
  // Verify schema allows NULL session_id
  const db = new Database(testDbPath);
  const schema = db.prepare("PRAGMA table_info(captures_metadata)").all() as Array<{name: string, notnull: number}>;
  const sessionIdCol = schema.find(c => c.name === 'session_id');
  if (sessionIdCol && sessionIdCol.notnull === 1) {
    db.close();
    throw new Error("session_id column has NOT NULL constraint - schema not applied correctly!");
  }
  db.close();
}

function clearCapturesTable(): void {
  const db = new Database(testDbPath);
  db.prepare("DELETE FROM captures_metadata").run();
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

function createCaptureMetadata(overrides: Partial<CaptureMetadata> = {}): CaptureMetadata {
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

describe("capture-repo.ts", () => {
  before(async () => {
    await setupTestDb();
  });

  after(async () => {
    await teardownTestDb();
  });

  // Helper to run a test with a clean database
  function testWithCleanDb(name: string, fn: () => void | Promise<void>): void {
    it(name, () => {
      clearCapturesTable();
      return fn();
    });
  }

  describe("upsertCapture / upsertCaptures", () => {
    testWithCleanDb("inserts a new capture", () => {
      const capture = createCaptureMetadata({ id: "test-insert-1" });
      upsertCapture(capture);
      
      const result = getCaptureById("test-insert-1");
      assert.ok(result !== null, "Capture should be found");
      assert.equal(result!.id, "test-insert-1");
      assert.equal(result!.sessionId, "session-123");
      assert.equal(result!.filepath, capture.filepath);
      assert.equal(result!.requestModel, "gpt-4");
      assert.equal(result!.responseModel, "gpt-4");
      assert.equal(result!.tokensPrompt, 100);
      assert.equal(result!.tokensCompletion, 200);
      assert.equal(result!.durationMs, 1500);
      assert.equal(result!.status, "success");
    });

    testWithCleanDb("updates an existing capture on conflict (upsert)", () => {
      const capture = createCaptureMetadata({ id: "test-upsert-1", status: "success" });
      upsertCapture(capture);
      
      // Update with new values
      const updated = { ...capture, status: "error", tokensPrompt: 50, tokensCompletion: 75 };
      upsertCapture(updated);
      
      const result = getCaptureById("test-upsert-1");
      assert.ok(result !== null);
      assert.equal(result!.status, "error");
      assert.equal(result!.tokensPrompt, 50);
      assert.equal(result!.tokensCompletion, 75);
    });

    testWithCleanDb("handles null/undefined sessionId correctly (nullable column)", () => {
      const capture = createCaptureMetadata({ 
        id: "test-null-session", 
        sessionId: null 
      });
      upsertCapture(capture);
      
      const result = getCaptureById("test-null-session");
      assert.ok(result !== null);
      // null in DB becomes undefined in CaptureMetadata (rowToCaptureMetadata uses ?? undefined)
      assert.equal(result!.sessionId, undefined);
    });

    testWithCleanDb("handles undefined sessionId correctly", () => {
      const capture = createCaptureMetadata({ 
        id: "test-undefined-session", 
        sessionId: undefined 
      });
      upsertCapture(capture);
      
      const result = getCaptureById("test-undefined-session");
      assert.ok(result !== null);
      // undefined -> stored as null in DB -> read back as undefined
      assert.equal(result!.sessionId, undefined);
    });

    testWithCleanDb("bulk inserts multiple captures with upsertCaptures", () => {
      const captures = [
        createCaptureMetadata({ id: "bulk-1", sessionId: "session-a" }),
        createCaptureMetadata({ id: "bulk-2", sessionId: "session-a" }),
        createCaptureMetadata({ id: "bulk-3", sessionId: "session-b" }),
      ];
      
      upsertCaptures(captures);
      
      const result1 = getCaptureById("bulk-1");
      const result2 = getCaptureById("bulk-2");
      const result3 = getCaptureById("bulk-3");
      
      assert.ok(result1 !== null);
      assert.ok(result2 !== null);
      assert.ok(result3 !== null);
      assert.equal(result1!.sessionId, "session-a");
      assert.equal(result2!.sessionId, "session-a");
      assert.equal(result3!.sessionId, "session-b");
    });

    testWithCleanDb("handles empty array in upsertCaptures", () => {
      // Should not throw
      upsertCaptures([]);
      assert.equal(getCaptureCount(), 0);
    });

    testWithCleanDb("upsertCaptures updates existing captures in bulk", () => {
      const captures = [
        createCaptureMetadata({ id: "bulk-update-1", status: "success" }),
        createCaptureMetadata({ id: "bulk-update-2", status: "success" }),
      ];
      upsertCaptures(captures);
      
      const updated = [
        { ...captures[0], status: "error" },
        { ...captures[1], status: "streaming" },
      ];
      upsertCaptures(updated);
      
      const result1 = getCaptureById("bulk-update-1");
      const result2 = getCaptureById("bulk-update-2");
      
      assert.equal(result1!.status, "error");
      assert.equal(result2!.status, "streaming");
    });
  });

  describe("getCaptureById", () => {
    testWithCleanDb("returns capture when found", () => {
      const capture = createCaptureMetadata({ id: "get-by-id-1" });
      upsertCapture(capture);
      
      const result = getCaptureById("get-by-id-1");
      assert.ok(result !== null);
      assert.equal(result!.id, "get-by-id-1");
    });

    testWithCleanDb("returns null when not found", () => {
      const result = getCaptureById("non-existent-id");
      assert.equal(result, null);
    });
  });

  describe("getCapturesBySession", () => {
    testWithCleanDb("returns captures for a session ordered by timestamp ascending", () => {
      const baseTime = Date.now();
      const captures = [
        createCaptureMetadata({ id: "session-order-1", sessionId: "session-order", timestamp: baseTime + 3000 }),
        createCaptureMetadata({ id: "session-order-2", sessionId: "session-order", timestamp: baseTime + 1000 }),
        createCaptureMetadata({ id: "session-order-3", sessionId: "session-order", timestamp: baseTime + 2000 }),
      ];
      upsertCaptures(captures);
      
      const results = getCapturesBySession("session-order");
      assert.equal(results.length, 3);
      assert.equal(results[0].id, "session-order-2"); // earliest first
      assert.equal(results[1].id, "session-order-3");
      assert.equal(results[2].id, "session-order-1"); // latest last
    });

    testWithCleanDb("returns empty array for session with no captures", () => {
      const results = getCapturesBySession("non-existent-session");
      assert.deepEqual(results, []);
    });

    testWithCleanDb("returns empty array for null sessionId", () => {
      const results = getCapturesBySession(null as any);
      assert.deepEqual(results, []);
    });
  });

  describe("getRecentCaptures", () => {
    testWithCleanDb("returns captures ordered by timestamp descending (newest first)", () => {
      const baseTime = Date.now();
      const captures = [
        createCaptureMetadata({ id: "recent-1", timestamp: baseTime + 1000 }),
        createCaptureMetadata({ id: "recent-2", timestamp: baseTime + 3000 }),
        createCaptureMetadata({ id: "recent-3", timestamp: baseTime + 2000 }),
      ];
      upsertCaptures(captures);
      
      const results = getRecentCaptures(10);
      assert.equal(results.length, 3);
      assert.equal(results[0].id, "recent-2"); // newest first
      assert.equal(results[1].id, "recent-3");
      assert.equal(results[2].id, "recent-1"); // oldest last
    });

    testWithCleanDb("respects limit parameter", () => {
      const baseTime = Date.now();
      const captures = [
        createCaptureMetadata({ id: "limit-1", timestamp: baseTime + 1000 }),
        createCaptureMetadata({ id: "limit-2", timestamp: baseTime + 2000 }),
        createCaptureMetadata({ id: "limit-3", timestamp: baseTime + 3000 }),
      ];
      upsertCaptures(captures);
      
      const results = getRecentCaptures(2);
      assert.equal(results.length, 2);
      assert.equal(results[0].id, "limit-3");
      assert.equal(results[1].id, "limit-2");
    });

    testWithCleanDb("respects offset parameter", () => {
      const baseTime = Date.now();
      const captures = [
        createCaptureMetadata({ id: "offset-1", timestamp: baseTime + 1000 }),
        createCaptureMetadata({ id: "offset-2", timestamp: baseTime + 2000 }),
        createCaptureMetadata({ id: "offset-3", timestamp: baseTime + 3000 }),
      ];
      upsertCaptures(captures);
      
      const results = getRecentCaptures(2, 1); // limit 2, offset 1
      assert.equal(results.length, 2);
      assert.equal(results[0].id, "offset-2");
      assert.equal(results[1].id, "offset-1");
    });

    testWithCleanDb("returns empty array when no captures exist", () => {
      const results = getRecentCaptures(10);
      assert.deepEqual(results, []);
    });
  });

  describe("getCapturesByDateRange", () => {
    testWithCleanDb("returns captures within inclusive date range ordered by timestamp ascending", () => {
      const baseTime = Date.now();
      const captures = [
        createCaptureMetadata({ id: "range-1", timestamp: baseTime - 10000 }), // before range
        createCaptureMetadata({ id: "range-2", timestamp: baseTime }),         // start of range
        createCaptureMetadata({ id: "range-3", timestamp: baseTime + 5000 }),  // in range
        createCaptureMetadata({ id: "range-4", timestamp: baseTime + 10000 }), // end of range
        createCaptureMetadata({ id: "range-5", timestamp: baseTime + 15000 }), // after range
      ];
      upsertCaptures(captures);
      
      const results = getCapturesByDateRange(baseTime, baseTime + 10000);
      assert.equal(results.length, 3);
      assert.equal(results[0].id, "range-2");
      assert.equal(results[1].id, "range-3");
      assert.equal(results[2].id, "range-4");
    });

    testWithCleanDb("returns empty array when no captures in range", () => {
      const results = getCapturesByDateRange(Date.now() + 100000, Date.now() + 200000);
      assert.deepEqual(results, []);
    });

    testWithCleanDb("handles single timestamp range (start === end)", () => {
      const timestamp = Date.now();
      const capture = createCaptureMetadata({ id: "single-time", timestamp });
      upsertCapture(capture);
      
      const results = getCapturesByDateRange(timestamp, timestamp);
      assert.equal(results.length, 1);
      assert.equal(results[0].id, "single-time");
    });
  });

  describe("deleteCapture", () => {
    testWithCleanDb("deletes an existing capture", () => {
      const capture = createCaptureMetadata({ id: "delete-1" });
      upsertCapture(capture);
      
      assert.ok(getCaptureById("delete-1") !== null);
      
      deleteCapture("delete-1");
      
      assert.equal(getCaptureById("delete-1"), null);
    });

    testWithCleanDb("throws error when capture not found", () => {
      assert.throws(
        () => deleteCapture("non-existent-id"),
        /Capture with id "non-existent-id" not found/
      );
    });
  });

  describe("getCaptureCount", () => {
    testWithCleanDb("returns 0 for empty database", () => {
      const initialCount = getCaptureCount();
      assert.equal(initialCount, 0);
    });

    testWithCleanDb("returns correct count after inserts", () => {
      const captures = [
        createCaptureMetadata({ id: "count-1" }),
        createCaptureMetadata({ id: "count-2" }),
        createCaptureMetadata({ id: "count-3" }),
      ];
      upsertCaptures(captures);
      
      assert.equal(getCaptureCount(), 3);
    });
  });

  describe("getStats", () => {
    testWithCleanDb("returns correct stats for empty table", () => {
      const stats = getStats();
      assert.equal(stats.totalCaptures, 0);
      assert.equal(stats.totalSessions, 0);
      assert.equal(stats.dateRange.earliest, 0);
      assert.equal(stats.dateRange.latest, 0);
    });

    testWithCleanDb("returns correct stats with data", () => {
      const baseTime = Date.now();
      const captures = [
        createCaptureMetadata({ id: "stats-1", sessionId: "sess-1", timestamp: baseTime }),
        createCaptureMetadata({ id: "stats-2", sessionId: "sess-1", timestamp: baseTime + 1000 }),
        createCaptureMetadata({ id: "stats-3", sessionId: "sess-2", timestamp: baseTime + 2000 }),
      ];
      upsertCaptures(captures);
      
      const stats = getStats();
      assert.equal(stats.totalCaptures, 3);
      assert.equal(stats.totalSessions, 2);
      assert.equal(stats.dateRange.earliest, baseTime);
      assert.equal(stats.dateRange.latest, baseTime + 2000);
    });

    testWithCleanDb("handles null session_id in session count", () => {
      const baseTime = Date.now();
      const captures = [
        createCaptureMetadata({ id: "stats-null-1", sessionId: null, timestamp: baseTime }),
        createCaptureMetadata({ id: "stats-null-2", sessionId: "sess-1", timestamp: baseTime + 1000 }),
      ];
      upsertCaptures(captures);
      
      const stats = getStats();
      // COUNT(DISTINCT session_id) in SQLite does NOT count NULL values
      // So only "sess-1" is counted = 1 session
      assert.equal(stats.totalSessions, 1);
    });
  });

  function setupSearchData(baseTime: number) {
    const captures = [
      createCaptureMetadata({ 
        id: "search-1", 
        sessionId: "session-a", 
        requestModel: "gpt-4", 
        responseModel: "gpt-4",
        status: "success",
        timestamp: baseTime 
      }),
      createCaptureMetadata({ 
        id: "search-2", 
        sessionId: "session-a", 
        requestModel: "gpt-3.5-turbo", 
        responseModel: "gpt-3.5-turbo",
        status: "success",
        timestamp: baseTime + 1000 
      }),
      createCaptureMetadata({ 
        id: "search-3", 
        sessionId: "session-b", 
        requestModel: "gpt-4", 
        responseModel: "gpt-4",
        status: "error",
        timestamp: baseTime + 2000 
      }),
      createCaptureMetadata({ 
        id: "search-4", 
        sessionId: "session-b", 
        requestModel: "claude-3", 
        responseModel: "claude-3",
        status: "streaming",
        timestamp: baseTime + 3000 
      }),
      createCaptureMetadata({ 
        id: "search-5", 
        sessionId: null, 
        requestModel: "gpt-4", 
        responseModel: "gpt-4",
        status: "success",
        timestamp: baseTime + 4000 
      }),
    ];
    upsertCaptures(captures);
  }

  describe("searchCaptures", () => {
    testWithCleanDb("filters by sessionId", () => {
      const baseTime = Date.now();
      setupSearchData(baseTime);
      
      const results = searchCaptures({ sessionId: "session-a" });
      assert.equal(results.length, 2);
      assert.ok(results.every(r => r.sessionId === "session-a"));
    });

    testWithCleanDb("filters by model (request_model OR response_model)", () => {
      const baseTime = Date.now();
      setupSearchData(baseTime);
      
      const results = searchCaptures({ model: "gpt-4" });
      // search-1, search-3, search-5 have gpt-4 = 3 total
      assert.equal(results.length, 3);
      assert.ok(results.every(r => r.requestModel === "gpt-4" || r.responseModel === "gpt-4"));
    });

    testWithCleanDb("filters by status", () => {
      const baseTime = Date.now();
      setupSearchData(baseTime);
      
      const results = searchCaptures({ status: "error" });
      assert.equal(results.length, 1);
      assert.equal(results[0].id, "search-3");
    });

    testWithCleanDb("filters by startDate (inclusive)", () => {
      const baseTime = Date.now();
      setupSearchData(baseTime);
      
      const results = searchCaptures({ startDate: baseTime + 1500 });
      assert.equal(results.length, 3); // search-3, search-4, search-5
      assert.ok(results.every(r => r.timestamp >= baseTime + 1500));
    });

    testWithCleanDb("filters by endDate (inclusive)", () => {
      const baseTime = Date.now();
      setupSearchData(baseTime);
      
      const results = searchCaptures({ endDate: baseTime + 1500 });
      assert.equal(results.length, 2); // search-1, search-2
      assert.ok(results.every(r => r.timestamp <= baseTime + 1500));
    });

    testWithCleanDb("filters by date range", () => {
      const baseTime = Date.now();
      setupSearchData(baseTime);
      
      const results = searchCaptures({ 
        startDate: baseTime + 500, 
        endDate: baseTime + 2500 
      });
      assert.equal(results.length, 2); // search-2, search-3
      assert.ok(results.every(r => r.timestamp >= baseTime + 500 && r.timestamp <= baseTime + 2500));
    });

    testWithCleanDb("combines multiple filters", () => {
      const baseTime = Date.now();
      setupSearchData(baseTime);
      
      const results = searchCaptures({ 
        sessionId: "session-a",
        model: "gpt-4",
        status: "success"
      });
      assert.equal(results.length, 1);
      assert.equal(results[0].id, "search-1");
    });

    testWithCleanDb("respects limit parameter", () => {
      const baseTime = Date.now();
      setupSearchData(baseTime);
      
      const results = searchCaptures({ limit: 2 });
      assert.equal(results.length, 2);
    });

    testWithCleanDb("respects offset parameter", () => {
      const baseTime = Date.now();
      setupSearchData(baseTime);
      
      const results1 = searchCaptures({ limit: 2, offset: 0 });
      const results2 = searchCaptures({ limit: 2, offset: 2 });
      assert.equal(results1.length, 2);
      assert.equal(results2.length, 2);
      // Should be different results
      assert.notEqual(results1[0].id, results2[0].id);
    });

    testWithCleanDb("handles offset without limit (uses LIMIT -1)", () => {
      const baseTime = Date.now();
      setupSearchData(baseTime);
      
      const results = searchCaptures({ offset: 2 });
      assert.equal(results.length, 3); // 5 total - 2 offset = 3
    });

    testWithCleanDb("orders by timestamp descending by default", () => {
      const baseTime = Date.now();
      setupSearchData(baseTime);
      
      const results = searchCaptures({});
      assert.ok(results.length > 0);
      for (let i = 1; i < results.length; i++) {
        assert.ok(results[i-1].timestamp >= results[i].timestamp);
      }
    });

    testWithCleanDb("returns empty array when no matches", () => {
      const baseTime = Date.now();
      setupSearchData(baseTime);
      
      const results = searchCaptures({ sessionId: "non-existent" });
      assert.deepEqual(results, []);
    });
  });

  describe("Type conversion: rowToCaptureMetadata / captureMetadataToRow", () => {
    testWithCleanDb("converts null session_id to undefined", () => {
      const capture = createCaptureMetadata({ id: "type-null-1", sessionId: null });
      upsertCapture(capture);
      
      const result = getCaptureById("type-null-1");
      assert.ok(result !== null);
      // null in DB becomes undefined in CaptureMetadata (rowToCaptureMetadata uses ?? undefined)
      assert.equal(result!.sessionId, undefined);
    });

    testWithCleanDb("converts undefined sessionId to null in database", () => {
      const capture = createCaptureMetadata({ id: "type-undef-1", sessionId: undefined });
      upsertCapture(capture);
      
      const result = getCaptureById("type-undef-1");
      assert.ok(result !== null);
      // undefined -> stored as null in DB -> read back as undefined
      assert.equal(result!.sessionId, undefined);
    });

    testWithCleanDb("preserves all optional fields when null", () => {
      const capture = createCaptureMetadata({ 
        id: "type-optional-1",
        requestModel: null,
        responseModel: null,
        tokensPrompt: null,
        tokensCompletion: null,
        durationMs: null,
      });
      upsertCapture(capture);
      
      const result = getCaptureById("type-optional-1");
      assert.ok(result !== null);
      // null in DB becomes undefined in CaptureMetadata
      assert.equal(result!.requestModel, undefined);
      assert.equal(result!.responseModel, undefined);
      assert.equal(result!.tokensPrompt, undefined);
      assert.equal(result!.tokensCompletion, undefined);
      assert.equal(result!.durationMs, undefined);
    });

    testWithCleanDb("preserves all optional fields when undefined", () => {
      const capture = createCaptureMetadata({ 
        id: "type-optional-2",
        requestModel: undefined,
        responseModel: undefined,
        tokensPrompt: undefined,
        tokensCompletion: undefined,
        durationMs: undefined,
      });
      upsertCapture(capture);
      
      const result = getCaptureById("type-optional-2");
      assert.ok(result !== null);
      // undefined -> stored as null in DB -> read back as undefined
      assert.equal(result!.requestModel, undefined);
      assert.equal(result!.responseModel, undefined);
      assert.equal(result!.tokensPrompt, undefined);
      assert.equal(result!.tokensCompletion, undefined);
      assert.equal(result!.durationMs, undefined);
    });

    testWithCleanDb("round-trips all fields correctly", () => {
      const original = createCaptureMetadata({ 
        id: "roundtrip-1",
        sessionId: "sess-roundtrip",
        filepath: "/test/roundtrip.json",
        timestamp: 1234567890000,
        requestModel: "test-model",
        responseModel: "test-model",
        tokensPrompt: 42,
        tokensCompletion: 58,
        durationMs: 1234,
        status: "streaming",
        createdAt: 1234567890000,
      });
      upsertCapture(original);
      
      const result = getCaptureById("roundtrip-1");
      assert.ok(result !== null);
      assert.equal(result!.id, original.id);
      assert.equal(result!.sessionId, original.sessionId);
      assert.equal(result!.filepath, original.filepath);
      assert.equal(result!.timestamp, original.timestamp);
      assert.equal(result!.requestModel, original.requestModel);
      assert.equal(result!.responseModel, original.responseModel);
      assert.equal(result!.tokensPrompt, original.tokensPrompt);
      assert.equal(result!.tokensCompletion, original.tokensCompletion);
      assert.equal(result!.durationMs, original.durationMs);
      assert.equal(result!.status, original.status);
      assert.equal(result!.createdAt, original.createdAt);
    });
  });
});