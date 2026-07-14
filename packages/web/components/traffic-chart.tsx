"use client";

import { useState, useMemo } from "react";
import { formatBytes } from "@/lib/utils";
import type { TrafficMetric } from "@/types/api";
import {
  BarChart,
  Bar,
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
}

interface ChartDataPoint {
  timestamp: string;
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
    const timestamp = chunk[chunk.length - 1].timestamp;
    result.push({ timestamp, requestBytes: maxRequest, responseBytes: maxResponse });
  }

  return result;
}

export function TrafficChart({ data, maxDataPoints = 50, loading = false }: TrafficChartProps) {
  const [copied, setCopied] = useState(false);

  const chartData = useMemo(() => {
    const raw = data.map((item) => ({
      timestamp: new Date(item.timestamp).toLocaleDateString(),
      requestBytes: item.requestBytes,
      responseBytes: item.responseBytes,
    }));
    return downsampleData(raw, maxDataPoints);
  }, [data, maxDataPoints]);

  const copyToClipboard = async () => {
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
  };

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
        Bar chart displaying request and response bytes over time. Each bar
        represents a time period with blue indicating request bytes and green
        indicating response bytes. Hover bars for exact values.
      </div>
      <ResponsiveContainer width="100%" height={300}>
        <BarChart
          data={chartData}
          aria-labelledby="traffic-chart-description"
          role="img"
          layout="vertical"
        >
          <CartesianGrid strokeDasharray="3 3" stroke="#ccc" />
          {/* With layout="vertical" (horizontal bars): XAxis is the value axis at the bottom, YAxis is the category axis on the left */}
          <XAxis
            type="number"
            label={{
              // XAxis is the value axis at the bottom in vertical layout
              value: "Bytes",
              position: "outsideBottom",
              offset: 40,
              style: { textAnchor: "middle", fill: "#333" },
            }}
            tick={{ fill: "#333", fontSize: 12 }}
            tickLine={{ stroke: "#666" }}
            axisLine={{ stroke: "#666" }}
            tickFormatter={(value) => formatBytes(value)}
          />
          <YAxis
            dataKey="timestamp"
            type="category"
            width={160}
            label={{
              // YAxis is horizontal on the BOTTOM in vertical layout
              value: "Date",
              position: "outsideBottom",
              offset: 30,
              style: { textAnchor: "middle", fill: "#333" },
            }}
            tick={{ fill: "#333", fontSize: 11 }}
            tickLine={{ stroke: "#666" }}
            axisLine={{ stroke: "#666" }}
          />
          <Tooltip
            formatter={(value: number) => formatBytes(value)}
            labelFormatter={(label) => `Date: ${label}`}
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
          <Bar
            dataKey="requestBytes"
            name="Request Bytes"
            fill="#3b82f6"
            stroke="#1d4ed8"
            strokeDasharray="4 4"
            strokeWidth={1}
            opacity={0.85}
            radius={[0, 4, 4, 0]}
            aria-label="Request bytes"
          />
          <Bar
            dataKey="responseBytes"
            name="Response Bytes"
            fill="#10b981"
            stroke="#059669"
            strokeDasharray="8 2"
            strokeWidth={1}
            opacity={0.85}
            radius={[0, 4, 4, 0]}
            aria-label="Response bytes"
          />
        </BarChart>
      </ResponsiveContainer>
    </div>
  );
}
