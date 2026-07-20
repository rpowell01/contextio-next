/**
 * Background filesystem watcher for capture redaction metadata.
 *
 * Monitors CAPTURE_DIR for new or modified capture files using fs.watch
 * (with debounce + random jitter). On each settled change, reads the
 * capture JSON, invokes the redaction-utils computation, and writes the
 * `{captureId}.redact-meta.json` metadata file atomically.
 *
 * Design guarantees:
 * - The watcher runs asynchronously and never blocks the proxy's request
 *   / response path.
 * - Rapid sequential writes are batched with a debounce window plus a
 *   small random jitter so that bursts of captures produce at most one
 *   filesystem scan per debounce window.
 * - Metadata writes are atomic: they land in a `.tmp` sibling and are
 *   renamed into place, preventing torn reads.
 * - Errors are contained to the watcher loop; a bad capture file is
 *   skipped and logged but never propagates to the proxy caller.
 */

import fs from "node:fs";
import { stat, readdir, readFile, writeFile, rename, unlink, mkdir } from "node:fs/promises";
import { join } from "node:path";
import type { EncryptionAtRestConfig } from "@contextio/core";
import { encrypt, decrypt } from "@contextio/logger";



// ---------------------------------------------------------------------------
// Configuration
// ---------------------------------------------------------------------------

/** Freshness window in ms. All events inside this window are coalesced. */
export const REDACTION_META_DEBOUNCE_MS = 2_000;
/** Upper bound of random jitter appended to each debounce window (ms). */
export const REDACTION_META_JITTER_MS = 500;
/** Maximum time a .tmp file may exist before it is considered stale (ms). */
export const REDACTION_META_TMP_MAX_AGE_MS = 30_000;

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/**
 * Attempt to decrypt capture data if it's encrypted.
 * Returns the decrypted data if successful, or the original data if not encrypted.
 * Returns null if decryption fails (wrong key, corrupt data, etc.).
 */
async function maybeDecryptCapture(
  rawBytes: string,
  encryption?: EncryptionAtRestConfig,
): Promise<unknown> {
  if (!encryption) {
    // No encryption config, assume plaintext
    try {
      return JSON.parse(rawBytes);
    } catch {
      return null;
    }
  }

  // Resolve key material the same way the logger plugin does
  let keyMaterial: string | undefined;
  switch (encryption.keyProvider) {
    case "static":
      keyMaterial = encryption.staticKey;
      break;
    case "env":
    default:
      keyMaterial = process.env[encryption.keyEnvVar ?? "CONTEXTIO_LOGGER_ENCRYPTION_KEY"];
      break;
    case "kms":
      throw new Error("[redaction-meta-watcher] KMS key provider not yet implemented");
  }
  if (!keyMaterial) {
    // No key material available, can't decrypt
    return null;
  }

  try {
    // Parse the raw bytes first to check if it's an encrypted envelope
    const parsed = JSON.parse(rawBytes);
    const isEncrypted =
      typeof parsed.ciphertext === "string" &&
      typeof parsed.salt === "string" &&
      typeof parsed.iv === "string";

    if (!isEncrypted) {
      // Not encrypted, return as-is
      return parsed;
    }

    // Decrypt the encrypted payload
    const decrypted = await decrypt(rawBytes, keyMaterial);
    return JSON.parse(decrypted);
  } catch {
    // Decryption failed (wrong key, corrupt data, etc.)
    return null;
  }
}

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

export interface RedactionMetaWatcherOptions {
  /** Directory containing capture JSON files. */
  captureDir: string;
  /**
   * Optional in-process function called when metadata is ready.
   *
   * When omitted the watcher still writes `.redact-meta.json` files to
   * disk so that the web UI can discover them without a live callback.
   */
  onMetadataReady?: (metadata: CaptureRedactionMetadata) => void;
  /**
   * Optional encryption configuration for encrypting metadata files.
   * When provided, metadata files will be encrypted with AES-256-GCM
   * using the same key derivation as capture files.
   */
  encryption?: EncryptionAtRestConfig;
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
}

export interface RedactionMetaWatcher {
  /** Stop watching and clear all pending timers. */
  stop(): void;
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/**
 * Derive metadata file path: `<name>.redact-meta.json`.
 *
 * If the input filename ends in `.json`, the metadata filename replaces
 * that suffix. Otherwise `.redact-meta.json` is appended.
 */
function metaFilenameFor(captureFilename: string): string {
  const base = captureFilename.endsWith(".json")
    ? captureFilename.slice(0, -".json".length)
    : captureFilename;
  return `${base}.redact-meta.json`;
}

/**
 * Write the metadata file atomically by staging to a `.tmp` sibling and
 * renaming. `rename` is atomic on POSIX systems when source and target
 * reside on the same filesystem.
 */
async function atomicWriteMetadata(
  targetPath: string,
  metadata: CaptureRedactionMetadata,
  encryption?: EncryptionAtRestConfig,
): Promise<void> {
  const tmpPath = `${targetPath}.tmp-${Date.now()}-${Math.random()
    .toString(36)
    .slice(2, 8)}`;

  let content: string;
  if (encryption?.enabled) {
    // Resolve key material the same way the logger plugin does
    let keyMaterial: string | undefined;
    switch (encryption.keyProvider) {
      case "static":
        keyMaterial = encryption.staticKey;
        break;
      case "env":
      default:
        keyMaterial = process.env[encryption.keyEnvVar ?? "CONTEXTIO_LOGGER_ENCRYPTION_KEY"];
        break;
      case "kms":
        throw new Error("[redaction-meta-watcher] KMS key provider not yet implemented");
    }
    if (!keyMaterial) {
      throw new Error("[redaction-meta-watcher] Encryption enabled but no key material resolved");
    }
    const encrypted = await encrypt(JSON.stringify(metadata), keyMaterial);
    content = JSON.stringify(encrypted);
  } else {
    content = JSON.stringify(metadata, null, 2);
  }

  await writeFile(
    tmpPath,
    content,
    "utf8",
  );

  // Retry rename once on EBUSY/EPERM/EEXIST (rare but possible under
  // concurrent writes on Windows or NFS mounts).
  const maxAttempts = 2;
  for (let attempt = 0; ; attempt++) {
    try {
      await rename(tmpPath, targetPath);
      return;
    } catch (err: unknown) {
      const code = (err as NodeJS.ErrnoException)?.code;
      if (attempt >= maxAttempts - 1 || !["EBUSY", "EPERM", "EEXIST"].includes(code ?? "")) {
        // Remove stale tmp if it still exists and re-throw.
        await unlink(tmpPath).catch(() => undefined);
        throw err;
      }
      await new Promise((r) => setTimeout(r, 100));
    }
  }
}

/**
 * Safely purge stale `.tmp-*` files older than `TMP_MAX_AGE_MS` that
 * may be left behind after a process crash.
 */
async function reapStaleTmpFiles(dir: string): Promise<void> {
 try {
 const entries = await readdir(dir);
    const threshold = Date.now() - REDACTION_META_TMP_MAX_AGE_MS;
    for (const entry of entries) {
      if (!entry.includes(".tmp-")) continue;
      const path = join(dir, entry);
      try {
        const s = await stat(path);
        if (s.mtimeMs < threshold) {
          await unlink(path);
        }
      } catch {
        // ignore unreadable entries
      }
    }
  } catch {
    // ignore read errors (dir may not exist yet)
  }
}

// ---------------------------------------------------------------------------
// Local redaction counting. The proxy previously called require("@contextio/web")
// at runtime, but the proxy is built as an ES module (type: "module") where
// require is undefined, and @contextio/web has no consumable entry point.
// Counts are computed locally instead: prefer the capture's persisted
// redactionStats (written by the redact plugin) and otherwise scan the
// request body for [RULE_REDACTED] placeholders and SSNs. This keeps the
// proxy free of a build/runtime dependency on the web package.
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
 * Used to populate the metadata file with minimal match information.
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
  return {
    captureId,
    totalRedactions: counts.totalRedactions,
    byRule: counts.byRule,
    generatedAt: new Date().toISOString(),
    // Omit matches - they will be preserved from redact plugin's meta file via mergeExistingMetadata
    // Watcher's extractRedactionMatches uses placeholder extraction which gives wrong ruleIds
    source: (rawCapture?.source as string) ?? undefined,
    provider: (rawCapture?.provider as string) ?? "unknown",
    targetUrl: (rawCapture?.targetUrl as string) ?? "",
    sessionId: (rawCapture?.sessionId as string) ?? undefined,
    timestamp: (rawCapture?.timestamp as string) ?? undefined,
    checksum: (rawCapture?.checksum as string) ?? undefined,
    schemaVersion: (rawCapture?.schemaVersion as string) ?? undefined,
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
    { metadata: CaptureRedactionMetadata | null; timer: NodeJS.Timeout }
  >();
  let stopped = false;
  let watcher: fs.FSWatcher | null = null;

  const flushStaleTmp = async (): Promise<void> => {
    await reapStaleTmpFiles(dir);
  };

async function mergeExistingMetadata(
  metaPath: string,
  computed: CaptureRedactionMetadata,
): Promise<CaptureRedactionMetadata> {
  try {
    const raw = await readFile(metaPath, "utf8");
    const existing = JSON.parse(raw) as Partial<CaptureRedactionMetadata>;
    if (typeof existing !== "object" || existing === null || Array.isArray(existing)) return computed;

    const enriched: CaptureRedactionMetadata = { ...computed };

    // Prefer existing byRule from redact plugin (correct preset rule names like "credential_generic")
    // over watcher-computed byRule (extracted from placeholders like "[SECRET_REDACTED]" -> "secret")
    if (existing.byRule && typeof existing.byRule === "object" && !Array.isArray(existing.byRule)) {
      enriched.byRule = existing.byRule as Record<string, number>;
    }

    // Prefer existing matches from redact plugin (they have correct ruleIds from presets)
    // over watcher-computed matches (which extract ruleIds from placeholders with different naming)
    // Always preserve existing matches if they exist - the API handles multiple formats
    if (Array.isArray(existing.matches) && existing.matches.length > 0) {
      enriched.matches = existing.matches;
    }

    if (!enriched.checksum && typeof existing.checksum === "string") {
      enriched.checksum = existing.checksum;
    }

    if (!enriched.provider && typeof existing.provider === "string") {
      enriched.provider = existing.provider;
    }

    if (!enriched.targetUrl && typeof existing.targetUrl === "string") {
      enriched.targetUrl = existing.targetUrl;
    }

    if (!enriched.schemaVersion && typeof existing.schemaVersion === "string") {
      enriched.schemaVersion = existing.schemaVersion;
    }

    if (!enriched.sessionId && typeof existing.sessionId === "string") {
      enriched.sessionId = existing.sessionId;
    }

    if (!enriched.timestamp && typeof existing.timestamp === "string") {
      enriched.timestamp = existing.timestamp;
    }

    return enriched;
  } catch {
    return computed;
  }
}

  const flush = async (captureFilename: string): Promise<void> => {
    const metaPath = join(dir, metaFilenameFor(captureFilename));
    const state = pending.get(captureFilename);
    if (!state) return;

    pending.delete(captureFilename);
    clearTimeout(state.timer);

    if (state.metadata === null) return;

    try {
      const metadata = await mergeExistingMetadata(
        metaPath,
        state.metadata,
      );

      await atomicWriteMetadata(metaPath, metadata, opts.encryption);
      if (opts.onMetadataReady) {
        opts.onMetadataReady(metadata);
      }
    } catch (err) {
      console.error(
        `[redaction-meta-watcher] Failed to write metadata for ${captureFilename}:`,
        err instanceof Error ? err.message : String(err),
      );
      // Re-schedule so transient errors (disk full, permission) do not
      // permanently suppress a valid capture.
      schedule(captureFilename, state.metadata);
    }
  };

  const schedule = (
    captureFilename: string,
    metadata: CaptureRedactionMetadata | null,
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
      let rawData: unknown = await maybeDecryptCapture(rawBytes, opts.encryption);
      if (!rawData) {
        // Could not decrypt or parse, skip
        return;
      }

const captureId = captureFilename.replace(/\.json$/, "");
      const metadata = computeCaptureMeta(captureId, rawData);

      // Wait for redact plugin's meta file to appear (race condition: capture
      // file event may arrive before meta file is visible). Retry up to 5s.
      const metaPath = join(dir, metaFilenameFor(captureFilename));
      let existingMeta: Record<string, unknown> | null = null;
      for (let attempt = 0; attempt < 25; attempt++) {
        try {
          const metaContent = await readFile(metaPath, "utf8");
          existingMeta = JSON.parse(metaContent) as Record<string, unknown>;
          break;
        } catch {
          if (attempt === 24) break;
          await new Promise((r) => setTimeout(r, 200));
        }
      }

      if (existingMeta) {
        const matches = existingMeta.matches;
        if (Array.isArray(matches) && matches.length > 0) {
          console.log(`[redaction-meta-watcher] Fast-path: preserving redact plugin matches for ${captureFilename}`);
          return;
        }
        console.log(`[redaction-meta-watcher] Meta exists but empty/invalid matches, re-processing: ${captureFilename}`);
      } else {
        console.log(`[redaction-meta-watcher] No meta file after 5s, will create: ${captureFilename}`);
      }

      schedule(captureFilename, metadata);
    } catch (err) {
      console.error(
        `[redaction-meta-watcher] Error processing ${captureFilename}:`,
        err instanceof Error ? err.message : String(err),
      );
    }
  };

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
