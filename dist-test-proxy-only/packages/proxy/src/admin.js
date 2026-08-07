/**
 * Admin API handler for the proxy.
 *
 * Exposes management endpoints for the web UI to query proxy status,
 * environment variables, and logs.
 */
import { SERVICE_IDENTIFIER } from "@contextio/core";
import { getAllMergedProviders } from "@contextio/core/db";
function isRateLimiterPlugin(plugin) {
    return (plugin.name === "rate-limiter" &&
        "_internal" in plugin &&
        typeof plugin._internal?.getAllBucketStates === "function" &&
        typeof plugin._internal?.getConfigSummary === "function");
}
// In-memory log buffer (in production, you'd want a more robust solution)
const logBuffer = [];
const MAX_LOG_ENTRIES = 1000;
// Override console methods to capture logs
const originalConsoleLog = console.log;
const originalConsoleError = console.error;
const originalConsoleWarn = console.warn;
const originalConsoleDebug = console.debug;
let logCaptureEnabled = false;
export function enableLogCapture() {
    if (logCaptureEnabled)
        return;
    logCaptureEnabled = true;
    console.log = (...args) => {
        addLogEntry("info", "stdout", args.map(String).join(" "));
        originalConsoleLog.apply(console, args);
    };
    console.error = (...args) => {
        addLogEntry("error", "stderr", args.map(String).join(" "));
        originalConsoleError.apply(console, args);
    };
    console.warn = (...args) => {
        addLogEntry("warn", "stderr", args.map(String).join(" "));
        originalConsoleWarn.apply(console, args);
    };
    console.debug = (...args) => {
        addLogEntry("debug", "stdout", args.map(String).join(" "));
        originalConsoleDebug.apply(console, args);
    };
}
function addLogEntry(level, source, message) {
    const entry = {
        id: `log-${Date.now()}-${Math.random().toString(36).slice(2, 9)}`,
        timestamp: new Date().toISOString(),
        level,
        message: message.slice(0, 2000), // Limit message length
        source,
    };
    logBuffer.push(entry);
    if (logBuffer.length > MAX_LOG_ENTRIES) {
        logBuffer.shift();
    }
}
export function getLogs(filter, limit = 100) {
    let filtered = [...logBuffer].reverse(); // Newest first
    if (filter?.levels && filter.levels.length > 0) {
        filtered = filtered.filter((log) => filter.levels.includes(log.level));
    }
    if (filter?.search) {
        const searchLower = filter.search.toLowerCase();
        filtered = filtered.filter((log) => log.message.toLowerCase().includes(searchLower) ||
            log.source.toLowerCase().includes(searchLower));
    }
    return filtered.slice(0, limit);
}
export function clearLogs() {
    logBuffer.length = 0;
}
function formatUptime(ms) {
    const seconds = Math.floor(ms / 1000);
    const minutes = Math.floor(seconds / 60);
    const hours = Math.floor(minutes / 60);
    const days = Math.floor(hours / 24);
    if (days > 0)
        return `${days}d ${hours % 24}h ${minutes % 60}m`;
    if (hours > 0)
        return `${hours}h ${minutes % 60}m`;
    if (minutes > 0)
        return `${minutes}m ${seconds % 60}s`;
    return `${seconds}s`;
}
/** Maps a merged provider to the admin API response format. */
function mapProviderToResponse(p) {
    return {
        id: p.id,
        name: p.name,
        upstreamUrl: p.upstreamUrl,
        apiFormat: p.apiFormat,
        authType: p.authType,
        enabled: p.enabled,
        rateLimit: p.rateLimit,
        retry: p.retry,
        customHeaders: p.customHeaders,
        allowBaseUrlOverride: p.allowBaseUrlOverride,
        baseUrlOverrideHeader: p.baseUrlOverrideHeader,
        source: p.source,
        dynamic: p.dynamic,
        models: p.models,
    };
}
export function createAdminHandler(options) {
    const { plugins, logTraffic, startTime } = options;
    let sessionCount = 0;
    // Track active sessions (simplified - in reality you'd track from plugin state)
    const activeSessions = new Set();
    return async (req, res) => {
        const parsedUrl = new URL(req.url || "", `http://${req.headers.host}`);
        // Only handle /admin/* routes
        if (!parsedUrl.pathname.startsWith("/admin/")) {
            res.writeHead(404, { "Content-Type": "application/json" });
            res.end(JSON.stringify({ error: "Not found", service: SERVICE_IDENTIFIER }));
            return;
        }
        // CORS headers for web UI
        res.setHeader("Access-Control-Allow-Origin", "*");
        res.setHeader("Access-Control-Allow-Methods", "GET, POST, OPTIONS");
        res.setHeader("Access-Control-Allow-Headers", "Content-Type");
        if (req.method === "OPTIONS") {
            res.writeHead(204);
            res.end();
            return;
        }
        const path = parsedUrl.pathname.slice(7); // Remove "/admin/"
        try {
            switch (path) {
                case "status": {
                    if (req.method !== "GET") {
                        res.writeHead(405, { "Content-Type": "application/json" });
                        res.end(JSON.stringify({ error: "Method not allowed", service: SERVICE_IDENTIFIER }));
                        return;
                    }
                    const status = {
                        running: true,
                        pid: process.pid,
                        port: parseInt(process.env.CONTEXT_PROXY_PORT || "4040", 10),
                        uptime: formatUptime(Date.now() - startTime),
                        sessions: activeSessions.size,
                        plugins: plugins.map((p) => p.name),
                        logTraffic,
                    };
                    res.writeHead(200, { "Content-Type": "application/json" });
                    res.end(JSON.stringify({ ...status, service: SERVICE_IDENTIFIER }));
                    break;
                }
                case "env": {
                    if (req.method !== "GET") {
                        res.writeHead(405, { "Content-Type": "application/json" });
                        res.end(JSON.stringify({ error: "Method not allowed", service: SERVICE_IDENTIFIER }));
                        return;
                    }
                    // Blacklist keys that look sensitive so their values can't be leaked via the admin API.
                    // Coolify-set variables (e.g. MY_TEST) and production-critical values like CSRF_SECRET
                    // are blocked by the SECRET pattern.
                    const BLACKLISTED_PATTERNS = [
                        /(^|_)(PASSWORD|SECRET|TOKEN|API_KEY|PRIVATE_KEY|DATABASE_URL|CREDENTIAL|ACCESS_KEY|CSRF_SECRET|ENCRYPTION_KEY)(_|$)/i,
                    ];
                    const isBlacklisted = (key) => {
                        return BLACKLISTED_PATTERNS.some((pattern) => pattern.test(key));
                    };
                    const MASKED_VALUE = "[REDACTED]";
                    const envVars = Object.entries(process.env)
                        .map(([key, value]) => ({
                        key,
                        value: isBlacklisted(key) ? MASKED_VALUE : (value ?? ""),
                        source: isBlacklisted(key) ? "blacklisted" : "process",
                    }));
                    // Add defaults for keys that might not be set, preserving the previous contract
                    // so the env page doesn't regress when the proxy is launched with a minimal env.
                    const defaults = {
                        CONTEXT_PROXY_BIND_HOST: "0.0.0.0",
                        CONTEXT_PROXY_PORT: "4040",
                        LOGGER_MAX_SESSIONS: "0",
                        REDACT_REVERSIBLE: "false",
                        REDACT_PRESET: "pii",
                    };
                    for (const [key, value] of Object.entries(defaults)) {
                        if (!envVars.some((v) => v.key === key)) {
                            envVars.push({ key, value, source: "default" });
                        }
                    }
                    res.writeHead(200, {
                        "Content-Type": "application/json",
                        "x-service-identifier": SERVICE_IDENTIFIER,
                    });
                    res.end(JSON.stringify(envVars));
                    break;
                }
                case "logs": {
                    if (req.method !== "GET") {
                        res.writeHead(405, { "Content-Type": "application/json" });
                        res.end(JSON.stringify({ error: "Method not allowed", service: SERVICE_IDENTIFIER }));
                        return;
                    }
                    const levels = parsedUrl.searchParams.get("levels")?.split(",").filter(Boolean);
                    const search = parsedUrl.searchParams.get("search") || undefined;
                    const limit = parseInt(parsedUrl.searchParams.get("limit") || "100", 10);
                    const stream = parsedUrl.searchParams.get("stream") === "true";
                    const logs = getLogs({ levels, search }, limit);
                    if (stream) {
                        // Server-Sent Events for real-time streaming
                        res.writeHead(200, {
                            "Content-Type": "text/event-stream",
                            "Cache-Control": "no-cache",
                            Connection: "keep-alive",
                        });
                        // Send existing logs first
                        for (const log of logs.reverse()) {
                            res.write(`data: ${JSON.stringify(log)}\n\n`);
                        }
                        // Keep connection open for new logs
                        const interval = setInterval(() => {
                            // In a real implementation, you'd have a way to get new logs
                            // For now, we'll just send a heartbeat
                            // Check if response is still writable (res.write returns false when closed)
                            // and handle write errors (e.g., client disconnected)
                            try {
                                if (!res.writableEnded && !res.destroyed) {
                                    const ok = res.write(`: heartbeat\n\n`);
                                    if (!ok) {
                                        // Buffer full or connection closed
                                        clearInterval(interval);
                                    }
                                }
                                else {
                                    clearInterval(interval);
                                }
                            }
                            catch {
                                clearInterval(interval);
                            }
                        }, 30000);
                        req.on("close", () => {
                            clearInterval(interval);
                            // End the response if headers were sent but not ended
                            if (res.writableEnded === false && res.headersSent) {
                                res.end();
                            }
                        });
                        return;
                    }
                    res.writeHead(200, { "Content-Type": "application/json" });
                    res.end(JSON.stringify({ logs, containerId: "contextio-next", service: SERVICE_IDENTIFIER }));
                    break;
                }
                case "clear-logs": {
                    if (req.method !== "POST") {
                        res.writeHead(405, { "Content-Type": "application/json" });
                        res.end(JSON.stringify({ error: "Method not allowed", service: SERVICE_IDENTIFIER }));
                        return;
                    }
                    clearLogs();
                    res.writeHead(200, { "Content-Type": "application/json" });
                    res.end(JSON.stringify({ success: true, message: "Logs cleared", service: SERVICE_IDENTIFIER }));
                    break;
                }
                case "providers": {
                    if (req.method !== "GET") {
                        res.writeHead(405, { "Content-Type": "application/json" });
                        res.end(JSON.stringify({ error: "Method not allowed", service: SERVICE_IDENTIFIER }));
                        return;
                    }
                    try {
                        const providers = getAllMergedProviders();
                        const providerList = providers.map(mapProviderToResponse);
                        res.writeHead(200, { "Content-Type": "application/json" });
                        res.end(JSON.stringify({ providers: providerList, total: providerList.length, service: SERVICE_IDENTIFIER }));
                    }
                    catch (error) {
                        console.error("[admin] Providers list error:", error);
                        res.writeHead(500, { "Content-Type": "application/json" });
                        res.end(JSON.stringify({ error: "Failed to load providers", service: SERVICE_IDENTIFIER }));
                    }
                    break;
                }
                case "rate-limiter": {
                    if (req.method !== "GET") {
                        res.writeHead(405, { "Content-Type": "application/json" });
                        res.end(JSON.stringify({ error: "Method not allowed", service: SERVICE_IDENTIFIER }));
                        return;
                    }
                    // Find the rate limiter plugin
                    const rateLimiterPlugin = plugins.find((p) => p.name === "rate-limiter");
                    if (!rateLimiterPlugin) {
                        console.error("[admin] Rate limiter plugin not found in plugins array:", plugins.map(p => p.name));
                        res.writeHead(404, { "Content-Type": "application/json" });
                        res.end(JSON.stringify({ error: "Rate limiter plugin not found", code: "RATE_LIMITER_NOT_FOUND", service: SERVICE_IDENTIFIER }));
                        return;
                    }
                    // Find the retry plugin for NVIDIA worker retry count and upstream 429 counts
                    const retryPlugin = plugins.find((p) => p.name === "retry");
                    let nvidiaWorkerRetryCount = 0;
                    let upstream429Counts = {};
                    if (retryPlugin && retryPlugin._internal?.getNvidiaWorkerRetryCount) {
                        nvidiaWorkerRetryCount = retryPlugin._internal.getNvidiaWorkerRetryCount();
                    }
                    if (retryPlugin && retryPlugin._internal?.getUpstream429Counts) {
                        upstream429Counts = retryPlugin._internal.getUpstream429Counts();
                    }
                    // Get bucket state from the plugin (using typed internal methods)
                    if (!isRateLimiterPlugin(rateLimiterPlugin)) {
                        console.error("[admin] Rate limiter plugin missing internal methods:", Object.keys(rateLimiterPlugin));
                        res.writeHead(500, { "Content-Type": "application/json" });
                        res.end(JSON.stringify({ error: "Rate limiter does not expose metrics methods", code: "RATE_LIMITER_INTERNAL_ERROR", service: SERVICE_IDENTIFIER }));
                        return;
                    }
                    try {
                        const getAllBucketStates = rateLimiterPlugin._internal.getAllBucketStates.bind(rateLimiterPlugin);
                        const getConfigSummary = rateLimiterPlugin._internal.getConfigSummary.bind(rateLimiterPlugin);
                        const config = getConfigSummary();
                        // Check if rate limiter is enabled
                        if (!config.enabled) {
                            res.writeHead(200, { "Content-Type": "application/json" });
                            res.end(JSON.stringify({
                                config: {
                                    maxRequests: config.maxRequests,
                                    windowMs: config.windowMs,
                                    bufferCapacity: config.bufferCapacity,
                                    maxEntries: config.maxEntries,
                                    enabled: config.enabled,
                                },
                                buckets: [],
                                totalBuckets: 0,
                                totalQueued: 0,
                                timestamp: new Date().toISOString(),
                                code: "RATE_LIMITER_DISABLED",
                                nvidiaWorkerRetryCount,
                                upstream429Counts,
                                service: SERVICE_IDENTIFIER,
                            }));
                            return;
                        }
                        const buckets = getAllBucketStates();
                        const metrics = {
                            config: {
                                maxRequests: config.maxRequests,
                                windowMs: config.windowMs,
                                bufferCapacity: config.bufferCapacity,
                                maxEntries: config.maxEntries,
                                enabled: config.enabled,
                            },
                            buckets: buckets.map((b) => {
                                let provider = b.provider;
                                let sessionId = b.sessionId;
                                if (!provider) {
                                    const lastColonIndex = b.key.lastIndexOf(":");
                                    if (lastColonIndex >= 0) {
                                        provider = b.key.slice(lastColonIndex + 1);
                                    }
                                    else {
                                        provider = b.key.length > 0 ? b.key : "unknown";
                                    }
                                }
                                if (!sessionId) {
                                    const lastColonIndex = b.key.lastIndexOf(":");
                                    if (lastColonIndex >= 0) {
                                        sessionId = b.key.slice(0, lastColonIndex);
                                    }
                                    else {
                                        sessionId = "all";
                                    }
                                }
                                return {
                                    key: b.key,
                                    tokens: b.tokens,
                                    maxTokens: b.maxTokens,
                                    bufferCapacity: b.bufferCapacity,
                                    queueLength: b.queueLength,
                                    provider,
                                    sessionId,
                                    requestsInWindow: b.requestsInWindow,
                                };
                            }),
                            totalBuckets: buckets.length,
                            totalQueued: buckets.reduce((sum, b) => sum + b.queueLength, 0),
                            timestamp: new Date().toISOString(),
                            code: "OK",
                            nvidiaWorkerRetryCount,
                            upstream429Counts,
                        };
                        res.writeHead(200, { "Content-Type": "application/json" });
                        res.end(JSON.stringify({ ...metrics, service: SERVICE_IDENTIFIER }));
                    }
                    catch (innerError) {
                        console.error("[admin] Rate limiter metrics error:", innerError);
                        res.writeHead(500, { "Content-Type": "application/json" });
                        res.end(JSON.stringify({
                            error: "Internal server error",
                            details: innerError instanceof Error ? innerError.message : String(innerError),
                            code: "RATE_LIMITER_INTERNAL_ERROR",
                            service: SERVICE_IDENTIFIER
                        }));
                    }
                    break;
                }
                default: {
                    res.writeHead(404, { "Content-Type": "application/json" });
                    res.end(JSON.stringify({ error: `Unknown admin endpoint: /admin/${path}`, service: SERVICE_IDENTIFIER }));
                }
            }
        }
        catch (error) {
            console.error("Admin API error:", error);
            // Only write error response if headers haven't been sent yet
            if (!res.headersSent) {
                res.writeHead(500, { "Content-Type": "application/json" });
                res.end(JSON.stringify({ error: "Internal server error", service: SERVICE_IDENTIFIER }));
            }
            else {
                // Headers already sent - we can't send a proper error response
                // Just end the response
                res.end();
            }
        }
    };
}
//# sourceMappingURL=admin.js.map