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
import type { EncryptionAtRestConfig } from "@contextio/core";
import { type RedactionMetadata } from "@contextio/core/db";
/** Freshness window in ms. All events inside this window are coalesced. */
export declare const REDACTION_META_DEBOUNCE_MS = 2000;
/** Upper bound of random jitter appended to each debounce window (ms). */
export declare const REDACTION_META_JITTER_MS = 500;
/** Maximum time a .tmp file may exist before it is considered stale (ms). */
export declare const REDACTION_META_TMP_MAX_AGE_MS = 30000;
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
    /**
     * Optional callback to persist redaction metadata to SQLite.
     * When provided, the watcher will also write metadata to the database
     * in addition to the sidecar file.
     */
    persistToSqlite?: (metadata: RedactionMetadata) => void;
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
    requestBytes?: number;
    responseBytes?: number;
    timings?: {
        send_ms?: number;
        wait_ms?: number;
        receive_ms?: number;
        total_ms?: number;
    };
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
/**
 * Start a background watcher over `captureDir`.
 *
 * The watcher never blocks the caller. It is the caller's responsibility to
 * invoke `.stop()` before the process exits so that the fs.watch handle
 * is released cleanly.
 */
export declare function createRedactionMetaWatcher(opts: RedactionMetaWatcherOptions): RedactionMetaWatcher;
//# sourceMappingURL=redaction-meta-watcher.d.ts.map