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
 */
export async function getRedactionMetadataBySessionIdFromDb(
  sessionId: string,
): Promise<import("@contextio/core/db").RedactionMetadata[]> {
  const db = await getDbModule();
  if (sessionId === "unsorted") {
    const dbInstance = db.getDb();
    const rows = dbInstance.prepare("SELECT * FROM redaction_metadata WHERE session_id IS NULL ORDER BY created_at ASC").all() as import("@contextio/core/db").RedactionMetadataRow[];
    return rows.map((row) => ({
      captureId: row.capture_id,
      sessionId: null,
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
    }));
  }
  return db.getRedactionMetadataBySessionId(sessionId);
}

/**
 * Aggregate redaction counts from SQLite, grouped by sessionId.
 */
export async function aggregateRedactionMetaBySessionFromDb(): Promise<
  Map<string, { totalRedactions: number; byRule: Record<string, number> }>
> {
  const db = await getDbModule();
  const dbInstance = db.getDb();
  
  const rows = dbInstance.prepare("SELECT DISTINCT session_id FROM redaction_metadata WHERE session_id IS NOT NULL").all() as { session_id: string }[];
  
  const sessionMap = new Map<
    string,
    { totalRedactions: number; byRule: Record<string, number> }
  >();

  for (const row of rows) {
    const sessionId = row.session_id;
    
    if (sessionId.startsWith("title-")) continue;

    const aggregate = db.aggregateRedactionMetadataBySession(sessionId);
    
    sessionMap.set(sessionId, {
      totalRedactions: aggregate.totalRedactions,
      byRule: aggregate.byRule,
    });
  }

  return sessionMap;
}

/**
 * Get all redaction metadata from SQLite for session grouping.
 */
export async function getAllRedactionMetadataFromDb(): Promise<import("@contextio/core/db").RedactionMetadata[]> {
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
  }));
}