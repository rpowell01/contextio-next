/**
 * @contextio/logger
 *
 * Capture-to-disk plugin for the contextio proxy. Writes every
 * request/response pair as a JSON file using atomic writes (write to
 * .tmp, then rename) so readers never see half-written files.
 *
 * Filename format: `{source}_{sessionId}_{timestamp}-{counter}.json`
 * Example: `claude_a1b2c3d4_1739000000000-000001.json`
 *
 * @packageDocumentation
 */

import fs from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

import { decrypt, encrypt } from "./crypto.js";
import type {
  CaptureData,
  ProxyPlugin,
  EncryptionAtRestConfig,
} from "@contextio/core";

/**
 * Configuration for {@link createLoggerPlugin}.
 */
export interface LoggerConfig {
  /**
   * Directory to write capture files to.
   * Default: `~/.contextio/captures`
   */
  captureDir?: string;

  /**
   * Encryption-at-rest configuration. When `enabled` is true,
   * captures are AES-256-GCM encrypted before being written to disk.
   * Default: disabled (plaintext JSON files).
   */
  encryption?: EncryptionAtRestConfig;

  /**
   * Maximum number of sessions to retain. On startup, the plugin
   * groups existing captures by session ID and deletes the oldest
   * sessions beyond this limit.
   *
   * Set to 0 to keep everything (no pruning). Default: 0.
   */
  maxSessions?: number;
}

/**
 * Extended plugin interface that exposes the resolved capture directory.
 * Useful for CLI output (telling the user where captures are written).
 */
export interface LoggerPlugin extends ProxyPlugin {
  /** The resolved directory where captures are written. */
  captureDir: string;
}

/**
 * Expected shape of an encrypted capture file's top-level JSON envelope.
 */
interface EncryptedPayload {
  ciphertext: string;
  salt: string;
  iv: string;
}

/**
 * Read a capture file and return the parsed `CaptureData`.
 *
 * Transparently handles both plaintext and encrypted capture files.
 * When the file contents look like an encrypted payload (`{ ciphertext,
 * salt, iv }`), it is decrypted with the provided `keyMaterial` and
 * the resulting plaintext is parsed as JSON.
 *
 * Returns `null` if the file cannot be read, decryption fails (wrong
 * key, corrupt payload), or the contents are not valid capture JSON.
 *
 * @param filepath - Path to the capture file on disk.
 * @param keyMaterial - Optional encryption key. Pass the same value
 *   used when the logger plugin was configured with `encryption.enabled=true`.
 *   Omit or pass `null`/empty string to read only unencrypted captures.
 */
export async function decryptCapture(
  filepath: string,
  keyMaterial: string | null,
): Promise<CaptureData | null> {
  try {
    const raw = fs.readFileSync(filepath, "utf8");

    // Detect whether the file is an encrypted envelope by inspecting the
    // parsed JSON structure.
    const parsed = JSON.parse(raw) as Record<string, unknown>;
    const isEncrypted =
      typeof parsed.ciphertext === "string" &&
      typeof parsed.salt === "string" &&
      typeof parsed.iv === "string";

    if (isEncrypted) {
      // Encrypted file but no key provided — cannot decrypt.
      if (!keyMaterial || keyMaterial.length === 0) return null;
      // Attempt decryption; wrong key or corrupt payload returns null.
      try {
        const plaintext: string = await decrypt(raw, keyMaterial);
        return JSON.parse(plaintext) as CaptureData;
      } catch {
        return null;
      }
    }

    // Not encrypted — parse raw bytes directly as plaintext JSON.
    return JSON.parse(raw) as CaptureData;
  } catch {
    // File unreadable or contains invalid JSON.
    return null;
  }
}

export {
  deriveKey,
  encrypt,
  decrypt,
  validateKey,
} from "./crypto.js";

/**
 * Create a logger plugin that writes captures to disk.
 *
 * ```typescript
 * import { createLoggerPlugin } from '@contextio/logger';
 *
 * const logger = createLoggerPlugin({ maxSessions: 20 });
 * console.log(logger.captureDir); // ~/.contextio/captures
 * ```
 */
export function createLoggerPlugin(config?: LoggerConfig): LoggerPlugin {
  const captureDir =
    config?.captureDir || join(homedir(), ".contextio", "captures");
  const maxSessions = config?.maxSessions ?? 0;
  const encryption = config?.encryption;

  const encryptionEnabled = encryption?.enabled ?? false;
  let keyMaterial: string | undefined;
  if (encryptionEnabled) {
    const enc = encryption!;
    switch (enc.keyProvider) {
      case "static":
        keyMaterial = enc.staticKey;
        break;
      case "env":
      default:
        keyMaterial =
          process.env[enc.keyEnvVar ?? "CONTEXTIO_ENCRYPTION_KEY"];
        break;
      case "kms":
        throw new Error(
          "[logger] KMS key provider not yet implemented",
        );
    }
    if (!keyMaterial) {
      throw new Error(
        "[logger] Encryption enabled but no key material resolved",
      );
    }
  }

  let dirReady = false;
  let counter = 0;

  /** Create the capture directory if needed, and prune old sessions on first call. */
  function ensureDir(): void {
    if (dirReady) return;
    fs.mkdirSync(captureDir, { recursive: true });
    dirReady = true;
    if (maxSessions > 0) {
      pruneOldSessions();
    }
  }

  /**
   * Build a filename from capture metadata.
   * Format: {source}_{sessionId}_{timestamp}-{counter}.json
   * Falls back to "unknown" for missing source, omits session if null.
   */
  function buildFilename(capture: CaptureData): string {
    if (capture.captureId) return capture.captureId;
    const source = capture.source || "unknown";
    const safe = source.replace(/[^a-zA-Z0-9_-]/g, "_");
    const session = capture.sessionId ? `_${capture.sessionId}` : "";
    const ts = Date.now();
    const seq = String(counter++).padStart(6, "0");
    return `${safe}${session}_${ts}-${seq}.json`;
  }

  /**
   * Extract the session ID from a capture filename.
   *
   * Filename format: `{source}_{sessionId}_{timestamp}-{counter}.json`
   * The session ID is the second underscore-delimited segment and is
   * always 8 lowercase hex chars. Returns null if not present.
   */
  function extractSessionFromFilename(filename: string): string | null {
    const parts = filename.replace(/\.json$/, "").split("_");
    if (parts.length >= 3) {
      const candidate = parts[1];
      if (/^[a-f0-9]{8}$/.test(candidate)) {
        return candidate;
      }
    }
    return null;
  }

  /**
   * Delete capture files from the oldest sessions, keeping the most
   * recent `maxSessions`. Groups files by session ID, sorts by newest
   * timestamp, and removes everything beyond the limit.
   */
  function pruneOldSessions(): void {
    try {
      const files = fs
        .readdirSync(captureDir)
        .filter((f) => f.endsWith(".json") && !f.endsWith(".tmp"))
        .sort(); // lexicographic, but we group by session below

      // Group files by session ID
      const sessionFiles = new Map<string, string[]>();
      const noSessionFiles: string[] = [];

      for (const file of files) {
        const session = extractSessionFromFilename(file);
        if (session) {
          const existing = sessionFiles.get(session) ?? [];
          existing.push(file);
          sessionFiles.set(session, existing);
        } else {
          noSessionFiles.push(file);
        }
      }

      // Find the most recent timestamp per session to sort them
      const sessions = [...sessionFiles.entries()].map(
        ([id, sessionFilesList]) => {
          // Extract the max timestamp from the session's files.
          // Filename format: {source}_{sessionId}_{timestamp}-{counter}.json
          let maxTs = 0;
          for (const f of sessionFilesList) {
            const match = f.match(/_(\d{13})-\d{6}\.json$/);
            if (match) {
              const ts = parseInt(match[1], 10);
              if (ts > maxTs) maxTs = ts;
            }
          }
          return { id, files: sessionFilesList, maxTs };
        },
      );

      // Sort newest first by timestamp
      sessions.sort((a, b) => b.maxTs - a.maxTs);

      // Keep the newest maxSessions, prune the rest
      const toPrune = sessions.slice(maxSessions);
      let pruned = 0;
      for (const session of toPrune) {
        for (const file of session.files) {
          try {
            fs.unlinkSync(join(captureDir, file));
            pruned++;
          } catch {
            // ignore: file may have been removed already
          }
        }
      }

      if (pruned > 0) {
        console.log(
          `[logger] Pruned ${pruned} capture file(s) from ${toPrune.length} old session(s)`,
        );
      }
    } catch {
      // ignore: directory may not exist or be unreadable
    }
  }

  /**
   * Write a capture to disk atomically (write to .tmp, then rename).
   * Returns the filename on success, null on failure.
   *
   * When encryption is enabled, the plaintext is encrypted with AES-256-GCM
   * before writing. The file extension remains `.json` but the content is the
   * `{ ciphertext, salt, iv }` payload envelope.
   */
  async function write(
    capture: CaptureData,
  ): Promise<string | null> {
    ensureDir();
    const filename = buildFilename(capture);
    const filePath = join(captureDir, filename);
    const tmpPath = `${filePath}.tmp`;

    try {
      let content: string;
      if (keyMaterial) {
        const encrypted = await encrypt(JSON.stringify(capture), keyMaterial);
        content = JSON.stringify(encrypted);
      } else {
        content = JSON.stringify(capture);
      }

      fs.writeFileSync(tmpPath, content);
      fs.renameSync(tmpPath, filePath);
      return filename;
    } catch (err: unknown) {
      console.error(
        "Capture write error:",
        err instanceof Error ? err.message : String(err),
      );
      try {
        fs.unlinkSync(tmpPath);
      } catch {
        /* may not exist */
      }
      return null;
    }
  }

  // Eagerly create directory and prune on construction, not first write.
  ensureDir();

  return {
    name: "logger",
    captureDir,
    onCapture(capture: CaptureData): void | Promise<void> {
      // fire-and-forget: errors are logged inside write()
      void write(capture);
    },
  };
}