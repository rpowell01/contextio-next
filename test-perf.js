#!/usr/bin/env node
/**
 * Performance test script for redaction API endpoints.
 * Creates test capture files and measures API response times.
 */

import fs from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";

const TEST_DIR = join(tmpdir(), `contextio-perf-test-${Date.now()}`);
const CAPTURE_DIR = join(TEST_DIR, "captures");

const CAPTURE_COUNTS = [100, 1000, 10000];
const PAGE_SIZE = 50;

// Generate a sample capture file
function generateCapture(index, sessionId) {
  const providers = ["anthropic", "openai", "gemini"];
  const sources = ["cli", "vscode", "web"];
  const rules = ["email", "ssn", "api_key", "credit_card"];

  const provider = providers[index % providers.length];
  const source = sources[index % sources.length];
  const numRedactions = (index % 5) + 1;

  const byRule = {};
  for (let i = 0; i < numRedactions; i++) {
    byRule[rules[i % rules.length]] = (byRule[rules[i % rules.length]] ?? 0) + 1;
  }

  const totalRedactions = Object.values(byRule).reduce((a, b) => a + b, 0);

  return {
    sessionId,
    source,
    provider,
    apiFormat: "messages",
    targetUrl: `https://api.${provider}.com/v1/messages`,
    method: "POST",
    requestBytes: 1024,
    responseBytes: 2048,
    responseStatus: 200,
    responseIsStreaming: false,
    timestamp: new Date(Date.now() - index * 1000).toISOString(),
    timings: { send_ms: 10, wait_ms: 100, receive_ms: 50, total_ms: 160 },
    requestBody: { messages: [{ role: "user", content: "Test message" }] },
    responseBody: '{"id":"msg_123","type":"message","role":"assistant","content":[{"type":"text","text":"Response"}]}',
    redactionStats: { totalRedactions, byRule },
    originalRequestBody: { messages: [{ role: "user", content: "Test message" }] }
  };
}

// Generate metadata file
function generateMeta(captureId, capture) {
  return {
    schemaVersion: "1",
    captureId,
    sessionId: capture.sessionId,
    timestamp: capture.timestamp,
    provider: capture.provider,
    targetUrl: capture.targetUrl,
    totalRedactions: capture.redactionStats.totalRedactions,
    byRule: capture.redactionStats.byRule,
    generatedAt: new Date().toISOString()
  };
}

async function setupTestFiles(count) {
  console.log(`\n=== Setting up ${count} test files ===`);
  await fs.mkdir(CAPTURE_DIR, { recursive: true });

  const sessionId = "test-session-12345";
  const startTime = Date.now();

  // Batch write for performance
  const batchSize = 100;
  for (let i = 0; i < count; i += batchSize) {
    const batchEnd = Math.min(i + batchSize, count);
    const promises = [];

    for (let j = i; j < batchEnd; j++) {
      const capture = generateCapture(j, sessionId);
      const filename = `${sessionId}-${Date.now() + j}-${j}.json`;
      const metaFilename = `${sessionId}-${Date.now() + j}-${j}.redact-meta.json`;

      promises.push(
        fs.writeFile(join(CAPTURE_DIR, filename), JSON.stringify(capture, null, 2)),
        fs.writeFile(join(CAPTURE_DIR, metaFilename), JSON.stringify(generateMeta(filename.replace(".json", ""), capture), null, 2))
      );
    }

    await Promise.all(promises);

    if (count >= 1000 && (batchEnd % 1000) === 0) {
      console.log(`  Created ${batchEnd}/${count} files...`);
    }
  }

  const elapsed = Date.now() - startTime;
  console.log(`  Created ${count} capture + ${count} meta files in ${elapsed}ms`);
  return elapsed;
}

async function cleanupTestFiles() {
  try {
    await fs.rm(TEST_DIR, { recursive: true, force: true });
    console.log("\nCleaned up test directory");
  } catch {
    // ignore
  }
}

// Test API endpoint
async function testEndpoint(port, path, params = {}) {
  const query = new URLSearchParams(params).toString();
  const url = `http://localhost:${port}${path}${query ? "?" + query : ""}`;

  const start = performance.now();
  try {
    const response = await fetch(url);
    const json = await response.json();
    const elapsed = performance.now() - start;
    return { success: true, elapsed, status: response.status, json };
  } catch (error) {
    return { success: false, elapsed: performance.now() - start, error: String(error) };
  }
}

async function runBenchmarks() {
  const PORT = 3001; // Dev server port

  console.log("\n=== Performance Benchmark ===");
  console.log(`Testing against http://localhost:${PORT}`);
  console.log("Make sure dev server is running: pnpm dev\n");

  const results = [];

  for (const count of CAPTURE_COUNTS) {
    await cleanupTestFiles();
    await setupTestFiles(count);

    // Wait a moment for file watchers
    await new Promise(r => setTimeout(r, 1000));

    // Test summary endpoint
    console.log(`\n--- Testing /api/redactions?summary=true with ${count} captures ---`);
    const summaryTimes = [];
    for (let i = 0; i < 5; i++) {
      const result = await testEndpoint(PORT, "/api/redactions", { summary: "true" });
      if (result.success) {
        summaryTimes.push(result.elapsed);
        console.log(`  Run ${i + 1}: ${result.elapsed.toFixed(2)}ms (total: ${result.json.summary?.totalRedactions}, types: ${Object.keys(result.json.summary?.byType ?? {}).length})`);
      } else {
        console.log(`  Run ${i + 1}: FAILED - ${result.error}`);
      }
      await new Promise(r => setTimeout(r, 100));
    }

    const avgSummary = summaryTimes.reduce((a, b) => a + b, 0) / summaryTimes.length;
    console.log(`  Average: ${avgSummary.toFixed(2)}ms`);

    // Test paginated detail endpoint
    console.log(`\n--- Testing /api/redactions/detail?page=1&pageSize=${PAGE_SIZE} ---`);
    const detailTimes = [];
    for (let i = 0; i < 3; i++) {
      const result = await testEndpoint(PORT, "/api/redactions/detail", { page: "1", pageSize: String(PAGE_SIZE) });
      if (result.success) {
        detailTimes.push(result.elapsed);
        console.log(`  Run ${i + 1}: ${result.elapsed.toFixed(2)}ms (details: ${result.json.details?.length}, total: ${result.json.totalCount})`);
      } else {
        console.log(`  Run ${i + 1}: FAILED - ${result.error}`);
      }
      await new Promise(r => setTimeout(r, 100));
    }

    const avgDetail = detailTimes.reduce((a, b) => a + b, 0) / detailTimes.length;
    console.log(`  Average: ${avgDetail.toFixed(2)}ms`);

    // Test sessions API with groupBySourceDest
    console.log(`\n--- Testing /api/sessions?groupBySourceDest=true ---`);
    const sessionTimes = [];
    for (let i = 0; i < 3; i++) {
      const result = await testEndpoint(PORT, "/api/sessions", { groupBySourceDest: "true" });
      if (result.success) {
        sessionTimes.push(result.elapsed);
        console.log(`  Run ${i + 1}: ${result.elapsed.toFixed(2)}ms (summaries: ${result.json.summaries?.length})`);
      } else {
        console.log(`  Run ${i + 1}: FAILED - ${result.error}`);
      }
      await new Promise(r => setTimeout(r, 100));
    }

    const avgSession = sessionTimes.reduce((a, b) => a + b, 0) / sessionTimes.length;
    console.log(`  Average: ${avgSession.toFixed(2)}ms`);

    results.push({ count, avgSummary, avgDetail, avgSession });
  }

  await cleanupTestFiles();

  // Print summary table
  console.log("\n=== SUMMARY ===");
  console.log("| Captures | Summary (ms) | Detail (ms) | Sessions (ms) |");
  console.log("|----------|--------------|-------------|---------------|");
  for (const r of results) {
    console.log(`| ${r.count.toString().padStart(8)} | ${r.avgSummary.toFixed(2).padStart(12)} | ${r.avgDetail.toFixed(2).padStart(11)} | ${r.avgSession.toFixed(2).padStart(13)} |`);
  }

  console.log("\n=== TARGETS ===");
  console.log("| Metric                    | Target   |");
  console.log("|---------------------------|----------|");
  console.log("| Summary endpoint (10k)   | < 50ms   |");
  console.log("| Sessions list (10k)       | < 100ms  |");
  console.log("| Dashboard total load      | < 500ms  |");

  // Check targets
  const tenK = results.find(r => r.count === 10000);
  if (tenK) {
    console.log("\n=== VERIFICATION ===");
    console.log(`Summary (10k): ${tenK.avgSummary.toFixed(2)}ms ${tenK.avgSummary < 50 ? "✅ PASS" : "❌ FAIL"} (< 50ms)`);
    console.log(`Sessions (10k): ${tenK.avgSession.toFixed(2)}ms ${tenK.avgSession < 100 ? "✅ PASS" : "❌ FAIL"} (< 100ms)`);
  }
}

runBenchmarks().catch(console.error);