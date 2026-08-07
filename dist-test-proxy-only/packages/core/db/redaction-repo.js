/**
 * Redaction metadata repository for SQLite-backed redaction metadata storage.
 * Replaces file-based .redact-meta.json sidecar files with database operations.
 */
import { getDb } from "./connection.js";
import fs from "node:fs";
import { join } from "node:path";
/**
 * Convert a database row to a RedactionMetadata object.
 */
function rowToRedactionMetadata(row) {
    return {
        captureId: row.capture_id,
        sessionId: row.session_id ?? null,
        ruleCounts: safeJsonParse(row.rule_counts, {}),
        totalRedactions: row.total_redactions,
        encrypted: row.encrypted === 1,
        createdAt: row.created_at,
        updatedAt: row.updated_at,
        source: row.source ?? null,
        provider: row.provider ?? null,
        targetUrl: row.target_url ?? null,
        requestBytes: row.request_bytes ?? undefined,
        responseBytes: row.response_bytes ?? undefined,
        timings: row.timings_total_ms !== null ? {
            send_ms: row.timings_send_ms ?? undefined,
            wait_ms: row.timings_wait_ms ?? undefined,
            receive_ms: row.timings_receive_ms ?? undefined,
            total_ms: row.timings_total_ms ?? undefined,
        } : undefined,
        totalInputTokens: row.total_input_tokens ?? undefined,
        totalOutputTokens: row.total_output_tokens ?? undefined,
        tokensPerSecond: row.tokens_per_second ?? undefined,
        successCount: row.success_count ?? undefined,
        errorCount: row.error_count ?? undefined,
        model: row.model ?? undefined,
    };
}
/**
 * Helper to safely parse JSON columns with fallback.
 */
function safeJsonParse(value, fallback) {
    if (!value)
        return fallback;
    try {
        return JSON.parse(value);
    }
    catch {
        return fallback;
    }
}
/**
 * Convert a RedactionMetadata object to database column values for insert/update.
 */
function redactionMetadataToRow(metadata) {
    return {
        capture_id: metadata.captureId,
        session_id: metadata.sessionId ?? null,
        rule_counts: JSON.stringify(metadata.ruleCounts),
        total_redactions: metadata.totalRedactions,
        encrypted: metadata.encrypted ? 1 : 0,
        source: metadata.source ?? null,
        provider: metadata.provider ?? null,
        target_url: metadata.targetUrl ?? null,
        request_bytes: metadata.requestBytes ?? null,
        response_bytes: metadata.responseBytes ?? null,
        timings_send_ms: metadata.timings?.send_ms ?? null,
        timings_wait_ms: metadata.timings?.wait_ms ?? null,
        timings_receive_ms: metadata.timings?.receive_ms ?? null,
        timings_total_ms: metadata.timings?.total_ms ?? null,
        total_input_tokens: metadata.totalInputTokens ?? null,
        total_output_tokens: metadata.totalOutputTokens ?? null,
        tokens_per_second: metadata.tokensPerSecond ?? null,
        success_count: metadata.successCount ?? null,
        error_count: metadata.errorCount ?? null,
        model: metadata.model ?? null,
    };
}
/** Prepared statement for upserting a single redaction metadata entry. */
const UPSERT_REDACTION_METADATA_SQL = `
	INSERT INTO redaction_metadata (
		capture_id, session_id, rule_counts, total_redactions, encrypted,
		source, provider, target_url, request_bytes, response_bytes,
		timings_send_ms, timings_wait_ms, timings_receive_ms, timings_total_ms,
		total_input_tokens, total_output_tokens, tokens_per_second,
		success_count, error_count, model, created_at, updated_at
	) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
	ON CONFLICT(capture_id) DO UPDATE SET
		session_id = excluded.session_id,
		rule_counts = excluded.rule_counts,
		total_redactions = excluded.total_redactions,
		encrypted = excluded.encrypted,
		source = excluded.source,
		provider = excluded.provider,
		target_url = excluded.target_url,
		request_bytes = excluded.request_bytes,
		response_bytes = excluded.response_bytes,
		timings_send_ms = excluded.timings_send_ms,
		timings_wait_ms = excluded.timings_wait_ms,
		timings_receive_ms = excluded.timings_receive_ms,
		timings_total_ms = excluded.timings_total_ms,
		total_input_tokens = excluded.total_input_tokens,
		total_output_tokens = excluded.total_output_tokens,
		tokens_per_second = excluded.tokens_per_second,
		success_count = excluded.success_count,
		error_count = excluded.error_count,
		model = excluded.model,
		updated_at = strftime('%s','now') * 1000
`;
/**
 * Insert or update a redaction metadata entry.
 * Uses upsert (ON CONFLICT DO UPDATE) to handle both new and existing captures.
 */
export function upsertRedactionMetadata(metadata) {
    const db = getDb();
    const row = redactionMetadataToRow(metadata);
    const stmt = db.prepare(UPSERT_REDACTION_METADATA_SQL);
    stmt.run(row.capture_id, row.session_id, row.rule_counts, row.total_redactions, row.encrypted, row.source, row.provider, row.target_url, row.request_bytes, row.response_bytes, row.timings_send_ms, row.timings_wait_ms, row.timings_receive_ms, row.timings_total_ms, row.total_input_tokens, row.total_output_tokens, row.tokens_per_second, row.success_count, row.error_count, row.model, metadata.createdAt, metadata.updatedAt ?? Date.now());
}
/**
 * Insert or update multiple redaction metadata entries in a single transaction.
 * More efficient than calling upsertRedactionMetadata repeatedly for bulk operations.
 */
export function upsertRedactionMetadataBulk(metadataArray) {
    if (metadataArray.length === 0)
        return;
    const db = getDb();
    const stmt = db.prepare(UPSERT_REDACTION_METADATA_SQL);
    const transaction = db.transaction((items) => {
        for (const metadata of items) {
            const row = redactionMetadataToRow(metadata);
            stmt.run(row.capture_id, row.session_id, row.rule_counts, row.total_redactions, row.encrypted, row.source, row.provider, row.target_url, row.request_bytes, row.response_bytes, row.timings_send_ms, row.timings_wait_ms, row.timings_receive_ms, row.timings_total_ms, row.total_input_tokens, row.total_output_tokens, row.tokens_per_second, row.success_count, row.error_count, row.model, metadata.createdAt, metadata.updatedAt ?? Date.now());
        }
    });
    transaction(metadataArray);
}
/**
 * Get a redaction metadata entry by capture ID.
 * Returns null if not found.
 */
export function getRedactionMetadataByCaptureId(captureId) {
    const db = getDb();
    const row = db.prepare("SELECT * FROM redaction_metadata WHERE capture_id = ?").get(captureId);
    return row ? rowToRedactionMetadata(row) : null;
}
/**
 * Get all redaction metadata entries for a specific session.
 * Ordered by created_at (oldest first).
 */
export function getRedactionMetadataBySessionId(sessionId) {
    const db = getDb();
    const rows = db.prepare("SELECT * FROM redaction_metadata WHERE session_id = ? ORDER BY created_at ASC").all(sessionId);
    return rows.map(rowToRedactionMetadata);
}
/**
 * Get aggregate redaction statistics for a specific session.
 */
export function aggregateRedactionMetadataBySession(sessionId) {
    const db = getDb();
    // Single query to get all stats at once
    const row = db.prepare("SELECT COUNT(*) as totalCaptures, SUM(total_redactions) as totalRedactions, rule_counts FROM redaction_metadata WHERE session_id = ?").get(sessionId);
    // Aggregate rule counts across all captures in the session
    const byRule = {};
    if (row) {
        // We need to aggregate rule_counts from all rows
        const rows = db.prepare("SELECT rule_counts FROM redaction_metadata WHERE session_id = ?").all(sessionId);
        for (const r of rows) {
            const ruleCounts = safeJsonParse(r.rule_counts, {});
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
export function deleteRedactionMetadataByCaptureId(captureId) {
    const db = getDb();
    const result = db.prepare("DELETE FROM redaction_metadata WHERE capture_id = ?").run(captureId);
    if (result.changes === 0) {
        throw new Error(`Redaction metadata with capture_id "${captureId}" not found`);
    }
}
/**
 * Get aggregate statistics across all redaction metadata.
 */
export function getRedactionAggregateStats() {
    const db = getDb();
    const row = db.prepare("SELECT COUNT(*) as totalCaptures, SUM(total_redactions) as totalRedactions FROM redaction_metadata").get();
    // Aggregate rule counts across all captures
    const byRule = {};
    const rows = db.prepare("SELECT rule_counts FROM redaction_metadata").all();
    for (const r of rows) {
        const ruleCounts = safeJsonParse(r.rule_counts, {});
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
 * Extract missing session fields from the capture file.
 * Reads the capture JSON file and extracts source, provider, targetUrl, timings, etc.
 * Handles encrypted capture files by decrypting them first.
 */
async function extractMissingFieldsFromCapture(captureDir, captureId, existingMeta, decryptFn, keyMaterial) {
    const captureFilepath = join(captureDir, `${captureId}.json`);
    const missing = {};
    try {
        let capture;
        const raw = fs.readFileSync(captureFilepath, "utf8");
        // Check if the capture file is encrypted (has the encrypted payload structure)
        const parsed = JSON.parse(raw);
        const isEncrypted = typeof parsed.ciphertext === "string" &&
            typeof parsed.salt === "string" &&
            typeof parsed.iv === "string";
        if (isEncrypted) {
            // Decrypt the capture file using the same key as the logger plugin
            if (!keyMaterial) {
                console.warn(`[redaction-repo] Capture file ${captureId}.json is encrypted but no key material available`);
                return missing;
            }
            if (!decryptFn) {
                console.warn(`[redaction-repo] Capture file ${captureId}.json is encrypted but no decrypt function provided`);
                return missing;
            }
            try {
                const plaintext = await decryptFn(raw, keyMaterial);
                capture = JSON.parse(plaintext);
            }
            catch (e) {
                console.warn(`[redaction-repo] Failed to decrypt capture file ${captureId}.json: ${e instanceof Error ? e.message : String(e)}`);
                return missing;
            }
        }
        else {
            capture = parsed;
        }
        // Extract fields from capture if missing in sidecar
        const isMissingOrEmpty = (val) => val === undefined || val === null || val === "";
        const hasValue = (val) => val !== undefined && val !== null && val !== "";
        if (isMissingOrEmpty(existingMeta.source) && hasValue(capture.source)) {
            missing.source = capture.source;
        }
        if (isMissingOrEmpty(existingMeta.provider) && hasValue(capture.provider)) {
            missing.provider = capture.provider;
        }
        if (isMissingOrEmpty(existingMeta.targetUrl) && hasValue(capture.targetUrl)) {
            missing.targetUrl = capture.targetUrl;
        }
        if (isMissingOrEmpty(existingMeta.requestBytes) && hasValue(capture.requestBytes)) {
            missing.requestBytes = capture.requestBytes;
        }
        if (isMissingOrEmpty(existingMeta.responseBytes) && hasValue(capture.responseBytes)) {
            missing.responseBytes = capture.responseBytes;
        }
        if (isMissingOrEmpty(existingMeta.timings) && capture.timings && typeof capture.timings === "object") {
            const t = capture.timings;
            missing.timings = {
                send_ms: typeof t.send_ms === "number" ? t.send_ms : undefined,
                wait_ms: typeof t.wait_ms === "number" ? t.wait_ms : undefined,
                receive_ms: typeof t.receive_ms === "number" ? t.receive_ms : undefined,
                total_ms: typeof t.total_ms === "number" ? t.total_ms : undefined,
            };
        }
        if (isMissingOrEmpty(existingMeta.totalInputTokens) && hasValue(capture.totalInputTokens)) {
            missing.totalInputTokens = capture.totalInputTokens;
        }
        if (isMissingOrEmpty(existingMeta.totalOutputTokens) && hasValue(capture.totalOutputTokens)) {
            missing.totalOutputTokens = capture.totalOutputTokens;
        }
        if (isMissingOrEmpty(existingMeta.tokensPerSecond) && hasValue(capture.tokensPerSecond)) {
            missing.tokensPerSecond = capture.tokensPerSecond;
        }
        if (isMissingOrEmpty(existingMeta.successCount) && hasValue(capture.successCount)) {
            missing.successCount = capture.successCount;
        }
        if (isMissingOrEmpty(existingMeta.errorCount) && hasValue(capture.errorCount)) {
            missing.errorCount = capture.errorCount;
        }
        if (isMissingOrEmpty(existingMeta.model) && hasValue(capture.model)) {
            missing.model = capture.model;
        }
    }
    catch (err) {
        // Log error for diagnostics but don't fail the import - return what we have
        console.warn(`[redaction-repo] Failed to read capture file ${captureId}.json for missing field extraction: ${err instanceof Error ? err.message : String(err)}`);
    }
    return missing;
}
/**
 * Import existing .redact-meta.json sidecar files into the SQLite database.
 * This is used for one-time migration from file-based to SQLite storage.
 *
 * @param captureDir - Path to the capture directory containing .redact-meta.json files
 * @param decryptFn - Optional decryption function (e.g., from @contextio/logger) for encrypted metadata files
 * @returns Number of metadata files imported
 */
export async function importRedactionMetaFromFiles(captureDir, decryptFn) {
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
            // Extract captureId from filename (remove .redact-meta.json suffix)
            const captureId = filename.replace(/\.redact-meta\.json$/, "");
            try {
                const raw = fs.readFileSync(filepath, "utf8");
                const meta = JSON.parse(raw);
                // Handle encrypted metadata files
                let parsedMeta = meta;
                const isEncrypted = typeof meta.ciphertext === "string" &&
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
                        parsedMeta = JSON.parse(plaintext);
                    }
                    catch (e) {
                        console.warn(`[redaction-repo] Failed to decrypt ${filename}: ${e instanceof Error ? e.message : String(e)}`);
                        continue;
                    }
                }
                // Build RedactionMetadata from parsed meta
                const metadata = {
                    captureId,
                    sessionId: typeof parsedMeta.sessionId === "string" ? parsedMeta.sessionId : null,
                    ruleCounts: parsedMeta.byRule ?? {},
                    totalRedactions: typeof parsedMeta.totalRedactions === "number" ? parsedMeta.totalRedactions : 0,
                    encrypted: isEncrypted,
                    createdAt: typeof parsedMeta.generatedAt === "string" ? new Date(parsedMeta.generatedAt).getTime() : Date.now(),
                    updatedAt: Date.now(),
                    // Include all session fields from parsedMeta if present
                    source: typeof parsedMeta.source === "string" ? parsedMeta.source : (parsedMeta.source === null ? null : undefined),
                    provider: typeof parsedMeta.provider === "string" ? parsedMeta.provider : (parsedMeta.provider === null ? null : undefined),
                    targetUrl: typeof parsedMeta.targetUrl === "string" ? parsedMeta.targetUrl : (parsedMeta.targetUrl === null ? null : undefined),
                    requestBytes: typeof parsedMeta.requestBytes === "number" ? parsedMeta.requestBytes : undefined,
                    responseBytes: typeof parsedMeta.responseBytes === "number" ? parsedMeta.responseBytes : undefined,
                    timings: parsedMeta.timings && typeof parsedMeta.timings === "object" ? {
                        send_ms: typeof parsedMeta.timings.send_ms === "number" ? parsedMeta.timings.send_ms : undefined,
                        wait_ms: typeof parsedMeta.timings.wait_ms === "number" ? parsedMeta.timings.wait_ms : undefined,
                        receive_ms: typeof parsedMeta.timings.receive_ms === "number" ? parsedMeta.timings.receive_ms : undefined,
                        total_ms: typeof parsedMeta.timings.total_ms === "number" ? parsedMeta.timings.total_ms : undefined,
                    } : undefined,
                    totalInputTokens: typeof parsedMeta.totalInputTokens === "number" ? parsedMeta.totalInputTokens : undefined,
                    totalOutputTokens: typeof parsedMeta.totalOutputTokens === "number" ? parsedMeta.totalOutputTokens : undefined,
                    tokensPerSecond: typeof parsedMeta.tokensPerSecond === "number" ? parsedMeta.tokensPerSecond : undefined,
                    successCount: typeof parsedMeta.successCount === "number" ? parsedMeta.successCount : undefined,
                    errorCount: typeof parsedMeta.errorCount === "number" ? parsedMeta.errorCount : undefined,
                    model: typeof parsedMeta.model === "string" ? parsedMeta.model : (parsedMeta.model === null ? null : undefined),
                };
                // Extract missing fields from capture file (source, provider, targetUrl, timings, etc.)
                const keyMaterial = process.env.CONTEXTIO_LOGGER_ENCRYPTION_KEY;
                const missingFields = await extractMissingFieldsFromCapture(captureDir, captureId, parsedMeta, decryptFn, keyMaterial);
                Object.assign(metadata, missingFields);
                upsertRedactionMetadata(metadata);
                // Delete the metadata file after successful import to prevent reprocessing on container restart
                fs.unlinkSync(filepath);
                imported++;
                console.log(`[redaction-repo] Imported redaction metadata for ${captureId} and removed source file`);
            }
            catch (err) {
                // Check if file was deleted between listing and reading (race condition with cleanup)
                const isNotFoundError = err instanceof Error &&
                    (err.message.includes("ENOENT") || err.message.includes("no such file or directory"));
                if (isNotFoundError) {
                    console.warn(`[redaction-repo] Skipping ${filename}: file was deleted before import (likely cleaned up)`);
                }
                else {
                    console.warn(`[redaction-repo] Failed to import redaction metadata from ${filename}: ${err instanceof Error ? err.message : String(err)}`);
                }
            }
        }
        return imported;
    }
    catch (err) {
        console.error(`[redaction-repo] Failed to read capture directory ${captureDir}: ${err instanceof Error ? err.message : String(err)}`);
        return 0;
    }
}
/**
 * Check if redaction metadata exists for a capture ID.
 */
export function redactionMetadataExists(captureId) {
    const db = getDb();
    const row = db.prepare("SELECT 1 FROM redaction_metadata WHERE capture_id = ?").get(captureId);
    return row !== undefined;
}
//# sourceMappingURL=redaction-repo.js.map