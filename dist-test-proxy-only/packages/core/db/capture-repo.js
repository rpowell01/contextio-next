/**
 * Capture metadata repository for SQLite-backed capture indexing.
 * Provides CRUD operations and queries for capture metadata.
 */
import { getDb } from "./connection.js";
/**
 * Convert a database row to a CaptureMetadata object.
 */
function rowToCaptureMetadata(row) {
    return {
        id: row.id,
        sessionId: row.session_id ?? undefined,
        filepath: row.filepath,
        timestamp: row.timestamp,
        requestModel: row.request_model ?? undefined,
        responseModel: row.response_model ?? undefined,
        tokensPrompt: row.tokens_prompt ?? undefined,
        tokensCompletion: row.tokens_completion ?? undefined,
        durationMs: row.duration_ms ?? undefined,
        status: row.status,
        createdAt: row.created_at,
    };
}
/**
 * Convert a CaptureMetadata object to database column values for insert/update.
 */
function captureMetadataToRow(metadata) {
    return {
        id: metadata.id,
        session_id: metadata.sessionId ?? null,
        filepath: metadata.filepath,
        timestamp: metadata.timestamp,
        request_model: metadata.requestModel ?? null,
        response_model: metadata.responseModel ?? null,
        tokens_prompt: metadata.tokensPrompt ?? null,
        tokens_completion: metadata.tokensCompletion ?? null,
        duration_ms: metadata.durationMs ?? null,
        status: metadata.status,
    };
}
/** Prepared statement for upserting a single capture. */
const UPSERT_CAPTURE_SQL = `
	INSERT INTO captures_metadata (
		id, session_id, filepath, timestamp,
		request_model, response_model, tokens_prompt, tokens_completion,
		duration_ms, status, created_at
	) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
	ON CONFLICT(id) DO UPDATE SET
		session_id = excluded.session_id,
		filepath = excluded.filepath,
		timestamp = excluded.timestamp,
		request_model = excluded.request_model,
		response_model = excluded.response_model,
		tokens_prompt = excluded.tokens_prompt,
		tokens_completion = excluded.tokens_completion,
		duration_ms = excluded.duration_ms,
		status = excluded.status
`;
/**
 * Insert or update a capture metadata entry.
 * Uses upsert (ON CONFLICT DO UPDATE) to handle both new and existing captures.
 */
export function upsertCapture(metadata) {
    const db = getDb();
    const row = captureMetadataToRow(metadata);
    const stmt = db.prepare(UPSERT_CAPTURE_SQL);
    stmt.run(row.id, row.session_id, row.filepath, row.timestamp, row.request_model, row.response_model, row.tokens_prompt, row.tokens_completion, row.duration_ms, row.status, metadata.createdAt);
}
/**
 * Insert or update multiple capture metadata entries in a single transaction.
 * More efficient than calling upsertCapture repeatedly for bulk operations.
 */
export function upsertCaptures(metadataArray) {
    if (metadataArray.length === 0)
        return;
    const db = getDb();
    const stmt = db.prepare(UPSERT_CAPTURE_SQL);
    const transaction = db.transaction((items) => {
        for (const metadata of items) {
            const row = captureMetadataToRow(metadata);
            stmt.run(row.id, row.session_id, row.filepath, row.timestamp, row.request_model, row.response_model, row.tokens_prompt, row.tokens_completion, row.duration_ms, row.status, metadata.createdAt);
        }
    });
    transaction(metadataArray);
}
/**
 * Get a capture metadata entry by ID.
 * Returns null if not found.
 */
export function getCaptureById(id) {
    const db = getDb();
    const row = db.prepare("SELECT * FROM captures_metadata WHERE id = ?").get(id);
    return row ? rowToCaptureMetadata(row) : null;
}
/**
 * Get all capture metadata entries for a specific session.
 * Ordered by timestamp (oldest first).
 */
export function getCapturesBySession(sessionId) {
    const db = getDb();
    const rows = db.prepare("SELECT * FROM captures_metadata WHERE session_id = ? ORDER BY timestamp ASC").all(sessionId);
    return rows.map(rowToCaptureMetadata);
}
/**
 * Get the most recent capture metadata entries.
 * Ordered by timestamp descending (newest first).
 */
export function getRecentCaptures(limit, offset = 0) {
    const db = getDb();
    const rows = db.prepare("SELECT * FROM captures_metadata ORDER BY timestamp DESC LIMIT ? OFFSET ?").all(limit, offset);
    return rows.map(rowToCaptureMetadata);
}
/**
 * Get capture metadata entries within a date range.
 * Ordered by timestamp ascending (oldest first).
 */
export function getCapturesByDateRange(startMs, endMs) {
    const db = getDb();
    const rows = db.prepare("SELECT * FROM captures_metadata WHERE timestamp >= ? AND timestamp <= ? ORDER BY timestamp ASC").all(startMs, endMs);
    return rows.map(rowToCaptureMetadata);
}
/**
 * Delete a capture metadata entry by ID.
 * Note: This only removes the index entry; the capture file on disk is not deleted.
 */
export function deleteCapture(id) {
    const db = getDb();
    const result = db.prepare("DELETE FROM captures_metadata WHERE id = ?").run(id);
    if (result.changes === 0) {
        throw new Error(`Capture with id "${id}" not found`);
    }
}
/**
 * Get the total count of capture metadata entries.
 */
export function getCaptureCount() {
    const db = getDb();
    const row = db.prepare("SELECT COUNT(*) as count FROM captures_metadata").get();
    return row?.count ?? 0;
}
/**
 * Get aggregate statistics about captures.
 */
export function getStats() {
    const db = getDb();
    // Single query to get all stats at once
    const row = db.prepare("SELECT COUNT(*) as count, COUNT(DISTINCT session_id) as sessions, MIN(timestamp) as earliest, MAX(timestamp) as latest FROM captures_metadata").get();
    return {
        totalCaptures: row?.count ?? 0,
        totalSessions: row?.sessions ?? 0,
        dateRange: {
            earliest: row?.earliest ?? 0,
            latest: row?.latest ?? 0,
        },
    };
}
/**
 * Search captures with flexible filters.
 */
export function searchCaptures(query) {
    const db = getDb();
    const conditions = [];
    const params = [];
    if (query.sessionId !== undefined) {
        conditions.push("session_id = ?");
        params.push(query.sessionId);
    }
    if (query.model !== undefined) {
        conditions.push("(request_model = ? OR response_model = ?)");
        params.push(query.model, query.model);
    }
    if (query.status !== undefined) {
        conditions.push("status = ?");
        params.push(query.status);
    }
    if (query.startDate !== undefined) {
        conditions.push("timestamp >= ?");
        params.push(query.startDate);
    }
    if (query.endDate !== undefined) {
        conditions.push("timestamp <= ?");
        params.push(query.endDate);
    }
    const whereClause = conditions.length > 0 ? `WHERE ${conditions.join(" AND ")}` : "";
    let sql = `SELECT * FROM captures_metadata ${whereClause} ORDER BY timestamp DESC`;
    // SQLite requires LIMIT before OFFSET. Use LIMIT -1 (no upper bound) when only offset is provided.
    if (query.limit !== undefined) {
        sql += " LIMIT ?";
        params.push(query.limit);
    }
    else if (query.offset !== undefined) {
        sql += " LIMIT -1";
    }
    if (query.offset !== undefined) {
        sql += " OFFSET ?";
        params.push(query.offset);
    }
    const rows = db.prepare(sql).all(...params);
    return rows.map(rowToCaptureMetadata);
}
//# sourceMappingURL=capture-repo.js.map