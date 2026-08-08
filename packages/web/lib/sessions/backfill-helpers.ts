import { type RedactionMetadata } from "@contextio/core/db";
import { type TokenUsageResult } from "@/lib/sessions/utils";

/**
 * Lean statistics for redaction metadata.
 * - Route caller (packages/web/app/api/admin/backfill-redaction-meta/route.ts): provides matches with renamed fields (preValue/postValue)
 * - Root script caller (scripts/backfill-redaction-meta.ts): provides matches with renamed fields (preValue/postValue)
 * - Web package script caller (packages/web/scripts/backfill-redaction-meta.ts): provides only totalRedactions and byRule (no matches)
 */
export interface LeanStats {
  totalRedactions: number;
  byRule: Record<string, number>;
  matches?: Array<{ ruleId: string; preValue: string; postValue: string; path: string }>;
}

/**
 * Build the canonical RedactionMetadata object from capture data.
 * This is the single source of truth for metadata fields.
 * Returns both the RedactionMetadata for SQLite and the original timestamp string for JSON sidecar.
 */
export function buildRedactionMetadata(params: {
  captureId: string;
  data: Record<string, unknown>;
  leanStats: LeanStats;
  tokenUsage: TokenUsageResult;
  tokensPerSecond: number;
  successCount: number;
  errorCount: number;
}): { metadata: RedactionMetadata; originalTimestamp: string | null } {
  const { captureId, data, leanStats, tokenUsage, tokensPerSecond, successCount, errorCount } = params;
  const originalTimestamp = typeof data.timestamp === "string" ? data.timestamp : null;
  const totalMs = data.timings && typeof data.timings === "object"
    ? (typeof (data.timings as Record<string, unknown>).total_ms === "number" ? (data.timings as Record<string, unknown>).total_ms as number : 0)
    : 0;

  const metadata: RedactionMetadata = {
    captureId,
    sessionId: typeof data.sessionId === "string" ? data.sessionId : null,
    ruleCounts: leanStats.byRule,
    totalRedactions: leanStats.totalRedactions,
    encrypted: false,
    createdAt: originalTimestamp ? new Date(originalTimestamp).getTime() : Date.now(),
    updatedAt: Date.now(),
    source: typeof data.source === "string" ? data.source : null,
    provider: typeof data.provider === "string" ? data.provider : null,
    targetUrl: typeof data.targetUrl === "string" ? data.targetUrl : null,
    requestBytes: typeof data.requestBytes === "number" ? data.requestBytes : 0,
    responseBytes: typeof data.responseBytes === "number" ? data.responseBytes : 0,
    timings: { total_ms: totalMs },
    totalInputTokens: tokenUsage.input,
    totalOutputTokens: tokenUsage.output,
    tokensPerSecond: Number(tokensPerSecond.toFixed(2)),
    successCount,
    errorCount,
    model: tokenUsage.model,
  };

  return { metadata, originalTimestamp };
}

/**
 * Convert RedactionMetadata to the JSON sidecar format.
 * Handles format differences: string timestamps vs epoch ms, spread vs explicit fields.
 * Uses the original timestamp string from capture data to preserve format compatibility.
 */
export function metadataToJsonSidecar(
  metadata: RedactionMetadata,
  leanStats: LeanStats,
  originalTimestamp: string | null
): Record<string, unknown> {
  return {
    captureId: metadata.captureId,
    sessionId: metadata.sessionId,
    timestamp: originalTimestamp,
    provider: metadata.provider,
    targetUrl: metadata.targetUrl,
    source: metadata.source,
    timings: metadata.timings ? { total_ms: metadata.timings.total_ms ?? 0 } : { total_ms: 0 },
    requestBytes: metadata.requestBytes ?? 0,
    responseBytes: metadata.responseBytes ?? 0,
    totalInputTokens: metadata.totalInputTokens ?? 0,
    totalOutputTokens: metadata.totalOutputTokens ?? 0,
    tokensPerSecond: metadata.tokensPerSecond ?? 0,
    successCount: metadata.successCount ?? 0,
    errorCount: metadata.errorCount ?? 0,
    model: metadata.model,
    ...leanStats,
  };
}