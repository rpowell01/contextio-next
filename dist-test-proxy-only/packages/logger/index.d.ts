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
import type { CaptureData, ProxyPlugin, EncryptionAtRestConfig } from "@contextio/core";
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
export declare function decryptCapture(filepath: string, keyMaterial: string | null): Promise<CaptureData | null>;
export { deriveKey, encrypt, decrypt, validateKey, } from "./crypto.js";
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
export declare function createLoggerPlugin(config?: LoggerConfig): LoggerPlugin;
//# sourceMappingURL=index.d.ts.map