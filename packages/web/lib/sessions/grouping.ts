import type { SessionSummary, SessionMetrics } from "@/types/api";
import {
  computeContextValues,
  computeTokenUsage,
} from "@/lib/sessions/utils";
import {
  countRedactionsInResponse,
  getCaptureRedactionStats,
} from "@/lib/sessions/redaction-utils";
import type { CaptureRedactionStats } from "@/lib/sessions/redaction-utils";
import { ruleNameToPlaceholder } from "@/lib/sessions/placeholder-map";

export interface RawCaptureData extends Record<string, unknown> {
  sessionId: string | null;
  source: string | null;
  provider: string;
  apiFormat?: string;
  targetUrl: string;
  requestBytes: number;
  responseBytes: number;
  timings: { total_ms: number };
  timestamp: string;
  requestBody?: unknown;
  responseBody?: string;
  responseStatus?: number;
  responseIsStreaming?: boolean;
  redactionStats?: {
    totalRedactions: number;
    byRule: Record<string, number>;
  };
  filename?: string;
}

/**
 * Group captures by session ID and compute summary metrics.
 * Uses pre-aggregated redaction metadata when provided to avoid rescanning captures.
 */

export function groupCapturesIntoSessions(
  captures: RawCaptureData[],
  redactionMetaBySession?: Map<
    string,
    { totalRedactions: number; byRule: Record<string, number> }
  >,
): {
  summaries: SessionSummary[];
  metrics: Record<string, SessionMetrics>;
} {
  const sessionGroups = new Map<string, RawCaptureData[]>();

  // Group captures by session ID
  for (const capture of captures) {
    const sessionId = capture.sessionId || "unsorted";
    if (!sessionGroups.has(sessionId)) {
      sessionGroups.set(sessionId, []);
    }
    sessionGroups.get(sessionId)!.push(capture);
  }

  const summaries: SessionSummary[] = [];
  const metrics: Record<string, SessionMetrics> = {};

  for (const [sessionId, sessionCaptures] of Array.from(
    sessionGroups.entries(),
  )) {
    // Calculate totals
    let totalRequestBytes = 0;
    let totalResponseBytes = 0;
    let totalTimeMs = 0;
    let totalContextValues = 0;
    let totalInputTokens = 0;
    let totalOutputTokens = 0;

    let firstTimestamp = "";
    let lastTimestamp = "";

    for (const c of sessionCaptures) {
      totalRequestBytes += c.requestBytes;
      totalResponseBytes += c.responseBytes;
      totalTimeMs += c.timings.total_ms;

      if (!firstTimestamp || c.timestamp < firstTimestamp) {
        firstTimestamp = c.timestamp;
      }
      if (!lastTimestamp || c.timestamp > lastTimestamp) {
        lastTimestamp = c.timestamp;
      }

      // Count context values from request body
      totalContextValues += computeContextValues(c.requestBody).count;

      const usage = computeTokenUsage(c.responseBody, c.requestBody);
      totalInputTokens += usage.input;
      totalOutputTokens += usage.output;
    }

    // Use pre-aggregated redaction metadata if available
    let totalRedactions = 0;
    const byPlaceholder: Record<string, number> = {};
    if (
      redactionMetaBySession &&
      redactionMetaBySession.has(sessionId)
    ) {
      const meta = redactionMetaBySession.get(sessionId)!;
      totalRedactions = meta.totalRedactions;
      // Convert rule names to placeholder names for consistency with redactions page
      for (const [rule, count] of Object.entries(meta.byRule)) {
        const placeholder = ruleNameToPlaceholder(rule);
        byPlaceholder[placeholder] = (byPlaceholder[placeholder] ?? 0) + count;
      }
    } else {
      // Fallback: compute from captures (legacy behavior)
      for (const c of sessionCaptures) {
        const cachedStats = getCaptureRedactionStats(
          c as unknown as Record<string, unknown>,
        );
        const redactionCounts: CaptureRedactionStats =
          cachedStats ??
          countRedactionsInResponse(
            c.responseBody,
            c.requestBody,
            false,
          );
        totalRedactions += redactionCounts.totalRedactions;
        for (const [rule, count] of Object.entries(
          redactionCounts.byRule,
        )) {
          const placeholder = ruleNameToPlaceholder(rule);
          byPlaceholder[placeholder] = (byPlaceholder[placeholder] ?? 0) + count;
        }
      }
    }

    // Compute throughput (bytes/sec)
    const timeSec = totalTimeMs / 1000 || 1;
    const inboundThroughput = totalRequestBytes / timeSec;
    const outboundThroughput = totalResponseBytes / timeSec;

    const firstCapture = sessionCaptures[0];
    const source = firstCapture?.source || "unknown";
    const destination = firstCapture?.provider || "unknown";

    summaries.push({
      sessionId,
      source,
      destination,
      captureCount: sessionCaptures.length,
      totalRequestBytes,
      totalResponseBytes,
      totalTimeMs,
      firstTimestamp,
      lastTimestamp,
      tokenUsage:
        totalInputTokens + totalOutputTokens > 0
          ? {
              input: totalInputTokens,
              output: totalOutputTokens,
              total: totalInputTokens + totalOutputTokens,
            }
          : undefined,
    });

    const captureCount = sessionCaptures.length;
    const tokensPerSecond =
      captureCount > 0 && totalOutputTokens > 0
        ? totalOutputTokens / captureCount
        : 0;

    metrics[sessionId] = {
      totalInboundBytes: totalRequestBytes,
      totalOutboundBytes: totalResponseBytes,
      inboundThroughput,
      outboundThroughput,
      totalContextValues,
      totalInputTokens: totalInputTokens || undefined,
      totalOutputTokens: totalOutputTokens || undefined,
      tokensPerSecond:
        tokensPerSecond > 0
          ? Number(tokensPerSecond.toFixed(2))
          : 0,
      redactionStats: {
        totalRedactions,
        byRule: byPlaceholder, // Already converted to placeholder keys
      },
    };
  }

  return { summaries, metrics };
}