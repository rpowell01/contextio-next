"use client";

import { MainLayout } from "@/components/main-layout";
import { formatBytes, formatNumber } from "@/lib/utils";
import { apiClient } from "@/lib/api";
import type {
  MetricsData,
  TimeRange,
} from "@/types/api";
import { TrafficChart } from "@/components/traffic-chart";
import { useEffect, useState, useCallback } from "react";
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
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const [progress, setProgress] = useState<{ current: number; total: number; message: string } | null>(null);
  const [timeRange, setTimeRange] = useState<TimeRange>(TIME_RANGES[2]); // default 24h
  const [maxDataPoints, setMaxDataPoints] = useState<number>(50);
  const [page, setPage] = useState<number>(1);
  const [pageSize] = useState<number>(50);

  // Page load tracking for footer
  const { registerPageLoad, registerPageReady } = usePageLoad();

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

  useEffect(() => {
    fetchMetrics();
  }, [fetchMetrics]);

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