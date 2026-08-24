import { NextResponse } from "next/server";
import type { RetryMetrics } from "@/types/client-api";
import { createSuccessResponse } from "@contextio/core";

// Proxy admin API URL (for server-side requests)
const PROXY_ADMIN_URL =
  process.env.NEXT_PUBLIC_PROXY_ADMIN_URL || "http://localhost:4040";

export async function GET() {
  try {
    // Fetch real retry metrics from the proxy admin API
    const response = await fetch(`${PROXY_ADMIN_URL}/admin/retry-metrics`, {
      cache: "no-store",
      headers: {
        "Cache-Control": "no-cache, no-store, must-revalidate",
        Pragma: "no-cache",
        Expires: "0",
      },
    });
    if (!response.ok) {
      throw new Error(`Proxy admin API returned ${response.status}`);
    }
    let metrics: RetryMetrics;
    try {
      metrics = await response.json();
    } catch (e: unknown) {
      throw new Error(
        `Failed to parse retry metrics JSON: ${
          e instanceof Error ? e.message : "Unknown error"
        }`,
      );
    }
    return NextResponse.json(createSuccessResponse(metrics), {
      headers: {
        "Cache-Control": "no-cache, no-store, must-revalidate",
        Pragma: "no-cache",
        Expires: "0",
      },
    });
  } catch (error) {
    console.error("Error in retry-metrics API:", error);
    // Fallback to empty state if proxy is unreachable
    return NextResponse.json(
      createSuccessResponse({
        providers: [],
        totals: {
          totalNonStreamingRetries: 0,
          totalStreamingRetries: 0,
          totalRetryAttempts: 0,
          totalActiveStreamingSessions: 0,
          totalCurrentBufferUsageMB: 0,
          totalMaxBufferUsageMB: 0,
        },
      } satisfies RetryMetrics),
      {
        headers: {
          "Cache-Control": "no-cache, no-store, must-revalidate",
          Pragma: "no-cache",
          Expires: "0",
        },
      },
    );
  }
}
