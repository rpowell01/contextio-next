import { describe, it, before, after } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import Database from "better-sqlite3";

import { PresidioTsDetector, createPresidioTsDetector, type PresidioTsConfig } from "../src/presidioTsDetector.js";
import { MemoryFeedbackStore, SqliteFeedbackStore, createFeedbackStore, type FeedbackStore } from "../src/feedback.js";
import { closeDb, initDb, getDb } from "@contextio/core/db";

// Skip tests if running in CI without proper model setup
const SKIP_INTEGRATION = process.env.CI === "true" && !process.env.RUN_INTEGRATION_TESTS;
const SKIP_HEAVY_INTEGRATION = SKIP_INTEGRATION || process.env.SKIP_HEAVY_TESTS === "true";

function skipIfHeavy(this: { skip: (msg: string) => void }) {
  if (SKIP_HEAVY_INTEGRATION) {
    this.skip("Heavy integration test skipped");
  }
}

let testDbDir: string;
let testDbPath: string;

async function setupTestDb(): Promise<void> {
  testDbDir = mkdtempSync(join(tmpdir(), "contextio-presidio-detector-feedback-test-"));
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

function createTestEntry(value: string, ruleId: string, overrides: Partial<{ label: string; path: string; sessionId: string; matchMode: "exact" | "pattern" }> = {}) {
  return {
    value,
    ruleId,
    label: overrides.label ?? ruleId.toUpperCase().replace(/-/g, "_"),
    path: overrides.path ?? `$.messages[0].content`,
    timestamp: Date.now(),
    sessionId: overrides.sessionId,
    matchMode: overrides.matchMode ?? "exact",
  };
}

// Shared detector instances to avoid reloading model multiple times
let sharedPresidioDetector: PresidioTsDetector | null = null;

async function getSharedPresidioDetector(config?: PresidioTsConfig): Promise<PresidioTsDetector> {
  if (!sharedPresidioDetector) {
    sharedPresidioDetector = await createPresidioTsDetector({
      name: "presidio-ts",
      threshold: 0.5,
      useNER: true,
      ...config,
    });
  }
  return sharedPresidioDetector;
}

// Run tests for both MemoryFeedbackStore and SqliteFeedbackStore
function runPresidioDetectorFeedbackTests(
  name: string,
  createStore: () => FeedbackStore,
  cleanup?: () => void | Promise<void>
) {
  describe(`${name} - PresidioTsDetector with FeedbackStore`, () => {
    let store: FeedbackStore;

    before(async () => {
      if (cleanup) cleanup();
      store = createStore();
      // Ensure the shared detector is initialized
      await getSharedPresidioDetector();
    });

    after(async () => {
      // Don't shutdown shared detector here - it's used by other tests
    });

    describe("false positive filtering", () => {
      it("should filter out exact match false positives for pattern-based entities", async function(this: { skip: (msg: string) => void }) {
        skipIfHeavy.call(this);
        const detector = await getSharedPresidioDetector();

        // Record a false positive for a specific email
        // Note: Presidio uses "presidio-ts" as the ruleId (detector name)
        await store.recordFalsePositive(createTestEntry("falsepositive@test.com", "presidio-ts"));

        // Detect - the false positive should be filtered out
        const result = await detector.detect("Contact falsepositive@test.com or real@test.com", {
          feedbackStore: store,
        });

        // Should only detect the real email
        const emailSpans = result.spans.filter((s) => s.label === "EMAIL_ADDRESS");
        assert.equal(emailSpans.length, 1);
        assert.equal(emailSpans[0].text, "real@test.com");
      });

      it("should filter out exact match false positives for NER entities", async function(this: { skip: (msg: string) => void }) {
        skipIfHeavy.call(this);
        const detector = await getSharedPresidioDetector();

        // Record a false positive for a person name
        // Use a unique name that's unlikely to be split
        await store.recordFalsePositive(createTestEntry("Johnathan Doe", "presidio-ts", { label: "PERSON" }));

        // Detect - the false positive should be filtered out
        const result = await detector.detect("Johnathan Doe and Jane Smith work here", {
          feedbackStore: store,
        });

        // Should only detect Jane Smith (or at least not Johnathan Doe)
        const personSpans = result.spans.filter((s) => s.label === "PERSON");
        // The false positive should be filtered, so Johnathan Doe should not appear
        const hasJohnathan = personSpans.some(s => s.text.includes("Johnathan"));
        assert.equal(hasJohnathan, false, "False positive Johnathan Doe should be filtered");
        // At least Jane Smith should be detected
        assert.ok(personSpans.length >= 1, "Should detect at least one person");
      });

      it("should not filter out non-false-positive spans", async function(this: { skip: (msg: string) => void }) {
        skipIfHeavy.call(this);
        const detector = await getSharedPresidioDetector();

        // Record a false positive for one email
        await store.recordFalsePositive(createTestEntry("falsepositive@test.com", "presidio-ts"));

        // Detect with different emails - non-false-positives should still be detected
        const result = await detector.detect("Contact falsepositive@test.com and real1@test.com and real2@test.com", {
          feedbackStore: store,
        });

        const emailSpans = result.spans.filter((s) => s.label === "EMAIL_ADDRESS");
        assert.equal(emailSpans.length, 2);
        const texts = emailSpans.map((s) => s.text).sort();
        assert.deepEqual(texts, ["real1@test.com", "real2@test.com"]);
      });

      it("should filter false positives by ruleId (detector name)", async function(this: { skip: (msg: string) => void }) {
        skipIfHeavy.call(this);
        const detector = await getSharedPresidioDetector();

        // Record false positive for presidio-ts detector
        await store.recordFalsePositive(createTestEntry("test@test.com", "presidio-ts"));

        // Detect - phone should still be detected even though email is filtered
        const result = await detector.detect("Call me at +1-555-123-4567 and email test@test.com", {
          feedbackStore: store,
        });

        const phoneSpans = result.spans.filter((s) => s.label === "PHONE_NUMBER");
        const emailSpans = result.spans.filter((s) => s.label === "EMAIL_ADDRESS");

        assert.equal(phoneSpans.length, 1);
        assert.equal(emailSpans.length, 0);
      });

      it("should filter pattern mode false positives", async function(this: { skip: (msg: string) => void }) {
        skipIfHeavy.call(this);
        const detector = await getSharedPresidioDetector();

        // Record a pattern-mode false positive (matches similar emails)
        await store.recordFalsePositive(createTestEntry("user123@test.com", "presidio-ts", { matchMode: "pattern" }));

        // Detect - similar emails should be filtered
        const result = await detector.detect("Contact user456@test.com and user789@test.com and real@test.com", {
          feedbackStore: store,
        });

        const emailSpans = result.spans.filter((s) => s.label === "EMAIL_ADDRESS");
        assert.equal(emailSpans.length, 1);
        assert.equal(emailSpans[0].text, "real@test.com");
      });

      it("should not filter non-matching patterns", async function(this: { skip: (msg: string) => void }) {
        skipIfHeavy.call(this);
        const detector = await getSharedPresidioDetector();

        // Record a pattern-mode false positive for user123@test.com
        await store.recordFalsePositive(createTestEntry("user123@test.com", "presidio-ts", { matchMode: "pattern" }));

        // Detect - completely different email should not be filtered
        const result = await detector.detect("Contact completely.different@test.com", {
          feedbackStore: store,
        });

        const emailSpans = result.spans.filter((s) => s.label === "EMAIL_ADDRESS");
        assert.equal(emailSpans.length, 1);
        assert.equal(emailSpans[0].text, "completely.different@test.com");
      });

      it("should respect session scoping for false positives", async function(this: { skip: (msg: string) => void }) {
        skipIfHeavy.call(this);
        const detector = await getSharedPresidioDetector();

        // Record global false positive
        await store.recordFalsePositive(createTestEntry("global@test.com", "presidio-ts"));
        // Record session-specific false positive
        await store.recordFalsePositive(createTestEntry("session@test.com", "presidio-ts", { sessionId: "session-1" }));

        // Detect - detector doesn't pass sessionId to feedbackStore
        // So only global entries (sessionId=null) will be matched
        const result = await detector.detect("Contact global@test.com and session@test.com and other@test.com", {
          feedbackStore: store,
        });

        const emailSpans = result.spans.filter((s) => s.label === "EMAIL_ADDRESS");
        // Only global should be filtered (session-specific requires sessionId to be passed)
        assert.equal(emailSpans.length, 2);
        const texts = emailSpans.map(s => s.text).sort();
        assert.deepEqual(texts, ["other@test.com", "session@test.com"]);
      });

      it("should handle multiple false positives for same detector", async function(this: { skip: (msg: string) => void }) {
        skipIfHeavy.call(this);
        const detector = await getSharedPresidioDetector();

        await store.recordFalsePositive(createTestEntry("fp1@test.com", "presidio-ts"));
        await store.recordFalsePositive(createTestEntry("fp2@test.com", "presidio-ts"));
        await store.recordFalsePositive(createTestEntry("fp3@test.com", "presidio-ts"));

        const result = await detector.detect("Emails: fp1@test.com, fp2@test.com, fp3@test.com, real@test.com", {
          feedbackStore: store,
        });

        const emailSpans = result.spans.filter((s) => s.label === "EMAIL_ADDRESS");
        assert.equal(emailSpans.length, 1);
        assert.equal(emailSpans[0].text, "real@test.com");
      });

      it("should handle false positives across different entity types", async function(this: { skip: (msg: string) => void }) {
        skipIfHeavy.call(this);
        const detector = await getSharedPresidioDetector();

        await store.recordFalsePositive(createTestEntry("test@test.com", "presidio-ts", { label: "EMAIL_ADDRESS" }));
        await store.recordFalsePositive(createTestEntry("123-45-6789", "presidio-ts", { label: "US_SSN" }));
        await store.recordFalsePositive(createTestEntry("4111-1111-1111-1111", "presidio-ts", { label: "CREDIT_CARD" }));

        const result = await detector.detect(
          "Email: test@test.com, SSN: 123-45-6789, Card: 4111-1111-1111-1111, Phone: +1-555-123-4567",
          { feedbackStore: store }
        );

        // Only phone should be detected
        const labels = result.spans.map((s) => s.label);
        assert.ok(labels.includes("PHONE_NUMBER"));
        assert.ok(!labels.includes("EMAIL_ADDRESS"));
        assert.ok(!labels.includes("US_SSN"));
        assert.ok(!labels.includes("CREDIT_CARD"));
      });

      it("should not crash when feedback store throws error", async function(this: { skip: (msg: string) => void }) {
        skipIfHeavy.call(this);
        const detector = await getSharedPresidioDetector();

        // Create a store that throws on isFalsePositive
        const errorStore: FeedbackStore = {
          async recordFalsePositive(entry) { return { ...entry, pattern: entry.value } as any; },
          async isFalsePositive() { throw new Error("Store error"); },
          async getAllFalsePositives() { return []; },
          async removeFalsePositive() { return false; },
          async clear() { return 0; },
        };

        // Should not throw, should treat as non-false-positive
        const result = await detector.detect("Contact test@test.com", { feedbackStore: errorStore });
        const emailSpans = result.spans.filter((s) => s.label === "EMAIL_ADDRESS");
        assert.equal(emailSpans.length, 1); // Still detected because error treated as non-fp
      });

      it("should work with runtime feedbackStore config override", async function(this: { skip: (msg: string) => void }) {
        skipIfHeavy.call(this);
        const detector = await getSharedPresidioDetector();

        // Create a store with false positives
        const runtimeStore = createFeedbackStore("memory");
        await runtimeStore.recordFalsePositive(createTestEntry("runtime@test.com", "presidio-ts"));

        // Detect with runtime feedbackStore
        const result = await detector.detect("Contact runtime@test.com and real@test.com", {
          feedbackStore: runtimeStore,
        });

        const emailSpans = result.spans.filter((s) => s.label === "EMAIL_ADDRESS");
        assert.equal(emailSpans.length, 1);
        assert.equal(emailSpans[0].text, "real@test.com");
      });

      it("should filter false positives when detector initialized with feedbackStore", async function(this: { skip: (msg: string) => void }) {
        skipIfHeavy.call(this);
        const initStore = createFeedbackStore("memory");
        // RuleId must match the detector's name (this.name)
        await initStore.recordFalsePositive(createTestEntry("init@test.com", "presidio-with-store"));

        // Create new detector with feedbackStore in config
        const detectorWithStore = await createPresidioTsDetector({
          name: "presidio-with-store",
          threshold: 0.5,
          useNER: true,
          feedbackStore: initStore,
        });

        try {
          const result = await detectorWithStore.detect("Contact init@test.com and real@test.com");
          const emailSpans = result.spans.filter((s) => s.label === "EMAIL_ADDRESS");
          assert.equal(emailSpans.length, 1);
          assert.equal(emailSpans[0].text, "real@test.com");
        } finally {
          await detectorWithStore.shutdown();
        }
      });
    });
  });
}

// Run tests for MemoryFeedbackStore
runPresidioDetectorFeedbackTests("MemoryFeedbackStore", () => createFeedbackStore("memory"));

// Run tests for SqliteFeedbackStore
describe("SqliteFeedbackStore - PresidioTsDetector with FeedbackStore", () => {
  before(async () => {
    await setupTestDb();
  });

  after(async () => {
    await teardownTestDb();
    // Shutdown shared detector after all Sqlite tests
    if (sharedPresidioDetector) {
      await sharedPresidioDetector.shutdown();
      sharedPresidioDetector = null;
    }
  });

  runPresidioDetectorFeedbackTests(
    "SqliteFeedbackStore",
    () => createFeedbackStore("sqlite"),
    clearFeedbackTable
  );
});