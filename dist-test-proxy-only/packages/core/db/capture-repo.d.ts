/**
 * Capture metadata repository for SQLite-backed capture indexing.
 * Provides CRUD operations and queries for capture metadata.
 */
import type { CaptureMetadata } from "../types.js";
export type { CaptureMetadata };
/**
 * Insert or update a capture metadata entry.
 * Uses upsert (ON CONFLICT DO UPDATE) to handle both new and existing captures.
 */
export declare function upsertCapture(metadata: CaptureMetadata): void;
/**
 * Insert or update multiple capture metadata entries in a single transaction.
 * More efficient than calling upsertCapture repeatedly for bulk operations.
 */
export declare function upsertCaptures(metadataArray: CaptureMetadata[]): void;
/**
 * Get a capture metadata entry by ID.
 * Returns null if not found.
 */
export declare function getCaptureById(id: string): CaptureMetadata | null;
/**
 * Get all capture metadata entries for a specific session.
 * Ordered by timestamp (oldest first).
 */
export declare function getCapturesBySession(sessionId: string): CaptureMetadata[];
/**
 * Get the most recent capture metadata entries.
 * Ordered by timestamp descending (newest first).
 */
export declare function getRecentCaptures(limit: number, offset?: number): CaptureMetadata[];
/**
 * Get capture metadata entries within a date range.
 * Ordered by timestamp ascending (oldest first).
 */
export declare function getCapturesByDateRange(startMs: number, endMs: number): CaptureMetadata[];
/**
 * Delete a capture metadata entry by ID.
 * Note: This only removes the index entry; the capture file on disk is not deleted.
 */
export declare function deleteCapture(id: string): void;
/**
 * Get the total count of capture metadata entries.
 */
export declare function getCaptureCount(): number;
/**
 * Get aggregate statistics about captures.
 */
export declare function getStats(): {
    totalCaptures: number;
    totalSessions: number;
    dateRange: {
        earliest: number;
        latest: number;
    };
};
/**
 * Search captures with flexible filters.
 */
export declare function searchCaptures(query: {
    sessionId?: string;
    model?: string;
    status?: string;
    startDate?: number;
    endDate?: number;
    limit?: number;
    offset?: number;
}): CaptureMetadata[];
//# sourceMappingURL=capture-repo.d.ts.map