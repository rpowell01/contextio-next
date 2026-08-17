import { describe, it, beforeEach, before, after } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import Database from "better-sqlite3";

import {
  MemoryFeedbackStore,
  SqliteFeedbackStore,
  createFeedbackStore,
  generatePatternFromValue,
  type FalsePositiveEntry,
  type MatchMode,
} from "../src/feedback.js";
import { closeDb, initDb, getDb } from "@contextio/core/db";

let testDbDir: string;
let testDbPath: string;

async function setupTestDb(): Promise<void> {
  testDbDir = mkdtempSync(join(tmpdir(), "contextio-feedback-test-"));
  testDbPath = join(testDbDir, "test.db");

  process.env.CONTEXTIO_DB_PATH = testDbPath;
  closeDb();
  initDb();

  const db = new Database(testDbPath);
  db.close();
}

async function teardownTestDb(): Promise<void> {
  closeDb();
  if (testDbDir) {
    rmSync(testDbDir, { recursive: true, force: true });
  }
  delete process.env.CONTEXTIO_DB_PATH;
}

function clearFeedbackTable(): void {
  const db = getDb();
  db.prepare("DELETE FROM redaction_false_positives").run();
}

function createTestEntry(overrides: Partial<FalsePositiveEntry> = {}): Omit<FalsePositiveEntry, "pattern"> {
  return {
    value: "test@example.com",
    ruleId: "email-rule",
    label: "EMAIL",
    path: "$.user.email",
    timestamp: Date.now(),
    matchMode: "exact",
    ...overrides,
  };
}

// Helper to run tests against both store implementations
function runFeedbackStoreTests(
  name: string,
  createStore: () => ReturnType<typeof createFeedbackStore>,
  cleanup?: () => void | Promise<void>
) {
  describe(`${name} - FeedbackStore`, () => {
    let store: ReturnType<typeof createFeedbackStore>;

    beforeEach(() => {
      if (cleanup) cleanup();
      store = createStore();
    });

    describe("recordFalsePositive", () => {
      it("should record a false positive with exact match mode", async () => {
        const entry = await store.recordFalsePositive(createTestEntry());
        assert.equal(entry.value, "test@example.com");
        assert.equal(entry.ruleId, "email-rule");
        assert.equal(entry.label, "EMAIL");
        assert.equal(entry.matchMode, "exact");
        assert.equal(entry.pattern, "test@example.com"); // exact mode uses value as pattern
      });

      it("should record a false positive with pattern match mode", async () => {
        const entry = await store.recordFalsePositive(createTestEntry({ matchMode: "pattern" }));
        assert.equal(entry.matchMode, "pattern");
        // Pattern should be auto-generated with regex escaping and \d+ for digits
        assert.ok(entry.pattern.startsWith("^"));
        assert.ok(entry.pattern.endsWith("$"));
        assert.ok(entry.pattern.includes("\\.")); // dots escaped
      });

      it("should record a false positive with sessionId", async () => {
        const entry = await store.recordFalsePositive(createTestEntry({ sessionId: "session-1" }));
        assert.equal(entry.sessionId, "session-1");
      });

      it("should record a false positive without sessionId (global)", async () => {
        const entry = await store.recordFalsePositive(createTestEntry());
        assert.equal(entry.sessionId, undefined);
      });
    });

    describe("isFalsePositive - exact mode", () => {
      it("should return true for exact match", async () => {
        await store.recordFalsePositive(createTestEntry({ value: "john@example.com", matchMode: "exact" }));
        assert.equal(await store.isFalsePositive("john@example.com", "email-rule"), true);
      });

      it("should return false for non-matching value", async () => {
        await store.recordFalsePositive(createTestEntry({ value: "john@example.com", matchMode: "exact" }));
        assert.equal(await store.isFalsePositive("jane@example.com", "email-rule"), false);
      });

      it("should return false for different ruleId", async () => {
        await store.recordFalsePositive(createTestEntry({ value: "john@example.com", ruleId: "email-rule", matchMode: "exact" }));
        assert.equal(await store.isFalsePositive("john@example.com", "phone-rule"), false);
      });

      it("should match global entries when sessionId is provided", async () => {
        await store.recordFalsePositive(createTestEntry({ value: "global@example.com", matchMode: "exact" })); // global
        await store.recordFalsePositive(createTestEntry({ value: "session@example.com", sessionId: "session-1", matchMode: "exact" }));

        assert.equal(await store.isFalsePositive("global@example.com", "email-rule", "session-1"), true);
        assert.equal(await store.isFalsePositive("session@example.com", "email-rule", "session-1"), true);
        assert.equal(await store.isFalsePositive("other@example.com", "email-rule", "session-1"), false);
      });

      it("should not match other sessions' entries", async () => {
        await store.recordFalsePositive(createTestEntry({ value: "global@example.com", matchMode: "exact" }));
        await store.recordFalsePositive(createTestEntry({ value: "session1@example.com", sessionId: "session-1", matchMode: "exact" }));
        await store.recordFalsePositive(createTestEntry({ value: "session2@example.com", sessionId: "session-2", matchMode: "exact" }));

        assert.equal(await store.isFalsePositive("session2@example.com", "email-rule", "session-1"), false);
        assert.equal(await store.isFalsePositive("session1@example.com", "email-rule", "session-1"), true);
      });
    });

    describe("isFalsePositive - pattern mode", () => {
      it("should return true for pattern match", async () => {
        await store.recordFalsePositive(createTestEntry({ value: "user123@example.com", matchMode: "pattern" }));
        // Pattern should match similar values with different digits
        assert.equal(await store.isFalsePositive("user456@example.com", "email-rule"), true);
      });

      it("should return true for exact value match in pattern mode", async () => {
        await store.recordFalsePositive(createTestEntry({ value: "user123@example.com", matchMode: "pattern" }));
        assert.equal(await store.isFalsePositive("user123@example.com", "email-rule"), true);
      });

      it("should return false for non-matching pattern", async () => {
        await store.recordFalsePositive(createTestEntry({ value: "user123@example.com", matchMode: "pattern" }));
        assert.equal(await store.isFalsePositive("completely-different@example.com", "email-rule"), false);
      });

      it("should match global pattern entries when sessionId is provided", async () => {
        await store.recordFalsePositive(createTestEntry({ value: "global123@example.com", matchMode: "pattern" }));
        await store.recordFalsePositive(createTestEntry({ value: "session123@example.com", sessionId: "session-1", matchMode: "pattern" }));

        assert.equal(await store.isFalsePositive("global456@example.com", "email-rule", "session-1"), true);
        assert.equal(await store.isFalsePositive("session456@example.com", "email-rule", "session-1"), true);
        assert.equal(await store.isFalsePositive("other@example.com", "email-rule", "session-1"), false);
      });

      it("should not match other sessions' pattern entries", async () => {
        // Use values with different base patterns so they don't cross-match
        await store.recordFalsePositive(createTestEntry({ value: "global123@example.com", matchMode: "pattern" }));
        await store.recordFalsePositive(createTestEntry({ value: "user111@example.com", sessionId: "session-1", matchMode: "pattern" }));
        await store.recordFalsePositive(createTestEntry({ value: "admin222@example.com", sessionId: "session-2", matchMode: "pattern" }));

        // session-1 pattern (^user\d+@example\.com$) should not match admin222
        assert.equal(await store.isFalsePositive("admin222@example.com", "email-rule", "session-1"), false);
        // session-1 pattern should match user111 and user456
        assert.equal(await store.isFalsePositive("user111@example.com", "email-rule", "session-1"), true);
        assert.equal(await store.isFalsePositive("user456@example.com", "email-rule", "session-1"), true);
        // session-2 pattern (^admin\d+@example\.com$) should not match user111
        assert.equal(await store.isFalsePositive("user111@example.com", "email-rule", "session-2"), false);
      });
    });

    describe("getAllFalsePositives", () => {
      it("should return all entries when no filters provided", async () => {
        await store.recordFalsePositive(createTestEntry({ value: "a@example.com", ruleId: "rule1" }));
        await store.recordFalsePositive(createTestEntry({ value: "b@example.com", ruleId: "rule2" }));

        const entries = await store.getAllFalsePositives();
        assert.equal(entries.length, 2);
      });

      it("should filter by ruleId", async () => {
        await store.recordFalsePositive(createTestEntry({ value: "a@example.com", ruleId: "rule1" }));
        await store.recordFalsePositive(createTestEntry({ value: "b@example.com", ruleId: "rule2" }));

        const entries = await store.getAllFalsePositives("rule1");
        assert.equal(entries.length, 1);
        assert.equal(entries[0].ruleId, "rule1");
      });

      it("should include global and session-specific when sessionId provided", async () => {
        await store.recordFalsePositive(createTestEntry({ value: "global@example.com" }));
        await store.recordFalsePositive(createTestEntry({ value: "session@example.com", sessionId: "session-1" }));

        const entries = await store.getAllFalsePositives("email-rule", "session-1");
        assert.equal(entries.length, 2);
        const values = entries.map((e) => e.value).sort();
        assert.deepEqual(values, ["global@example.com", "session@example.com"]);
      });

      it("should not include other sessions' entries when sessionId provided", async () => {
        await store.recordFalsePositive(createTestEntry({ value: "global@example.com" }));
        await store.recordFalsePositive(createTestEntry({ value: "session1@example.com", sessionId: "session-1" }));
        await store.recordFalsePositive(createTestEntry({ value: "session2@example.com", sessionId: "session-2" }));

        const entries = await store.getAllFalsePositives("email-rule", "session-1");
        assert.equal(entries.length, 2);
        const values = entries.map((e) => e.value).sort();
        assert.deepEqual(values, ["global@example.com", "session1@example.com"]);
      });

      it("should return entries sorted by timestamp descending", async () => {
        const now = Date.now();
        await store.recordFalsePositive(createTestEntry({ value: "first@example.com", timestamp: now }));
        await store.recordFalsePositive(createTestEntry({ value: "second@example.com", timestamp: now + 1000 }));
        await store.recordFalsePositive(createTestEntry({ value: "third@example.com", timestamp: now + 2000 }));

        const entries = await store.getAllFalsePositives();
        assert.equal(entries[0].value, "third@example.com");
        assert.equal(entries[1].value, "second@example.com");
        assert.equal(entries[2].value, "first@example.com");
      });
    });

    describe("removeFalsePositive", () => {
      it("should remove an existing entry", async () => {
        await store.recordFalsePositive(createTestEntry({ value: "remove@example.com" }));
        const removed = await store.removeFalsePositive("remove@example.com", "email-rule");
        assert.equal(removed, true);

        const entries = await store.getAllFalsePositives();
        assert.equal(entries.length, 0);
      });

      it("should return false for non-existent entry", async () => {
        const removed = await store.removeFalsePositive("nonexistent@example.com", "email-rule");
        assert.equal(removed, false);
      });

      it("should only remove matching ruleId", async () => {
        await store.recordFalsePositive(createTestEntry({ value: "same@example.com", ruleId: "rule1" }));
        await store.recordFalsePositive(createTestEntry({ value: "same@example.com", ruleId: "rule2" }));

        await store.removeFalsePositive("same@example.com", "rule1");
        const entries = await store.getAllFalsePositives();
        assert.equal(entries.length, 1);
        assert.equal(entries[0].ruleId, "rule2");
      });

      it("should respect sessionId scoping", async () => {
        await store.recordFalsePositive(createTestEntry({ value: "global@example.com" }));
        await store.recordFalsePositive(createTestEntry({ value: "session@example.com", sessionId: "session-1" }));

        await store.removeFalsePositive("session@example.com", "email-rule", "session-1");
        const entries = await store.getAllFalsePositives("email-rule");
        assert.equal(entries.length, 1);
        assert.equal(entries[0].value, "global@example.com");
      });

      it("should not remove other sessions' entries", async () => {
        await store.recordFalsePositive(createTestEntry({ value: "session1@example.com", sessionId: "session-1" }));
        await store.recordFalsePositive(createTestEntry({ value: "session2@example.com", sessionId: "session-2" }));

        await store.removeFalsePositive("session2@example.com", "email-rule", "session-1");
        const entries = await store.getAllFalsePositives("email-rule", "session-2");
        assert.equal(entries.length, 1);
        assert.equal(entries[0].value, "session2@example.com");
      });
    });

    describe("clear", () => {
      it("should clear all entries when no filters", async () => {
        await store.recordFalsePositive(createTestEntry({ value: "a@example.com", ruleId: "rule1" }));
        await store.recordFalsePositive(createTestEntry({ value: "b@example.com", ruleId: "rule2" }));

        const cleared = await store.clear();
        assert.equal(cleared, 2);

        const entries = await store.getAllFalsePositives();
        assert.equal(entries.length, 0);
      });

      it("should clear only matching ruleId", async () => {
        await store.recordFalsePositive(createTestEntry({ value: "a@example.com", ruleId: "rule1" }));
        await store.recordFalsePositive(createTestEntry({ value: "b@example.com", ruleId: "rule2" }));

        const cleared = await store.clear("rule1");
        assert.equal(cleared, 1);

        const entries = await store.getAllFalsePositives();
        assert.equal(entries.length, 1);
        assert.equal(entries[0].ruleId, "rule2");
      });

      it("should clear global and session-specific when sessionId provided", async () => {
        await store.recordFalsePositive(createTestEntry({ value: "global@example.com" }));
        await store.recordFalsePositive(createTestEntry({ value: "session@example.com", sessionId: "session-1" }));

        const cleared = await store.clear("email-rule", "session-1");
        assert.equal(cleared, 2);

        const entries = await store.getAllFalsePositives("email-rule");
        assert.equal(entries.length, 0);
      });

      it("should not clear other sessions' specific entries when sessionId provided", async () => {
        await store.recordFalsePositive(createTestEntry({ value: "global@example.com" }));
        await store.recordFalsePositive(createTestEntry({ value: "session1@example.com", sessionId: "session-1" }));
        await store.recordFalsePositive(createTestEntry({ value: "session2@example.com", sessionId: "session-2" }));

        const cleared = await store.clear("email-rule", "session-1");
        // Clear with sessionId deletes global + that session's entries
        assert.equal(cleared, 2);

        // Session-2's specific entry should remain (global is deleted for everyone)
        const entries = await store.getAllFalsePositives("email-rule", "session-2");
        assert.equal(entries.length, 1);
        assert.equal(entries[0].value, "session2@example.com");
      });
    });
  });
}

// Run tests for MemoryFeedbackStore
runFeedbackStoreTests("MemoryFeedbackStore", () => createFeedbackStore("memory"));

// Run tests for SqliteFeedbackStore
describe("SqliteFeedbackStore - FeedbackStore", () => {
  before(async () => {
    await setupTestDb();
  });

  after(async () => {
    await teardownTestDb();
  });

  runFeedbackStoreTests(
    "SqliteFeedbackStore",
    () => createFeedbackStore("sqlite"),
    clearFeedbackTable
  );
});

describe("generatePatternFromValue", () => {
  it("should escape regex special characters", () => {
    const pattern = generatePatternFromValue("test.value@example.com");
    // @ is not a regex special character, so it's not escaped
    assert.ok(pattern.includes("test\\.value@example\\.com"));
  });

  it("should replace digit sequences with \\d+", () => {
    const pattern = generatePatternFromValue("user123@example.com");
    assert.ok(pattern.includes("user\\d+"));
  });

  it("should replace whitespace sequences with \\s+", () => {
    const pattern = generatePatternFromValue("user name@example.com");
    assert.ok(pattern.includes("user\\s+name"));
  });

  it("should anchor pattern with ^ and $", () => {
    const pattern = generatePatternFromValue("test@example.com");
    assert.ok(pattern.startsWith("^"));
    assert.ok(pattern.endsWith("$"));
  });

  it("should handle complex values with multiple transformations", () => {
    const pattern = generatePatternFromValue("user.name123@test-domain.com");
    // Should have: escaped dots, \d+ for digits, anchored
    // @ and - are not escaped (not regex metacharacters outside char classes)
    assert.ok(pattern.startsWith("^"));
    assert.ok(pattern.endsWith("$"));
    assert.ok(pattern.includes("user\\.name\\d+"));
    assert.ok(pattern.includes("test-domain\\.com"));
  });

  it("should handle value with no special characters or digits", () => {
    const pattern = generatePatternFromValue("simple@example");
    assert.equal(pattern, "^simple@example$");
  });
});