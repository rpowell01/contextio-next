"use client";

import { MainLayout } from "@/components/main-layout";
import { formatBytes, formatNumber } from "@/lib/utils";
import type {
  MetricsData,
  ProviderUsage,
  RedactionMetric,
  TrafficMetric,
  TimeRange,
} from "@/types/api";
import { TrafficChart } from "@/components/traffic-chart";
import { useEffect, useState } from "react";

const API_URL = process.env.NEXT_PUBLIC_API_URL || "http://localhost:4040";

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

export default function MetricsPage() {
  const [metrics, setMetrics] = useState<MetricsData | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const [timeRange, setTimeRange] = useState<TimeRange>(TIME_RANGES[2]); // default 24h
  const [maxDataPoints, setMaxDataPoints] = useState<number>(50);

  useEffect(() => {
    let cancelled = false;

    async function fetchMetrics() {
      setLoading(true);
      setError(null);

      try {
        const url = new URL(`${API_URL}/api/metrics`);
        url.searchParams.set("hours", String(timeRange.hours));
        if (maxDataPoints > 0) {
          url.searchParams.set("maxPoints", String(maxDataPoints));
        }

        const response = await fetch(url.toString());

        if (!response.ok) {
          throw new Error(`Failed to fetch metrics: ${response.statusText}`);
        }

        const data = (await response.json()) as MetricsData;

        if (!isValidMetricsData(data)) {
          throw new Error("Invalid metrics data received from API");
        }

        if (!cancelled) {
          setMetrics(data);
        }
      } catch (e) {
        if (!cancelled) {
          setError(e instanceof Error ? e.message : "Unknown error");
          setMetrics(null);
        }
      } finally {
        if (!cancelled) {
          setLoading(false);
        }
      }
    }

    fetchMetrics();

    return () => {
      cancelled = true;
    };
  }, [timeRange, maxDataPoints]);

  return (
    <MainLayout>
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
            <div className="grid gap-4 md:grid-cols-2 lg:grid-cols-4">
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
              <div className="rounded-lg border p-4">
                <div className="text-sm text-muted-foreground">
                  Input Tokens
                </div>
                <div className="text-2xl font-bold">
                  {formatNumber(metrics.totalInputTokens ?? 0)}
                </div>
              </div>
              <div className="rounded-lg border p-4">
                <div className="text-sm text-muted-foreground">
                  Output Tokens
                </div>
                <div className="text-2xl font-bold">
                  {formatNumber(metrics.totalOutputTokens ?? 0)}
                </div>
              </div>
              <div className="rounded-lg border p-4">
                <div className="text-sm text-muted-foreground">
                  Total Redactions
                </div>
                <div className="text-2xl font-bold">
                  {formatNumber(
                    metrics.redactions.reduce((sum, r) => sum + r.count, 0),
                  )}
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
                    {formatNumber(provider.totalInputTokens)} in,{" "}
                    {formatNumber(provider.totalOutputTokens)} out
                  </div>
                </div>
              </div>
            ))}
          </div>
        </div>
      </div>
    </MainLayout>
  );
}

function isValidMetricsData(data: unknown): data is MetricsData {
  if (!data || typeof data !== "object") return false;
  const metrics = data as Record<string, unknown>;

  return (
    typeof metrics.totalInputTokens === "number" &&
    typeof metrics.totalOutputTokens === "number" &&
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