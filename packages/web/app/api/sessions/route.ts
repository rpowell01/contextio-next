import fs from "fs/promises";
import { join } from "path";
import type {
  Session,
  SessionSummary,
  SessionMetrics,
  SessionDetail,
} from "@/types/api";
import {
  listCaptureFiles,
  getSessionMetadata,
  getCaptureDir,
  MAX_FILE_SIZE,
  computeContextValues,
  computeTokenUsage,
  aggregateRedactionMetaBySession,
  readCaptureFile,
} from "@/lib/sessions/utils";
import {
  countRedactionsInResponse,
  getCaptureRedactionStats,
} from "@/lib/sessions/redaction-utils";
import type { CaptureRedactionStats } from "@/lib/sessions/redaction-utils";

// Re-implementation of computeCaptureMetrics from /api/sessions/[id]:
// returns per-capture metric fields. Equivalent to the id-route's helper.
function computeCaptureMetrics(c: {
  requestBody?: unknown;
  responseBody?: string;
  responseStatus?: number;
  timings?: { total_ms?: number };
  redactionStats?: { totalRedactions: number; byRule: Record<string, number> };
}): {
  successCount: number;
  errorCount: number;
  errorRate: number;
  totalContextValues: number;
  totalInputTokens: number;
  totalOutputTokens: number;
  tokensPerSecond: number;
  totalRedactions: number;
  model: string | null;
} {
  const isSuccess =
    !!c.responseStatus && c.responseStatus >= 200 && c.responseStatus < 300;
  const captureContextValues = computeContextValues(c.requestBody);
  let tokenUsage = { input: 0, output: 0, model: null as string | null };
  try {
    tokenUsage = computeTokenUsage(c.responseBody, c.requestBody);
  } catch {
    tokenUsage = { input: 0, output: 0, model: null };
  }
  const timeSec = (c.timings?.total_ms || 1) / 1000;
  const tokensPerSecond = timeSec > 0 ? tokenUsage.output / timeSec : 0;
  const redaction: CaptureRedactionStats =
    c.redactionStats ??
    getCaptureRedactionStats(c as unknown as Record<string, unknown>) ??
    countRedactionsInResponse(c.responseBody, c.requestBody, false);
  return {
    successCount: isSuccess ? 1 : 0,
    errorCount: isSuccess ? 0 : 1,
    errorRate: isSuccess ? 0 : 1,
    totalContextValues: captureContextValues.count,
    totalInputTokens: tokenUsage.input,
    totalOutputTokens: tokenUsage.output,
    tokensPerSecond: Number(tokensPerSecond.toFixed(2)),
    totalRedactions: redaction.totalRedactions,
    model: tokenUsage.model,
  };
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
  responseBody?: string;
  responseStatus?: number;
  responseIsStreaming?: boolean;
  redactionStats?: { totalRedactions: number; byRule: Record<string, number> };
}

/**
 * Group captures by session ID and compute summary metrics.
 * Uses pre-aggregated redaction metadata when provided to avoid rescanning captures.
 */
function groupCapturesIntoSessions(
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
    const byRule: Record<string, number> = {};
    if (redactionMetaBySession && redactionMetaBySession.has(sessionId)) {
      const meta = redactionMetaBySession.get(sessionId)!;
      totalRedactions = meta.totalRedactions;
      Object.assign(byRule, meta.byRule);
    } else {
      // Fallback: compute from captures (legacy behavior)
      for (const c of sessionCaptures) {
        const cachedStats = getCaptureRedactionStats(
          c as unknown as Record<string, unknown>,
        );
        const redactionCounts: CaptureRedactionStats =
          cachedStats ??
          countRedactionsInResponse(c.responseBody, c.requestBody, false);
        totalRedactions += redactionCounts.totalRedactions;
        for (const [rule, count] of Object.entries(redactionCounts.byRule)) {
          byRule[rule] = (byRule[rule] || 0) + count;
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
        tokensPerSecond > 0 ? Number(tokensPerSecond.toFixed(2)) : 0,
      redactionStats: {
        totalRedactions,
        byRule,
      },
    };
  }

  return { summaries, metrics };
}

export async function GET(request: Request) {
  try {
    const url = new URL(request.url);
    const groupBySourceDest =
      url.searchParams.get("groupBySourceDest") === "true";
    const pathParts = url.pathname.split("/").filter(Boolean);

    // Check if we're requesting a specific session by ID
    if (
      pathParts.length >= 2 &&
      pathParts[0] === "api" &&
      pathParts[1] === "sessions" &&
      pathParts[2]
    ) {
      const sessionId = pathParts[2];

// Get all captures for this session
      const files = await listCaptureFiles();
      const sessionCaptures: RawCaptureData[] = [];

      for (const filename of files) {
        try {
    const filepath = join(getCaptureDir(), filename);
          const stats = await fs.stat(filepath);
          if (stats.size > MAX_FILE_SIZE) continue;

          const data = await readCaptureFile(filepath);
          if (!data) continue;

          // Check if this file belongs to the requested session
          const dataSessionId = data.sessionId as string | null;
          const requestedSessionId = sessionId === "unsorted" ? null : sessionId;
          if (
            dataSessionId === requestedSessionId ||
            (dataSessionId === "" && requestedSessionId === "") ||
            (dataSessionId === null && requestedSessionId === null)
          ) {
            const capture: RawCaptureData = {
              sessionId: data.sessionId as string | null,
              source: data.source as string | null,
              provider: data.provider as string,
              apiFormat: data.apiFormat as string | undefined,
              targetUrl: data.targetUrl as string,
              requestBytes: (data.requestBytes as number) || 0,
              responseBytes: (data.responseBytes as number) || 0,
              timings: (data.timings as { total_ms: number }) || {
                total_ms: 0,
              },
              timestamp: data.timestamp as string,
              requestBody: data.requestBody,
              responseBody: data.responseBody as string | undefined,
              responseStatus: (data.responseStatus as number) || 200,
              responseIsStreaming:
                (data.responseIsStreaming as boolean) || false,
              redactionStats: data.redactionStats as
                | { totalRedactions: number; byRule: Record<string, number> }
                | undefined,
            };
            sessionCaptures.push(capture);
          }
        } catch (error) {
          console.error(`Error processing session capture ${filename}:`, error);
          continue;
        }
      }

      if (sessionCaptures.length === 0) {
        return Response.json({ error: "Session not found" }, { status: 404 });
      }

      // Calculate metrics for this session
      let totalRequestBytes = 0;
      let totalResponseBytes = 0;
      let totalTimeMs = 0;
      let totalRedactions = 0;
      const byRule: Record<string, number> = {};
      let totalInputTokens = 0;
      let totalOutputTokens = 0;
      let totalContextValues = 0;

      let firstTimestamp = "";
      let lastTimestamp = "";

      // For response status and streaming, we'll use values from the first capture
      // In a more sophisticated implementation, we might aggregate or validate consistency
      let responseStatus = 200;
      let responseIsStreaming = false;

      // Context values extraction
      const contextValues: Record<string, unknown> = {};

      for (const c of sessionCaptures) {
        totalRequestBytes += c.requestBytes;
        totalResponseBytes += c.responseBytes;
        totalTimeMs += c.timings.total_ms;

        // Set response status and streaming from first capture (or could validate consistency)
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

        const captureContextValues = computeContextValues(c.requestBody);
        Object.assign(contextValues, captureContextValues.values);
        totalContextValues += captureContextValues.count;

        const usage = computeTokenUsage(c.responseBody, c.requestBody);
        totalInputTokens += usage.input;
        totalOutputTokens += usage.output;

        // Count redactions from request body only to keep totals consistent
        const cachedStats = getCaptureRedactionStats(
          c as unknown as Record<string, unknown>,
        );
        const redactionCounts: CaptureRedactionStats =
          cachedStats ??
          countRedactionsInResponse(c.responseBody, c.requestBody, false);
        totalRedactions += redactionCounts.totalRedactions;
        for (const [rule, count] of Object.entries(redactionCounts.byRule)) {
          byRule[rule] = (byRule[rule] || 0) + count;
        }
      }

      const timeSec = totalTimeMs / 1000 || 1;

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
        inboundThroughput: totalRequestBytes / timeSec,
        outboundThroughput: totalResponseBytes / timeSec,
        totalContextValues,
        totalInputTokens: totalInputTokens || undefined,
        totalOutputTokens: totalOutputTokens || undefined,
        tokensPerSecond:
          tokensPerSecond > 0 ? Number(tokensPerSecond.toFixed(2)) : 0,
        redactionStats: { totalRedactions, byRule },
      };

      // Build detailed session response
      const sessionDetail: SessionDetail = {
        id: sessionId,
        sessionId: sessionId,
        source,
        provider: destination,
        apiFormat: firstCapture?.apiFormat || "unknown",
        targetUrl: firstCapture?.targetUrl || "",
        requestBody:
          (firstCapture?.requestBody as Record<string, unknown>) ||
          ({} as Record<string, unknown>),
        responseStatus,
        responseIsStreaming,
        responseBody: firstCapture?.responseBody || null,
        timestamp: firstTimestamp,
        timings: { total_ms: totalTimeMs },
        metrics,
        contextValues,
        redactionStats: { totalRedactions, byRule },
        captures: sessionCaptures.map((c) => ({
          id: (c as unknown as { filename: string }).filename,
          timestamp: c.timestamp,
          targetUrl: c.targetUrl,
          requestBytes: c.requestBytes,
          responseBytes: c.responseBytes,
          responseStatus: c.responseStatus,
          responseIsStreaming: c.responseIsStreaming,
          timings: c.timings,
          source: c.source,
          metrics: computeCaptureMetrics(
            c as unknown as Parameters<typeof computeCaptureMetrics>[0],
          ),
        })),
      };

      return Response.json(sessionDetail);
    }

    const files = await listCaptureFiles();
    const sessions: Session[] = [];

  for (const filename of files) {
  try {
  const filepath = join(getCaptureDir(), filename);
        const stats = await fs.stat(filepath);
        if (stats.size > MAX_FILE_SIZE) continue;

        const data = await readCaptureFile(filepath);
        if (!data) continue;
        const session = await getSessionMetadata(filename, data);
        sessions.push(session);
      } catch (error) {
        console.error(`Error processing session capture ${filename}:`, error);
        continue;
      }
    }

    // Sort by timestamp descending (newest first)
    sessions.sort(
      (a, b) =>
        new Date(b.timestamp).getTime() - new Date(a.timestamp).getTime(),
    );

    // Strip heavy body fields from list responses to avoid RangeError in JSON.stringify
    const listSessions = sessions.map(
      ({ requestBody: _rb, responseBody: _rsp, ...rest }) => rest,
    );
    // Return grouped summaries if requested
    if (groupBySourceDest) {
      // Load pre-aggregated redaction metadata from .redact-meta.json files
      const redactionMetaBySession = await aggregateRedactionMetaBySession();

      // Read raw capture data for accurate byte counts
      const files = await listCaptureFiles();
      const rawCaptures: RawCaptureData[] = [];
      
      for (const filename of files) {
        try {
          const filepath = join(getCaptureDir(), filename);
          const stats = await fs.stat(filepath);
          if (stats.size > MAX_FILE_SIZE) continue;

          const data = await readCaptureFile(filepath);
          if (!data) continue;

          rawCaptures.push({
            sessionId: data.sessionId as string | null,
            source: data.source as string | null,
            provider: data.provider as string,
            targetUrl: data.targetUrl as string,
            requestBytes: (data.requestBytes as number) || 0,
            responseBytes: (data.responseBytes as number) || 0,
            timings: (data.timings as { total_ms: number }) || { total_ms: 0 },
            timestamp: data.timestamp as string,
            requestBody: undefined,
            responseBody: undefined,
          });
        } catch (error) {
          console.error(`Error reading capture for grouped sessions ${filename}:`, error);
          continue;
        }
      }

      const { summaries, metrics } = groupCapturesIntoSessions(
        rawCaptures,
        redactionMetaBySession,
      );
      summaries.sort(
        (a, b) =>
          new Date(b.lastTimestamp).getTime() -
          new Date(a.lastTimestamp).getTime(),
      );
      return Response.json({ sessions: [], summaries, metrics });
    }

    return Response.json(listSessions);
  } catch (error) {
    console.error("Error in sessions API:", error);
    return Response.json({ error: "Internal server error" }, { status: 500 });
  }
}
