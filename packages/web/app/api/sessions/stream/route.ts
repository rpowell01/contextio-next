import { join } from "path";
import { NextRequest, NextResponse } from "next/server";
import { withRequestCache } from "@/lib/request-cache";
import { listCaptureFiles, getCaptureDir, MAX_FILE_SIZE, readCaptureFile, getSessionMetadata, listRedactionMetaFiles, loadRedactionMeta, extractCaptureMetadata } from "@/lib/sessions/server-utils";
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
  yield { type: "progress", current: 0, total: 0, message: "Loading redaction metadata..." };

  // Load redaction metadata first
  const metaFiles = await listRedactionMetaFiles();
  metaFiles.sort();

  const redactionMetaBySession = new Map<
    string,
    { totalRedactions: number; byRule: Record<string, number> }
  >();

  for (let i = 0; i < metaFiles.length; i++) {
    const filename = metaFiles[i];
    try {
      const meta = await loadRedactionMeta(filename);
      if (!meta) continue;
      if (meta.sessionId?.startsWith("title-")) continue;

      if (meta.sessionId) {
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
      }
    } catch {
      // Skip invalid meta files
    }

    // Yield progress periodically
    if (i % 10 === 0 || i === metaFiles.length - 1) {
      yield { type: "progress", current: i + 1, total: metaFiles.length, message: `Loading metadata ${i + 1}/${metaFiles.length}` };
    }
  }

  // Send progress after metadata
  yield { type: "progress", current: 0, total: 0, message: "Listing capture files..." };

  // List all capture files
  const files = await listCaptureFiles();

  if (files.length === 0) {
    yield { type: "progress", current: 0, total: 0, message: "No capture files found" };
    yield {
      type: "complete",
      current: 0,
      total: 0,
      data: { summaries: [], metrics: {}, pagination: { page, pageSize, totalPages: 0, totalItems: 0 } },
    };
    return;
  }

  // Extract session info from files
  const captureDir = await getCaptureDir();
  const sessionsData: any[] = [];

  // Read all files with progress
  let current = 0;
  const total = files.length;

  for (const filename of files) {
    current++;

    try {
      const filepath = join(captureDir, filename);
      const stats = await new Promise<{ size: number }>((resolve, reject) => {
        const fs = require("fs");
        fs.stat(filepath, (err: any, stats: any) => err ? reject(err) : resolve(stats));
      });

      if (stats.size > MAX_FILE_SIZE) {
        yield { type: "progress", current, total, message: `Skipping large file: ${filename}` };
        continue;
      }

      const data = await readCaptureFile(filepath);
      if (!data) {
        yield { type: "progress", current, total, message: `Skipping empty file: ${filename}` };
        continue;
      }

      const session = await getSessionMetadata(filename, data);
      // Extract requestBytes, responseBytes, and redactionStats from raw capture data
      const rawMeta = extractCaptureMetadata(filename, data);

      sessionsData.push({
        sessionId: session.sessionId,
        source: session.source,
        provider: session.provider,
        apiFormat: session.apiFormat,
        targetUrl: session.targetUrl,
        requestBytes: rawMeta.requestBytes ?? 0,
        responseBytes: rawMeta.responseBytes ?? 0,
        timings: session.timings,
        timestamp: session.timestamp,
        requestBody: session.requestBody,
        responseBody: session.responseBody,
        responseStatus: session.responseStatus,
        responseIsStreaming: session.responseIsStreaming,
        redactionStats: data.redactionStats as
          | { totalRedactions: number; byRule: Record<string, number> }
          | undefined,
        filename,
      });

      // Yield progress every few files or at the end
      if (current % 5 === 0 || current === total) {
        yield { type: "progress", current, total, message: `Processing ${filename}` };
      }
    } catch (error) {
      console.error(`Error processing ${filename}:`, error);
      yield { type: "progress", current, total, message: `Error: ${filename}` };
    }
  }

  // Sort by timestamp descending
  sessionsData.sort((a, b) => new Date(b.timestamp).getTime() - new Date(a.timestamp).getTime());

  // Group into sessions
  yield { type: "progress", current: total, total, message: "Grouping sessions..." };
  const { summaries, metrics } = groupCapturesIntoSessions(sessionsData, redactionMetaBySession);

  // Paginate
  const startIndex = (page - 1) * pageSize;
  const endIndex = startIndex + pageSize;
  const paginatedSummaries = summaries.slice(startIndex, endIndex);
  const totalPages = Math.ceil(summaries.length / pageSize);
  const totalItems = summaries.length;

  // Send final result
  yield {
    type: "complete",
    current: total,
    total,
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
        // Process within request cache context - wrap the entire generator iteration
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