"use client";

import { useState, useMemo, useRef, useEffect } from "react";
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
  displayKey: string;
  tokens: number;
  maxTokens: number;
  bufferCapacity: number;
  queueLength: number;
  provider?: string;
  sessionId?: string;
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
    case "critical": return "#ef4444";
    case "warning": return "#f59e0b";
    case "queued": return "#8b5cf6";
    default: return "#22c55e";
  }
}

export function RateLimiterChart({ buckets, loading = false, maxDataPoints = 50 }: RateLimiterChartProps) {
  const [copied, setCopied] = useState(false);
  const copyTimeoutRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  const chartData = useMemo(() => {
    const raw = buckets.map((bucket) => {
      const maxTokens = bucket.maxTokens;
      const utilizationPercent = maxTokens > 0 ? Math.round((1 - bucket.tokens / maxTokens) * 100) : 0;
      return {
        key: bucket.key,
        displayKey: bucket.key.length > 35 ? bucket.key.slice(0, 32) + "..." : bucket.key,
        tokens: bucket.tokens,
        maxTokens,
        bufferCapacity: bucket.bufferCapacity,
        queueLength: bucket.queueLength,
        provider: bucket.provider ?? "unknown",
        sessionId: bucket.sessionId ?? "unknown",
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

  const copyToClipboard = async () => {
    try {
      const dataToCopy = chartData.map(({ key, tokens, maxTokens, bufferCapacity, queueLength, provider, sessionId, utilizationPercent, status }) => ({
        key,
        tokens,
        maxTokens,
        bufferCapacity,
        queueLength,
        provider,
        sessionId,
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

  const maxTokenValue = Math.max(1, Math.max(...chartData.map((d) => d.maxTokens)));
  const queuedCount = chartData.filter(d => d.queueLength > 0).length;
  const criticalCount = chartData.filter(d => d.status === "critical").length;
  const warningCount = chartData.filter(d => d.status === "warning").length;

  return (
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
        <div className="flex items-center gap-4 text-xs">
          <span className="flex items-center gap-1" title={`${criticalCount} critical`}>
            <span className="w-2 h-2 rounded-full" style={{ backgroundColor: "#ef4444" }} />
            {criticalCount}
          </span>
          <span className="flex items-center gap-1" title={`${warningCount} warning`}>
            <span className="w-2 h-2 rounded-full" style={{ backgroundColor: "#f59e0b" }} />
            {warningCount}
          </span>
          <span className="flex items-center gap-1" title={`${queuedCount} queued`}>
            <span className="w-2 h-2 rounded-full" style={{ backgroundColor: "#8b5cf6" }} />
            {queuedCount}
          </span>
          {isDownsampled && (
            <span className="text-muted-foreground">
              Showing {chartData.length} of {buckets.length} buckets (min-sampled)
            </span>
          )}
        </div>
      </div>

      <div id="rate-limiter-chart-description" className="sr-only">
        Horizontal bar chart displaying token bucket states per session/provider.
        Bars colored by utilization: green (healthy), amber (warning), red (critical), violet (queued).
        Hover bars for exact values and session/provider details.
      </div>

      <div className="max-h-[600px] overflow-y-auto">
        <ResponsiveContainer width="100%" height={Math.min(600, Math.max(300, chartData.length * 30 + 100))}>
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
              domain={[0, maxTokenValue * 1.15]}
            />
            
            {/* Y Axis - Bucket keys */}
            <YAxis
              dataKey="displayKey"
              type="category"
              width={220}
              label={{
                value: "Session : Provider",
                position: "outsideLeft",
                offset: 30,
                style: { textAnchor: "middle", fill: "#333", fontSize: 12, fontWeight: 500 },
              }}
              tick={{ fill: "#333", fontSize: 10 }}
              tickLine={{ stroke: "#999" }}
              axisLine={{ stroke: "#999" }}
            />
            
            <Tooltip
              formatter={(value: number, name: string) => [formatNumber(value), name]}
              labelFormatter={(label, payload) => {
                if (payload && payload.length > 0 && payload[0].payload) {
                  const p = payload[0].payload;
                  const used = p.maxTokens - p.tokens;
                  return `${p.provider} | Session: ${p.sessionId} | ${used}/${p.maxTokens} requests used (${p.utilizationPercent}%)`;
                }
                return `Bucket: ${label}`;
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
            >
              {chartData.map((entry, index) => (
                <Cell key={`cell-${index}`} fill={getStatusColor(entry.status)} />
              ))}
            </Bar>
            
            {/* Used requests (remainder to fill to maxTokens) */}
            <Bar
              dataKey="maxTokens"
              name="Max Requests"
              stackId="tokens"
              fill="transparent"
              stroke="transparent"
            />
            
            {/* Buffer capacity indicator */}
            <Bar
              dataKey="bufferCapacity"
              name="Buffer"
              stackId="buffer"
              fill="#8b5cf6"
              opacity={0.3}
              radius={[0, 4, 4, 0]}
            />
            
            {/* Max requests reference line (maxTokens includes buffer in the API) */}
            <ReferenceLine
              x={maxTokenValue}
              stroke="#6b7280"
              strokeWidth={1.5}
              strokeDasharray="5 5"
              label={
                <Label
                  value="Max Requests"
                  position="center"
                  fill="#6b7280"
                  fontSize={10}
                  fontWeight={600}
                  offset={10}
                />
              }
            />
            
            {/* 70% used warning line */}
            <ReferenceLine
              x={maxTokenValue * 0.3}
              stroke="#f59e0b"
              strokeWidth={1}
              strokeDasharray="3 3"
              label={
                <Label
                  value="70% Used"
                  position="center"
                  fill="#f59e0b"
                  fontSize={9}
                  offset={10}
                />
              }
            />
            
            {/* 90% used critical line */}
            <ReferenceLine
              x={maxTokenValue * 0.1}
              stroke="#ef4444"
              strokeWidth={1}
              strokeDasharray="3 3"
              label={
                <Label
                  value="90% Used"
                  position="center"
                  fill="#ef4444"
                  fontSize={9}
                  offset={10}
                />
              }
            />
          </BarChart>
        </ResponsiveContainer>
      </div>

      {/* Legend / Status Guide */}
      <div className="mt-4 flex flex-wrap items-center gap-4 text-xs text-muted-foreground">
        <span className="flex items-center gap-1 font-medium">Status:</span>
        <span className="flex items-center gap-1">
          <span className="w-2 h-2 rounded-full" style={{ backgroundColor: "#22c55e" }} />
          Healthy ({'<'}70% used)
        </span>
        <span className="flex items-center gap-1">
          <span className="w-2 h-2 rounded-full" style={{ backgroundColor: "#f59e0b" }} />
          Warning (70-90% used)
        </span>
        <span className="flex items-center gap-1">
          <span className="w-2 h-2 rounded-full" style={{ backgroundColor: "#ef4444" }} />
          Critical ({'>'}90% used)
        </span>
        <span className="flex items-center gap-1">
          <span className="w-2 h-2 rounded-full" style={{ backgroundColor: "#8b5cf6" }} />
          Queued
        </span>
        <span className="flex items-center gap-1 ml-auto">
          <span className="w-6 h-1.5" style={{ background: "linear-gradient(90deg, transparent 50%, #8b5cf633 50%)", backgroundSize: "4px 100%" }} />
          Buffer
        </span>
      </div>
    </div>
  );
}