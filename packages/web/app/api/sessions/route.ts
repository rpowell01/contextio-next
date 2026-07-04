import fs from "node:fs/promises";
import { join } from "node:path";
import type { Session, SessionSummary, SessionMetrics, SessionDetail } from "@/types/api";
import { listCaptureFiles, getSessionMetadata, CAPTURE_DIR, MAX_FILE_SIZE, computeContextValues, computeTokenUsage } from "@/lib/sessions/utils";
import { countRedactionsInResponse } from "@/lib/sessions/redaction-utils";

interface RawCaptureData {
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
}

/**
 * Group captures by session ID and compute summary metrics.
 */
function groupCapturesIntoSessions(
  captures: RawCaptureData[],
): { summaries: SessionSummary[]; metrics: Record<string, SessionMetrics> } {
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

  for (const [sessionId, sessionCaptures] of Array.from(sessionGroups.entries())) {
    // Calculate totals
    let totalRequestBytes = 0;
    let totalResponseBytes = 0;
    let totalTimeMs = 0;
    let totalRedactions = 0;
    let totalContextValues = 0;
    const byRule: Record<string, number> = {};
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
      // Uses the same scalar-leaf counting logic as /api/sessions/[id] so list
      // and detail views agree for the same session (replaces prior
      // messages.reduce(...) formula that under-counted non-message captures).
      totalContextValues += computeContextValues(c.requestBody).count;

      const usage = computeTokenUsage(c.responseBody);
      totalInputTokens += usage.input;
      totalOutputTokens += usage.output;
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
      tokenUsage: totalInputTokens + totalOutputTokens > 0 ? {
        input: totalInputTokens,
        output: totalOutputTokens,
        total: totalInputTokens + totalOutputTokens,
      } : undefined,
    });

const captureCount = sessionCaptures.length;
const tokensPerSecond = captureCount > 0 && totalOutputTokens > 0 ? totalOutputTokens / captureCount : 0;

metrics[sessionId] = {
  totalInboundBytes: totalRequestBytes,
  totalOutboundBytes: totalResponseBytes,
  inboundThroughput,
  outboundThroughput,
  totalContextValues,
  totalInputTokens: totalInputTokens || undefined,
  totalOutputTokens: totalOutputTokens || undefined,
  tokensPerSecond: tokensPerSecond > 0 ? Number(tokensPerSecond.toFixed(2)) : 0,
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
    const groupBySourceDest = url.searchParams.get("groupBySourceDest") === "true";
    const pathParts = url.pathname.split("/").filter(Boolean);
    
    // Check if we're requesting a specific session by ID
    if (pathParts.length >= 2 && pathParts[0] === "api" && pathParts[1] === "sessions" && pathParts[2]) {
      const sessionId = pathParts[2];
      
      // Get all captures for this session
      const files = await listCaptureFiles();
      const sessionCaptures: RawCaptureData[] = [];
      
      for (const filename of files) {
        try {
          const filepath = join(CAPTURE_DIR, filename);
          const stats = await fs.stat(filepath);
          if (stats.size > MAX_FILE_SIZE) continue;
          
          const raw = await fs.readFile(filepath, "utf8");
          const data = JSON.parse(raw) as Record<string, unknown>;
          
          // Check if this file belongs to the requested session
          if (data.sessionId === sessionId || (data.sessionId === null && sessionId === "unsorted")) {
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
              responseBody: data.responseBody as string | undefined,
              responseStatus: (data.responseStatus as number) || 200,
              responseIsStreaming: (data.responseIsStreaming as boolean) || false,
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

  const usage = computeTokenUsage(c.responseBody);
  totalInputTokens += usage.input;
  totalOutputTokens += usage.output;

  // Count redactions from response body
  const redactionCounts = countRedactionsInResponse(c.responseBody);
  totalRedactions += redactionCounts.total;
  for (const [rule, count] of Object.entries(redactionCounts.byRule)) {
    byRule[rule] = (byRule[rule] || 0) + count;
  }
}

// Compute throughput (bytes/sec)
      const timeSec = totalTimeMs / 1000 || 1;
      const inboundThroughput = totalRequestBytes / timeSec;
      const outboundThroughput = totalResponseBytes / timeSec;
      
      const firstCapture = sessionCaptures[0];
      const source = firstCapture?.source || "unknown";
      const destination = firstCapture?.provider || "unknown";
      
      // Build detailed session response
      const sessionDetail: SessionDetail = {
        id: sessionId,
        sessionId: sessionId,
        source: source,
        provider: destination,
        apiFormat: firstCapture.apiFormat || "unknown",
        targetUrl: firstCapture.targetUrl || "",
        requestBody: {}, // Not storing full request body in session detail for performance
        responseStatus,
        responseIsStreaming,
        responseBody: null, // Not storing in session detail
        timestamp: firstTimestamp,
        timings: { total_ms: totalTimeMs },
        metrics: {
          totalInboundBytes: totalRequestBytes,
          totalOutboundBytes: totalResponseBytes,
          inboundThroughput,
          outboundThroughput,
          totalContextValues: Object.keys(contextValues).length, // equivalent to computeContextValues(c.requestBody).count per capture
          redactionStats: {
            totalRedactions,
            byRule
          }
        },
        contextValues,
        redactionStats: {
          totalRedactions,
          byRule
        }
      };
      
      return Response.json(sessionDetail);
    }
    
    const files = await listCaptureFiles();
    const sessions: Session[] = [];
    
    for (const filename of files) {
      try {
        const filepath = join(CAPTURE_DIR, filename);
        const stats = await fs.stat(filepath);
        if (stats.size > MAX_FILE_SIZE) continue;
        
        const raw = await fs.readFile(filepath, "utf8");
        const data = JSON.parse(raw) as Record<string, unknown>;
        
        const session = await getSessionMetadata(filename, data);
        sessions.push(session);
      } catch (error) {
        console.error(`Error processing session capture ${filename}:`, error);
        continue;
      }
    }
    
    // Sort by timestamp descending (newest first)
    sessions.sort((a, b) => new Date(b.timestamp).getTime() - new Date(a.timestamp).getTime());
    
    // Return grouped summaries if requested
    if (groupBySourceDest) {
      const rawCaptures: RawCaptureData[] = sessions.map((s) => ({
        sessionId: s.sessionId || null,
        source: s.source,
        provider: s.provider,
        targetUrl: s.targetUrl,
        requestBytes: 0,
        responseBytes: 0,
        timings: { total_ms: 0 },
        timestamp: s.timestamp,
        requestBody: undefined,
        responseBody: undefined,
      }));
      
      const { summaries, metrics } = groupCapturesIntoSessions(rawCaptures);
      return Response.json({ sessions: [], summaries, metrics });
    }
    
    return Response.json(sessions);
  } catch (error) {
    console.error("Error in sessions API:", error);
    return Response.json({ error: "Internal server error" }, { status: 500 });
  }
}