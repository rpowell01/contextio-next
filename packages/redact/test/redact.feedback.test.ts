import { describe, it, before, after, beforeEach } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import Database from "better-sqlite3";

import { createRedactPlugin, type RedactPlugin } from "../src/index.js";
import { MemoryFeedbackStore, SqliteFeedbackStore, createFeedbackStore, type FeedbackStore, type FalsePositiveEntry } from "../src/feedback.js";
import { closeDb, initDb, getDb } from "@contextio/core/db";

let testDbDir: string;
let testDbPath: string;

async function setupTestDb(): Promise<void> {
  testDbDir = mkdtempSync(join(tmpdir(), "contextio-redact-feedback-test-"));
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

// Helper to create a mock request context
function createRequestContext(body: any, sessionId: string | null = "test-session"): any {
  return {
    body,
    sessionId,
    provider: "openai",
    targetUrl: "https://api.openai.com/v1/chat/completions",
    source: "test",
    captureId: "test-capture-id",
  };
}

// Run tests for both MemoryFeedbackStore and SqliteFeedbackStore
function runRedactFeedbackTests(
  name: string,
  createStore: () => FeedbackStore,
  cleanup?: () => void | Promise<void>
) {
  describe(`${name} - createRedactPlugin with FeedbackStore`, () => {
    let plugin: RedactPlugin;
    let store: FeedbackStore;

    beforeEach(async () => {
      if (cleanup) cleanup();
      store = createStore();

      plugin = createRedactPlugin({
        preset: "pii",
        feedbackStore: store,
        verbose: false,
      });
    });

    after(async () => {
      plugin.shutdown();
    });

    describe("reportFalsePositive API", () => {
      it("should report a false positive and return the entry", async () => {
        const entry = await plugin.reportFalsePositive({
          value: "falsepositive@test.com",
          ruleId: "email",
          label: "EMAIL",
          path: "$.messages[0].content",
        });

        assert.equal(entry.value, "falsepositive@test.com");
        assert.equal(entry.ruleId, "email");
        assert.equal(entry.label, "EMAIL");
        assert.equal(entry.matchMode, "exact");
        assert.equal(entry.pattern, "falsepositive@test.com"); // exact mode uses value as pattern
      });

      it("should report a false positive with pattern match mode", async () => {
        const entry = await plugin.reportFalsePositive({
          value: "user123@test.com",
          ruleId: "email",
          label: "EMAIL",
          path: "$.messages[0].content",
          matchMode: "pattern",
        });

        assert.equal(entry.matchMode, "pattern");
        assert.ok(entry.pattern.startsWith("^"));
        assert.ok(entry.pattern.endsWith("$"));
        assert.ok(entry.pattern.includes("\\d+")); // digits replaced with \d+
      });

      it("should report a false positive with sessionId", async () => {
        const entry = await plugin.reportFalsePositive({
          value: "session@test.com",
          ruleId: "email",
          label: "EMAIL",
          path: "$.messages[0].content",
          sessionId: "session-1",
        });

        assert.equal(entry.sessionId, "session-1");
      });

      it("should throw if feedback store not configured", async () => {
        const pluginNoStore = createRedactPlugin({
          preset: "pii",
          // No feedbackStore configured
        });

        try {
          await pluginNoStore.reportFalsePositive({
            value: "test@test.com",
            ruleId: "email",
            label: "EMAIL",
            path: "$.messages[0].content",
          });
          assert.fail("Should have thrown");
        } catch (err) {
          assert.ok(err instanceof Error);
          assert.ok(err.message.includes("Feedback store not configured"));
        } finally {
          pluginNoStore.shutdown();
        }
      });

      it("should allow retrieving the feedback store", async () => {
        const retrievedStore = plugin.getFeedbackStore();
        assert.ok(retrievedStore === store);
      });
    });

    describe("false positive filtering in requests", () => {
      it("should not redact false positive values in subsequent requests", async () => {
        // Report a false positive
        await plugin.reportFalsePositive({
          value: "falsepositive@test.com",
          ruleId: "email",
          label: "EMAIL",
          path: "$.messages[0].content",
        });

        // Make a request with the false positive value
        const ctx = createRequestContext({
          messages: [{ role: "user", content: "Contact falsepositive@test.com or real@test.com" }],
        });

        const result = await plugin.onRequest(ctx);

        // The false positive should NOT be redacted, but the real one should
        assert.ok((result.body as any).messages[0].content.includes("falsepositive@test.com"));
        assert.ok((result.body as any).messages[0].content.includes("[EMAIL_"));
        assert.ok(!(result.body as any).messages[0].content.includes("real@test.com"));
      });

      it("should still redact non-false-positive values", async () => {
        // Report a false positive for one email
        await plugin.reportFalsePositive({
          value: "falsepositive@test.com",
          ruleId: "email",
          label: "EMAIL",
          path: "$.messages[0].content",
        });

        // Make a request with multiple emails
        const ctx = createRequestContext({
          messages: [{ role: "user", content: "Contact falsepositive@test.com and real1@test.com and real2@test.com" }],
        });

        const result = await plugin.onRequest(ctx);

        // Only the false positive should remain unredacted
        // Non-reversible mode uses [EMAIL_REDACTED] format
        const content = (result.body as any).messages[0].content;
        assert.ok(content.includes("falsepositive@test.com"));
        assert.ok(content.includes("[EMAIL_REDACTED]")); // real emails redacted
        // Both real emails should be redacted (same placeholder in non-reversible mode)
      });

      it("should filter false positives by ruleId", async () => {
        // Report false positive for email rule
        await plugin.reportFalsePositive({
          value: "test@test.com",
          ruleId: "email",
          label: "EMAIL",
          path: "$.messages[0].content",
        });

        // Request with email and phone (phone has context word "phone")
        // Phone number must have exchange code starting with 2-9 per pattern
        const ctx = createRequestContext({
          messages: [{ role: "user", content: "Email test@test.com and call phone (555) 234-5678" }],
        });

        const result = await plugin.onRequest(ctx);

        // Email should NOT be redacted (false positive), phone SHOULD be redacted
        const content = (result.body as any).messages[0].content;
        assert.ok(content.includes("test@test.com")); // Not redacted
        assert.ok(content.includes("[PHONE_")); // Redacted
      });

      it("should filter pattern mode false positives", async () => {
        // Report a pattern-mode false positive
        await plugin.reportFalsePositive({
          value: "user123@test.com",
          ruleId: "email",
          label: "EMAIL",
          path: "$.messages[0].content",
          matchMode: "pattern",
        });

        // Request with similar emails
        const ctx = createRequestContext({
          messages: [{ role: "user", content: "Contact user456@test.com and user789@test.com and real@test.com" }],
        });

        const result = await plugin.onRequest(ctx);

        // Pattern matches should be filtered, only real email redacted
        const content = (result.body as any).messages[0].content;
        assert.ok(content.includes("user456@test.com")); // Pattern match - not redacted
        assert.ok(content.includes("user789@test.com")); // Pattern match - not redacted
        assert.ok(content.includes("[EMAIL_")); // real@test.com redacted
      });

      it("should not filter non-matching patterns", async () => {
        // Report a pattern-mode false positive
        await plugin.reportFalsePositive({
          value: "user123@test.com",
          ruleId: "email",
          label: "EMAIL",
          path: "$.messages[0].content",
          matchMode: "pattern",
        });

        // Request with completely different email
        const ctx = createRequestContext({
          messages: [{ role: "user", content: "Contact completely.different@test.com" }],
        });

        const result = await plugin.onRequest(ctx);

        // Should be redacted (doesn't match pattern)
        const content = (result.body as any).messages[0].content;
        assert.ok(content.includes("[EMAIL_"));
        assert.ok(!content.includes("completely.different@test.com"));
      });

      it("should handle multiple false positives for same rule", async () => {
        await plugin.reportFalsePositive({
          value: "fp1@test.com",
          ruleId: "email",
          label: "EMAIL",
          path: "$.messages[0].content",
        });
        await plugin.reportFalsePositive({
          value: "fp2@test.com",
          ruleId: "email",
          label: "EMAIL",
          path: "$.messages[0].content",
        });
        await plugin.reportFalsePositive({
          value: "fp3@test.com",
          ruleId: "email",
          label: "EMAIL",
          path: "$.messages[0].content",
        });

        const ctx = createRequestContext({
          messages: [{ role: "user", content: "Emails: fp1@test.com, fp2@test.com, fp3@test.com, real@test.com" }],
        });

        const result = await plugin.onRequest(ctx);

        const content = (result.body as any).messages[0].content;
        assert.ok(content.includes("fp1@test.com"));
        assert.ok(content.includes("fp2@test.com"));
        assert.ok(content.includes("fp3@test.com"));
        assert.ok(content.includes("[EMAIL_")); // real@test.com
      });

      it("should handle false positives across different rule types", async () => {
        await plugin.reportFalsePositive({
          value: "test@test.com",
          ruleId: "email",
          label: "EMAIL",
          path: "$.messages[0].content",
        });
        await plugin.reportFalsePositive({
          value: "123-45-6789",
          ruleId: "ssn",
          label: "SSN",
          path: "$.messages[0].content",
        });
        await plugin.reportFalsePositive({
          value: "4111-1111-1111-1111",
          ruleId: "credit-card",
          label: "CREDIT_CARD",
          path: "$.messages[0].content",
        });

        const ctx = createRequestContext({
          messages: [{ role: "user", content: "Email: test@test.com, SSN: 123-45-6789, Card: 4111-1111-1111-1111, Phone: (555) 234-5678" }],
        });

        const result = await plugin.onRequest(ctx);

        const content = (result.body as any).messages[0].content;
        assert.ok(content.includes("test@test.com")); // Not redacted
        assert.ok(content.includes("123-45-6789")); // Not redacted
        assert.ok(content.includes("4111-1111-1111-1111")); // Not redacted
        assert.ok(content.includes("[PHONE_")); // Phone redacted (has context)
      });
    });

    describe("reversible mode with feedback", () => {
      let reversiblePlugin: RedactPlugin;
      let reversibleStore: FeedbackStore;

      beforeEach(() => {
        if (cleanup) cleanup();
        reversibleStore = createStore();

        reversiblePlugin = createRedactPlugin({
          preset: "pii",
          feedbackStore: reversibleStore,
          reversible: true,
          sessionTtlMs: 60000,
          verbose: false,
        });
      });

      after(async () => {
        reversiblePlugin.shutdown();
      });

      it("should not redact false positives in reversible mode", async () => {
        await reversiblePlugin.reportFalsePositive({
          value: "fp@test.com",
          ruleId: "email",
          label: "EMAIL",
          path: "$.messages[0].content",
        });

        const ctx = createRequestContext({
          messages: [{ role: "user", content: "Contact fp@test.com and real@test.com" }],
        }, "reversible-session");

        const result = await reversiblePlugin.onRequest(ctx);

        // False positive should not be redacted, real should be
        const content = (result.body as any).messages[0].content;
        assert.ok(content.includes("fp@test.com"));
        assert.ok(content.includes("[EMAIL_"));
        assert.ok(!content.includes("real@test.com"));
      });

      it("should still rehydrate correctly in reversible mode with feedback", async () => {
        await reversiblePlugin.reportFalsePositive({
          value: "fp@test.com",
          ruleId: "email",
          label: "EMAIL",
          path: "$.messages[0].content",
        });

        const ctx = createRequestContext({
          messages: [{ role: "user", content: "My email is fp@test.com and real@test.com" }],
        }, "rehydrate-session");

        const requestResult = await reversiblePlugin.onRequest(ctx);

        // Simulate LLM response with placeholders (as JSON string, like real API response)
        const redactedContent = (requestResult.body as any).messages[0].content;
        const mockResponseBody = JSON.stringify({
          choices: [{ message: { content: `I noted your emails: ${redactedContent}` } }],
        });

        const responseResult = await reversiblePlugin.onResponse({
          ...createRequestContext({}, "rehydrate-session"),
          body: mockResponseBody,
        });

        const responseContent = responseResult.body as string;
        // False positive should remain as-is (never redacted)
        assert.ok(responseContent.includes("fp@test.com"));
        // Real email should be rehydrated
        assert.ok(responseContent.includes("real@test.com"));
      });

      it("should work with streaming rehydration and feedback", async () => {
        await reversiblePlugin.reportFalsePositive({
          value: "fp@test.com",
          ruleId: "email",
          label: "EMAIL",
          path: "$.messages[0].content",
        });

        const ctx = createRequestContext({
          messages: [{ role: "user", content: "Contact fp@test.com and real@test.com" }],
        }, "stream-session");

        const requestResult = await reversiblePlugin.onRequest(ctx);
        const redactedContent = (requestResult.body as any).messages[0].content;

        // False positive should not be redacted, real email should be
        assert.ok(redactedContent.includes("fp@test.com"));
        assert.ok(redactedContent.includes("[EMAIL_"));

        // Simulate streaming chunks
        const chunk1 = Buffer.from(`data: {"choices":[{"delta":{"content":"I see "}}]}\n\n`);
        const chunk2 = Buffer.from(`data: {"choices":[{"delta":{"content":"` + redactedContent + `"}}]}\n\n`);
        const chunk3 = Buffer.from(`data: {"choices":[{"delta":{"content":". Thanks!"}}]}\n\n`);

        const rehydrated1 = await reversiblePlugin.onStreamChunk(chunk1, "stream-session");
        const rehydrated2 = await reversiblePlugin.onStreamChunk(chunk2, "stream-session");
        const rehydrated3 = await reversiblePlugin.onStreamChunk(chunk3, "stream-session");

        const combined = rehydrated1.toString() + rehydrated2.toString() + rehydrated3.toString();
        // False positive should appear as-is (never redacted)
        assert.ok(combined.includes("fp@test.com"));
        // Real email placeholder should be rehydrated
        assert.ok(combined.includes("real@test.com"));
      });
    });

    describe("feedback store persistence across requests", () => {
      it("should persist false positives across multiple requests", async () => {
        await plugin.reportFalsePositive({
          value: "persistent@test.com",
          ruleId: "email",
          label: "EMAIL",
          path: "$.messages[0].content",
        });

        // First request
        const ctx1 = createRequestContext({
          messages: [{ role: "user", content: "Email persistent@test.com" }],
        }, "session-1");
        const result1 = await plugin.onRequest(ctx1);
        assert.ok(((result1.body as any).messages[0].content).includes("persistent@test.com"));

        // Second request (different session)
        const ctx2 = createRequestContext({
          messages: [{ role: "user", content: "Also persistent@test.com" }],
        }, "session-2");
        const result2 = await plugin.onRequest(ctx2);
        assert.ok(((result2.body as any).messages[0].content).includes("persistent@test.com"));
      });

      it("should allow removing false positives", async () => {
        await plugin.reportFalsePositive({
          value: "removable@test.com",
          ruleId: "email",
          label: "EMAIL",
          path: "$.messages[0].content",
        });

        // First request - should not be redacted
        const ctx1 = createRequestContext({
          messages: [{ role: "user", content: "Email removable@test.com" }],
        });
        const result1 = await plugin.onRequest(ctx1);
        assert.ok(((result1.body as any).messages[0].content).includes("removable@test.com"));

        // Remove the false positive
        const store = plugin.getFeedbackStore()!;
        await store.removeFalsePositive("removable@test.com", "email");

        // Second request - should now be redacted
        const ctx2 = createRequestContext({
          messages: [{ role: "user", content: "Email removable@test.com" }],
        });
        const result2 = await plugin.onRequest(ctx2);
        assert.ok(((result2.body as any).messages[0].content).includes("[EMAIL_"));
        assert.ok(!((result2.body as any).messages[0].content).includes("removable@test.com"));
      });

      it("should allow clearing false positives", async () => {
        await plugin.reportFalsePositive({
          value: "clearable@test.com",
          ruleId: "email",
          label: "EMAIL",
          path: "$.messages[0].content",
        });

        // First request - should not be redacted
        const ctx1 = createRequestContext({
          messages: [{ role: "user", content: "Email clearable@test.com" }],
        });
        const result1 = await plugin.onRequest(ctx1);
        assert.ok(((result1.body as any).messages[0].content).includes("clearable@test.com"));

        // Clear all false positives
        const store = plugin.getFeedbackStore()!;
        await store.clear();

        // Second request - should now be redacted
        const ctx2 = createRequestContext({
          messages: [{ role: "user", content: "Email clearable@test.com" }],
        });
        const result2 = await plugin.onRequest(ctx2);
        assert.ok(((result2.body as any).messages[0].content).includes("[EMAIL_"));
        assert.ok(!((result2.body as any).messages[0].content).includes("clearable@test.com"));
      });
    });
  });
}

// Run tests for MemoryFeedbackStore
runRedactFeedbackTests("MemoryFeedbackStore", () => createFeedbackStore("memory"));

// Run tests for SqliteFeedbackStore
describe("SqliteFeedbackStore - createRedactPlugin with FeedbackStore", () => {
  before(async () => {
    await setupTestDb();
  });

  after(async () => {
    await teardownTestDb();
  });

  runRedactFeedbackTests(
    "SqliteFeedbackStore",
    () => createFeedbackStore("sqlite"),
    clearFeedbackTable
  );
});