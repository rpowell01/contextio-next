import { NextRequest, NextResponse } from "next/server";
import { withRequestCache } from "@/lib/request-cache";
import { listRedactionMetaFiles, loadRedactionMeta } from "@/lib/sessions/server-utils";
import { groupCapturesIntoSessions, type RawCaptureData } from "@/lib/sessions/grouping";
import type { SessionSummary, SessionMetrics } from "@/types/api";

interface ProgressUpdate {
  type: "progress" | "complete" | "error";
  current?: number;
  total?: number;
  message?: string;
  data?: {
    session: SessionSummary;
    metrics: SessionMetrics;
    captures: Array<{
      id: string;
      timestamp: string;
      targetUrl: string;
      requestBytes: number;
      responseBytes: number;
      responseStatus: number;
      responseIsStreaming: boolean;
      timings: { total_ms: number };
      source: string;
      metrics: {
        successCount: number;
        errorCount: number;
        errorRate: number;
        totalContextValues: number;
        totalInputTokens: number;
        totalOutputTokens: number;
        tokensPerSecond: number;
        totalRedactions: number;
        model: string | null;
      };
      redactionStats?: {
        totalRedactions: number;
        byRule: Record<string, number>;
        uniqueRedactions: number;
      };
    }>;
  };
  error?: string;
}

async function* processSessionDetailWithProgress(
  sessionId: string,
): AsyncGenerator<ProgressUpdate> {
  yield { type: "progress", current: 0, total: 0, message: "Loading session metadata..." };

  const metaFiles = await listRedactionMetaFiles();
  metaFiles.sort();

  if (metaFiles.length === 0) {
    yield {
      type: "progress",
      current: 0,
      total: 0,
      message: "No sessions found",
    };
    yield {
      type: "error",
      error: "Session not found",
    };
    return;
  }

  const redactionMetaBySession = new Map<
    string,
    { totalRedactions: number; byRule: Record<string, number> }
  >();

  const rawCaptures: RawCaptureData[] = [];
  let matchedCaptures = 0;

  for (let i = 0; i < metaFiles.length; i++) {
    const filename = metaFiles[i];
    try {
      const meta = await loadRedactionMeta(filename);
      if (!meta) continue;
      if (meta.sessionId?.startsWith("title-")) continue;

      if (meta.sessionId === sessionId || (meta.sessionId === null && sessionId === "unsorted")) {
        const timings = meta.timings
          ? { total_ms: meta.timings.total_ms ?? 0 }
          : { total_ms: 0 };

        rawCaptures.push({
          sessionId: meta.sessionId,
          source: meta.source ?? "unknown",
          provider: meta.provider ?? "unknown",
          apiFormat: "unknown",
          targetUrl: meta.targetUrl ?? "",
          requestBytes: meta.requestBytes ?? 0,
          responseBytes: meta.responseBytes ?? 0,
          timings,
          timestamp: meta.timestamp ?? new Date().toISOString(),
          requestBody: undefined,
          responseBody: undefined,
          responseStatus: 200,
          responseIsStreaming: false,
          redactionStats: {
            totalRedactions: meta.totalRedactions ?? 0,
            byRule: meta.byRule ?? {},
          },
          filename,
        });

        if (meta.sessionId && meta.totalRedactions) {
          const existing = redactionMetaBySession.get(meta.sessionId);
          redactionMetaBySession.set(meta.sessionId, {
            totalRedactions: (existing?.totalRedactions || 0) + (meta.totalRedactions || 0),
            byRule: { ...existing?.byRule, ...meta.byRule },
          });
        }

        matchedCaptures++;
      }
    } catch (error) {
      console.error(`Error reading metadata ${filename}:`, error);
    }

    if (i % 10 === 0 || i === metaFiles.length - 1) {
      yield {
        type: "progress",
        current: i + 1,
        total: metaFiles.length,
        message: `Loading metadata ${i + 1}/${metaFiles.length}${matchedCaptures > 0 ? ` (${matchedCaptures} matches)` : ""}`,
      };
    }
  }

  if (rawCaptures.length === 0) {
    yield {
      type: "error",
      error: "Session not found",
    };
    return;
  }

  // Sort by timestamp descending
  rawCaptures.sort((a, b) => new Date(b.timestamp).getTime() - new Date(a.timestamp).getTime());

  yield { type: "progress", current: metaFiles.length, total: metaFiles.length, message: "Grouping session..." };

  const { summaries, metrics } = groupCapturesIntoSessions(rawCaptures, redactionMetaBySession);

  const summary = summaries[0];
  const sessionMetrics = metrics[sessionId];

  // Convert metadata filename (e.g., foo.redact-meta.json) to capture filename (foo.json)
  const metaToCaptureFilename = (metaFilename: string): string => {
    return metaFilename.replace(/\.redact-meta\.json$/, ".json");
  };

  const captures = rawCaptures.map((c) => ({
    id: c.filename ? metaToCaptureFilename(c.filename) : "",
    timestamp: c.timestamp,
    targetUrl: c.targetUrl,
    requestBytes: c.requestBytes,
    responseBytes: c.responseBytes,
    responseStatus: c.responseStatus ?? 200,
    responseIsStreaming: c.responseIsStreaming ?? false,
    timings: c.timings,
    source: c.source ?? "unknown",
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
  }));

  yield {
    type: "complete",
    current: metaFiles.length,
    total: metaFiles.length,
    data: {
      session: summary,
      metrics: sessionMetrics,
      captures,
    },
  };
}

export async function GET(
  _request: NextRequest,
  { params }: { params: Promise<{ id: string }> },
) {
  const { id: sessionId } = await params;

  const stream = new ReadableStream<Uint8Array>({
    async start(controller) {
      const encoder = new TextEncoder();

      const send = (update: ProgressUpdate) => {
        controller.enqueue(encoder.encode(`data: ${JSON.stringify(update)}\n\n`));
      };

      try {
        await withRequestCache(async () => {
          for await (const update of processSessionDetailWithProgress(sessionId)) {
            send(update);
          }
        });
      } catch (error) {
        send({ type: "error", error: error instanceof Error ? error.message : "Unknown error" });
      } finally {
        controller.close();
      }
    },
  });

  return new NextResponse(stream, {
    headers: {
      "Content-Type": "text/event-stream",
      "Cache-Control": "no-cache",
      "Connection": "keep-alive",
    },
  });
}