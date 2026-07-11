"use client";

import { useState } from "react";
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
  LabelList,
  Tooltip,
} from "recharts";
import { Copy } from "lucide-react";

interface TrafficChartProps {
  data: TrafficMetric[];
}

export function TrafficChart({ data }: TrafficChartProps) {
  const [copied, setCopied] = useState(false);

  const chartData = data.map((item) => ({
    timestamp: new Date(item.timestamp).toLocaleDateString(),
    requestBytes: item.requestBytes,
    responseBytes: item.responseBytes,
    formattedRequest: formatBytes(item.requestBytes),
    formattedResponse: formatBytes(item.responseBytes),
  }));

  const copyToClipboard = async () => {
    try {
      const dataToCopy = chartData.map(
        ({ formattedRequest, formattedResponse, ...rest }) => rest
      );
      await navigator.clipboard.writeText(JSON.stringify(dataToCopy, null, 2));
      setCopied(true);
      setTimeout(() => setCopied(false), 2000);
    } catch {
      // Silently fail
    }
  };

  return (
    <div className="w-full">
      <div className="flex justify-end mb-2">
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
      </div>
      <div
        id="traffic-chart-description"
        className="sr-only"
      >
        Bar chart displaying request and response bytes over time. Each bar
        represents a time period with blue indicating request bytes and green
        indicating response bytes.
      </div>
      <ResponsiveContainer width="100%" height={300}>
        <BarChart
          data={chartData}
          aria-labelledby="traffic-chart-description"
          role="img"
        >
          <CartesianGrid strokeDasharray="3 3" stroke="#ccc" />
          <XAxis
            dataKey="timestamp"
            label={{
              value: "Date",
              position: "outsideBottom",
              style: { textAnchor: "middle", fill: "#333" },
            }}
            tick={{ fill: "#333", fontSize: 12 }}
            tickLine={{ stroke: "#666" }}
            axisLine={{ stroke: "#666" }}
          />
          <YAxis
            label={{
              value: "Bytes",
              angle: -90,
              position: "outsideLeft",
              style: { textAnchor: "middle", fill: "#333" },
            }}
            tick={{ fill: "#333", fontSize: 12 }}
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
            radius={[4, 4, 0, 0]}
            aria-label="Request bytes"
          >
            <LabelList
              position="top"
              formatter={(value: number) => formatBytes(value)}
            />
          </Bar>
          <Bar
            dataKey="responseBytes"
            name="Response Bytes"
            fill="#10b981"
            stroke="#059669"
            strokeDasharray="8 2"
            strokeWidth={1}
            opacity={0.85}
            radius={[4, 4, 0, 0]}
            aria-label="Response bytes"
          >
            <LabelList
              position="top"
              formatter={(value: number) => formatBytes(value)}
            />
          </Bar>
        </BarChart>
      </ResponsiveContainer>
    </div>
  );
}
