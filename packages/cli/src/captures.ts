/**
 * Shared utilities for reading capture files from disk.
 *
 * Used by the inspect, monitor, export, and replay commands. All
 * functions default to `~/.contextio/captures` when no directory
 * is specified.
 */

import fs from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

import type { CaptureData } from "@contextio/core";
import { decryptCapture } from "@contextio/logger";

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
