import { NextResponse } from "next/server";
import type { RateLimiterMetrics } from "@/types/api";

// Proxy admin API URL (for server-side requests)
const PROXY_ADMIN_URL =
  process.env.NEXT_PUBLIC_PROXY_ADMIN_URL || "http://localhost:4040";

export async function GET() {
  try {
    // Fetch real rate limiter metrics from the proxy admin API
    const response = await fetch(`${PROXY_ADMIN_URL}/admin/rate-limiter`, {
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
    let metrics: RateLimiterMetrics;
    try {
      metrics = await response.json();
    } catch (e: unknown) {
      throw new Error(
        `Failed to parse rate limiter metrics JSON: ${
          e instanceof Error ? e.message : "Unknown error"
        }`,
      );
    }
    return NextResponse.json(metrics, {
      headers: {
        "Cache-Control": "no-cache, no-store, must-revalidate",
        Pragma: "no-cache",
        Expires: "0",
      },
    });
  } catch (error) {
    console.error("Error in rate-limiter API:", error);
    // Fallback to disabled state if proxy is unreachable
    return NextResponse.json({
      config: {
        maxRequests: 60,
        windowMs: 60000,
        bufferCapacity: 10,
        maxEntries: 10000,
        enabled: false,
      },
      buckets: [],
      totalBuckets: 0,
      totalQueued: 0,
      timestamp: new Date().toISOString(),
      code: "RATE_LIMITER_UNAVAILABLE",
    } satisfies RateLimiterMetrics, {
      headers: {
        "Cache-Control": "no-cache, no-store, must-revalidate",
        Pragma: "no-cache",
        Expires: "0",
      },
    });
  }
}