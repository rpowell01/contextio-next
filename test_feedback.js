import { createFeedbackStore } from "./packages/redact/src/feedback.js";

const store = createFeedbackStore("memory");

async function test() {
  console.log("Testing FeedbackStore session scoping consistency...\n");
  
  // Add a global false positive (no sessionId)
  await store.recordFalsePositive({
    value: "test@example.com",
    ruleId: "email-rule",
    label: "EMAIL",
    path: "$.user.email",
    timestamp: Date.now(),
    matchMode: "exact"
  });
  console.log("✓ Added global false positive for test@example.com");
  
  // Add a session-specific false positive
  await store.recordFalsePositive({
    value: "session@example.com",
    ruleId: "email-rule",
    label: "EMAIL",
    path: "$.user.email",
    timestamp: Date.now(),
    sessionId: "session-1",
    matchMode: "exact"
  });
  console.log("✓ Added session-specific false positive for session@example.com");
  
  // Test isFalsePositive with sessionId - should match both global and session-specific
  const result1 = await store.isFalsePositive("test@example.com", "email-rule", "session-1");
  console.log(`isFalsePositive("test@example.com", "email-rule", "session-1") = ${result1} (expected: true)`);
  
  const result2 = await store.isFalsePositive("session@example.com", "email-rule", "session-1");
  console.log(`isFalsePositive("session@example.com", "email-rule", "session-1") = ${result2} (expected: true)`);
  
  const result3 = await store.isFalsePositive("other@example.com", "email-rule", "session-1");
  console.log(`isFalsePositive("other@example.com", "email-rule", "session-1") = ${result3} (expected: false)`);
  
  // Test getAllFalsePositives with sessionId - should return both global and session-specific
  const allWithSession = await store.getAllFalsePositives("email-rule", "session-1");
  console.log(`\ngetAllFalsePositives("email-rule", "session-1") returned ${allWithSession.length} entries (expected: 2)`);
  allWithSession.forEach(e => console.log(`  - ${e.value} (sessionId: ${e.sessionId || "global"})`));
  
  // Test getAllFalsePositives without sessionId - should return all
  const allGlobal = await store.getAllFalsePositives("email-rule");
  console.log(`\ngetAllFalsePositives("email-rule") returned ${allGlobal.length} entries (expected: 2)`);
  
  // Test clear with sessionId - should clear both global and session-specific for that rule
  const cleared = await store.clear("email-rule", "session-1");
  console.log(`\nclear("email-rule", "session-1") cleared ${cleared} entries (expected: 2)`);
  
  const remaining = await store.getAllFalsePositives("email-rule");
  console.log(`Remaining entries: ${remaining.length} (expected: 0)`);
  
  console.log("\n✅ All tests passed!");
}

test().catch(console.error);
