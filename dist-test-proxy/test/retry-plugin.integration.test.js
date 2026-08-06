"use strict";
/**
 * @contextio/proxy - Retry Plugin Integration Tests
 *
 * End-to-end integration tests for the retry plugin with a real proxy server
 * and mock upstream servers.
 */
var __importDefault = (this && this.__importDefault) || function (mod) {
    return (mod && mod.__esModule) ? mod : { "default": mod };
};
Object.defineProperty(exports, "__esModule", { value: true });
const node_test_1 = require("node:test");
const strict_1 = __importDefault(require("node:assert/strict"));
const node_http_1 = __importDefault(require("node:http"));
const proxy_js_1 = require("../dist/proxy.js");
const retry_plugin_js_1 = require("../dist/retry-plugin.js");
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
                    headers: res.headers,
                });
            });
        });
        req.on("error", reject);
        if (options.body)
            req.write(options.body);
        req.end();
    });
}
async function makeStreamingRequest(port, options) {
    return new Promise((resolve, reject) => {
        const req = node_http_1.default.request({
            hostname: "127.0.0.1",
            port,
            method: "POST",
            path: options.path,
            headers: {
                "Content-Type": "application/json",
                "anthropic-version": "2023-06-01",
                ...options.headers,
            },
        }, (res) => {
            const chunks = [];
            res.on("data", (chunk) => chunks.push(chunk));
            res.on("end", () => {
                resolve({
                    status: res.statusCode,
                    body: Buffer.concat(chunks).toString("utf8"),
                    headers: res.headers,
                });
            });
            res.on("error", reject);
        });
        req.on("error", reject);
        if (options.body)
            req.write(options.body);
        req.end();
    });
}
(0, node_test_1.describe)("retry plugin - integration tests", () => {
    let proxy;
    let retryPlugin;
    (0, node_test_1.before)(async () => {
        retryPlugin = (0, retry_plugin_js_1.createRetryPlugin)({
            maxRetries: 3,
            baseDelayMs: 50, // Fast for tests
            maxDelayMs: 500,
            jitterFactor: 0, // Disable jitter for predictable timing tests
            retryableStatuses: [429, 500, 502, 503, 504],
            enabled: true,
        });
        proxy = (0, proxy_js_1.createProxy)({
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
    (0, node_test_1.after)(async () => {
        await proxy.stop();
        retryPlugin._internal.shutdown();
    });
    (0, node_test_1.describe)("429 with Retry-After header", () => {
        let upstreamServer;
        let upstreamPort;
        let requestCount;
        (0, node_test_1.beforeEach)(async () => {
            requestCount = 0;
            upstreamServer = node_http_1.default.createServer((req, res) => {
                requestCount++;
                if (requestCount === 1) {
                    // First request: 429 with Retry-After: 1 second
                    res.writeHead(429, {
                        "content-type": "application/json",
                        "retry-after": "1", // 1 second
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
            // Update proxy upstream for anthropic
            proxy.upstreams.anthropic = `http://127.0.0.1:${upstreamPort}`;
        });
        (0, node_test_1.afterEach)(async () => {
            upstreamServer.close();
        });
        (0, node_test_1.it)("retries on 429 with Retry-After: 1 and succeeds on retry", async () => {
            const startTime = Date.now();
            const response = await makeRequest(proxy.port, {
                path: "/v1/messages",
                method: "POST",
                body: JSON.stringify({ model: "claude-3", messages: [] }),
                headers: { "content-type": "application/json", "anthropic-version": "2023-06-01" },
            });
            const elapsed = Date.now() - startTime;
            // Should succeed after retry
            strict_1.default.equal(response.status, 200);
            const body = JSON.parse(response.body);
            strict_1.default.equal(body.success, true);
            strict_1.default.equal(body.attempt, 2); // Second attempt succeeded
            // Should have made 2 requests to upstream
            strict_1.default.equal(requestCount, 2);
            // Should have waited approximately 1 second (Retry-After: 1)
            // Allow some tolerance for test execution overhead
            strict_1.default.ok(elapsed >= 900 && elapsed <= 2000, `Should wait ~1s for Retry-After, got ${elapsed}ms`);
        });
    });
    (0, node_test_1.describe)("5xx responses with exponential backoff", () => {
        let upstreamServer;
        let upstreamPort;
        let requestCount;
        let attemptTimestamps;
        (0, node_test_1.beforeEach)(async () => {
            requestCount = 0;
            attemptTimestamps = [];
            upstreamServer = node_http_1.default.createServer((req, res) => {
                requestCount++;
                attemptTimestamps.push(Date.now());
                if (requestCount <= 3) {
                    // First 3 requests: 500
                    res.writeHead(500, { "content-type": "application/json" });
                    res.end(JSON.stringify({ error: "Server error", attempt: requestCount }));
                }
                else {
                    // 4th request: 200 OK
                    res.writeHead(200, { "content-type": "application/json" });
                    res.end(JSON.stringify({ success: true, attempt: requestCount }));
                }
            });
            await new Promise((resolve) => upstreamServer.listen(0, resolve));
            upstreamPort = getServerPort(upstreamServer);
            proxy.upstreams.anthropic = `http://127.0.0.1:${upstreamPort}`;
        });
        (0, node_test_1.afterEach)(async () => {
            upstreamServer.close();
        });
        (0, node_test_1.it)("retries on 500 three times with exponential backoff, then succeeds", async () => {
            const startTime = Date.now();
            const response = await makeRequest(proxy.port, {
                path: "/v1/messages",
                method: "POST",
                body: JSON.stringify({ model: "claude-3", messages: [] }),
                headers: { "content-type": "application/json" },
            });
            const totalElapsed = Date.now() - startTime;
            // Should succeed after 3 retries (4th attempt)
            strict_1.default.equal(response.status, 200);
            const body = JSON.parse(response.body);
            strict_1.default.equal(body.success, true);
            strict_1.default.equal(body.attempt, 4);
            // Should have made 4 requests to upstream (initial + 3 retries)
            strict_1.default.equal(requestCount, 4);
            // Verify exponential backoff timing
            // Retry 0: baseDelayMs * 2^0 = 50ms
            // Retry 1: baseDelayMs * 2^1 = 100ms
            // Retry 2: baseDelayMs * 2^2 = 200ms
            // Total expected delay: ~350ms (plus small overhead)
            const expectedMinDelay = 50 + 100 + 200 - 100; // Allow some tolerance
            const expectedMaxDelay = 50 + 100 + 200 + 200; // Allow overhead
            strict_1.default.ok(totalElapsed >= expectedMinDelay && totalElapsed <= expectedMaxDelay, `Total time ${totalElapsed}ms should be approximately 350ms (50+100+200) for 3 retries`);
            // Verify individual retry delays via timestamps
            if (attemptTimestamps.length >= 4) {
                const delay1 = attemptTimestamps[1] - attemptTimestamps[0]; // Between attempt 1 and 2
                const delay2 = attemptTimestamps[2] - attemptTimestamps[1]; // Between attempt 2 and 3
                const delay3 = attemptTimestamps[3] - attemptTimestamps[2]; // Between attempt 3 and 4
                // First retry: ~50ms (baseDelay * 2^0)
                strict_1.default.ok(delay1 >= 40 && delay1 <= 120, `First retry delay ${delay1}ms should be ~50ms`);
                // Second retry: ~100ms (baseDelay * 2^1)
                strict_1.default.ok(delay2 >= 80 && delay2 <= 180, `Second retry delay ${delay2}ms should be ~100ms`);
                // Third retry: ~200ms (baseDelay * 2^2)
                strict_1.default.ok(delay3 >= 160 && delay3 <= 300, `Third retry delay ${delay3}ms should be ~200ms`);
            }
        });
    });
    (0, node_test_1.describe)("non-retryable status codes", () => {
        let upstreamServer;
        let upstreamPort;
        let requestCount;
        (0, node_test_1.beforeEach)(async () => {
            requestCount = 0;
            upstreamServer = node_http_1.default.createServer((req, res) => {
                requestCount++;
                res.writeHead(400, { "content-type": "application/json" });
                res.end(JSON.stringify({ error: "Bad request" }));
            });
            await new Promise((resolve) => upstreamServer.listen(0, resolve));
            upstreamPort = getServerPort(upstreamServer);
            proxy.upstreams.anthropic = `http://127.0.0.1:${upstreamPort}`;
        });
        (0, node_test_1.afterEach)(async () => {
            upstreamServer.close();
        });
        (0, node_test_1.it)("passes through 400 immediately without retry", async () => {
            const startTime = Date.now();
            const response = await makeRequest(proxy.port, {
                path: "/v1/messages",
                method: "POST",
                body: JSON.stringify({ model: "claude-3", messages: [] }),
                headers: { "content-type": "application/json" },
            });
            const elapsed = Date.now() - startTime;
            // Should return 400 immediately
            strict_1.default.equal(response.status, 400);
            const body = JSON.parse(response.body);
            strict_1.default.ok(body.error.includes("Bad request"));
            // Should have made exactly 1 request (no retries)
            strict_1.default.equal(requestCount, 1);
            // Should not have waited
            strict_1.default.ok(elapsed < 100, `Should not wait for non-retryable status, got ${elapsed}ms`);
        });
    });
    (0, node_test_1.describe)("streaming responses with SSE error events", () => {
        let upstreamServer;
        let upstreamPort;
        let requestCount;
        (0, node_test_1.beforeEach)(async () => {
            requestCount = 0;
            upstreamServer = node_http_1.default.createServer((req, res) => {
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
                }
                else {
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
            await new Promise((resolve) => upstreamServer.listen(0, resolve));
            upstreamPort = getServerPort(upstreamServer);
            proxy.upstreams.anthropic = `http://127.0.0.1:${upstreamPort}`;
        });
        (0, node_test_1.afterEach)(async () => {
            upstreamServer.close();
        });
        (0, node_test_1.it)("retries on SSE error event in streaming response", async () => {
            const startTime = Date.now();
            const response = await makeStreamingRequest(proxy.port, {
                path: "/v1/messages",
                body: JSON.stringify({ model: "claude-3", messages: [] }),
            });
            const elapsed = Date.now() - startTime;
            // Should succeed on retry
            strict_1.default.equal(response.status, 200);
            strict_1.default.ok(response.body.includes("Success response"), `Should receive successful stream, got: ${response.body}`);
            // Should have made 2 requests (initial + 1 retry)
            strict_1.default.equal(requestCount, 2);
            // Should have waited for backoff delay (baseDelayMs * 2^0 = 50ms)
            strict_1.default.ok(elapsed >= 40 && elapsed <= 500, `Should wait for backoff ~50ms, got ${elapsed}ms`);
        });
        (0, node_test_1.it)("retries on SSE data error object (OpenAI style)", async () => {
            requestCount = 0;
            // Override the upstream for this specific test
            upstreamServer.close();
            upstreamServer = node_http_1.default.createServer((req, res) => {
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
                }
                else {
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
            await new Promise((resolve) => upstreamServer.listen(0, resolve));
            upstreamPort = getServerPort(upstreamServer);
            proxy.upstreams.anthropic = `http://127.0.0.1:${upstreamPort}`;
            const response = await makeStreamingRequest(proxy.port, {
                path: "/v1/messages",
                body: JSON.stringify({ model: "claude-3", messages: [] }),
            });
            strict_1.default.equal(response.status, 200);
            strict_1.default.ok(response.body.includes("Retry succeeded"), `Should receive successful stream, got: ${response.body}`);
            strict_1.default.equal(requestCount, 2);
        });
        (0, node_test_1.it)("retries on SSE data error object (Anthropic style)", async () => {
            requestCount = 0;
            upstreamServer.close();
            upstreamServer = node_http_1.default.createServer((req, res) => {
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
                }
                else {
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
            await new Promise((resolve) => upstreamServer.listen(0, resolve));
            upstreamPort = getServerPort(upstreamServer);
            proxy.upstreams.anthropic = `http://127.0.0.1:${upstreamPort}`;
            const response = await makeStreamingRequest(proxy.port, {
                path: "/v1/messages",
                body: JSON.stringify({ model: "claude-3", messages: [] }),
            });
            strict_1.default.equal(response.status, 200);
            strict_1.default.ok(response.body.includes("Anthropic retry ok"), `Should receive successful stream, got: ${response.body}`);
            strict_1.default.equal(requestCount, 2);
        });
    });
    (0, node_test_1.describe)("max retries exceeded", () => {
        let upstreamServer;
        let upstreamPort;
        let requestCount;
        (0, node_test_1.beforeEach)(async () => {
            requestCount = 0;
            upstreamServer = node_http_1.default.createServer((req, res) => {
                requestCount++;
                res.writeHead(503, { "content-type": "application/json" });
                res.end(JSON.stringify({ error: "Service unavailable", attempt: requestCount }));
            });
            await new Promise((resolve) => upstreamServer.listen(0, resolve));
            upstreamPort = getServerPort(upstreamServer);
            // Use a plugin with only 1 retry (maxRetries=1 = 1 retry = 2 total attempts)
            const limitedRetryPlugin = (0, retry_plugin_js_1.createRetryPlugin)({
                maxRetries: 1,
                baseDelayMs: 20,
                maxDelayMs: 100,
                jitterFactor: 0,
            });
            const proxyLimited = (0, proxy_js_1.createProxy)({
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
            global.testProxyLimited = proxyLimited;
            global.testRetryPluginLimited = limitedRetryPlugin;
            proxy = proxyLimited;
            retryPlugin = limitedRetryPlugin;
        });
        (0, node_test_1.afterEach)(async () => {
            upstreamServer.close();
            const limitedProxy = global.testProxyLimited;
            const limitedPlugin = global.testRetryPluginLimited;
            if (limitedProxy)
                await limitedProxy.stop();
            if (limitedPlugin)
                limitedPlugin._internal.shutdown();
        });
        (0, node_test_1.it)("returns error after max retries exceeded", async () => {
            const response = await makeRequest(proxy.port, {
                path: "/v1/messages",
                method: "POST",
                body: JSON.stringify({ model: "claude-3", messages: [] }),
                headers: { "content-type": "application/json" },
            });
            // Should return the last error after max retries (1 retry = 2 total attempts)
            strict_1.default.equal(response.status, 503);
            const body = JSON.parse(response.body);
            strict_1.default.ok(body.error.includes("Service unavailable"));
            // Should have made 2 requests (initial + 1 retry)
            strict_1.default.equal(requestCount, 2);
        });
    });
});
