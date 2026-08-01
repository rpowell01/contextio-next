/**
 * @contextio/proxy - Retry Plugin Integration Tests
 *
 * End-to-end integration tests for the retry plugin with a real proxy server
 * and mock upstream servers.
 */

import { describe, it, before, after, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import http from "node:http";
import { createProxy } from "../dist/proxy.js";
import { createRetryPlugin } from "../dist/retry-plugin.js";
import type { ProxyPlugin } from "@contextio/core";

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
): Promise<{ status: number; body: string; headers: http.IncomingHttpHeaders }> {
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
            headers: res.headers,
          });
        });
      },
    );
    req.on("error", reject);
    if (options.body) req.write(options.body);
    req.end();
  });
}

async function makeStreamingRequest(
  port: number,
  options: {
    path: string;
    headers?: Record<string, string>;
    body?: string;
  },
): Promise<{ status: number; body: string; headers: http.IncomingHttpHeaders }> {
  return new Promise((resolve, reject) => {
    const req = http.request(
      {
        hostname: "127.0.0.1",
        port,
        method: "POST",
        path: options.path,
        headers: {
          "Content-Type": "application/json",
          "anthropic-version": "2023-06-01",
          ...options.headers,
        },
      },
      (res) => {
        const chunks: Buffer[] = [];
        res.on("data", (chunk: Buffer) => chunks.push(chunk));
        res.on("end", () => {
          resolve({
            status: res.statusCode!,
            body: Buffer.concat(chunks).toString("utf8"),
            headers: res.headers,
          });
        });
        res.on("error", reject);
      },
    );
    req.on("error", reject);
    if (options.body) req.write(options.body);
    req.end();
  });
}

describe("retry plugin - integration tests", () => {
  let proxy: { start: () => Promise<void>; stop: () => Promise<void>; port: number };
  let retryPlugin: ReturnType<typeof createRetryPlugin>;

  before(async () => {
    retryPlugin = createRetryPlugin({
      maxRetries: 3,
      baseDelayMs: 50, // Fast for tests
      maxDelayMs: 500,
      jitterFactor: 0, // Disable jitter for predictable timing tests
      retryableStatuses: [429, 500, 502, 503, 504],
      enabled: true,
    });

    proxy = createProxy({
      port: 0,
      upstreams: {
        anthropic: "http://127.0.0.1:1", // Will be overridden per test
        openai: "http://127.0.0.1:1",
        gemini: "http://127.0.0.1:1",
        chatgpt: "http://127.0.0.1:1",
        geminiCodeAssist: "http://127.0.0.1:1",
      },
      plugins: [retryPlugin],
    });

    await proxy.start();
  });

  after(async () => {
    await proxy.stop();
    (retryPlugin as any)._internal.shutdown();
  });

  describe("429 with Retry-After header", () => {
    let upstreamServer: http.Server;
    let upstreamPort: number;
    let requestCount: number;

    beforeEach(async () => {
      requestCount = 0;
      upstreamServer = http.createServer((req, res) => {
        requestCount++;
        if (requestCount === 1) {
          // First request: 429 with Retry-After: 1 second
          res.writeHead(429, {
            "content-type": "application/json",
            "retry-after": "1", // 1 second
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

      // Update proxy upstream for anthropic
      (proxy as any).upstreams.anthropic = `http://127.0.0.1:${upstreamPort}`;
    });

    afterEach(async () => {
      upstreamServer.close();
    });

    it("retries on 429 with Retry-After: 1 and succeeds on retry", async () => {
      const startTime = Date.now();
      const response = await makeRequest(proxy.port, {
        path: "/v1/messages",
        method: "POST",
        body: JSON.stringify({ model: "claude-3", messages: [] }),
        headers: { "content-type": "application/json", "anthropic-version": "2023-06-01" },
      });
      const elapsed = Date.now() - startTime;

      // Should succeed after retry
      assert.equal(response.status, 200);
      const body = JSON.parse(response.body);
      assert.equal(body.success, true);
      assert.equal(body.attempt, 2); // Second attempt succeeded

      // Should have made 2 requests to upstream
      assert.equal(requestCount, 2);

      // Should have waited approximately 1 second (Retry-After: 1)
      // Allow some tolerance for test execution overhead
      assert.ok(elapsed >= 900 && elapsed <= 2000, `Should wait ~1s for Retry-After, got ${elapsed}ms`);
    });
  });

  describe("5xx responses with exponential backoff", () => {
    let upstreamServer: http.Server;
    let upstreamPort: number;
    let requestCount: number;
    let attemptTimestamps: number[];

    beforeEach(async () => {
      requestCount = 0;
      attemptTimestamps = [];
      upstreamServer = http.createServer((req, res) => {
        requestCount++;
        attemptTimestamps.push(Date.now());
        if (requestCount <= 3) {
          // First 3 requests: 500
          res.writeHead(500, { "content-type": "application/json" });
          res.end(JSON.stringify({ error: "Server error", attempt: requestCount }));
        } else {
          // 4th request: 200 OK
          res.writeHead(200, { "content-type": "application/json" });
          res.end(JSON.stringify({ success: true, attempt: requestCount }));
        }
      });
      await new Promise<void>((resolve) => upstreamServer.listen(0, resolve));
      upstreamPort = getServerPort(upstreamServer);

      (proxy as any).upstreams.anthropic = `http://127.0.0.1:${upstreamPort}`;
    });

    afterEach(async () => {
      upstreamServer.close();
    });

    it("retries on 500 three times with exponential backoff, then succeeds", async () => {
      const startTime = Date.now();
      const response = await makeRequest(proxy.port, {
        path: "/v1/messages",
        method: "POST",
        body: JSON.stringify({ model: "claude-3", messages: [] }),
        headers: { "content-type": "application/json" },
      });
      const totalElapsed = Date.now() - startTime;

      // Should succeed after 3 retries (4th attempt)
      assert.equal(response.status, 200);
      const body = JSON.parse(response.body);
      assert.equal(body.success, true);
      assert.equal(body.attempt, 4);

      // Should have made 4 requests to upstream (initial + 3 retries)
      assert.equal(requestCount, 4);

      // Verify exponential backoff timing
      // Retry 0: baseDelayMs * 2^0 = 50ms
      // Retry 1: baseDelayMs * 2^1 = 100ms
      // Retry 2: baseDelayMs * 2^2 = 200ms
      // Total expected delay: ~350ms (plus small overhead)
      const expectedMinDelay = 50 + 100 + 200 - 100; // Allow some tolerance
      const expectedMaxDelay = 50 + 100 + 200 + 200; // Allow overhead
      assert.ok(
        totalElapsed >= expectedMinDelay && totalElapsed <= expectedMaxDelay,
        `Total time ${totalElapsed}ms should be approximately 350ms (50+100+200) for 3 retries`
      );

      // Verify individual retry delays via timestamps
      if (attemptTimestamps.length >= 4) {
        const delay1 = attemptTimestamps[1] - attemptTimestamps[0]; // Between attempt 1 and 2
        const delay2 = attemptTimestamps[2] - attemptTimestamps[1]; // Between attempt 2 and 3
        const delay3 = attemptTimestamps[3] - attemptTimestamps[2]; // Between attempt 3 and 4

        // First retry: ~50ms (baseDelay * 2^0)
        assert.ok(delay1 >= 40 && delay1 <= 120, `First retry delay ${delay1}ms should be ~50ms`);
        // Second retry: ~100ms (baseDelay * 2^1)
        assert.ok(delay2 >= 80 && delay2 <= 180, `Second retry delay ${delay2}ms should be ~100ms`);
        // Third retry: ~200ms (baseDelay * 2^2)
        assert.ok(delay3 >= 160 && delay3 <= 300, `Third retry delay ${delay3}ms should be ~200ms`);
      }
    });
  });

  describe("non-retryable status codes", () => {
    let upstreamServer: http.Server;
    let upstreamPort: number;
    let requestCount: number;

    beforeEach(async () => {
      requestCount = 0;
      upstreamServer = http.createServer((req, res) => {
        requestCount++;
        res.writeHead(400, { "content-type": "application/json" });
        res.end(JSON.stringify({ error: "Bad request" }));
      });
      await new Promise<void>((resolve) => upstreamServer.listen(0, resolve));
      upstreamPort = getServerPort(upstreamServer);

      (proxy as any).upstreams.anthropic = `http://127.0.0.1:${upstreamPort}`;
    });

    afterEach(async () => {
      upstreamServer.close();
    });

    it("passes through 400 immediately without retry", async () => {
      const startTime = Date.now();
      const response = await makeRequest(proxy.port, {
        path: "/v1/messages",
        method: "POST",
        body: JSON.stringify({ model: "claude-3", messages: [] }),
        headers: { "content-type": "application/json" },
      });
      const elapsed = Date.now() - startTime;

      // Should return 400 immediately
      assert.equal(response.status, 400);
      const body = JSON.parse(response.body);
      assert.ok(body.error.includes("Bad request"));

      // Should have made exactly 1 request (no retries)
      assert.equal(requestCount, 1);

      // Should not have waited
      assert.ok(elapsed < 100, `Should not wait for non-retryable status, got ${elapsed}ms`);
    });
  });

  describe("streaming responses with SSE error events", () => {
    let upstreamServer: http.Server;
    let upstreamPort: number;
    let requestCount: number;

    beforeEach(async () => {
      requestCount = 0;
      upstreamServer = http.createServer((req, res) => {
        requestCount++;
        if (requestCount === 1) {
          // First attempt: SSE stream with error event
          res.writeHead(200, {
            "Content-Type": "text/event-stream",
            "Cache-Control": "no-cache",
            Connection: "keep-alive",
          });
          // Send normal data first
          res.write('data: {"type":"content_block_delta","index":0,"delta":{"type":"text_delta","text":"Partial "}}\n\n');
          // Then send error event
          res.write('event: error\n');
          res.write('data: {"error":{"message":"Rate limit exceeded","type":"rate_limit_error","code":429}}\n\n');
          setTimeout(() => res.end(), 50);
        } else {
          // Retry attempt: successful stream
          res.writeHead(200, {
            "Content-Type": "text/event-stream",
            "Cache-Control": "no-cache",
            Connection: "keep-alive",
          });
          res.write('data: {"type":"content_block_delta","index":0,"delta":{"type":"text_delta","text":"Success "}}\n\n');
          res.write('data: {"type":"content_block_delta","index":0,"delta":{"type":"text_delta","text":"response"}}\n\n');
          res.write('data: {"type":"message_stop"}\n\n');
          setTimeout(() => res.end(), 50);
        }
      });
      await new Promise<void>((resolve) => upstreamServer.listen(0, resolve));
      upstreamPort = getServerPort(upstreamServer);

      (proxy as any).upstreams.anthropic = `http://127.0.0.1:${upstreamPort}`;
    });

    afterEach(async () => {
      upstreamServer.close();
    });

    it("retries on SSE error event in streaming response", async () => {
      const startTime = Date.now();
      const response = await makeStreamingRequest(proxy.port, {
        path: "/v1/messages",
        body: JSON.stringify({ model: "claude-3", messages: [] }),
      });
      const elapsed = Date.now() - startTime;

      // Should succeed on retry
      assert.equal(response.status, 200);
      assert.ok(response.body.includes("Success response"), `Should receive successful stream, got: ${response.body}`);

      // Should have made 2 requests (initial + 1 retry)
      assert.equal(requestCount, 2);

      // Should have waited for backoff delay (baseDelayMs * 2^0 = 50ms)
      assert.ok(elapsed >= 40 && elapsed <= 500, `Should wait for backoff ~50ms, got ${elapsed}ms`);
    });

    it("retries on SSE data error object (OpenAI style)", async () => {
      requestCount = 0;
      // Override the upstream for this specific test
      upstreamServer.close();
      upstreamServer = http.createServer((req, res) => {
        requestCount++;
        if (requestCount === 1) {
          res.writeHead(200, {
            "Content-Type": "text/event-stream",
            "Cache-Control": "no-cache",
            Connection: "keep-alive",
          });
          // OpenAI style error in data field
          res.write('data: {"error":{"message":"Rate limit exceeded","type":"rate_limit_error","code":429}}\n\n');
          setTimeout(() => res.end(), 50);
        } else {
          res.writeHead(200, {
            "Content-Type": "text/event-stream",
            "Cache-Control": "no-cache",
            Connection: "keep-alive",
          });
          res.write('data: {"type":"content_block_delta","index":0,"delta":{"type":"text_delta","text":"Retry succeeded"}}\n\n');
          res.write('data: {"type":"message_stop"}\n\n');
          setTimeout(() => res.end(), 50);
        }
      });
      await new Promise<void>((resolve) => upstreamServer.listen(0, resolve));
      upstreamPort = getServerPort(upstreamServer);
      (proxy as any).upstreams.anthropic = `http://127.0.0.1:${upstreamPort}`;

      const response = await makeStreamingRequest(proxy.port, {
        path: "/v1/messages",
        body: JSON.stringify({ model: "claude-3", messages: [] }),
      });

      assert.equal(response.status, 200);
      assert.ok(response.body.includes("Retry succeeded"), `Should receive successful stream, got: ${response.body}`);
      assert.equal(requestCount, 2);
    });

    it("retries on SSE data error object (Anthropic style)", async () => {
      requestCount = 0;
      upstreamServer.close();
      upstreamServer = http.createServer((req, res) => {
        requestCount++;
        if (requestCount === 1) {
          res.writeHead(200, {
            "Content-Type": "text/event-stream",
            "Cache-Control": "no-cache",
            Connection: "keep-alive",
          });
          // Anthropic style error: { type: "error", error: {...} }
          res.write('data: {"type":"error","error":{"type":"rate_limit_error","message":"Rate limit exceeded"}}\n\n');
          setTimeout(() => res.end(), 50);
        } else {
          res.writeHead(200, {
            "Content-Type": "text/event-stream",
            "Cache-Control": "no-cache",
            Connection: "keep-alive",
          });
          res.write('data: {"type":"content_block_delta","index":0,"delta":{"type":"text_delta","text":"Anthropic retry ok"}}\n\n');
          res.write('data: {"type":"message_stop"}\n\n');
          setTimeout(() => res.end(), 50);
        }
      });
      await new Promise<void>((resolve) => upstreamServer.listen(0, resolve));
      upstreamPort = getServerPort(upstreamServer);
      (proxy as any).upstreams.anthropic = `http://127.0.0.1:${upstreamPort}`;

      const response = await makeStreamingRequest(proxy.port, {
        path: "/v1/messages",
        body: JSON.stringify({ model: "claude-3", messages: [] }),
      });

      assert.equal(response.status, 200);
      assert.ok(response.body.includes("Anthropic retry ok"), `Should receive successful stream, got: ${response.body}`);
      assert.equal(requestCount, 2);
    });
  });

  describe("max retries exceeded", () => {
    let upstreamServer: http.Server;
    let upstreamPort: number;
    let requestCount: number;

    beforeEach(async () => {
      requestCount = 0;
      upstreamServer = http.createServer((req, res) => {
        requestCount++;
        res.writeHead(503, { "content-type": "application/json" });
        res.end(JSON.stringify({ error: "Service unavailable", attempt: requestCount }));
      });
      await new Promise<void>((resolve) => upstreamServer.listen(0, resolve));
      upstreamPort = getServerPort(upstreamServer);

      // Use a plugin with only 1 retry (maxRetries=1 = 1 retry = 2 total attempts)
      const limitedRetryPlugin = createRetryPlugin({
        maxRetries: 1,
        baseDelayMs: 20,
        maxDelayMs: 100,
        jitterFactor: 0,
      });

      const proxyLimited = createProxy({
        port: 0,
        upstreams: {
          anthropic: `http://127.0.0.1:${upstreamPort}`,
          openai: `http://127.0.0.1:${upstreamPort}`,
          gemini: `http://127.0.0.1:${upstreamPort}`,
          chatgpt: `http://127.0.0.1:${upstreamPort}`,
          geminiCodeAssist: `http://127.0.0.1:${upstreamPort}`,
        },
        plugins: [limitedRetryPlugin],
      });
      await proxyLimited.start();

      // Temporarily replace proxy
      const originalProxy = proxy;
      (global as any).testProxyLimited = proxyLimited;
      (global as any).testRetryPluginLimited = limitedRetryPlugin;
      proxy = proxyLimited;
      retryPlugin = limitedRetryPlugin;
    });

    afterEach(async () => {
      upstreamServer.close();
      const limitedProxy = (global as any).testProxyLimited;
      const limitedPlugin = (global as any).testRetryPluginLimited;
      if (limitedProxy) await limitedProxy.stop();
      if (limitedPlugin) (limitedPlugin as any)._internal.shutdown();
    });

    it("returns error after max retries exceeded", async () => {
      const response = await makeRequest(proxy.port, {
        path: "/v1/messages",
        method: "POST",
        body: JSON.stringify({ model: "claude-3", messages: [] }),
        headers: { "content-type": "application/json" },
      });

      // Should return the last error after max retries (1 retry = 2 total attempts)
      assert.equal(response.status, 503);
      const body = JSON.parse(response.body);
      assert.ok(body.error.includes("Service unavailable"));

      // Should have made 2 requests (initial + 1 retry)
      assert.equal(requestCount, 2);
    });
  });
});