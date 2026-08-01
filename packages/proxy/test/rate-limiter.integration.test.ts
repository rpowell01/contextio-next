import { describe, it, before, after } from "node:test";
import assert from "node:assert/strict";
import http from "node:http";
import { createRateLimiterPlugin, type RateLimiterConfig } from "@contextio/proxy";

/**
 * Helper to make an HTTP request to the proxy.
 */
function makeRequest(
  port: number,
  path: string,
): Promise<{ status: number; body: string; headers: http.IncomingHttpHeaders }> {
  return new Promise((resolve, reject) => {
    const req = http.request(
      {
        hostname: "127.0.0.1",
        port,
        method: "POST",
        path,
        headers: { "Content-Type": "application/json" },
      },
      (res) => {
        const chunks: Buffer[] = [];
        res.on("data", (chunk) => chunks.push(chunk));
        res.on("end", () => {
          resolve({
            status: res.statusCode!,
            body: Buffer.concat(chunks).toString(),
            headers: res.headers,
          });
        });
      },
    );
    req.on("error", reject);
    req.write(JSON.stringify({ model: "gpt-4", messages: [] }));
    req.end();
  });
}

/**
 * Create a proxy with the given rate limiter config.
 */
async function createTestProxy(
  upstreamPort: number,
  rateLimiterConfig: Parameters<typeof createRateLimiterPlugin>[0],
) {
  const { createProxy } = await import("../dist/proxy.js");

  const plugin = createRateLimiterPlugin(rateLimiterConfig);

  const proxy = createProxy({
    port: 0,
    upstreams: {
      openai: `http://127.0.0.1:${upstreamPort}`,
      anthropic: `http://127.0.0.1:${upstreamPort}`,
      chatgpt: `http://127.0.0.1:1`,
      gemini: `http://127.0.0.1:1`,
      geminiCodeAssist: `http://127.0.0.1:1`,
      vertex: `http://127.0.0.1:1`,
      nvidia: `http://127.0.0.1:1`,
      openrouter: `http://127.0.0.1:1`,
      kilo: `http://127.0.0.1:1`,
    },
    plugins: [plugin],
  });

  await proxy.start();
  return { proxy, plugin };
}

describe("rate-limiter integration", () => {
  let upstreamPort: number;
  let upstreamServer: http.Server;

  // Main proxy: bufferCapacity=0 for exact rate limiting (no burst)
  let proxy: any;
  let rateLimiterPlugin: ReturnType<typeof createRateLimiterPlugin>;

  // Buffering proxy: bufferCapacity=2 for testing queued requests
  let bufferingProxy: any;
  let bufferingPlugin: ReturnType<typeof createRateLimiterPlugin>;

  // Cleanup proxy: short TTL for testing stale entry removal
  let cleanupProxy: any;
  let cleanupPlugin: ReturnType<typeof createRateLimiterPlugin>;

  before(async () => {
    upstreamServer = http.createServer((req, res) => {
      res.writeHead(200, { "Content-Type": "application/json" });
      res.end('{"id":"test","object":"chat.completion"}');
    });

    await new Promise<void>((resolve) => upstreamServer.listen(0, resolve));
    upstreamPort = (upstreamServer.address() as any).port;

    // Main proxy for basic rate limiting tests (no buffer)
    ({ proxy, plugin: rateLimiterPlugin } = await createTestProxy(upstreamPort, {
      maxRequests: 3,
      windowMs: 1000,
      bufferCapacity: 0, // No burst — exact limit
      keyStrategy: "session-provider",
      cleanupIntervalMs: 86_400_000,
      entryTtlMs: 86_400_000,
    }));

    // Buffering proxy for queue/release tests
    ({ proxy: bufferingProxy, plugin: bufferingPlugin } = await createTestProxy(upstreamPort, {
      maxRequests: 3,
      windowMs: 1000,
      bufferCapacity: 2, // Allow 2 queued requests
      keyStrategy: "session-provider",
      cleanupIntervalMs: 86_400_000,
      entryTtlMs: 86_400_000,
    }));

    // Cleanup proxy with short TTL
    ({ proxy: cleanupProxy, plugin: cleanupPlugin } = await createTestProxy(upstreamPort, {
      maxRequests: 2,
      windowMs: 1000,
      bufferCapacity: 0,
      keyStrategy: "session-provider",
      cleanupIntervalMs: 300,
      entryTtlMs: 500,
    }));
  });

  after(async () => {
    if (rateLimiterPlugin) rateLimiterPlugin._internal.shutdown();
    if (bufferingPlugin) bufferingPlugin._internal.shutdown();
    if (cleanupPlugin) cleanupPlugin._internal.shutdown();
    if (proxy) await proxy.stop();
    if (bufferingProxy) await bufferingProxy.stop();
    if (cleanupProxy) await cleanupProxy.stop();
    if (upstreamServer) upstreamServer.close();
  });

  it("sequential requests to same session/provider until limit hit", async () => {
    const sessionId = "11111111";
    const results: { status: number }[] = [];

    // With bufferCapacity=0, exactly maxRequests (3) should succeed, then 429
    for (let i = 0; i < 5; i++) {
      const res = await makeRequest(proxy.port, `/openai/${sessionId}/v1/chat/completions`);
      results.push({ status: res.status });
    }

    const successCount = results.filter((r) => r.status === 200).length;
    const rateLimitedCount = results.filter((r) => r.status === 429).length;

    assert.equal(successCount, 3, "Should allow exactly maxRequests requests");
    assert.equal(rateLimitedCount, 2, "Should rate limit remaining requests");
  });

  it("429 responses include Retry-After header and rateLimitInfo", async () => {
    const sessionId = "22222222";

    // Exhaust the limit (3 requests with bufferCapacity=0)
    for (let i = 0; i < 3; i++) {
      const res = await makeRequest(proxy.port, `/openai/${sessionId}/v1/chat/completions`);
      assert.equal(res.status, 200);
    }

    // Next request should be 429
    const res = await makeRequest(proxy.port, `/openai/${sessionId}/v1/chat/completions`);
    assert.equal(res.status, 429);

    // Retry-After header is in seconds
    const retryAfter = res.headers["retry-after"];
    assert.ok(retryAfter, "Should have Retry-After header");
    const retryAfterSec = parseInt(retryAfter as string, 10);
    assert.ok(retryAfterSec > 0, "Retry-After should be positive");

    // Response body structure
    const body = JSON.parse(res.body);
    assert.ok(body.error);
    assert.equal(body.error.type, "rate_limit_exceeded");
    assert.ok(body.error.rateLimitInfo);
    assert.equal(body.error.rateLimitInfo.limit, 3);
    assert.equal(body.error.rateLimitInfo.remaining, 0);
    assert.ok(body.error.rateLimitInfo.retryAfter > 0);
  });

  it("buffering queues requests and releases them when slots free up", async () => {
    const sessionId = "33333333";

    // bufferingProxy has maxRequests=3, bufferCapacity=2
    // Initial tokens = 5 (maxRequests + bufferCapacity)
    // First 5 succeed immediately, next 2 queued, 8th = 429

    // First 5 consume all initial tokens
    for (let i = 0; i < 5; i++) {
      const res = await makeRequest(bufferingProxy.port, `/openai/${sessionId}/v1/chat/completions`);
      assert.equal(res.status, 200, `Request ${i + 1} should succeed immediately`);
    }

    // Next 2 fit in buffer and are queued
    const queued1 = makeRequest(bufferingProxy.port, `/openai/${sessionId}/v1/chat/completions`);
    const queued2 = makeRequest(bufferingProxy.port, `/openai/${sessionId}/v1/chat/completions`);

    // 8th request exceeds buffer capacity → immediate 429
    const res = await makeRequest(bufferingProxy.port, `/openai/${sessionId}/v1/chat/completions`);
    assert.equal(res.status, 429);

    // Wait for token refill. refillRate = 3/1000 = 0.003 tokens/ms.
    // Each queued request needs 1 token ≈ 334ms. Two queued ≈ 668ms.
    await new Promise((r) => setTimeout(r, 1000));

    // Queued requests should have been released and forwarded
    const [q1, q2] = await Promise.all([queued1, queued2]);
    assert.equal(q1.status, 200, "First queued request should succeed after refill");
    assert.equal(q2.status, 200, "Second queued request should succeed after refill");
  });

  it("different sessions are independent with keyStrategy=session-provider", async () => {
    const sessionA = "44444444";
    const sessionB = "55555555";

    // Exhaust sessionA's quota (3 requests with bufferCapacity=0)
    for (let i = 0; i < 3; i++) {
      const res = await makeRequest(proxy.port, `/openai/${sessionA}/v1/chat/completions`);
      assert.equal(res.status, 200);
    }

    // sessionB should have a fresh, independent bucket
    const res = await makeRequest(proxy.port, `/openai/${sessionB}/v1/chat/completions`);
    assert.equal(res.status, 200);
  });

  it("different providers are independent", async () => {
    const sessionId = "66666666";

    // Exhaust openai quota for this session
    for (let i = 0; i < 3; i++) {
      const res = await makeRequest(proxy.port, `/openai/${sessionId}/v1/chat/completions`);
      assert.equal(res.status, 200);
    }

    // anthropic uses a separate bucket, so it should still allow requests
    const res = await makeRequest(proxy.port, `/anthropic/${sessionId}/v1/messages`);
    assert.equal(res.status, 200);
  });

  it("cleanup removes stale session entries", async () => {
    const sessionId = "77777777";

    // Create a bucket by making a request
    const res = await makeRequest(cleanupProxy.port, `/openai/${sessionId}/v1/chat/completions`);
    assert.equal(res.status, 200);

    // Bucket should exist
    const keysBefore = cleanupPlugin._internal.getAllKeys();
    assert.ok(keysBefore.length > 0, "Should have at least one bucket before cleanup");

    // Wait past entryTtlMs + cleanupIntervalMs so the stale entry is removed
    await new Promise((r) => setTimeout(r, 1200));

    // Bucket should be gone
    const keysAfter = cleanupPlugin._internal.getAllKeys();
    assert.equal(keysAfter.length, 0, "Stale entries should be cleaned up");
  });
});