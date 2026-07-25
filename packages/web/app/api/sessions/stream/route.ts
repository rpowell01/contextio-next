import { NextRequest, NextResponse } from "next/server";
import { withRequestCache } from "@/lib/request-cache";
import { listRedactionMetaFiles, loadRedactionMeta } from "@/lib/sessions/server-utils";
import { groupCapturesIntoSessions } from "@/lib/sessions/grouping";

interface ProgressUpdate {
  type: "progress" | "complete" | "error";
  current?: number;
  total?: number;
  message?: string;
  data?: {
    summaries: any[];
    metrics: Record<string, any>;
    pagination?: {
      page: number;
      pageSize: number;
      totalPages: number;
      totalItems: number;
    };
  };
  error?: string;
}

async function* processSessionsWithProgress(page = 1, pageSize = 20): AsyncGenerator<ProgressUpdate> {
  // Send initial progress
  yield { type: "progress", current: 0, total: 0, message: "Loading session metadata..." };

  // Load redaction metadata files - these are small and contain all needed info
  const metaFiles = await listRedactionMetaFiles();
  metaFiles.sort();

  if (metaFiles.length === 0) {
    yield { type: "progress", current: 0, total: 0, message: "No sessions found" };
    yield {
      type: "complete",
      current: 0,
      total: 0,
      data: { summaries: [], metrics: {}, pagination: { page, pageSize, totalPages: 0, totalItems: 0 } },
    };
    return;
  }

  const redactionMetaBySession = new Map<
    string,
    { totalRedactions: number; byRule: Record<string, number> }
  >();

  const rawCaptures: any[] = [];

  for (let i = 0; i < metaFiles.length; i++) {
    const filename = metaFiles[i];
    try {
      const meta = await loadRedactionMeta(filename);
      if (!meta) continue;
      if (meta.sessionId?.startsWith("title-")) continue;

      if (meta.sessionId) {
        // Build raw capture data directly from metadata (fast - no full file reads!)
        const byPlaceholder = meta.matches && Array.isArray(meta.matches)
          ? {}
          : meta.byRule ? Object.fromEntries(
              Object.entries(meta.byRule).map(([rule, count]) => [rule, count])
            )
          : {};

        const existing = redactionMetaBySession.get(meta.sessionId);
        redactionMetaBySession.set(meta.sessionId, {
          totalRedactions: (existing?.totalRedactions || 0) + (meta.totalRedactions || 0),
          byRule: { ...existing?.byRule, ...byPlaceholder },
        });

        // Push capture data directly from metadata - no readCaptureFile needed!
        rawCaptures.push({
          sessionId: meta.sessionId,
          source: meta.source ?? "unknown",
          provider: meta.provider ?? "unknown",
          targetUrl: meta.targetUrl ?? "",
          requestBytes: meta.requestBytes ?? 0,
          responseBytes: meta.responseBytes ?? 0,
          timings: meta.timings ? { total_ms: meta.timings.total_ms ?? 0 } : { total_ms: 0 },
          timestamp: meta.timestamp ?? new Date().toISOString(),
          // No requestBody/responseBody needed for list view
          redactionStats: undefined, // We use aggregated redactionMetaBySession instead
        });
      }
    } catch (error) {
      console.error(`Error reading metadata ${filename}:`, error);
    }

    // Yield progress periodically
    if (i % 10 === 0 || i === metaFiles.length - 1) {
      yield { type: "progress", current: i + 1, total: metaFiles.length, message: `Loading metadata ${i + 1}/${metaFiles.length}` };
    }
  }

  // Sort by timestamp descending
  rawCaptures.sort((a, b) => new Date(b.timestamp).getTime() - new Date(a.timestamp).getTime());

  // Group into sessions
  yield { type: "progress", current: metaFiles.length, total: metaFiles.length, message: "Grouping sessions..." };
  const { summaries, metrics } = groupCapturesIntoSessions(rawCaptures, redactionMetaBySession);

  // Paginate
  const startIndex = (page - 1) * pageSize;
  const endIndex = startIndex + pageSize;
  const paginatedSummaries = summaries.slice(startIndex, endIndex);
  const totalPages = Math.ceil(summaries.length / pageSize);
  const totalItems = summaries.length;

  // Send final result
  yield {
    type: "complete",
    current: metaFiles.length,
    total: metaFiles.length,
    data: {
      summaries: paginatedSummaries,
      metrics,
      pagination: { page, pageSize, totalPages, totalItems },
    },
  };
}

export async function GET(request: NextRequest) {
  const url = new URL(request.url);
  const page = Number(url.searchParams.get("page")) || 1;
  const pageSize = Number(url.searchParams.get("pageSize")) || 20;

  // Create a readable stream for Server-Sent Events
  const stream = new ReadableStream<Uint8Array>({
    async start(controller) {
      const encoder = new TextEncoder();

      const send = (update: ProgressUpdate) => {
        controller.enqueue(encoder.encode(`data: ${JSON.stringify(update)}\n\n`));
      };

      try {
        // Process within request cache context for any operations that might need it
        await withRequestCache(async () => {
          for await (const update of processSessionsWithProgress(page, pageSize)) {
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