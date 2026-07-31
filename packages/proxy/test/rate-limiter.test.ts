import { describe, it, before, after, mock } from "node:test";
import * as assert from "node:assert";
import { createRateLimiterPlugin, type RateLimiterConfig } from "@contextio/proxy";
import type { RequestContext, ProxyPlugin } from "@contextio/core";
import * as http from "node:http";

// Helper to create a mock RequestContext
function createMockContext(overrides: Partial<RequestContext> = {}): RequestContext {
  return {
    provider: "openai",
    apiFormat: "chat-completions",
    path: "/v1/chat/completions",
    source: "test",
    sessionId: "session-1",
    headers: { "content-type": "application/json" },
    body: { model: "gpt-4", messages: [] },
    rawBody: Buffer.from('{"model":"gpt-4","messages":[]}'),
    ...overrides,
  };
}

// Helper to get internal methods from the plugin
function getInternal(plugin: ProxyPlugin) {
  return (plugin as any)._internal;
}

describe("rate-limiter plugin", () => {
  // Test token bucket / sliding window logic
  it("allows requests up to maxRequests within the window", async () => {
    const plugin = createRateLimiterPlugin({
      maxRequests: 10,
      windowMs: 1000,
      bufferCapacity: 5,
    });
    const internal = getInternal(plugin);
    const ctx = createMockContext();

    for (let i = 0; i < 10; i++) {
      await assert.doesNotReject(Promise.resolve(plugin.onRequest!(ctx)));
    }

    internal.shutdown();
  });

  it("refills tokens over time (sliding window)", async () => {
    mock.timers.enable({ apis: ["setTimeout", "Date"] });

    const plugin = createRateLimiterPlugin({
      maxRequests: 10,
      windowMs: 1000,
      bufferCapacity: 5,
    });
    const internal = getInternal(plugin);
    const ctx = createMockContext();

    for (let i = 0; i < 10; i++) {
      await plugin.onRequest!(ctx);
    }

    // Advance time by 1100ms to allow full token refill
    mock.timers.tick(1100);

    // Should be able to make 10 more requests now
    for (let i = 0; i < 10; i++) {
      await assert.doesNotReject(Promise.resolve(plugin.onRequest!(ctx)));
    }

    mock.timers.reset();
    internal.shutdown();
  });

  it("calculates correct retry-after when rate limited", async () => {
    const plugin = createRateLimiterPlugin({
      maxRequests: 2,
      windowMs: 1000,
      bufferCapacity: 0, // No buffer - direct rate limiting
    });
    const internal = getInternal(plugin);
    const ctx = createMockContext();

    // First 2 requests consume tokens
    await plugin.onRequest!(ctx);
    await plugin.onRequest!(ctx);

    // 3rd request should get 429 (no buffer)
    let lastError: any = null;
    try {
      await plugin.onRequest!(ctx);
    } catch (e: any) {
      lastError = e;
    }

    assert.ok(lastError !== null);
    assert.equal(lastError.statusCode, 429);
    assert.ok(lastError.retryAfter > 0);
    assert.ok(lastError.rateLimitInfo);
    assert.equal(lastError.rateLimitInfo.limit, 2);
    assert.equal(lastError.rateLimitInfo.remaining, 0);
    assert.ok(lastError.rateLimitInfo.retryAfter > 0);

    internal.shutdown();
  });

  // Per-session isolation (requires explicit keyStrategy)
  it("different sessions have independent limits when keyStrategy=session-provider", async () => {
    const plugin = createRateLimiterPlugin({
      maxRequests: 10,
      windowMs: 1000,
      bufferCapacity: 0, // No buffer to avoid pending promises
      keyStrategy: "session-provider",
    });
    const internal = getInternal(plugin);
    const session1 = createMockContext({ sessionId: "session-1" });
    const session2 = createMockContext({ sessionId: "session-2" });

    // Exhaust session1 (10 tokens)
    for (let i = 0; i < 10; i++) {
      await plugin.onRequest!(session1);
    }

    // Session2 should have full quota
    for (let i = 0; i < 10; i++) {
      await Promise.resolve(plugin.onRequest!(session2));
    }

    internal.shutdown();
  });

  it("handles null sessionId with keyStrategy=session-provider", async () => {
    const plugin = createRateLimiterPlugin({
      maxRequests: 10,
      windowMs: 1000,
      bufferCapacity: 0, // No buffer to avoid pending promises
      keyStrategy: "session-provider",
    });
    const internal = getInternal(plugin);
    const ctx1 = createMockContext({ sessionId: null });
    const ctx2 = createMockContext({ sessionId: "session-1" });

    for (let i = 0; i < 10; i++) {
      await plugin.onRequest!(ctx1);
    }

    // Named session should have full quota
    for (let i = 0; i < 10; i++) {
      await Promise.resolve(plugin.onRequest!(ctx2));
    }

    internal.shutdown();
  });

  // Per-provider sharing (new default behavior)
  it("different sessions share limits per provider by default", async () => {
    const plugin = createRateLimiterPlugin({
      maxRequests: 10,
      windowMs: 1000,
      bufferCapacity: 0, // No buffer to avoid pending promises
      // Default keyStrategy="provider" - sessions share bucket
    });
    const internal = getInternal(plugin);
    const session1 = createMockContext({ sessionId: "session-1", provider: "openai" });
    const session2 = createMockContext({ sessionId: "session-2", provider: "openai" });

    // Exhaust the shared bucket via session1 (10 tokens)
    for (let i = 0; i < 10; i++) {
      await plugin.onRequest!(session1);
    }

    // session2 should be rate limited (shared bucket)
    let lastError: any = null;
    try {
      await plugin.onRequest!(session2);
    } catch (e: any) {
      lastError = e;
    }

    assert.ok(lastError !== null);
    assert.equal(lastError.statusCode, 429);

    internal.shutdown();
  });

  // Per-provider isolation
  it("different providers have independent limits", async () => {
    const plugin = createRateLimiterPlugin({
      maxRequests: 10,
      windowMs: 1000,
      bufferCapacity: 0, // No buffer to avoid pending promises
    });
    const internal = getInternal(plugin);
    const openaiCtx = createMockContext({ provider: "openai", sessionId: "session-1" });
    const anthropicCtx = createMockContext({ provider: "anthropic", sessionId: "session-1" });

    for (let i = 0; i < 10; i++) {
      await Promise.resolve(plugin.onRequest!(openaiCtx));
    }

    // Anthropic should have full quota
    for (let i = 0; i < 10; i++) {
      await Promise.resolve(plugin.onRequest!(anthropicCtx));
    }

    internal.shutdown();
  });

  // 429 response with Retry-After header
  it("returns 429 with rateLimitInfo when buffer is disabled (bufferCapacity=0)", async () => {
    const plugin = createRateLimiterPlugin({
      maxRequests: 2,
      windowMs: 1000,
      bufferCapacity: 0, // No buffer - immediate 429
    });
    const internal = getInternal(plugin);
    const ctx = createMockContext();

    // Request 1: token 2→1 (success)
    await plugin.onRequest!(ctx);
    // Request 2: token 1→0 (success)
    await plugin.onRequest!(ctx);
    // Request 3: token 0, no buffer, return 429
    let lastError: any = null;
    try {
      await plugin.onRequest!(ctx);
    } catch (e: any) {
      lastError = e;
    }

    assert.ok(lastError !== null);
    assert.equal(lastError.statusCode, 429);
    assert.ok(lastError.retryAfter > 0);
    assert.ok(lastError.rateLimitInfo);
    assert.equal(lastError.rateLimitInfo.limit, 2);
    assert.equal(lastError.rateLimitInfo.remaining, 0);
    assert.ok(lastError.rateLimitInfo.reset > 0);
    assert.ok(lastError.rateLimitInfo.retryAfter > 0);

    internal.shutdown();
  });

  it("buffers requests when tokens exhausted but buffer available", async () => {
    const plugin = createRateLimiterPlugin({
      maxRequests: 2,
      windowMs: 1000,
      bufferCapacity: 2,
    });
    const internal = getInternal(plugin);
    const ctx = createMockContext();

    // Request 1: token 2→1 (success)
    await plugin.onRequest!(ctx);
    // Request 2: token 1→0 (success)
    await plugin.onRequest!(ctx);
    // Request 3: token 0, queue length 0 < buffer 2, queue it
    const queued1 = plugin.onRequest!(ctx);
    // Request 4: queue length 1 < buffer 2, queue it
    const queued2 = plugin.onRequest!(ctx);
    // Request 5: queue length 2 >= buffer 2, return 429
    let lastError: any = null;
    try {
      await plugin.onRequest!(ctx);
    } catch (e: any) {
      lastError = e;
    }

    assert.ok(lastError !== null);
    assert.equal(lastError.statusCode, 429);

    // Verify the queue has 2 items
    const bucket = internal.getBucketState("openai");
    assert.ok(bucket);
    assert.equal(bucket.queue.length, 2);

    // Manually set tokens high enough to process the queue (simulating token refill)
    if (bucket) {
      bucket.tokens = 2; // Enough to process both queued requests
    }
    internal.processAllQueues();

    // Verify the queue is now empty (requests were processed)
    assert.equal(bucket.queue.length, 0);

    internal.shutdown();
  });

  it("returns 429 with rateLimitInfo when buffer is full", async () => {
    const plugin = createRateLimiterPlugin({
      maxRequests: 2,
      windowMs: 1000,
      bufferCapacity: 1,
    });
    const internal = getInternal(plugin);
    const ctx = createMockContext();

    // Request 1: token 2→1 (success)
    await plugin.onRequest!(ctx);
    // Request 2: token 1→0 (success)
    await plugin.onRequest!(ctx);
    // Request 3: token 0, queue length 0 < buffer 1, queue it
    const queued = plugin.onRequest!(ctx);
    // Request 4: queue length 1 >= buffer 1, return 429
    let lastError: any = null;
    try {
      await plugin.onRequest!(ctx);
    } catch (e: any) {
      lastError = e;
    }

    assert.ok(lastError !== null);
    assert.equal(lastError.statusCode, 429);
    assert.ok(lastError.retryAfter > 0);
    assert.ok(lastError.rateLimitInfo);
    assert.equal(lastError.rateLimitInfo.limit, 2);
    assert.equal(lastError.rateLimitInfo.remaining, 0);
    assert.ok(lastError.rateLimitInfo.reset > 0);
    assert.ok(lastError.rateLimitInfo.retryAfter > 0);

    // Clean up the queued request
    const bucket = internal.getBucketState("openai");
    assert.ok(bucket);
    assert.equal(bucket.queue.length, 1);

    // Give the queued promise a rejection handler to avoid unhandled rejection
    const p = queued as Promise<any>;
    p.catch(() => {});

    internal.shutdown();
  });

  it("calls onRateLimited callback when rate limited", async () => {
    let callbackCalled = false;
    let callbackCtx: RequestContext | null = null;
    let callbackRetryAfter = 0;

    const plugin = createRateLimiterPlugin({
      maxRequests: 2,
      windowMs: 1000,
      bufferCapacity: 0, // No buffer - immediate 429
      onRateLimited: (ctx: RequestContext, retryAfterMs: number) => {
        callbackCalled = true;
        callbackCtx = ctx;
        callbackRetryAfter = retryAfterMs;
      },
    });
    const internal = getInternal(plugin);

    const ctx = createMockContext();

    await plugin.onRequest!(ctx);
    await plugin.onRequest!(ctx);

    // Third request should be rate limited (buffer=0)
    try {
      await plugin.onRequest!(ctx);
    } catch (e) {}

    assert.equal(callbackCalled, true);
    assert.ok(callbackCtx !== null);
    assert.ok(callbackRetryAfter > 0);

    internal.shutdown();
  });

  // Cleanup of stale session entries
  it("clears entries on shutdown", async () => {
    const plugin = createRateLimiterPlugin({
      maxRequests: 10,
      windowMs: 1000,
      bufferCapacity: 0, // No buffer to avoid pending promises
    });
    const internal = getInternal(plugin);

    const ctx = createMockContext({ sessionId: "cleanup-test" });
    await plugin.onRequest!(ctx);

    const keysBefore = internal.getAllKeys();
    assert.ok(keysBefore.length > 0);

    internal.shutdown();

    const keysAfter = internal.getAllKeys();
    assert.equal(keysAfter.length, 0);
  });

  it("enforces maxEntries with LRU eviction", async () => {
    const plugin = createRateLimiterPlugin({
      maxRequests: 10,
      windowMs: 1000,
      bufferCapacity: 0, // No buffer to avoid pending promises
      maxEntries: 3,
    });
    const internal = getInternal(plugin);

    // Use different providers to create different buckets (default keyStrategy="provider")
    const providers = ["openai", "anthropic", "gemini", "vertex", "nvidia"];
    for (const provider of providers) {
      const ctx = createMockContext({ sessionId: `session-${provider}`, provider });
      await plugin.onRequest!(ctx);
    }

    const keys = internal.getAllKeys();
    assert.equal(keys.length, 3);

    internal.shutdown();
  });

  it("supports clear() method via internal API", async () => {
    const plugin = createRateLimiterPlugin({
      maxRequests: 10,
      windowMs: 1000,
      bufferCapacity: 0, // No buffer to avoid pending promises
    });
    const internal = getInternal(plugin);
    const ctx = createMockContext({ sessionId: "test-clear" });
    await plugin.onRequest!(ctx);

    const keysBefore = internal.getAllKeys();
    assert.equal(keysBefore.length, 1);

    internal.clear();

    const keysAfter = internal.getAllKeys();
    assert.equal(keysAfter.length, 0);
  });

  // Configuration
  it("supports nested defaults config format", async () => {
    const plugin = createRateLimiterPlugin({
      defaults: {
        maxRequests: 5,
        windowMs: 1000,
        bufferCapacity: 0, // No buffer to avoid pending promises
      },
    });
    const internal = getInternal(plugin);

    const ctx = createMockContext();

    for (let i = 0; i < 5; i++) {
      await assert.doesNotReject(Promise.resolve(plugin.onRequest!(ctx)));
    }

    try {
      await plugin.onRequest!(ctx);
      assert.fail("Should have thrown");
    } catch (e: any) {
      assert.equal(e.statusCode, 429);
    }

    internal.shutdown();
  });

  it("supports flat legacy config format", async () => {
    const plugin = createRateLimiterPlugin({
      maxRequests: 5,
      windowMs: 1000,
      bufferCapacity: 0, // No buffer to avoid pending promises
    });
    const internal = getInternal(plugin);

    const ctx = createMockContext();

    for (let i = 0; i < 5; i++) {
      await assert.doesNotReject(Promise.resolve(plugin.onRequest!(ctx)));
    }

    internal.shutdown();
  });

  it("validates config: throws on invalid maxRequests", () => {
    assert.throws(
      () => createRateLimiterPlugin({ maxRequests: 0 }),
      /maxRequests must be positive/
    );
  });

  it("validates config: throws on invalid windowMs", () => {
    assert.throws(
      () => createRateLimiterPlugin({ windowMs: 0 }),
      /windowMs must be positive/
    );
  });

  it("validates config: throws on invalid bufferCapacity", () => {
    assert.throws(
      () => createRateLimiterPlugin({ bufferCapacity: -1 }),
      /bufferCapacity must be non-negative/
    );
  });

  it("validates config: throws on invalid maxEntries", () => {
    assert.throws(
      () => createRateLimiterPlugin({ maxEntries: 0 }),
      /maxEntries must be positive/
    );
  });

  it("allows custom keyGenerator", async () => {
    const plugin = createRateLimiterPlugin({
      maxRequests: 2,
      windowMs: 1000,
      bufferCapacity: 0, // No buffer to avoid pending promises
      keyGenerator: (ctx: RequestContext) => `custom-${ctx.provider}`,
    });
    const internal = getInternal(plugin);

    const ctx1 = createMockContext({ sessionId: "session-1", provider: "openai" });
    const ctx2 = createMockContext({ sessionId: "session-2", provider: "openai" });

    await plugin.onRequest!(ctx1);
    await plugin.onRequest!(ctx2);

    try {
      await plugin.onRequest!(createMockContext({ sessionId: "session-3", provider: "openai" }));
      assert.fail("Should have thrown");
    } catch (e: any) {
      assert.equal(e.statusCode, 429);
    }

    internal.shutdown();
  });

  it("disabled rate limiter passes all requests", async () => {
    const plugin = createRateLimiterPlugin({
      maxRequests: 1,
      windowMs: 1000,
      bufferCapacity: 0,
      enabled: false,
    });
    const internal = getInternal(plugin);

    const ctx = createMockContext();

    for (let i = 0; i < 100; i++) {
      await assert.doesNotReject(Promise.resolve(plugin.onRequest!(ctx)));
    }

    internal.shutdown();
  });

  // Integration with proxy - uses REAL rate limiter
  describe("integration with proxy", () => {
    let proxy: any;
    let upstreamPort: number;
    let upstreamServer: http.Server;

    before(async () => {
      upstreamServer = http.createServer((req, res) => {
        res.writeHead(200, { "Content-Type": "application/json" });
        res.end('{"id":"test","object":"chat.completion"}');
      });

      await new Promise<void>((resolve) => upstreamServer.listen(0, resolve));
      upstreamPort = (upstreamServer.address() as any).port;

      const { createProxy } = await import("../dist/proxy.js");
      proxy = createProxy({
        port: 0,
        upstreams: {
          openai: `http://127.0.0.1:${upstreamPort}`,
          // Unreachable upstreams (port 1) - will fail at connection stage
          anthropic: `http://127.0.0.1:1`,
          chatgpt: `http://127.0.0.1:1`,
          gemini: `http://127.0.0.1:1`,
          geminiCodeAssist: `http://127.0.0.1:1`,
          vertex: `http://127.0.0.1:1`,
          nvidia: `http://127.0.0.1:1`,
          openrouter: `http://127.0.0.1:1`,
          kilo: `http://127.0.0.1:1`,
        },
        plugins: [
          createRateLimiterPlugin({
            maxRequests: 5,
            windowMs: 2000,
            bufferCapacity: 2,
            cleanupIntervalMs: 86400000, // 24 hours - effectively disabled for tests
            keyStrategy: "session-provider", // Test per-session isolation
          }),
        ],
      });

      await proxy.start();
    });

    after(async () => {
      if (proxy) await proxy.stop();
      if (upstreamServer) upstreamServer.close();
    });

    function makeRequest(path: string, sessionId: string): Promise<{ status: number; body: string; headers: any }> {
      return new Promise((resolve, reject) => {
        const req = http.request(
          {
            hostname: "127.0.0.1",
            port: proxy.port,
            method: "POST",
            path: `/${sessionId}${path}`,
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
          }
        );
        req.on("error", reject);
        req.write(JSON.stringify({ model: "gpt-4", messages: [] }));
        req.end();
      });
    }

    it("rate limits requests through proxy", async () => {
      const testSessionId = "openai/ab12cd34";
      
      const promises = [];
      for (let i = 0; i < 8; i++) {
        promises.push(makeRequest("/v1/chat/completions", testSessionId));
      }
      
      const results = await Promise.all(promises);
      
      let successCount = 0;
      let rateLimitedCount = 0;
      for (let i = 0; i < results.length; i++) {
        const res = results[i];
        if (res.status === 200) {
          successCount++;
        } else if (res.status === 429) {
          rateLimitedCount++;
        }
      }
      
      assert.equal(successCount, 7);
      assert.equal(rateLimitedCount, 1);
      
      const rateLimitedRes = results.find(r => r.status === 429);
      assert.ok(rateLimitedRes);
      
      assert.ok(rateLimitedRes.headers["retry-after"]);
      const retryAfter = parseInt(rateLimitedRes.headers["retry-after"], 10);
      assert.ok(retryAfter > 0);
      
      const body = JSON.parse(rateLimitedRes.body);
      assert.ok(body.error);
      assert.ok(body.error.message.includes("Rate limit"));
      assert.equal(body.error.type, "rate_limit_exceeded");
      
      assert.ok(body.error.rateLimitInfo);
      assert.equal(body.error.rateLimitInfo.limit, 5);
      assert.equal(body.error.rateLimitInfo.remaining, 0);
      assert.ok(body.error.rateLimitInfo.retryAfter > 0);
    });

    it("different sessions have independent limits through proxy (with keyStrategy=session-provider)", async () => {
      const sessionA = "openai/aaaaaaaa";
      const sessionB = "openai/bbbbbbbb";

      for (let i = 0; i < 7; i++) {
        const res = await makeRequest("/v1/chat/completions", sessionA);
        assert.equal(res.status, 200);
      }

      const res = await makeRequest("/v1/chat/completions", sessionB);
      assert.equal(res.status, 200);
    });
  });
});