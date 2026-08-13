/**
 * Background filesystem watcher for capture redaction metadata.
 *
 * Monitors CAPTURE_DIR for new or modified capture files using fs.watch
 * (with debounce + random jitter). On each settled change, reads the
 * capture JSON, invokes the redaction-utils computation, and persists
 * metadata directly to SQLite via the persistToSqlite callback.
 *
 * Design guarantees:
 * - The watcher runs asynchronously and never blocks the proxy's request
 *   / response path.
 * - Rapid sequential writes are batched with a debounce window plus a
 *   small random jitter so that bursts of captures produce at most one
 *   metadata computation per debounce window.
 * - Errors are contained to the watcher loop; a bad capture file is
 *   skipped and logged but never propagates to the proxy caller.
 */

import fs from "node:fs";
import { stat, readdir, readFile, mkdir } from "node:fs/promises";
import { join } from "node:path";
import { parseResponseUsage, estimateTokensFromText } from "@contextio/core";
import { decrypt } from "@contextio/logger";
import {
	upsertRedactionMetadata,
	type RedactionMetadata,
} from "@contextio/core/db";


// ---------------------------------------------------------------------------
// Configuration
// ---------------------------------------------------------------------------

/** Freshness window in ms. All events inside this window are coalesced. */
export const REDACTION_META_DEBOUNCE_MS = 2_000;
/** Upper bound of random jitter appended to each debounce window (ms). */
export const REDACTION_META_JITTER_MS = 500;


// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

export interface RedactionMetaWatcherOptions {
  /** Directory containing capture JSON files. */
  captureDir: string;
  /**
   * Required callback to persist redaction metadata to SQLite.
   * The watcher will compute metadata and call this callback for each capture.
   */
  persistToSqlite: (metadata: RedactionMetadata) => void;
  /**
   * Optional encryption key for decrypting encrypted capture files.
   * When captures are encrypted at rest, provide the same key material
   * used by the logger plugin so the watcher can extract request/response
   * byte counts and other fields from the plaintext.
   */
  encryptionKey?: string;
}

export interface RedactionMatch {
  ruleId: string;
  original: string;
  placeholder: string;
  path: string;
}

export interface CaptureRedactionMetadata {
  captureId: string;
  totalRedactions: number;
  byRule: Record<string, number>;
  generatedAt: string;
  source?: string;
  provider?: string;
  targetUrl?: string;
  sessionId?: string;
  timestamp?: string;
  checksum?: string;
  schemaVersion?: string;
  matches?: Array<RedactionMatch>;
  // Added for sessions/metrics API performance - allows reading metadata instead of full captures
  requestBytes?: number;
  responseBytes?: number;
  timings?: {
    send_ms?: number;
    wait_ms?: number;
    receive_ms?: number;
    total_ms?: number;
  };
  // Token metrics
  totalInputTokens?: number;
  totalOutputTokens?: number;
  tokensPerSecond?: number;
  successCount?: number;
  errorCount?: number;
  model?: string | null;
}

export interface RedactionMetaWatcher {
  /** Stop watching and clear all pending timers. */
  stop(): void;
}


// ---------------------------------------------------------------------------
// Local redaction counting.
// ---------------------------------------------------------------------------

const PLACEHOLDER_REGEX = /\[([A-Z][A-Z0-9_]*)_REDACTED\]/g;
const SSN_REGEX = /\b\d{3}-\d{2}-\d{4}\b/g;

/**
 * Validate that the matches array in a meta file has the expected format.
 * Accepts two legacy/concurrent shapes:
 *  - Watcher/backfill: { ruleId, original, placeholder, path }
 *  - Redact plugin:  { ruleId, preValue, postValue, path }
 * Returns true if valid, false if invalid or missing.
 */
function isValidMatchesFormat(matches: unknown): boolean {
  if (!Array.isArray(matches)) return false;
  for (const match of matches) {
    const rec = match as Record<string, unknown>;
    const hasRuleId = typeof rec.ruleId === "string";
    const hasOriginalPlaceholder =
      typeof rec.original === "string" && typeof rec.placeholder === "string";
    const hasPrePost =
      typeof rec.preValue === "string" && typeof rec.postValue === "string";
    const hasPath = typeof rec.path === "string";
    if (!hasRuleId || !hasPath || (!hasOriginalPlaceholder && !hasPrePost)) {
      return false;
    }
  }
  return true;
}

/** Recursively collect every string leaf value from an arbitrary value. */
function collectStrings(value: unknown, out: string[]): void {
  if (typeof value === "string") {
    out.push(value);
  } else if (Array.isArray(value)) {
    for (const item of value) collectStrings(item, out);
  } else if (value !== null && typeof value === "object") {
    for (const item of Object.values(value)) collectStrings(item, out);
  }
}

interface RawRedactionStats {
  totalRedactions?: unknown;
  byRule?: unknown;
}

/**
 * Lightweight extractor for redaction matches, recording only rule and JSON path.
 * Used to populate the metadata with minimal match information.
 */
function extractRedactionMatches(rawData: unknown): Array<RedactionMatch> {
  const rawCapture = (rawData ?? null) as Record<string, unknown> | null;
  const matches: Array<RedactionMatch> = [];

  // Helper to extract matches from a string value
  function extractFromString(text: string, path: string): void {
    PLACEHOLDER_REGEX.lastIndex = 0;
    let m: RegExpExecArray | null;
  while ((m = PLACEHOLDER_REGEX.exec(text)) !== null) {
    const ruleId = (m[1] ?? "unknown").toLowerCase();
    matches.push({
      ruleId,
      original: text,
      placeholder: m[0],
      path,
    });
  }
  SSN_REGEX.lastIndex = 0;
  while ((m = SSN_REGEX.exec(text)) !== null) {
    matches.push({
      ruleId: "ssn",
      original: text,
      placeholder: m[0],
      path,
    });
  }
  }

  // Collect all string values and their paths
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
  if (rawCapture?.requestBody) {
    collectStringsWithPath(rawCapture.requestBody, "requestBody");
  }
  if (typeof rawCapture?.responseBody === "string") {
    extractFromString(rawCapture.responseBody, "responseBody");
  } else if (rawCapture?.responseBody) {
    collectStringsWithPath(rawCapture.responseBody, "responseBody");
  }

  return matches;
}

/**
 * Derive redaction counts for a capture.
 *
 * Prefers the persisted redactionStats field when present (matching the web
 * API's source of truth), otherwise falls back to scanning the request body
 * for redacted placeholders and SSNs.
 */
function computeCaptureRedactionCounts(rawData: unknown): {
  totalRedactions: number;
  byRule: Record<string, number>;
} {
  const rawCapture = (rawData ?? null) as Record<string, unknown> | null;
  const stats = rawCapture?.redactionStats as RawRedactionStats | undefined;
  if (stats && typeof stats.byRule === "object" && stats.byRule !== null) {
    const statsObj = stats as Record<string, unknown>;
    const total =
      typeof stats.totalRedactions === "number"
        ? stats.totalRedactions
        : typeof statsObj.total === "number"
          ? statsObj.total
          : undefined;
    if (typeof total === "number") {
      const byRule: Record<string, number> = {};
      for (const [rule, count] of Object.entries(
        stats.byRule as Record<string, unknown>,
      )) {
        const n = typeof count === "number" ? count : Number(count);
        if (Number.isFinite(n)) byRule[rule] = n;
      }
      return { totalRedactions: total, byRule };
    }
  }

  const strings: string[] = [];
  collectStrings(rawCapture?.requestBody ?? null, strings);
  collectStrings(rawCapture?.responseBody ?? null, strings);
  const byRule: Record<string, number> = {};
  let total = 0;
  for (const text of strings) {
    PLACEHOLDER_REGEX.lastIndex = 0;
    let m: RegExpExecArray | null;
    while ((m = PLACEHOLDER_REGEX.exec(text)) !== null) {
      const rule = (m[1] ?? "unknown").toLowerCase();
      byRule[rule] = (byRule[rule] ?? 0) + 1;
      total++;
    }
    SSN_REGEX.lastIndex = 0;
    while ((m = SSN_REGEX.exec(text)) !== null) {
      byRule["ssn"] = (byRule["ssn"] ?? 0) + 1;
      total++;
    }
  }
  return { totalRedactions: total, byRule };
}

function computeCaptureMeta(captureId: string, rawData: unknown): CaptureRedactionMetadata | null {
  try {
    const counts = computeCaptureRedactionCounts(rawData);
    const rawCapture = (rawData ?? null) as Record<string, unknown> | null;
    const rawTimings =
      rawCapture?.timings && typeof rawCapture.timings === "object"
        ? (rawCapture.timings as Record<string, unknown>)
        : {};

    // Compute token metrics from response body
    let totalInputTokens = 0;
    let totalOutputTokens = 0;
    let tokensPerSecond = 0;
    let model: string | null = null;
    let successCount = 0;
    let errorCount = 0;

    const responseBody = typeof rawCapture?.responseBody === "string" ? rawCapture.responseBody : undefined;
    const requestBody = rawCapture?.requestBody;
    const responseStatus = typeof rawCapture?.responseStatus === "number" ? rawCapture.responseStatus : 0;
    const totalMs = typeof rawTimings.total_ms === "number" ? rawTimings.total_ms : 0;

    // Determine success/error count based on response status
    const isSuccess = responseStatus >= 200 && responseStatus < 300;
    successCount = isSuccess ? 1 : 0;
    errorCount = isSuccess ? 0 : 1;

    // Parse response for token usage (mirrors web package computeTokenUsage logic)
    if (typeof responseBody === "string" && responseBody.length > 0) {
      const parsed = parseResponseUsage(responseBody);
      const fallback = estimateTokensFromText(responseBody);

      if (parsed.inputTokens === 0 && parsed.outputTokens === 0) {
        totalInputTokens = fallback;
        totalOutputTokens = fallback;
        model = parsed.model;
      } else {
        totalInputTokens = parsed.inputTokens || fallback;
        totalOutputTokens = parsed.outputTokens || fallback;
        model = parsed.model;
      }
    } else if (requestBody) {
      // No response body - estimate from request body
      const requestText = JSON.stringify(requestBody);
      totalInputTokens = estimateTokensFromText(requestText);
      totalOutputTokens = 0;
      model = null;
    }

    // Compute tokens per second (output tokens / total time in seconds)
    const timeSec = totalMs > 0 ? totalMs / 1000 : 0;
    tokensPerSecond = timeSec > 0 ? totalOutputTokens / timeSec : 0;

    return {
      captureId,
      totalRedactions: counts.totalRedactions,
      byRule: counts.byRule,
      generatedAt: new Date().toISOString(),
      // Include matches from redact plugin if available (we can extract from rawData if present)
      matches: extractRedactionMatches(rawData),
      source: (rawCapture?.source as string) ?? undefined,
      provider: (rawCapture?.provider as string) ?? "unknown",
      targetUrl: (rawCapture?.targetUrl as string) ?? "",
      sessionId: (rawCapture?.sessionId as string) ?? undefined,
      timestamp: (rawCapture?.timestamp as string) ?? undefined,
      checksum: (rawCapture?.checksum as string) ?? undefined,
      schemaVersion: (rawCapture?.schemaVersion as string) ?? undefined,
      // Include byte counts and timings for sessions/metrics API performance
      requestBytes: typeof rawCapture?.requestBytes === "number" ? rawCapture.requestBytes : undefined,
      responseBytes: typeof rawCapture?.responseBytes === "number" ? rawCapture.responseBytes : undefined,
      timings: {
        send_ms: typeof rawTimings.send_ms === "number" ? rawTimings.send_ms : undefined,
        wait_ms: typeof rawTimings.wait_ms === "number" ? rawTimings.wait_ms : undefined,
        receive_ms: typeof rawTimings.receive_ms === "number" ? rawTimings.receive_ms : undefined,
        total_ms: typeof rawTimings.total_ms === "number" ? rawTimings.total_ms : undefined,
      },
      // Token metrics
      totalInputTokens,
      totalOutputTokens,
      tokensPerSecond: Number(tokensPerSecond.toFixed(2)),
      successCount,
      errorCount,
      model,
    };
  } catch (err) {
    console.error(
      `[redaction-meta-watcher] Failed to compute metadata for ${captureId}:`,
      err instanceof Error ? err.message : String(err),
    );
    return null;
  }
}

// ---------------------------------------------------------------------------
// Main watcher factory
// ---------------------------------------------------------------------------

/**
 * Start a background watcher over `captureDir`.
 *
 * The watcher never blocks the caller. It is the caller's responsibility to
 * invoke `.stop()` before the process exits so that the fs.watch handle
 * is released cleanly.
 */
export function createRedactionMetaWatcher(
  opts: RedactionMetaWatcherOptions,
): RedactionMetaWatcher {
  const dir = opts.captureDir;
  const pending = new Map<
    string,
    { metadata: CaptureRedactionMetadata; timer: NodeJS.Timeout }
  >();
  let stopped = false;
  let watcher: fs.FSWatcher | null = null;

  const flush = async (captureFilename: string): Promise<void> => {
    const state = pending.get(captureFilename);
    if (!state) return;

    pending.delete(captureFilename);
    clearTimeout(state.timer);

    const metadata = state.metadata;

    try {
      // Persist to SQLite directly (no sidecar file)
      const sqliteMetadata: RedactionMetadata = {
        captureId: metadata.captureId,
        sessionId: metadata.sessionId ?? null,
        ruleCounts: metadata.byRule,
        totalRedactions: metadata.totalRedactions,
        encrypted: false, // SQLite doesn't use file encryption
        createdAt: new Date(metadata.generatedAt).getTime(),
        updatedAt: Date.now(),
        source: metadata.source ?? null,
        provider: metadata.provider ?? null,
        targetUrl: metadata.targetUrl ?? null,
        requestBytes: metadata.requestBytes,
        responseBytes: metadata.responseBytes,
        timings: metadata.timings,
        totalInputTokens: metadata.totalInputTokens,
        totalOutputTokens: metadata.totalOutputTokens,
        tokensPerSecond: metadata.tokensPerSecond,
        successCount: metadata.successCount,
        errorCount: metadata.errorCount,
        model: metadata.model,
	        // Convert watcher's match format (original/placeholder) to DB format (preValue/postValue)
	        matches: metadata.matches?.map((m) => ({
	          ruleId: m.ruleId,
	          preValue: m.original,
	          postValue: m.placeholder,
	          path: m.path,
	        })),
	      };
      opts.persistToSqlite(sqliteMetadata);
    } catch (err) {
      console.error(
        `[redaction-meta-watcher] Failed to persist to SQLite for ${captureFilename}:`,
        err instanceof Error ? err.message : String(err),
      );
      // Re-schedule so transient errors do not permanently suppress a valid capture.
      schedule(captureFilename, state.metadata);
    }
  };

  const schedule = (
    captureFilename: string,
    metadata: CaptureRedactionMetadata,
  ): void => {
    if (stopped) return;
    // Cancel any existing timer for the same file (batching).
    const existing = pending.get(captureFilename);
    if (existing) {
      clearTimeout(existing.timer);
      existing.metadata = metadata;
      pending.set(captureFilename, existing);
      return;
    }
    const jitterMs = Math.round(Math.random() * REDACTION_META_JITTER_MS);
    const timer = setTimeout(() => {
      void flush(captureFilename);
    }, REDACTION_META_DEBOUNCE_MS + jitterMs);
    pending.set(captureFilename, { metadata, timer });
  };

  const processCaptureFile = async (captureFilename: string): Promise<void> => {
    const path = join(dir, captureFilename);

    // Guard: only process regular files, skip metadata files and tmp files.
    if (
      !captureFilename.endsWith(".json") ||
      captureFilename.endsWith(".tmp") ||
      captureFilename.includes("redact-meta")
    ) {
      return;
    }
    if (!isValidFilename(captureFilename)) return;

    try {
      // Stat to avoid reading files that vanished between the fs.watch
      // event and our handler.
      let fileStats: fs.Stats;
      try {
        fileStats = await stat(path);
      } catch {
        // File was deleted; drop any pending work for it.
        pending.delete(captureFilename);
        return;
      }

      const MAX_FILE_SIZE = 25 * 1024 * 1024;
      if (fileStats.size > MAX_FILE_SIZE) return;

      const rawBytes = await readFile(path, "utf8");
      let rawData: unknown;
      try {
        rawData = JSON.parse(rawBytes);
      } catch {
        // Could not parse JSON, skip
        return;
      }

      // If the capture is encrypted at rest, decrypt it before extracting
      // metadata so requestBytes/responseBytes and other fields are available.
      const encryptedEnvelope = rawData as Record<string, unknown> | null;
      const isEncrypted =
        !!encryptedEnvelope &&
        typeof encryptedEnvelope.ciphertext === "string" &&
        typeof encryptedEnvelope.salt === "string" &&
        typeof encryptedEnvelope.iv === "string";

      if (isEncrypted) {
        if (!opts.encryptionKey) {
          console.warn(
            `[redaction-meta-watcher] Skipping encrypted capture ${captureFilename}: no encryption key provided`,
          );
          return;
        }
        try {
          const plaintext = await decrypt(
            rawBytes,
            opts.encryptionKey,
          );
          rawData = JSON.parse(plaintext);
        } catch (err) {
          console.warn(
            `[redaction-meta-watcher] Failed to decrypt capture ${captureFilename}:`,
            err instanceof Error ? err.message : String(err),
          );
          return;
        }
      }

      const captureId = captureFilename.replace(/\.json$/, "");
      const metadata = computeCaptureMeta(captureId, rawData);

      if (metadata) {
        schedule(captureFilename, metadata);
      }
    } catch (err) {
      console.error(
        `[redaction-meta-watcher] Error processing ${captureFilename}:`,
        err instanceof Error ? err.message : String(err),
      );
    }
  };

  async function scanExistingCaptures(): Promise<void> {
    console.log("[redaction-meta-watcher] Scanning existing capture files...");
    try {
      const entries = await readdir(dir);
      const captureFiles = entries.filter(
        (f) =>
          f.endsWith(".json") &&
          !f.endsWith(".tmp") &&
          !f.includes("redact-meta") &&
          isValidFilename(f),
      );

      let processed = 0;
      for (const filename of captureFiles) {
        // Process all capture files - we no longer check for .redact-meta.json sidecars
        await processCaptureFile(filename);
        processed++;
      }
      console.log(
        `[redaction-meta-watcher] Scanned ${captureFiles.length} existing captures, processed ${processed} for SQLite metadata`,
      );
    } catch (err) {
      console.error(
        "[redaction-meta-watcher] Error scanning existing captures:",
        err instanceof Error ? err.message : String(err),
      );
    }
  }

  const handleChange = async (
    eventType: "rename" | "change",
    filename: string | null,
  ): Promise<void> => {
    if (!filename) return;
    await processCaptureFile(filename);
  };

  const startWatcher = (): void => {
    if (stopped) return;
    console.log("[redaction-meta-watcher] Starting watcher on:", dir);

    // Scan existing capture files on startup to process any that don't have SQLite metadata
    scanExistingCaptures().catch((err) => {
      console.error(
        "[redaction-meta-watcher] Failed to scan existing captures:",
        err instanceof Error ? err.message : String(err),
      );
    });

    watcher = fs.watch(dir, { persistent: false }, (eventType, filename) => {
      if (eventType === "rename" || eventType === "change") {
        const name = filename ?? "";
        void handleChange(eventType, name);
      }
    });

    watcher.on("error", (err: Error) => {
      console.error(
        "[redaction-meta-watcher] fs.watch error, attempting restart in 5s:",
        err.message,
      );
      try {
        watcher?.close();
      } catch {
        // ignore close errors during restart
      }
      if (!stopped) {
        setTimeout(startWatcher, 5_000);
      }
    });
  };

  // Ensure the capture directory exists before starting.
  void mkdir(dir, { recursive: true })
    .then(startWatcher)
    .catch((err: unknown) => {
      console.error(
        "[redaction-meta-watcher] Failed to create capture directory:",
        err instanceof Error ? err.message : String(err),
      );
    });

  return {
    stop() {
      stopped = true;
      // Cancel pending timers.
      for (const [, state] of pending) {
        clearTimeout(state.timer);
      }
      pending.clear();
      try {
        watcher?.close();
      } catch {
        // ignore close errors during shutdown
      }
    },
  };
}

// ---------------------------------------------------------------------------
// Filename validation mirrors the web package's isValidFilename so the
// watcher's surface area stays consistent.
// ---------------------------------------------------------------------------

/**
 * Validate filename to prevent path traversal attacks.
 *
 * Same contract as `packages/web/lib/sessions/utils.ts::isValidFilename`.
 */
function isValidFilename(filename: string): boolean {
  if (!filename || filename.length === 0) return false;
  if (filename.length > 255) return false;
  if (filename.startsWith(".")) return false;
  if (
    filename.includes("..") ||
    filename.includes("/") ||
    filename.includes("\\")
  ) {
    return false;
  }
  const validPattern = /^[a-zA-Z0-9_-]+\.json$/;
  return validPattern.test(filename);
}