/**
 * Admin API handler for the proxy.
 *
 * Exposes management endpoints for the web UI to query proxy status,
 * environment variables, and logs.
 */

import http from "node:http";
import type { ProxyPlugin } from "@contextio/core";

export interface AdminOptions {
  plugins: ProxyPlugin[];
  logTraffic: boolean;
  startTime: number;
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
  source: "process" | "default";
}

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

export function createAdminHandler(options: AdminOptions): http.RequestListener {
  const { plugins, logTraffic, startTime } = options;
  let sessionCount = 0;

  // Track active sessions (simplified - in reality you'd track from plugin state)
  const activeSessions = new Set<string>();

  return async (req: http.IncomingMessage, res: http.ServerResponse): Promise<void> => {
    const parsedUrl = new URL(req.url || "", `http://${req.headers.host}`);

    // Only handle /admin/* routes
    if (!parsedUrl.pathname.startsWith("/admin/")) {
      res.writeHead(404, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ error: "Not found" }));
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
            res.end(JSON.stringify({ error: "Method not allowed" }));
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
          res.end(JSON.stringify(status));
          break;
        }

case "env": {
  if (req.method !== "GET") {
    res.writeHead(405, { "Content-Type": "application/json" });
    res.end(JSON.stringify({ error: "Method not allowed" }));
    return;
  }

  // Blacklist keys that look sensitive so they can't be leaked via the admin API.
  // Coolify-set variables (e.g. MY_TEST) and production-critical values like CSRF_SECRET
  // pass through the blacklist unchanged.
  const BLACKLISTED_PATTERNS: RegExp[] = [
    /(^|_)(PASSWORD|SECRET|TOKEN|API_KEY|PRIVATE_KEY|DATABASE_URL|CREDENTIAL|ACCESS_KEY)(_|$)/i,
  ];
  const ALLOWLISTED_KEYS: Set<string> = new Set([
    "CSRF_SECRET",
  ]);

  const envVars: ProxyEnvVar[] = Object.entries(process.env)
    .filter(([key]) => {
      if (ALLOWLISTED_KEYS.has(key)) return true;
      return !BLACKLISTED_PATTERNS.some((pattern) => pattern.test(key));
    })
    .map(([key, value]) => ({
      key,
      value: value ?? "",
      source: "process" as const,
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

  res.writeHead(200, { "Content-Type": "application/json" });
  res.end(JSON.stringify(envVars));
  break;
}

        case "logs": {
          if (req.method !== "GET") {
            res.writeHead(405, { "Content-Type": "application/json" });
            res.end(JSON.stringify({ error: "Method not allowed" }));
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
              res.write(`: heartbeat\n\n`);
            }, 30000);

            req.on("close", () => {
              clearInterval(interval);
            });

            return;
          }

          res.writeHead(200, { "Content-Type": "application/json" });
          res.end(JSON.stringify({ logs, containerId: "contextio-next" }));
          break;
        }

        case "clear-logs": {
          if (req.method !== "POST") {
            res.writeHead(405, { "Content-Type": "application/json" });
            res.end(JSON.stringify({ error: "Method not allowed" }));
            return;
          }

          clearLogs();
          res.writeHead(200, { "Content-Type": "application/json" });
          res.end(JSON.stringify({ success: true, message: "Logs cleared" }));
          break;
        }

        default: {
          res.writeHead(404, { "Content-Type": "application/json" });
          res.end(JSON.stringify({ error: `Unknown admin endpoint: /admin/${path}` }));
        }
      }
    } catch (error) {
      console.error("Admin API error:", error);
      res.writeHead(500, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ error: "Internal server error" }));
    }
  };
}