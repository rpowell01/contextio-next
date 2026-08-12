/**
 * Verification script for contextio-mol-stj: Verify end-to-end integration with proxy
 */

import http from "node:http";
import { createProxy } from "./packages/proxy/dist/proxy.js";
import { createRedactPlugin, PRESETS } from "./packages/redact/dist/index.js";
import { getDb, initConnection, closeDb, upsertSettings, upsertRedactionMetadata, getRedactionMetadataByCaptureId } from "./packages/core/dist/db/index.js";
import fs from "node:fs";
import path from "node:path";
import os from "node:os";

const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "contextio-verify-"));
const testDbPath = path.join(tempDir, "test.db");

function cleanup() {
  try { closeDb(); } catch {}
  try { fs.rmSync(tempDir, { recursive: true, force: true }); } catch {}
}

process.on("exit", cleanup);
process.on("SIGINT", () => { cleanup(); process.exit(0); });

process.env.CONTEXTIO_DB_PATH = testDbPath;
const db = initConnection();

// Create all tables directly, skipping the migration system
db.exec(`
  CREATE TABLE IF NOT EXISTS captures_metadata (
    id TEXT PRIMARY KEY, session_id TEXT NOT NULL, filepath TEXT NOT NULL UNIQUE,
    timestamp INTEGER NOT NULL, request_model TEXT, response_model TEXT,
    tokens_prompt INTEGER, tokens_completion INTEGER, duration_ms INTEGER,
    status TEXT, created_at INTEGER DEFAULT (strftime('%s','now')*1000)
  );
  CREATE TABLE IF NOT EXISTS providers (
    id TEXT PRIMARY KEY, name TEXT NOT NULL, upstream_url TEXT NOT NULL,
    api_format TEXT NOT NULL, auth_type TEXT NOT NULL, enabled INTEGER NOT NULL DEFAULT 1,
    rate_limit_max_requests INTEGER, rate_limit_window_ms INTEGER,
    rate_limit_buffer_capacity INTEGER, retry_max_retries INTEGER,
    retry_base_delay_ms INTEGER, retry_max_delay_ms INTEGER,
    retry_retryable_statuses TEXT, retry_jitter_factor REAL,
    retry_max_stream_retries INTEGER, retry_max_response_buffer_size INTEGER,
    retry_enabled INTEGER, custom_headers TEXT,
    allow_base_url_override INTEGER DEFAULT 1, base_url_override_header TEXT,
    source TEXT NOT NULL, dynamic INTEGER NOT NULL DEFAULT 0,
    created_at INTEGER DEFAULT (strftime('%s','now')*1000),
    updated_at INTEGER DEFAULT (strftime('%s','now')*1000)
  );
  CREATE TABLE IF NOT EXISTS settings (
    id TEXT PRIMARY KEY, log_dir TEXT, max_sessions INTEGER,
    redact_preset TEXT, redact_reversible INTEGER, redact_policy_file TEXT,
    encryption_at_rest INTEGER, capture_cleanup_enabled INTEGER,
    capture_cleanup_interval_hours INTEGER, capture_cleanup_max_age_days INTEGER,
    theme TEXT, oidc_enabled INTEGER, oidc_public_url TEXT,
    show_page_load_time INTEGER, detector_mode TEXT, detector_model_name TEXT NOT NULL DEFAULT 'Xenova/bert-base-NER',
    detector_threshold REAL, rate_limiter TEXT, streaming_retry TEXT,
    created_at INTEGER DEFAULT (strftime('%s','now')*1000),
    updated_at INTEGER DEFAULT (strftime('%s','now')*1000)
  );
  CREATE TABLE IF NOT EXISTS redaction_metadata (
    capture_id TEXT PRIMARY KEY, session_id TEXT, rule_counts TEXT,
    total_redactions INTEGER, encrypted INTEGER, source TEXT, provider TEXT,
    target_url TEXT, request_bytes INTEGER, response_bytes INTEGER,
    timings_send_ms INTEGER, timings_wait_ms INTEGER, timings_receive_ms INTEGER,
    timings_total_ms INTEGER, total_input_tokens INTEGER, total_output_tokens INTEGER,
    tokens_per_second REAL, success_count INTEGER, error_count INTEGER,
    model TEXT, matches TEXT,
    created_at INTEGER DEFAULT (strftime('%s','now')*1000),
    updated_at INTEGER DEFAULT (strftime('%s','now')*1000)
  );
  INSERT OR IGNORE INTO settings (id, detector_mode, detector_model_name, detector_threshold, redact_preset)
  VALUES ('default', 'rules', 'Xenova/bert-base-NER', 0.5, 'pii');
`);

// Insert default providers
const defaultProviders = [
  ["openai", "OpenAI", "https://api.openai.com", "chat-completions", "bearer", 1, 60, 60000, 10, 3, 1000, 30000, "[429,500,502,503,504]", 0.2, 3, 10485760, 1, "{}", 1, "x-openai-baseurl", "default", 0],
  ["anthropic", "Anthropic", "https://api.anthropic.com", "anthropic-messages", "bearer", 1, 60, 60000, 10, 3, 1000, 30000, "[429,500,502,503,504]", 0.2, 3, 10485760, 1, "{}", 1, "x-anthropic-baseurl", "default", 0],
  ["chatgpt", "ChatGPT", "https://chatgpt.com", "chatgpt-backend", "bearer", 1, 60, 60000, 10, 3, 1000, 30000, "[429,500,502,503,504]", 0.2, 3, 10485760, 1, "{}", 1, "x-chatgpt-baseurl", "default", 0],
  ["gemini", "Gemini", "https://generativelanguage.googleapis.com", "gemini", "api-key", 1, 60, 60000, 10, 3, 1000, 30000, "[429,500,502,503,504]", 0.2, 3, 10485760, 1, "{}", 1, "x-gemini-baseurl", "default", 0],
  ["vertex", "Vertex AI", "https://us-central1-aiplatform.googleapis.com", "gemini", "api-key", 1, 60, 60000, 10, 3, 1000, 30000, "[429,500,502,503,504]", 0.2, 3, 10485760, 1, "{}", 1, "x-vertex-baseurl", "default", 0],
  ["nvidia", "NVIDIA", "https://integrate.api.nvidia.com", "chat-completions", "bearer", 1, 20, 60000, 5, 3, 1000, 30000, "[429,500,502,503,504]", 0.2, 3, 10485760, 1, "{}", 1, "x-nvidia-baseurl", "default", 0],
  ["kilo", "Kilo", "https://api.kilo.ai/api/gateway", "chat-completions", "bearer", 1, 60, 60000, 10, 3, 1000, 30000, "[429,500,502,503,504]", 0.2, 3, 10485760, 1, "{}", 1, "x-kilo-baseurl", "default", 0],
  ["openrouter", "OpenRouter", "https://openrouter.ai/api", "chat-completions", "bearer", 1, 60, 60000, 10, 3, 1000, 30000, "[429,500,502,503,504]", 0.2, 3, 10485760, 1, "{}", 1, "x-openrouter-baseurl", "default", 0],
  ["geminiCodeAssist", "Gemini Code Assist", "https://cloudcode-pa.googleapis.com", "gemini", "api-key", 1, 60, 60000, 10, 3, 1000, 30000, "[429,500,502,503,504]", 0.2, 3, 10485760, 1, "{}", 1, "x-gemini-code-assist-baseurl", "default", 0],
];

const insertProvider = db.prepare(`
  INSERT OR REPLACE INTO providers (id, name, upstream_url, api_format, auth_type, enabled,
    rate_limit_max_requests, rate_limit_window_ms, rate_limit_buffer_capacity,
    retry_max_retries, retry_base_delay_ms, retry_max_delay_ms,
    retry_retryable_statuses, retry_jitter_factor, retry_max_stream_retries,
    retry_max_response_buffer_size, retry_enabled, custom_headers,
    allow_base_url_override, base_url_override_header, source, dynamic)
  VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
`);

for (const p of defaultProviders) {
  insertProvider.run(...p);
}

let passed = 0;
let failed = 0;

function assert(condition, message) {
  if (condition) {
    console.log(`  ✓ ${message}`);
    passed++;
  } else {
    console.log(`  ✗ ${message}`);
    failed++;
  }
}

async function testDetectorModes() {
  console.log("\n=== Test 1: Detector modes via env vars ===");
  
  const rulesPlugin = createRedactPlugin({ preset: "pii", detectorMode: "rules" });
  assert(rulesPlugin !== null, "rules mode plugin created");
  assert(typeof rulesPlugin.onRequest === "function", "rules mode plugin has onRequest");
  
  const rulesCtx = await rulesPlugin.onRequest({
    body: { messages: [{ role: "user", content: "My email is john@test.com and SSN is 123-45-6789" }] },
    sessionId: "test-session", captureId: "capture-rules",
    provider: "anthropic", targetUrl: "http://localhost:8000", source: "test", redactionStats: null,
  });
  assert(rulesCtx.body.messages[0].content.includes("EMAIL_REDACTED"), "rules mode redacts email");
  assert(rulesCtx.body.messages[0].content.includes("SSN_REDACTED"), "rules mode redacts SSN");
  
  const hybridPlugin = createRedactPlugin({ 
    preset: "pii", detectorMode: "hybrid",
    detectorConfig: { modelName: "Xenova/bert-base-NER", llmThreshold: 0.5 }
  });
  assert(hybridPlugin !== null, "hybrid mode plugin created");
  
  const llmPlugin = createRedactPlugin({ 
    preset: "pii", detectorMode: "llm",
    detectorConfig: { modelName: "Xenova/bert-base-NER", llmThreshold: 0.5 }
  });
  assert(llmPlugin !== null, "llm mode plugin created");
}

async function testProxyIntegration() {
  console.log("\n=== Test 2: Proxy integration with redact plugin ===");
  
  const upstream = http.createServer((req, res) => {
    const chunks = [];
    req.on("data", (c) => chunks.push(c));
    req.on("end", () => {
      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ received: Buffer.concat(chunks).toString() }));
    });
  });
  
  await new Promise((r) => upstream.listen(0, r));
  const upstreamPort = upstream.address().port;
  
  const redactPlugin = createRedactPlugin({ preset: "pii", detectorMode: "rules" });
  
  const proxy = createProxy({
    port: 0,
    plugins: [redactPlugin],
    upstreams: {
      anthropic: `http://127.0.0.1:${upstreamPort}`,
      openai: `http://127.0.0.1:${upstreamPort}`,
      gemini: `http://127.0.0.1:${upstreamPort}`,
      chatgpt: `http://127.0.0.1:${upstreamPort}`,
      geminiCodeAssist: `http://127.0.0.1:${upstreamPort}`,
    },
  });
  
  await proxy.start();
  assert(proxy.port > 0, "proxy started on random port");
  
  try {
    const res = await new Promise((resolve, reject) => {
      const req = http.request({
        hostname: "127.0.0.1", port: proxy.port,
        method: "POST", path: "/v1/messages",
        headers: { "Content-Type": "application/json" },
      }, (res) => {
        const chunks = [];
        res.on("data", (c) => chunks.push(c));
        res.on("end", () => resolve({ status: res.statusCode, body: Buffer.concat(chunks).toString() }));
      });
      req.on("error", reject);
      req.write(JSON.stringify({ model: "claude-3", messages: [{ role: "user", content: "My email is john@test.com" }] }));
      req.end();
    });
    
    assert(res.status === 200, "proxy returns 200 with redact plugin");
    
    const upstreamReceived = JSON.parse(res.body).received;
    assert(!upstreamReceived.includes("john@test.com"), "PII redacted before reaching upstream");
    assert(upstreamReceived.includes("EMAIL_REDACTED"), "replacement token present in upstream request");
  } finally {
    await proxy.stop();
    upstream.close();
  }
}

async function testSamplePII() {
  console.log("\n=== Test 3: Sample PII data redaction ===");
  
  // Test rules mode - catches pattern-based PII
  const rulesPlugin = createRedactPlugin({ preset: "pii", detectorMode: "rules" });
  
  const ruleSamples = [
    { input: "Email me at john.doe@example.com", expected: "EMAIL_REDACTED", desc: "email" },
    { input: "My SSN is 123-45-6789", expected: "SSN_REDACTED", desc: "SSN" },
    { input: "Please charge my credit card 4111-1111-1111-1111", expected: "CC_REDACTED", desc: "credit card" },
    { input: "key: AKIAIOSFODNN7EXAMPLE", expected: "AWS_KEY_REDACTED", desc: "AWS key" },
  ];
  
  for (const sample of ruleSamples) {
    const ctx = await rulesPlugin.onRequest({
      body: { text: sample.input },
      sessionId: "pii-test", captureId: `capture-${sample.desc}`,
      provider: "anthropic", targetUrl: "http://localhost:8000", source: "test", redactionStats: null,
    });
    const output = typeof ctx.body === "string" ? ctx.body : JSON.stringify(ctx.body);
    assert(output.includes(sample.expected), `rules: ${sample.desc} contains ${sample.expected}`);
  }
  
  // Test hybrid mode - catches NER-based PII (names, locations, etc.)
  const hybridPlugin = createRedactPlugin({ 
    preset: "pii", detectorMode: "hybrid",
    detectorConfig: { modelName: "Xenova/bert-base-NER", llmThreshold: 0.5 }
  });
  
  const hybridSamples = [
    { input: "My name is John Doe", expected: "PERSON", desc: "name (NER)" },
    { input: "Meeting in New York tomorrow", expected: "LOCATION", desc: "location (NER)" },
    { input: "Microsoft announced a new product", expected: "ORGANIZATION", desc: "organization (NER)" },
  ];
  
  for (const sample of hybridSamples) {
    const ctx = await hybridPlugin.onRequest({
      body: { text: sample.input },
      sessionId: "hybrid-test", captureId: `capture-hybrid-${sample.desc}`,
      provider: "anthropic", targetUrl: "http://localhost:8000", source: "test", redactionStats: null,
    });
    const output = typeof ctx.body === "string" ? ctx.body : JSON.stringify(ctx.body);
    assert(output.includes(sample.expected), `hybrid: ${sample.desc} contains ${sample.expected}`);
  }
}

async function testSqliteMetadata() {
  console.log("\n=== Test 4: SQLite metadata persistence ===");
  
  const plugin = createRedactPlugin({ 
    preset: "pii", detectorMode: "rules",
    onRedactionMetadata: (metadata) => { upsertRedactionMetadata(metadata); }
  });
  
  const captureId = "capture-meta-test";
  await plugin.onRequest({
    body: { messages: [{ role: "user", content: "Email john@test.com and SSN 123-45-6789" }] },
    sessionId: "meta-session", captureId,
    provider: "anthropic", targetUrl: "http://localhost:8000", source: "test", redactionStats: null,
  });
  
  const metadata = getRedactionMetadataByCaptureId(captureId);
  assert(metadata !== null, "metadata persisted to SQLite");
  assert(metadata !== null && metadata.totalRedactions >= 1, "totalRedactions >= 1");
  assert(metadata !== null && metadata.sessionId === "meta-session", "sessionId persisted");
  assert(metadata !== null && metadata.provider === "anthropic", "provider persisted");
}

async function testWebUISettings() {
  console.log("\n=== Test 5: Web UI settings for detectorMode ===");
  
  upsertSettings({
    detectorMode: "hybrid", detectorModelName: "Xenova/bert-base-NER", detectorThreshold: 0.7,
  });
  
  const db2 = getDb();
  const row = db2.prepare("SELECT * FROM settings WHERE id = 'default'").get();
  assert(row !== undefined, "settings row exists in SQLite");
  assert(row.detector_mode === "hybrid", "detectorMode = hybrid persisted");
  assert(row.detector_model_name === "Xenova/bert-base-NER", "detectorModelName persisted");
  assert(row.detector_threshold === 0.7, "detectorThreshold persisted");
  
  upsertSettings({ detectorMode: "rules", detectorModelName: "Xenova/bert-base-NER", detectorThreshold: 0.5 });
}

async function testRedactFactory() {
  console.log("\n=== Test 6: Redact factory loads correctly ===");
  
  const originalMode = process.env.REDACT_DETECTOR_MODE;
  const originalPreset = process.env.REDACT_PRESET;
  
  process.env.REDACT_DETECTOR_MODE = "hybrid";
  process.env.REDACT_PRESET = "pii";
  
  try {
    const factory = await import("./packages/redact/dist/factory.js");
    const plugin = await factory.default();
    assert(plugin !== null, "factory creates plugin with env vars");
  } finally {
    process.env.REDACT_DETECTOR_MODE = originalMode;
    process.env.REDACT_PRESET = originalPreset;
  }
}

async function runAll() {
  console.log("Starting end-to-end verification for contextio-mol-stj");
  console.log(`Temp directory: ${tempDir}`);
  
  try {
    await testDetectorModes();
    await testProxyIntegration();
    await testSamplePII();
    await testSqliteMetadata();
    await testWebUISettings();
    await testRedactFactory();
  } catch (err) {
    console.error("Verification error:", err);
    failed++;
  }
  
  console.log("\n=== Summary ===");
  console.log(`Passed: ${passed}`);
  console.log(`Failed: ${failed}`);
  
  if (failed > 0) {
    console.log("\n❌ Verification FAILED");
    process.exit(1);
  } else {
    console.log("\n✅ Verification PASSED");
    process.exit(0);
  }
}

runAll();
