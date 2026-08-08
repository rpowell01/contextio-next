/**
 * Shared utilities for reading capture files from disk.
 *
 * Used by the inspect, monitor, export, and replay commands. All
 * functions default to `~/.contextio/captures` when no directory
 * is specified.
 *
 * This module provides both file-based (legacy) and SQLite-backed
 * implementations. SQLite-backed functions are preferred for performance
 * and automatically fall back to file-based methods if the database
 * is not initialized.
 */

import fs from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

import type { CaptureData } from "@contextio/core";
import { decryptCapture, decrypt } from "@contextio/logger";
import {
	isDbInitialized,
	getCapturesBySession as dbGetCapturesBySession,
	getRecentCaptures as dbGetRecentCaptures,
	searchCaptures as dbSearchCaptures,
	getStats as dbGetStats,
	migrateCapturesSync,
	migrateCaptures,
	type CaptureMetadata,
	type MigrateCapturesResult,
} from "@contextio/core/db";

export type { CaptureMetadata, MigrateCapturesResult };

/** Default capture directory: `~/.contextio/captures`. */
export function captureDir(): string {
  return join(homedir(), ".contextio", "captures");
}

/**
 * List all `.json` capture files in a directory, sorted lexicographically.
 * Excludes `.tmp` files (incomplete atomic writes).
 */
export function listCaptureFiles(dir?: string): string[] {
  const d = dir ?? captureDir();
  if (!fs.existsSync(d)) return [];
  return fs
    .readdirSync(d)
    .filter((f) => f.endsWith(".json") && !f.endsWith(".tmp"))
    .sort();
}

/**
 * Read and parse a single capture file. Returns null on any error.
 *
 * @param filepath - Path to the capture file.
 * @param keyMaterial - Optional encryption key. When provided, the
 *   function transparently decrypts files that were written with
 *   `encryption.enabled=true` in the logger plugin. Pass the same
 *   value that was supplied as `encryption.staticKey` or
 *   `encryption.keyEnvVar` when the plugin was configured.
 */
export async function readCapture(
  filepath: string,
  keyMaterial?: string,
): Promise<CaptureData | null> {
  return decryptCapture(filepath, keyMaterial ?? null);
}

/**
 * Find the session ID of the most recent capture file.
 * Scans from the end of the sorted file list for efficiency.
 */
export async function findLastSessionId(
  dir?: string,
  keyMaterial?: string,
): Promise<string | null> {
  const d = dir ?? captureDir();
  const files = listCaptureFiles(d);

  for (let i = files.length - 1; i >= 0; i--) {
    const capture = await readCapture(join(d, files[i]), keyMaterial);
    if (capture?.sessionId) return capture.sessionId;
  }

  return null;
}

/**
 * Load all captures belonging to a given session ID, in file order.
 *
 * @param sessionId - The session ID to filter by.
 * @param dir - Directory to scan (defaults to the standard capture dir).
 * @param keyMaterial - Optional encryption key for decrypting captures.
 */
export async function loadSessionCaptures(
  sessionId: string,
  dir?: string,
  keyMaterial?: string,
): Promise<CaptureData[]> {
  const d = dir ?? captureDir();
  const files = listCaptureFiles(d);
  const captures: CaptureData[] = [];

  for (const file of files) {
    const capture = await readCapture(join(d, file), keyMaterial);
    if (capture && capture.sessionId === sessionId) {
      captures.push(capture);
    }
  }

  return captures;
}

/**
 * SQLite-backed alternative to listCaptureFiles().
 * Queries the captures_metadata table for filepaths.
 * Falls back to file scan if DB not initialized.
 *
 * @param dir - Capture directory (used for fallback only).
 * @param options - Query options: sessionId, dateRange (start/end ms), limit, offset.
 * @returns Array of capture filepaths relative to capture directory.
 */
export async function listCaptureFilesSqlite(
  dir?: string,
  options?: {
    sessionId?: string;
    dateRange?: { start: number; end: number };
    limit?: number;
    offset?: number;
  },
): Promise<string[]> {
  const d = dir ?? captureDir();

  // Check if DB is initialized
  if (!isDbInitialized()) {
    console.warn("[listCaptureFilesSqlite] Database not initialized, falling back to file scan");
    return listCaptureFiles(d);
  }

  try {
    const dbOptions: Parameters<typeof dbSearchCaptures>[0] = {
      limit: options?.limit,
      offset: options?.offset,
    };

    if (options?.sessionId) {
      dbOptions.sessionId = options.sessionId;
    }

    if (options?.dateRange) {
      dbOptions.startDate = options.dateRange.start;
      dbOptions.endDate = options.dateRange.end;
    }

    const results = dbSearchCaptures(dbOptions);
    return results.map((r) => r.filepath);
  } catch (err) {
    console.warn(
      `[listCaptureFilesSqlite] SQLite query failed: ${err instanceof Error ? err.message : String(err)}, falling back to file scan`,
    );
    return listCaptureFiles(d);
  }
}

/**
 * SQLite-backed alternative to findLastSessionId().
 * Queries captures_metadata ORDER BY timestamp DESC and returns
 * the first capture with a sessionId.
 * Much faster than scanning all files.
 * Falls back to file-based method if DB not initialized.
 *
 * @param dir - Capture directory (used for fallback only).
 * @param keyMaterial - Optional encryption key (used for fallback only).
 * @returns Most recent session ID or null.
 */
export async function findLastSessionIdSqlite(
  dir?: string,
  keyMaterial?: string,
): Promise<string | null> {
  const d = dir ?? captureDir();

  if (!isDbInitialized()) {
    console.warn("[findLastSessionIdSqlite] Database not initialized, falling back to file scan");
    return findLastSessionId(d, keyMaterial);
  }

  try {
    // Fetch up to 100 recent captures to find one with a sessionId
    // This matches the file-based fallback which scans all files backwards
    const recent = dbGetRecentCaptures(100);
    for (const capture of recent) {
      if (capture.sessionId) {
        return capture.sessionId;
      }
    }
    return null;
  } catch (err) {
    console.warn(
      `[findLastSessionIdSqlite] SQLite query failed: ${err instanceof Error ? err.message : String(err)}, falling back to file scan`,
    );
    return findLastSessionId(d, keyMaterial);
  }
}

/**
 * SQLite-backed alternative to loadSessionCaptures().
 * Queries captures_metadata WHERE session_id = ?,
 * then reads only matching JSON files.
 * Avoids reading all capture files.
 * Falls back to file-based method if DB not initialized.
 *
 * @param sessionId - The session ID to filter by.
 * @param dir - Directory to scan (used for fallback only).
 * @param keyMaterial - Optional encryption key for decrypting captures.
 * @returns Array of CaptureData for the session.
 */
export async function loadSessionCapturesSqlite(
  sessionId: string,
  dir?: string,
  keyMaterial?: string,
): Promise<CaptureData[]> {
  const d = dir ?? captureDir();

  if (!isDbInitialized()) {
    console.warn("[loadSessionCapturesSqlite] Database not initialized, falling back to file scan");
    return loadSessionCaptures(sessionId, d, keyMaterial);
  }

  try {
    const metadata = dbGetCapturesBySession(sessionId);
    const captures: CaptureData[] = [];

    for (const meta of metadata) {
      const capture = await readCapture(join(d, meta.filepath), keyMaterial);
      if (capture) {
        captures.push(capture);
      }
    }

    return captures;
  } catch (err) {
    console.warn(
      `[loadSessionCapturesSqlite] SQLite query failed: ${err instanceof Error ? err.message : String(err)}, falling back to file scan`,
    );
    return loadSessionCaptures(sessionId, d, keyMaterial);
  }
}

/**
 * Get capture statistics from the SQLite database.
 * Returns total captures, total sessions, and date range.
 *
 * @returns Statistics object or null if DB not initialized.
 */
export async function getCaptureStats(): Promise<{
  totalCaptures: number;
  totalSessions: number;
  dateRange: { earliest: number; latest: number };
} | null> {
  if (!isDbInitialized()) {
    console.warn("[getCaptureStats] Database not initialized");
    return null;
  }

  try {
    return dbGetStats();
  } catch (err) {
    console.warn(
      `[getCaptureStats] SQLite query failed: ${err instanceof Error ? err.message : String(err)}`,
    );
    return null;
  }
}

/**
 * Search captures using SQLite index with flexible filters.
 *
 * @param query - Search query: sessionId, model, status, startDate, endDate, limit, offset.
 * @returns Array of CaptureMetadata matching the query.
 */
export async function searchCapturesSqlite(query: {
  sessionId?: string;
  model?: string;
  status?: string;
  startDate?: number;
  endDate?: number;
  limit?: number;
  offset?: number;
}): Promise<CaptureMetadata[]> {
  if (!isDbInitialized()) {
    console.warn("[searchCapturesSqlite] Database not initialized, returning empty results");
    return [];
  }

  try {
    return dbSearchCaptures(query);
  } catch (err) {
    console.warn(
      `[searchCapturesSqlite] SQLite query failed: ${err instanceof Error ? err.message : String(err)}`,
    );
    return [];
  }
}

/**
 * Rebuild the SQLite capture index from JSON files on disk.
 * This is the CLI equivalent of the migrate captures command.
 *
 * @param dir - Capture directory to scan.
 * @param keyMaterial - Optional encryption key for decrypting captures.
 * @param force - Whether to re-index already indexed captures.
 * @param dryRun - Preview changes without writing to database.
 * @returns Migration result with indexed, skipped, failed counts and errors.
 */
export async function reindexCaptures(
  dir?: string,
  keyMaterial?: string,
  force = false,
  dryRun = false,
): Promise<MigrateCapturesResult> {
  const d = dir ?? captureDir();

  const decryptFn = keyMaterial ? decrypt : undefined;

  try {
    if (decryptFn) {
      const result = await migrateCaptures({
        captureDir: d,
        force,
        dryRun,
        decryptFn,
        keyMaterial,
      });
      return result;
    } else {
      const result = migrateCapturesSync({ captureDir: d, force, dryRun });
      return result;
    }
  } catch (err) {
    console.error(
      `[reindexCaptures] Failed to reindex captures: ${err instanceof Error ? err.message : String(err)}`,
    );
    throw err;
  }
}
