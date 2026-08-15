import { describe, it, before, after, beforeEach } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import Database from "better-sqlite3";

import { createFeedbackStore } from "../src/feedback.js";
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

describe("SqliteFeedbackStore session scoping consistency", () => {
  before(async () => {
    await setupTestDb();
  });

  after(async () => {
    await teardownTestDb();
  });

  let store: ReturnType<typeof createFeedbackStore>;

  beforeEach(() => {
    clearFeedbackTable();
    store = createFeedbackStore("sqlite");
  });

  it("should include global entries when sessionId is provided in isFalsePositive", async () => {
    await store.recordFalsePositive({
      value: "global@example.com",
      ruleId: "email-rule",
      label: "EMAIL",
      path: "$.user.email",
      timestamp: Date.now(),
      matchMode: "exact"
    });

    await store.recordFalsePositive({
      value: "session@example.com",
      ruleId: "email-rule",
      label: "EMAIL",
      path: "$.user.email",
      timestamp: Date.now(),
      sessionId: "session-1",
      matchMode: "exact"
    });

    assert.equal(await store.isFalsePositive("global@example.com", "email-rule", "session-1"), true);
    assert.equal(await store.isFalsePositive("session@example.com", "email-rule", "session-1"), true);
    assert.equal(await store.isFalsePositive("other@example.com", "email-rule", "session-1"), false);
  });

  it("should include global entries when sessionId is provided in getAllFalsePositives", async () => {
    await store.recordFalsePositive({
      value: "global@example.com",
      ruleId: "email-rule",
      label: "EMAIL",
      path: "$.user.email",
      timestamp: Date.now(),
      matchMode: "exact"
    });

    await store.recordFalsePositive({
      value: "session@example.com",
      ruleId: "email-rule",
      label: "EMAIL",
      path: "$.user.email",
      timestamp: Date.now(),
      sessionId: "session-1",
      matchMode: "exact"
    });

    const withSession = await store.getAllFalsePositives("email-rule", "session-1");
    assert.equal(withSession.length, 2);
    const values = withSession.map(e => e.value).sort();
    assert.deepEqual(values, ["global@example.com", "session@example.com"]);
  });

  it("should include global entries when sessionId is provided in clear", async () => {
    await store.recordFalsePositive({
      value: "global@example.com",
      ruleId: "email-rule",
      label: "EMAIL",
      path: "$.user.email",
      timestamp: Date.now(),
      matchMode: "exact"
    });

    await store.recordFalsePositive({
      value: "session@example.com",
      ruleId: "email-rule",
      label: "EMAIL",
      path: "$.user.email",
      timestamp: Date.now(),
      sessionId: "session-1",
      matchMode: "exact"
    });

    const cleared = await store.clear("email-rule", "session-1");
    assert.equal(cleared, 2);

    const remaining = await store.getAllFalsePositives("email-rule");
    assert.equal(remaining.length, 0);
  });

  it("should not include other sessions' entries when sessionId is provided", async () => {
    await store.recordFalsePositive({
      value: "global@example.com",
      ruleId: "email-rule",
      label: "EMAIL",
      path: "$.user.email",
      timestamp: Date.now(),
      matchMode: "exact"
    });

    await store.recordFalsePositive({
      value: "session1@example.com",
      ruleId: "email-rule",
      label: "EMAIL",
      path: "$.user.email",
      timestamp: Date.now(),
      sessionId: "session-1",
      matchMode: "exact"
    });

    await store.recordFalsePositive({
      value: "session2@example.com",
      ruleId: "email-rule",
      label: "EMAIL",
      path: "$.user.email",
      timestamp: Date.now(),
      sessionId: "session-2",
      matchMode: "exact"
    });

    const withSession1 = await store.getAllFalsePositives("email-rule", "session-1");
    assert.equal(withSession1.length, 2);
    const values = withSession1.map(e => e.value).sort();
    assert.deepEqual(values, ["global@example.com", "session1@example.com"]);

    assert.equal(await store.isFalsePositive("session2@example.com", "email-rule", "session-1"), false);
    assert.equal(await store.isFalsePositive("session1@example.com", "email-rule", "session-1"), true);
  });
});
