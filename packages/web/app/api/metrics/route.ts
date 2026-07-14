import fs from "fs/promises";
import { join } from "path";

import type { MetricsData, TrafficMetric, ProviderUsage, RedactionMetric } from "@/types/api";
import { getCaptureDir, MAX_FILE_SIZE, listCaptureFiles } from "@/lib/sessions/utils";
import { countRedactionsInResponse, getCaptureRedactionStats } from "@/lib/sessions/redaction-utils";
import { computeTokenUsage } from "@/lib/sessions/utils";

/**
 * Parse a single capture file and extract metrics.
 */
function parseCapture(data: Record<string, unknown>): {
  traffic: TrafficMetric | null;
  providerUsage: ProviderUsage | null;
  redaction: RedactionMetric | null;
} {
  const timestamp = (data.timestamp as string) ?? new Date().toISOString();
  const provider = (data.provider as string) ?? "unknown";
  const requestBytes = (data.requestBytes as number) ?? 0;
  const responseBytes = (data.responseBytes as number) ?? 0;

  const traffic: TrafficMetric = {
    timestamp,
    requestBytes,
    responseBytes,
  };

  // Extract token usage from response body (and request body as fallback)
  const responseBody = data.responseBody as string | null | undefined;
  const requestBody = data.requestBody as Record<string, unknown> | undefined;
  const tokenUsage = computeTokenUsage(responseBody, requestBody);

  const providerUsage: ProviderUsage = {
    provider,
    requestCount: 1,
    totalInputTokens: tokenUsage.input,
    totalOutputTokens: tokenUsage.output,
  };

  // Count redactions from persisted capture stats, falling back to request body only
  let redactionCount = 0;
  try {
    const cachedStats = getCaptureRedactionStats(data);
    if (cachedStats) {
      redactionCount = cachedStats.totalRedactions;
    } else {
      redactionCount = countRedactionsInResponse(
        data.responseBody as string | null | undefined,
        data.requestBody,
        false,
      ).totalRedactions;
    }
  } catch (error) {
    console.error(
      `Error counting redactions for ${data.timestamp ?? "unknown"} capture:`,
      error,
    );
  }

  const redaction: RedactionMetric = {
    timestamp,
    count: redactionCount,
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

/** Shared peak-sampling strategy: group adjacent points and take the max in each group.
 * Mirrors the client-side `downsampleData` in `traffic-chart.tsx` so server and
 * client produce identical chart representations for the same data. */
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
  try {
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
    const now = new Date();
    const cutoff = new Date(now.getTime() - hours * 60 * 60 * 1000);

    const files = await listCaptureFiles();
    const captures: Array<{
      traffic: TrafficMetric | null;
      providerUsage: ProviderUsage | null;
      redaction: RedactionMetric | null;
    }> = [];

    for (const filename of files) {
      try {
        const filepath = join(getCaptureDir(), filename);
        const stats = await fs.stat(filepath);
        if (stats.size > MAX_FILE_SIZE) {
          console.warn(`Capture file too large, skipping: ${filename}`);
          continue;
        }

        const raw = await fs.readFile(filepath, "utf8");
        const data = JSON.parse(raw) as Record<string, unknown>;
        const parsed = parseCapture(data);

        // Filter by timestamp on the server side
        if (parsed.traffic) {
          const ts = new Date(parsed.traffic.timestamp);
          if (ts < cutoff) {
            continue;
          }
        }

        captures.push(parsed);
      } catch (error) {
        console.error(`Error processing capture ${filename}:`, error);
        continue;
      }
    }

    const metrics = aggregateMetrics(captures);
    const totalTrafficPoints = metrics.traffic.length;

    // Server-side downsampling using shared function
    if (maxPoints && metrics.traffic.length > maxPoints) {
      metrics.traffic = downsampleTraffic(metrics.traffic, maxPoints);
    }

    const response = Response.json(metrics);
    if (maxPoints) {
      response.headers.set(
        "X-Data-Points-Total",
        String(totalTrafficPoints),
      );
    }
    return response;
  } catch (error) {
    console.error("Error in metrics API:", error);
    return Response.json({ error: "Internal server error" }, { status: 500 });
  }
}
