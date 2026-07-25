"use client";

import { MainLayout } from "@/components/main-layout";
import { formatBytes, formatNumber } from "@/lib/utils";
import { apiClient } from "@/lib/api";
import type {
  MetricsData,
  ProviderUsage,
  RedactionMetric,
  TrafficMetric,
  TimeRange,
} from "@/types/api";
import { TrafficChart } from "@/components/traffic-chart";
import { useEffect, useState, useCallback } from "react";
import { usePageLoad } from "@/components/page-load-context";

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
  const [timeRange, setTimeRange] = useState<TimeRange>(TIME_RANGES[2]); // default 24h
  const [maxDataPoints, setMaxDataPoints] = useState<number>(50);
  const [page, setPage] = useState<number>(1);
  const [pageSize] = useState<number>(50);

  // Page load tracking for footer
  const { registerPageLoad, registerPageReady } = usePageLoad();

  const fetchMetrics = useCallback(async () => {
    // Signal that page loading has started
    registerPageLoad();
    setLoading(true);
    setError(null);

    try {
      const controller = new AbortController();
      const data = await apiClient.getMetrics(
        timeRange.hours,
        maxDataPoints || undefined,
        page,
        pageSize,
        controller.signal,
      );

      if (!isValidMetricsData(data)) {
        throw new Error("Invalid metrics data received from API");
      }

      setMetrics(data);
    } catch (e) {
      setError(e instanceof Error ? e.message : "Unknown error");
      setMetrics(null);
    } finally {
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

      {error && (
        <div className="rounded-lg border border-destructive bg-destructive/10 p-4">
          <p className="text-destructive">Error: {error}</p>
        </div>
      )}

      {loading && !metrics && (
        <div className="rounded-lg border p-4">
          <p className="text-muted-foreground">Loading metrics...</p>
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
            <div className="rounded-lg border p-4 bg-blue-50 border-blue-200"
                 title="Sum of max redactions per placeholder per session. For each session, take the highest count of each placeholder type across all its captures, then sum across all sessions.">
              <div className="text-sm text-muted-foreground">
                Unique Redactions (per session)
              </div>
              <div className="text-2xl font-bold text-blue-600">
                <span title="Sum of maximum redactions per session. For each session, the highest count of each placeholder type across all its captures is used, then summed across all sessions. This avoids double-counting when a session has multiple captures.">
                  {formatNumber(metrics.redactionStatsDeduped?.totalRedactions ?? 0)}
                </span>
              </div>
            </div>

            {/* Total Redactions (sum across all captures) */}
            <div className="rounded-lg border p-4 bg-red-50 border-red-200"
                 title="Sum of all redactions across every capture. Every capture's redactions are counted individually (no deduplication).">
              <div className="text-sm text-muted-foreground">
                Total Redactions (all captures)
              </div>
              <div className="text-2xl font-bold text-red-600">
                <span title="Sum of all redactions across every capture. Every capture's redactions are counted individually with no deduplication. A single session with multiple captures will have its redactions counted multiple times.">
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

          {/* Redaction Breakdown by Rule */}
          {(metrics.redactionStatsDeduped ||
            metrics.redactionStatsSum) && (
            <div className="rounded-lg border p-4">
              <h3 className="text-lg font-semibold mb-4">
                Redaction Breakdown by Rule
              </h3>
              <div className="grid gap-3 md:grid-cols-2 lg:grid-cols-4">
                {/* Unique (deduplicated) breakdown */}
                {metrics.redactionStatsDeduped &&
                  Object.keys(metrics.redactionStatsDeduped.byRule).length > 0 && (
                    <div className="md:col-span-2 lg:col-span-4">
                      <h4 className="text-sm font-medium text-blue-600 mb-2"
                          title="Unique per session: for each session, takes the max count of this placeholder across all its captures, then sums across sessions.">
                        Unique per Session
                      </h4>
                      <div className="grid gap-2 md:grid-cols-4">
                        {Object.entries(metrics.redactionStatsDeduped.byRule).map(
                          ([rule, count]) => (
                            <div
                              key={rule}
                              className="rounded border p-2 bg-blue-50"
                              title="Max count of this placeholder in any single capture per session, summed across all sessions."
                            >
                              <div className="text-xs text-muted-foreground capitalize">
                                {rule.replace(/_/g, " ")}
                              </div>
                              <div className="text-lg font-bold text-blue-600">
                                <span title="Max count of this placeholder in any single capture per session, summed across all sessions.">
                                  {formatNumber(count)}
                                </span>
                              </div>
                            </div>
                          ),
                        )}
                      </div>
                    </div>
                  )}

                {/* Total (sum) breakdown */}
                {metrics.redactionStatsSum &&
                  Object.keys(metrics.redactionStatsSum.byRule).length > 0 && (
                    <div className="md:col-span-2 lg:col-span-4">
                      <h4 className="text-sm font-medium text-red-600 mb-2"
                          title="Sum across all captures: adds up every occurrence of this placeholder across every capture in every session.">
                        Sum Across All Captures
                      </h4>
                      <div className="grid gap-2 md:grid-cols-4">
                        {Object.entries(metrics.redactionStatsSum.byRule).map(
                          ([rule, count]) => (
                            <div
                              key={rule}
                              className="rounded border p-2 bg-red-50"
                              title="Total occurrences of this placeholder across all captures in all sessions."
                            >
                              <div className="text-xs text-muted-foreground capitalize">
                                {rule.replace(/_/g, " ")}
                              </div>
                              <div className="text-lg font-bold text-red-600">
                                <span title="Total occurrences of this placeholder across all captures in all sessions.">
                                  {formatNumber(count)}
                                </span>
                              </div>
                            </div>
                          ),
                        )}
                      </div>
                    </div>
                  )}
              </div>
            </div>
          )}

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
                    onClick={() => setPage((p) => p + 1)}
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
  );
}

export default function MetricsPage() {
  return (
    <MainLayout>
      <MetricsContent />
    </MainLayout>
  );
}

function isValidMetricsData(data: unknown): data is MetricsData {
  if (!data || typeof data !== "object") return false;
  const metrics = data as Record<string, unknown>;

  return (
    (typeof metrics.totalInputTokens === "number" ||
      metrics.totalInputTokens === undefined) &&
    (typeof metrics.totalOutputTokens === "number" ||
      metrics.totalOutputTokens === undefined) &&
    typeof metrics.totalRequestBytes === "number" &&
    typeof metrics.totalResponseBytes === "number" &&
    Array.isArray(metrics.providers) &&
    metrics.providers.every(isValidProviderUsage) &&
    Array.isArray(metrics.redactions) &&
    metrics.redactions.every(isValidRedactionMetric) &&
    Array.isArray(metrics.traffic) &&
    metrics.traffic.every(isValidTrafficMetric)
  );
}

function isValidProviderUsage(p: unknown): p is ProviderUsage {
  if (!p || typeof p !== "object") return false;
  const provider = p as Record<string, unknown>;

  return (
    typeof provider.provider === "string" &&
    typeof provider.requestCount === "number" &&
    typeof provider.totalInputTokens === "number" &&
    typeof provider.totalOutputTokens === "number"
  );
}

function isValidRedactionMetric(r: unknown): r is RedactionMetric {
  if (!r || typeof r !== "object") return false;
  const redaction = r as Record<string, unknown>;

  return (
    typeof redaction.timestamp === "string" &&
    typeof redaction.count === "number"
  );
}

function isValidTrafficMetric(t: unknown): t is TrafficMetric {
  if (!t || typeof t !== "object") return false;
  const traffic = t as Record<string, unknown>;

  return (
    typeof traffic.timestamp === "string" &&
    typeof traffic.requestBytes === "number" &&
    typeof traffic.responseBytes === "number"
  );
}