/**
 * Admin API handler for the proxy.
 *
 * Exposes management endpoints for the web UI to query proxy status,
 * environment variables, and logs.
 */

import http from "node:http";
import type { ProxyPlugin } from "@contextio/core";
import type { RateLimiterBucketState, RateLimiterConfigSummary, RateLimiterMetrics, ProviderConfig, Provider, OidcProviderConfig } from "@contextio/core";
import { SERVICE_IDENTIFIER } from "@contextio/core";
import { getAllMergedProviders, type MergedProvider } from "@contextio/core/db";
import { validateSession, type AuthSession } from "./auth.js";
import type { FeedbackStore } from "@contextio/redact";

/**
 * Extract session from request for admin authentication.
 * Returns session if valid, null if not authenticated.
 */
function getAdminSession(req: http.IncomingMessage, oidc: OidcProviderConfig | null): AuthSession | null {
  if (!oidc) return null;
  return validateSession(req, oidc.sessionSecret);
}

/**
 * Check if the authenticated user has admin privileges.
 * Currently checks against ADMIN_EMAILS environment variable (comma-separated).
 * In the future, this could check for a specific OIDC claim or role.
 */
function isAdmin(session: AuthSession): boolean {
  const adminEmails = process.env.ADMIN_EMAILS?.split(",").map((e) => e.trim().toLowerCase()) ?? [];
  if (adminEmails.length === 0) {
    console.warn("[admin] ADMIN_EMAILS environment variable not configured - admin access will be denied for all users");
    return false;
  }
  return session.email !== undefined && adminEmails.includes(session.email.toLowerCase());
}

export interface AdminOptions {
  plugins: ProxyPlugin[];
  logTraffic: boolean;
  startTime: number;
  oidc: OidcProviderConfig | null;
}

export interface ProxyStatus {
  running: boolean;
  pid: number;
  port: number;
  uptime: string;
  sessions: number;
  plugins: string[];
  logTraffic: boolean;
}

export interface ProxyEnvVar {
  key: string;
  value: string;
  source: "process" | "default" | "blacklisted";
}

// --- Rate Limiter Internal Types ---

export interface RateLimiterInternal {
  getAllBucketStates: () => Array<{
    key: string;
    tokens: number;
    maxTokens: number;
    bufferCapacity: number;
    queueLength: number;
    requestsInWindow: number;
    provider?: string;
    sessionId?: string;
  }>;
  getConfigSummary: () => {
    maxRequests: number;
    windowMs: number;
    bufferCapacity: number;
    maxEntries: number;
    enabled: boolean;
  };
}

// --- Provider Response Type ---

/** Response format for provider data in admin API. */
export interface ProviderResponse {
  id: string;
  name: string;
  upstreamUrl: string;
  apiFormat: string;
  authType: string;
  enabled: boolean;
  rateLimit: { maxRequests: number; windowMs: number; bufferCapacity: number };
  retry: { maxRetries: number; baseDelayMs: number; maxDelayMs: number; retryableStatuses: number[]; jitterFactor: number };
  customHeaders: Record<string, string>;
  allowBaseUrlOverride: boolean;
  baseUrlOverrideHeader: string;
  source: "default" | "env" | "file";
  dynamic: boolean;
  models: string[] | undefined;
}

function isRateLimiterPlugin(plugin: ProxyPlugin): plugin is ProxyPlugin & { _internal: RateLimiterInternal } {
  return (
    plugin.name === "rate-limiter" &&
    "_internal" in plugin &&
    typeof (plugin as { _internal?: RateLimiterInternal })._internal?.getAllBucketStates === "function" &&
    typeof (plugin as { _internal?: RateLimiterInternal })._internal?.getConfigSummary === "function"
  );
}

function isRetryPlugin(plugin: ProxyPlugin): plugin is ProxyPlugin & { _internal: RetryInternal } {
  return (
    plugin.name === "retry" &&
    "_internal" in plugin &&
    typeof (plugin as { _internal?: RetryInternal })._internal?.getRetryMetrics === "function"
  );
}

interface RetryInternal {
  getRetryMetrics: () => {
    providers: Array<{
      provider: string;
      maxRetries: number;
      maxResponseBufferSizeMB: number;
      nonStreamingRetryAttempts: number;
      streamingRetryAttempts: number;
      totalRetryAttempts: number;
      activeStreamingSessions: number;
      currentBufferUsageMB: number;
      maxBufferUsageMB: number;
      bufferUtilizationPercent: number;
    }>;
    totals: {
      totalNonStreamingRetries: number;
      totalStreamingRetries: number;
      totalRetryAttempts: number;
      totalActiveStreamingSessions: number;
      totalCurrentBufferUsageMB: number;
      totalMaxBufferUsageMB: number;
    };
  };
  getNvidiaWorkerRetryCount: () => number;
  getUpstream429Counts: () => Record<string, number>;
  getRequestStoreSize: () => number;
  getStreamStateSize: () => number;
}

// --- Rate Limiter Metrics ---

// Types are imported from @contextio/core

// Log entry for the admin API
export interface LogEntry {
  id: string;
  timestamp: string;
  level: "error" | "warn" | "info" | "debug";
  message: string;
  source: "stdout" | "stderr";
  sessionId?: string;
}

// In-memory log buffer (in production, you'd want a more robust solution)
const logBuffer: LogEntry[] = [];
const MAX_LOG_ENTRIES = 1000;

// Override console methods to capture logs
const originalConsoleLog = console.log;
const originalConsoleError = console.error;
const originalConsoleWarn = console.warn;
const originalConsoleDebug = console.debug;

let logCaptureEnabled = false;

export function enableLogCapture(): void {
  if (logCaptureEnabled) return;
  logCaptureEnabled = true;

  console.log = (...args: unknown[]) => {
    addLogEntry("info", "stdout", args.map(String).join(" "));
    originalConsoleLog.apply(console, args);
  };

  console.error = (...args: unknown[]) => {
    addLogEntry("error", "stderr", args.map(String).join(" "));
    originalConsoleError.apply(console, args);
  };

  console.warn = (...args: unknown[]) => {
    addLogEntry("warn", "stderr", args.map(String).join(" "));
    originalConsoleWarn.apply(console, args);
  };

  console.debug = (...args: unknown[]) => {
    addLogEntry("debug", "stdout", args.map(String).join(" "));
    originalConsoleDebug.apply(console, args);
  };
}

function addLogEntry(level: LogEntry["level"], source: LogEntry["source"], message: string): void {
  const entry: LogEntry = {
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

export function getLogs(
  filter?: { levels?: LogEntry["level"][]; search?: string },
  limit = 100,
): LogEntry[] {
  let filtered = [...logBuffer].reverse(); // Newest first

  if (filter?.levels && filter.levels.length > 0) {
    filtered = filtered.filter((log) => filter.levels!.includes(log.level));
  }

  if (filter?.search) {
    const searchLower = filter.search.toLowerCase();
    filtered = filtered.filter(
      (log) =>
        log.message.toLowerCase().includes(searchLower) ||
        log.source.toLowerCase().includes(searchLower),
    );
  }

  return filtered.slice(0, limit);
}

export function clearLogs(): void {
  logBuffer.length = 0;
}

function formatUptime(ms: number): string {
  const seconds = Math.floor(ms / 1000);
  const minutes = Math.floor(seconds / 60);
  const hours = Math.floor(minutes / 60);
  const days = Math.floor(hours / 24);

  if (days > 0) return `${days}d ${hours % 24}h ${minutes % 60}m`;
  if (hours > 0) return `${hours}h ${minutes % 60}m`;
  if (minutes > 0) return `${minutes}m ${seconds % 60}s`;
  return `${seconds}s`;
}

/** Maps a merged provider to the admin API response format. */
function mapProviderToResponse(p: MergedProvider): ProviderResponse {
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

export function createAdminHandler(options: AdminOptions): http.RequestListener {
  const { plugins, logTraffic, startTime, oidc } = options;
  let sessionCount = 0;

  // Track active sessions (simplified - in reality you'd track from plugin state)
  const activeSessions = new Set<string>();

  // Get FeedbackStore from redact plugin
  const redactPlugin = plugins.find((p) => p.name === "redact") as (ProxyPlugin & { getFeedbackStore?: () => FeedbackStore }) | undefined;
  const feedbackStore: FeedbackStore | undefined = redactPlugin?.getFeedbackStore?.();

  return async (req: http.IncomingMessage, res: http.ServerResponse): Promise<void> => {
    const parsedUrl = new URL(req.url || "", `http://${req.headers.host}`);

    // Only handle /admin/* routes
    if (!parsedUrl.pathname.startsWith("/admin/")) {
      res.writeHead(404, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ error: "Not found", service: SERVICE_IDENTIFIER }));
      return;
    }

    // CORS headers for web UI
    // Echo origin for credentialed requests (wildcard not allowed with credentials)
    const origin = req.headers.origin;
    if (origin) {
      res.setHeader("Access-Control-Allow-Origin", origin);
      res.setHeader("Access-Control-Allow-Credentials", "true");
    }
    res.setHeader("Access-Control-Allow-Methods", "GET, POST, DELETE, OPTIONS");
    res.setHeader("Access-Control-Allow-Headers", "Content-Type, X-Requested-With, X-CSRF-Token");
    res.setHeader("Vary", "Origin");

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

          const status: ProxyStatus = {
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
          return;
        }

        case "memory": {
          if (req.method !== "GET") {
            res.writeHead(405, { "Content-Type": "application/json" });
            res.end(JSON.stringify({ error: "Method not allowed", service: SERVICE_IDENTIFIER }));
            return;
          }

          const memUsage = process.memoryUsage();
          const memStats = {
            rss: Math.round(memUsage.rss / 1024 / 1024), // MB
            heapTotal: Math.round(memUsage.heapTotal / 1024 / 1024), // MB
            heapUsed: Math.round(memUsage.heapUsed / 1024 / 1024), // MB
            external: Math.round(memUsage.external / 1024 / 1024), // MB
            arrayBuffers: Math.round(memUsage.arrayBuffers / 1024 / 1024), // MB
            heapUsedPercent: Math.round((memUsage.heapUsed / memUsage.heapTotal) * 100),
            gcAvailable: typeof global.gc === "function",
            nodeOptions: process.env.NODE_OPTIONS || "",
            timestamp: new Date().toISOString(),
          };

          // Also include plugin-specific memory info if available
          const rateLimiterPlugin = plugins.find((p) => p.name === "rate-limiter");
          const retryPlugin = plugins.find((p) => p.name === "retry");
          
          let rateLimiterStats: any = null;
          let retryStats: any = null;
          
          if (rateLimiterPlugin && (rateLimiterPlugin as any)._internal?.getAllBucketStates) {
            const buckets = (rateLimiterPlugin as any)._internal.getAllBucketStates();
            rateLimiterStats = {
              totalBuckets: buckets.length,
              totalQueued: buckets.reduce((sum: number, b: any) => sum + b.queueLength, 0),
              bucketsWithRequests: buckets.filter((b: any) => b.requestsInWindow > 0).length,
            };
          }
          
          if (retryPlugin && (retryPlugin as any)._internal?.getRequestStoreSize) {
            retryStats = {
              requestStoreSize: (retryPlugin as any)._internal.getRequestStoreSize(),
              streamStateSize: (retryPlugin as any)._internal.getStreamStateSize?.() || 0,
            };
          }

          res.writeHead(200, { "Content-Type": "application/json" });
          res.end(JSON.stringify({
            process: memStats,
            rateLimiter: rateLimiterStats,
            retry: retryStats,
            service: SERVICE_IDENTIFIER,
          }));
          return;
        }

        case "env": {
          if (req.method !== "GET") {
            res.writeHead(405, { "Content-Type": "application/json" });
            res.end(
              JSON.stringify({
                error: "Method not allowed",
                service: SERVICE_IDENTIFIER,
              }),
            );
            return;
          }

          // Blacklist keys that look sensitive so their values can't be leaked via the admin API.
          // Coolify-set variables (e.g. MY_TEST) and production-critical values like CSRF_SECRET
          // are blocked by the SECRET pattern.
          const BLACKLISTED_PATTERNS: RegExp[] = [
            /(^|_)(PASSWORD|SECRET|TOKEN|API_KEY|PRIVATE_KEY|DATABASE_URL|CREDENTIAL|ACCESS_KEY|CSRF_SECRET|ENCRYPTION_KEY)(_|$)/i,
          ];

          const isBlacklisted = (key: string): boolean => {
            return BLACKLISTED_PATTERNS.some((pattern) => pattern.test(key));
          };

          const MASKED_VALUE = "[REDACTED]";

          const envVars: ProxyEnvVar[] = Object.entries(process.env)
            .map(([key, value]) => ({
              key,
              value: isBlacklisted(key) ? MASKED_VALUE : (value ?? ""),
              source: isBlacklisted(key) ? ("blacklisted" as const) : ("process" as const),
            }));

          // Add defaults for keys that might not be set, preserving the previous contract
          // so the env page doesn't regress when the proxy is launched with a minimal env.
          const defaults: Record<string, string> = {
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
          return;
        }

        case "logs": {
          if (req.method !== "GET") {
            res.writeHead(405, { "Content-Type": "application/json" });
            res.end(JSON.stringify({ error: "Method not allowed", service: SERVICE_IDENTIFIER }));
            return;
          }

          const levels = parsedUrl.searchParams.get("levels")?.split(",").filter(Boolean) as LogEntry["level"][] | undefined;
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
                } else {
                  clearInterval(interval);
                }
              } catch {
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
          return;
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
          return;
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
          } catch (error) {
            console.error("[admin] Providers list error:", error);
            res.writeHead(500, { "Content-Type": "application/json" });
            res.end(JSON.stringify({ error: "Failed to load providers", service: SERVICE_IDENTIFIER }));
          }
          return;
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
          let upstream429Counts: Record<string, number> = {};
          if (retryPlugin && (retryPlugin as any)._internal?.getNvidiaWorkerRetryCount) {
            nvidiaWorkerRetryCount = (retryPlugin as any)._internal.getNvidiaWorkerRetryCount();
          }
          if (retryPlugin && (retryPlugin as any)._internal?.getUpstream429Counts) {
            upstream429Counts = (retryPlugin as any)._internal.getUpstream429Counts();
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
                  } else {
                    provider = b.key.length > 0 ? b.key : "unknown";
                  }
                }

                if (!sessionId) {
                  const lastColonIndex = b.key.lastIndexOf(":");
                  if (lastColonIndex >= 0) {
                    sessionId = b.key.slice(0, lastColonIndex);
                  } else {
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
          } catch (innerError) {
            console.error("[admin] Rate limiter metrics error:", innerError);
            res.writeHead(500, { "Content-Type": "application/json" });
            res.end(JSON.stringify({ 
              error: "Internal server error", 
              details: innerError instanceof Error ? innerError.message : String(innerError),
              code: "RATE_LIMITER_INTERNAL_ERROR",
              service: SERVICE_IDENTIFIER 
            }));
          }
          return;
        }
 
        // Retry Metrics Endpoint
        case "retry-metrics": {
          if (req.method !== "GET") {
            res.writeHead(405, { "Content-Type": "application/json" });
            res.end(JSON.stringify({ error: "Method not allowed", service: SERVICE_IDENTIFIER }));
            return;
          }
 
          const retryPlugin = plugins.find((p) => p.name === "retry");
          if (!retryPlugin) {
            console.error("[admin] Retry plugin not found in plugins array:", plugins.map(p => p.name));
            res.writeHead(404, { "Content-Type": "application/json" });
            res.end(JSON.stringify({ error: "Retry plugin not found", code: "RETRY_PLUGIN_NOT_FOUND", service: SERVICE_IDENTIFIER }));
            return;
          }
 
          if (!isRetryPlugin(retryPlugin)) {
            console.error("[admin] Retry plugin missing internal methods:", Object.keys(retryPlugin));
            res.writeHead(500, { "Content-Type": "application/json" });
            res.end(JSON.stringify({ error: "Retry plugin does not expose metrics methods", code: "RETRY_PLUGIN_INTERNAL_ERROR", service: SERVICE_IDENTIFIER }));
            return;
          }
 
          try {
            const getRetryMetrics = retryPlugin._internal.getRetryMetrics.bind(retryPlugin);
            const metrics = getRetryMetrics();
 
            res.writeHead(200, { "Content-Type": "application/json" });
            res.end(JSON.stringify({ ...metrics, service: SERVICE_IDENTIFIER }));
          } catch (innerError) {
            console.error("[admin] Retry metrics error:", innerError);
            res.writeHead(500, { "Content-Type": "application/json" });
            res.end(JSON.stringify({
              error: "Internal server error",
              details: innerError instanceof Error ? innerError.message : String(innerError),
              code: "RETRY_PLUGIN_INTERNAL_ERROR",
              service: SERVICE_IDENTIFIER
            }));
          }
          return;
        }
 
        // False Positive Management Endpoints
        // Handle both /redact/false-positives and /redact/false-positives/clear
        case "redact/false-positives":
        case "redact/false-positives/clear": {
          // Require admin authentication
          const session = getAdminSession(req, oidc);
          if (!session) {
            res.writeHead(401, { "Content-Type": "application/json" });
            res.end(JSON.stringify({ error: "Unauthorized - admin authentication required", service: SERVICE_IDENTIFIER }));
            return;
          }
 
          // Check admin role
          if (!isAdmin(session)) {
            res.writeHead(403, { "Content-Type": "application/json" });
            res.end(JSON.stringify({ error: "Forbidden - admin role required", service: SERVICE_IDENTIFIER }));
            return;
          }
 
          // CSRF protection for state-changing operations (POST, DELETE)
          // Require a custom header (X-Requested-With or X-CSRF-Token). This blocks simple
          // form-based CSRF attacks (which cannot set custom headers). It does NOT block
          // JavaScript-based cross-origin attacks because the CORS config (line 262) echoes
          // any Origin, allowing preflight to succeed for all origins.
          if (req.method === "POST" || req.method === "DELETE") {
            const csrfHeader = req.headers["x-requested-with"] || req.headers["x-csrf-token"];
            if (!csrfHeader) {
              res.writeHead(403, { "Content-Type": "application/json" });
              res.end(JSON.stringify({ error: "CSRF token required: include X-Requested-With or X-CSRF-Token header", service: SERVICE_IDENTIFIER }));
              return;
            }
          }

          // Check if FeedbackStore is configured
          if (!feedbackStore) {
            res.writeHead(503, { "Content-Type": "application/json" });
            res.end(JSON.stringify({ error: "Feedback store not configured", code: "FEEDBACK_STORE_NOT_CONFIGURED", service: SERVICE_IDENTIFIER }));
            return;
          }

          // Check if this is the /clear endpoint
          const isClearEndpoint = path === "redact/false-positives/clear";

          // Handle different HTTP methods
          if (req.method === "GET") {
            // GET /admin/redact/false-positives - List all false positives with pagination
            if (isClearEndpoint) {
              res.writeHead(405, { "Content-Type": "application/json" });
              res.end(
                JSON.stringify({
                  error: "Method not allowed",
                  service: SERVICE_IDENTIFIER,
                }),
              );
              return;
            }

            const ruleId = parsedUrl.searchParams.get("ruleId") || undefined;
            const sessionId = parsedUrl.searchParams.get("sessionId") || undefined;
            const pageParam = parseInt(parsedUrl.searchParams.get("page") || "1", 10);
            const pageSizeParam = parseInt(parsedUrl.searchParams.get("pageSize") || "50", 10);
            const page = Number.isNaN(pageParam) || pageParam < 1 ? 1 : pageParam;
            const pageSize = Number.isNaN(pageSizeParam) || pageSizeParam < 1 ? 50 : Math.min(pageSizeParam, 200);

            try {
              const allEntries = await feedbackStore.getAllFalsePositives(ruleId, sessionId);
              const total = allEntries.length;
              const start = (page - 1) * pageSize;
              const end = start + pageSize;
              const entries = allEntries.slice(start, end);

              res.writeHead(200, { "Content-Type": "application/json" });
              res.end(JSON.stringify({
                falsePositives: entries,
                pagination: {
                  page,
                  pageSize,
                  total,
                  totalPages: Math.ceil(total / pageSize),
                },
                service: SERVICE_IDENTIFIER,
              }));
            } catch (error) {
              console.error("[admin] False positives list error:", error);
              res.writeHead(500, { "Content-Type": "application/json" });
              res.end(JSON.stringify({ error: "Failed to load false positives", service: SERVICE_IDENTIFIER }));
            }
            return;
          }

          if (req.method === "POST") {
            // POST /admin/redact/false-positives/clear - Clear all false positives
            if (isClearEndpoint) {
              const ruleId = parsedUrl.searchParams.get("ruleId") || undefined;
              const sessionId = parsedUrl.searchParams.get("sessionId") || undefined;

              try {
                const cleared = await feedbackStore.clear(ruleId, sessionId);
                res.writeHead(200, { "Content-Type": "application/json" });
                res.end(JSON.stringify({ success: true, cleared, message: `Cleared ${cleared} false positive(s)`, service: SERVICE_IDENTIFIER }));
              } catch (error) {
                console.error("[admin] False positives clear error:", error);
                res.writeHead(500, { "Content-Type": "application/json" });
                res.end(JSON.stringify({ error: "Failed to clear false positives", service: SERVICE_IDENTIFIER }));
              }
              return;
            }

            // POST /admin/redact/false-positives - Create new false positive entry
            // Validate Content-Type
            const contentType = req.headers["content-type"] || "";
            if (!contentType.includes("application/json")) {
              res.writeHead(415, { "Content-Type": "application/json" });
              res.end(JSON.stringify({ error: "Content-Type must be application/json", service: SERVICE_IDENTIFIER }));
              return;
            }

            // Parse request body with size limit (1 MB)
            const MAX_BODY_SIZE = 1024 * 1024;
            let body = "";
            for await (const chunk of req) {
              body += chunk;
              if (body.length > MAX_BODY_SIZE) {
                res.writeHead(413, { "Content-Type": "application/json" });
                res.end(JSON.stringify({ error: "Request body too large", service: SERVICE_IDENTIFIER }));
                return;
              }
            }

            let params: {
              value: string;
              ruleId: string;
              label: string;
              path: string;
              sessionId?: string;
              matchMode?: "exact" | "pattern";
              pattern?: string;
            };

            try {
              params = JSON.parse(body);
            } catch (error) {
              console.error("[admin] False positive JSON parse error:", error);
              res.writeHead(400, { "Content-Type": "application/json" });
              res.end(JSON.stringify({ error: "Invalid JSON body", service: SERVICE_IDENTIFIER }));
              return;
            }

            // Validate required fields
            if (!params.value || !params.ruleId || !params.label || !params.path) {
              res.writeHead(400, { "Content-Type": "application/json" });
              res.end(JSON.stringify({ error: "Missing required fields: value, ruleId, label, path", service: SERVICE_IDENTIFIER }));
              return;
            }

            // Validate matchMode if provided
            if (params.matchMode !== undefined && params.matchMode !== "exact" && params.matchMode !== "pattern") {
              res.writeHead(400, { "Content-Type": "application/json" });
              res.end(JSON.stringify({ error: "Invalid matchMode: must be 'exact' or 'pattern'", service: SERVICE_IDENTIFIER }));
              return;
            }

            try {
              const entry = await feedbackStore.recordFalsePositive({
                value: params.value,
                ruleId: params.ruleId,
                label: params.label,
                path: params.path,
                timestamp: Date.now(),
                sessionId: params.sessionId,
                matchMode: params.matchMode ?? "exact",
                ...(params.pattern && { pattern: params.pattern }),
              });

              res.writeHead(201, { "Content-Type": "application/json" });
              res.end(JSON.stringify({ success: true, falsePositive: entry, service: SERVICE_IDENTIFIER }));
            } catch (error) {
              console.error("[admin] False positive create error:", error);
              res.writeHead(500, { "Content-Type": "application/json" });
              res.end(JSON.stringify({ error: "Failed to create false positive entry", service: SERVICE_IDENTIFIER }));
            }
            return;
          }

          if (req.method === "DELETE") {
            // DELETE /admin/redact/false-positives - Remove false positive entry
            // Uses query parameters: value, ruleId, sessionId (no numeric ID in the store)
            if (isClearEndpoint) {
              res.writeHead(405, { "Content-Type": "application/json" });
              res.end(
                JSON.stringify({
                  error: "Method not allowed",
                  service: SERVICE_IDENTIFIER,
                }),
              );
              return;
            }

            const value = parsedUrl.searchParams.get("value");
            const ruleId = parsedUrl.searchParams.get("ruleId");
            const sessionId = parsedUrl.searchParams.get("sessionId") || undefined;

            if (value === null || value === "" || ruleId === null || ruleId === "") {
              res.writeHead(400, { "Content-Type": "application/json" });
              res.end(JSON.stringify({ error: "Missing required query parameters: value, ruleId", service: SERVICE_IDENTIFIER }));
              return;
            }

            try {
              const removed = await feedbackStore.removeFalsePositive(value, ruleId, sessionId);
              if (!removed) {
                res.writeHead(404, { "Content-Type": "application/json" });
                res.end(JSON.stringify({ error: "False positive entry not found", service: SERVICE_IDENTIFIER }));
                return;
              }

              res.writeHead(200, { "Content-Type": "application/json" });
              res.end(JSON.stringify({ success: true, message: "False positive entry removed", service: SERVICE_IDENTIFIER }));
            } catch (error) {
              console.error("[admin] False positive delete error:", error);
              res.writeHead(500, { "Content-Type": "application/json" });
              res.end(JSON.stringify({ error: "Failed to remove false positive entry", service: SERVICE_IDENTIFIER }));
            }
            return;
          }

          // Method not allowed
          res.writeHead(405, { "Content-Type": "application/json" });
          res.end(
            JSON.stringify({
              error: "Method not allowed",
              service: SERVICE_IDENTIFIER,
            }),
          );
          return;
        }
        default: {
          console.warn("[admin] Unrecognized API state:", path);
          res.writeHead(404, { "Content-Type": "application/json" });
          res.end(JSON.stringify({ error: `Unknown admin endpoint: /admin/${path}`, service: SERVICE_IDENTIFIER }));
          return;
        }
      }
    } catch (error) {
      console.error("Admin API error:", error);
      // Only write error response if headers haven't been sent yet
      if (!res.headersSent) {
        res.writeHead(500, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ error: "Internal server error", service: SERVICE_IDENTIFIER }));
      } else {
        // Headers already sent - we can't send a proper error response
        // Just end the response
        res.end();
      }
    }
  };
}