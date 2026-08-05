/**
 * Redaction metadata repository for SQLite-backed redaction metadata storage.
 * Replaces file-based .redact-meta.json sidecar files with database operations.
 */

import { getDb } from "./connection.js";
import fs from "node:fs";
import { join } from "node:path";

/**
 * Database row type for redaction_metadata table.
 * Matches the schema in 002_redaction_metadata.sql
 */
export interface RedactionMetadataRow {
	capture_id: string;
	session_id: string | null;
	rule_counts: string; // JSON: rule_name -> count
	total_redactions: number;
	encrypted: number;
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
}

export interface SessionRedactionAggregate {
	sessionId: string;
	totalCaptures: number;
	totalRedactions: number;
	byRule: Record<string, number>;
}

/**
 * Convert a database row to a RedactionMetadata object.
 */
function rowToRedactionMetadata(row: RedactionMetadataRow): RedactionMetadata {
	return {
		captureId: row.capture_id,
		sessionId: row.session_id ?? null,
		ruleCounts: safeJsonParse(row.rule_counts, {}),
		totalRedactions: row.total_redactions,
		encrypted: row.encrypted === 1,
		createdAt: row.created_at,
		updatedAt: row.updated_at,
	};
}

/**
 * Helper to safely parse JSON columns with fallback.
 */
function safeJsonParse<T>(value: string, fallback: T): T {
	if (!value) return fallback;
	try {
		return JSON.parse(value) as T;
	} catch {
		return fallback;
	}
}

/**
 * Convert a RedactionMetadata object to database column values for insert/update.
 */
function redactionMetadataToRow(
	metadata: RedactionMetadata,
): Omit<RedactionMetadataRow, "created_at" | "updated_at"> {
	return {
		capture_id: metadata.captureId,
		session_id: metadata.sessionId ?? null,
		rule_counts: JSON.stringify(metadata.ruleCounts),
		total_redactions: metadata.totalRedactions,
		encrypted: metadata.encrypted ? 1 : 0,
	};
}

/** Prepared statement for upserting a single redaction metadata entry. */
const UPSERT_REDACTION_METADATA_SQL = `
	INSERT INTO redaction_metadata (
		capture_id, session_id, rule_counts, total_redactions, encrypted, created_at
	) VALUES (?, ?, ?, ?, ?, ?)
	ON CONFLICT(capture_id) DO UPDATE SET
		session_id = excluded.session_id,
		rule_counts = excluded.rule_counts,
		total_redactions = excluded.total_redactions,
		encrypted = excluded.encrypted,
		updated_at = strftime('%s','now') * 1000
`;

/**
 * Insert or update a redaction metadata entry.
 * Uses upsert (ON CONFLICT DO UPDATE) to handle both new and existing captures.
 */
export function upsertRedactionMetadata(metadata: RedactionMetadata): void {
	const db = getDb();
	const row = redactionMetadataToRow(metadata);

	const stmt = db.prepare(UPSERT_REDACTION_METADATA_SQL);

	stmt.run(
		row.capture_id,
		row.session_id,
		row.rule_counts,
		row.total_redactions,
		row.encrypted,
		metadata.createdAt,
	);
}

/**
 * Insert or update multiple redaction metadata entries in a single transaction.
 * More efficient than calling upsertRedactionMetadata repeatedly for bulk operations.
 */
export function upsertRedactionMetadataBulk(metadataArray: RedactionMetadata[]): void {
	if (metadataArray.length === 0) return;

	const db = getDb();
	const stmt = db.prepare(UPSERT_REDACTION_METADATA_SQL);

	const transaction = db.transaction((items: RedactionMetadata[]) => {
		for (const metadata of items) {
			const row = redactionMetadataToRow(metadata);
			stmt.run(
				row.capture_id,
				row.session_id,
				row.rule_counts,
				row.total_redactions,
				row.encrypted,
				metadata.createdAt,
			);
		}
	});

	transaction(metadataArray);
}

/**
 * Get a redaction metadata entry by capture ID.
 * Returns null if not found.
 */
export function getRedactionMetadataByCaptureId(captureId: string): RedactionMetadata | null {
	const db = getDb();
	const row = db.prepare("SELECT * FROM redaction_metadata WHERE capture_id = ?").get(captureId) as RedactionMetadataRow | undefined;
	return row ? rowToRedactionMetadata(row) : null;
}

/**
 * Get all redaction metadata entries for a specific session.
 * Ordered by created_at (oldest first).
 */
export function getRedactionMetadataBySessionId(sessionId: string): RedactionMetadata[] {
	const db = getDb();
	const rows = db.prepare("SELECT * FROM redaction_metadata WHERE session_id = ? ORDER BY created_at ASC").all(sessionId) as RedactionMetadataRow[];
	return rows.map(rowToRedactionMetadata);
}

/**
 * Get aggregate redaction statistics for a specific session.
 */
export function aggregateRedactionMetadataBySession(sessionId: string): SessionRedactionAggregate {
	const db = getDb();

	// Single query to get all stats at once
	const row = db.prepare(
		"SELECT COUNT(*) as totalCaptures, SUM(total_redactions) as totalRedactions, rule_counts FROM redaction_metadata WHERE session_id = ?"
	).get(sessionId) as { totalCaptures: number; totalRedactions: number | null; rule_counts: string | null } | undefined;

// Aggregate rule counts across all captures in the session
		const byRule: Record<string, number> = {};
		if (row) {
			// We need to aggregate rule_counts from all rows
			const rows = db.prepare("SELECT rule_counts FROM redaction_metadata WHERE session_id = ?").all(sessionId) as { rule_counts: string }[];
			for (const r of rows) {
				const ruleCounts = safeJsonParse<Record<string, number>>(r.rule_counts, {});
				for (const [rule, count] of Object.entries(ruleCounts)) {
					byRule[rule] = (byRule[rule] ?? 0) + count;
				}
			}
		}

	return {
		sessionId,
		totalCaptures: row?.totalCaptures ?? 0,
		totalRedactions: row?.totalRedactions ?? 0,
		byRule,
	};
}

/**
 * Delete a redaction metadata entry by capture ID.
 */
export function deleteRedactionMetadataByCaptureId(captureId: string): void {
	const db = getDb();
	const result = db.prepare("DELETE FROM redaction_metadata WHERE capture_id = ?").run(captureId);
	if (result.changes === 0) {
		throw new Error(`Redaction metadata with capture_id "${captureId}" not found`);
	}
}

/**
 * Get aggregate statistics across all redaction metadata.
 */
export function getRedactionAggregateStats(): {
	totalCaptures: number;
	totalRedactions: number;
	byRule: Record<string, number>;
} {
	const db = getDb();

	const row = db.prepare(
		"SELECT COUNT(*) as totalCaptures, SUM(total_redactions) as totalRedactions FROM redaction_metadata"
	).get() as { totalCaptures: number; totalRedactions: number | null } | undefined;

	// Aggregate rule counts across all captures
	const byRule: Record<string, number> = {};
	const rows = db.prepare("SELECT rule_counts FROM redaction_metadata").all() as { rule_counts: string }[];
	for (const r of rows) {
		const ruleCounts = safeJsonParse<Record<string, number>>(r.rule_counts, {});
		for (const [rule, count] of Object.entries(ruleCounts)) {
			byRule[rule] = (byRule[rule] ?? 0) + count;
		}
	}

	return {
		totalCaptures: row?.totalCaptures ?? 0,
		totalRedactions: row?.totalRedactions ?? 0,
		byRule,
	};
}

/**
 * Import existing .redact-meta.json sidecar files into the SQLite database.
 * This is used for one-time migration from file-based to SQLite storage.
 *
 * @param captureDir - Path to the capture directory containing .redact-meta.json files
 * @param decryptFn - Optional decryption function (e.g., from @contextio/logger) for encrypted metadata files
 * @returns Number of metadata files imported
 */
export async function importRedactionMetaFromFiles(
	captureDir: string,
	decryptFn?: (encryptedJson: string, keyMaterial: string) => Promise<string>,
): Promise<number> {
	if (!fs.existsSync(captureDir)) {
		console.log(`[redaction-repo] Capture directory not found at ${captureDir}, skipping import`);
		return 0;
	}

	try {
		const files = fs.readdirSync(captureDir);
		const metaFiles = files.filter((f) => f.endsWith(".redact-meta.json"));

		let imported = 0;

		for (const filename of metaFiles) {
			const filepath = join(captureDir, filename);
			try {
				const raw = fs.readFileSync(filepath, "utf8");
				const meta = JSON.parse(raw) as Record<string, unknown>;

				// Extract captureId from filename (remove .redact-meta.json suffix)
				const captureId = filename.replace(/\.redact-meta\.json$/, "");

				// Handle encrypted metadata files
				let parsedMeta: Record<string, unknown> = meta;
				const isEncrypted =
					typeof meta.ciphertext === "string" &&
					typeof meta.salt === "string" &&
					typeof meta.iv === "string";

				if (isEncrypted) {
					// Try to decrypt using the same key as the logger plugin
					const keyMaterial = process.env.CONTEXTIO_LOGGER_ENCRYPTION_KEY;
					if (!keyMaterial) {
						console.warn(`[redaction-repo] Encryption enabled but CONTEXTIO_LOGGER_ENCRYPTION_KEY not set, skipping ${filename}`);
						continue;
					}
					try {
						if (!decryptFn) {
							throw new Error("Decryption function not provided");
						}
						const plaintext = await decryptFn(raw, keyMaterial);
						parsedMeta = JSON.parse(plaintext) as Record<string, unknown>;
					} catch (e) {
						console.warn(`[redaction-repo] Failed to decrypt ${filename}: ${e instanceof Error ? e.message : String(e)}`);
						continue;
					}
				}

				// Build RedactionMetadata from parsed meta
				const metadata: RedactionMetadata = {
					captureId,
					sessionId: typeof parsedMeta.sessionId === "string" ? parsedMeta.sessionId : null,
					ruleCounts: (parsedMeta.byRule as Record<string, number>) ?? {},
					totalRedactions: typeof parsedMeta.totalRedactions === "number" ? parsedMeta.totalRedactions : 0,
					encrypted: isEncrypted,
					createdAt: typeof parsedMeta.generatedAt === "string" ? new Date(parsedMeta.generatedAt).getTime() : Date.now(),
					updatedAt: Date.now(),
				};

				upsertRedactionMetadata(metadata);
				imported++;
				console.log(`[redaction-repo] Imported redaction metadata for ${captureId}`);
			} catch (err) {
				console.warn(`[redaction-repo] Failed to import redaction metadata from ${filename}: ${err instanceof Error ? err.message : String(err)}`);
			}
		}

		return imported;
	} catch (err) {
		console.error(`[redaction-repo] Failed to read capture directory ${captureDir}: ${err instanceof Error ? err.message : String(err)}`);
		return 0;
	}
}

/**
 * Check if redaction metadata exists for a capture ID.
 */
export function redactionMetadataExists(captureId: string): boolean {
	const db = getDb();
	const row = db.prepare("SELECT 1 FROM redaction_metadata WHERE capture_id = ?").get(captureId);
	return row !== undefined;
}