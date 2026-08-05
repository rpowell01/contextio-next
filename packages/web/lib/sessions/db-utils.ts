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
  tokensPerSecond?: number;
  successCount?: number;
  errorCount?: number;
  model?: string | null;
} | null> {
  const db = await getDbModule();
  const meta = db.getRedactionMetadataByCaptureId(captureId);
  if (!meta) return null;

  return {
    totalRedactions: meta.totalRedactions,
    byRule: meta.ruleCounts,
    sessionId: meta.sessionId,
    provider: undefined,
    targetUrl: undefined,
    timestamp: undefined,
    generatedAt: new Date(meta.createdAt).toISOString(),
    source: undefined,
    requestBytes: undefined,
    responseBytes: undefined,
    timings: undefined,
    totalInputTokens: undefined,
    totalOutputTokens: undefined,
    tokensPerSecond: undefined,
    successCount: undefined,
    errorCount: undefined,
    model: undefined,
  };
}

/**
 * Get all redaction metadata for a specific session from SQLite.
 */
export async function getRedactionMetadataBySessionIdFromDb(
  sessionId: string,
): Promise<import("@contextio/core/db").RedactionMetadata[]> {
  const db = await getDbModule();
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
  }));
}