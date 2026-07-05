import fs from "node:fs/promises";
import { join } from "node:path";

import type { MetricsData, TrafficMetric, ProviderUsage, RedactionMetric } from "@/types/api";
import { CAPTURE_DIR, MAX_FILE_SIZE, listCaptureFiles } from "@/lib/sessions/utils";
import { countRedactionsInResponse } from "@/lib/sessions/redaction-utils";

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

   const providerUsage: ProviderUsage = {
     provider,
     requestCount: 1,
     totalInputTokens: 0,
     totalOutputTokens: 0,
   };

   // Compute redactions from request and response bodies
   let redactionCount = 0;
   try {
     const redactionCounts = countRedactionsInResponse(
       data.responseBody as string | null | undefined,
       data.requestBody
     );
     redactionCount = redactionCounts.totalRedactions;
   } catch (e) {
     console.error("Failed to count redactions in capture:", e);
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
        providerMap.set(capture.providerUsage.provider, { ...capture.providerUsage });
      }
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
    totalInputTokens,
    totalOutputTokens,
  };
}

export async function GET(_request: Request): Promise<Response> {
  try {
    const files = await listCaptureFiles();
    const captures: Array<{
      traffic: TrafficMetric | null;
      providerUsage: ProviderUsage | null;
      redaction: RedactionMetric | null;
    }> = [];

    for (const filename of files) {
      try {
        const filepath = join(CAPTURE_DIR, filename);
        const stats = await fs.stat(filepath);
        if (stats.size > MAX_FILE_SIZE) {
          console.warn(`Capture file too large, skipping: ${filename}`);
          continue;
        }

        const raw = await fs.readFile(filepath, "utf8");
        const data = JSON.parse(raw) as Record<string, unknown>;
        captures.push(parseCapture(data));
      } catch (error) {
        console.error(`Error processing capture ${filename}:`, error);
        continue;
      }
    }

    const metrics = aggregateMetrics(captures);
    return Response.json(metrics);
  } catch (error) {
    console.error("Error in metrics API:", error);
    return Response.json(
      { error: "Internal server error" },
      { status: 500 },
    );
  }
}