"use client";

import { useState, useMemo, useCallback } from "react";
import { formatBytes } from "@/lib/utils";
import type { TrafficMetric } from "@/types/api";
import {
  AreaChart,
  Area,
  XAxis,
  YAxis,
  CartesianGrid,
  ResponsiveContainer,
  Legend,
  Tooltip,
} from "recharts";
import { Copy, Loader2 } from "lucide-react";

interface TrafficChartProps {
  data: TrafficMetric[];
  /**
   * Maximum number of data points to render before sampling/aggregating.
   * Default: 50. Set to undefined to disable client-side sampling.
   */
  maxDataPoints?: number;
  /**
   * Show a loading spinner while data is being fetched/processed.
   * Default: false.
   */
  loading?: boolean;
  /**
   * Time range in hours for the data. Used to determine timestamp formatting.
   * Default: 24 (show hours for ≤24h, dates for longer ranges).
   */
  timeRangeHours?: number;
}

interface ChartDataPoint {
  timestamp: string;
  originalTimestamp: string;
  requestBytes: number;
  responseBytes: number;
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
    const maxRequest = Math.max(...chunk.map((d) => d.requestBytes));
    const maxResponse = Math.max(...chunk.map((d) => d.responseBytes));
    // Use the timestamp from the last item in the chunk for labeling
    // Since data is chronological (oldest first), the last item is the newest in the chunk
    const timestamp = chunk[chunk.length - 1].timestamp;
    const originalTimestamp = chunk[chunk.length - 1].originalTimestamp;
    result.push({ timestamp, originalTimestamp, requestBytes: maxRequest, responseBytes: maxResponse });
  }

  return result;
}

function formatBytesWithUnit(bytes: number): string {
  if (bytes >= 1024 * 1024) {
    return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
  }
  if (bytes >= 1024) {
    return `${(bytes / 1024).toFixed(1)} KB`;
  }
  return `${bytes} B`;
}

export function TrafficChart({
  data,
  maxDataPoints,
  loading = false,
  timeRangeHours = 24,
}: TrafficChartProps) {
  const [copied, setCopied] = useState(false);

  const chartData = useMemo(() => {
    // API returns data sorted newest-first (reverse chronological).
    // For a time-series area chart, we need oldest-first (chronological).
    // So we reverse the array.
    const raw = [...data]
      .reverse()
      .map((item) => {
        const date = new Date(item.timestamp);
        // For short time ranges (≤24h), show time; otherwise show date
        const timestamp = timeRangeHours <= 24
          ? date.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })
          : date.toLocaleDateString([], { month: '2-digit', day: '2-digit' });
        return {
          timestamp,
          originalTimestamp: item.timestamp, // Keep original ISO string for tooltip
          requestBytes: item.requestBytes,
          responseBytes: item.responseBytes,
        };
      });
    // Only downsample if maxDataPoints is a positive number
    // 0, negative, or undefined = no downsampling (unlimited)
    if (maxDataPoints && maxDataPoints > 0) {
      return downsampleData(raw, maxDataPoints);
    }
    return raw;
  }, [data, maxDataPoints, timeRangeHours]);

  const copyToClipboard = useCallback(async () => {
    try {
      const dataToCopy = chartData.map(
        ({ timestamp, requestBytes, responseBytes }) => ({
          timestamp,
          requestBytes,
          responseBytes,
        })
      );
      await navigator.clipboard.writeText(JSON.stringify(dataToCopy, null, 2));
      setCopied(true);
      setTimeout(() => setCopied(false), 2000);
    } catch {
      // Silently fail
    }
  }, [chartData]);

  // Show a note if data was downsampled
  const isDownsampled = chartData.length < data.length;

  // Show loading spinner when data is being fetched/processed
  if (loading) {
    return (
      <div className="w-full flex flex-col items-center justify-center py-12">
        <Loader2 className="h-8 w-8 animate-spin text-primary" />
        <p className="mt-2 text-sm text-muted-foreground">Loading traffic data...</p>
      </div>
    );
  }

  // Find max value for Y-axis domain to leave some headroom
  const maxBytes = Math.max(
    chartData.length > 0 ? Math.max(...chartData.map((d) => d.requestBytes)) : 0,
    chartData.length > 0 ? Math.max(...chartData.map((d) => d.responseBytes)) : 0,
  );

  return (
    <div className="w-full">
      <div className="flex justify-between items-center mb-2">
        <button
          onClick={copyToClipboard}
          className="inline-flex items-center gap-1 px-2 py-1 text-sm rounded hover:bg-muted"
          aria-label={
            copied ? "Chart data copied to clipboard" : "Copy chart data to clipboard"
          }
          title={
            copied ? "Chart data copied to clipboard" : "Copy chart data to clipboard"
          }
        >
          <Copy className="h-4 w-4" />
          {copied ? "Copied" : "Copy"}
        </button>
        {isDownsampled && (
          <span className="text-xs text-muted-foreground">
            Showing {chartData.length} of {data.length} data points (peaked-sampled)
          </span>
        )}
      </div>
      <div
        id="traffic-chart-description"
        className="sr-only"
      >
        Filled area chart displaying request and response bytes over time. The shaded
        areas represent the volume of bytes, with blue for requests and green for
        responses. The x-axis shows time progressing left to right. Hover for exact values.
      </div>
      <ResponsiveContainer width="100%" height={300}>
        <AreaChart
          data={chartData}
          aria-labelledby="traffic-chart-description"
          role="img"
          margin={{ top: 10, right: 30, left: 60, bottom: 60 }}
        >
          <defs>
            <linearGradient id="requestBytesGradient" x1="0" y1="0" x2="0" y2="1">
              <stop offset="0%" stopColor="#3b82f6" stopOpacity={0.4} />
              <stop offset="100%" stopColor="#3b82f6" stopOpacity={0.05} />
            </linearGradient>
            <linearGradient id="responseBytesGradient" x1="0" y1="0" x2="0" y2="1">
              <stop offset="0%" stopColor="#10b981" stopOpacity={0.4} />
              <stop offset="100%" stopColor="#10b981" stopOpacity={0.05} />
            </linearGradient>
          </defs>
          <CartesianGrid
            strokeDasharray="3 3"
            stroke="#e2e8f0"
            vertical={true}
            horizontal={true}
          />
          <XAxis
            dataKey="timestamp"
            type="category"
            tick={{ fill: "#333", fontSize: 11 }}
            tickLine={{ stroke: "#94a3b8" }}
            axisLine={{ stroke: "#94a3b8" }}
            tickCount={chartData.length > 0 ? Math.min(chartData.length, 8) : 0}
            interval="preserveStartEnd"
          />
          <YAxis
            type="number"
            label={{
              value: "Bytes",
              position: "insideLeft",
              offset: -40,
              style: { textAnchor: "middle", fill: "#64748b", fontSize: 12 },
            }}
            tick={{ fill: "#333", fontSize: 11 }}
            tickLine={{ stroke: "#94a3b8" }}
            axisLine={{ stroke: "#94a3b8" }}
            tickFormatter={formatBytesWithUnit}
            domain={maxBytes > 0 ? [0, Math.ceil(maxBytes * 1.15)] : [0, 1000]}
          />
          <Tooltip
            formatter={(value: number, name: string) => [formatBytes(value), name]}
            labelFormatter={(label, payload) => {
              if (payload && payload.length > 0 && payload[0].payload?.originalTimestamp) {
                const originalTs = payload[0].payload.originalTimestamp;
                const date = new Date(originalTs);
                return date.toLocaleString([], {
                  year: 'numeric',
                  month: '2-digit',
                  day: '2-digit',
                  hour: '2-digit',
                  minute: '2-digit',
                  second: '2-digit',
                });
              }
              return `Time: ${label}`;
            }}
            contentStyle={{
              backgroundColor: "rgba(255, 255, 255, 0.95)",
              border: "1px solid #e2e8f0",
              borderRadius: "6px",
              boxShadow: "0 4px 12px rgba(0, 0, 0, 0.1)",
            }}
            cursor={{ fill: "rgba(59, 130, 246, 0.1)" }}
          />
          <Legend
            verticalAlign="top"
            align="center"
            iconSize={12}
            wrapperStyle={{ fontSize: 12, fontWeight: 500 }}
          />
          <Area
            type="monotone"
            dataKey="requestBytes"
            name="Request Bytes"
            stroke="#3b82f6"
            strokeWidth={2}
            fillOpacity={1}
            fill="url(#requestBytesGradient)"
            opacity={0.9}
          />
          <Area
            type="monotone"
            dataKey="responseBytes"
            name="Response Bytes"
            stroke="#10b981"
            strokeWidth={2}
            fillOpacity={1}
            fill="url(#responseBytesGradient)"
            opacity={0.9}
          />
        </AreaChart>
      </ResponsiveContainer>
    </div>
  );
}