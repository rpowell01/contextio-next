"use client";

import React, { memo, useState, useMemo, useRef, useEffect } from "react";
import { formatNumber } from "@/lib/utils";

/**
 * Format a percentage value to maximum 2 decimal places, trimming trailing zeros.
 * e.g., 50 -> "50", 50.5 -> "50.5", 50.555 -> "50.56", 50.50 -> "50.5"
 */
function formatPercent(value: number): string {
  return value.toFixed(2).replace(/\.?0+$/, "");
}
import type { RateLimiterBucketState } from "@/types/client-api";
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
} from "recharts";
import { Copy, Loader2 } from "lucide-react";

interface RateLimiterChartProps {
  buckets: RateLimiterBucketState[];
  loading?: boolean;
  maxDataPoints?: number;
}

interface ProviderSummary {
  provider: string;
  maxRequests: number;
  bufferCapacity: number;
  totalQueueLength: number;
  totalRequestsInWindow: number;
  utilizationPercent: number;
  status: "healthy" | "warning" | "critical" | "buffered";
}

/**
 * Downsample data to a maximum number of points by grouping adjacent points
 * and taking the max totalRequestsInWindow in each group (to preserve most constrained buckets).
 */
function downsampleData(data: ProviderSummary[], maxPoints: number): ProviderSummary[] {
  if (maxPoints <= 0 || data.length <= maxPoints) return data;

  const step = Math.ceil(data.length / maxPoints);
  const result: ProviderSummary[] = [];

  for (let i = 0; i < data.length; i += step) {
    const chunk = data.slice(i, i + step);
    const maxItem = chunk.reduce((max, item) =>
      item.totalRequestsInWindow > max.totalRequestsInWindow ? item : max
    , chunk[0]);
    result.push(maxItem);
  }

  return result;
}

function getProviderStatus(
  requestsInWindow: number,
  maxRequests: number,
  queueLength: number
): ProviderSummary["status"] {
  if (queueLength > 0) return "buffered";
  if (maxRequests === 0) return "healthy";
  
  const utilization = requestsInWindow / maxRequests;
  if (utilization >= 1.0) return "critical";  // Over hard limit
  if (utilization >= 0.9) return "critical";
  if (utilization >= 0.7) return "warning";
  return "healthy";
}

function getStatusColor(status: ProviderSummary["status"]): string {
  switch (status) {
    case "critical":
      return "#ef4444";
    case "warning":
      return "#f59e0b";
    case "buffered":
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

  for (let i = 0; i < prevBuckets.length; i++) {
    if (
      prevBuckets[i].provider !== nextBuckets[i].provider ||
      prevBuckets[i].maxTokens !== nextBuckets[i].maxTokens ||
      prevBuckets[i].bufferCapacity !== nextBuckets[i].bufferCapacity ||
      prevBuckets[i].queueLength !== nextBuckets[i].queueLength ||
      prevBuckets[i].requestsInWindow !== nextBuckets[i].requestsInWindow
    ) {
      return false;
    }
  }
  return true;
}

function RateLimiterChartComponent({
  buckets,
  loading = false,
  maxDataPoints = 50,
}: RateLimiterChartProps) {
  const [copied, setCopied] = useState(false);
  const copyTimeoutRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  // Provider summaries - aggregate per provider
  const providerSummaries = useMemo((): ProviderSummary[] => {
    const providerMap = new Map<string, ProviderSummary>();

    buckets.forEach((bucket) => {
      const provider = bucket.provider ?? "unknown";
      const maxRequests = bucket.maxTokens - bucket.bufferCapacity;
      const requestsInWindow = bucket.requestsInWindow ?? 0;
      
      const existing = providerMap.get(provider);
      if (!existing) {
        providerMap.set(provider, {
          provider,
          maxRequests,
          bufferCapacity: bucket.bufferCapacity,
          totalQueueLength: bucket.queueLength,
          totalRequestsInWindow: requestsInWindow,
          utilizationPercent: maxRequests > 0 ? Math.round((requestsInWindow / maxRequests) * 10000) / 100 : 0,
          status: getProviderStatus(requestsInWindow, maxRequests, bucket.queueLength),
        });
      } else {
        existing.maxRequests += maxRequests;
        existing.bufferCapacity += bucket.bufferCapacity;
        existing.totalQueueLength += bucket.queueLength;
        existing.totalRequestsInWindow += requestsInWindow;
        existing.utilizationPercent = existing.maxRequests > 0
          ? Math.round((existing.totalRequestsInWindow / existing.maxRequests) * 10000) / 100
          : 0;
        const newStatus = getProviderStatus(
          existing.totalRequestsInWindow,
          existing.maxRequests,
          existing.totalQueueLength
        );
        const statusPriority = { healthy: 0, warning: 1, critical: 2, buffered: 3 };
        if (statusPriority[newStatus] > statusPriority[existing.status]) {
          existing.status = newStatus;
        }
      }
    });

    return Array.from(providerMap.values()).sort((a, b) => {
      if (a.totalQueueLength !== b.totalQueueLength) return b.totalQueueLength - a.totalQueueLength;
      return b.utilizationPercent - a.utilizationPercent;
    });
  }, [buckets]);

  // Downsample if needed
  const chartData = useMemo(() => {
    const downsampled = downsampleData(providerSummaries, maxDataPoints);
    // Add cappedUsage field for visual overlay - cap at total capacity
    return downsampled.map(d => ({
      ...d,
      cappedUsage: Math.min(d.totalRequestsInWindow, d.maxRequests + d.bufferCapacity),
      totalCapacity: d.maxRequests + d.bufferCapacity,
    }));
  }, [providerSummaries, maxDataPoints]);

  // Custom shape for capacity bar with usage overlay
  const CapacityBarShape = (props: any) => {
    const { x, y, width, height, payload } = props;
    const data = payload;
    if (!data) return <g />;
    
    const maxRequests = data.maxRequests ?? 0;
    const bufferCapacity = data.bufferCapacity ?? 0;
    const cappedUsage = data.cappedUsage ?? 0;
    const totalCapacity = maxRequests + bufferCapacity;
    
    if (totalCapacity === 0) return <g />;
    
    const limitWidth = (maxRequests / totalCapacity) * width;
    const bufferWidth = (bufferCapacity / totalCapacity) * width;
    const usageWidth = (cappedUsage / totalCapacity) * width;
    const statusColor = getStatusColor(data.status);
    
    return (
      <g>
        {/* Limit portion - gray */}
        <rect
          x={x}
          y={y}
          width={Math.max(0, limitWidth)}
          height={height}
          fill="#9ca3af"
          stroke="#6b7280"
          strokeWidth={0.5}
        />
        {/* Buffer portion - lighter gray */}
        {bufferCapacity > 0 && (
          <rect
            x={x + limitWidth}
            y={y}
            width={Math.max(0, bufferWidth)}
            height={height}
            fill="#d1d5db"
            stroke="#9ca3af"
            strokeWidth={0.5}
          />
        )}
        {/* Usage overlay - colored by status, full height */}
        {cappedUsage > 0 && (
          <rect
            x={x}
            y={y}
            width={Math.min(usageWidth, width)}
            height={height}
            fill={statusColor}
            opacity={0.9}
          />
        )}
      </g>
    );
  };

  const copyToClipboard = async () => {
    try {
      const dataToCopy = chartData.map(({ provider, maxRequests, bufferCapacity, totalRequestsInWindow, totalQueueLength, utilizationPercent, status }) => ({
        provider,
        maxRequests,
        bufferCapacity,
        requestsInWindow: totalRequestsInWindow,
        queueLength: totalQueueLength,
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

  const isDownsampled = chartData.length < providerSummaries.length;

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

  // Find global max for X axis domain
  const globalMaxCapacity = Math.max(1, Math.max(...chartData.map((d) => d.maxRequests + d.bufferCapacity)));

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
              Showing {chartData.length} of {providerSummaries.length} providers (max-sampled)
            </span>
          )}
        </div>

        <div id="rate-limiter-chart-description" className="sr-only">
          Horizontal stacked bar chart displaying rate limiter capacity per provider.
          Base gray bar: request limit. Top lighter bar: buffer capacity.
          Colored overlay bar shows current usage: green (healthy), amber (warning), red (critical), violet (buffered).
          Hover bars for exact values and provider details.
        </div>

        <div className="max-h-[600px] overflow-y-auto">
          <ResponsiveContainer width="100%" height={Math.min(600, Math.max(300, chartData.length * 48 + 120))}>
            <BarChart
              data={chartData}
              aria-labelledby="rate-limiter-chart-description"
              role="img"
              layout="vertical"
              margin={{ top: 20, right: 20, bottom: 60, left: 160 }}
            >
              <CartesianGrid strokeDasharray="3 3" stroke="#e5e7eb" vertical={false} />

              {/* X Axis - Request values */}
              <XAxis
                type="number"
                label={{
                  value: "Requests",
                  position: "outsideBottom",
                  offset: 80,
                  style: { textAnchor: "middle", fill: "#333", fontSize: 12, fontWeight: 500 },
                }}
                tick={{ fill: "#666", fontSize: 11 }}
                tickLine={{ stroke: "#999" }}
                axisLine={{ stroke: "#999" }}
                tickFormatter={(value) => formatNumber(value)}
                domain={[0, globalMaxCapacity * 1.15]}
              />

              {/* Y Axis - Provider names */}
              <YAxis
                dataKey="provider"
                type="category"
                width={160}
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
                    const totalCapacity = p.totalCapacity ?? (p.maxRequests + p.bufferCapacity);
                    const usagePercent = totalCapacity > 0
                      ? formatPercent((p.totalRequestsInWindow / totalCapacity) * 100)
                      : "0";
                    return `${p.provider} | ${p.totalRequestsInWindow}/${p.maxRequests} requests used (${usagePercent}%)${p.totalQueueLength > 0 ? ` | ${p.totalQueueLength} queued` : ""} | Buffer: ${p.bufferCapacity}`;
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

              {/* Single Bar with custom shape rendering capacity + usage overlay */}
              <Bar
                dataKey="totalCapacity"
                name="Capacity"
                fill="#9ca3af"
                shape={CapacityBarShape}
                aria-label="Rate limiter capacity and usage"
                animationDuration={0}
              />

              {/* Reference lines for utilization thresholds */}
              {chartData.map((p, idx) => (
                <React.Fragment key={p.provider}>
                  <ReferenceLine
                    x={p.totalCapacity * 0.7}
                    stroke="#f59e0b"
                    strokeWidth={1}
                    strokeDasharray="4 4"
                    label={
                      <Label
                        value={`${p.provider}: 70%`}
                        position="center"
                        fill="#f59e0b"
                        fontSize={8}
                        offset={10 + idx * 25}
                      />
                    }
                  />
                  <ReferenceLine
                    x={p.totalCapacity * 0.9}
                    stroke="#ef4444"
                    strokeWidth={1}
                    strokeDasharray="4 4"
                    label={
                      <Label
                        value={`${p.provider}: 90%`}
                        position="center"
                        fill="#ef4444"
                        fontSize={8}
                        offset={10 + idx * 25}
                      />
                    }
                  />
                  <ReferenceLine
                    x={p.totalCapacity}
                    stroke="#6b7280"
                    strokeWidth={1}
                    strokeDasharray="2 2"
                    label={
                      <Label
                        value={`${p.provider}: Limit`}
                        position="center"
                        fill="#6b7280"
                        fontSize={8}
                        offset={10 + idx * 25}
                      />
                    }
                  />
                </React.Fragment>
              ))}
            </BarChart>
          </ResponsiveContainer>
        </div>
      </div>

      {/* Legend */}
      <div className="flex flex-wrap items-center gap-4 text-sm text-muted-foreground">
        <div className="flex items-center gap-2">
          <div className="w-4 h-4 rounded" style={{ background: "#22c55e" }} />
          <span>Healthy (below 70%)</span>
        </div>
        <div className="flex items-center gap-2">
          <div className="w-4 h-4 rounded" style={{ background: "#f59e0b" }} />
          <span>Warning (70-90%)</span>
        </div>
        <div className="flex items-center gap-2">
          <div className="w-4 h-4 rounded" style={{ background: "#ef4444" }} />
          <span>Critical (90%+ or over limit)</span>
        </div>
        <div className="flex items-center gap-2">
          <div className="w-4 h-4 rounded" style={{ background: "#8b5cf6" }} />
          <span>Buffered</span>
        </div>
        <div className="flex items-center gap-1">
          <div className="w-8 h-4 rounded" style={{ background: "linear-gradient(90deg, #9ca3af 50%, #d1d5db 50%)" }} />
          <span>Capacity (Limit + Buffer)</span>
        </div>
      </div>
    </div>
  );
}

/**
 * Provider Utilization Card - compact summary per provider
 */
function ProviderUtilizationCard({ summary }: { summary: ProviderSummary }) {
  const { provider, maxRequests, bufferCapacity, totalRequestsInWindow, totalQueueLength, status } = summary;

  const statusColors = {
    healthy: { bg: "bg-green-50", border: "border-green-200", text: "text-green-800", dot: "bg-green-500", hex: "#22c55e" },
    warning: { bg: "bg-amber-50", border: "border-amber-200", text: "text-amber-800", dot: "bg-amber-500", hex: "#f59e0b" },
    critical: { bg: "bg-red-50", border: "border-red-200", text: "text-red-800", dot: "bg-red-500", hex: "#ef4444" },
    buffered: { bg: "bg-violet-50", border: "border-violet-200", text: "text-violet-800", dot: "bg-violet-500", hex: "#8b5cf6" },
  };

  const colors = statusColors[status];

  // Guard against zero total capacity - match main chart behavior
  const totalCapacity = maxRequests + bufferCapacity;
  const limitPercent = totalCapacity > 0 ? Math.min(100, (maxRequests / totalCapacity) * 100) : 0;
  const bufferPercent = totalCapacity > 0 ? Math.min(100, (bufferCapacity / totalCapacity) * 100) : 0;
  const usagePercent = totalCapacity > 0 ? Math.min(100, (totalRequestsInWindow / totalCapacity) * 100) : 0;

  // Formatted percentages for display (max 2 decimal places)
  const usagePercentFormatted = formatPercent(usagePercent);

  return (
    <div className={`rounded-lg border p-3 ${colors.bg} ${colors.border} flex flex-col gap-2`}>
      <div className="flex items-center justify-between">
        <h4 className="font-medium text-sm">{provider}</h4>
        <span className={`w-2 h-2 rounded-full ${colors.dot}`} />
      </div>

      {/* Capacity meter - shows limit + buffer */}
      <div className="w-full h-3 bg-gray-200 rounded-full overflow-hidden relative">
        {/* Limit portion - absolute positioned at left */}
        <div
          className="h-full bg-gray-400"
          style={{
            position: 'absolute',
            top: 0,
            left: 0,
            width: `${limitPercent}%`,
            borderRadius: limitPercent === 100 ? '0.25rem' : '0.25rem 0 0 0.25rem',
          }}
        />
        {/* Buffer portion - absolute positioned after limit */}
        {bufferCapacity > 0 && (
          <div
            className="h-full bg-gray-300"
            style={{
              position: 'absolute',
              top: 0,
              left: `${limitPercent}%`,
              width: `${bufferPercent}%`,
              borderRadius: limitPercent === 0 ? '0.25rem' : '0 0.25rem 0.25rem 0',
            }}
          />
        )}
        {/* Usage overlay - based on total capacity */}
        <div
          className="absolute top-0 left-0 h-full rounded-full transition-all duration-300"
          style={{
            width: `${usagePercent}%`,
            backgroundColor: colors.hex,
          }}
        />
      </div>

      <div className="flex items-center justify-between text-xs">
        <span className={colors.text} font-medium>
          {usagePercentFormatted}% used
        </span>
        <span className="text-muted-foreground">
          {formatNumber(totalRequestsInWindow)} / {formatNumber(totalCapacity)} used
          {bufferCapacity > 0 && <span className="ml-1">(limit: {formatNumber(maxRequests)}, buffer: {formatNumber(bufferCapacity)})</span>}
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

export const RateLimiterChart = memo(RateLimiterChartComponent, chartDataEqual);
