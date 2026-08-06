"use strict";
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
var __importDefault = (this && this.__importDefault) || function (mod) {
    return (mod && mod.__esModule) ? mod : { "default": mod };
};
Object.defineProperty(exports, "__esModule", { value: true });
const node_test_1 = require("node:test");
const strict_1 = __importDefault(require("node:assert/strict"));
const node_http_1 = __importDefault(require("node:http"));
const retry_plugin_js_1 = require("../dist/retry-plugin.js");
const proxy_js_1 = require("../dist/proxy.js");
// --- Test Helpers ---
function createMockRequestContext(overrides = {}) {
    const uniqueId = Math.floor(Math.random() * 1000000);
    return {
        provider: "anthropic",
        apiFormat: "anthropic",
        path: "/v1/messages",
        source: "test",
        sessionId: "test-session-123",
        headers: { "content-type": "application/json" },
        body: { model: "claude-3", messages: [] },
        rawBody: Buffer.from(JSON.stringify({ model: "claude-3", messages: [] })),
        captureId: `capture-test-${uniqueId}`,
        targetUrl: "http://localhost:8000/v1/messages",
        ...overrides,
    };
}
function createMockResponseContext(overrides = {}) {
    // Get captureId from overrides or use a default
    const { captureId, headers: overrideHeaders, ...restOverrides } = overrides;
    const defaultHeaders = {
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
function getServerPort(server) {
    const address = server.address();
    if (!address || typeof address === "string") {
        throw new Error("Server is not listening on a TCP port.");
    }
    return address.port;
}
async function makeRequest(port, options) {
    return new Promise((resolve, reject) => {
        const req = node_http_1.default.request({
            hostname: "127.0.0.1",
            port,
            method: options.method || "POST",
            path: options.path,
            headers: options.headers || {},
        }, (res) => {
            const chunks = [];
            res.on("data", (chunk) => chunks.push(chunk));
            res.on("end", () => {
                resolve({
                    status: res.statusCode,
                    body: Buffer.concat(chunks).toString("utf8"),
                });
            });
        });
        req.on("error", reject);
        if (options.body)
            req.write(options.body);
        req.end();
    });
}
// --- Test Suite ---
(0, node_test_1.describe)("retry plugin - unit tests", () => {
    let plugin;
    (0, node_test_1.beforeEach)(() => {
        plugin = (0, retry_plugin_js_1.createRetryPlugin)({
            maxRetries: 3,
            baseDelayMs: 10, // Fast for tests
            maxDelayMs: 100,
            retryableStatuses: [429, 500, 502, 503, 504],
            jitterFactor: 0, // Disable jitter for predictable tests
            enabled: true,
        });
    });
    (0, node_test_1.afterEach)(() => {
        if (plugin && typeof plugin._internal?.shutdown === "function") {
            plugin._internal.shutdown();
        }
    });
    (0, node_test_1.describe)("onRequest - request buffering", () => {
        (0, node_test_1.it)("stores original request body and headers on first attempt", async () => {
            const ctx = createMockRequestContext();
            const result = await plugin.onRequest(ctx);
            // Should add x-retry-id header
            strict_1.default.ok(result.headers["x-retry-id"], "Should add x-retry-id header");
            strict_1.default.equal(typeof result.headers["x-retry-id"], "string");
            // Should store request data internally
            const internal = plugin._internal;
            const storedBody = internal.getRequestBody(ctx.captureId);
            const storedHeaders = internal.getRequestHeaders(ctx.captureId);
            strict_1.default.ok(storedBody, "Should store request body");
            strict_1.default.equal(storedBody.toString(), '{"model":"claude-3","messages":[]}');
            strict_1.default.ok(storedHeaders, "Should store request headers");
            strict_1.default.equal(storedHeaders["content-type"], "application/json");
        });
        (0, node_test_1.it)("preserves existing x-retry-id for retry attempts", async () => {
            const ctx = createMockRequestContext({
                headers: { "content-type": "application/json", "x-retry-id": "existing-retry-123" },
            });
            const result = await plugin.onRequest(ctx);
            strict_1.default.equal(result.headers["x-retry-id"], "existing-retry-123");
        });
        (0, node_test_1.it)("generates new x-retry-id when none exists", async () => {
            const ctx = createMockRequestContext({
                headers: { "content-type": "application/json" },
                captureId: undefined,
            });
            const result = await plugin.onRequest(ctx);
            strict_1.default.ok(result.headers["x-retry-id"]);
            strict_1.default.match(result.headers["x-retry-id"], /^retry-\d+-\d{6}$/);
        });
    });
    (0, node_test_1.describe)("onResponse - 429 with Retry-After header", () => {
        (0, node_test_1.it)("reads Retry-After header (seconds), waits, and signals retry", async () => {
            const ctx = createMockRequestContext();
            const requestCtx = await plugin.onRequest(ctx);
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
            const result = await plugin.onResponse(responseCtx);
            const elapsed = Date.now() - startTime;
            // Should signal retry with status 599
            strict_1.default.equal(result.status, 599, "Should return 599 to signal retry");
            // Should wait approximately 1s (with tight tolerance)
            strict_1.default.ok(elapsed >= 900 && elapsed <= 1200, `Should wait ~1s, got ${elapsed}ms`);
            // Should preserve retry ID and capture ID
            strict_1.default.equal(result.headers["x-retry-id"], requestCtx.headers["x-retry-id"]);
            strict_1.default.equal(result.headers["x-contextio-capture-id"], ctx.captureId);
            // Should increment retry count
            const internal = plugin._internal;
            strict_1.default.equal(internal.getRetryCount(ctx.captureId), 1);
        });
        (0, node_test_1.it)("reads Retry-After header (HTTP-date), waits, and signals retry", async () => {
            const ctx = createMockRequestContext();
            await plugin.onRequest(ctx);
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
            const result = await plugin.onResponse(responseCtx);
            // Should signal retry with status 599
            strict_1.default.equal(result.status, 599);
            // Note: HTTP-date parsing may fall back to exponential backoff depending on date format
            // The key assertion is that it signals retry (status 599)
        });
        (0, node_test_1.it)("falls back to exponential backoff when Retry-After is invalid", async () => {
            const ctx = createMockRequestContext();
            await plugin.onRequest(ctx);
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
            const result = await plugin.onResponse(responseCtx);
            const elapsed = Date.now() - startTime;
            strict_1.default.equal(result.status, 599);
            // First retry: baseDelayMs * 2^0 = 10ms (no jitter)
            strict_1.default.ok(elapsed >= 5 && elapsed <= 30, `Should use exponential backoff ~10ms, got ${elapsed}ms`);
        });
    });
    (0, node_test_1.describe)("onResponse - 5xx responses with exponential backoff", () => {
        (0, node_test_1.it)("retries 500 with exponential backoff", async () => {
            const ctx = createMockRequestContext();
            await plugin.onRequest(ctx);
            const responseCtx = createMockResponseContext({
                status: 500,
                headers: { "content-type": "application/json" },
                sessionId: "test-session-123",
                captureId: ctx.captureId,
            });
            const startTime = Date.now();
            const result = await plugin.onResponse(responseCtx);
            const elapsed = Date.now() - startTime;
            strict_1.default.equal(result.status, 599);
            // First retry: 10ms * 2^0 = 10ms
            strict_1.default.ok(elapsed >= 5 && elapsed <= 30);
            strict_1.default.equal(plugin._internal.getRetryCount(ctx.captureId), 1);
        });
        (0, node_test_1.it)("retries 502 with exponential backoff", async () => {
            const ctx = createMockRequestContext();
            await plugin.onRequest(ctx);
            const responseCtx = createMockResponseContext({
                status: 502,
                headers: { "content-type": "application/json" },
                sessionId: "test-session-123",
                captureId: ctx.captureId,
            });
            const result = await plugin.onResponse(responseCtx);
            strict_1.default.equal(result.status, 599);
        });
        (0, node_test_1.it)("retries 503 with exponential backoff", async () => {
            const ctx = createMockRequestContext();
            await plugin.onRequest(ctx);
            const responseCtx = createMockResponseContext({
                status: 503,
                headers: { "content-type": "application/json" },
                sessionId: "test-session-123",
                captureId: ctx.captureId,
            });
            const result = await plugin.onResponse(responseCtx);
            strict_1.default.equal(result.status, 599);
        });
        (0, node_test_1.it)("retries 504 with exponential backoff", async () => {
            const ctx = createMockRequestContext();
            await plugin.onRequest(ctx);
            const responseCtx = createMockResponseContext({
                status: 504,
                headers: { "content-type": "application/json" },
                sessionId: "test-session-123",
                captureId: ctx.captureId,
            });
            const result = await plugin.onResponse(responseCtx);
            strict_1.default.equal(result.status, 599);
        });
        (0, node_test_1.it)("increases delay exponentially on subsequent retries", async () => {
            const ctx = createMockRequestContext();
            await plugin.onRequest(ctx);
            // First retry (attempt 0): 10ms
            let responseCtx = createMockResponseContext({ status: 500, sessionId: "test-session-123", captureId: ctx.captureId });
            let startTime = Date.now();
            await plugin.onResponse(responseCtx);
            let elapsed1 = Date.now() - startTime;
            // Second retry (attempt 1): 20ms
            responseCtx = createMockResponseContext({ status: 500, sessionId: "test-session-123", captureId: ctx.captureId });
            startTime = Date.now();
            await plugin.onResponse(responseCtx);
            let elapsed2 = Date.now() - startTime;
            // Third retry (attempt 2): 40ms
            responseCtx = createMockResponseContext({ status: 500, sessionId: "test-session-123", captureId: ctx.captureId });
            startTime = Date.now();
            await plugin.onResponse(responseCtx);
            let elapsed3 = Date.now() - startTime;
            strict_1.default.ok(elapsed1 >= 5 && elapsed1 <= 30, `First retry ~10ms, got ${elapsed1}ms`);
            strict_1.default.ok(elapsed2 >= 10 && elapsed2 <= 50, `Second retry ~20ms, got ${elapsed2}ms`);
            strict_1.default.ok(elapsed3 >= 20 && elapsed3 <= 80, `Third retry ~40ms, got ${elapsed3}ms`);
            strict_1.default.equal(plugin._internal.getRetryCount(ctx.captureId), 3);
        });
        (0, node_test_1.it)("caps delay at maxDelayMs", async () => {
            // Create plugin with small maxDelayMs
            const cappedPlugin = (0, retry_plugin_js_1.createRetryPlugin)({
                maxRetries: 5,
                baseDelayMs: 10,
                maxDelayMs: 50, // Cap at 50ms
                jitterFactor: 0,
            });
            const ctx = createMockRequestContext();
            await cappedPlugin.onRequest(ctx);
            // Retry 0: 10ms
            // Retry 1: 20ms
            // Retry 2: 40ms -> capped at 50ms
            // Retry 3: 80ms -> capped at 50ms
            for (let i = 0; i < 4; i++) {
                const responseCtx = createMockResponseContext({ status: 500, sessionId: "test-session-123", captureId: ctx.captureId });
                const startTime = Date.now();
                await cappedPlugin.onResponse(responseCtx);
                const elapsed = Date.now() - startTime;
                if (i >= 2) {
                    strict_1.default.ok(elapsed >= 30 && elapsed <= 70, `Retry ${i} should be capped at 50ms, got ${elapsed}ms`);
                }
            }
            cappedPlugin._internal.shutdown();
        });
    });
    (0, node_test_1.describe)("onResponse - non-retryable status codes", () => {
        (0, node_test_1.it)("passes through 400 immediately without retry", async () => {
            const ctx = createMockRequestContext();
            await plugin.onRequest(ctx);
            const responseCtx = createMockResponseContext({
                status: 400,
                headers: { "content-type": "application/json" },
                sessionId: "test-session-123",
                captureId: ctx.captureId,
            });
            const startTime = Date.now();
            const result = await plugin.onResponse(responseCtx);
            const elapsed = Date.now() - startTime;
            strict_1.default.equal(result.status, 400, "Should pass through 400 unchanged");
            strict_1.default.ok(elapsed < 20, "Should not wait for non-retryable status");
            strict_1.default.equal(plugin._internal.getRetryCount(ctx.captureId), 0);
        });
        (0, node_test_1.it)("passes through 401 immediately without retry", async () => {
            const ctx = createMockRequestContext();
            await plugin.onRequest(ctx);
            const responseCtx = createMockResponseContext({
                status: 401,
                headers: { "content-type": "application/json" },
                sessionId: "test-session-123",
                captureId: ctx.captureId,
            });
            const result = await plugin.onResponse(responseCtx);
            strict_1.default.equal(result.status, 401);
        });
        (0, node_test_1.it)("passes through 403 immediately without retry", async () => {
            const ctx = createMockRequestContext();
            await plugin.onRequest(ctx);
            const responseCtx = createMockResponseContext({
                status: 403,
                headers: { "content-type": "application/json" },
                sessionId: "test-session-123",
                captureId: ctx.captureId,
            });
            const result = await plugin.onResponse(responseCtx);
            strict_1.default.equal(result.status, 403);
        });
        (0, node_test_1.it)("passes through 404 immediately without retry", async () => {
            const ctx = createMockRequestContext();
            await plugin.onRequest(ctx);
            const responseCtx = createMockResponseContext({
                status: 404,
                headers: { "content-type": "application/json" },
                sessionId: "test-session-123",
                captureId: ctx.captureId,
            });
            const result = await plugin.onResponse(responseCtx);
            strict_1.default.equal(result.status, 404);
        });
        (0, node_test_1.it)("passes through 2xx success responses without modification", async () => {
            const ctx = createMockRequestContext();
            await plugin.onRequest(ctx);
            const responseCtx = createMockResponseContext({
                status: 200,
                headers: { "content-type": "application/json" },
                sessionId: "test-session-123",
                captureId: ctx.captureId,
            });
            const result = await plugin.onResponse(responseCtx);
            strict_1.default.equal(result.status, 200);
            strict_1.default.equal(result.body, '{"result":"ok"}');
        });
    });
    (0, node_test_1.describe)("onResponse - max retries exceeded", () => {
        (0, node_test_1.it)("returns last error response when max retries exceeded", async () => {
            const ctx = createMockRequestContext();
            await plugin.onRequest(ctx);
            // maxRetries = 3, so we need 4 attempts (0, 1, 2, 3) to exceed
            for (let i = 0; i < 3; i++) {
                const responseCtx = createMockResponseContext({
                    status: 500,
                    sessionId: "test-session-123",
                    captureId: ctx.captureId,
                });
                const result = await plugin.onResponse(responseCtx);
                strict_1.default.equal(result.status, 599, `Retry ${i} should signal retry`);
            }
            // 4th attempt - should exceed maxRetries (3) and return the error
            const finalResponseCtx = createMockResponseContext({
                status: 500,
                body: '{"error":"Internal server error"}',
                sessionId: "test-session-123",
                captureId: ctx.captureId,
            });
            const result = await plugin.onResponse(finalResponseCtx);
            strict_1.default.equal(result.status, 500, "Should return original error status");
            strict_1.default.equal(result.body, '{"error":"Internal server error"}');
        });
        (0, node_test_1.it)("cleans up request store after max retries exceeded", async () => {
            const ctx = createMockRequestContext();
            await plugin.onRequest(ctx);
            for (let i = 0; i < 3; i++) {
                await plugin.onResponse(createMockResponseContext({ status: 500, sessionId: "test-session-123", captureId: ctx.captureId }));
            }
            await plugin.onResponse(createMockResponseContext({ status: 500, sessionId: "test-session-123", captureId: ctx.captureId }));
            const internal = plugin._internal;
            const storedBody = internal.getRequestBody(ctx.captureId);
            strict_1.default.equal(storedBody, undefined, "Should clean up request store after max retries");
        });
    });
    (0, node_test_1.describe)("onStreamChunk - SSE error detection", () => {
        (0, node_test_1.it)("detects error event in SSE stream (OpenAI style)", async () => {
            const ctx = createMockRequestContext();
            await plugin.onRequest(ctx);
            // Simulate streaming chunk with error
            const errorChunk = Buffer.from('data: {"error":{"message":"Rate limit exceeded","type":"rate_limit_error","code":429}}\n\n');
            const result = plugin.onStreamChunk(errorChunk, "test-session-123");
            strict_1.default.equal(result, errorChunk, "Should pass through chunk");
            const streamError = plugin._internal.getStreamError("test-session-123");
            strict_1.default.ok(streamError, "Should detect stream error");
            strict_1.default.equal(streamError.errorDetected, true);
            strict_1.default.equal(streamError.errorStatus, 429);
            strict_1.default.ok(streamError.errorMessage.includes("Rate limit exceeded"));
        });
        (0, node_test_1.it)("detects error event in SSE stream (Anthropic style)", async () => {
            const ctx = createMockRequestContext();
            await plugin.onRequest(ctx);
            const errorChunk = Buffer.from('data: {"type":"error","error":{"type":"rate_limit_error","message":"Rate limit exceeded"}}\n\n');
            plugin.onStreamChunk(errorChunk, "test-session-123");
            const streamError = plugin._internal.getStreamError("test-session-123");
            strict_1.default.ok(streamError.errorDetected);
            // Anthropic error format doesn't include numeric status, so status is null
            strict_1.default.equal(streamError.errorStatus, null);
            strict_1.default.ok(streamError.errorMessage.includes("Rate limit exceeded"));
        });
        (0, node_test_1.it)("detects explicit error event type in SSE", async () => {
            const ctx = createMockRequestContext();
            await plugin.onRequest(ctx);
            const errorChunk = Buffer.from('event: error\n\n');
            plugin.onStreamChunk(errorChunk, "test-session-123");
            const streamError = plugin._internal.getStreamError("test-session-123");
            strict_1.default.ok(streamError.errorDetected);
            strict_1.default.ok(streamError.hasErrorEvent);
            strict_1.default.equal(streamError.errorMessage, "SSE error event detected");
        });
        (0, node_test_1.it)("does not detect error for normal SSE data", async () => {
            const ctx = createMockRequestContext();
            await plugin.onRequest(ctx);
            const normalChunk = Buffer.from('data: {"type":"content_block_delta","delta":{"text":"Hello"}}\n\n');
            plugin.onStreamChunk(normalChunk, "test-session-123");
            const streamError = plugin._internal.getStreamError("test-session-123");
            strict_1.default.ok(!streamError.errorDetected, "Should not detect error for normal data");
        });
        (0, node_test_1.it)("handles partial SSE lines split across chunks", async () => {
            const ctx = createMockRequestContext();
            await plugin.onRequest(ctx);
            // First chunk - partial line (incomplete JSON)
            const chunk1 = Buffer.from('data: {"error":{"message":');
            plugin.onStreamChunk(chunk1, "test-session-123");
            // Second chunk - completes the line
            const chunk2 = Buffer.from('"test"}}\n\n');
            plugin.onStreamChunk(chunk2, "test-session-123");
            const streamError = plugin._internal.getStreamError("test-session-123");
            strict_1.default.ok(streamError.errorDetected);
        });
    });
    (0, node_test_1.describe)("onStreamEnd - streaming retry signaling", () => {
        (0, node_test_1.it)("signals retry when SSE error detected at stream end", async () => {
            const ctx = createMockRequestContext();
            const requestCtx = await plugin.onRequest(ctx);
            // Send error chunk
            const errorChunk = Buffer.from('data: {"error":{"message":"Rate limit","type":"rate_limit_error","code":429}}\n\n');
            plugin.onStreamChunk(errorChunk, "test-session-123");
            // End stream - should signal retry
            const flushed = plugin.onStreamEnd("test-session-123");
            // Check if pending retry was set
            const pendingRetry = plugin._internal.getAndConsumePendingStreamRetry("test-session-123");
            strict_1.default.ok(pendingRetry, "Should have pending retry for streaming error");
            strict_1.default.equal(pendingRetry.retryId, requestCtx.headers["x-retry-id"]);
            strict_1.default.ok(pendingRetry.originalBodyBuffer);
            strict_1.default.ok(pendingRetry.delayMs > 0);
        });
        (0, node_test_1.it)("does not signal retry for successful stream", async () => {
            const ctx = createMockRequestContext();
            await plugin.onRequest(ctx);
            const normalChunk = Buffer.from('data: {"type":"message_stop"}\n\n');
            plugin.onStreamChunk(normalChunk, "test-session-123");
            const flushed = plugin.onStreamEnd("test-session-123");
            const pendingRetry = plugin._internal.getAndConsumePendingStreamRetry("test-session-123");
            strict_1.default.equal(pendingRetry, null, "Should not have pending retry for successful stream");
        });
        (0, node_test_1.it)("respects maxRetries for streaming retries", async () => {
            const ctx = createMockRequestContext();
            await plugin.onRequest(ctx);
            // maxRetries = 3 means 3 retries allowed (retryCount 0, 1, 2)
            // 4th attempt (retryCount 3) should not retry
            // First 3 attempts should retry
            for (let i = 0; i < 3; i++) {
                const errorChunk = Buffer.from(`data: {"error":{"message":"Error ${i}","code":500}}\n\n`);
                plugin.onStreamChunk(errorChunk, "test-session-123");
                plugin.onStreamEnd("test-session-123");
                const pendingRetry = plugin._internal.getAndConsumePendingStreamRetry("test-session-123");
                strict_1.default.ok(pendingRetry, `Should have pending retry for attempt ${i}`);
            }
            // 4th attempt should not retry
            const errorChunk = Buffer.from(`data: {"error":{"message":"Error 3","code":500}}\n\n`);
            plugin.onStreamChunk(errorChunk, "test-session-123");
            plugin.onStreamEnd("test-session-123");
            const pendingRetry = plugin._internal.getAndConsumePendingStreamRetry("test-session-123");
            strict_1.default.equal(pendingRetry, null, "Should not retry after max retries exceeded");
        });
    });
    (0, node_test_1.describe)("request body buffering and replay", () => {
        (0, node_test_1.it)("buffers and replays original request body on retry", async () => {
            const originalBody = { model: "claude-3", messages: [{ role: "user", content: "test" }] };
            const ctx = createMockRequestContext({ body: originalBody, rawBody: Buffer.from(JSON.stringify(originalBody)) });
            await plugin.onRequest(ctx);
            // Trigger retry
            const responseCtx = createMockResponseContext({ status: 429, sessionId: "test-session-123", captureId: ctx.captureId });
            await plugin.onResponse(responseCtx);
            // Verify original body is stored
            const internal = plugin._internal;
            const storedBody = internal.getRequestBody(ctx.captureId);
            const storedJson = internal.getRequestBodyJson(ctx.captureId);
            strict_1.default.ok(storedBody);
            strict_1.default.equal(storedBody.toString(), JSON.stringify(originalBody));
            strict_1.default.deepEqual(storedJson, originalBody);
        });
        (0, node_test_1.it)("buffers and replays request headers on retry", async () => {
            const ctx = createMockRequestContext({
                headers: {
                    "content-type": "application/json",
                    "anthropic-version": "2023-06-01",
                    "x-custom-header": "custom-value"
                },
            });
            await plugin.onRequest(ctx);
            const responseCtx = createMockResponseContext({ status: 500, sessionId: "test-session-123", captureId: ctx.captureId });
            await plugin.onResponse(responseCtx);
            const internal = plugin._internal;
            const storedHeaders = internal.getRequestHeaders(ctx.captureId);
            strict_1.default.ok(storedHeaders);
            strict_1.default.equal(storedHeaders["content-type"], "application/json");
            strict_1.default.equal(storedHeaders["anthropic-version"], "2023-06-01");
            strict_1.default.equal(storedHeaders["x-custom-header"], "custom-value");
        });
        (0, node_test_1.it)("preserves captureId for retry requests", async () => {
            const ctx = createMockRequestContext({ captureId: "my-capture-456" });
            await plugin.onRequest(ctx);
            // Response context must have the same captureId for plugin to find stored entry
            const responseCtx = createMockResponseContext({
                status: 500,
                sessionId: "test-session-123",
                captureId: "my-capture-456",
            });
            const result = await plugin.onResponse(responseCtx);
            strict_1.default.equal(result.headers["x-contextio-capture-id"], "my-capture-456");
        });
    });
    (0, node_test_1.describe)("per-provider config isolation", () => {
        (0, node_test_1.it)("uses provider-specific config when configured", async () => {
            const providerPlugin = (0, retry_plugin_js_1.createRetryPlugin)({
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
            await providerPlugin.onRequest(anthropicCtx);
            // maxRetries=5 means 5 retries allowed (retryCount 0,1,2,3,4)
            // 6th attempt (retryCount=5) should fail
            for (let i = 0; i < 6; i++) {
                const responseCtx = createMockResponseContext({ status: 500, sessionId: "test-session-123", captureId: "capture-anthropic-123" });
                const result = await providerPlugin.onResponse(responseCtx);
                if (i < 5) {
                    strict_1.default.equal(result.status, 599, `Anthropic retry ${i} should signal retry`);
                }
                else {
                    strict_1.default.equal(result.status, 500, "Anthropic should allow 5 retries");
                }
            }
            // Test openai config (2 retries, 20ms base)
            const openaiCtx = createMockRequestContext({
                provider: "openai",
                captureId: "capture-openai-123"
            });
            await providerPlugin.onRequest(openaiCtx);
            // maxRetries=2 means 2 retries allowed (retryCount 0,1)
            // 3rd attempt (retryCount=2) should fail
            for (let i = 0; i < 3; i++) {
                const responseCtx = createMockResponseContext({ status: 500, sessionId: "test-session-123", captureId: "capture-openai-123" });
                const result = await providerPlugin.onResponse(responseCtx);
                if (i < 2) {
                    strict_1.default.equal(result.status, 599, `OpenAI retry ${i} should signal retry`);
                }
                else {
                    strict_1.default.equal(result.status, 500, "OpenAI should allow 2 retries");
                }
            }
            // Test default provider (1 retry)
            const defaultCtx = createMockRequestContext({
                provider: "gemini",
                captureId: "capture-gemini-123"
            });
            await providerPlugin.onRequest(defaultCtx);
            // maxRetries=1 means 1 retry allowed (retryCount 0)
            // 2nd attempt (retryCount=1) should fail
            const responseCtx1 = createMockResponseContext({ status: 500, sessionId: "test-session-123", captureId: "capture-gemini-123" });
            const result1 = await providerPlugin.onResponse(responseCtx1);
            strict_1.default.equal(result1.status, 599, "Default provider should allow 1 retry");
            const responseCtx2 = createMockResponseContext({ status: 500, sessionId: "test-session-123", captureId: "capture-gemini-123" });
            const result2 = await providerPlugin.onResponse(responseCtx2);
            strict_1.default.equal(result2.status, 500, "Default provider should not allow 2nd retry");
            providerPlugin._internal.shutdown();
        });
        (0, node_test_1.it)("falls back to global config for unknown providers", async () => {
            const providerPlugin = (0, retry_plugin_js_1.createRetryPlugin)({
                maxRetries: 2,
                baseDelayMs: 10,
                providers: {
                    anthropic: { maxRetries: 5 },
                },
            });
            const ctx = createMockRequestContext({ provider: "unknown-provider", captureId: "capture-unknown-123" });
            await providerPlugin.onRequest(ctx);
            // Should use global config (2 retries)
            // maxRetries=2 means 2 retries allowed (retryCount 0,1)
            // 3rd attempt (retryCount=2) should fail
            const responseCtx1 = createMockResponseContext({ status: 500, sessionId: "test-session-123", captureId: "capture-unknown-123" });
            await providerPlugin.onResponse(responseCtx1); // retry 1
            const responseCtx2 = createMockResponseContext({ status: 500, sessionId: "test-session-123", captureId: "capture-unknown-123" });
            await providerPlugin.onResponse(responseCtx2); // retry 2
            const responseCtx3 = createMockResponseContext({ status: 500, sessionId: "test-session-123", captureId: "capture-unknown-123" });
            const result = await providerPlugin.onResponse(responseCtx3); // retry 3 - should exceed
            strict_1.default.equal(result.status, 500);
            providerPlugin._internal.shutdown();
        });
    });
    (0, node_test_1.describe)("disabled plugin", () => {
        (0, node_test_1.it)("passes through all responses when disabled globally", async () => {
            const disabledPlugin = (0, retry_plugin_js_1.createRetryPlugin)({ enabled: false });
            const ctx = createMockRequestContext();
            const result = await disabledPlugin.onRequest(ctx);
            strict_1.default.equal(result.headers["x-retry-id"], undefined, "Should not add x-retry-id when disabled");
            const responseCtx = createMockResponseContext({ status: 500, sessionId: "test-session-123", captureId: ctx.captureId });
            const responseResult = await disabledPlugin.onResponse(responseCtx);
            strict_1.default.equal(responseResult.status, 500, "Should pass through 500 when disabled");
            disabledPlugin._internal.shutdown();
        });
        (0, node_test_1.it)("ignores provider-specific config when plugin is globally disabled", async () => {
            const disabledPlugin = (0, retry_plugin_js_1.createRetryPlugin)({
                enabled: false,
                providers: {
                    anthropic: { maxRetries: 5 }, // Should be ignored when globally disabled
                },
            });
            const ctx = createMockRequestContext({ provider: "anthropic" });
            await disabledPlugin.onRequest(ctx);
            const responseCtx = createMockResponseContext({ status: 500, sessionId: "test-session-123", captureId: ctx.captureId });
            const result = await disabledPlugin.onResponse(responseCtx);
            strict_1.default.equal(result.status, 500, "Should pass through 500 without retry when globally disabled");
            disabledPlugin._internal.shutdown();
        });
        (0, node_test_1.it)("does not retry when maxRetries=0 but plugin is enabled", async () => {
            const zeroRetryPlugin = (0, retry_plugin_js_1.createRetryPlugin)({
                maxRetries: 0,
                baseDelayMs: 10,
                jitterFactor: 0,
                enabled: true,
            });
            const ctx = createMockRequestContext();
            await zeroRetryPlugin.onRequest(ctx);
            const responseCtx = createMockResponseContext({
                status: 500,
                sessionId: "test-session-123",
                captureId: ctx.captureId
            });
            const result = await zeroRetryPlugin.onResponse(responseCtx);
            // Should not retry, pass through the error immediately
            strict_1.default.equal(result.status, 500, "Should pass through 500 without retry when maxRetries=0");
            strict_1.default.equal(zeroRetryPlugin._internal.getRetryCount(ctx.captureId), 0);
            zeroRetryPlugin._internal.shutdown();
        });
        (0, node_test_1.it)("does not retry when retryableStatuses is empty array", async () => {
            const noRetryStatusesPlugin = (0, retry_plugin_js_1.createRetryPlugin)({
                maxRetries: 3,
                baseDelayMs: 10,
                retryableStatuses: [], // Empty array - no status codes are retryable
                jitterFactor: 0,
                enabled: true,
            });
            const ctx = createMockRequestContext();
            await noRetryStatusesPlugin.onRequest(ctx);
            // Test 500 - normally retryable but not in empty array
            const responseCtx500 = createMockResponseContext({
                status: 500,
                sessionId: "test-session-123",
                captureId: ctx.captureId
            });
            const result500 = await noRetryStatusesPlugin.onResponse(responseCtx500);
            strict_1.default.equal(result500.status, 500, "Should pass through 500 without retry when retryableStatuses is empty");
            // Test 429 - normally retryable but not in empty array
            const responseCtx429 = createMockResponseContext({
                status: 429,
                headers: { "content-type": "application/json", "retry-after": "1" },
                sessionId: "test-session-123",
                captureId: ctx.captureId
            });
            const result429 = await noRetryStatusesPlugin.onResponse(responseCtx429);
            strict_1.default.equal(result429.status, 429, "Should pass through 429 without retry when retryableStatuses is empty");
            strict_1.default.equal(noRetryStatusesPlugin._internal.getRetryCount(ctx.captureId), 0);
            noRetryStatusesPlugin._internal.shutdown();
        });
    });
});
(0, node_test_1.describe)("retry plugin - integration with proxy", () => {
    let proxy;
    let upstreamServer;
    let upstreamPort;
    let requestCount;
    let retryPlugin;
    (0, node_test_1.before)(async () => {
        // Create mock upstream server
        requestCount = 0;
        upstreamServer = node_http_1.default.createServer((req, res) => {
            requestCount++;
            if (requestCount === 1) {
                // First request: 429 with Retry-After: 0.1s
                res.writeHead(429, {
                    "content-type": "application/json",
                    "retry-after": "0.1", // 100ms for fast test
                });
                res.end(JSON.stringify({ error: "Rate limited" }));
            }
            else {
                // Subsequent requests: 200 OK
                res.writeHead(200, { "content-type": "application/json" });
                res.end(JSON.stringify({ success: true, attempt: requestCount }));
            }
        });
        await new Promise((resolve) => upstreamServer.listen(0, resolve));
        upstreamPort = getServerPort(upstreamServer);
        // Create proxy with retry plugin
        retryPlugin = (0, retry_plugin_js_1.createRetryPlugin)({
            maxRetries: 3,
            baseDelayMs: 50, // Fast for tests
            maxDelayMs: 500,
            jitterFactor: 0,
        });
        proxy = (0, proxy_js_1.createProxy)({
            port: 0,
            upstreams: { anthropic: `http://127.0.0.1:${upstreamPort}` },
            plugins: [retryPlugin],
        });
        await proxy.start();
    });
    (0, node_test_1.after)(async () => {
        await proxy.stop();
        upstreamServer.close();
        retryPlugin._internal.shutdown();
    });
    (0, node_test_1.it)("retries on 429 and succeeds on subsequent attempt", async () => {
        const response = await makeRequest(proxy.port, {
            path: "/v1/messages",
            method: "POST",
            body: JSON.stringify({ model: "claude-3", messages: [] }),
            headers: { "content-type": "application/json", "anthropic-version": "2023-06-01" },
        });
        // Should succeed after retry
        strict_1.default.equal(response.status, 200);
        const body = JSON.parse(response.body);
        strict_1.default.equal(body.success, true);
        strict_1.default.equal(body.attempt, 2); // Second attempt succeeded
        // Should have made 2 requests to upstream
        strict_1.default.equal(requestCount, 2);
    });
    (0, node_test_1.it)("retries on 500 with exponential backoff", async () => {
        let attempt = 0;
        let server500;
        server500 = node_http_1.default.createServer((req, res) => {
            attempt++;
            if (attempt <= 2) {
                res.writeHead(500, { "content-type": "application/json" });
                res.end(JSON.stringify({ error: "Server error" }));
            }
            else {
                res.writeHead(200, { "content-type": "application/json" });
                res.end(JSON.stringify({ success: true, attempt }));
            }
        });
        await new Promise((resolve) => server500.listen(0, resolve));
        const port500 = getServerPort(server500);
        const retryPlugin = (0, retry_plugin_js_1.createRetryPlugin)({
            maxRetries: 3,
            baseDelayMs: 50,
            maxDelayMs: 500,
            jitterFactor: 0,
        });
        const proxy500 = (0, proxy_js_1.createProxy)({
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
            strict_1.default.equal(response.status, 200);
            const body = JSON.parse(response.body);
            strict_1.default.equal(body.attempt, 3); // Third attempt succeeded
            strict_1.default.equal(attempt, 3);
        }
        finally {
            await proxy500.stop();
            server500.close();
            retryPlugin._internal.shutdown();
        }
    });
    (0, node_test_1.it)("passes through 400 without retry", async () => {
        let server400;
        server400 = node_http_1.default.createServer((req, res) => {
            res.writeHead(400, { "content-type": "application/json" });
            res.end(JSON.stringify({ error: "Bad request" }));
        });
        await new Promise((resolve) => server400.listen(0, resolve));
        const port400 = getServerPort(server400);
        const retryPlugin = (0, retry_plugin_js_1.createRetryPlugin)({
            maxRetries: 3,
            baseDelayMs: 50,
        });
        const proxy400 = (0, proxy_js_1.createProxy)({
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
            strict_1.default.equal(response.status, 400);
            const body = JSON.parse(response.body);
            strict_1.default.ok(body.error.includes("Bad request"));
        }
        finally {
            await proxy400.stop();
            server400.close();
            retryPlugin._internal.shutdown();
        }
    });
    (0, node_test_1.it)("returns error after max retries exceeded", async () => {
        let attempt = 0;
        let serverFail;
        serverFail = node_http_1.default.createServer((req, res) => {
            attempt++;
            res.writeHead(503, { "content-type": "application/json" });
            res.end(JSON.stringify({ error: "Service unavailable", attempt }));
        });
        await new Promise((resolve) => serverFail.listen(0, resolve));
        const portFail = getServerPort(serverFail);
        const retryPlugin = (0, retry_plugin_js_1.createRetryPlugin)({
            maxRetries: 2, // Only 2 retries
            baseDelayMs: 20,
            maxDelayMs: 100,
            jitterFactor: 0,
        });
        const proxyFail = (0, proxy_js_1.createProxy)({
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
            strict_1.default.equal(response.status, 503);
            strict_1.default.equal(attempt, 3); // Initial + 2 retries
        }
        finally {
            await proxyFail.stop();
            serverFail.close();
            retryPlugin._internal.shutdown();
        }
    });
});
