import { clsx } from "clsx";
import type { MetricsData, Session } from "@/types/api";
import { twMerge } from "tailwind-merge";

export function cn(...inputs: (string | boolean | undefined)[]): string {
  return twMerge(clsx(inputs.filter(Boolean)));
}

export function formatDateTime(date: string | Date): string {
  const d = new Date(date);
  return d.toLocaleDateString("en-US", {
  year: "numeric",
  month: "short",
  day: "numeric",
  hour: "2-digit",
  minute: "2-digit",
  timeZone: undefined,
 });
}

export function formatDuration(ms: number): string {
  const seconds = Math.floor(ms / 1000);
  const minutes = Math.floor(seconds / 60);
  const hours = Math.floor(minutes / 60);
  const days = Math.floor(hours / 24);

  if (days > 0) {
    return `${days}d ${hours % 24}h`;
  }
  if (hours > 0) {
    return `${hours}h ${minutes % 60}m`;
  }
  if (minutes > 0) {
    return `${minutes}m ${seconds % 60}s`;
  }
  return `${seconds}s`;
}

export function formatBytes(bytes: number): string {
  if (bytes === 0) return "0 B";
  const k = 1024;
  const sizes = ["B", "KB", "MB", "GB"];
  const i = Math.floor(Math.log(bytes) / Math.log(k));
  return `${parseFloat((bytes / Math.pow(k, i)).toFixed(2))} ${sizes[i]}`;
}

export function formatNumber(num: number): string {
  return num.toLocaleString();
}

export function safeJsonStringify(obj: unknown, spaces?: number): string {
  try {
    const seen = new WeakSet();
    return JSON.stringify(obj, (_key, value) => {
      if (typeof value === "object" && value !== null) {
        if (seen.has(value)) {
          return "[Circular]";
        }
        seen.add(value);
      }
      return value;
    }, spaces);
  } catch {
    return String(obj);
  }
}

// Type guards for API response validation
export function isValidSession(data: unknown): data is Session {
  if (!data || typeof data !== "object") return false;
  const session = data as Record<string, unknown>;
  return (
    typeof session.id === "string" &&
    typeof session.sessionId === "string" &&
    typeof session.source === "string" &&
    typeof session.provider === "string" &&
    typeof session.apiFormat === "string" &&
    typeof session.targetUrl === "string" &&
    typeof session.timestamp === "string" &&
    typeof session.responseStatus === "number" &&
    typeof session.responseIsStreaming === "boolean" &&
  (typeof session.requestBody === "undefined" ||
    (typeof session.requestBody === "object" &&
      session.requestBody !== null)) &&
  (typeof session.responseBody === "undefined" ||
    typeof session.responseBody === "string" ||
    session.responseBody === null) &&
    typeof session.timings === "object" &&
    typeof (session.timings as Record<string, unknown>).total_ms === "number"
  );
}

export function isValidMetricsData(data: unknown): data is MetricsData {
  if (!data || typeof data !== "object") return false;
  const metrics = data as Record<string, unknown>;
  return (
    typeof metrics.totalRequestBytes === "number" &&
    typeof metrics.totalResponseBytes === "number" &&
    Array.isArray(metrics.providers) &&
    Array.isArray(metrics.redactions) &&
    Array.isArray(metrics.traffic)
  );
}

/**
 * Auto-generate a regex pattern from a value for pattern-based matching.
 * Escapes special regex characters and replaces digit sequences with \d+.
 */
export function generatePatternFromValue(value: string): string {
  let pattern = value
    .replace(/[.+*?^${}()|[\]\\]/g, "\\$&")
    .replace(/\d+/g, "\\d+")
    .replace(/\s+/g, "\\s+");
  pattern = `^${pattern}$`;
  return pattern;
}