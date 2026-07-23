import fs from "fs/promises";
import { join } from "path";
import type { SessionDetail, SessionMetrics, CaptureMetrics } from "@/types/api";
import {
  listCaptureFiles,
  getCaptureDir,
  MAX_FILE_SIZE,
  computeContextValues,
  computeTokenUsage,
  readCaptureFile,
} from "@/lib/sessions/utils";
import {
  countRedactionsInResponse,
  getCaptureRedactionStats,
} from "@/lib/sessions/redaction-utils";
import { ruleNameToPlaceholder } from "@/lib/sessions/placeholder-map";
import { withRequestCache } from "@/lib/request-cache";

interface CaptureRedactionStats {
  totalRedactions: number;
  byRule: Record<string, number>;
}

interface RawCaptureData extends Record<string, unknown> {
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
  originalRequestBody?: unknown;
  responseBody?: string;
  responseStatus?: number;
  responseIsStreaming?: boolean;
  filename: string; // Store the actual filename for capture detail linking
  redactionStats?: { totalRedactions: number; byRule: Record<string, number> };
}

function computeCaptureMetrics(c: RawCaptureData): CaptureMetrics {
  const isSuccess =
    c.responseStatus && c.responseStatus >= 200 && c.responseStatus < 300;
  const successCount = isSuccess ? 1 : 0;
  const errorCount = isSuccess ? 0 : 1;
  const errorRate = errorCount; // Per capture, it's either 0 or 1

  // Count context values from request body
  const captureContextValues = computeContextValues(c.requestBody);
  const totalContextValues = captureContextValues.count;

  // Parse response for tokens (pass requestBody for fallback estimation)
  let tokenUsage = { input: 0, output: 0, model: null as string | null };
  try {
    tokenUsage = computeTokenUsage(c.responseBody, c.requestBody);
  } catch {
    tokenUsage = { input: 0, output: 0, model: null };
  }
  const totalInputTokens = tokenUsage.input;
  const totalOutputTokens = tokenUsage.output;

  // Tokens per second for this capture
  const timeSec = (c.timings.total_ms || 1) / 1000;
  const tokensPerSecond = timeSec > 0 ? totalOutputTokens / timeSec : 0;

  // Redactions: prefer canonical capture.redactionStats; fall back to raw-body recompute
  const redactionCounts: CaptureRedactionStats =
    c.redactionStats ??
    getCaptureRedactionStats(c as unknown as Record<string, unknown>) ??
    countRedactionsInResponse(c.responseBody, c.requestBody, false);
  const totalRedactions = redactionCounts.totalRedactions;

  return {
    successCount,
    errorCount,
    errorRate,
    totalContextValues,
    totalInputTokens,
    totalOutputTokens,
    tokensPerSecond: Number(tokensPerSecond.toFixed(2)),
    totalRedactions,
    model: tokenUsage.model,
  };
}

function computeSessionMetrics(
  sessionCaptures: RawCaptureData[],
): {
  metrics: SessionMetrics;
  contextValues: Record<string, unknown>;
  redactionStats: { totalRedactions: number; byRule: Record<string, number> };
  source: string;
  destination: string;
  firstTimestamp: string;
  lastTimestamp: string;
  responseStatus: number;
  responseIsStreaming: boolean;
  totalTimeMs: number;
} {
  let totalRequestBytes = 0;
  let totalResponseBytes = 0;
  let totalTimeMs = 0;
  let totalRedactions = 0;
  const byRule: Record<string, number> = {};
  let totalInputTokens = 0;
  let totalOutputTokens = 0;
  let totalContextValues = 0;
  let successCount = 0;
  let errorCount = 0;

  let firstTimestamp = "";
  let lastTimestamp = "";
  let responseStatus = 200;
  let responseIsStreaming = false;

  const contextValues: Record<string, unknown> = {};

  for (const c of sessionCaptures) {
    totalRequestBytes += c.requestBytes;
    totalResponseBytes += c.responseBytes;
    totalTimeMs += c.timings.total_ms;

    if (!firstTimestamp) {
      responseStatus = c.responseStatus ?? 200;
      responseIsStreaming = c.responseIsStreaming ?? false;
    }

    if (!firstTimestamp || c.timestamp < firstTimestamp) {
      firstTimestamp = c.timestamp;
    }
    if (!lastTimestamp || c.timestamp > lastTimestamp) {
      lastTimestamp = c.timestamp;
    }

    if (c.responseStatus && c.responseStatus >= 200 && c.responseStatus < 300) {
      successCount++;
    } else {
      errorCount++;
    }

    // Count context values from request body (shared with /api/sessions)
    const captureContextValues = computeContextValues(c.requestBody);
    Object.assign(contextValues, captureContextValues.values);
    totalContextValues += captureContextValues.count;

    // Parse response for tokens (defensive: malformed JSON in the response
    // body must not crash metrics aggregation). Pass requestBody for
    // input token estimation when responseBody is empty (streaming).
    let tokenUsage = { input: 0, output: 0 };
    try {
      tokenUsage = computeTokenUsage(c.responseBody, c.requestBody);
    } catch {
      tokenUsage = { input: 0, output: 0 };
    }
    totalInputTokens += tokenUsage.input;
    totalOutputTokens += tokenUsage.output;

    // Redactions: use the pre-computed redactionStats from the capture file
    // (populated by the redact plugin) instead of rescanning response bodies
    if (c.redactionStats) {
      totalRedactions += c.redactionStats.totalRedactions ?? 0;
      for (const [rule, count] of Object.entries(c.redactionStats.byRule ?? {})) {
        const placeholder = ruleNameToPlaceholder(rule);
        byRule[placeholder] = (byRule[placeholder] || 0) + (count as number);
      }
    }
  }

  const timeSec = totalTimeMs / 1000 || 1;
  const inboundThroughput = totalRequestBytes / timeSec;
  const outboundThroughput = totalResponseBytes / timeSec;

  const firstCapture = sessionCaptures[0];
  const source = firstCapture?.source || "unknown";
  const destination = firstCapture?.provider || "unknown";

  const captureCount = sessionCaptures.length;
  const tokensPerSecond =
    captureCount > 0 && totalOutputTokens > 0
      ? totalOutputTokens / captureCount
      : 0;

  const metrics: SessionMetrics = {
    totalInboundBytes: totalRequestBytes,
    totalOutboundBytes: totalResponseBytes,
    inboundThroughput,
    outboundThroughput,
    totalContextValues,
    totalInputTokens: totalInputTokens || undefined,
    totalOutputTokens: totalOutputTokens || undefined,
    tokensPerSecond:
      tokensPerSecond > 0 ? Number(tokensPerSecond.toFixed(2)) : 0,
    successCount: successCount || undefined,
    errorCount: errorCount || undefined,
    errorRate:
      captureCount > 0
        ? Number((errorCount / captureCount).toFixed(4))
        : undefined,
    redactionStats: {
      totalRedactions,
      byRule,
    },
  };

  return {
    metrics,
    contextValues,
    redactionStats: { totalRedactions, byRule },
    source,
    destination,
    firstTimestamp,
    lastTimestamp,
    responseStatus,
    responseIsStreaming,
    totalTimeMs,
  };
}

export async function GET(
  _request: Request,
  { params }: { params: Promise<{ id: string }> },
) {
  return withRequestCache(async () => {
    const { id } = await params;

    try {
      const files = await listCaptureFiles();
      const sessionCaptures: RawCaptureData[] = [];

      for (const filename of files) {
        try {
          const captureDir = await getCaptureDir();
          const filepath = join(captureDir, filename);
          const stats = await fs.stat(filepath);
          if (stats.size > MAX_FILE_SIZE) continue;

          const data = await readCaptureFile(filepath);
          if (!data) continue;

          // Check if this file belongs to the requested session
          if (
            data.sessionId === id ||
            (data.sessionId === null && id === "unsorted")
          ) {
            const capture: RawCaptureData = {
              sessionId: data.sessionId as string | null,
              source: data.source as string | null,
              provider: data.provider as string,
              apiFormat: data.apiFormat as string | undefined,
              targetUrl: data.targetUrl as string,
              requestBytes: (data.requestBytes as number) || 0,
              responseBytes: (data.responseBytes as number) || 0,
              timings: (data.timings as { total_ms: number }) || { total_ms: 0 },
              timestamp: data.timestamp as string,
              requestBody: data.requestBody,
              originalRequestBody: data.originalRequestBody,
              responseBody: data.responseBody as string | undefined,
              responseStatus: (data.responseStatus as number) || 200,
              responseIsStreaming: (data.responseIsStreaming as boolean) || false,
              filename: filename,
              redactionStats: data.redactionStats as {
                totalRedactions: number;
                byRule: Record<string, number>;
              } | undefined,
            };
            sessionCaptures.push(capture);
          }
        } catch (error) {
          console.error(
            `Error processing session detail capture ${filename}:`,
            error,
          );
          continue;
        }
      }

      if (sessionCaptures.length === 0) {
        return Response.json({ error: "Session not found" }, { status: 404 });
      }

      // Compute metrics and enriched data
      const {
        metrics,
        contextValues,
        redactionStats,
        source,
        destination,
        firstTimestamp,
        responseStatus,
        responseIsStreaming,
        totalTimeMs,
      } = computeSessionMetrics(sessionCaptures);

      const firstCapture = sessionCaptures[0];

      // Build detailed session response
      const sessionDetail: SessionDetail = {
        id,
        sessionId: id,
        source,
        provider: destination,
        apiFormat: firstCapture.apiFormat || "unknown",
        targetUrl: firstCapture.targetUrl || "",
        requestBody:
          (firstCapture.requestBody as Record<string, unknown>) ||
          ({} as Record<string, unknown>),
        responseStatus,
        responseIsStreaming,
        responseBody: firstCapture.responseBody || null,
        timestamp: firstTimestamp,
        timings: { total_ms: totalTimeMs },
        metrics,
        contextValues,
        redactionStats,
        captures: sessionCaptures.map((c) => ({
          id: c.filename,
          timestamp: c.timestamp,
          targetUrl: c.targetUrl,
          requestBytes: c.requestBytes,
          responseBytes: c.responseBytes,
          responseStatus: c.responseStatus,
          responseIsStreaming: c.responseIsStreaming,
          timings: c.timings,
          source: c.source,
          metrics: computeCaptureMetrics(c),
          redactionStats: c.redactionStats ?? { totalRedactions: 0, byRule: {} },
        })),
      };

      return Response.json(sessionDetail);
    } catch (error) {
      console.error("Error in session detail API:", error);
      return Response.json({ error: "Internal server error" }, { status: 500 });
    }
  });
}
