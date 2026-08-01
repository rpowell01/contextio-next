"use client";

import { memo, useState, useMemo, useRef, useEffect } from "react";
import { formatNumber } from "@/lib/utils";
import type { RateLimiterBucketState } from "@/types/api";
import {
  BarChart,
  Bar,
  XAxis,
  YAxis,
  CartesianGrid,
  ResponsiveContainer,
  Legend,
  Tooltip,
  ReferenceLine,
  Label,
  Cell,
} from "recharts";
import { Copy, Loader2 } from "lucide-react";

interface RateLimiterChartProps {
  buckets: RateLimiterBucketState[];
  loading?: boolean;
  maxDataPoints?: number;
}

interface ChartDataPoint {
  key: string;
  provider: string;
  tokens: number;
  maxTokens: number;
  bufferCapacity: number;
  queueLength: number;
  sessionId: string;
  utilizationPercent: number;
  status: "healthy" | "warning" | "critical" | "queued";
  // Computed for display
  used: number;
  totalCapacity: number;
}

interface ProviderSummary {
  provider: string;
  maxRequests: number;
  windowMs: number;
  bufferCapacity: number;
  totalTokens: number;
  totalMaxTokens: number;
  totalQueueLength: number;
  totalUsed: number;
  utilizationPercent: number;
  status: "healthy" | "warning" | "critical" | "queued";
}

/**
 * Downsample data to a maximum number of points by grouping adjacent points
 * and taking the min value in each group (to preserve most constrained buckets).
 */
function downsampleData(data: ChartDataPoint[], maxPoints: number): ChartDataPoint[] {
  if (maxPoints <= 0 || data.length <= maxPoints) return data;

  const step = Math.ceil(data.length / maxPoints);
  const result: ChartDataPoint[] = [];

  for (let i = 0; i < data.length; i += step) {
    const chunk = data.slice(i, i + step);
    const minItem = chunk.reduce((min, item) => (item.tokens < min.tokens ? item : min), chunk[0]);
    result.push(minItem);
  }

  return result;
}

function getStatus(tokens: number, maxTokens: number, queueLength: number): ChartDataPoint["status"] {
  if (queueLength > 0) return "queued";
  const utilization = 1 - tokens / maxTokens;
  if (utilization >= 0.9) return "critical";
  if (utilization >= 0.7) return "warning";
  return "healthy";
}

function getStatusColor(status: ChartDataPoint["status"]): string {
  switch (status) {
    case "critical":
      return "#ef4444";
    case "warning":
      return "#f59e0b";
    case "queued":
      return "#8b5cf6";
    default:
      return "#22c55e";
  }
}

// Custom comparison function for memo - only re-render when data actually changes
function chartDataEqual(prevProps: RateLimiterChartProps, nextProps: RateLimiterChartProps): boolean {
  if (prevProps.loading !== nextProps.loading) return false;
  if (prevProps.maxDataPoints !== nextProps.maxDataPoints) return false;

  const prevBuckets = prevProps.buckets || [];
  const nextBuckets = nextProps.buckets || [];

  if (prevBuckets.length !== nextBuckets.length) return false;

  // Compare tokens, maxTokens, queueLength for each bucket
  for (let i = 0; i < prevBuckets.length; i++) {
    if (
      prevBuckets[i].tokens !== nextBuckets[i].tokens ||
      prevBuckets[i].maxTokens !== nextBuckets[i].maxTokens ||
      prevBuckets[i].queueLength !== nextBuckets[i].queueLength
    ) {
      return false; // Data changed, re-render
    }
  }
  return true; // Data unchanged, skip re-render
}

export const RateLimiterChart = memo(function RateLimiterChart({
  buckets,
  loading = false,
  maxDataPoints = 50,
}: RateLimiterChartProps) {
  const [copied, setCopied] = useState(false);
  const copyTimeoutRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  const chartData = useMemo(() => {
    const raw = buckets.map((bucket) => {
      const maxTokens = bucket.maxTokens;
      const used = maxTokens - bucket.tokens;
      const utilizationPercent = maxTokens > 0 ? Math.round((used / maxTokens) * 100) : 0;
      return {
        key: bucket.key,
        provider: bucket.provider ?? "unknown",
        tokens: bucket.tokens,
        maxTokens,
        bufferCapacity: bucket.bufferCapacity,
        queueLength: bucket.queueLength,
        sessionId: bucket.sessionId ?? "unknown",
        used,
        totalCapacity: maxTokens + bucket.bufferCapacity,
        utilizationPercent,
        status: getStatus(bucket.tokens, maxTokens, bucket.queueLength),
      };
    });

    // Sort by utilization (most constrained first), then by queue length
    const sorted = [...raw].sort((a, b) => {
      if (a.queueLength !== b.queueLength) return b.queueLength - a.queueLength;
      return b.utilizationPercent - a.utilizationPercent;
    });

    return downsampleData(sorted, maxDataPoints);
  }, [buckets, maxDataPoints]);

  // Provider summaries - aggregate since we may have multiple buckets per provider
  // (e.g., if using custom keyStrategy or legacy session-provider)
  const providerSummaries = useMemo((): ProviderSummary[] => {
    const providerMap = new Map<string, ProviderSummary>();

    chartData.forEach((d) => {
      const provider = d.provider;
      const existing = providerMap.get(provider);
      if (!existing) {
        providerMap.set(provider, {
          provider,
          maxRequests: d.maxTokens - d.bufferCapacity,
          windowMs: 60_000, // Would need to come from config
          bufferCapacity: d.bufferCapacity,
          totalTokens: d.tokens,
          totalMaxTokens: d.maxTokens,
          totalQueueLength: d.queueLength,
          totalUsed: d.used,
          utilizationPercent: d.utilizationPercent,
          status: d.status,
        });
      } else {
        // Aggregate: sum used, max, queue; weighted average utilization
        existing.totalTokens += d.tokens;
        existing.totalMaxTokens += d.maxTokens;
        existing.totalQueueLength += d.queueLength;
        existing.totalUsed += d.used;
        existing.utilizationPercent = existing.totalMaxTokens > 0
          ? Math.round((existing.totalUsed / existing.totalMaxTokens) * 100)
          : 0;
        // Escalate status
        if (d.status === "queued" || existing.status === "critical") {
          existing.status = d.status === "queued" ? "queued" : "critical";
        } else if (d.status === "critical" || existing.status === "warning") {
          existing.status = d.status === "critical" ? "critical" : "warning";
        } else if (d.status === "warning") {
          existing.status = "warning";
        }
      }
    });

    return Array.from(providerMap.values()).sort((a, b) => {
      if (a.totalQueueLength !== b.totalQueueLength) return b.totalQueueLength - a.totalQueueLength;
      return b.utilizationPercent - a.utilizationPercent;
    });
  }, [chartData]);

  const copyToClipboard = async () => {
    try {
      const dataToCopy = chartData.map(({ key, provider, tokens, maxTokens, bufferCapacity, queueLength, sessionId, used, utilizationPercent, status }) => ({
        key,
        provider,
        tokens,
        maxTokens,
        bufferCapacity,
        queueLength,
        sessionId,
        used,
        utilizationPercent,
        status,
      }));
      await navigator.clipboard.writeText(JSON.stringify(dataToCopy, null, 2));
      setCopied(true);
      if (copyTimeoutRef.current) clearTimeout(copyTimeoutRef.current);
      copyTimeoutRef.current = setTimeout(() => setCopied(false), 2000);
    } catch {
      // Silently fail
    }
  };

  useEffect(() => {
    return () => {
      if (copyTimeoutRef.current) clearTimeout(copyTimeoutRef.current);
    };
  }, []);

  const isDownsampled = chartData.length < buckets.length;

  if (loading) {
    return (
      <div className="w-full flex flex-col items-center justify-center py-12">
        <Loader2 className="h-8 w-8 animate-spin text-primary" />
        <p className="mt-2 text-sm text-muted-foreground">Loading rate limiter data...</p>
      </div>
    );
  }

  if (chartData.length === 0) {
    return (
      <div className="rounded-lg border p-8 text-center">
        <p className="text-muted-foreground">No rate limiter buckets to display</p>
      </div>
    );
  }

  const globalMaxTokens = Math.max(1, Math.max(...chartData.map((d) => d.maxTokens)));

  return (
    <div className="w-full space-y-4">
      {/* Provider Utilization Summary Cards */}
      <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-3 xl:grid-cols-4">
        {providerSummaries.map((summary) => (
          <ProviderUtilizationCard key={summary.provider} summary={summary} />
        ))}
      </div>

      {/* Main Chart */}
      <div className="w-full">
        <div className="flex flex-wrap items-center justify-between gap-2 mb-3">
          <button
            onClick={copyToClipboard}
            className="inline-flex items-center gap-1 px-2 py-1 text-sm rounded hover:bg-muted"
            aria-label={copied ? "Chart data copied to clipboard" : "Copy chart data to clipboard"}
            title={copied ? "Chart data copied to clipboard" : "Copy chart data to clipboard"}
          >
            <Copy className="h-4 w-4" />
            {copied ? "Copied" : "Copy"}
          </button>
          {isDownsampled && (
            <span className="text-muted-foreground text-xs">
              Showing {chartData.length} of {buckets.length} buckets (min-sampled)
            </span>
          )}
        </div>

        <div id="rate-limiter-chart-description" className="sr-only">
          Horizontal bar chart displaying token bucket states per provider.
          Bars colored by utilization: green (healthy), amber (warning), red (critical), violet (queued).
          Hover bars for exact values and provider details.
        </div>

        <div className="max-h-[600px] overflow-y-auto">
          <ResponsiveContainer width="100%" height={Math.min(600, Math.max(300, chartData.length * 36 + 120))}>
            <BarChart
              data={chartData}
              aria-labelledby="rate-limiter-chart-description"
              role="img"
              layout="vertical"
            >
              <CartesianGrid strokeDasharray="3 3" stroke="#e5e7eb" vertical={false} />

              {/* X Axis - Token values */}
              <XAxis
                type="number"
                label={{
                  value: "Requests Remaining / Max Requests",
                  position: "outsideBottom",
                  offset: 80,
                  style: { textAnchor: "middle", fill: "#333", fontSize: 12, fontWeight: 500 },
                }}
                tick={{ fill: "#666", fontSize: 11 }}
                tickLine={{ stroke: "#999" }}
                axisLine={{ stroke: "#999" }}
                tickFormatter={(value) => formatNumber(value)}
                domain={[0, globalMaxTokens * 1.15]}
              />

              {/* Y Axis - Provider names */}
              <YAxis
                dataKey="provider"
                type="category"
                width={140}
                label={{
                  value: "Provider",
                  position: "outsideLeft",
                  offset: 30,
                  style: { textAnchor: "middle", fill: "#333", fontSize: 12, fontWeight: 500 },
                }}
                tick={{ fill: "#333", fontSize: 11 }}
                tickLine={{ stroke: "#999" }}
                axisLine={{ stroke: "#999" }}
              />

              <Tooltip
                formatter={(value: number, name: string) => [formatNumber(value), name]}
                labelFormatter={(label, payload) => {
                  if (payload && payload.length > 0 && payload[0].payload) {
                    const p = payload[0].payload;
                    return `${p.provider} | ${p.used}/${p.maxTokens} requests used (${p.utilizationPercent}%)${p.queueLength > 0 ? ` | ${p.queueLength} queued` : ""}`;
                  }
                  return `Provider: ${label}`;
                }}
                contentStyle={{
                  backgroundColor: "rgba(255, 255, 255, 0.98)",
                  border: "1px solid #ddd",
                  borderRadius: "8px",
                  boxShadow: "0 4px 12px rgba(0,0,0,0.1)",
                }}
                cursor={{ fill: "rgba(0, 0, 0, 0.05)" }}
              />

              <Legend
                verticalAlign="top"
                align="center"
                iconSize={12}
                wrapperStyle={{ fontSize: 11, fontWeight: 500, marginBottom: 8 }}
              />

              {/* Used requests (filled portion showing consumption) */}
              <Bar
                dataKey="used"
                name="Used"
                stackId="tokens"
                fill="#d1d5db"
                stroke="#9ca3af"
                strokeWidth={0.5}
                opacity={0.5}
                radius={[0, 4, 4, 0]}
                aria-label="Used requests"
                animationDuration={0}
              />

              {/* Remaining requests (colored by status) */}
              <Bar
                dataKey="tokens"
                name="Remaining"
                stackId="tokens"
                fill="#3b82f6"
                stroke="#1d4ed8"
                strokeDasharray="4 4"
                strokeWidth={1}
                opacity={0.85}
                radius={[0, 4, 4, 0]}
                aria-label="Remaining requests"
                animationDuration={0}
              >
                {chartData.map((entry, index) => (
                  <Cell key={`cell-${index}`} fill={getStatusColor(entry.status)} />
                ))}
              </Bar>

              {/* Buffer capacity indicator */}
              <Bar
                dataKey="bufferCapacity"
                name="Buffer"
                stackId="buffer"
                fill="#8b5cf6"
                opacity={0.3}
                radius={[0, 4, 4, 0]}
                animationDuration={0}
              />

              {/* Provider max reference lines */}
              {providerSummaries.map((p, idx) => (
                <>
                  <ReferenceLine
                    x={p.totalMaxTokens}
                    stroke="#3b82f6"
                    strokeWidth={1}
                    strokeDasharray="4 4"
                    label={
                      <Label
                        value={`${p.provider}: ${formatNumber(p.totalMaxTokens)} max`}
                        position="center"
                        fill="#3b82f6"
                        fontSize={9}
                        offset={10 + idx * 15}
                      />
                    }
                  />
                  <ReferenceLine
                    x={p.totalMaxTokens * 0.3}
                    stroke="#f59e0b"
                    strokeWidth={0.8}
                    strokeDasharray="3 3"
                    label={
                      <Label
                        value={`${p.provider}: 70%`}
                        position="center"
                        fill="#f59e0b"
                        fontSize={8}
                        offset={10 + idx * 15}
                      />
                    }
                  />
                  <ReferenceLine
                    x={p.totalMaxTokens * 0.1}
                    stroke="#ef4444"
                    strokeWidth={0.8}
                    strokeDasharray="3 3"
                    label={
                      <Label
                        value={`${p.provider}: 90%`}
                        position="center"
                        fill="#ef4444"
                        fontSize={8}
                        offset={10 + idx * 15}
                      />
                    }
                  />
                </>
              ))}
            </BarChart>
          </ResponsiveContainer>
        </div>
      </div>

      {/* Legend */}
      <div className="flex flex-wrap items-center gap-4 text-sm text-muted-foreground">
        <div className="flex items-center gap-2">
          <div className="w-4 h-4 rounded" style={{ background: "#22c55e" }} />
          <span>Healthy ({"<"} 70%)</span>
        </div>
        <div className="flex items-center gap-2">
          <div className="w-4 h-4 rounded" style={{ background: "#f59e0b" }} />
          <span>Warning (70-90%)</span>
        </div>
        <div className="flex items-center gap-2">
          <div className="w-4 h-4 rounded" style={{ background: "#ef4444" }} />
          <span>Critical ({">"} 90%)</span>
        </div>
        <div className="flex items-center gap-2">
          <div className="w-4 h-4 rounded" style={{ background: "#8b5cf6" }} />
          <span>Queued</span>
        </div>
        <div className="flex items-center gap-1">
          <div className="w-4 h-4 rounded border-2 border-dashed border-gray-400" />
          <span>Buffer</span>
        </div>
      </div>
    </div>
  );
}, chartDataEqual);

/**
 * Provider Utilization Card - compact summary per provider
 */
function ProviderUtilizationCard({ summary }: { summary: ProviderSummary }) {
  const { provider, totalTokens, totalMaxTokens, totalQueueLength, utilizationPercent, status } = summary;

  const statusColors = {
    healthy: { bg: "bg-green-50", border: "border-green-200", text: "text-green-800", dot: "bg-green-500" },
    warning: { bg: "bg-amber-50", border: "border-amber-200", text: "text-amber-800", dot: "bg-amber-500" },
    critical: { bg: "bg-red-50", border: "border-red-200", text: "text-red-800", dot: "bg-red-500" },
    queued: { bg: "bg-violet-50", border: "border-violet-200", text: "text-violet-800", dot: "bg-violet-500" },
  };

  const colors = statusColors[status];

  return (
    <div className={`rounded-lg border p-3 ${colors.bg} ${colors.border} flex flex-col gap-2`}>
      <div className="flex items-center justify-between">
        <h4 className="font-medium text-sm">{provider}</h4>
        <span className={`w-2 h-2 rounded-full ${colors.dot}`} />
      </div>

      {/* Utilization meter */}
      <div className="w-full h-3 bg-gray-200 rounded-full overflow-hidden">
        <div
          className="h-full rounded-full transition-all duration-300"
          style={{
            width: `${Math.min(100, utilizationPercent)}%`,
            backgroundColor: totalQueueLength > 0 ? "#8b5cf6" : colors.text,
          }}
        />
      </div>

      <div className="flex items-center justify-between text-xs">
        <span className={colors.text} font-medium>
          {utilizationPercent}% used
        </span>
        <span className="text-muted-foreground">
          {formatNumber(totalMaxTokens - totalTokens)} / {formatNumber(totalMaxTokens)} used
        </span>
      </div>

      {totalQueueLength > 0 && (
        <div className="flex items-center gap-1 text-xs text-violet-700 bg-violet-100 px-2 py-0.5 rounded">
          <span className="font-medium">{totalQueueLength}</span>
          <span>requests queued</span>
        </div>
      )}
    </div>
  );
}