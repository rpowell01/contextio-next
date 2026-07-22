import type { MetricsData, TrafficMetric, ProviderUsage, RedactionMetric } from "@/types/api";
import { listRedactionMetaFiles, loadRedactionMeta } from "@/lib/sessions/utils";
import { withRequestCache } from "@/lib/request-cache";

/**
 * Parse a single capture metadata and extract metrics.
 */
function parseCaptureMeta(meta: {
  timestamp?: string | null;
  provider?: string | null;
  requestBytes?: number;
  responseBytes?: number;
  totalRedactions: number;
}): {
  traffic: TrafficMetric | null;
  providerUsage: ProviderUsage | null;
  redaction: RedactionMetric | null;
} {
  const timestamp = meta.timestamp ?? new Date().toISOString();
  const provider = meta.provider ?? "unknown";
  const requestBytes = meta.requestBytes ?? 0;
  const responseBytes = meta.responseBytes ?? 0;

  const traffic: TrafficMetric = {
    timestamp,
    requestBytes,
    responseBytes,
  };

  // Token usage is not available in metadata files (requires full response body)
  // So we return 0 for tokens in metadata-only mode
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

/**
 * Aggregate metrics from all capture files.
 */
function aggregateMetrics(
  captures: Array<{
    traffic: TrafficMetric | null;
    providerUsage: ProviderUsage | null;
    redaction: RedactionMetric | null;
  }>,
): MetricsData {
  const traffic: TrafficMetric[] = [];
  const providerMap: Map<string, ProviderUsage> = new Map();
  const redactions: RedactionMetric[] = [];

  let totalRequestBytes = 0;
  let totalResponseBytes = 0;
  let totalInputTokens = 0;
  let totalOutputTokens = 0;

  for (const capture of captures) {
    if (capture.traffic) {
      traffic.push(capture.traffic);
      totalRequestBytes += capture.traffic.requestBytes;
      totalResponseBytes += capture.traffic.responseBytes;
    }

    if (capture.providerUsage) {
      const existing = providerMap.get(capture.providerUsage.provider);
      if (existing) {
        existing.requestCount += capture.providerUsage.requestCount;
        existing.totalInputTokens += capture.providerUsage.totalInputTokens;
        existing.totalOutputTokens += capture.providerUsage.totalOutputTokens;
      } else {
        providerMap.set(capture.providerUsage.provider, {
          ...capture.providerUsage,
        });
      }
      totalInputTokens += capture.providerUsage.totalInputTokens;
      totalOutputTokens += capture.providerUsage.totalOutputTokens;
    }

    if (capture.redaction) {
      redactions.push(capture.redaction);
    }
  }

  const providers = Array.from(providerMap.values());

  return {
    traffic,
    providers,
    redactions,
    totalRequestBytes,
    totalResponseBytes,
    totalInputTokens: totalInputTokens === 0 ? undefined : totalInputTokens,
    totalOutputTokens: totalOutputTokens === 0 ? undefined : totalOutputTokens,
  };
}

/**
 * Shared peak-sampling strategy: group adjacent points and take the max in each group.
 * Mirrors the client-side `downsampleData` in `traffic-chart.tsx` so server and
 * client produce identical chart representations for the same data.
 */
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

export async function GET(request: Request): Promise<Response> {
  return withRequestCache(async () => {
    const url = new URL(request.url);

    // Parse query params
    const hoursValue = Number(url.searchParams.get("hours"));
    const hours =
      Number.isFinite(hoursValue) && hoursValue > 0 ? Math.trunc(hoursValue) : 24;
    const maxPointsValue = Number(url.searchParams.get("maxPoints"));
    const maxPoints =
      Number.isFinite(maxPointsValue) && maxPointsValue > 0
        ? Math.trunc(maxPointsValue)
        : undefined;
    const pageValue = Number(url.searchParams.get("page"));
    const page = Number.isFinite(pageValue) && pageValue > 0 ? pageValue : 1;
    const pageSizeValue = Number(url.searchParams.get("pageSize"));
    const pageSize =
      Number.isFinite(pageSizeValue) && pageSizeValue > 0
        ? pageSizeValue
        : 50;
    const now = new Date();
    const cutoff = new Date(now.getTime() - hours * 60 * 60 * 1000);

    const metaFiles = await listRedactionMetaFiles();
    const captures: Array<{
      traffic: TrafficMetric | null;
      providerUsage: ProviderUsage | null;
      redaction: RedactionMetric | null;
    }> = [];

    for (const filename of metaFiles) {
      try {
        const meta = await loadRedactionMeta(filename);
        if (!meta) continue;

        // Filter by timestamp on the server side
        if (meta.timestamp) {
          const ts = new Date(meta.timestamp);
          if (ts < cutoff) {
            continue;
          }
        }

        const parsed = parseCaptureMeta(meta);
        captures.push(parsed);
      } catch (error) {
        console.error(`Error processing metadata ${filename}:`, error);
        continue;
      }
    }

    const metrics = aggregateMetrics(captures);

    // Sort traffic by timestamp to ensure chronological order
    metrics.traffic.sort(
      (a, b) => new Date(a.timestamp).getTime() - new Date(b.timestamp).getTime(),
    );
    const totalTrafficPoints = metrics.traffic.length;
    const totalPages = Math.ceil(totalTrafficPoints / pageSize);

    // Apply pagination
    const startIndex = (page - 1) * pageSize;
    const endIndex = startIndex + pageSize;
    const paginatedTraffic = metrics.traffic.slice(startIndex, endIndex);

    // Server-side downsampling using shared function (only if maxPoints is specified and no pagination)
    if (maxPoints && !url.searchParams.has("page")) {
      metrics.traffic = downsampleTraffic(metrics.traffic, maxPoints);
    } else {
      metrics.traffic = paginatedTraffic;
    }

    const response = Response.json({
      ...metrics,
      traffic: metrics.traffic,
      pagination: {
        page,
        pageSize,
        totalPages,
        totalItems: totalTrafficPoints,
      },
    });
    if (maxPoints) {
      response.headers.set(
        "X-Data-Points-Total",
        String(totalTrafficPoints),
      );
    }
    return response;
  });
}
