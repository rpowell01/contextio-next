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
import { stat, readFile, writeFile, rename, unlink, mkdir } from "node:fs/promises";
import { join } from "node:path";

import type { CaptureData } from "@contextio/core";

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
}

export interface CaptureRedactionMetadata {
  captureId: string;
  totalRedactions: number;
  byRule: Record<string, number>;
  generatedAt: string;
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
): Promise<void> {
  const tmpPath = `${targetPath}.tmp-${Date.now()}-${Math.random()
    .toString(36)
    .slice(2, 8)}`;

  await writeFile(
    tmpPath,
    JSON.stringify(metadata, null, 2),
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
    const entries = await fs.readdir(dir);
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
// Lazy-computed helper: importing computeCaptureRedactionCounts only when
// the watcher actually runs avoids the proxy package depending on the web
// package at build time. We require() it inside the loop so the function
// is fetched from the shared workspace at runtime.
// ---------------------------------------------------------------------------

function computeCaptureMeta(captureId: string, rawData: unknown): CaptureRedactionMetadata | null {
  try {
    // Use dynamic require so that the proxy package does not need to
    // re-package redaction-utils at build time.
    const {
      computeCaptureRedactionCounts,
    }: {
      computeCaptureRedactionCounts: (raw: unknown) => {
        totalRedactions: number;
        byRule: Record<string, number>;
      };
    } = require("@contextio/web");

    const result = computeCaptureRedactionCounts(rawData as never);
    return {
      captureId,
      totalRedactions: result.totalRedactions,
      byRule: result.byRule,
      generatedAt: new Date().toISOString(),
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

  const flush = async (captureFilename: string): Promise<void> => {
    const metaPath = join(dir, metaFilenameFor(captureFilename));
    const state = pending.get(captureFilename);
    if (!state) return;

    pending.delete(captureFilename);
    clearTimeout(state.timer);

    if (state.metadata === null) return;

    try {
      await atomicWriteMetadata(metaPath, state.metadata);
      if (opts.onMetadataReady) {
        opts.onMetadataReady(state.metadata);
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
      let rawData: unknown;
      try {
        rawData = JSON.parse(rawBytes);
      } catch {
        return;
      }

      const captureId = captureFilename.replace(/\.json$/, "");
      const metadata = computeCaptureMeta(captureId, rawData);

      // fast-path: if the metadata file already exists and is up-to-date
      // relative to the capture mtime, skip re-writing. This keeps the
      // watcher quiet for files that haven't changed since the last run.
      const metaPath = join(dir, metaFilenameFor(captureFilename));
      try {
        const metaStats = await stat(metaPath);
        // Allow a small clock skew tolerance (1 s).
        if (
          metadata &&
          metaStats.mtimeMs >= fileStats.mtimeMs - 1_000 &&
          metaStats.size > 0
        ) {
          return;
        }
      } catch {
        // metadata file does not yet exist; continue to write it.
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

    // Best-effort cleanup of stale tmp files on startup / reconnect.
    void flushStaleTmp();

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
      watcher?.close().catch(() => undefined);
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
      watcher?.close().catch(() => undefined);
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
