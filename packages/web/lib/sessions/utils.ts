import fs from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";

import type { Session, Capture } from "@/types/api";

// Re-export Session and Capture types for convenience
export type { Session, Capture } from "@/types/api";

// Allow override via environment variable (used in Docker environments)
// Falls back to default ~/.contextio/captures for local development
export const CAPTURE_DIR = process.env.LOGGER_CAPTURE_DIR || join(homedir(), ".contextio", "captures");
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
 * List capture files from the capture directory.
 */
export async function listCaptureFiles(): Promise<string[]> {
  try {
    const files = await fs.readdir(CAPTURE_DIR);
    return files
      .filter((f) => isValidFilename(f) && !f.endsWith(".tmp"))
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

  const rawTimings =
    data.timings && typeof data.timings === "object"
      ? (data.timings as Record<string, unknown>)
      : {};

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
    responseIsStreaming:
      typeof data.responseIsStreaming === "boolean"
        ? data.responseIsStreaming
        : data.responseIsStreaming === true || data.responseIsStreaming === "true",
    timestamp: typeof data.timestamp === "string" ? data.timestamp : new Date().toISOString(),
    timings: {
      send_ms: getNumber(rawTimings, "send_ms"),
      wait_ms: getNumber(rawTimings, "wait_ms"),
      receive_ms: getNumber(rawTimings, "receive_ms"),
      total_ms: getNumber(rawTimings, "total_ms"),
    },
  };
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
 * Extract token usage counts from a parsed LLM response body.
 */
export function computeTokenUsage(
  responseBody: string | null | undefined,
): { input: number; output: number } {
  let input = 0;
  let output = 0;

  if (responseBody) {
    try {
      const parsed = JSON.parse(responseBody);
      if (parsed.usage?.prompt_tokens) {
        input += parsed.usage.prompt_tokens;
      }
      if (parsed.usage?.completion_tokens) {
        output += parsed.usage.completion_tokens;
      }
    } catch {
      /* ignore */
    }
  }

  return { input, output };
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
