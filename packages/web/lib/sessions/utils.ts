import { parseResponseUsage, estimateTokensFromText } from "@contextio/core";
import type { Session, Capture } from "@/types/api";
import { requestCacheStore } from "@/lib/request-cache";
// Import decryptCapture for reading encrypted capture files
import { decryptCapture } from "@contextio/logger";
// Re-export capture directory utilities
import { 
getCaptureDir, 
setCaptureDir, 
CAPTURE_DIR, 
resolveLogDir, 
applyLogDir, 
getNodeUtils, 
getHomedir, 
} from "../capture-dir";

export {
getCaptureDir,
setCaptureDir,
CAPTURE_DIR,
resolveLogDir,
applyLogDir,
getNodeUtils,
getHomedir,
};

// Re-export Session and Capture types for convenience
export type { Session, Capture } from "@/types/api";

/** Category of a capture read failure. */
export type CaptureReadErrorKind = "notFound" | "corrupt" | "unexpected";

/** Structured error thrown by `readCaptureFile` instead of returning `null`. */
export class CaptureReadError extends Error {
  readonly kind: CaptureReadErrorKind;

  constructor(kind: CaptureReadErrorKind, message: string, cause?: Error) {
    super(message, { cause });
    this.name = "CaptureReadError";
    this.kind = kind;
  }
}

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
  const { fs } = await getNodeUtils();
  try {
    const captureDir = await getCaptureDir();
    const files = await fs.readdir(captureDir);
    return files
      .filter((f) => isValidFilename(f) && !f.endsWith(".tmp") && !f.includes("redact-meta"))
      .sort();
  } catch {
    return [];
  }
}

/**
 * List redaction metadata files (*.redact-meta.json) from the capture directory.
 */
export async function listRedactionMetaFiles(): Promise<string[]> {
  const { fs } = await getNodeUtils();
  try {
    const captureDir = await getCaptureDir();
    const files = await fs.readdir(captureDir);
    return files
      .filter((f) => f.endsWith(".redact-meta.json"))
      .sort();
  } catch {
    return [];
  }
}

/**
 * Load redaction metadata from a metadata file.
 * Handles both encrypted and plaintext metadata files.
 */
export async function loadRedactionMeta(
  filename: string,
): Promise<{
  totalRedactions: number;
  byRule: Record<string, number>;
  sessionId: string | null;
  provider?: string;
  targetUrl?: string;
  timestamp?: string;
  generatedAt?: string;
  source?: string | null;
  matches?: Array<{
    ruleId: string;
    preValue: string;
    postValue: string;
    path: string;
  }>;
  // Added for sessions/metrics API performance - allows reading metadata instead of full captures
  requestBytes?: number;
  responseBytes?: number;
  timings?: {
    send_ms?: number;
    wait_ms?: number;
    receive_ms?: number;
    total_ms?: number;
  };
} | null> {
  const { fs, path } = await getNodeUtils();
  try {
    const captureDir = await getCaptureDir();
    const filepath = path.join(captureDir, filename);
    const raw = await fs.readFile(filepath, "utf8");

    // Check if the file is encrypted (has the encrypted payload structure)
    let meta: {
      totalRedactions?: number;
      byRule?: Record<string, number>;
      sessionId?: string;
      provider?: string;
      targetUrl?: string;
      timestamp?: string;
      generatedAt?: string;
      source?: string | null;
      matches?: Array<{
        ruleId: string;
        preValue: string;
        postValue: string;
        path: string;
      }>;
      requestBytes?: number;
      responseBytes?: number;
      timings?: {
        send_ms?: number;
        wait_ms?: number;
        receive_ms?: number;
        total_ms?: number;
      };
    } | null = null;
    try {
      const parsed = JSON.parse(raw) as Record<string, unknown>;
      const isEncrypted =
        typeof parsed.ciphertext === "string" &&
        typeof parsed.salt === "string" &&
        typeof parsed.iv === "string";

      if (isEncrypted) {
        // Decrypt using the same key as the logger plugin
        const keyMaterial = process.env.CONTEXTIO_LOGGER_ENCRYPTION_KEY;
        if (!keyMaterial) {
          console.error(
            "[loadRedactionMeta] Encryption enabled but CONTEXTIO_LOGGER_ENCRYPTION_KEY not set",
          );
          return null;
        }
        // Re-use the decrypt function from logger package
        const { decrypt } = await import("@contextio/logger");
        const plaintext = await decrypt(raw, keyMaterial);
        meta = JSON.parse(plaintext) as typeof meta;
      } else {
        meta = parsed;
      }
    } catch (e) {
      // If JSON parse fails or decryption fails, file is corrupted/unreadable
      console.error(
        `[loadRedactionMeta] Failed to parse metadata file ${filename}:`,
        e instanceof Error ? e.message : String(e),
      );
      return null;
    }

    if (!meta || typeof meta.totalRedactions !== "number") return null;
    if (!meta.byRule || typeof meta.byRule !== "object") return null;

    return {
      totalRedactions: meta.totalRedactions,
      byRule: meta.byRule as Record<string, number>,
      sessionId: typeof meta.sessionId === "string" ? meta.sessionId : null,
      provider: meta.provider,
      targetUrl: meta.targetUrl,
      timestamp: meta.timestamp,
      generatedAt: meta.generatedAt,
      source: meta.source,
      matches: meta.matches,
      requestBytes: meta.requestBytes,
      responseBytes: meta.responseBytes,
      timings: meta.timings,
    };
  } catch {
    return null;
  }
}

/**
 * Aggregate redaction counts from metadata files, grouped by sessionId.
 * Returns a map of sessionId -> { totalRedactions, byRule }.
 */
export async function aggregateRedactionMetaBySession(): Promise<
  Map<string, { totalRedactions: number; byRule: Record<string, number> }>
> {
  const metaFiles = await listRedactionMetaFiles();
  const sessionMap = new Map<
    string,
    { totalRedactions: number; byRule: Record<string, number> }
  >();

  for (const filename of metaFiles) {
    const meta = await loadRedactionMeta(filename);
    if (!meta || !meta.sessionId) continue;

    const existing = sessionMap.get(meta.sessionId) ?? {
      totalRedactions: 0,
      byRule: {},
    };
    existing.totalRedactions += meta.totalRedactions;
    for (const [rule, count] of Object.entries(meta.byRule)) {
      existing.byRule[rule] = (existing.byRule[rule] ?? 0) + count;
    }
    sessionMap.set(meta.sessionId, existing);
  }

  return sessionMap;
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
  // If we have a response body string, parse it for actual usage data
  if (typeof responseBody === "string" && responseBody.length > 0) {
    const parsed = parseResponseUsage(responseBody);
    const fallback = estimateTokensFromText(responseBody);

    if (parsed.inputTokens === 0 && parsed.outputTokens === 0) {
      return { input: fallback, output: fallback, model: parsed.model };
    }

    const input = parsed.inputTokens || fallback;
    const output = parsed.outputTokens || fallback;
    return { input, output, model: parsed.model };
  }

  // No response body string - estimate from request body if available
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

/**
 * Read and decrypt a capture file.
 * Dedupes within a single request via the ALS-backed capture cache.
 * Concurrent requests see isolated caches — no cross-request exposure.
 *
 * @param filepath - Path to the capture file
 * @param keyMaterial - Optional encryption key material. If not provided, attempts to read from CONTEXTIO_LOGGER_ENCRYPTION_KEY env var.
 * @returns Parsed capture data
 * @throws {Error} If called outside a `withRequestCache()` boundary (cached access requires isolated per-request state).
 * @throws {CaptureReadError} `kind: "notFound"` when the capture file does not exist or cannot be opened.
 * @throws {CaptureReadError} `kind: "corrupt"` when the file cannot be decrypted or parsed as valid capture JSON.
 * @throws {CaptureReadError} `kind: "unexpected"` for filesystem or decryption errors that do not fit the above categories.
 */
export async function readCaptureFile(
filepath: string,
keyMaterial?: string,
): Promise<Record<string, unknown>> {
  const resolvedKey =
    keyMaterial ?? process.env.CONTEXTIO_LOGGER_ENCRYPTION_KEY ?? "";
  const cacheKey = `${filepath}@${resolvedKey}`;

  const store = requestCacheStore.getStore();
  if (!store) {
    throw new Error(
      "readCaptureFile() called outside of request context — " +
        "wrap the caller in `withRequestCache(() => ...)` " +
        "(see `@/lib/request-cache`).",
    );
  }

  const current = store.captureCache;
  if (current.has(cacheKey)) {
    return current.get(cacheKey) as Record<string, unknown>;
  }

  let result: Record<string, unknown> | null = null;
  try {
    const capture = await decryptCapture(filepath, resolvedKey || null);
    result = capture as Record<string, unknown> | null;
  } catch (error) {
    console.error(`Error reading capture file ${filepath}:`, error);
    throw new CaptureReadError(
      "unexpected",
      `Capture file could not be read: ${filepath}`,
      error instanceof Error ? error : undefined,
    );
  }

  if (result) {
    current.set(cacheKey, result);
    return result;
  }

  throw new CaptureReadError(
    "corrupt",
    `Capture file is empty, unreadable, or could not be decrypted: ${filepath}`,
  );
}

/**
 * Extract redaction matches from capture data.
 * Returns array of matches with rule, original value, placeholder, and path.
 */
export function extractRedactionMatches(
  capture: Record<string, unknown>
): Array<{ rule: string; original: string; placeholder: string; path: string }> {
  const matches: Array<{ rule: string; original: string; placeholder: string; path: string }> = [];

  // Helper to extract matches from a string value
  function extractFromString(text: string, path: string): void {
    const PLACEHOLDER_REGEX = /\[([A-Z][A-Z0-9_]*)_REDACTED\]/g;
    const SSN_REGEX = /\b\d{3}-\d{2}-\d{4}\b/g;
    
    PLACEHOLDER_REGEX.lastIndex = 0;
    let m: RegExpExecArray | null;
    while ((m = PLACEHOLDER_REGEX.exec(text)) !== null) {
      const rule = (m[1] ?? "unknown").toLowerCase();
      const placeholder = m[0];
      matches.push({ rule, original: text, placeholder, path });
    }
    SSN_REGEX.lastIndex = 0;
    while ((m = SSN_REGEX.exec(text)) !== null) {
      matches.push({ rule: "ssn", original: text, placeholder: m[0], path });
    }
  }

  // Recursively collect all string values with their paths
  function collectStringsWithPath(value: unknown, path: string): void {
    if (typeof value === "string") {
      extractFromString(value, path);
    } else if (Array.isArray(value)) {
      value.forEach((item, index) => collectStringsWithPath(item, `${path}[${index}]`));
    } else if (value !== null && typeof value === "object") {
      for (const [key, val] of Object.entries(value as Record<string, unknown>)) {
        collectStringsWithPath(val, `${path}.${key}`);
      }
    }
  }

  // Extract from request body and response body
  const captureData = capture as Record<string, unknown>;
  if (captureData?.requestBody) {
    collectStringsWithPath(captureData.requestBody, "requestBody");
  }
  if (captureData?.responseBody && typeof captureData.responseBody === "string") {
    extractFromString(captureData.responseBody, "responseBody");
  } else if (captureData?.responseBody) {
    collectStringsWithPath(captureData.responseBody, "responseBody");
  }

  return matches;
}

/**
 * Read and decrypt a redaction metadata file (.redact-meta.json).
 * Handles both encrypted and plaintext meta files transparently.
 * 
 * @param filepath - Path to the .redact-meta.json file
 * @param keyMaterial - Optional encryption key material. If not provided, attempts to read from CONTEXTIO_LOGGER_ENCRYPTION_KEY env var.
 * @returns Parsed metadata, or null if file cannot be read/decrypted
 */
export async function readRedactionMetaFile(
  filepath: string,
  keyMaterial?: string
): Promise<Record<string, unknown> | null> {
  const resolvedKey = keyMaterial ?? process.env.CONTEXTIO_LOGGER_ENCRYPTION_KEY ?? "";
  try {
    const capture = await decryptCapture(filepath, resolvedKey || null);
    return capture as Record<string, unknown> | null;
  } catch (error) {
    console.error(`Error reading redaction meta file ${filepath}:`, error);
    return null;
  }
}
