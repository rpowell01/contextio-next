"use client";

import { MainLayout } from "@/components/main-layout";
import { formatBytes, formatNumber } from "@/lib/utils";
import { apiClient } from "@/lib/api";
import type {
  MetricsData,
  TimeRange,
  RateLimiterMetrics,
} from "@/types/api";
import { TrafficChart } from "@/components/traffic-chart";
import { RateLimiterChart } from "@/components/rate-limiter-chart";
import { useEffect, useState, useCallback, useRef, useMemo } from "react";
import { usePageLoad } from "@/components/page-load-context";
import { ProgressBar } from "@/components/ui/progress-bar";

const TIME_RANGES: TimeRange[] = [
  { value: "1h", label: "Last hour", hours: 1 },
  { value: "6h", label: "Last 6 hours", hours: 6 },
  { value: "24h", label: "Last 24 hours", hours: 24 },
  { value: "7d", label: "Last 7 days", hours: 168 },
  { value: "30d", label: "Last 30 days", hours: 720 },
];

const MAX_DATA_POINTS_OPTIONS = [
  { value: "50", label: "50 points" },
  { value: "100", label: "100 points" },
  { value: "200", label: "200 points" },
  { value: "500", label: "500 points" },
  { value: "1000", label: "1000 points" },
  { value: "0", label: "Unlimited" },
];

/**
 * Inner content component that uses usePageLoad.
 * Must be rendered inside MainLayout (which provides PageLoadProvider).
 */
function MetricsContent() {
  const [metrics, setMetrics] = useState<MetricsData | null>(null);
  const [rateLimiterMetrics, setRateLimiterMetrics] = useState<RateLimiterMetrics | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const [progress, setProgress] = useState<{ current: number; total: number; message: string } | null>(null);
  const [timeRange, setTimeRange] = useState<TimeRange>(TIME_RANGES[2]); // default 24h
  const [maxDataPoints, setMaxDataPoints] = useState<number>(50);
  const [page, setPage] = useState<number>(1);
  const [pageSize] = useState<number>(50);
  const [rateLimiterError, setRateLimiterError] = useState<string | null>(null);
  const [rateLimiterLoading, setRateLimiterLoading] = useState(true);

  // Memoized sorted buckets for the table to avoid re-sorting on every render
  const sortedBuckets = useMemo(
    () =>
      rateLimiterMetrics?.buckets
        ? [...rateLimiterMetrics.buckets].sort((a, b) => a.tokens - b.tokens)
        : [],
    [rateLimiterMetrics?.buckets],
  );

  // Page load tracking for footer
  const { registerPageLoad, registerPageReady } = usePageLoad();

  // Refs for polling
  const pollingIntervalRef = useRef<ReturnType<typeof setInterval> | null>(null);
  const abortControllerRef = useRef<AbortController | null>(null);
  const isMountedRef = useRef(true);
  const requestIdRef = useRef(0);

  const progressPercent = progress && progress.total > 0
    ? Math.round((progress.current / progress.total) * 100)
    : 0;

  const fetchMetrics = useCallback(async () => {
    // Signal that page loading has started
    registerPageLoad();
    setLoading(true);
    setError(null);
    setProgress({ current: 0, total: 0, message: "Starting..." });

    try {
      const stream = await apiClient.getMetricsStream(
        timeRange.hours,
        maxDataPoints || undefined,
        page,
        pageSize,
      );

      for await (const update of stream) {
        if (!isMountedRef.current) break;
        
        if (update.type === "progress") {
          setProgress({
            current: update.current || 0,
            total: update.total || 0,
            message: update.message || "",
          });
        } else if (update.type === "complete" && update.data) {
          setMetrics(update.data as MetricsData);
          setProgress({ current: update.total || 0, total: update.total || 0, message: "Complete" });
          setLoading(false);
          registerPageReady();
        } else if (update.type === "error") {
          throw new Error(update.error || "Streaming error");
        }
      }
    } catch (e) {
      setError(e instanceof Error ? e.message : "Unknown error");
      setMetrics(null);
      setLoading(false);
      registerPageReady();
    }
  }, [timeRange, maxDataPoints, page, pageSize, registerPageLoad, registerPageReady]);

  // Fetch rate limiter metrics
  const fetchRateLimiterMetrics = useCallback(async (signal?: AbortSignal, requestId?: number): Promise<boolean> => {
    if (!isMountedRef.current) return false;
    setRateLimiterLoading(true);
    try {
      const data = await apiClient.getRateLimiterMetrics(signal);
      // Only update if this request is still the latest one
      if (isMountedRef.current && (requestId === undefined || requestId === requestIdRef.current)) {
        // Only update state if data actually changed to avoid unnecessary re-renders
        setRateLimiterMetrics(prev => {
          // Compare buckets array - check length and each bucket's tokens, maxTokens, queueLength
          if (!prev || !prev.buckets) return data;
          const prevBuckets = prev.buckets;
          const newBuckets = data.buckets;
          if (prevBuckets.length !== newBuckets.length) return data;
          for (let i = 0; i < prevBuckets.length; i++) {
            if (prevBuckets[i].tokens !== newBuckets[i].tokens ||
                prevBuckets[i].maxTokens !== newBuckets[i].maxTokens ||
                prevBuckets[i].queueLength !== newBuckets[i].queueLength) {
              return data; // Data changed
            }
          }
          return prev; // Data unchanged, keep previous state
        });
        setRateLimiterError(null);
      }
      return true;
    } catch (e) {
      // Ignore aborted requests - the API throws "Request aborted" error
      if (e instanceof Error && e.message === "Request aborted") {
        return false;
      }
      // On any other error, clear metrics to avoid stale data
      if (isMountedRef.current && (requestId === undefined || requestId === requestIdRef.current)) {
        const errorMessage = e instanceof Error ? e.message : String(e);
        setRateLimiterMetrics(null);
        setRateLimiterError(`Failed to fetch metrics: ${errorMessage}`);
      }
      // Re-throw connection errors so polling can stop
      if (e instanceof Error && (
        (e.name === "TypeError" && e.message === "Failed to fetch") ||
        e.message.includes("NetworkError") ||
        e.message.includes("ERR_CONNECTION_REFUSED")
      )) {
        throw e;
      }
      return false;
    } finally {
      if (isMountedRef.current && (requestId === undefined || requestId === requestIdRef.current)) {
        setRateLimiterLoading(false);
      }
    }
  }, []);

  // Poll for rate limiter metrics
  useEffect(() => {
    let cancelled = false;

    const runPoll = async () => {
      if (cancelled) return;
      // Abort any in-flight request from previous poll
      if (abortControllerRef.current) {
        abortControllerRef.current.abort();
      }
      // Increment request ID to track this request
      const requestId = ++requestIdRef.current;
      // Create new abort controller for this request
      const abortController = new AbortController();
      abortControllerRef.current = abortController;
      try {
        await fetchRateLimiterMetrics(abortController.signal, requestId);
      } catch (e) {
        // Connection error - stop polling to avoid infinite failed requests
        if (e instanceof Error && (
          (e.name === "TypeError" && e.message === "Failed to fetch") ||
          e.message.includes("NetworkError") ||
          e.message.includes("ERR_CONNECTION_REFUSED")
        )) {
          console.error("[metrics] Rate limiter polling stopped due to connection error:", e.message);
          return;
        }
      }
      // Schedule next poll after current one completes
      if (!cancelled) {
        pollingIntervalRef.current = setTimeout(runPoll, 5000);
      }
    };

    runPoll();

    return () => {
      cancelled = true;
      if (pollingIntervalRef.current) {
        clearTimeout(pollingIntervalRef.current);
        pollingIntervalRef.current = null;
      }
      if (abortControllerRef.current) {
        abortControllerRef.current.abort();
        abortControllerRef.current = null;
      }
    };
  }, [fetchRateLimiterMetrics]);

  useEffect(() => {
    fetchMetrics();
  }, [fetchMetrics]);

  // Cleanup on unmount
  useEffect(() => {
    return () => {
      isMountedRef.current = false;
    };
  }, []);

  return (
    <div className="space-y-6">
      <div>
        <h1 className="text-3xl font-bold tracking-tight">Metrics</h1>
        <p className="text-muted-foreground">
          Monitor API traffic, usage, and redaction statistics
        </p>
      </div>

      {/* Progress Bar */}
      {(loading || progress) && (
        <div className="space-y-2">
          <ProgressBar
            value={loading ? progressPercent : 100}
            indeterminate={Boolean(loading && progress && progress.total === 0)}
            height={6}
            className="w-full"
          />
          <div className="flex items-center justify-between text-sm text-muted-foreground">
            <span>{progress?.message || "Loading metrics..."}</span>
            {progress && progress.total > 0 && (
              <span>{progress.current} / {progress.total} ({progressPercent}%)</span>
            )}
          </div>
        </div>
      )}

      {error && (
        <div className="rounded-lg border border-destructive bg-destructive/10 p-4">
          <p className="text-destructive">Error: {error}</p>
        </div>
      )}

      {/* Rate Limiter Metrics - rendered independently of main metrics */}
      <div className="rounded-lg border p-4">
        <h3 className="text-lg font-semibold mb-4">Rate Limiter Status</h3>
        {rateLimiterError && (
          <div className="rounded-lg border border-destructive bg-destructive/10 p-4 mb-4">
            <p className="text-destructive">{rateLimiterError}</p>
          </div>
        )}
        {rateLimiterMetrics && !rateLimiterMetrics.config.enabled && (
          <div className="text-center py-8">
            <p className="text-muted-foreground">
              Rate limiter is not enabled. Enable it in the proxy configuration to see metrics.
            </p>
          </div>
        )}
        {!rateLimiterMetrics && rateLimiterError && (
          <div className="text-center py-8">
            <p className="text-muted-foreground">
              Unable to load rate limiter metrics. Check the proxy connection and try again.
            </p>
          </div>
        )}
        {rateLimiterMetrics && rateLimiterMetrics.config.enabled && (
          <div className="space-y-4">
            {/* Chart */}
            <div className="rounded-lg border p-4">
              <h4 className="text-md font-medium mb-3">Token Bucket States</h4>
              <RateLimiterChart
                buckets={rateLimiterMetrics.buckets}
                loading={rateLimiterLoading}
                maxDataPoints={maxDataPoints}
              />
            </div>

            {/* Bucket Details Table */}
            {sortedBuckets.length > 0 && (
              <div className="rounded-lg border p-4">
                <h4 className="text-md font-medium mb-3">Bucket Details</h4>
                <div className="overflow-x-auto max-h-[400px] overflow-y-auto">
                  <table className="w-full text-sm">
                    <thead>
                      <tr className="border-b">
                        <th className="text-left p-2 font-medium">Key</th>
                        <th className="text-right p-2 font-medium">Tokens</th>
                        <th className="text-right p-2 font-medium">Max</th>
                        <th className="text-right p-2 font-medium">Buffer</th>
                        <th className="text-right p-2 font-medium">Queue</th>
                        <th className="text-left p-2 font-medium">Provider</th>
                        <th className="text-left p-2 font-medium">Session</th>
                      </tr>
                    </thead>
                    <tbody>
                      {sortedBuckets.map((bucket) => (
                          <tr key={bucket.key} className="border-b last:border-0">
                            <td className="p-2 font-mono text-xs truncate max-w-xs" title={bucket.key}>
                              {bucket.key}
                            </td>
                            <td className="p-2 text-right">
                              <span className={bucket.tokens < 5 ? "text-destructive font-medium" : ""}>
                                {formatNumber(bucket.tokens)}
                              </span>
                            </td>
                            <td className="p-2 text-right text-muted-foreground">{formatNumber(bucket.maxTokens)}</td>
                            <td className="p-2 text-right text-muted-foreground">{formatNumber(bucket.bufferCapacity)}</td>
                            <td className="p-2 text-right">
                              <span className={bucket.queueLength > 0 ? "text-destructive font-medium" : "text-muted-foreground"}>
                                {formatNumber(bucket.queueLength)}
                              </span>
                            </td>
                            <td className="p-2 text-muted-foreground">{bucket.provider ?? "unknown"}</td>
                            <td className="p-2 text-muted-foreground">{bucket.sessionId ?? "unknown"}</td>
                          </tr>
                        ))}
                    </tbody>
                  </table>
                </div>
              </div>
            )}
          </div>
        )}
        {!rateLimiterMetrics && !rateLimiterError && (
          <div className="text-center py-8">
            <p className="text-muted-foreground">Loading rate limiter metrics...</p>
          </div>
        )}
      </div>

      {metrics && (
        <div>
          {/* Filter Controls */}
          <div className="flex flex-wrap items-center gap-4">
            <div className="flex items-center gap-2">
              <label
                htmlFor="time-range"
                className="text-sm font-medium text-muted-foreground"
              >
                Time Range:
              </label>
              <select
                id="time-range"
                value={timeRange.value}
                onChange={(e) => {
                  const selected = TIME_RANGES.find(
                    (r) => r.value === e.target.value,
                  );
                  if (selected) setTimeRange(selected);
                }}
                className="h-9 rounded-md border border-input bg-transparent px-3 py-1 text-sm shadow-sm transition-colors focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring"
              >
                {TIME_RANGES.map((range) => (
                  <option key={range.value} value={range.value}>
                    {range.label}
                  </option>
                ))}
              </select>
            </div>

            <div className="flex items-center gap-2">
              <label
                htmlFor="data-points"
                className="text-sm font-medium text-muted-foreground"
              >
                Data Points:
              </label>
              <select
                id="data-points"
                value={String(maxDataPoints)}
                onChange={(e) => {
                  const val = parseInt(e.target.value, 10);
                  setMaxDataPoints(Number.isFinite(val) ? val : 0);
                }}
                className="h-9 rounded-md border border-input bg-transparent px-3 py-1 text-sm shadow-sm transition-colors focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring"
              >
                {MAX_DATA_POINTS_OPTIONS.map((opt) => (
                  <option key={opt.value} value={opt.value}>
                    {opt.label}
                  </option>
                ))}
              </select>
            </div>
          </div>

          {/* Summary Cards */}
          <div className="grid gap-4 md:grid-cols-2 lg:grid-cols-5">
            <div className="rounded-lg border p-4">
              <div className="text-sm text-muted-foreground">
                Total Requests
              </div>
              <div className="text-2xl font-bold">
                {formatNumber(
                  metrics.providers.reduce(
                    (sum, p) => sum + p.requestCount,
                    0,
                  ),
                )}
              </div>
            </div>

            {/* Unique Redactions (deduplicated by session) */}
            <div
              className="rounded-lg border p-4 bg-blue-50 border-blue-200"
              title="Sum of max redactions per placeholder per session. For each session, take the highest count of each placeholder type across all its captures, then sum across all sessions."
            >
              <div className="text-sm text-muted-foreground">
                Unique Redactions (per session)
              </div>
              <div className="text-2xl font-bold text-blue-600">
                <span
                  title="Sum of maximum redactions per session. For each session, the highest count of each placeholder type across all its captures is used, then summed across all sessions. This avoids double-counting when a session has multiple captures."
                >
                  {formatNumber(metrics.redactionStatsDeduped?.totalRedactions ?? 0)}
                </span>
              </div>
            </div>

            {/* Total Redactions (sum across all captures) */}
            <div
              className="rounded-lg border p-4 bg-red-50 border-red-200"
              title="Sum of all redactions across every capture. Every capture's redactions are counted individually (no deduplication)."
            >
              <div className="text-sm text-muted-foreground">
                Total Redactions (all captures)
              </div>
              <div className="text-2xl font-bold text-red-600">
                <span
                  title="Sum of all redactions across every capture. Every capture's redactions are counted individually with no deduplication. A single session with multiple captures will have its redactions counted multiple times."
                >
                  {formatNumber(metrics.redactionStatsSum?.totalRedactions ?? 0)}
                </span>
              </div>
            </div>

            <div className="rounded-lg border p-4">
              <div className="text-sm text-muted-foreground">
                Request Bytes
              </div>
              <div className="text-2xl font-bold">
                {formatBytes(metrics.totalRequestBytes)}
              </div>
            </div>
            <div className="rounded-lg border p-4">
              <div className="text-sm text-muted-foreground">
                Response Bytes
              </div>
              <div className="text-2xl font-bold">
                {formatBytes(metrics.totalResponseBytes)}
              </div>
            </div>
          </div>

          {/* Traffic Chart */}
          {metrics.traffic.length > 0 ? (
            <div className="rounded-lg border p-4">
              <h3 className="text-lg font-semibold mb-4">
                Traffic Over Time
              </h3>
              <TrafficChart
                data={metrics.traffic}
                maxDataPoints={maxDataPoints || undefined}
                loading={loading}
                timeRangeHours={timeRange.hours}
              />
            </div>
          ) : (
            <div className="rounded-lg border p-4">
              <h3 className="text-lg font-semibold mb-4">
                Traffic Over Time
              </h3>
              <p className="text-muted-foreground">
                No traffic data available for the selected time range.
              </p>
            </div>
          )}

          {/* Traffic Summary */}
          <div className="rounded-lg border p-4">
            <h3 className="text-lg font-semibold mb-4">Traffic Summary</h3>
            <div className="grid gap-4 md:grid-cols-2">
              <div>
                <div className="text-sm text-muted-foreground">
                  Request Bytes
                </div>
                <div className="text-xl font-medium">
                  {formatBytes(metrics.totalRequestBytes)}
                </div>
              </div>
              <div>
                <div className="text-sm text-muted-foreground">
                  Response Bytes
                </div>
                <div className="text-xl font-medium">
                  {formatBytes(metrics.totalResponseBytes)}
                </div>
              </div>
            </div>
          </div>

          {/* Pagination Controls */}
          {metrics.pagination && metrics.pagination.totalPages > 1 && (
            <div className="rounded-lg border p-4">
              <h3 className="text-lg font-semibold mb-4">Pagination</h3>
              <div className="flex items-center justify-between">
                <div className="text-sm text-muted-foreground">
                  Page {metrics.pagination.page} of {metrics.pagination.totalPages} ({metrics.pagination.totalItems} total items)
                </div>
                <div className="flex items-center gap-2">
                  <button
                    onClick={() => setPage((p) => Math.max(1, p - 1))}
                    disabled={page <= 1}
                    className="rounded-md border px-3 py-1 text-sm hover:bg-accent disabled:opacity-50 disabled:cursor-not-allowed"
                  >
                    &larr; Previous
                  </button>
                  <button
                    onClick={() =>
                      setPage((p) =>
                        metrics.pagination && p >= metrics.pagination.totalPages
                          ? p
                          : p + 1,
                      )
                    }
                    disabled={
                      metrics.pagination && page >= metrics.pagination.totalPages
                    }
                    className="rounded-md border px-3 py-1 text-sm hover:bg-accent disabled:opacity-50 disabled:cursor-not-allowed"
                  >
                    Next &rarr;
                  </button>
                </div>
              </div>
            </div>
          )}

          {/* Provider Usage */}
          <div className="rounded-lg border p-4">
            <h3 className="text-lg font-semibold mb-4">Provider Usage</h3>
            {!metrics && !error && (
              <div className="text-sm text-muted-foreground">
                Loading provider data...
              </div>
            )}
            {metrics && metrics.providers.length === 0 && (
              <div className="text-sm text-muted-foreground">
                No provider usage recorded.
              </div>
            )}
            <div className="space-y-2">
              {metrics?.providers.map((provider) => (
                <div
                  key={provider.provider}
                  className="flex items-center justify-between rounded border p-3"
                >
                  <span className="font-medium">{provider.provider}</span>
                  <div className="text-right text-sm">
                    <div>{formatNumber(provider.requestCount)} requests</div>
                    <div className="text-muted-foreground">
                      Tokens not available in metadata-only mode
                    </div>
                  </div>
                </div>
              ))}
            </div>
          </div>
        </div>
      )}
    </div>
  );
}

export default function MetricsPage() {
  return (
    <MainLayout>
      <MetricsContent />
    </MainLayout>
  );
}