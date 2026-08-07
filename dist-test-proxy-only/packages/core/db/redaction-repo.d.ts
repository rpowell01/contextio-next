/**
 * Redaction metadata repository for SQLite-backed redaction metadata storage.
 * Replaces file-based .redact-meta.json sidecar files with database operations.
 */
/**
 * Database row type for redaction_metadata table.
 * Matches the schema with all session fields.
 */
export interface RedactionMetadataRow {
    capture_id: string;
    session_id: string | null;
    rule_counts: string;
    total_redactions: number;
    encrypted: number;
    source: string | null;
    provider: string | null;
    target_url: string | null;
    request_bytes: number | null;
    response_bytes: number | null;
    timings_send_ms: number | null;
    timings_wait_ms: number | null;
    timings_receive_ms: number | null;
    timings_total_ms: number | null;
    total_input_tokens: number | null;
    total_output_tokens: number | null;
    tokens_per_second: number | null;
    success_count: number | null;
    error_count: number | null;
    model: string | null;
    created_at: number;
    updated_at: number;
}
/**
 * Type definitions for the redaction metadata API.
 */
export interface RedactionMetadata {
    captureId: string;
    sessionId: string | null;
    ruleCounts: Record<string, number>;
    totalRedactions: number;
    encrypted: boolean;
    createdAt: number;
    updatedAt: number;
    source?: string | null;
    provider?: string | null;
    targetUrl?: string | null;
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
export interface SessionRedactionAggregate {
    sessionId: string;
    totalCaptures: number;
    totalRedactions: number;
    byRule: Record<string, number>;
}
/**
 * Insert or update a redaction metadata entry.
 * Uses upsert (ON CONFLICT DO UPDATE) to handle both new and existing captures.
 */
export declare function upsertRedactionMetadata(metadata: RedactionMetadata): void;
/**
 * Insert or update multiple redaction metadata entries in a single transaction.
 * More efficient than calling upsertRedactionMetadata repeatedly for bulk operations.
 */
export declare function upsertRedactionMetadataBulk(metadataArray: RedactionMetadata[]): void;
/**
 * Get a redaction metadata entry by capture ID.
 * Returns null if not found.
 */
export declare function getRedactionMetadataByCaptureId(captureId: string): RedactionMetadata | null;
/**
 * Get all redaction metadata entries for a specific session.
 * Ordered by created_at (oldest first).
 */
export declare function getRedactionMetadataBySessionId(sessionId: string): RedactionMetadata[];
/**
 * Get aggregate redaction statistics for a specific session.
 */
export declare function aggregateRedactionMetadataBySession(sessionId: string): SessionRedactionAggregate;
/**
 * Delete a redaction metadata entry by capture ID.
 */
export declare function deleteRedactionMetadataByCaptureId(captureId: string): void;
/**
 * Get aggregate statistics across all redaction metadata.
 */
export declare function getRedactionAggregateStats(): {
    totalCaptures: number;
    totalRedactions: number;
    byRule: Record<string, number>;
};
/**
 * Import existing .redact-meta.json sidecar files into the SQLite database.
 * This is used for one-time migration from file-based to SQLite storage.
 *
 * @param captureDir - Path to the capture directory containing .redact-meta.json files
 * @param decryptFn - Optional decryption function (e.g., from @contextio/logger) for encrypted metadata files
 * @returns Number of metadata files imported
 */
export declare function importRedactionMetaFromFiles(captureDir: string, decryptFn?: (encryptedJson: string, keyMaterial: string) => Promise<string>): Promise<number>;
/**
 * Check if redaction metadata exists for a capture ID.
 */
export declare function redactionMetadataExists(captureId: string): boolean;
//# sourceMappingURL=redaction-repo.d.ts.map