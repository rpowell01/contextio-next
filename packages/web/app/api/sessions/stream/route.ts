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

async function processSessionsWithProgress(page = 1, pageSize = 20): Promise<{
  summaries: any[];
  metrics: Record<string, any>;
  pagination: { page: number; pageSize: number; totalPages: number; totalItems: number };
}> {
  // Load redaction metadata first
  const metaFiles = await listRedactionMetaFiles();
  metaFiles.sort();

  const redactionMetaBySession = new Map<
    string,
    { totalRedactions: number; byRule: Record<string, number> }
  >();

  for (const filename of metaFiles) {
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

        // Simple conversion for now
        const existing = redactionMetaBySession.get(meta.sessionId);
        redactionMetaBySession.set(meta.sessionId, {
          totalRedactions: (existing?.totalRedactions || 0) + (meta.totalRedactions || 0),
          byRule: { ...existing?.byRule, ...byPlaceholder },
        });
      }
    } catch {
      // Skip invalid meta files
    }
  }

  // List all capture files
  const files = await listCaptureFiles();

  // Extract session info from files
  const captureDir = await getCaptureDir();
  const sessionsData: any[] = [];

  // Read all files with progress
  let current = 0;

  for (const filename of files) {
    current++;

    try {
      const filepath = join(captureDir, filename);
      const stats = await new Promise<{ size: number }>((resolve, reject) => {
        const fs = require("fs");
        fs.stat(filepath, (err: any, stats: any) => err ? reject(err) : resolve(stats));
      });

      if (stats.size > MAX_FILE_SIZE) {
        continue;
      }

      const data = await readCaptureFile(filepath);
      if (!data) {
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
    } catch (error) {
      console.error(`Error processing ${filename}:`, error);
    }
  }

  // Sort by timestamp descending
  sessionsData.sort((a, b) => new Date(b.timestamp).getTime() - new Date(a.timestamp).getTime());

  // Group into sessions
  const { summaries, metrics } = groupCapturesIntoSessions(sessionsData, redactionMetaBySession);

  // Paginate
  const startIndex = (page - 1) * pageSize;
  const endIndex = startIndex + pageSize;
  const paginatedSummaries = summaries.slice(startIndex, endIndex);
  const totalPages = Math.ceil(summaries.length / pageSize);
  const totalItems = summaries.length;

  return {
    summaries: paginatedSummaries,
    metrics,
    pagination: { page, pageSize, totalPages, totalItems },
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
        // Send initial progress
        send({ type: "progress", current: 0, total: 0, message: "Starting session load..." });

        // Process within request cache context
        const result = await withRequestCache(async () => {
          return await processSessionsWithProgress(page, pageSize);
        });

        // Send progress updates during processing (simulate since we now do it all at once)
        const files = await listCaptureFiles();
        for (let i = 1; i <= files.length; i++) {
          send({ type: "progress", current: i, total: files.length, message: `Processing file ${i} of ${files.length}` });
        }

        // Send final result
        send({
          type: "complete",
          current: files.length,
          total: files.length,
          data: {
            summaries: result.summaries,
            metrics: result.metrics,
            pagination: result.pagination,
          },
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