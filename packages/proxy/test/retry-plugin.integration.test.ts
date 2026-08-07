/**
 * @contextio/proxy - Retry Plugin Integration Tests
 *
 * End-to-end integration tests for the retry plugin with a real proxy server
 * and mock upstream servers.
 */

import { describe, it, before, after, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import http from "node:http";
import fs from "node:fs";
import path from "node:path";
import { tmpdir } from "node:os";
import { mkdtempSync, rmSync } from "node:fs";
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
  let tempDir: string;
  let providersPath: string;

  before(async () => {
    // Create temporary directory and providers.json for config resolution
    tempDir = mkdtempSync(path.join(tmpdir(), "contextio-proxy-test-"));
    providersPath = path.join(tempDir, "providers.json");
    process.env.PROVIDERS_FILE = providersPath;
    process.env.HOME = tempDir;
    process.env.USERPROFILE = tempDir;

    // Write minimal providers.json
    const defaultProviders = {
      anthropic: { id: "anthropic", name: "Anthropic", upstreamUrl: "https://api.anthropic.com", apiFormat: "anthropic-messages", authType: "bearer", enabled: true, rateLimit: { maxRequests: 60, windowMs: 60000, bufferCapacity: 10 }, retry: { maxRetries: 3, baseDelayMs: 1000, maxDelayMs: 30000, retryableStatuses: [429, 500, 502, 503, 504], jitterFactor: 0.2, maxStreamRetries: 3, maxResponseBufferSize: 10485760, enabled: true }, customHeaders: {}, allowBaseUrlOverride: true, baseUrlOverrideHeader: "x-anthropic-baseurl" },
      openai: { id: "openai", name: "OpenAI", upstreamUrl: "https://api.openai.com", apiFormat: "chat-completions", authType: "bearer", enabled: true, rateLimit: { maxRequests: 60, windowMs: 60000, bufferCapacity: 10 }, retry: { maxRetries: 3, baseDelayMs: 1000, maxDelayMs: 30000, retryableStatuses: [429, 500, 502, 503, 504], jitterFactor: 0.2, maxStreamRetries: 3, maxResponseBufferSize: 10485760, enabled: true }, customHeaders: {}, allowBaseUrlOverride: true, baseUrlOverrideHeader: "x-openai-baseurl" },
      chatgpt: { id: "chatgpt", name: "ChatGPT", upstreamUrl: "https://chatgpt.com", apiFormat: "chatgpt-backend", authType: "bearer", enabled: true, rateLimit: { maxRequests: 60, windowMs: 60000, bufferCapacity: 10 }, retry: { maxRetries: 3, baseDelayMs: 1000, maxDelayMs: 30000, retryableStatuses: [429, 500, 502, 503, 504], jitterFactor: 0.2, maxStreamRetries: 3, maxResponseBufferSize: 10485760, enabled: true }, customHeaders: {}, allowBaseUrlOverride: true, baseUrlOverrideHeader: "x-chatgpt-baseurl" },
      gemini: { id: "gemini", name: "Gemini", upstreamUrl: "https://generativelanguage.googleapis.com", apiFormat: "gemini", authType: "api-key", enabled: true, rateLimit: { maxRequests: 60, windowMs: 60000, bufferCapacity: 10 }, retry: { maxRetries: 3, baseDelayMs: 1000, maxDelayMs: 30000, retryableStatuses: [429, 500, 502, 503, 504], jitterFactor: 0.2, maxStreamRetries: 3, maxResponseBufferSize: 10485760, enabled: true }, customHeaders: {}, allowBaseUrlOverride: true, baseUrlOverrideHeader: "x-gemini-baseurl" },
      geminiCodeAssist: { id: "geminiCodeAssist", name: "Gemini Code Assist", upstreamUrl: "https://cloudcode-pa.googleapis.com", apiFormat: "gemini", authType: "api-key", enabled: true, rateLimit: { maxRequests: 60, windowMs: 60000, bufferCapacity: 10 }, retry: { maxRetries: 3, baseDelayMs: 1000, maxDelayMs: 30000, retryableStatuses: [429, 500, 502, 503, 504], jitterFactor: 0.2, maxStreamRetries: 3, maxResponseBufferSize: 10485760, enabled: true }, customHeaders: {}, allowBaseUrlOverride: true, baseUrlOverrideHeader: "x-gemini-code-assist-baseurl" },
      vertex: { id: "vertex", name: "Vertex AI", upstreamUrl: "https://us-central1-aiplatform.googleapis.com", apiFormat: "gemini", authType: "api-key", enabled: true, rateLimit: { maxRequests: 60, windowMs: 60000, bufferCapacity: 10 }, retry: { maxRetries: 3, baseDelayMs: 1000, maxDelayMs: 30000, retryableStatuses: [429, 500, 502, 503, 504], jitterFactor: 0.2, maxStreamRetries: 3, maxResponseBufferSize: 10485760, enabled: true }, customHeaders: {}, allowBaseUrlOverride: true, baseUrlOverrideHeader: "x-vertex-baseurl" },
      nvidia: { id: "nvidia", name: "NVIDIA", upstreamUrl: "https://integrate.api.nvidia.com", apiFormat: "chat-completions", authType: "bearer", enabled: true, rateLimit: { maxRequests: 20, windowMs: 60000, bufferCapacity: 5 }, retry: { maxRetries: 3, baseDelayMs: 1000, maxDelayMs: 30000, retryableStatuses: [429, 500, 502, 503, 504], jitterFactor: 0.2, maxStreamRetries: 3, maxResponseBufferSize: 10485760, enabled: true }, customHeaders: {}, allowBaseUrlOverride: true, baseUrlOverrideHeader: "x-nvidia-baseurl" },
      kilo: { id: "kilo", name: "Kilo", upstreamUrl: "https://api.kilo.ai/api/gateway", apiFormat: "chat-completions", authType: "bearer", enabled: true, rateLimit: { maxRequests: 60, windowMs: 60000, bufferCapacity: 10 }, retry: { maxRetries: 3, baseDelayMs: 1000, maxDelayMs: 30000, retryableStatuses: [429, 500, 502, 503, 504], jitterFactor: 0.2, maxStreamRetries: 3, maxResponseBufferSize: 10485760, enabled: true }, customHeaders: {}, allowBaseUrlOverride: true, baseUrlOverrideHeader: "x-kilo-baseurl" },
      openrouter: { id: "openrouter", name: "OpenRouter", upstreamUrl: "https://openrouter.ai/api", apiFormat: "chat-completions", authType: "bearer", enabled: true, rateLimit: { maxRequests: 60, windowMs: 60000, bufferCapacity: 10 }, retry: { maxRetries: 3, baseDelayMs: 1000, maxDelayMs: 30000, retryableStatuses: [429, 500, 502, 503, 504], jitterFactor: 0.2, maxStreamRetries: 3, maxResponseBufferSize: 10485760, enabled: true }, customHeaders: {}, allowBaseUrlOverride: true, baseUrlOverrideHeader: "x-openrouter-baseurl" },
      unknown: { id: "unknown", name: "Unknown", upstreamUrl: "https://unknown.provider", apiFormat: "unknown", authType: "none", enabled: true, rateLimit: { maxRequests: 60, windowMs: 60000, bufferCapacity: 10 }, retry: { maxRetries: 3, baseDelayMs: 1000, maxDelayMs: 30000, retryableStatuses: [429, 500, 502, 503, 504], jitterFactor: 0.2, maxStreamRetries: 3, maxResponseBufferSize: 10485760, enabled: true }, customHeaders: {}, allowBaseUrlOverride: false, baseUrlOverrideHeader: "x-unknown-baseurl" },
    };
    fs.writeFileSync(providersPath, JSON.stringify(defaultProviders, null, 2));

    // Set required upstream URLs for config resolution (override providers.json)
    process.env.UPSTREAM_ANTHROPIC_URL = "http://localhost:1";
    process.env.UPSTREAM_OPENAI_URL = "http://localhost:1";
    process.env.UPSTREAM_CHATGPT_URL = "http://localhost:1";
    process.env.UPSTREAM_GEMINI_URL = "http://localhost:1";
    process.env.UPSTREAM_GEMINI_CODE_ASSIST_URL = "http://localhost:1";

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
    // Clean up environment variables
    delete process.env.UPSTREAM_ANTHROPIC_URL;
    delete process.env.UPSTREAM_OPENAI_URL;
    delete process.env.UPSTREAM_CHATGPT_URL;
    delete process.env.UPSTREAM_GEMINI_URL;
    delete process.env.UPSTREAM_GEMINI_CODE_ASSIST_URL;
    delete process.env.PROVIDERS_FILE;
    delete process.env.HOME;
    delete process.env.USERPROFILE;
    if (tempDir) {
      try {
        rmSync(tempDir, { recursive: true, force: true });
      } catch {
        // best-effort cleanup
      }
    }
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
        headers: { "x-kilo-session": "overflow-test-session" },
      });
      const elapsed = Date.now() - startTime;

      // Should succeed on retry
      assert.equal(response.status, 200);
      assert.ok(response.body.includes("Success "), `Should receive "Success " in stream, got: ${response.body}`);
      assert.ok(response.body.includes("response"), `Should receive "response" in stream, got: ${response.body}`);

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
        headers: { "x-kilo-session": "test-session-2" },
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
        headers: { "x-kilo-session": "test-session-3" },
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

  describe("stream buffer overflow protection", () => {
    let upstreamServer: http.Server;
    let upstreamPort: number;
    let requestCount: number;
    let capturedData: any = null;
    let overflowRetryPlugin: ReturnType<typeof createRetryPlugin>;
    let proxyWithOverflow: any;

    beforeEach(async () => {
      requestCount = 0;
      capturedData = null;

      // Create a capture plugin to verify capture data on overflow
      const capturePlugin: any = {
        name: "test-capture",
        onCapture(capture: any) {
          capturedData = capture;
        },
      };

      // Create retry plugin for internal retry plugin overflow
      overflowRetryPlugin = createRetryPlugin({
        maxRetries: 3,
        baseDelayMs: 50,
        maxDelayMs: 500,
        jitterFactor: 0,
        retryableStatuses: [429, 500, 502, 503, 504],
        enabled: true,
      });

      proxyWithOverflow = createProxy({
        port: 0,
        upstreams: {
          anthropic: "http://127.0.0.1:1", // Will be overridden per test
          openai: "http://127.0.0.1:1",
          gemini: "http://127.0.0.1:1",
          chatgpt: "http://127.0.0.1:1",
          geminiCodeAssist: "http://127.0.0.1:1",
        },
        plugins: [overflowRetryPlugin, capturePlugin],
      });
      await proxyWithOverflow.start();

      // Set tiny buffer size on provider config (Forward.ts reads from opts.providers[provider].retry.maxResponseBufferSize
      // which comes from the proxy's resolved providers config. Mutate AFTER createProxy() since
      // createProxy() passes a shallow copy of resolved.providers to the handler, and proxyWithOverflow.providers
      // is the same object reference that Forward.ts reads as opts.providers).
      proxyWithOverflow.providers.anthropic = {
        ...proxyWithOverflow.providers.anthropic,
        retry: {
          ...proxyWithOverflow.providers.anthropic?.retry,
          maxResponseBufferSize: 100,
        },
      };

      // Store original proxy and replace
      (global as any).originalProxy = proxy;
      (global as any).originalRetryPlugin = retryPlugin;
      proxy = proxyWithOverflow;
      retryPlugin = overflowRetryPlugin;
    });

    afterEach(async () => {
      upstreamServer?.close();
      const origProxy = (global as any).originalProxy;
      const origPlugin = (global as any).originalRetryPlugin;
      if (origProxy) proxy = origProxy;
      if (origPlugin) retryPlugin = origPlugin;
      if (overflowRetryPlugin) (overflowRetryPlugin as any)._internal.shutdown();
      if (proxyWithOverflow) await proxyWithOverflow.stop();
    });

    it("does not overflow with small streaming responses (existing behavior preserved)", async () => {
      // Small response that fits in 100 bytes buffer
      upstreamServer = http.createServer((req, res) => {
        requestCount++;
        res.writeHead(200, {
          "Content-Type": "text/event-stream",
          "Cache-Control": "no-cache",
          Connection: "keep-alive",
        });
        // Small SSE response (~80 bytes total)
        res.write('data: {"type":"content_block_delta","index":0,"delta":{"type":"text_delta","text":"Hi"}}\n\n');
        res.write('data: {"type":"message_stop"}\n\n');
        setTimeout(() => res.end(), 50);
      });
      await new Promise<void>((resolve) => upstreamServer.listen(0, resolve));
      upstreamPort = getServerPort(upstreamServer);
      (proxy as any).upstreams.anthropic = `http://127.0.0.1:${upstreamPort}`;

      const response = await makeStreamingRequest(proxy.port, {
        path: "/v1/messages",
        body: JSON.stringify({ model: "claude-3", messages: [] }),
      });

      assert.equal(response.status, 200);
      assert.ok(response.body.includes("Hi"), "Should receive small stream");
      assert.equal(requestCount, 1, "Should not retry for successful small response");
      
      // Verify capture was called with streaming info
      assert.ok(capturedData, "Capture plugin should have been called");
      assert.equal(capturedData.responseIsStreaming, true, "Should be marked as streaming");
      assert.ok(capturedData.responseBytes > 0, "Should have response bytes recorded");
    });

    it("overflows buffer with large streaming responses and streams directly to client", async () => {
      // Large response that exceeds 100 bytes buffer
      upstreamServer = http.createServer((req, res) => {
        requestCount++;
        res.writeHead(200, {
          "Content-Type": "text/event-stream",
          "Cache-Control": "no-cache",
          Connection: "keep-alive",
        });
        // Send many chunks that will exceed 100 bytes
        for (let i = 0; i < 10; i++) {
          res.write(`data: {"type":"content_block_delta","index":0,"delta":{"type":"text_delta","text":"Chunk ${i} with more data to exceed buffer "}}\n\n`);
        }
        res.write('data: {"type":"message_stop"}\n\n');
        setTimeout(() => res.end(), 50);
      });
      await new Promise<void>((resolve) => upstreamServer.listen(0, resolve));
      upstreamPort = getServerPort(upstreamServer);
      (proxy as any).upstreams.anthropic = `http://127.0.0.1:${upstreamPort}`;

      const chunks: Buffer[] = [];
      const response = await new Promise<{ status: number }>((resolve, reject) => {
        const req = http.request(
          {
            hostname: "127.0.0.1",
            port: proxy.port,
            method: "POST",
            path: "/v1/messages",
            headers: {
              "Content-Type": "application/json",
              "anthropic-version": "2023-06-01",
            },
          },
          (res) => {
            res.on("data", (chunk: Buffer) => chunks.push(chunk));
            res.on("end", () => resolve({ status: res.statusCode! }));
            res.on("error", reject);
          },
        );
        req.on("error", reject);
        req.write(JSON.stringify({ model: "claude-3", messages: [] }));
        req.end();
      });

      const body = Buffer.concat(chunks).toString();
      assert.equal(response.status, 200);
      assert.ok(body.includes("Chunk 0"), "Should receive first chunk");
      assert.ok(body.includes("Chunk 9"), "Should receive all chunks despite overflow");
      assert.equal(requestCount, 1, "Should not retry for successful large response");
      
      // Verify capture was called with streaming info
      assert.ok(capturedData, "Capture plugin should have been called on overflow");
      assert.equal(capturedData.responseIsStreaming, true, "Should be marked as streaming on overflow");
      assert.ok(capturedData.responseBytes > 100, "Should have full response bytes recorded (exceeding buffer)");
    });

    it("strips content-length header on buffer overflow", async () => {
      let responseHeaders: http.IncomingHttpHeaders = {};
      
      upstreamServer = http.createServer((req, res) => {
        requestCount++;
        res.writeHead(200, {
          "Content-Type": "text/event-stream",
          "Cache-Control": "no-cache",
          Connection: "keep-alive",
          "Content-Length": "5000", // This should be stripped on overflow
        });
        // Send large response to trigger overflow
        for (let i = 0; i < 20; i++) {
          res.write(`data: {"type":"content_block_delta","index":0,"delta":{"type":"text_delta","text":"Overflow chunk ${i} "}}\n\n`);
        }
        res.write('data: {"type":"message_stop"}\n\n');
        setTimeout(() => res.end(), 50);
      });
      await new Promise<void>((resolve) => upstreamServer.listen(0, resolve));
      upstreamPort = getServerPort(upstreamServer);
      (proxy as any).upstreams.anthropic = `http://127.0.0.1:${upstreamPort}`;

      await new Promise<void>((resolve, reject) => {
        const req = http.request(
          {
            hostname: "127.0.0.1",
            port: proxy.port,
            method: "POST",
            path: "/v1/messages",
            headers: {
              "Content-Type": "application/json",
              "anthropic-version": "2023-06-01",
            },
          },
          (res) => {
            responseHeaders = res.headers;
            res.on("data", () => {});
            res.on("end", resolve);
            res.on("error", reject);
          },
        );
        req.on("error", reject);
        req.write(JSON.stringify({ model: "claude-3", messages: [] }));
        req.end();
      });

      // Content-length should be stripped when overflow occurs (since total length is unknown)
      // transfer-encoding will be "chunked" from Node.js since we're streaming
      assert.equal(responseHeaders["content-length"], undefined, "content-length should be stripped on overflow");
      assert.equal(responseHeaders["transfer-encoding"], "chunked", "transfer-encoding should be chunked for streaming response");
    });

    it("skips retry logic when buffer overflows", async () => {
      upstreamServer = http.createServer((req, res) => {
        requestCount++;
        if (requestCount === 1) {
          // First attempt: SSE stream with error event AND large enough to overflow
          res.writeHead(200, {
            "Content-Type": "text/event-stream",
            "Cache-Control": "no-cache",
            Connection: "keep-alive",
          });
          // Send enough data to overflow buffer before error
          for (let i = 0; i < 10; i++) {
            res.write(`data: {"type":"content_block_delta","index":0,"delta":{"type":"text_delta","text":"Large chunk ${i} to overflow buffer "}}\n\n`);
          }
          // Then send error event
          res.write('event: error\n');
          res.write('data: {"error":{"message":"Rate limit exceeded","type":"rate_limit_error","code":429}}\n\n');
          setTimeout(() => res.end(), 50);
        } else {
          // Should NOT reach here - retry should be skipped on overflow
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
        headers: { "x-kilo-session": "overflow-test-session" },
      });

      // Should return the error response (not retry) because overflow disables retry
      assert.equal(response.status, 200); // SSE streams return 200 even with error events
      assert.ok(response.body.includes("Rate limit exceeded"), "Should receive error event from first attempt");
      assert.equal(requestCount, 1, "Should NOT retry when buffer overflows");
    });

    it("clears streamBufferChunks after flushBufferAndStream", async () => {
      let capturedOnOverflow: any = null;
      const capturePlugin: any = {
        name: "overflow-capture",
        onCapture(capture: any) {
          capturedOnOverflow = capture;
        },
      };

      // Create a fresh proxy with capture plugin for this test
      const testRetryPlugin = createRetryPlugin({
        maxRetries: 3,
        baseDelayMs: 50,
        maxDelayMs: 500,
        jitterFactor: 0,
        retryableStatuses: [429, 500, 502, 503, 504],
        enabled: true,
      });

      const testProxy = createProxy({
        port: 0,
        upstreams: {
          anthropic: "http://127.0.0.1:1",
          openai: "http://127.0.0.1:1",
          gemini: "http://127.0.0.1:1",
          chatgpt: "http://127.0.0.1:1",
          geminiCodeAssist: "http://127.0.0.1:1",
        },
        plugins: [testRetryPlugin, capturePlugin],
      });
      await testProxy.start();

      // Set tiny buffer size on provider config (Forward.ts reads from opts.providers[provider].retry.maxResponseBufferSize
      // which comes from the proxy's resolved providers config. Mutate AFTER createProxy() since
      // createProxy() passes a shallow copy of resolved.providers to the handler, and testProxy.providers
      // is the same object reference that Forward.ts reads as opts.providers).
      testProxy.providers.anthropic = {
        ...testProxy.providers.anthropic,
        retry: {
          ...testProxy.providers.anthropic?.retry,
          maxResponseBufferSize: 100,
        },
      };

      upstreamServer = http.createServer((req, res) => {
        requestCount++;
        res.writeHead(200, {
          "Content-Type": "text/event-stream",
          "Cache-Control": "no-cache",
          Connection: "keep-alive",
        });
        // Large response to trigger overflow
        for (let i = 0; i < 20; i++) {
          res.write(`data: {"type":"content_block_delta","index":0,"delta":{"type":"text_delta","text":"Chunk ${i} "}}\n\n`);
        }
        res.write('data: {"type":"message_stop"}\n\n');
        setTimeout(() => res.end(), 50);
      });
      await new Promise<void>((resolve) => upstreamServer.listen(0, resolve));
      upstreamPort = getServerPort(upstreamServer);
      (testProxy as any).upstreams.anthropic = `http://127.0.0.1:${upstreamPort}`;

      const chunks: Buffer[] = [];
      await new Promise<void>((resolve, reject) => {
        const req = http.request(
          {
            hostname: "127.0.0.1",
            port: testProxy.port,
            method: "POST",
            path: "/v1/messages",
            headers: {
              "Content-Type": "application/json",
              "anthropic-version": "2023-06-01",
            },
          },
          (res) => {
            res.on("data", (chunk: Buffer) => chunks.push(chunk));
            res.on("end", resolve);
            res.on("error", reject);
          },
        );
        req.on("error", reject);
        req.write(JSON.stringify({ model: "claude-3", messages: [] }));
        req.end();
      });

      const body = Buffer.concat(chunks).toString();
      assert.ok(body.includes("Chunk 0"), "Should receive all chunks");
      assert.ok(body.includes("Chunk 19"), "Should receive all chunks");

      // Give capture plugin time to fire
      await new Promise((r) => setTimeout(r, 100));

      // Verify capture was called - the buffer should have been cleared after flush
      assert.ok(capturedOnOverflow, "Capture should have been called");
      assert.equal(capturedOnOverflow.responseIsStreaming, true);
      // The response bytes should reflect the full response, not just buffered portion
      assert.ok(capturedOnOverflow.responseBytes > 100);

      await testProxy.stop();
      (testRetryPlugin as any)._internal.shutdown();
    });

    it("handles client disconnect during overflow gracefully", async () => {
      // Test that proxy handles client disconnect during overflow without crashing
      upstreamServer = http.createServer((req, res) => {
        requestCount++;
        res.writeHead(200, {
          "Content-Type": "text/event-stream",
          "Cache-Control": "no-cache",
          Connection: "keep-alive",
        });
        // Send large response slowly to allow client disconnect during overflow
        const chunks = [
          `data: {"type":"content_block_delta","index":0,"delta":{"type":"text_delta","text":"Chunk 0 "}}\n\n`,
          `data: {"type":"content_block_delta","index":0,"delta":{"type":"text_delta","text":"Chunk 1 "}}\n\n`,
          `data: {"type":"content_block_delta","index":0,"delta":{"type":"text_delta","text":"Chunk 2 "}}\n\n`,
        ];
        let idx = 0;
        const interval = setInterval(() => {
          if (idx < chunks.length) {
            res.write(chunks[idx++]);
          } else {
            res.write('data: {"type":"message_stop"}\n\n');
            res.end();
            clearInterval(interval);
          }
        }, 10);
      });
      await new Promise<void>((resolve) => upstreamServer.listen(0, resolve));
      upstreamPort = getServerPort(upstreamServer);
      (proxy as any).upstreams.anthropic = `http://127.0.0.1:${upstreamPort}`;

      // Make request but close client early during streaming
      await new Promise<void>((resolve, reject) => {
        const req = http.request(
          {
            hostname: "127.0.0.1",
            port: proxy.port,
            method: "POST",
            path: "/v1/messages",
            headers: {
              "Content-Type": "application/json",
              "anthropic-version": "2023-06-01",
            },
          },
          (res) => {
            let chunkCount = 0;
            res.on("data", (chunk: Buffer) => {
              chunkCount++;
              // Close connection after receiving first chunk (during overflow)
              if (chunkCount === 1) {
                req.destroy();
              }
            });
            res.on("close", resolve);
            // ECONNRESET is expected when client destroys connection
            res.on("error", (err) => {
              if ((err as any).code === "ECONNRESET") resolve();
              else reject(err);
            });
          },
        );
        // Ignore ECONNRESET on request socket
        req.on("error", (err) => {
          if ((err as any).code !== "ECONNRESET") reject(err);
        });
        req.write(JSON.stringify({ model: "claude-3", messages: [] }));
        req.end();
      });

      // Test passes if we reach here without unhandled errors
      // (Proxy handled client disconnect gracefully)
    });
  });
});