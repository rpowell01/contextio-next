import fs from "node:fs/promises";
import { join } from "node:path";
import type { SessionDetail, SessionMetrics } from "@/types/api";
import { listCaptureFiles, CAPTURE_DIR, MAX_FILE_SIZE } from "@/lib/sessions/utils";

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

    // Count context values from request body
    if (c.requestBody && typeof c.requestBody === "object") {
      const body = c.requestBody as Record<string, unknown>;
      for (const [key, value] of Object.entries(body)) {
        if (typeof value === "string" || typeof value === "number" || typeof value === "boolean") {
          contextValues[key] = value;
          totalContextValues++;
        } else if (value !== null && typeof value === "object") {
          for (const [subKey, subValue] of Object.entries(value)) {
            if (typeof subValue === "string" || typeof subValue === "number" || typeof subValue === "boolean") {
              contextValues[`${key}.${subKey}`] = subValue;
              totalContextValues++;
            }
          }
        }
      }
    }

    // Parse response for tokens and redactions
    if (c.responseBody) {
      try {
        const parsed = JSON.parse(c.responseBody);
        if (parsed.usage?.prompt_tokens) {
          totalInputTokens += parsed.usage.prompt_tokens;
        }
        if (parsed.usage?.completion_tokens) {
          totalOutputTokens += parsed.usage.completion_tokens;
        }
      } catch { /* ignore */ }

      // Count redactions from response body
      if (typeof c.responseBody === "string") {
        const redactedMatches = c.responseBody.match(/\[[A-Z]+_\d+\]/g) || [];
        for (const match of redactedMatches) {
          const matchClean = match.replace(/\[\s*|\s*\]/g, "");
          const parts = matchClean.split("_");
          if (parts.length >= 2) {
            const ruleType = parts.slice(0, -1).join("_");
            byRule[ruleType] = (byRule[ruleType] || 0) + 1;
            totalRedactions++;
          }
        }
      }
    }
  }

  const timeSec = totalTimeMs / 1000 || 1;
  const inboundThroughput = totalRequestBytes / timeSec;
  const outboundThroughput = totalResponseBytes / timeSec;

  const firstCapture = sessionCaptures[0];
  const source = firstCapture?.source || "unknown";
  const destination = firstCapture?.provider || "unknown";

  const metrics: SessionMetrics = {
    totalInboundBytes: totalRequestBytes,
    totalOutboundBytes: totalResponseBytes,
    inboundThroughput,
    outboundThroughput,
    totalContextValues,
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
      } catch {
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
      requestBody: {},
      responseStatus,
      responseIsStreaming,
      responseBody: null,
      timestamp: firstTimestamp,
      timings: { total_ms: totalTimeMs },
      metrics,
      contextValues,
      redactionStats,
    };

    return Response.json(sessionDetail);
  } catch (error) {
    console.error("Error in session detail API:", error);
    return Response.json({ error: "Internal server error" }, { status: 500 });
  }
}