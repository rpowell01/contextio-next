import fs from "fs/promises";
import { join } from "path";
import type { Session, SessionDetail } from "@/types/api";
import {
  listCaptureFiles,
  getSessionMetadata,
  getCaptureDir,
  MAX_FILE_SIZE,
  readCaptureFile,
  listRedactionMetaFiles,
  loadRedactionMeta,
} from "@/lib/sessions/server-utils";
import {
  aggregateRedactionMetaBySessionFromDb,
  getAllRedactionMetadataFromDb,
} from "@/lib/sessions/db-utils";
import { withRequestCache } from "@/lib/request-cache";
import { groupCapturesIntoSessions, type RawCaptureData } from "@/lib/sessions/grouping";
import { createErrorResponse, createSuccessResponse } from "@contextio/core";

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
    const sessionId = pathParts[2];

    // Get all captures for this session from metadata files (much faster!)
    const metaFiles = await listRedactionMetaFiles();
    const sessionCaptures: RawCaptureData[] = [];

    for (const filename of metaFiles) {
      try {
        const meta = await loadRedactionMeta(filename);
        if (!meta) continue;

        // Skip title-* sessions
        if (meta.sessionId?.startsWith("title-")) continue;

        // Check if this file belongs to the requested session
        if (meta.sessionId === sessionId || (meta.sessionId === null && sessionId === "unsorted")) {
          // Build raw capture data from metadata - no full file reads needed!
          const timings = meta.timings
            ? { total_ms: meta.timings.total_ms ?? 0 }
            : { total_ms: 0 };

          sessionCaptures.push({
            sessionId: meta.sessionId,
            source: meta.source ?? "unknown",
            provider: meta.provider ?? "unknown",
            apiFormat: "unknown", // Not in metadata
            targetUrl: meta.targetUrl ?? "",
            requestBytes: meta.requestBytes ?? 0,
            responseBytes: meta.responseBytes ?? 0,
            timings,
            timestamp: meta.timestamp ?? new Date().toISOString(),
            requestBody: undefined, // We don't have full bodies in metadata
            responseBody: undefined,
            responseStatus: 200,
            responseIsStreaming: false,
            redactionStats: {
              totalRedactions: meta.totalRedactions ?? 0,
              byRule: meta.byRule ?? {},
            },
          });
        }
      } catch (error) {
        console.error(`Error processing session metadata ${filename}:`, error);
        continue;
      }
    }

    if (sessionCaptures.length === 0) {
      return Response.json(createErrorResponse({ message: "Session not found", status: 404 }), { status: 404 });
    }

    // Calculate metrics for this session using the grouping function
    const redactionMetaBySession = new Map<
      string,
      { totalRedactions: number; byRule: Record<string, number> }
    >();

    // Accumulate redaction metadata
    for (const c of sessionCaptures) {
      if (c.sessionId && c.redactionStats) {
        const existing = redactionMetaBySession.get(c.sessionId);
        if (existing) {
          existing.totalRedactions += c.redactionStats.totalRedactions ?? 0;
          for (const [rule, count] of Object.entries(c.redactionStats.byRule)) {
            existing.byRule[rule] = (existing.byRule[rule] ?? 0) + count;
          }
        } else {
          redactionMetaBySession.set(c.sessionId, {
            totalRedactions: c.redactionStats.totalRedactions ?? 0,
            byRule: { ...c.redactionStats.byRule },
          });
        }
      }
    }

    const { summaries, metrics } = groupCapturesIntoSessions(
      sessionCaptures,
      redactionMetaBySession,
    );

    const summary = summaries[0];
    const sessionMetrics = metrics[sessionId];

    // For response status and streaming, use first capture as representative
    const firstCapture = sessionCaptures[0];
    const responseStatus = 200;
    const responseIsStreaming = false;

    // Build detailed session response
    const sessionDetail: SessionDetail = {
      id: sessionId,
      sessionId,
      source: summary.source,
      provider: summary.destination,
      apiFormat: firstCapture?.apiFormat || "unknown",
      targetUrl: firstCapture?.targetUrl || "",
      requestBody: {},
      responseStatus,
      responseIsStreaming,
      responseBody: null,
      timestamp: summary.firstTimestamp,
      timings: { total_ms: summary.totalTimeMs },
      metrics: {
        totalInboundBytes: sessionMetrics?.totalInboundBytes ?? 0,
        totalOutboundBytes: sessionMetrics?.totalOutboundBytes ?? 0,
        inboundThroughput: sessionMetrics?.inboundThroughput ?? 0,
        outboundThroughput: sessionMetrics?.outboundThroughput ?? 0,
        totalContextValues: sessionMetrics?.totalContextValues ?? 0,
        totalInputTokens: sessionMetrics?.totalInputTokens,
        totalOutputTokens: sessionMetrics?.totalOutputTokens,
        redactionStats: {
          totalRedactions: sessionMetrics?.redactionStats.totalRedactions ?? 0,
          byRule: sessionMetrics?.redactionStats.byRule ?? {},
        },
      },
      contextValues: {},
      redactionStats: {
        totalRedactions: sessionMetrics?.redactionStats.totalRedactions ?? 0,
        byRule: sessionMetrics?.redactionStats.byRule ?? {},
      },
      captures: sessionCaptures.map((c) => ({
        id: c.filename ?? "",
        timestamp: c.timestamp,
        targetUrl: c.targetUrl,
        requestBytes: c.requestBytes,
        responseBytes: c.responseBytes,
        responseStatus: c.responseStatus,
        responseIsStreaming: c.responseIsStreaming,
        timings: c.timings,
        source: c.source,
        metrics: {
          successCount: 0,
          errorCount: 0,
          errorRate: 0,
          totalContextValues: 0,
          totalInputTokens: 0,
          totalOutputTokens: 0,
          tokensPerSecond: 0,
          totalRedactions: c.redactionStats?.totalRedactions ?? 0,
          model: null,
        },
        redactionStats: c.redactionStats
          ? {
              totalRedactions: c.redactionStats.totalRedactions,
              byRule: c.redactionStats.byRule,
              uniqueRedactions: 0,
            }
          : undefined,
      })),
    };

    return Response.json(createSuccessResponse(sessionDetail));
  }

  const files = await listCaptureFiles();
  const sessions: Session[] = [];

  for (const filename of files) {
    try {
      const captureDir = await getCaptureDir();
      const filepath = join(captureDir, filename);
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
    return Response.json(createSuccessResponse({
      sessions: paginatedSessions,
      pagination: {
        page,
        pageSize,
        totalPages,
        totalItems: listSessions.length,
      },
    }));
  }

  // Return grouped summaries if requested
  if (groupBySourceDest) {
    // Load pre-aggregated redaction metadata from SQLite (much faster than file scanning)
    const redactionMetaBySession = await aggregateRedactionMetaBySessionFromDb();

    // Get all redaction metadata from SQLite for building rawCaptures
    const allMeta = await getAllRedactionMetadataFromDb();

    const rawCaptures: RawCaptureData[] = [];

    for (const meta of allMeta) {
      // Skip title-* sessions (match Redactions page behavior)
      if (meta.sessionId?.startsWith("title-")) continue;

      // Use actual data from database instead of hardcoded "unknown"
      const timings = meta.timings
        ? { total_ms: meta.timings.total_ms ?? 0 }
        : { total_ms: 0 };

      rawCaptures.push({
        sessionId: meta.sessionId,
        source: meta.source ?? "unknown",
        provider: meta.provider ?? "unknown",
        targetUrl: meta.targetUrl ?? "",
        requestBytes: meta.requestBytes ?? 0,
        responseBytes: meta.responseBytes ?? 0,
        timings,
        timestamp: new Date(meta.createdAt).toISOString(),
        requestBody: undefined,
        responseBody: undefined,
      });
    }

    const { summaries, metrics } = groupCapturesIntoSessions(
      rawCaptures,
      redactionMetaBySession,
    );
    summaries.sort(
      (a, b) =>
        new Date(b.firstTimestamp).getTime() -
        new Date(a.firstTimestamp).getTime(),
    );

    // Apply pagination to summaries
    const startIndex = (page - 1) * pageSize;
    const endIndex = startIndex + pageSize;
    const paginatedSummaries = summaries.slice(startIndex, endIndex);
    const totalPages = Math.ceil(summaries.length / pageSize);

    return Response.json(createSuccessResponse({
      sessions: [],
      summaries: paginatedSummaries,
      metrics,
      pagination: {
        page,
        pageSize,
        totalPages,
        totalItems: summaries.length,
      },
    }));
  }

  // For non-grouped list without pagination params, return all
  // Preserve array response shape while adding service identification via header
  const response = Response.json(listSessions);
  response.headers.set("x-service-identifier", "contextio-next");
  return response;
}

export async function GET(request: Request) {
  try {
    return await withRequestCache(() => handleGet(request));
  } catch (error) {
    console.error("Error in sessions API:", error);
    return Response.json(createErrorResponse({ message: "Internal server error", status: 500 }), { status: 500 });
  }
}
