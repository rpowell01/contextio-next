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
}

/**
 * Downsample data to a maximum number of points by grouping adjacent points
 * and taking the min value in each group (to preserve most constrained buckets).
 */
function downsampleData(data: ChartDataPoint[], maxPoints: number): ChartDataPoint[] {
  // If maxPoints <= 0, return all data (unlimited)
  if (maxPoints <= 0 || data.length <= maxPoints) return data;

  const step = Math.ceil(data.length / maxPoints);
  const result: ChartDataPoint[] = [];

  for (let i = 0; i < data.length; i += step) {
    const chunk = data.slice(i, i + step);
    // Use the bucket with min tokens to preserve most constrained (worst-case)
    const minItem = chunk.reduce((min, item) => (item.tokens < min.tokens ? item : min), chunk[0]);
    result.push(minItem);
  }

  return result;
}

export function RateLimiterChart({ buckets, loading = false, maxDataPoints = 50 }: RateLimiterChartProps) {
  const [copied, setCopied] = useState(false);
  const copyTimeoutRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  const chartData = useMemo(() => {
    const raw = buckets.map((bucket) => {
      // Use provider and sessionId from API response (already parsed by backend)
      return {
        key: bucket.key,
        displayKey: bucket.key.length > 30 ? bucket.key.slice(0, 27) + "..." : bucket.key,
        tokens: bucket.tokens,
        maxTokens: bucket.maxTokens,
        bufferCapacity: bucket.bufferCapacity,
        queueLength: bucket.queueLength,
        provider: bucket.provider ?? "unknown",
        sessionId: bucket.sessionId ?? "unknown",
      };
    });

    // Sort by tokens ascending (most constrained first) - create a copy to avoid mutation
    const sorted = [...raw].sort((a, b) => a.tokens - b.tokens);

    return downsampleData(sorted, maxDataPoints);
  }, [buckets, maxDataPoints]);

  const copyToClipboard = async () => {
    try {
      const dataToCopy = chartData.map(({ key, tokens, maxTokens, bufferCapacity, queueLength, provider, sessionId }) => ({
        key,
        tokens,
        maxTokens,
        bufferCapacity,
        queueLength,
        provider,
        sessionId,
      }));
      await navigator.clipboard.writeText(JSON.stringify(dataToCopy, null, 2));
      setCopied(true);
      if (copyTimeoutRef.current) {
        clearTimeout(copyTimeoutRef.current);
      }
      copyTimeoutRef.current = setTimeout(() => setCopied(false), 2000);
    } catch {
      // Silently fail
    }
  };

  // Cleanup timeout on unmount
  useEffect(() => {
    return () => {
      if (copyTimeoutRef.current) {
        clearTimeout(copyTimeoutRef.current);
      }
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

  // Calculate max token value for Y axis (maxTokens already includes buffer capacity)
  // Ensure minimum of 1 to prevent Recharts domain edge case [0, 0]
  const maxTokenValue = Math.max(1, Math.max(...chartData.map((d) => d.maxTokens)));

  return (
    <div className="w-full">
      <div className="flex justify-between items-center mb-2">
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
          <span className="text-xs text-muted-foreground">
            Showing {chartData.length} of {buckets.length} buckets (min-sampled)
          </span>
        )}
      </div>

      <div
        id="rate-limiter-chart-description"
        className="sr-only"
      >
        Horizontal bar chart displaying token bucket states per session/provider.
        Blue bars show available tokens. Red dashed reference line indicates the
        total capacity (max requests + buffer). Hover bars for exact values and
        session/provider details.
      </div>

      <div className="max-h-[600px] overflow-y-auto">
        <ResponsiveContainer width="100%" height={Math.min(600, Math.max(300, chartData.length * 30 + 100))}>
        <BarChart
          data={chartData}
          aria-labelledby="rate-limiter-chart-description"
          role="img"
          layout="vertical"
        >
          <CartesianGrid strokeDasharray="3 3" stroke="#ccc" />
          
          {/* X Axis - Token values */}
          <XAxis
            type="number"
            label={{
              value: "Tokens",
              position: "outsideBottom",
              offset: 80,
              style: { textAnchor: "middle", fill: "#333" },
            }}
            tick={{ fill: "#333", fontSize: 12 }}
            tickLine={{ stroke: "#666" }}
            axisLine={{ stroke: "#666" }}
            tickFormatter={(value) => formatNumber(value)}
            domain={[0, maxTokenValue * 1.1]}
          />
          
          {/* Y Axis - Bucket keys */}
          <YAxis
            dataKey="displayKey"
            type="category"
            width={200}
            label={{
              value: "Session:Provider",
              position: "outsideLeft",
              offset: 30,
              style: { textAnchor: "middle", fill: "#333" },
            }}
            tick={{ fill: "#333", fontSize: 11 }}
            tickLine={{ stroke: "#666" }}
            axisLine={{ stroke: "#666" }}
          />
          
          <Tooltip
            formatter={(value: number, name: string) => [formatNumber(value), name]}
            labelFormatter={(label, payload) => {
              if (payload && payload.length > 0 && payload[0].payload) {
                const p = payload[0].payload;
                return `${p.provider} | Session: ${p.sessionId} | Key: ${p.key}`;
              }
              return `Bucket: ${label}`;
            }}
            contentStyle={{
              backgroundColor: "rgba(255, 255, 255, 0.95)",
              border: "1px solid #ccc",
            }}
            cursor={{ fill: "rgba(0, 0, 0, 0.1)" }}
          />
          
          <Legend
            verticalAlign="top"
            align="center"
            iconSize={12}
            wrapperStyle={{ fontSize: 12, fontWeight: 500 }}
          />
          
          {/* Available tokens (blue) */}
          <Bar
            dataKey="tokens"
            name="Available Tokens"
            fill="#3b82f6"
            stroke="#1d4ed8"
            strokeDasharray="4 4"
            strokeWidth={1}
            opacity={0.85}
            radius={[0, 4, 4, 0]}
            aria-label="Available tokens"
          />
          
          {/* Total capacity reference line */}
          <ReferenceLine
            x={maxTokenValue}
            stroke="#ef4444"
            strokeWidth={2}
            strokeDasharray="5 5"
            label={
              <Label
                value="Total Capacity (Max + Buffer)"
                position="center"
                fill="#ef4444"
                fontSize={11}
                fontWeight={600}
                offset={10}
              />
            }
          />
        </BarChart>
      </ResponsiveContainer>
    </div>
  </div>
  );
}