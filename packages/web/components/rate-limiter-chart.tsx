"use client";

import { useState, useMemo } from "react";
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
 * and taking the max value in each group (to preserve peaks).
 */
function downsampleData(data: ChartDataPoint[], maxPoints: number): ChartDataPoint[] {
  if (data.length <= maxPoints) return data;

  const step = Math.ceil(data.length / maxPoints);
  const result: ChartDataPoint[] = [];

  for (let i = 0; i < data.length; i += step) {
    const chunk = data.slice(i, i + step);
    // Use the bucket with max tokens to preserve worst-case
    const maxItem = chunk.reduce((max, item) => (item.tokens > max.tokens ? item : max), chunk[0]);
    result.push(maxItem);
  }

  return result;
}

export function RateLimiterChart({ buckets, loading = false }: RateLimiterChartProps) {
  const [copied, setCopied] = useState(false);
  const maxDataPoints = 50;

  const chartData = useMemo(() => {
    const raw = buckets.map((bucket) => {
      // Extract provider and sessionId from key if present (format: "sessionId:provider")
      const [sessionId, provider] = bucket.key.split(":");
      return {
        key: bucket.key,
        displayKey: bucket.key.length > 30 ? bucket.key.slice(0, 27) + "..." : bucket.key,
        tokens: bucket.tokens,
        maxTokens: bucket.maxTokens,
        bufferCapacity: bucket.bufferCapacity,
        queueLength: bucket.queueLength,
        provider: bucket.provider ?? provider ?? "unknown",
        sessionId: bucket.sessionId ?? sessionId ?? "unknown",
      };
    });

    // Sort by tokens ascending (most constrained first)
    raw.sort((a, b) => a.tokens - b.tokens);

    return downsampleData(raw, maxDataPoints);
  }, [buckets]);

  const copyToClipboard = async () => {
    try {
      const dataToCopy = chartData.map(({ displayKey, tokens, maxTokens, bufferCapacity, queueLength, provider, sessionId }) => ({
        key: displayKey,
        tokens,
        maxTokens,
        bufferCapacity,
        queueLength,
        provider,
        sessionId,
      }));
      await navigator.clipboard.writeText(JSON.stringify(dataToCopy, null, 2));
      setCopied(true);
      setTimeout(() => setCopied(false), 2000);
    } catch {
      // Silently fail
    }
  };

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

  // Calculate max token value for Y axis (use maxTokens which already includes buffer)
  const maxTokenValue = Math.max(...chartData.map((d) => d.maxTokens));

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
            Showing {chartData.length} of {buckets.length} buckets (peaked-sampled)
          </span>
        )}
      </div>

      <div
        id="rate-limiter-chart-description"
        className="sr-only"
      >
        Horizontal bar chart displaying token bucket states per session/provider.
        Blue bars show available tokens, green bars show buffer capacity,
        red bars show queued requests. All bars are stacked. Red reference line
        indicates the total token capacity (max requests + buffer).
        Hover bars for exact values and session/provider details.
      </div>

      <ResponsiveContainer width="100%" height={Math.max(300, chartData.length * 30 + 100)}>
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
              position: "outsideBottom",
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
          
          {/* Buffer capacity reference line - shows total capacity */}
          <ReferenceLine
            x={maxTokenValue}
            stroke="#ef4444"
            strokeWidth={2}
            strokeDasharray="5 5"
            label={
              <Label
                value="Total Capacity"
                position="center"
                fill="#ef4444"
                fontSize={11}
                fontWeight={600}
                offset={10}
              />
            }
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
            stackId="a"
          />
          
          {/* Buffer capacity (green) - stacked on top of available tokens */}
          <Bar
            dataKey="bufferCapacity"
            name="Buffer Capacity"
            fill="#10b981"
            stroke="#059669"
            strokeDasharray="8 2"
            strokeWidth={1}
            opacity={0.85}
            radius={[0, 4, 4, 0]}
            aria-label="Buffer capacity"
            stackId="a"
          />
          
          {/* Queue length indicator (red) - stacked on top */}
          <Bar
            dataKey="queueLength"
            name="Queued Requests"
            fill="#ef4444"
            stroke="#dc2626"
            strokeDasharray="2 2"
            strokeWidth={1}
            opacity={0.7}
            radius={[0, 4, 4, 0]}
            aria-label="Queued requests"
            stackId="a"
          />
        </BarChart>
      </ResponsiveContainer>
    </div>
  );
}