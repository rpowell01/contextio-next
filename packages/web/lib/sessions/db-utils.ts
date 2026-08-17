"use server";

import "server-only";

/**
 * Server-only database utilities for redaction metadata.
 * This module is only imported by API routes and server components.
 */

let dbModule: typeof import("@contextio/core/db") | null = null;

async function getDbModule() {
  if (!dbModule) {
    dbModule = await import("@contextio/core/db");
  }
  return dbModule;
}

/**
 * Columns to select for bulk operations (excludes the large `matches` column).
 * The `matches` column contains detailed redaction match data (pre/post values, paths)
 * which can be huge when there are many false positives from Presidio LLM redaction.
 * This column is only needed when viewing details for a specific capture.
 */
const REDACTION_METADATA_BULK_COLUMNS = `
  capture_id,
  session_id,
  rule_counts,
  total_redactions,
  encrypted,
  source,
  provider,
  target_url,
  request_bytes,
  response_bytes,
  timings_send_ms,
  timings_wait_ms,
  timings_receive_ms,
  timings_total_ms,
  total_input_tokens,
  total_output_tokens,
  tokens_per_second,
  success_count,
  error_count,
  model,
  created_at,
  updated_at
`;

/**
 * Map a database row (without matches) to RedactionMetadata object.
 */
function mapRowToRedactionMetadataNoMatches(row: {
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
}): import("@contextio/core/db").RedactionMetadata {
  return {
    captureId: row.capture_id,
    sessionId: row.session_id ?? null,
    ruleCounts: JSON.parse(row.rule_counts || "{}"),
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
 * Get redaction metadata for a specific capture by captureId from SQLite.
 */
export async function getRedactionMetadataByCaptureIdFromDb(
  captureId: string,
): Promise<{
  totalRedactions: number;
  byRule: Record<string, number>;
  sessionId: string | null;
  provider?: string;
  targetUrl?: string;
  timestamp?: string;
  generatedAt?: string;
  source?: string | null;
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
  totalTokens?: {
    input: number;
    output: number;
    total: number;
  };
  tokensPerSecond?: number;
  successCount?: number;
  errorCount?: number;
  model?: string | null;
  captureId: string;
  // Actual redaction matches with pre/post values from SQLite
  matches?: Array<{
    ruleId: string;
    preValue: string;
    postValue: string;
    path: string;
  }>;
} | null> {
  const db = await getDbModule();
  const meta = db.getRedactionMetadataByCaptureId(captureId);
  if (!meta) return null;

  return {
    totalRedactions: meta.totalRedactions,
    byRule: meta.ruleCounts,
    sessionId: meta.sessionId,
    provider: meta.provider ?? undefined,
    targetUrl: meta.targetUrl ?? undefined,
    timestamp: meta.createdAt ? new Date(meta.createdAt).toISOString() : undefined,
    generatedAt: meta.createdAt ? new Date(meta.createdAt).toISOString() : undefined,
    source: meta.source ?? undefined,
    requestBytes: meta.requestBytes ?? undefined,
    responseBytes: meta.responseBytes ?? undefined,
    timings: meta.timings ?? undefined,
    totalInputTokens: meta.totalInputTokens ?? undefined,
    totalOutputTokens: meta.totalOutputTokens ?? undefined,
    totalTokens:
      meta.totalInputTokens !== undefined && meta.totalOutputTokens !== undefined
        ? {
            input: meta.totalInputTokens,
            output: meta.totalOutputTokens,
            total: meta.totalInputTokens + meta.totalOutputTokens,
          }
        : undefined,
    tokensPerSecond: meta.tokensPerSecond ?? undefined,
    successCount: meta.successCount ?? undefined,
    errorCount: meta.errorCount ?? undefined,
    model: meta.model ?? undefined,
    captureId,
    // Include matches from SQLite for precise diff highlighting
    matches: meta.matches ?? undefined,
  };
}

/**
 * Get all redaction metadata for a specific session from SQLite.
 * Use sessionId "unsorted" to query for captures with NULL session_id.
 * This function uses the optimized query (without matches) for the "unsorted" case.
 */
export async function getRedactionMetadataBySessionIdFromDb(
  sessionId: string,
): Promise<import("@contextio/core/db").RedactionMetadata[]> {
  const db = await getDbModule();
  if (sessionId === "unsorted") {
    const dbInstance = db.getDb();
    const rows = dbInstance.prepare(`SELECT ${REDACTION_METADATA_BULK_COLUMNS} FROM redaction_metadata WHERE session_id IS NULL ORDER BY created_at ASC`).all() as Array<{
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
    }>;
    return rows.map(mapRowToRedactionMetadataNoMatches);
  }
  return db.getRedactionMetadataBySessionId(sessionId);
}

/**
 * Aggregate redaction counts from SQLite, grouped by sessionId.
 * Optimized to avoid loading the massive `matches` column.
 */
export async function aggregateRedactionMetaBySessionFromDb(): Promise<
  Map<string, { totalRedactions: number; byRule: Record<string, number> }>
> {
  const db = await getDbModule();
  const dbInstance = db.getDb();
  
  // Get all distinct session IDs in a single query
  const sessionRows = dbInstance.prepare("SELECT DISTINCT session_id FROM redaction_metadata WHERE session_id IS NOT NULL AND session_id NOT LIKE 'title-%'").all() as { session_id: string }[];
  
  const sessionMap = new Map<
    string,
    { totalRedactions: number; byRule: Record<string, number> }
  >();

  // Use a single query per session to aggregate (still more efficient than loading all rows)
  // But we can optimize further by doing it in one query if needed
  for (const row of sessionRows) {
    const sessionId = row.session_id;
    
    const aggregate = db.aggregateRedactionMetadataBySession(sessionId);
    
    sessionMap.set(sessionId, {
      totalRedactions: aggregate.totalRedactions,
      byRule: aggregate.byRule,
    });
  }

  return sessionMap;
}

/**
 * Get all redaction metadata from SQLite for session grouping (optimized).
 * Excludes the `matches` column which can be massive when there are many
 * false positives from Presidio LLM redaction.
 */
export async function getAllRedactionMetadataFromDb(): Promise<import("@contextio/core/db").RedactionMetadata[]> {
  const db = await getDbModule();
  const dbInstance = db.getDb();
  const rows = dbInstance.prepare(`SELECT ${REDACTION_METADATA_BULK_COLUMNS} FROM redaction_metadata ORDER BY created_at ASC`).all() as Array<{
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
  }>;
  
  return rows.map(mapRowToRedactionMetadataNoMatches);
}

/**
 * Get all redaction metadata from SQLite INCLUDING the `matches` column.
 * Only use this when you actually need the detailed match data (pre/post values, paths)
 * for a specific capture or small set of captures.
 * WARNING: This can be very slow and memory-intensive if there are many captures
 * with large matches arrays.
 */
export async function getAllRedactionMetadataFromDbWithMatches(): Promise<import("@contextio/core/db").RedactionMetadata[]> {
  const db = await getDbModule();
  const dbInstance = db.getDb();
  const rows = dbInstance.prepare("SELECT * FROM redaction_metadata ORDER BY created_at ASC").all() as import("@contextio/core/db").RedactionMetadataRow[];
  
  return rows.map((row) => ({
    captureId: row.capture_id,
    sessionId: row.session_id ?? null,
    ruleCounts: JSON.parse(row.rule_counts || "{}"),
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
    matches: row.matches ? JSON.parse(row.matches) : undefined,
  }));
}