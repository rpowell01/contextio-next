/**
 * Capture metadata repository for SQLite-backed capture indexing.
 * Provides CRUD operations and queries for capture metadata.
 */

import { getDb } from "./connection.js";
import type { CaptureMetadata } from "../types.js";

export type { CaptureMetadata };

/**
 * Database row type for captures_metadata table.
 * Matches the schema after migration 003 (nullable session_id, additional indexes).
 */
interface CaptureMetadataRow {
	id: string;
	session_id: string | null;
	filepath: string;
	timestamp: number;
	request_model: string | null;
	response_model: string | null;
	tokens_prompt: number | null;
	tokens_completion: number | null;
	duration_ms: number | null;
	status: string;
	created_at: number;
}

/**
 * Convert a database row to a CaptureMetadata object.
 */
function rowToCaptureMetadata(row: CaptureMetadataRow): CaptureMetadata {
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
function captureMetadataToRow(metadata: CaptureMetadata): Omit<CaptureMetadataRow, "created_at"> {
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
export function upsertCapture(metadata: CaptureMetadata): void {
	const db = getDb();
	const row = captureMetadataToRow(metadata);

	const stmt = db.prepare(UPSERT_CAPTURE_SQL);

	stmt.run(
		row.id,
		row.session_id,
		row.filepath,
		row.timestamp,
		row.request_model,
		row.response_model,
		row.tokens_prompt,
		row.tokens_completion,
		row.duration_ms,
		row.status,
		metadata.createdAt
	);
}

/**
 * Insert or update multiple capture metadata entries in a single transaction.
 * More efficient than calling upsertCapture repeatedly for bulk operations.
 */
export function upsertCaptures(metadataArray: CaptureMetadata[]): void {
	if (metadataArray.length === 0) return;

	const db = getDb();
	const stmt = db.prepare(UPSERT_CAPTURE_SQL);

	const transaction = db.transaction((items: CaptureMetadata[]) => {
		for (const metadata of items) {
			const row = captureMetadataToRow(metadata);
			stmt.run(
				row.id,
				row.session_id,
				row.filepath,
				row.timestamp,
				row.request_model,
				row.response_model,
				row.tokens_prompt,
				row.tokens_completion,
				row.duration_ms,
				row.status,
				metadata.createdAt
			);
		}
	});

	transaction(metadataArray);
}

/**
 * Get a capture metadata entry by ID.
 * Returns null if not found.
 */
export function getCaptureById(id: string): CaptureMetadata | null {
	const db = getDb();
	const row = db.prepare("SELECT * FROM captures_metadata WHERE id = ?").get(id) as CaptureMetadataRow | undefined;
	return row ? rowToCaptureMetadata(row) : null;
}

/**
 * Get all capture metadata entries for a specific session.
 * Ordered by timestamp (oldest first).
 */
export function getCapturesBySession(sessionId: string): CaptureMetadata[] {
	const db = getDb();
	const rows = db.prepare("SELECT * FROM captures_metadata WHERE session_id = ? ORDER BY timestamp ASC").all(sessionId) as CaptureMetadataRow[];
	return rows.map(rowToCaptureMetadata);
}

/**
 * Get the most recent capture metadata entries.
 * Ordered by timestamp descending (newest first).
 */
export function getRecentCaptures(limit: number, offset = 0): CaptureMetadata[] {
	const db = getDb();
	const rows = db.prepare("SELECT * FROM captures_metadata ORDER BY timestamp DESC LIMIT ? OFFSET ?").all(limit, offset) as CaptureMetadataRow[];
	return rows.map(rowToCaptureMetadata);
}

/**
 * Get capture metadata entries within a date range.
 * Ordered by timestamp ascending (oldest first).
 */
export function getCapturesByDateRange(startMs: number, endMs: number): CaptureMetadata[] {
	const db = getDb();
	const rows = db.prepare("SELECT * FROM captures_metadata WHERE timestamp >= ? AND timestamp <= ? ORDER BY timestamp ASC").all(startMs, endMs) as CaptureMetadataRow[];
	return rows.map(rowToCaptureMetadata);
}

/**
 * Delete a capture metadata entry by ID.
 * Note: This only removes the index entry; the capture file on disk is not deleted.
 */
export function deleteCapture(id: string): void {
	const db = getDb();
	const result = db.prepare("DELETE FROM captures_metadata WHERE id = ?").run(id);
	if (result.changes === 0) {
		throw new Error(`Capture with id "${id}" not found`);
	}
}

/**
 * Delete capture metadata entries by filepath.
 * Useful when the capture file on disk has been deleted and we need to clean up orphaned metadata.
 *
 * @param filepath - The filepath as stored in the database (can be full path or relative)
 * @returns Number of deleted records
 */
export function deleteCaptureByFilepath(filepath: string): number {
	const db = getDb();
	const result = db.prepare("DELETE FROM captures_metadata WHERE filepath = ?").run(filepath);
	return result.changes;
}

/**
 * Delete multiple capture metadata entries by filepaths.
 * More efficient than calling deleteCaptureByFilepath repeatedly for bulk cleanup.
 *
 * @param filepaths - Array of filepaths as stored in the database
 * @returns Number of deleted records
 */
export function deleteCapturesByFilepaths(filepaths: string[]): number {
	if (filepaths.length === 0) return 0;

	const db = getDb();
	const placeholders = filepaths.map(() => "?").join(",");
	const sql = `DELETE FROM captures_metadata WHERE filepath IN (${placeholders})`;

	const stmt = db.prepare(sql);
	const result = stmt.run(...filepaths);
	return result.changes;
}

/**
 * Get the total count of capture metadata entries.
 */
export function getCaptureCount(): number {
	const db = getDb();
	const row = db.prepare("SELECT COUNT(*) as count FROM captures_metadata").get() as { count: number } | undefined;
	return row?.count ?? 0;
}

/**
 * Get aggregate statistics about captures.
 */
export function getStats(): {
	totalCaptures: number;
	totalSessions: number;
	dateRange: { earliest: number; latest: number };
} {
	const db = getDb();

	// Single query to get all stats at once
	const row = db.prepare(
		"SELECT COUNT(*) as count, COUNT(DISTINCT session_id) as sessions, MIN(timestamp) as earliest, MAX(timestamp) as latest FROM captures_metadata"
	).get() as { count: number; sessions: number; earliest: number | null; latest: number | null } | undefined;

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
 * Delete all capture metadata entries.
 * Used when clearing all captures to ensure the SQLite database is also cleared.
 * @returns Number of deleted records
 */
export function deleteAllCaptures(): number {
	const db = getDb();
	const result = db.prepare("DELETE FROM captures_metadata").run();
	return result.changes;
}

/**
 * Search captures with flexible filters.
 */
export function searchCaptures(query: {
	sessionId?: string;
	model?: string;
	status?: string;
	startDate?: number;
	endDate?: number;
	limit?: number;
	offset?: number;
}): CaptureMetadata[] {
	const db = getDb();

	const conditions: string[] = [];
	const params: (string | number)[] = [];

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
	} else if (query.offset !== undefined) {
		sql += " LIMIT -1";
	}

	if (query.offset !== undefined) {
		sql += " OFFSET ?";
		params.push(query.offset);
	}

	const rows = db.prepare(sql).all(...params) as CaptureMetadataRow[];
	return rows.map(rowToCaptureMetadata);
}
