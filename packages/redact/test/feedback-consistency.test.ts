import { describe, it, beforeEach } from "node:test";
import assert from "node:assert/strict";
import { createFeedbackStore } from "../src/feedback.js";

describe("FeedbackStore session scoping consistency", () => {
  let store: ReturnType<typeof createFeedbackStore>;

  beforeEach(() => {
    store = createFeedbackStore("memory");
  });

  it("should include global entries when sessionId is provided in isFalsePositive", async () => {
    // Add global false positive
    await store.recordFalsePositive({
      value: "global@example.com",
      ruleId: "email-rule",
      label: "EMAIL",
      path: "$.user.email",
      timestamp: Date.now(),
      matchMode: "exact"
    });

    // Add session-specific false positive
    await store.recordFalsePositive({
      value: "session@example.com",
      ruleId: "email-rule",
      label: "EMAIL",
      path: "$.user.email",
      timestamp: Date.now(),
      sessionId: "session-1",
      matchMode: "exact"
    });

    // Both should match when checking with sessionId
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

    // Should return both global and session-specific when sessionId provided
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

    // Clear with sessionId should clear both
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

    // When checking session-1, should see global and session-1, but NOT session-2
    const withSession1 = await store.getAllFalsePositives("email-rule", "session-1");
    assert.equal(withSession1.length, 2);
    const values = withSession1.map(e => e.value).sort();
    assert.deepEqual(values, ["global@example.com", "session1@example.com"]);

    // isFalsePositive should also not match session-2 entries
    assert.equal(await store.isFalsePositive("session2@example.com", "email-rule", "session-1"), false);
    assert.equal(await store.isFalsePositive("session1@example.com", "email-rule", "session-1"), true);
  });
});
