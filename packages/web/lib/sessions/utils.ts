import fs from "fs/promises";
import { join, resolve } from "path";

import type { Session, Capture } from "@/types/api";
import { parseResponseUsage, estimateTokensFromText } from "@contextio/core";

// Re-export Session and Capture types for convenience
export type { Session, Capture } from "@/types/api";

// Allow override via environment variable (used in Docker environments)
// Falls back to default ~/.contextio/captures for local development
let _captureDir: string | undefined;

function getDefaultCaptureDir(): string {
  const { homedir } = require("os");
  return process.env.LOGGER_CAPTURE_DIR || join(homedir(), ".contextio", "captures");
}

/** Read the capture directory currently in effect. */
export function getCaptureDir(): string {
  if (!_captureDir) {
    _captureDir = getDefaultCaptureDir();
  }
  return _captureDir;
}

/** Update the capture directory seen by all server-side helpers. */
export function setCaptureDir(dir: string): void {
  _captureDir = dir;
  // Keep the deprecated re-export in sync for external callers
  CAPTURE_DIR = dir;
}

/** @deprecated Use `getCaptureDir()` — live ESM binding kept for external
 *  callers that haven't migrated. Internal code should call `getCaptureDir()`
 *  directly to avoid relying on live-binding propagation quirks. */
export let CAPTURE_DIR: string = getCaptureDir();

export const MAX_FILE_SIZE = 10 * 1024 * 1024;
export const MAX_FILENAME_LENGTH = 255;

/**
 * Validate filename to prevent path traversal attacks and ensure safe file access.
 */
export function isValidFilename(filename: string): boolean {
  if (!filename || filename.length === 0) return false;
  if (filename.length > MAX_FILENAME_LENGTH) return false;
  if (filename.startsWith(".")) return false;
  if (
    filename.includes("..") ||
    filename.includes("/") ||
    filename.includes("\\")
  )
    return false;
  const validPattern = /^[a-zA-Z0-9_-]+\.json$/;
  return validPattern.test(filename);
}

/**
 * Derive metadata file path: `<name>.redact-meta.json`.
 *
 * If the input filename ends in `.json`, the metadata filename replaces
 * that suffix. Otherwise `.redact-meta.json` is appended.
 */
export function metaFilenameFor(captureFilename: string): string {
  const base = captureFilename.endsWith(".json")
    ? captureFilename.slice(0, -".json".length)
    : captureFilename;
  return `${base}.redact-meta.json`;
}

/**
 * List capture files from the capture directory.
 */
export async function listCaptureFiles(): Promise<string[]> {
  try {
  const files = await fs.readdir(getCaptureDir());
    return files
      .filter((f) => isValidFilename(f) && !f.endsWith(".tmp") && !f.includes("redact-meta"))
      .sort();
  } catch {
    return [];
  }
}

/**
 * Extract capture metadata from parsed data.
 */
export function extractCaptureMetadata(
  filename: string,
  data: Record<string, unknown>,
): Capture {
  const source = typeof data.source === "string" ? data.source : (extractSource(filename) ?? "unknown");

  const getNumber = (obj: unknown, key: string): number => {
    if (typeof obj === "object" && obj !== null) {
      const val = (obj as Record<string, unknown>)[key];
      return typeof val === "number" ? val : Number(val) || 0;
    }
    return 0;
  };

  const rawTimings = data.timings && typeof data.timings === "object" ? (data.timings as Record<string, unknown>) : {};

  return {
    id: filename,
    sessionId: typeof data.sessionId === "string" && data.sessionId.length > 0 ? data.sessionId : (extractSessionId(filename) ?? ""),
    source,
    provider: typeof data.provider === "string" ? data.provider : "unknown",
    apiFormat: typeof data.apiFormat === "string" ? data.apiFormat : "unknown",
    targetUrl: typeof data.targetUrl === "string" ? data.targetUrl : "",
    method: typeof data.method === "string" ? data.method : "unknown",
    requestBytes: getNumber(data, "requestBytes"),
    responseBytes: getNumber(data, "responseBytes"),
    responseStatus: typeof data.responseStatus === "number" ? data.responseStatus : Number(data.responseStatus) || 0,
    responseIsStreaming: typeof data.responseIsStreaming === "boolean" ? data.responseIsStreaming : data.responseIsStreaming === true || data.responseIsStreaming === "true",
    timestamp: typeof data.timestamp === "string" ? data.timestamp : new Date().toISOString(),
    timings: {
      send_ms: getNumber(rawTimings, "send_ms"),
      wait_ms: getNumber(rawTimings, "wait_ms"),
      receive_ms: getNumber(rawTimings, "receive_ms"),
      total_ms: getNumber(rawTimings, "total_ms"),
    },
  };
}

/** Canonical `logDir` → absolute capture-directory resolver. */
export function resolveLogDir(logDir: string): string {
  const { homedir } = require("os");
  const trimmed = logDir.trim();
  if (!trimmed) {
    return process.env.LOGGER_CAPTURE_DIR || getDefaultCaptureDir();
  }
  if (trimmed === "~") return homedir();
  if (trimmed.startsWith("~/")) return join(homedir(), trimmed.slice(2));
  if (trimmed.startsWith("/")) return trimmed;
  return resolve(process.cwd(), trimmed);
}

/** Resolve and apply a Settings `logDir` value as the active capture directory. */
export function applyLogDir(logDir: string): void {
  setCaptureDir(resolveLogDir(logDir));
}


/**
 * Safely extract session ID from filename or data.
 */
export function extractSessionId(
  filename: string,
  data?: Record<string, unknown>
): string | null {
  if (data && typeof data.sessionId === "string" && data.sessionId.length > 0) {
    return data.sessionId;
  }

  const match = filename.match(/_([a-f0-9]{8})_\d{13}-\d{6}\.json$/i);
  if (match) return match[1].toLowerCase();

  return null;
}

/**
 * Safely extract source from filename.
 * Supports filename format: {source}_{sessionId}_{timestamp}-{counter}.json
 * where source is alphanumeric with hyphens/underscores.
 * Session ID is optional - if present, it's 8 hex chars before timestamp.
 *
 * @param filename - The capture filename to parse
 * @returns The extracted source or null if not found
 */
export function extractSource(filename: string): string | null {
  // With session ID: {source}_{sessionId}_{13digitTimestamp}-{counter}.json
  // Source is everything before the session ID (8 hex chars before timestamp)
  const withSessionMatch = filename.match(
    /^([a-zA-Z0-9_-]+)_[a-f0-9]{8}_\d{13}-\d{6}\.json$/i,
  );
  if (withSessionMatch) return withSessionMatch[1];

  // Without session ID: {source}_{13digitTimestamp}-{counter}.json
  // Source is everything before the timestamp
  const withoutSessionMatch = filename.match(
    /^([a-zA-Z0-9_-]+)_\d{13}-\d{6}\.json$/i,
  );
  if (withoutSessionMatch) return withoutSessionMatch[1];

  return null;
}

/**
 * Validate capture timestamp and return ISO string or null if invalid.
 */
export function validateCaptureTimestamp(timestamp: unknown): string | null {
  if (typeof timestamp !== "string") return null;
  const date = new Date(timestamp);
  return isNaN(date.getTime()) ? null : timestamp;
}

/**
 * Result of extracting context values from a session's request bodies.
 * - `count`: the number of scalar (string/number/boolean) leaf values found.
 * - `values`: a flat map of dotted-path keys to their scalar values.
 *
 * The extraction walks at most two levels of nesting: top-level keys plus one
 * level of nested keys (object properties or array indices, flattened to
 * dotted-path keys like "messages.0"). Arrays ARE traversed because
 * `typeof [] === "object"` enters the nested branch. Null values are skipped
 * at every level. This count is what `SessionMetrics.totalContextValues`
 * reports and matches the row count in the "Context Values" table.
 */
export interface ContextValues {
  count: number;
  values: Record<string, unknown>;
}

/**
 * Extract scalar leaf values from a request body for display as "context values".
 * Single source of truth for `totalContextValues` across all API routes.
 */
export function computeContextValues(requestBody: unknown): ContextValues {
  const values: Record<string, unknown> = {};

  if (requestBody && typeof requestBody === "object") {
    const body = requestBody as Record<string, unknown>;
    for (const [key, value] of Object.entries(body)) {
      if (typeof value === "string" || typeof value === "number" || typeof value === "boolean") {
        values[key] = value;
      } else if (value !== null && typeof value === "object") {
        for (const [subKey, subValue] of Object.entries(value)) {
          if (typeof subValue === "string" || typeof subValue === "number" || typeof subValue === "boolean") {
            values[`${key}.${subKey}`] = subValue;
          }
        }
      }
    }
  }

  return { count: Object.keys(values).length, values };
}

/**
 * Result of token usage computation.
 */
export interface TokenUsageResult {
  /** Estimated or actual input tokens */
  input: number;
  /** Estimated or actual output tokens */
  output: number;
  /** Model name detected from response, if available */
  model: string | null;
}

/**
 * Extract token usage counts from a parsed LLM response body.
 *
 * Tries the rich core parser first (covers OpenAI, Anthropic, Gemini, and
 * Context Lens wrapper formats). Falls back to a cheap character-count
 * approximation when the capture did not preserve usage fields so the
 * capture breakdown table always shows a plausible non-zero estimate.
 *
 * If responseBody is empty but requestBody is provided, estimates input tokens
 * from the request body.
 */
export function computeTokenUsage(
  responseBody: string | null | undefined,
  requestBody?: unknown,
): TokenUsageResult {
  // If we have a response body, parse it for actual usage data
  if (responseBody) {
    const parsed = parseResponseUsage(responseBody);
    const fallback = estimateTokensFromText(responseBody);

    if (parsed.inputTokens === 0 && parsed.outputTokens === 0) {
      return { input: fallback, output: fallback, model: parsed.model };
    }

    const input = parsed.inputTokens || fallback;
    const output = parsed.outputTokens || fallback;
    return { input, output, model: parsed.model };
  }

  // No response body - estimate from request body if available
  if (requestBody) {
    const requestText = JSON.stringify(requestBody);
    const estimatedInput = estimateTokensFromText(requestText);
    return { input: estimatedInput, output: 0, model: null };
  }

  // No data at all
  return { input: 0, output: 0, model: null };
}

/**
 * Extract capture metadata from parsed data.
 */
export async function getSessionMetadata(
  filename: string,
  data: Record<string, unknown>,
): Promise<
  Omit<Session, "requestBody" | "responseBody" | "timings"> & {
    requestBody: Record<string, unknown>;
    responseBody: string | null;
    timings: Session["timings"];
  }
> {
  // Try to get sessionId from data first, then fall back to filename extraction
  const sessionIdFromData =
    typeof data.sessionId === "string" && data.sessionId.length > 0
      ? data.sessionId
      : null;
  const sessionId = sessionIdFromData ?? extractSessionId(filename);
  const source =
    typeof data.source === "string"
      ? data.source
      : (extractSource(filename) ?? "unknown");
  const responseStatus =
    typeof data.responseStatus === "number"
      ? data.responseStatus
      : Number(data.responseStatus) || 0;
  const responseIsStreaming =
    typeof data.responseIsStreaming === "boolean"
      ? data.responseIsStreaming
      : data.responseIsStreaming === true ||
        data.responseIsStreaming === "true";

  const rawTimings =
    data.timings && typeof data.timings === "object"
      ? (data.timings as Record<string, unknown>)
      : {};
  const timings = {
    total_ms:
      typeof rawTimings.total_ms === "number"
        ? rawTimings.total_ms
        : Number(rawTimings.total_ms) || 0,
  };

  const validatedTimestamp = validateCaptureTimestamp(data.timestamp);

  return {
    id: filename,
    sessionId: sessionId ?? "",
    source,
    provider: typeof data.provider === "string" ? data.provider : "unknown",
    apiFormat: typeof data.apiFormat === "string" ? data.apiFormat : "unknown",
    targetUrl: typeof data.targetUrl === "string" ? data.targetUrl : "",
    requestBody:
      typeof data.requestBody === "object" && data.requestBody !== null
        ? (data.requestBody as Record<string, unknown>)
        : {},
    responseBody:
      typeof data.responseBody === "string" ? data.responseBody : null,
    responseStatus,
    responseIsStreaming,
    timestamp: validatedTimestamp ?? new Date().toISOString(),
    timings,
  };
}
