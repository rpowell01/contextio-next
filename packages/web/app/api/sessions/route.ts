import fs from "fs/promises";
import { join } from "path";
import type {
  Session,
  SessionSummary,
  SessionMetrics,
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
import { withRequestCache } from "@/lib/request-cache";
import {
  countRedactionsInResponse,
  getCaptureRedactionStats,
} from "@/lib/sessions/redaction-utils";
import type { CaptureRedactionStats } from "@/lib/sessions/redaction-utils";

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
  redactionStats?: {
    totalRedactions: number;
    byRule: Record<string, number>;
  };
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
    if (
      redactionMetaBySession &&
      redactionMetaBySession.has(sessionId)
    ) {
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
          countRedactionsInResponse(
            c.responseBody,
            c.requestBody,
            false,
          );
        totalRedactions += redactionCounts.totalRedactions;
        for (const [rule, count] of Object.entries(
          redactionCounts.byRule,
        )) {
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
        tokensPerSecond > 0
          ? Number(tokensPerSecond.toFixed(2))
          : 0,
      redactionStats: {
        totalRedactions,
        byRule,
      },
    };
  }

  return { summaries, metrics };
}

async function handleGet(request: Request): Promise<Response> {
  const url = new URL(request.url);
  const groupBySourceDest =
    url.searchParams.get("groupBySourceDest") === "true";
  const pageValue = Number(url.searchParams.get("page"));
  const page = Number.isFinite(pageValue) && pageValue > 0 ? pageValue : 1;
  const pageSizeValue = Number(url.searchParams.get("pageSize"));
  const pageSize =
    Number.isFinite(pageSizeValue) && pageSizeValue > 0
      ? pageSizeValue
      : 20;
  const pathParts = url.pathname.split("/").filter(Boolean);

  // Check if we're requesting a specific session by ID
  if (
    pathParts.length >= 2 &&
    pathParts[0] === "api" &&
    pathParts[1] === "sessions" &&
    pathParts[2]
  ) {
    // ... existing session detail code unchanged ...
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
      console.error(
        `Error processing session capture ${filename}:`,
        error,
      );
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

  // Apply pagination for non-grouped list
  if (!groupBySourceDest) {
    const startIndex = (page - 1) * pageSize;
    const endIndex = startIndex + pageSize;
    const paginatedSessions = listSessions.slice(startIndex, endIndex);
    const totalPages = Math.ceil(listSessions.length / pageSize);
    return Response.json({
      sessions: paginatedSessions,
      pagination: {
        page,
        pageSize,
        totalPages,
        totalItems: listSessions.length,
      },
    });
  }

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
          timings: (data.timings as { total_ms: number }) || {
            total_ms: 0,
          },
          timestamp: data.timestamp as string,
          requestBody: undefined,
          responseBody: undefined,
        });
      } catch (error) {
        console.error(
          `Error reading capture for grouped sessions ${filename}:`,
          error,
        );
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

    // Apply pagination to summaries
    const startIndex = (page - 1) * pageSize;
    const endIndex = startIndex + pageSize;
    const paginatedSummaries = summaries.slice(startIndex, endIndex);
    const totalPages = Math.ceil(summaries.length / pageSize);

    return Response.json({
      sessions: [],
      summaries: paginatedSummaries,
      metrics,
      pagination: {
        page,
        pageSize,
        totalPages,
        totalItems: summaries.length,
      },
    });
  }

  // For non-grouped list without pagination params, return all
  return Response.json(listSessions);
}

export async function GET(request: Request) {
  try {
    return await withRequestCache(() => handleGet(request));
  } catch (error) {
    console.error("Error in sessions API:", error);
    return Response.json({ error: "Internal server error" }, { status: 500 });
  }
}
