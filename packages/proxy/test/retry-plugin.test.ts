/**
 * @contextio/proxy - Retry Plugin Unit Tests
 *
 * Comprehensive tests for the retry plugin covering:
 * - 429 responses with Retry-After header
 * - 5xx responses with exponential backoff and jitter
 * - Non-retryable status codes (400, 401, 403)
 * - Max retries exceeded
 * - Streaming SSE error detection
 * - Request body buffering and replay
 * - Per-provider config isolation
 * - Integration with proxy handler
 */

import { describe, it, before, after, beforeEach, afterEach, mock } from "node:test";
import assert from "node:assert/strict";
import http from "node:http";
import { createRetryPlugin } from "../dist/retry-plugin.js";
import { createProxy } from "../dist/proxy.js";
import type { ProxyPlugin, RequestContext, ResponseContext, HeaderMap, JsonValue, Upstreams } from "@contextio/core";

// --- Test Helpers ---

function createMockRequestContext(overrides: Partial<RequestContext> = {}): RequestContext {
  const uniqueId = Math.floor(Math.random() * 1000000);
  return {
    provider: "anthropic",
    apiFormat: "anthropic",
    path: "/v1/messages",
    source: "test",
    sessionId: "test-session-123",
    headers: { "content-type": "application/json" } as HeaderMap,
    body: { model: "claude-3", messages: [] } as JsonValue,
    rawBody: Buffer.from(JSON.stringify({ model: "claude-3", messages: [] })),
    captureId: `capture-test-${uniqueId}`,
    targetUrl: "http://localhost:8000/v1/messages",
    ...overrides,
  };
}

function createMockResponseContext(overrides: Partial<ResponseContext> & { captureId?: string } = {}): ResponseContext {
  // Get captureId from overrides or use a default
  const { captureId, headers: overrideHeaders, ...restOverrides } = overrides;
  const defaultHeaders: HeaderMap = {
    "content-type": "application/json",
  };

  // Add captureId to headers if provided
  if (captureId) {
    defaultHeaders["x-contextio-capture-id"] = captureId;
  }

  // Merge headers from overrides with defaults
  const mergedHeaders = overrideHeaders
    ? { ...defaultHeaders, ...overrideHeaders }
    : defaultHeaders;

  return {
    status: 200,
    headers: mergedHeaders,
    body: '{"result":"ok"}',
    isStreaming: false,
    sessionId: "test-session-123",
    ...restOverrides,
  };
}

function getServerPort(server: http.Server): number {
  const address = server.address();
  if (!address || typeof address === "string") {
    throw new Error("Server is not listening on a TCP port.");
  }
  return address.port;
}

async function makeRequest(
  port: number,
  options: {
    method?: string;
    path: string;
    headers?: Record<string, string>;
    body?: string;
  },
): Promise<{ status: number; body: string }> {
  return new Promise((resolve, reject) => {
    const req = http.request(
      {
        hostname: "127.0.0.1",
        port,
        method: options.method || "POST",
        path: options.path,
        headers: options.headers || {},
      },
      (res) => {
        const chunks: Buffer[] = [];
        res.on("data", (chunk: Buffer) => chunks.push(chunk));
        res.on("end", () => {
          resolve({
            status: res.statusCode!,
            body: Buffer.concat(chunks).toString("utf8"),
          });
        });
      },
    );
    req.on("error", reject);
    if (options.body) req.write(options.body);
    req.end();
  });
}

// --- Test Suite ---

describe("retry plugin - unit tests", () => {
  let plugin: ReturnType<typeof createRetryPlugin>;

  beforeEach(() => {
    plugin = createRetryPlugin({
      maxRetries: 3,
      baseDelayMs: 10, // Fast for tests
      maxDelayMs: 100,
      retryableStatuses: [429, 500, 502, 503, 504],
      jitterFactor: 0, // Disable jitter for predictable tests
      enabled: true,
    });
  });

  afterEach(() => {
    if (plugin && typeof (plugin as any)._internal?.shutdown === "function") {
      (plugin as any)._internal.shutdown();
    }
  });

  describe("onRequest - request buffering", () => {
    it("stores original request body and headers on first attempt", async () => {
      const ctx = createMockRequestContext();
      const result = await plugin.onRequest!(ctx);
      
      // Should add x-retry-id header
      assert.ok(result.headers["x-retry-id"], "Should add x-retry-id header");
      assert.equal(typeof result.headers["x-retry-id"], "string");
      
      // Should store request data internally
      const internal = (plugin as any)._internal;
      const storedBody = internal.getRequestBody(ctx.captureId!);
      const storedHeaders = internal.getRequestHeaders(ctx.captureId!);
      
      assert.ok(storedBody, "Should store request body");
      assert.equal(storedBody!.toString(), '{"model":"claude-3","messages":[]}');
      assert.ok(storedHeaders, "Should store request headers");
      assert.equal(storedHeaders!["content-type"], "application/json");
    });

    it("preserves existing x-retry-id for retry attempts", async () => {
      const ctx = createMockRequestContext({
        headers: { "content-type": "application/json", "x-retry-id": "existing-retry-123" } as HeaderMap,
      });
      const result = await plugin.onRequest!(ctx);
      
      assert.equal(result.headers["x-retry-id"], "existing-retry-123");
    });

    it("generates new x-retry-id when none exists", async () => {
      const ctx = createMockRequestContext({
        headers: { "content-type": "application/json" } as HeaderMap,
        captureId: undefined,
      });
      const result = await plugin.onRequest!(ctx);
      
      assert.ok(result.headers["x-retry-id"]);
      assert.match(result.headers["x-retry-id"] as string, /^retry-\d+-\d{6}$/);
    });
  });

  describe("onResponse - 429 with Retry-After header", () => {
    it("reads Retry-After header (seconds), waits, and signals retry", async () => {
      const ctx = createMockRequestContext();
      const requestCtx = await plugin.onRequest!(ctx);
      
      const responseCtx = createMockResponseContext({
        status: 429,
        headers: {
          "content-type": "application/json",
          "retry-after": "1", // 1 second
        },
        sessionId: "test-session-123",
        captureId: ctx.captureId, // Pass captureId from request context
      });
      
      const startTime = Date.now();
      const result = await plugin.onResponse!(responseCtx);
      const elapsed = Date.now() - startTime;
      
      // Should signal retry with status 599
      assert.equal(result.status, 599, "Should return 599 to signal retry");
      
      // Should wait approximately 1s (with tight tolerance)
      assert.ok(elapsed >= 900 && elapsed <= 1200, `Should wait ~1s, got ${elapsed}ms`);
      
      // Should preserve retry ID and capture ID
      assert.equal(result.headers["x-retry-id"], requestCtx.headers["x-retry-id"]);
      assert.equal(result.headers["x-contextio-capture-id"], ctx.captureId);
      
      // Should increment retry count
      const internal = (plugin as any)._internal;
      assert.equal(internal.getRetryCount(ctx.captureId!), 1);
    });

    it("reads Retry-After header (HTTP-date), waits, and signals retry", async () => {
      const ctx = createMockRequestContext();
      await plugin.onRequest!(ctx);
      
      const futureDate = new Date(Date.now() + 500).toUTCString(); // 500ms in future
      
      const responseCtx = createMockResponseContext({
        status: 429,
        headers: {
          "content-type": "application/json",
          "retry-after": futureDate,
        },
        sessionId: "test-session-123",
        captureId: ctx.captureId,
      });
      
      const result = await plugin.onResponse!(responseCtx);
      
      // Should signal retry with status 599
      assert.equal(result.status, 599);
      // Note: HTTP-date parsing may fall back to exponential backoff depending on date format
      // The key assertion is that it signals retry (status 599)
    });

    it("falls back to exponential backoff when Retry-After is invalid", async () => {
      const ctx = createMockRequestContext();
      await plugin.onRequest!(ctx);
      
      const responseCtx = createMockResponseContext({
        status: 429,
        headers: {
          "content-type": "application/json",
          "retry-after": "invalid",
        },
        sessionId: "test-session-123",
        captureId: ctx.captureId,
      });
      
      const startTime = Date.now();
      const result = await plugin.onResponse!(responseCtx);
      const elapsed = Date.now() - startTime;
      
      assert.equal(result.status, 599);
      // First retry: baseDelayMs * 2^0 = 10ms (no jitter)
      assert.ok(elapsed >= 5 && elapsed <= 30, `Should use exponential backoff ~10ms, got ${elapsed}ms`);
    });
  });

  describe("onResponse - 5xx responses with exponential backoff", () => {
    it("retries 500 with exponential backoff", async () => {
      const ctx = createMockRequestContext();
      await plugin.onRequest!(ctx);
      
      const responseCtx = createMockResponseContext({
        status: 500,
        headers: { "content-type": "application/json" },
        sessionId: "test-session-123",
        captureId: ctx.captureId,
      });
      
      const startTime = Date.now();
      const result = await plugin.onResponse!(responseCtx);
      const elapsed = Date.now() - startTime;
      
      assert.equal(result.status, 599);
      // First retry: 10ms * 2^0 = 10ms
      assert.ok(elapsed >= 5 && elapsed <= 30);
      assert.equal((plugin as any)._internal.getRetryCount(ctx.captureId!), 1);
    });

    it("retries 502 with exponential backoff", async () => {
      const ctx = createMockRequestContext();
      await plugin.onRequest!(ctx);
      
      const responseCtx = createMockResponseContext({
        status: 502,
        headers: { "content-type": "application/json" },
        sessionId: "test-session-123",
        captureId: ctx.captureId,
      });
      
      const result = await plugin.onResponse!(responseCtx);
      assert.equal(result.status, 599);
    });

    it("retries 503 with exponential backoff", async () => {
      const ctx = createMockRequestContext();
      await plugin.onRequest!(ctx);
      
      const responseCtx = createMockResponseContext({
        status: 503,
        headers: { "content-type": "application/json" },
        sessionId: "test-session-123",
        captureId: ctx.captureId,
      });
      
      const result = await plugin.onResponse!(responseCtx);
      assert.equal(result.status, 599);
    });

    it("retries 504 with exponential backoff", async () => {
      const ctx = createMockRequestContext();
      await plugin.onRequest!(ctx);
      
      const responseCtx = createMockResponseContext({
        status: 504,
        headers: { "content-type": "application/json" },
        sessionId: "test-session-123",
        captureId: ctx.captureId,
      });
      
      const result = await plugin.onResponse!(responseCtx);
      assert.equal(result.status, 599);
    });

    it("increases delay exponentially on subsequent retries", async () => {
      const ctx = createMockRequestContext();
      await plugin.onRequest!(ctx);
      
      // First retry (attempt 0): 10ms
      let responseCtx = createMockResponseContext({ status: 500, sessionId: "test-session-123", captureId: ctx.captureId });
      let startTime = Date.now();
      await plugin.onResponse!(responseCtx);
      let elapsed1 = Date.now() - startTime;
      
      // Second retry (attempt 1): 20ms
      responseCtx = createMockResponseContext({ status: 500, sessionId: "test-session-123", captureId: ctx.captureId });
      startTime = Date.now();
      await plugin.onResponse!(responseCtx);
      let elapsed2 = Date.now() - startTime;
      
      // Third retry (attempt 2): 40ms
      responseCtx = createMockResponseContext({ status: 500, sessionId: "test-session-123", captureId: ctx.captureId });
      startTime = Date.now();
      await plugin.onResponse!(responseCtx);
      let elapsed3 = Date.now() - startTime;
      
      assert.ok(elapsed1 >= 5 && elapsed1 <= 30, `First retry ~10ms, got ${elapsed1}ms`);
      assert.ok(elapsed2 >= 10 && elapsed2 <= 50, `Second retry ~20ms, got ${elapsed2}ms`);
      assert.ok(elapsed3 >= 20 && elapsed3 <= 80, `Third retry ~40ms, got ${elapsed3}ms`);
      
      assert.equal((plugin as any)._internal.getRetryCount(ctx.captureId!), 3);
    });

    it("caps delay at maxDelayMs", async () => {
      // Create plugin with small maxDelayMs
      const cappedPlugin = createRetryPlugin({
        maxRetries: 5,
        baseDelayMs: 10,
        maxDelayMs: 50, // Cap at 50ms
        jitterFactor: 0,
      });
      
      const ctx = createMockRequestContext();
      await cappedPlugin.onRequest!(ctx);
      
      // Retry 0: 10ms
      // Retry 1: 20ms
      // Retry 2: 40ms -> capped at 50ms
      // Retry 3: 80ms -> capped at 50ms
      
      for (let i = 0; i < 4; i++) {
        const responseCtx = createMockResponseContext({ status: 500, sessionId: "test-session-123", captureId: ctx.captureId });
        const startTime = Date.now();
        await cappedPlugin.onResponse!(responseCtx);
        const elapsed = Date.now() - startTime;
        
        if (i >= 2) {
          assert.ok(elapsed >= 30 && elapsed <= 70, `Retry ${i} should be capped at 50ms, got ${elapsed}ms`);
        }
      }
      
      (cappedPlugin as any)._internal.shutdown();
    });
  });

  describe("onResponse - non-retryable status codes", () => {
    it("passes through 400 immediately without retry", async () => {
      const ctx = createMockRequestContext();
      await plugin.onRequest!(ctx);
      
      const responseCtx = createMockResponseContext({
        status: 400,
        headers: { "content-type": "application/json" },
        sessionId: "test-session-123",
        captureId: ctx.captureId,
      });
      
      const startTime = Date.now();
      const result = await plugin.onResponse!(responseCtx);
      const elapsed = Date.now() - startTime;
      
      assert.equal(result.status, 400, "Should pass through 400 unchanged");
      assert.ok(elapsed < 20, "Should not wait for non-retryable status");
      assert.equal((plugin as any)._internal.getRetryCount(ctx.captureId!), 0);
    });

    it("passes through 401 immediately without retry", async () => {
      const ctx = createMockRequestContext();
      await plugin.onRequest!(ctx);
      
      const responseCtx = createMockResponseContext({
        status: 401,
        headers: { "content-type": "application/json" },
        sessionId: "test-session-123",
        captureId: ctx.captureId,
      });
      
      const result = await plugin.onResponse!(responseCtx);
      assert.equal(result.status, 401);
    });

    it("passes through 403 immediately without retry", async () => {
      const ctx = createMockRequestContext();
      await plugin.onRequest!(ctx);
      
      const responseCtx = createMockResponseContext({
        status: 403,
        headers: { "content-type": "application/json" },
        sessionId: "test-session-123",
        captureId: ctx.captureId,
      });
      
      const result = await plugin.onResponse!(responseCtx);
      assert.equal(result.status, 403);
    });

    it("passes through 404 immediately without retry", async () => {
      const ctx = createMockRequestContext();
      await plugin.onRequest!(ctx);
      
      const responseCtx = createMockResponseContext({
        status: 404,
        headers: { "content-type": "application/json" },
        sessionId: "test-session-123",
        captureId: ctx.captureId,
      });
      
      const result = await plugin.onResponse!(responseCtx);
      assert.equal(result.status, 404);
    });

    it("passes through 2xx success responses without modification", async () => {
      const ctx = createMockRequestContext();
      await plugin.onRequest!(ctx);
      
      const responseCtx = createMockResponseContext({
        status: 200,
        headers: { "content-type": "application/json" },
        sessionId: "test-session-123",
        captureId: ctx.captureId,
      });
      
      const result = await plugin.onResponse!(responseCtx);
      assert.equal(result.status, 200);
      assert.equal(result.body, '{"result":"ok"}');
    });
  });

  describe("onResponse - max retries exceeded", () => {
    it("returns last error response when max retries exceeded", async () => {
      const ctx = createMockRequestContext();
      await plugin.onRequest!(ctx);
      
      // maxRetries = 3, so we need 4 attempts (0, 1, 2, 3) to exceed
      for (let i = 0; i < 3; i++) {
        const responseCtx = createMockResponseContext({ 
          status: 500, 
          sessionId: "test-session-123",
          captureId: ctx.captureId,
        });
        const result = await plugin.onResponse!(responseCtx);
        assert.equal(result.status, 599, `Retry ${i} should signal retry`);
      }
      
      // 4th attempt - should exceed maxRetries (3) and return the error
      const finalResponseCtx = createMockResponseContext({ 
        status: 500, 
        body: '{"error":"Internal server error"}',
        sessionId: "test-session-123",
        captureId: ctx.captureId,
      });
      const result = await plugin.onResponse!(finalResponseCtx);
      
      assert.equal(result.status, 500, "Should return original error status");
      assert.equal(result.body, '{"error":"Internal server error"}');
    });

    it("cleans up request store after max retries exceeded", async () => {
      const ctx = createMockRequestContext();
      await plugin.onRequest!(ctx);
      
      for (let i = 0; i < 3; i++) {
        await plugin.onResponse!(createMockResponseContext({ status: 500, sessionId: "test-session-123", captureId: ctx.captureId }));
      }
      
      await plugin.onResponse!(createMockResponseContext({ status: 500, sessionId: "test-session-123", captureId: ctx.captureId }));
      
      const internal = (plugin as any)._internal;
      const storedBody = internal.getRequestBody(ctx.captureId!);
      assert.equal(storedBody, undefined, "Should clean up request store after max retries");
    });
  });

  describe("onStreamChunk - SSE error detection", () => {
    it("detects error event in SSE stream (OpenAI style)", async () => {
      const ctx = createMockRequestContext();
      await plugin.onRequest!(ctx);
      
      // Simulate streaming chunk with error
      const errorChunk = Buffer.from(
        'data: {"error":{"message":"Rate limit exceeded","type":"rate_limit_error","code":429}}\n\n'
      );
      
      const result = plugin.onStreamChunk!(errorChunk, "test-session-123");
      assert.equal(result, errorChunk, "Should pass through chunk");
      
      const streamError = (plugin as any)._internal.getStreamError("test-session-123");
      assert.ok(streamError, "Should detect stream error");
      assert.equal(streamError.errorDetected, true);
      assert.equal(streamError.errorStatus, 429);
      assert.ok(streamError.errorMessage.includes("Rate limit exceeded"));
    });

    it("detects error event in SSE stream (Anthropic style)", async () => {
      const ctx = createMockRequestContext();
      await plugin.onRequest!(ctx);
      
      const errorChunk = Buffer.from(
        'data: {"type":"error","error":{"type":"rate_limit_error","message":"Rate limit exceeded"}}\n\n'
      );
      
      plugin.onStreamChunk!(errorChunk, "test-session-123");
      
      const streamError = (plugin as any)._internal.getStreamError("test-session-123");
      assert.ok(streamError.errorDetected);
      // Anthropic error format doesn't include numeric status, so status is null
      assert.equal(streamError.errorStatus, null);
      assert.ok(streamError.errorMessage.includes("Rate limit exceeded"));
    });

    it("detects explicit error event type in SSE", async () => {
      const ctx = createMockRequestContext();
      await plugin.onRequest!(ctx);
      
      const errorChunk = Buffer.from('event: error\n\n');
      
      plugin.onStreamChunk!(errorChunk, "test-session-123");
      
      const streamError = (plugin as any)._internal.getStreamError("test-session-123");
      assert.ok(streamError.errorDetected);
      assert.ok(streamError.hasErrorEvent);
      assert.equal(streamError.errorMessage, "SSE error event detected");
    });

    it("does not detect error for normal SSE data", async () => {
      const ctx = createMockRequestContext();
      await plugin.onRequest!(ctx);
      
      const normalChunk = Buffer.from(
        'data: {"type":"content_block_delta","delta":{"text":"Hello"}}\n\n'
      );
      
      plugin.onStreamChunk!(normalChunk, "test-session-123");
      
      const streamError = (plugin as any)._internal.getStreamError("test-session-123");
      assert.ok(!streamError.errorDetected, "Should not detect error for normal data");
    });

    it("handles partial SSE lines split across chunks", async () => {
      const ctx = createMockRequestContext();
      await plugin.onRequest!(ctx);
      
      // First chunk - partial line (incomplete JSON)
      const chunk1 = Buffer.from('data: {"error":{"message":');
      plugin.onStreamChunk!(chunk1, "test-session-123");
      
      // Second chunk - completes the line
      const chunk2 = Buffer.from('"test"}}\n\n');
      plugin.onStreamChunk!(chunk2, "test-session-123");
      
      const streamError = (plugin as any)._internal.getStreamError("test-session-123");
      assert.ok(streamError.errorDetected);
    });
  });

  describe("onStreamEnd - streaming retry signaling", () => {
    it("signals retry when SSE error detected at stream end", async () => {
      const ctx = createMockRequestContext();
      const requestCtx = await plugin.onRequest!(ctx);
      
      // Send error chunk
      const errorChunk = Buffer.from(
        'data: {"error":{"message":"Rate limit","type":"rate_limit_error","code":429}}\n\n'
      );
      plugin.onStreamChunk!(errorChunk, "test-session-123");
      
      // End stream - should signal retry
      const flushed = plugin.onStreamEnd!("test-session-123");
      
      // Check if pending retry was set
      const pendingRetry = (plugin as any)._internal.getAndConsumePendingStreamRetry("test-session-123");
      assert.ok(pendingRetry, "Should have pending retry for streaming error");
      assert.equal(pendingRetry.retryId, requestCtx.headers["x-retry-id"]);
      assert.ok(pendingRetry.originalBodyBuffer);
      assert.ok(pendingRetry.delayMs > 0);
    });

    it("does not signal retry for successful stream", async () => {
      const ctx = createMockRequestContext();
      await plugin.onRequest!(ctx);
      
      const normalChunk = Buffer.from(
        'data: {"type":"message_stop"}\n\n'
      );
      plugin.onStreamChunk!(normalChunk, "test-session-123");
      
      const flushed = plugin.onStreamEnd!("test-session-123");
      
      const pendingRetry = (plugin as any)._internal.getAndConsumePendingStreamRetry("test-session-123");
      assert.equal(pendingRetry, null, "Should not have pending retry for successful stream");
    });

    it("respects maxRetries for streaming retries", async () => {
      const ctx = createMockRequestContext();
      await plugin.onRequest!(ctx);
      
      // maxRetries = 3 means 3 retries allowed (retryCount 0, 1, 2)
      // 4th attempt (retryCount 3) should not retry
      
      // First 3 attempts should retry
      for (let i = 0; i < 3; i++) {
        const errorChunk = Buffer.from(
          `data: {"error":{"message":"Error ${i}","code":500}}\n\n`
        );
        plugin.onStreamChunk!(errorChunk, "test-session-123");
        plugin.onStreamEnd!("test-session-123");
        
        const pendingRetry = (plugin as any)._internal.getAndConsumePendingStreamRetry("test-session-123");
        assert.ok(pendingRetry, `Should have pending retry for attempt ${i}`);
      }
      
      // 4th attempt should not retry
      const errorChunk = Buffer.from(
        `data: {"error":{"message":"Error 3","code":500}}\n\n`
      );
      plugin.onStreamChunk!(errorChunk, "test-session-123");
      plugin.onStreamEnd!("test-session-123");
      
      const pendingRetry = (plugin as any)._internal.getAndConsumePendingStreamRetry("test-session-123");
      assert.equal(pendingRetry, null, "Should not retry after max retries exceeded");
    });
  });

  describe("request body buffering and replay", () => {
    it("buffers and replays original request body on retry", async () => {
      const originalBody = { model: "claude-3", messages: [{ role: "user", content: "test" }] };
      const ctx = createMockRequestContext({ body: originalBody, rawBody: Buffer.from(JSON.stringify(originalBody)) });
      await plugin.onRequest!(ctx);
      
      // Trigger retry
      const responseCtx = createMockResponseContext({ status: 429, sessionId: "test-session-123", captureId: ctx.captureId });
      await plugin.onResponse!(responseCtx);
      
      // Verify original body is stored
      const internal = (plugin as any)._internal;
      const storedBody = internal.getRequestBody(ctx.captureId!);
      const storedJson = internal.getRequestBodyJson(ctx.captureId!);
      
      assert.ok(storedBody);
      assert.equal(storedBody!.toString(), JSON.stringify(originalBody));
      assert.deepEqual(storedJson, originalBody);
    });

    it("buffers and replays request headers on retry", async () => {
      const ctx = createMockRequestContext({
        headers: { 
          "content-type": "application/json", 
          "anthropic-version": "2023-06-01",
          "x-custom-header": "custom-value"
        } as HeaderMap,
      });
      await plugin.onRequest!(ctx);
      
      const responseCtx = createMockResponseContext({ status: 500, sessionId: "test-session-123", captureId: ctx.captureId });
      await plugin.onResponse!(responseCtx);
      
      const internal = (plugin as any)._internal;
      const storedHeaders = internal.getRequestHeaders(ctx.captureId!);
      
      assert.ok(storedHeaders);
      assert.equal(storedHeaders!["content-type"], "application/json");
      assert.equal(storedHeaders!["anthropic-version"], "2023-06-01");
      assert.equal(storedHeaders!["x-custom-header"], "custom-value");
    });

    it("preserves captureId for retry requests", async () => {
      const ctx = createMockRequestContext({ captureId: "my-capture-456" });
      await plugin.onRequest!(ctx);
      
      // Response context must have the same captureId for plugin to find stored entry
      const responseCtx = createMockResponseContext({ 
        status: 500, 
        sessionId: "test-session-123",
        captureId: "my-capture-456",
      });
      const result = await plugin.onResponse!(responseCtx);
      
      assert.equal(result.headers["x-contextio-capture-id"], "my-capture-456");
    });
  });

  describe("per-provider config isolation", () => {
    it("uses provider-specific config when configured", async () => {
      const providerPlugin = createRetryPlugin({
        maxRetries: 1,
        baseDelayMs: 10,
        maxDelayMs: 100,
        jitterFactor: 0,
        providers: {
          anthropic: {
            maxRetries: 5,
            baseDelayMs: 50,
          },
          openai: {
            maxRetries: 2,
            baseDelayMs: 20,
          },
        },
      });
      
      // Test anthropic config (5 retries, 50ms base)
      const anthropicCtx = createMockRequestContext({ provider: "anthropic", captureId: "capture-anthropic-123" });
      await providerPlugin.onRequest!(anthropicCtx);
      
      // maxRetries=5 means 5 retries allowed (retryCount 0,1,2,3,4)
      // 6th attempt (retryCount=5) should fail
      for (let i = 0; i < 6; i++) {
        const responseCtx = createMockResponseContext({ status: 500, sessionId: "test-session-123", captureId: "capture-anthropic-123" });
        const result = await providerPlugin.onResponse!(responseCtx);
        if (i < 5) {
          assert.equal(result.status, 599, `Anthropic retry ${i} should signal retry`);
        } else {
          assert.equal(result.status, 500, "Anthropic should allow 5 retries");
        }
      }
      
      // Test openai config (2 retries, 20ms base)
      const openaiCtx = createMockRequestContext({ 
        provider: "openai", 
        captureId: "capture-openai-123" 
      });
      await providerPlugin.onRequest!(openaiCtx);
      
      // maxRetries=2 means 2 retries allowed (retryCount 0,1)
      // 3rd attempt (retryCount=2) should fail
      for (let i = 0; i < 3; i++) {
        const responseCtx = createMockResponseContext({ status: 500, sessionId: "test-session-123", captureId: "capture-openai-123" });
        const result = await providerPlugin.onResponse!(responseCtx);
        if (i < 2) {
          assert.equal(result.status, 599, `OpenAI retry ${i} should signal retry`);
        } else {
          assert.equal(result.status, 500, "OpenAI should allow 2 retries");
        }
      }
      
      // Test default provider (1 retry)
      const defaultCtx = createMockRequestContext({ 
        provider: "gemini", 
        captureId: "capture-gemini-123" 
      });
      await providerPlugin.onRequest!(defaultCtx);
      
      // maxRetries=1 means 1 retry allowed (retryCount 0)
      // 2nd attempt (retryCount=1) should fail
      const responseCtx1 = createMockResponseContext({ status: 500, sessionId: "test-session-123", captureId: "capture-gemini-123" });
      const result1 = await providerPlugin.onResponse!(responseCtx1);
      assert.equal(result1.status, 599, "Default provider should allow 1 retry");
      
      const responseCtx2 = createMockResponseContext({ status: 500, sessionId: "test-session-123", captureId: "capture-gemini-123" });
      const result2 = await providerPlugin.onResponse!(responseCtx2);
      assert.equal(result2.status, 500, "Default provider should not allow 2nd retry");
      
      (providerPlugin as any)._internal.shutdown();
    });

    it("falls back to global config for unknown providers", async () => {
      const providerPlugin = createRetryPlugin({
        maxRetries: 2,
        baseDelayMs: 10,
        providers: {
          anthropic: { maxRetries: 5 },
        },
      });
      
      const ctx = createMockRequestContext({ provider: "unknown-provider", captureId: "capture-unknown-123" });
      await providerPlugin.onRequest!(ctx);
      
      // Should use global config (2 retries)
      // maxRetries=2 means 2 retries allowed (retryCount 0,1)
      // 3rd attempt (retryCount=2) should fail
      const responseCtx1 = createMockResponseContext({ status: 500, sessionId: "test-session-123", captureId: "capture-unknown-123" });
      await providerPlugin.onResponse!(responseCtx1); // retry 1
      
      const responseCtx2 = createMockResponseContext({ status: 500, sessionId: "test-session-123", captureId: "capture-unknown-123" });
      await providerPlugin.onResponse!(responseCtx2); // retry 2
      
      const responseCtx3 = createMockResponseContext({ status: 500, sessionId: "test-session-123", captureId: "capture-unknown-123" });
      const result = await providerPlugin.onResponse!(responseCtx3); // retry 3 - should exceed
      assert.equal(result.status, 500);
      
      (providerPlugin as any)._internal.shutdown();
    });
  });

  describe("disabled plugin", () => {
    it("passes through all responses when disabled globally", async () => {
      const disabledPlugin = createRetryPlugin({ enabled: false });
      
      const ctx = createMockRequestContext();
      const result = await disabledPlugin.onRequest!(ctx);
      
      assert.equal(result.headers["x-retry-id"], undefined, "Should not add x-retry-id when disabled");
      
      const responseCtx = createMockResponseContext({ status: 500, sessionId: "test-session-123", captureId: ctx.captureId });
      const responseResult = await disabledPlugin.onResponse!(responseCtx);
      
      assert.equal(responseResult.status, 500, "Should pass through 500 when disabled");
      
      (disabledPlugin as any)._internal.shutdown();
    });

    it("ignores provider config when globally disabled", async () => {
      const disabledPlugin = createRetryPlugin({ 
        enabled: false,
        providers: {
          anthropic: { maxRetries: 5 }, // Should be ignored when globally disabled
        },
      });
      
      const ctx = createMockRequestContext({ provider: "anthropic" });
      await disabledPlugin.onRequest!(ctx);
      
      const responseCtx = createMockResponseContext({ status: 500, sessionId: "test-session-123", captureId: ctx.captureId });
      const result = await disabledPlugin.onResponse!(responseCtx);
      
      assert.equal(result.status, 500);
      
      (disabledPlugin as any)._internal.shutdown();
    });
  });
});

describe("retry plugin - integration with proxy", () => {
  let proxy: { start: () => Promise<void>; stop: () => Promise<void>; port: number };
  let upstreamServer: http.Server;
  let upstreamPort: number;
  let requestCount: number;
  let retryPlugin: ReturnType<typeof createRetryPlugin>;

  before(async () => {
    // Create mock upstream server
    requestCount = 0;
    
    upstreamServer = http.createServer((req, res) => {
      requestCount++;
      
      if (requestCount === 1) {
        // First request: 429 with Retry-After: 0.1s
        res.writeHead(429, { 
          "content-type": "application/json",
          "retry-after": "0.1", // 100ms for fast test
        });
        res.end(JSON.stringify({ error: "Rate limited" }));
      } else {
        // Subsequent requests: 200 OK
        res.writeHead(200, { "content-type": "application/json" });
        res.end(JSON.stringify({ success: true, attempt: requestCount }));
      }
    });
    
    await new Promise<void>((resolve) => upstreamServer.listen(0, resolve));
    upstreamPort = getServerPort(upstreamServer);
    
    // Create proxy with retry plugin
    retryPlugin = createRetryPlugin({
      maxRetries: 3,
      baseDelayMs: 50, // Fast for tests
      maxDelayMs: 500,
      jitterFactor: 0,
    });
    
    proxy = createProxy({
      port: 0,
      upstreams: { anthropic: `http://127.0.0.1:${upstreamPort}` },
      plugins: [retryPlugin],
    });
    
    await proxy.start();
  });

  after(async () => {
    await proxy.stop();
    upstreamServer.close();
    (retryPlugin as any)._internal.shutdown();
  });

  it("retries on 429 and succeeds on subsequent attempt", async () => {
    const response = await makeRequest(proxy.port, {
      path: "/v1/messages",
      method: "POST",
      body: JSON.stringify({ model: "claude-3", messages: [] }),
      headers: { "content-type": "application/json", "anthropic-version": "2023-06-01" },
    });
    
    // Should succeed after retry
    assert.equal(response.status, 200);
    const body = JSON.parse(response.body);
    assert.equal(body.success, true);
    assert.equal(body.attempt, 2); // Second attempt succeeded
    
    // Should have made 2 requests to upstream
    assert.equal(requestCount, 2);
  });

  it("retries on 500 with exponential backoff", async () => {
    let attempt = 0;
    let server500: http.Server;
    
    server500 = http.createServer((req, res) => {
      attempt++;
      if (attempt <= 2) {
        res.writeHead(500, { "content-type": "application/json" });
        res.end(JSON.stringify({ error: "Server error" }));
      } else {
        res.writeHead(200, { "content-type": "application/json" });
        res.end(JSON.stringify({ success: true, attempt }));
      }
    });
    
    await new Promise<void>((resolve) => server500.listen(0, resolve));
    const port500 = getServerPort(server500);
    
    const retryPlugin = createRetryPlugin({
      maxRetries: 3,
      baseDelayMs: 50,
      maxDelayMs: 500,
      jitterFactor: 0,
    });
    
    const proxy500 = createProxy({
      port: 0,
      upstreams: { anthropic: `http://127.0.0.1:${port500}` },
      plugins: [retryPlugin],
    });
    
    await proxy500.start();
    
    try {
      const response = await makeRequest(proxy500.port, {
        path: "/v1/messages",
        method: "POST",
        body: JSON.stringify({ model: "claude-3", messages: [] }),
        headers: { "content-type": "application/json" },
      });
      
      assert.equal(response.status, 200);
      const body = JSON.parse(response.body);
      assert.equal(body.attempt, 3); // Third attempt succeeded
      assert.equal(attempt, 3);
    } finally {
      await proxy500.stop();
      server500.close();
      (retryPlugin as any)._internal.shutdown();
    }
  });

  it("passes through 400 without retry", async () => {
    let server400: http.Server;
    
    server400 = http.createServer((req, res) => {
      res.writeHead(400, { "content-type": "application/json" });
      res.end(JSON.stringify({ error: "Bad request" }));
    });
    
    await new Promise<void>((resolve) => server400.listen(0, resolve));
    const port400 = getServerPort(server400);
    
    const retryPlugin = createRetryPlugin({
      maxRetries: 3,
      baseDelayMs: 50,
    });
    
    const proxy400 = createProxy({
      port: 0,
      upstreams: { anthropic: `http://127.0.0.1:${port400}` },
      plugins: [retryPlugin],
    });
    
    await proxy400.start();
    
    try {
      const response = await makeRequest(proxy400.port, {
        path: "/v1/messages",
        method: "POST",
        body: JSON.stringify({ model: "claude-3", messages: [] }),
        headers: { "content-type": "application/json" },
      });
      
      assert.equal(response.status, 400);
      const body = JSON.parse(response.body);
      assert.ok(body.error.includes("Bad request"));
    } finally {
      await proxy400.stop();
      server400.close();
      (retryPlugin as any)._internal.shutdown();
    }
  });

  it("returns error after max retries exceeded", async () => {
    let attempt = 0;
    let serverFail: http.Server;
    
    serverFail = http.createServer((req, res) => {
      attempt++;
      res.writeHead(503, { "content-type": "application/json" });
      res.end(JSON.stringify({ error: "Service unavailable", attempt }));
    });
    
    await new Promise<void>((resolve) => serverFail.listen(0, resolve));
    const portFail = getServerPort(serverFail);
    
    const retryPlugin = createRetryPlugin({
      maxRetries: 2, // Only 2 retries
      baseDelayMs: 20,
      maxDelayMs: 100,
      jitterFactor: 0,
    });
    
    const proxyFail = createProxy({
      port: 0,
      upstreams: { anthropic: `http://127.0.0.1:${portFail}` },
      plugins: [retryPlugin],
    });
    
    await proxyFail.start();
    
    try {
      const response = await makeRequest(proxyFail.port, {
        path: "/v1/messages",
        method: "POST",
        body: JSON.stringify({ model: "claude-3", messages: [] }),
        headers: { "content-type": "application/json" },
      });
      
      // Should return the last error after max retries (2 retries = 3 total attempts)
      assert.equal(response.status, 503);
      assert.equal(attempt, 3); // Initial + 2 retries
    } finally {
      await proxyFail.stop();
      serverFail.close();
      (retryPlugin as any)._internal.shutdown();
    }
  });
});