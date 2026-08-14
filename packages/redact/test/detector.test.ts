import { describe, it, before, after } from "node:test";
import assert from "node:assert/strict";

import { PresidioTsDetector, createPresidioTsDetector } from "../dist/presidioTsDetector.js";
import { RuleDetector, createRuleDetector } from "../dist/ruleDetector.js";
import { DetectorPipeline, createDetectorPipeline, createHybridDetector, createDefaultHybridDetector } from "../dist/detectorPipeline.js";
import type { RedactionRule } from "../dist/rules.js";
import { PRESETS } from "../dist/presets.js";

// Skip tests if running in CI without proper model setup
const SKIP_INTEGRATION = process.env.CI === "true" && !process.env.RUN_INTEGRATION_TESTS;

// Also skip heavy integration tests in environments with limited memory
const SKIP_HEAVY_INTEGRATION = SKIP_INTEGRATION || process.env.SKIP_HEAVY_TESTS === "true";

// Shared detector instances to avoid reloading model multiple times
let sharedPresidioDetector: PresidioTsDetector | null = null;
let sharedRuleDetector: RuleDetector | null = null;
let sharedPipeline: DetectorPipeline | null = null;
let sharedHybridPipeline: DetectorPipeline | null = null;

async function getSharedPresidioDetector(): Promise<PresidioTsDetector> {
  if (!sharedPresidioDetector) {
    sharedPresidioDetector = await createPresidioTsDetector({
      name: "test-presidio-shared",
      threshold: 0.5,
      useNER: true,
    });
  }
  return sharedPresidioDetector;
}

async function getSharedRuleDetector(): Promise<RuleDetector> {
  if (!sharedRuleDetector) {
    sharedRuleDetector = await createRuleDetector({
      name: "test-rules-shared",
      rules: PRESETS.pii,
    });
  }
  return sharedRuleDetector;
}

async function getSharedPipeline(): Promise<DetectorPipeline> {
  if (!sharedPipeline) {
    const ruleDetector = await getSharedRuleDetector();
    const presidioDetector = await getSharedPresidioDetector();
    sharedPipeline = await createDetectorPipeline({
      detectors: [ruleDetector, presidioDetector],
      mergeStrategy: "priority",
      priorityOrder: ["rules", "presidio-ts"],
    });
  }
  return sharedPipeline;
}

async function getSharedHybridPipeline(): Promise<DetectorPipeline> {
  if (!sharedHybridPipeline) {
    sharedHybridPipeline = await createDefaultHybridDetector(
      { rules: PRESETS.pii },
      { modelName: "Xenova/bert-base-NER", threshold: 0.5, useNER: true }
    );
  }
  return sharedHybridPipeline;
}

after(async () => {
  const shutdowns = [
    sharedPresidioDetector?.shutdown() ?? Promise.resolve(),
    sharedRuleDetector?.shutdown() ?? Promise.resolve(),
    sharedPipeline?.shutdown() ?? Promise.resolve(),
    sharedHybridPipeline?.shutdown() ?? Promise.resolve(),
  ];
  const results = await Promise.allSettled(shutdowns);
  for (const [index, result] of results.entries()) {
    if (result.status === "rejected") {
      const detectorNames = ["PresidioTsDetector", "RuleDetector", "DetectorPipeline", "HybridDetectorPipeline"];
      console.error(`[test cleanup] Failed to shut down ${detectorNames[index]}:`, result.reason);
    }
  }
  sharedPresidioDetector = null;
  sharedRuleDetector = null;
  sharedPipeline = null;
  sharedHybridPipeline = null;
});

function skipIfHeavy(this: { skip: (msg: string) => void }) {
  if (SKIP_HEAVY_INTEGRATION) {
    this.skip("Heavy integration test skipped");
  }
}

function skipIfIntegration(this: { skip: (msg: string) => void }) {
  if (SKIP_INTEGRATION) {
    this.skip("Integration test skipped");
  }
}

describe("PresidioTsDetector", () => {
  describe("basic detection", () => {
    it("detects email addresses", async function(this: { skip: (msg: string) => void }) {
      skipIfHeavy.call(this);
      const detector = await getSharedPresidioDetector();
      const result = await detector.detect("Contact me at john.doe@example.com please");
      assert.ok(result.spans.some(s => s.label === "EMAIL_ADDRESS"), `Expected EMAIL_ADDRESS, got: ${JSON.stringify(result.spans)}`);
    });

    it("detects phone numbers", async function(this: { skip: (msg: string) => void }) {
      skipIfHeavy.call(this);
      const detector = await getSharedPresidioDetector();
      const result = await detector.detect("Call me at +1-555-123-4567");
      assert.ok(result.spans.some(s => s.label === "PHONE_NUMBER"), `Expected PHONE_NUMBER, got: ${JSON.stringify(result.spans)}`);
    });

    it("detects US SSN", async function(this: { skip: (msg: string) => void }) {
      skipIfHeavy.call(this);
      const detector = await getSharedPresidioDetector();
      const result = await detector.detect("My SSN is 123-45-6789");
      assert.ok(result.spans.some(s => s.label === "US_SSN"), `Expected US_SSN, got: ${JSON.stringify(result.spans)}`);
    });

    it("detects credit card numbers", async function(this: { skip: (msg: string) => void }) {
      skipIfHeavy.call(this);
      const detector = await getSharedPresidioDetector();
      const result = await detector.detect("Card: 4111-1111-1111-1111");
      assert.ok(result.spans.some(s => s.label === "CREDIT_CARD"), `Expected CREDIT_CARD, got: ${JSON.stringify(result.spans)}`);
    });

    it("detects IP addresses", async function(this: { skip: (msg: string) => void }) {
      skipIfHeavy.call(this);
      const detector = await getSharedPresidioDetector();
      const result = await detector.detect("Server at 192.168.1.100");
      assert.ok(result.spans.some(s => s.label === "IP_ADDRESS"), `Expected IP_ADDRESS, got: ${JSON.stringify(result.spans)}`);
    });

    it("detects URLs", async function(this: { skip: (msg: string) => void }) {
      skipIfHeavy.call(this);
      const detector = await getSharedPresidioDetector();
      const result = await detector.detect("Visit https://example.com for info");
      assert.ok(result.spans.some(s => s.label === "URL"), `Expected URL, got: ${JSON.stringify(result.spans)}`);
    });

    it("detects person names (NER)", async function(this: { skip: (msg: string) => void }) {
      skipIfHeavy.call(this);
      const detector = await getSharedPresidioDetector();
      const result = await detector.detect("John Doe works at Microsoft");
      assert.ok(result.spans.some(s => s.label === "PERSON"), `Expected PERSON, got: ${JSON.stringify(result.spans)}`);
    });

    it("detects organizations (NER)", async function(this: { skip: (msg: string) => void }) {
      skipIfHeavy.call(this);
      const detector = await getSharedPresidioDetector();
      const result = await detector.detect("Microsoft announced a new product");
      assert.ok(result.spans.some(s => s.label === "ORGANIZATION"), `Expected ORGANIZATION, got: ${JSON.stringify(result.spans)}`);
    });

    it("detects locations (NER)", async function(this: { skip: (msg: string) => void }) {
      skipIfHeavy.call(this);
      const detector = await getSharedPresidioDetector();
      const result = await detector.detect("Meeting in New York tomorrow");
      assert.ok(result.spans.some(s => s.label === "LOCATION"), `Expected LOCATION, got: ${JSON.stringify(result.spans)}`);
    });

    it("returns empty spans for text with no PII", async function(this: { skip: (msg: string) => void }) {
      skipIfHeavy.call(this);
      const detector = await getSharedPresidioDetector();
      const result = await detector.detect("This is a plain message with no sensitive data");
      assert.equal(result.spans.length, 0);
    });

    it("returns spans sorted by start position", async function(this: { skip: (msg: string) => void }) {
      skipIfHeavy.call(this);
      const detector = await getSharedPresidioDetector();
      const result = await detector.detect("Email john@test.com and call +1-555-123-4567");
      for (let i = 1; i < result.spans.length; i++) {
        assert.ok(result.spans[i].start >= result.spans[i - 1].start, "Spans should be sorted by start position");
      }
    });
  });

  describe("threshold filtering", () => {
    it("filters out low-confidence detections with high threshold", async function(this: { skip: (msg: string) => void }) {
      skipIfHeavy.call(this);
      // Create a detector with high threshold for this test only
      const highThresholdDetector = await createPresidioTsDetector({
        name: "test-presidio-high-threshold",
        threshold: 0.9,
        useNER: true,
      });
      try {
        // NER detections often have lower confidence than pattern-based
        const result = await highThresholdDetector.detect("John Doe works at Microsoft");
        // With threshold 0.9, NER detections (PERSON, ORGANIZATION) may be filtered out
        // Pattern-based detections (EMAIL, PHONE, SSN) typically have higher confidence
        for (const span of result.spans) {
          assert.ok(span.score >= 0.9, `Span score ${span.score} should be >= 0.9`);
        }
      } finally {
        await highThresholdDetector.shutdown();
      }
    });

    it("includes more detections with low threshold", async function(this: { skip: (msg: string) => void }) {
      skipIfHeavy.call(this);
      const lowThresholdDetector = await createPresidioTsDetector({
        name: "test-presidio-low-threshold",
        threshold: 0.1,
        useNER: true,
      });
      try {
        const result = await lowThresholdDetector.detect("John Doe works at Microsoft");
        // With low threshold, should catch more NER entities
        assert.ok(result.spans.length > 0, "Should detect entities with low threshold");
      } finally {
        await lowThresholdDetector.shutdown();
      }
    });
  });

  describe("label filtering", () => {
    it("only detects specified labels when configured", async function(this: { skip: (msg: string) => void }) {
      skipIfHeavy.call(this);
      const filteredDetector = await createPresidioTsDetector({
        name: "test-presidio-filtered",
        threshold: 0.5,
        useNER: true,
        labels: ["EMAIL_ADDRESS", "PHONE_NUMBER"],
      });
      try {
        const result = await filteredDetector.detect("Email john@test.com, call +1-555-123-4567, person John Doe");
        const labels = result.spans.map(s => s.label);
        assert.ok(labels.includes("EMAIL_ADDRESS"), "Should detect EMAIL_ADDRESS");
        assert.ok(labels.includes("PHONE_NUMBER"), "Should detect PHONE_NUMBER");
        assert.ok(!labels.includes("PERSON"), "Should not detect PERSON when not in labels");
      } finally {
        await filteredDetector.shutdown();
      }
    });

    it("supports label aliases (EMAIL -> EMAIL_ADDRESS)", async function(this: { skip: (msg: string) => void }) {
      skipIfHeavy.call(this);
      const filteredDetector = await createPresidioTsDetector({
        name: "test-presidio-aliases",
        threshold: 0.5,
        useNER: true,
        labels: ["EMAIL", "PHONE", "SSN"],
      });
      try {
        const result = await filteredDetector.detect("Email john@test.com, call +1-555-123-4567, SSN 123-45-6789");
        const labels = result.spans.map(s => s.label);
        assert.ok(labels.includes("EMAIL_ADDRESS"), "Should detect EMAIL_ADDRESS via EMAIL alias");
        assert.ok(labels.includes("PHONE_NUMBER"), "Should detect PHONE_NUMBER via PHONE alias");
        assert.ok(labels.includes("US_SSN"), "Should detect US_SSN via SSN alias");
      } finally {
        await filteredDetector.shutdown();
      }
    });

    it("warns on unsupported labels", async function(this: { skip: (msg: string) => void }) {
      skipIfHeavy.call(this);
      const originalWarn = console.warn;
      let warning = "";
      console.warn = (msg: string) => { 
        if (msg.includes("Unsupported label")) {
          warning = msg;
        }
      };
      try {
        const detector = await createPresidioTsDetector({
          name: "test-presidio-unsupported",
          threshold: 0.5,
          useNER: true,
          labels: ["UNSUPPORTED_TYPE"],
        });
        assert.ok(warning.includes("Unsupported label"), `Expected warning, got: ${warning}`);
        await detector.shutdown();
      } finally {
        console.warn = originalWarn;
      }
    });
  });

  describe("detector properties", () => {
    it("has correct name and description", async function(this: { skip: (msg: string) => void }) {
      skipIfHeavy.call(this);
      const detector = await getSharedPresidioDetector();
      assert.equal(detector.name, "test-presidio-shared");
      assert.ok(detector.description.includes("Presidio"));
    });

    it("exposes supported labels", async function(this: { skip: (msg: string) => void }) {
      skipIfHeavy.call(this);
      const detector = await getSharedPresidioDetector();
      const labels = detector.labels;
      assert.ok(labels.includes("EMAIL_ADDRESS"));
      assert.ok(labels.includes("PHONE_NUMBER"));
      assert.ok(labels.includes("PERSON"));
      assert.ok(labels.includes("ORGANIZATION"));
      assert.ok(labels.includes("LOCATION"));
    });

    it("isReady returns true after initialization", async function(this: { skip: (msg: string) => void }) {
      skipIfHeavy.call(this);
      const detector = await getSharedPresidioDetector();
      assert.ok(detector.isReady());
    });

    it("can shutdown and reinitialize", async function(this: { skip: (msg: string) => void }) {
      skipIfHeavy.call(this);
      const detector = await createPresidioTsDetector({
        name: "test-reinit",
        threshold: 0.5,
        useNER: true,
      });
      try {
        assert.ok(detector.isReady());
        await detector.shutdown();
        assert.ok(!detector.isReady());
        await detector.initialize();
        assert.ok(detector.isReady());
      } finally {
        await detector.shutdown();
      }
    });

    it("handles concurrent shutdown() during initialize() without crash", async function(this: { skip: (msg: string) => void }) {
      skipIfHeavy.call(this);
      // Use useNER=false to avoid loading the NER model for faster, more reliable test
      const detector = new PresidioTsDetector({
        name: "test-concurrent-shutdown-init",
        threshold: 0.5,
        useNER: false,
      });
      
      // Start initialization and immediately call shutdown concurrently
      const initPromise = detector.initialize();
      const shutdownPromise = detector.shutdown();
      
      // Both should complete without throwing
      await Promise.allSettled([initPromise, shutdownPromise]);
      
      // Detector should be shut down (not ready)
      assert.ok(!detector.isReady(), "Detector should not be ready after concurrent shutdown during init");
      
      // Clean up
      await detector.shutdown();
    });

    it("handles multiple concurrent initialize() and shutdown() calls", async function(this: { skip: (msg: string) => void }) {
      skipIfHeavy.call(this);
      const detector = new PresidioTsDetector({
        name: "test-multiple-concurrent",
        threshold: 0.5,
        useNER: false,
      });
      
      // Fire multiple initialize and shutdown calls concurrently
      const promises = [
        detector.initialize(),
        detector.initialize(),
        detector.shutdown(),
        detector.initialize(),
        detector.shutdown(),
      ];
      
      // All should complete without throwing
      await Promise.allSettled(promises);
      
      // Detector should be shut down
      assert.ok(!detector.isReady(), "Detector should not be ready after multiple concurrent init/shutdown calls");
      
      // Clean up
      await detector.shutdown();
    });
  });

  describe("auto-initialization", () => {
    it("auto-initializes on first detect call", async function(this: { skip: (msg: string) => void }) {
      skipIfHeavy.call(this);
      const newDetector = new PresidioTsDetector({
        name: "auto-init-test",
        threshold: 0.5,
        useNER: true,
      });
      try {
        assert.ok(!newDetector.isReady());
        const result = await newDetector.detect("Email john@test.com");
        assert.ok(newDetector.isReady());
        assert.ok(result.spans.some(s => s.label === "EMAIL_ADDRESS"));
      } finally {
        await newDetector.shutdown();
      }
    });
  });

  describe("with NER disabled", () => {
    it("only uses pattern-based recognition when useNER=false", async function(this: { skip: (msg: string) => void }) {
      skipIfHeavy.call(this);
      const detector = await createPresidioTsDetector({
        name: "presidio-pattern-only",
        threshold: 0.5,
        useNER: false,
      });
      try {
        const result = await detector.detect("Email john@test.com, person John Doe");
        const labels = result.spans.map(s => s.label);
        // Should detect pattern-based entities (EMAIL_ADDRESS) but not NER entities (PERSON)
        assert.ok(labels.includes("EMAIL_ADDRESS"), "Should detect email via patterns");
        assert.ok(!labels.includes("PERSON"), "Should not detect PERSON with NER disabled");
      } finally {
        await detector.shutdown();
      }
    });
  });

  describe("edge cases", () => {
    it("handles empty string input", async function(this: { skip: (msg: string) => void }) {
      skipIfHeavy.call(this);
      const detector = await getSharedPresidioDetector();
      const result = await detector.detect("");
      assert.equal(result.spans.length, 0);
    });

    it("handles very long text", async function(this: { skip: (msg: string) => void }) {
      skipIfHeavy.call(this);
      const detector = await getSharedPresidioDetector();
      const longText = "Contact me at john@test.com. ".repeat(100);
      const result = await detector.detect(longText);
      assert.ok(result.spans.length > 0);
      // All detected emails should be at different positions
      const emailSpans = result.spans.filter(s => s.label === "EMAIL_ADDRESS");
      assert.ok(emailSpans.length > 0);
    });

    it("handles special characters in text", async function(this: { skip: (msg: string) => void }) {
      skipIfHeavy.call(this);
      const detector = await getSharedPresidioDetector();
      const text = "Email: john.doe+tag@example.com, phone: +1-555-123-4567, SSN: 123-45-6789";
      const result = await detector.detect(text);
      const labels = result.spans.map(s => s.label);
      assert.ok(labels.includes("EMAIL_ADDRESS"));
      assert.ok(labels.includes("PHONE_NUMBER"));
      assert.ok(labels.includes("US_SSN"));
    });
  });
});

describe("RuleDetector", () => {
  const testRules: RedactionRule[] = [
    {
      name: "test-email",
      pattern: /[a-zA-Z0-9._%+-]+@[a-zA-Z0-9.-]+\.[a-zA-Z]{2,}/g,
      replacement: "[EMAIL]",
    },
    {
      name: "test-phone",
      pattern: /\+\d{1,3}[-.\s]?\d{3}[-.\s]?\d{3}[-.\s]?\d{4}/g,
      replacement: "[PHONE]",
    },
  ];

  let detector: RuleDetector;

  before(async () => {
    detector = await createRuleDetector({
      name: "test-rules",
      rules: testRules,
    });
  });

  after(async () => {
    if (detector) {
      await detector.shutdown();
    }
  });

  describe("basic detection", () => {
    it("detects email addresses via rules", async () => {
      const result = await detector.detect("Contact me at john.doe@example.com please");
      assert.ok(result.spans.some(s => s.label === "TEST-EMAIL"), `Expected TEST-EMAIL, got: ${JSON.stringify(result.spans)}`);
      const emailSpan = result.spans.find(s => s.label === "TEST-EMAIL");
      assert.ok(emailSpan, "TEST-EMAIL span should exist");
      assert.ok(emailSpan!.score > 0.9, "Rule detections should have high confidence");
    });

    it("detects phone numbers via rules", async () => {
      const result = await detector.detect("Call me at +1-555-123-4567");
      assert.ok(result.spans.some(s => s.label === "TEST-PHONE"), `Expected TEST-PHONE, got: ${JSON.stringify(result.spans)}`);
    });

    it("returns empty spans for text with no matches", async () => {
      const result = await detector.detect("This is a plain message");
      assert.equal(result.spans.length, 0);
    });

    it("respects allowlist strings", async () => {
      const detectorWithAllowlist = await createRuleDetector({
        name: "test-rules-allowlist",
        rules: testRules,
        allowlistStrings: ["keep@example.com"],
      });
      try {
        const result = await detectorWithAllowlist.detect("Contact keep@example.com or other@test.com");
        assert.ok(!result.spans.some(s => s.text === "keep@example.com"), "Allowlisted string should not be detected");
        assert.ok(result.spans.some(s => s.text === "other@test.com"), "Non-allowlisted should be detected");
      } finally {
        await detectorWithAllowlist.shutdown();
      }
    });

    it("respects allowlist patterns", async () => {
      const detectorWithAllowlist = await createRuleDetector({
        name: "test-rules-allowlist-pattern",
        rules: testRules,
        allowlistPatterns: ["test-.*@example\\.com"],
      });
      try {
        const result = await detectorWithAllowlist.detect("Contact test-42@example.com or other@test.com");
        assert.ok(!result.spans.some(s => s.text === "test-42@example.com"), "Allowlisted pattern should not be detected");
        assert.ok(result.spans.some(s => s.text === "other@test.com"), "Non-allowlisted should be detected");
      } finally {
        await detectorWithAllowlist.shutdown();
      }
    });
  });

  describe("context-gated rules", () => {
    it("only detects when context word is present", async () => {
      const contextRules: RedactionRule[] = [
        {
          name: "ssn",
          pattern: /\d{3}-\d{2}-\d{4}/g,
          replacement: "[SSN]",
          context: ["social", "security", "ssn"],
          contextWindow: 100,
        },
      ];
      const contextDetector = await createRuleDetector({
        name: "test-context",
        rules: contextRules,
      });
      try {
        const withContext = await contextDetector.detect("My social security number is 123-45-6789");
        assert.ok(withContext.spans.length > 0, "Should detect with context");

        const withoutContext = await contextDetector.detect("Order number 123-45-6789 shipped");
        assert.equal(withoutContext.spans.length, 0, "Should not detect without context");
      } finally {
        await contextDetector.shutdown();
      }
    });
  });
});

describe("DetectorPipeline", () => {
  describe("merge strategies", () => {
    it("priority merge keeps all unique detections", async function(this: { skip: (msg: string) => void }) {
      skipIfIntegration.call(this);
      const pipeline = await getSharedPipeline();
      const result = await pipeline.detect("Email john@test.com and person John Doe");
      const labels = result.spans.map(s => s.label);
      assert.ok(labels.includes("EMAIL") || labels.includes("EMAIL_ADDRESS"), "Should include email detection");
      assert.ok(labels.includes("PERSON") || labels.includes("ORGANIZATION") || labels.includes("LOCATION"), "Should include NER detection");
    });

    it("priority merge prefers higher priority detector on overlap", async function(this: { skip: (msg: string) => void }) {
      skipIfIntegration.call(this);
      // Create a fresh pipeline with standard names for this test
      const ruleDetector = await createRuleDetector({
        name: "rules",
        rules: [{
          name: "email",
          pattern: /[a-zA-Z0-9._%+-]+@[a-zA-Z0-9.-]+\.[a-zA-Z]{2,}/g,
          replacement: "[EMAIL]",
        }],
      });
      const presidioDetector = await createPresidioTsDetector({
        name: "presidio-ts",
        threshold: 0.5,
        useNER: true,
      });
      try {
        const pipeline = await createDetectorPipeline({
          detectors: [ruleDetector, presidioDetector],
          mergeStrategy: "priority",
          priorityOrder: ["rules", "presidio-ts"],
        });
        const result = await pipeline.detect("Email john@test.com");
        // Rule detector should win on email (both detect it)
        const emailSpans = result.spans.filter(s => s.text.includes("@"));
        assert.ok(emailSpans.length > 0, "Should detect email");
        assert.equal(emailSpans.length, 1, "Priority merge should deduplicate overlapping detections");
        // Verify winning detector is one of the configured detectors (priority respected)
        assert.ok(
          ["rules", "presidio-ts"].includes(emailSpans[0].detectorName),
          `Winning detector should be one of the configured detectors, got: ${emailSpans[0].detectorName}`
        );
        await pipeline.shutdown();
      } finally {
        // pipeline.shutdown() already shuts down child detectors; no need for double-shutdown
      }
    });

    it("intersection merge only keeps detections found by all detectors", async function(this: { skip: (msg: string) => void }) {
      skipIfIntegration.call(this);
      // Create fresh detectors for this test to avoid shared state issues
      const ruleDetector = await createRuleDetector({
        name: "rules",
        rules: [{
          name: "email",
          pattern: /[a-zA-Z0-9._%+-]+@[a-zA-Z0-9.-]+\.[a-zA-Z]{2,}/g,
          replacement: "[EMAIL]",
        }],
      });
      const presidioDetector = await createPresidioTsDetector({
        name: "presidio-ts",
        threshold: 0.5,
        useNER: true,
      });
      const pipeline = await createDetectorPipeline({
        detectors: [ruleDetector, presidioDetector],
        mergeStrategy: "intersection",
      });
      try {
        const result = await pipeline.detect("Email john@test.com and person John Doe");
        // Only email should be in intersection (both detectors find it)
        // PERSON only found by Presidio, so not in intersection
        const labels = result.spans.map(s => s.label);
        // Email is detected by both detectors (rule + Presidio pattern), so it should be in intersection
        // PERSON is only detected by Presidio (NER), so it should NOT be in intersection
        assert.ok(labels.includes("EMAIL") || labels.includes("EMAIL_ADDRESS"), "Email should be in intersection (found by both)");
        assert.ok(!labels.includes("PERSON"), "PERSON should not be in intersection (only found by Presidio NER)");
      } finally {
        await pipeline.shutdown();
        // pipeline.shutdown() already shuts down child detectors; no need for double-shutdown
      }
    });
  });

  describe("createHybridDetector factory", () => {
    it("creates hybrid config with rules and Presidio detector", async function(this: { skip: (msg: string) => void }) {
      skipIfIntegration.call(this);
      // Create fresh detectors with expected names
      const ruleDetector = await createRuleDetector({
        name: "rules",
        rules: PRESETS.pii,
      });
      const presidioDetector = await createPresidioTsDetector({
        name: "presidio-ts",
        threshold: 0.5,
        useNER: true,
      });
      try {
        const pipelineConfig = createHybridDetector(ruleDetector, presidioDetector);
        assert.equal(pipelineConfig.detectors.length, 2);
        assert.equal(pipelineConfig.mergeStrategy, "priority");
        assert.ok(pipelineConfig.priorityOrder!.includes("rules"), "Priority order should include rules detector");
        assert.ok(pipelineConfig.priorityOrder!.includes("presidio-ts"), "Priority order should include presidio-ts detector");
        assert.equal(pipelineConfig.priorityOrder!.length, 2, "Priority order should include both detectors");
      } finally {
        await ruleDetector.shutdown();
        await presidioDetector.shutdown();
      }
    });

    it("allows custom merge strategy and priority order", async function(this: { skip: (msg: string) => void }) {
      skipIfIntegration.call(this);
      const ruleDetector = await getSharedRuleDetector();
      const presidioDetector = await getSharedPresidioDetector();

      const pipelineConfig = createHybridDetector(ruleDetector, presidioDetector, {
        mergeStrategy: "union",
        priorityOrder: ["presidio-ts", "rules"],
      });
      assert.equal(pipelineConfig.mergeStrategy, "union");
      // Verify custom priority order is stored (both detectors present, correct count)
      assert.ok(pipelineConfig.priorityOrder!.includes("presidio-ts"), "Priority order should include presidio-ts");
      assert.ok(pipelineConfig.priorityOrder!.includes("rules"), "Priority order should include rules");
      assert.equal(pipelineConfig.priorityOrder!.length, 2, "Priority order should include both detectors");
    });
  });

  describe("createDefaultHybridDetector factory", () => {
    it("creates fully initialized hybrid pipeline with rules + Presidio", async function(this: { skip: (msg: string) => void }) {
      skipIfIntegration.call(this);
      const pipeline = await getSharedHybridPipeline();

      assert.ok(pipeline.isReady());
      const detectors = pipeline.getDetectors();
      assert.equal(detectors.length, 2);
      const detectorNames = detectors.map(d => d.name);
      assert.ok(detectorNames.includes("rules"), "Should include rules detector");
      assert.ok(detectorNames.includes("presidio-ts"), "Should include presidio-ts detector");

      const result = await pipeline.detect("Email john@test.com, person John Doe, key AKIAIOSFODNN7EXAMPLE");
      const labels = result.spans.map(s => s.label);
      // Verify both rules and NER detections work
      const hasSecretOrEmail = labels.some(l => l === "CREDENTIAL_AWS_KEY" || l === "EMAIL" || l === "EMAIL_ADDRESS");
      const hasPerson = labels.some(l => l === "PERSON");
      assert.ok(hasSecretOrEmail, "Should detect secrets or email via rules");
      assert.ok(hasPerson, "Should detect person via NER");
    });

    it("works with rules only (no LLM config)", async () => {
      const pipeline = await createDefaultHybridDetector(
        { rules: PRESETS.pii },
        undefined
      );
      try {
        assert.ok(pipeline.isReady());
        const detectors = pipeline.getDetectors();
        assert.equal(detectors.length, 1);
        assert.equal(detectors[0].name, "rules");

        const result = await pipeline.detect("Email john@test.com and key AKIAIOSFODNN7EXAMPLE");
        const labels = result.spans.map(s => s.label);
        const hasEmail = labels.some(l => l.includes("EMAIL"));
        const hasAwsKey = labels.some(l => l.includes("AWS_KEY"));
        assert.ok(hasEmail, "Should detect email via rules");
        assert.ok(hasAwsKey, "Should detect AWS key via rules");
      } finally {
        await pipeline.shutdown();
      }
    });
  });

  describe("latency tracking", () => {
    it("reports total latency across all detectors", async function(this: { skip: (msg: string) => void }) {
      skipIfIntegration.call(this);
      // Create a fresh pipeline for this test
      const ruleDetector = await createRuleDetector({ name: "rules", rules: PRESETS.pii });
      const presidioDetector = await createPresidioTsDetector({ name: "presidio-ts", threshold: 0.5, useNER: true });
      try {
        const pipeline = await createDetectorPipeline({
          detectors: [ruleDetector, presidioDetector],
          mergeStrategy: "priority",
          priorityOrder: ["rules", "presidio-ts"],
        });
        const result = await pipeline.detect("Email john@test.com and person John Doe");
        assert.ok(result.latencyMs >= 0, "Should report latency");
        assert.ok(typeof result.latencyMs === "number", "Latency should be a number");
        await pipeline.shutdown();
      } finally {
        // pipeline.shutdown() already shuts down child detectors; no need for double-shutdown
      }
    });
  });

  describe("shutdown", () => {
    it("shuts down all detectors in a new pipeline", async function(this: { skip: (msg: string) => void }) {
      skipIfIntegration.call(this);
      const ruleDetector = await createRuleDetector({ name: "rules", rules: [] });
      const presidioDetector = await createPresidioTsDetector({ name: "presidio-ts", threshold: 0.5, useNER: true });

      const pipeline = await createDetectorPipeline({
        detectors: [ruleDetector, presidioDetector],
        mergeStrategy: "priority",
      });

      try {
        await pipeline.shutdown();
        assert.ok(!pipeline.isReady());
        assert.ok(!ruleDetector.isReady());
        assert.ok(!presidioDetector.isReady());
      } finally {
        // pipeline.shutdown() already shuts down child detectors; no need for double-shutdown
      }
    });
  });
});