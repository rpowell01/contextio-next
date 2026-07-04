import fs from "node:fs/promises";
import { join } from "node:path";
import type { SessionDetail, SessionMetrics } from "@/types/api";
import { listCaptureFiles, CAPTURE_DIR, MAX_FILE_SIZE, computeContextValues, computeTokenUsage } from "@/lib/sessions/utils";
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

function computeSessionMetrics(
  sessionCaptures: RawCaptureData[],
): { metrics: SessionMetrics; contextValues: Record<string, unknown>; redactionStats: { totalRedactions: number; byRule: Record<string, number> }; source: string; destination: string; firstTimestamp: string; lastTimestamp: string; responseStatus: number; responseIsStreaming: boolean; totalTimeMs: number } {
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
  // body must not crash metrics aggregation)
  let tokenUsage = { input: 0, output: 0 };
  try {
    tokenUsage = computeTokenUsage(c.responseBody);
  } catch {
    tokenUsage = { input: 0, output: 0 };
  }
  totalInputTokens += tokenUsage.input;
  totalOutputTokens += tokenUsage.output;

  const redactionCounts = countRedactionsInResponse(c.responseBody, c.requestBody);
  totalRedactions += redactionCounts.total;
  for (const [rule, count] of Object.entries(redactionCounts.byRule)) {
    byRule[rule] = (byRule[rule] || 0) + (count as number);
  }
}

const timeSec = totalTimeMs / 1000 || 1;
  const inboundThroughput = totalRequestBytes / timeSec;
  const outboundThroughput = totalResponseBytes / timeSec;

  const firstCapture = sessionCaptures[0];
  const source = firstCapture?.source || "unknown";
  const destination = firstCapture?.provider || "unknown";

const captureCount = sessionCaptures.length;
const tokensPerSecond = captureCount > 0 && totalOutputTokens > 0 ? totalOutputTokens / captureCount : 0;

const metrics: SessionMetrics = {
  totalInboundBytes: totalRequestBytes,
  totalOutboundBytes: totalResponseBytes,
  inboundThroughput,
  outboundThroughput,
  totalContextValues,
  totalInputTokens: totalInputTokens || undefined,
  totalOutputTokens: totalOutputTokens || undefined,
  tokensPerSecond: tokensPerSecond > 0 ? Number(tokensPerSecond.toFixed(2)) : 0,
  successCount: successCount || undefined,
  errorCount: errorCount || undefined,
  errorRate: captureCount > 0 ? Number((errorCount / captureCount).toFixed(4)) : undefined,
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

export async function GET(_request: Request, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;

  try {
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
        if (data.sessionId === id || (data.sessionId === null && id === "unsorted")) {
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
        console.error(`Error processing session detail capture ${filename}:`, error);
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
  requestBody: firstCapture.requestBody as Record<string, unknown> || ({} as Record<string, unknown>),
  responseStatus,
  responseIsStreaming,
  responseBody: firstCapture.responseBody || null,
  timestamp: firstTimestamp,
  timings: { total_ms: totalTimeMs },
  metrics,
  contextValues,
  redactionStats,
  captures: sessionCaptures.map((c, index) => ({
    id: c.sessionId ? `${c.sessionId}-${index + 1}` : `capture-${index + 1}`,
    timestamp: c.timestamp,
    targetUrl: c.targetUrl,
    requestBytes: c.requestBytes,
    responseBytes: c.responseBytes,
    responseStatus: c.responseStatus,
    responseIsStreaming: c.responseIsStreaming,
    timings: c.timings,
  })),
};

return Response.json(sessionDetail);
  } catch (error) {
    console.error("Error in session detail API:", error);
    return Response.json({ error: "Internal server error" }, { status: 500 });
  }
}