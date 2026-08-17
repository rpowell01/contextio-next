import { describe, it, before, after } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import Database from "better-sqlite3";

import { RuleDetector, createRuleDetector } from "../src/ruleDetector.js";
import { MemoryFeedbackStore, SqliteFeedbackStore, createFeedbackStore, type FeedbackStore } from "../src/feedback.js";
import type { RedactionRule } from "../src/rules.js";
import { closeDb, initDb, getDb } from "@contextio/core/db";

// Test rules that mimic the pii preset
const testRules: RedactionRule[] = [
  {
    name: "email",
    pattern: /[a-zA-Z0-9._%+-]+@[a-zA-Z0-9.-]+\.[a-zA-Z]{2,}/g,
    replacement: "[EMAIL_REDACTED]",
  },
  {
    name: "phone-us",
    pattern: /(?:\+?1[-.\s]?)?\(?\d{3}\)?[-.\s]?\d{3}[-.\s]?\d{4}/g,
    replacement: "[PHONE_REDACTED]",
    context: ["phone", "call", "mobile", "number"],
    contextWindow: 100,
  },
  {
    name: "ssn",
    pattern: /\d{3}-\d{2}-\d{4}/g,
    replacement: "[SSN_REDACTED]",
    context: ["social", "security", "ssn"],
    contextWindow: 100,
  },
  {
    name: "credit-card",
    pattern: /\d{4}[-.\s]?\d{4}[-.\s]?\d{4}[-.\s]?\d{4}/g,
    replacement: "[CC_REDACTED]",
    context: ["credit", "card", "charge", "payment"],
    contextWindow: 100,
  },
];

let testDbDir: string;
let testDbPath: string;

async function setupTestDb(): Promise<void> {
  testDbDir = mkdtempSync(join(tmpdir(), "contextio-rule-detector-feedback-test-"));
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

// Run tests for both MemoryFeedbackStore and SqliteFeedbackStore
function runRuleDetectorFeedbackTests(
  name: string,
  createStore: () => FeedbackStore,
  cleanup?: () => void | Promise<void>
) {
  describe(`${name} - RuleDetector with FeedbackStore`, () => {
    let detector: RuleDetector;
    let store: FeedbackStore;

    before(async () => {
      if (cleanup) cleanup();
      store = createStore();
      detector = await createRuleDetector({
        name: "test-rules",
        rules: testRules,
        feedbackStore: store,
      });
    });

    after(async () => {
      await detector.shutdown();
    });

    describe("false positive filtering", () => {
      it("should filter out exact match false positives", async () => {
        // Record a false positive for a specific email
        await store.recordFalsePositive(createTestEntry("falsepositive@test.com", "email"));

        // Detect - the false positive should be filtered out
        const result = await detector.detect("Contact falsepositive@test.com or real@test.com");

        // Should only detect the real email
        const emailSpans = result.spans.filter((s) => s.label === "EMAIL");
        assert.equal(emailSpans.length, 1);
        assert.equal(emailSpans[0].text, "real@test.com");
      });

      it("should not filter out non-false-positive spans", async () => {
        // Record a false positive for one email
        await store.recordFalsePositive(createTestEntry("falsepositive@test.com", "email"));

        // Detect with different emails - non-false-positives should still be detected
        const result = await detector.detect("Contact falsepositive@test.com and real1@test.com and real2@test.com");

        const emailSpans = result.spans.filter((s) => s.label === "EMAIL");
        assert.equal(emailSpans.length, 2);
        const texts = emailSpans.map((s) => s.text).sort();
        assert.deepEqual(texts, ["real1@test.com", "real2@test.com"]);
      });

      it("should filter false positives by ruleId", async () => {
        // Record false positive for email rule
        await store.recordFalsePositive(createTestEntry("test@test.com", "email"));

        // Detect - phone should still be detected even though email is filtered
        // Phone number must have exchange code starting with 2-9 per pattern
        const result = await detector.detect("Call me at (555) 234-5678 and email test@test.com");

        const phoneSpans = result.spans.filter((s) => s.label === "PHONE-US");
        const emailSpans = result.spans.filter((s) => s.label === "EMAIL");

        assert.equal(phoneSpans.length, 1);
        assert.equal(emailSpans.length, 0);
      });

      it("should filter pattern mode false positives", async () => {
        // Record a pattern-mode false positive (matches similar emails)
        await store.recordFalsePositive(createTestEntry("user123@test.com", "email", { matchMode: "pattern" }));

        // Detect - similar emails should be filtered
        const result = await detector.detect("Contact user456@test.com and user789@test.com and real@test.com");

        const emailSpans = result.spans.filter((s) => s.label === "EMAIL");
        assert.equal(emailSpans.length, 1);
        assert.equal(emailSpans[0].text, "real@test.com");
      });

      it("should not filter non-matching patterns", async () => {
        // Record a pattern-mode false positive for user123@test.com
        await store.recordFalsePositive(createTestEntry("user123@test.com", "email", { matchMode: "pattern" }));

        // Detect - completely different email should not be filtered
        const result = await detector.detect("Contact completely.different@test.com");

        const emailSpans = result.spans.filter((s) => s.label === "EMAIL");
        assert.equal(emailSpans.length, 1);
        assert.equal(emailSpans[0].text, "completely.different@test.com");
      });

      it("should respect session scoping for false positives", async () => {
        // Record global false positive
        await store.recordFalsePositive(createTestEntry("global@test.com", "email"));
        // Record session-specific false positive
        await store.recordFalsePositive(createTestEntry("session@test.com", "email", { sessionId: "session-1" }));

        // Detect - RuleDetector doesn't currently pass sessionId to feedbackStore in detect()
        // So only global entries (sessionId=null) will be matched
        const result = await detector.detect(
          "Contact global@test.com and session@test.com and other@test.com",
          { feedbackStore: store }
        );

        const emailSpans = result.spans.filter((s) => s.label === "EMAIL");
        // Only global should be filtered (session-specific requires sessionId to be passed)
        assert.equal(emailSpans.length, 2);
        const texts = emailSpans.map(s => s.text).sort();
        assert.deepEqual(texts, ["other@test.com", "session@test.com"]);
      });

      it("should handle multiple false positives for same rule", async () => {
        await store.recordFalsePositive(createTestEntry("fp1@test.com", "email"));
        await store.recordFalsePositive(createTestEntry("fp2@test.com", "email"));
        await store.recordFalsePositive(createTestEntry("fp3@test.com", "email"));

        const result = await detector.detect("Emails: fp1@test.com, fp2@test.com, fp3@test.com, real@test.com");

        const emailSpans = result.spans.filter((s) => s.label === "EMAIL");
        assert.equal(emailSpans.length, 1);
        assert.equal(emailSpans[0].text, "real@test.com");
      });

      it("should handle false positives across different rule types", async () => {
        await store.recordFalsePositive(createTestEntry("test@test.com", "email"));
        await store.recordFalsePositive(createTestEntry("123-45-6789", "ssn", { label: "SSN" }));
        await store.recordFalsePositive(createTestEntry("4111-1111-1111-1111", "credit-card", { label: "CREDIT_CARD" }));

        const result = await detector.detect(
          "Email: test@test.com, SSN: 123-45-6789, Card: 4111-1111-1111-1111, Phone: (555) 234-5678"
        );

        // Only phone should be detected (it has context word "Phone")
        const labels = result.spans.map((s) => s.label);
        assert.ok(labels.includes("PHONE-US"));
        assert.ok(!labels.includes("EMAIL"));
        assert.ok(!labels.includes("SSN"));
        assert.ok(!labels.includes("CREDIT_CARD"));
      });

      it("should not crash when feedback store throws error", async () => {
        // Create a store that throws on isFalsePositive
        const errorStore: FeedbackStore = {
          async recordFalsePositive(entry) { return { ...entry, pattern: entry.value } as any; },
          async isFalsePositive() { throw new Error("Store error"); },
          async getAllFalsePositives() { return []; },
          async removeFalsePositive() { return false; },
          async clear() { return 0; },
        };

        const errorDetector = await createRuleDetector({
          name: "error-rules",
          rules: testRules,
          feedbackStore: errorStore,
        });

        try {
          // Should not throw, should treat as non-false-positive
          const result = await errorDetector.detect("Contact test@test.com");
          const emailSpans = result.spans.filter((s) => s.label === "EMAIL");
          assert.equal(emailSpans.length, 1); // Still detected because error treated as non-fp
        } finally {
          await errorDetector.shutdown();
        }
      });

      it("should work with runtime feedbackStore config override", async () => {
        // Create detector without feedback store
        const detectorNoStore = await createRuleDetector({
          name: "no-store-rules",
          rules: testRules,
        });

        // Create a store with false positives
        const runtimeStore = createFeedbackStore("memory");
        await runtimeStore.recordFalsePositive(createTestEntry("runtime@test.com", "email"));

        // Detect with runtime feedbackStore
        const result = await detectorNoStore.detect("Contact runtime@test.com and real@test.com", {
          feedbackStore: runtimeStore,
        });

        const emailSpans = result.spans.filter((s) => s.label === "EMAIL");
        assert.equal(emailSpans.length, 1);
        assert.equal(emailSpans[0].text, "real@test.com");

        await detectorNoStore.shutdown();
      });
    });
  });
}

// Run tests for MemoryFeedbackStore
runRuleDetectorFeedbackTests("MemoryFeedbackStore", () => createFeedbackStore("memory"));

// Run tests for SqliteFeedbackStore
describe("SqliteFeedbackStore - RuleDetector with FeedbackStore", () => {
  before(async () => {
    await setupTestDb();
  });

  after(async () => {
    await teardownTestDb();
  });

  runRuleDetectorFeedbackTests(
    "SqliteFeedbackStore",
    () => createFeedbackStore("sqlite"),
    clearFeedbackTable
  );
});