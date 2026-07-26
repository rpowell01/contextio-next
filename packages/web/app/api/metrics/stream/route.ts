import { NextRequest, NextResponse } from "next/server";
import { withRequestCache } from "@/lib/request-cache";
import { listRedactionMetaFiles, loadRedactionMeta } from "@/lib/sessions/server-utils";
import { ruleNameToPlaceholder } from "@/lib/sessions/placeholder-map";
import type { MetricsData, TrafficMetric, ProviderUsage, RedactionMetric } from "@/types/api";

interface ProgressUpdate {
  type: "progress" | "complete" | "error";
  current?: number;
  total?: number;
  message?: string;
  data?: MetricsData & {
    pagination?: {
      page: number;
      pageSize: number;
      totalPages: number;
      totalItems: number;
    };
  };
  error?: string;
}

function parseCaptureMeta(meta: {
  timestamp?: string | null;
  provider?: string | null;
  requestBytes?: number;
  responseBytes?: number;
  totalRedactions: number;
  byRule?: Record<string, number>;
}) {
  const timestamp = meta.timestamp ?? new Date().toISOString();
  const provider = meta.provider ?? "unknown";
  const requestBytes = meta.requestBytes ?? 0;
  const responseBytes = meta.responseBytes ?? 0;

  const traffic: TrafficMetric = {
    timestamp,
    requestBytes,
    responseBytes,
  };

  const providerUsage: ProviderUsage = {
    provider,
    requestCount: 1,
    totalInputTokens: 0,
    totalOutputTokens: 0,
  };

  const redaction: RedactionMetric = {
    timestamp,
    count: meta.totalRedactions,
  };

  return { traffic, providerUsage, redaction };
}

function downsampleTraffic(
  data: TrafficMetric[],
  maxPoints: number,
): TrafficMetric[] {
  if (data.length <= maxPoints) return data;
  const step = Math.ceil(data.length / maxPoints);
  const result: TrafficMetric[] = [];
  for (let i = 0; i < data.length; i += step) {
    const chunk = data.slice(i, i + step);
    const maxRequest = Math.max(...chunk.map((d) => d.requestBytes));
    const maxResponse = Math.max(...chunk.map((d) => d.responseBytes));
    result.push({
      timestamp: chunk[chunk.length - 1].timestamp,
      requestBytes: maxRequest,
      responseBytes: maxResponse,
    });
  }
  return result;
}

async function* processMetricsWithProgress(
  hours: number,
  maxPoints: number | undefined,
  page: number,
  pageSize: number,
  hasPageParam: boolean,
): AsyncGenerator<ProgressUpdate> {
  yield { type: "progress", current: 0, total: 0, message: "Loading metadata files..." };

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
      type: "complete",
      current: 0,
      total: 0,
      data: {
        traffic: [],
        providers: [],
        redactions: [],
        totalRequestBytes: 0,
        totalResponseBytes: 0,
        totalInputTokens: undefined,
        totalOutputTokens: undefined,
        totalRedactionsDeduped: 0,
        totalRedactionsSum: 0,
        redactionByPlaceholderDeduped: {},
        redactionByPlaceholderSum: {},
        pagination: { page, pageSize, totalPages: 0, totalItems: 0 },
      },
    };
    return;
  }

  const now = new Date();
  const cutoff = new Date(now.getTime() - hours * 60 * 60 * 1000);

  const trafficMap = new Map<string, TrafficMetric>();
  const providerMap = new Map<string, ProviderUsage>();
  const redactions: RedactionMetric[] = [];

  let totalRequestBytes = 0;
  let totalResponseBytes = 0;
  let totalInputTokens = 0;
  let totalOutputTokens = 0;
  let totalRedactionsSum = 0;

  const redactionBySession = new Map<string, number>();
  const redactionByPlaceholderDeduped: Record<string, Map<string, number>> = {};
  const redactionByPlaceholderSum: Record<string, number> = {};

  for (let i = 0; i < metaFiles.length; i++) {
    const filename = metaFiles[i];
    try {
      const meta = await loadRedactionMeta(filename);
      if (!meta) continue;
      if (meta.sessionId?.startsWith("title-")) continue;

      if (meta.timestamp) {
        const ts = new Date(meta.timestamp);
        if (ts < cutoff) {
          continue;
        }
      }

      const parsed = parseCaptureMeta(meta);

      if (parsed.traffic) {
        const key = parsed.traffic.timestamp;
        trafficMap.set(key, parsed.traffic);
        totalRequestBytes += parsed.traffic.requestBytes;
        totalResponseBytes += parsed.traffic.responseBytes;
      }

      if (parsed.providerUsage) {
        const existing = providerMap.get(parsed.providerUsage.provider);
        if (existing) {
          existing.requestCount += parsed.providerUsage.requestCount;
          existing.totalInputTokens += parsed.providerUsage.totalInputTokens;
          existing.totalOutputTokens += parsed.providerUsage.totalOutputTokens;
        } else {
          providerMap.set(parsed.providerUsage.provider, {
            ...parsed.providerUsage,
          });
        }
        totalInputTokens += parsed.providerUsage.totalInputTokens;
        totalOutputTokens += parsed.providerUsage.totalOutputTokens;
      }

      if (parsed.redaction) {
        redactions.push(parsed.redaction);
      }

      totalRedactionsSum += meta.totalRedactions ?? 0;

      if (meta.byRule && typeof meta.byRule === "object") {
        for (const [rule, count] of Object.entries(meta.byRule)) {
          if (typeof count === "number") {
            const placeholder = ruleNameToPlaceholder(rule);
            redactionByPlaceholderSum[placeholder] = (redactionByPlaceholderSum[placeholder] ?? 0) + count;
          }
        }
      }

      if (meta.sessionId &&
        typeof meta.totalRedactions === "number" &&
        meta.totalRedactions > 0
      ) {
        const existing = redactionBySession.get(meta.sessionId);
        if (existing === undefined || meta.totalRedactions > existing) {
          redactionBySession.set(meta.sessionId, meta.totalRedactions);
        }
      }

      if (meta.sessionId && meta.byRule && typeof meta.byRule === "object") {
        for (const [rule, count] of Object.entries(meta.byRule)) {
          if (typeof count === "number") {
            const placeholder = ruleNameToPlaceholder(rule);
            if (!redactionByPlaceholderDeduped[placeholder]) {
              redactionByPlaceholderDeduped[placeholder] = new Map<string, number>();
            }
            const sessionMap = redactionByPlaceholderDeduped[placeholder];
            const existing = sessionMap.get(meta.sessionId);
            if (existing === undefined || count > existing) {
              sessionMap.set(meta.sessionId, count);
            }
          }
        }
      }
    } catch (error) {
      console.error(`Error processing metadata ${filename}:`, error);
    }

    if (i % 10 === 0 || i === metaFiles.length - 1) {
      yield { type: "progress", current: i + 1, total: metaFiles.length, message: `Processing metadata ${i + 1}/${metaFiles.length}` };
    }
  }

  let totalRedactionsDeduped = 0;
  const redactionByPlaceholderDedupedFinal: Record<string, number> = {};

  for (const sessionId of redactionBySession.keys()) {
    totalRedactionsDeduped += redactionBySession.get(sessionId) ?? 0;
  }

  for (const [placeholder, sessionMap] of Object.entries(redactionByPlaceholderDeduped)) {
    let ruleSum = 0;
    for (const count of sessionMap.values()) {
      ruleSum += count;
    }
    if (ruleSum > 0) {
      redactionByPlaceholderDedupedFinal[placeholder] = ruleSum;
    }
  }

  // Convert traffic map to array
  const traffic = Array.from(trafficMap.values());
  traffic.sort((a, b) => new Date(a.timestamp).getTime() - new Date(b.timestamp).getTime());

  const totalTrafficPoints = traffic.length;
  const startIndex = (page - 1) * pageSize;
  const endIndex = startIndex + pageSize;
  const paginatedTraffic = traffic.slice(startIndex, endIndex);
  const totalPages = Math.ceil(totalTrafficPoints / pageSize);

  // Server-side downsampling if maxPoints is specified and no pagination
  let finalTraffic = paginatedTraffic;
  if (maxPoints && !hasPageParam) {
    finalTraffic = downsampleTraffic(traffic, maxPoints);
  }

  const providers = Array.from(providerMap.values());

  yield {
    type: "complete",
    current: metaFiles.length,
    total: metaFiles.length,
    data: {
      traffic: finalTraffic,
      providers,
      redactions,
      totalRequestBytes,
      totalResponseBytes,
      totalInputTokens: totalInputTokens === 0 ? undefined : totalInputTokens,
      totalOutputTokens: totalOutputTokens === 0 ? undefined : totalOutputTokens,
      totalRedactionsDeduped,
      totalRedactionsSum,
      redactionByPlaceholderDeduped: redactionByPlaceholderDedupedFinal,
      redactionByPlaceholderSum,
      pagination: { page, pageSize, totalPages, totalItems: totalTrafficPoints },
    },
  };
}

export async function GET(request: NextRequest) {
  const url = new URL(request.url);
  const hours = Number(url.searchParams.get("hours")) || 24;
  const maxPoints = url.searchParams.get("maxPoints") ? Number(url.searchParams.get("maxPoints")) : undefined;
  const page = Number(url.searchParams.get("page")) || 1;
  const pageSize = Number(url.searchParams.get("pageSize")) || 50;

  const stream = new ReadableStream<Uint8Array>({
    async start(controller) {
      const encoder = new TextEncoder();

      const send = (update: ProgressUpdate) => {
        controller.enqueue(encoder.encode(`data: ${JSON.stringify(update)}\n\n`));
      };

      try {
        await withRequestCache(async () => {
          for await (const update of processMetricsWithProgress(hours, maxPoints, page, pageSize, url.searchParams.has("page"))) {
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