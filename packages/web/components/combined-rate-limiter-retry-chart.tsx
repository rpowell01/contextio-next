"use client";

import React, { memo, useMemo, useState, useRef, useEffect } from "react";
import { formatNumber } from "@/lib/utils";
import type { RateLimiterMetrics, RetryMetrics, RetryProviderMetrics } from "@/types/client-api";
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

interface CombinedRateLimiterRetryChartProps {
  rateLimiterMetrics: RateLimiterMetrics | null;
  retryMetrics: RetryMetrics | null;
  loading?: boolean;
  maxDataPoints?: number;
}

interface ProviderData {
  provider: string;
  // Request Buckets (from rate limiter)
  requestBuckets: number;
  maxRequests: number;
  bufferCapacity: number;
  totalRequestsInWindow: number;
  totalQueueLength: number;
  utilizationPercent: number;
  // Retry Attempts (from retry metrics)
  nonStreamingRetryAttempts: number;
  streamingRetryAttempts: number;
  totalRetryAttempts: number;
  // Streaming Retry Buffer Usage
  currentBufferUsageMB: number;
  maxBufferUsageMB: number;
  bufferUtilizationPercent: number;
  activeStreamingSessions: number;
  maxRetries: number;
}

// Color constants for consistent theming across charts
const CHART_COLORS = {
  // Request buckets
  requestBucketsUsed: "#3b82f6",        // Blue
  requestBucketsQueue: "#60a5fa",       // Light blue for queue
  // Retry attempts
  retryNonStreaming: "#f59e0b",         // Amber
  retryStreaming: "#8b5cf6",            // Purple (distinct from blue)
  // Buffer usage
  bufferMax: "#d1d5db",                 // Gray for max capacity
  bufferCurrent: "#10b981",             // Green for active usage
  // Reference lines
  threshold70: "#fbbf24",               // Amber for 70%
  threshold90: "#ef4444",               // Red for 90%
  maxRetries: "#f59e0b",                // Amber for max retries
  maxBuffer: "#6b7280",                 // Gray for max buffer
  maxRequests: "#6b7280",               // Gray for max requests (same as max buffer for consistency)
} as const;

/**
 * Format a percentage value to maximum 2 decimal places, trimming trailing zeros.
 * e.g., 50 -> "50", 50.5 -> "50.5", 50.555 -> "50.56", 50.50 -> "50.5"
 */
function formatPercent(value: number): string {
  return value.toFixed(2).replace(/\.?0+$/, "");
}

interface BufferUsageShapeProps {
  x: number;
  y: number;
  width: number;
  height: number;
  payload: ProviderData | undefined;
}

/**
 * Custom shape for buffer usage bar - renders max buffer as background
 * and current usage as a green overlay capped at max.
 */
const BufferUsageShape = ({ x, y, width, height, payload }: BufferUsageShapeProps) => {
  const data = payload;
  if (!data) return <g />;

  const maxBuffer = data.maxBufferUsageMB ?? 0;
  const currentBuffer = data.currentBufferUsageMB ?? 0;
  const bufferUtilization = data.bufferUtilizationPercent ?? 0;

  if (maxBuffer === 0) return <g />;

  // Current usage cannot exceed max - cap it visually
  const cappedCurrent = Math.min(currentBuffer, maxBuffer);
  const usageRatio = cappedCurrent / maxBuffer;
  const usageWidth = usageRatio * width;

  return (
    <g>
      {/* Max buffer background - gray */}
      <rect
        x={x}
        y={y}
        width={width}
        height={height}
        fill={CHART_COLORS.bufferMax}
        stroke="#9ca3af"
        strokeWidth={0.5}
      />
      {/* Current usage overlay - green, capped at max */}
      {cappedCurrent > 0 && (
        <rect
          x={x}
          y={y}
          width={Math.min(usageWidth, width)}
          height={height}
          fill={CHART_COLORS.bufferCurrent}
          opacity={0.9}
        />
      )}
      {/* Utilization percentage label at end of max bar */}
      {bufferUtilization > 0 && (
        <text
          x={x + width + 8}
          y={y + height / 2 + 4}
          fill="#6b7280"
          fontSize={10}
          fontWeight={500}
          dominantBaseline="middle"
        >
          {bufferUtilization.toFixed(1)}%
        </text>
      )}
    </g>
  );
};

/**
 * Downsample data to a maximum number of points by grouping adjacent points
 * and taking the max totalRequestsInWindow in each group (to preserve most constrained providers).
 */
function downsampleData(data: ProviderData[], maxPoints: number): ProviderData[] {
  if (maxPoints <= 0 || data.length <= maxPoints) return data;

  const step = Math.ceil(data.length / maxPoints);
  const result: ProviderData[] = [];

  for (let i = 0; i < data.length; i += step) {
    const chunk = data.slice(i, i + step);
    const maxItem = chunk.reduce((max, item) =>
      item.totalRequestsInWindow > max.totalRequestsInWindow ? item : max
    , chunk[0]);
    result.push(maxItem);
  }

  return result;
}

// Custom comparison function for memo - only re-render when data actually changes
function chartDataEqual(prevProps: CombinedRateLimiterRetryChartProps, nextProps: CombinedRateLimiterRetryChartProps): boolean {
  if (prevProps.loading !== nextProps.loading) return false;
  if (prevProps.maxDataPoints !== nextProps.maxDataPoints) return false;

  const prevRL = prevProps.rateLimiterMetrics;
  const nextRL = nextProps.rateLimiterMetrics;
  const prevRetry = prevProps.retryMetrics;
  const nextRetry = nextProps.retryMetrics;

  // Quick reference/bucket count check
  if (!prevRL?.buckets && !nextRL?.buckets) {
    // Both null/undefined, check retry metrics
  } else if (!prevRL?.buckets || !nextRL?.buckets) {
    return false; // One is null, other is not
  } else if (prevRL.buckets.length !== nextRL.buckets.length) {
    return false;
  } else {
    // Compare buckets
    for (let i = 0; i < prevRL.buckets.length; i++) {
      const pb = prevRL.buckets[i];
      const nb = nextRL.buckets[i];
      if (
        pb.provider !== nb.provider ||
        pb.maxTokens !== nb.maxTokens ||
        pb.bufferCapacity !== nb.bufferCapacity ||
        pb.queueLength !== nb.queueLength ||
        (pb.requestsInWindow ?? 0) !== (nb.requestsInWindow ?? 0)
      ) {
        return false;
      }
    }
  }

  // Compare retry metrics providers
  const prevProviders = prevRetry?.providers || [];
  const nextProviders = nextRetry?.providers || [];
  
  if (prevProviders.length !== nextProviders.length) return false;
  
  for (let i = 0; i < prevProviders.length; i++) {
    const pp = prevProviders[i];
    const np = nextProviders[i];
    if (
      pp.provider !== np.provider ||
      pp.nonStreamingRetryAttempts !== np.nonStreamingRetryAttempts ||
      pp.streamingRetryAttempts !== np.streamingRetryAttempts ||
      pp.totalRetryAttempts !== np.totalRetryAttempts ||
      pp.currentBufferUsageMB !== np.currentBufferUsageMB ||
      pp.maxBufferUsageMB !== np.maxBufferUsageMB ||
      pp.bufferUtilizationPercent !== np.bufferUtilizationPercent ||
      pp.activeStreamingSessions !== np.activeStreamingSessions ||
      pp.maxRetries !== np.maxRetries
    ) {
      return false;
    }
  }

  return true;
}

function CombinedRateLimiterRetryChartComponent({
  rateLimiterMetrics,
  retryMetrics,
  loading = false,
  maxDataPoints = 50,
}: CombinedRateLimiterRetryChartProps) {
  const [copied, setCopied] = useState(false);
  const copyTimeoutRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  // Aggregate rate limiter buckets by provider to match retry metrics providers
  const providerData = useMemo((): ProviderData[] => {
    const providerMap = new Map<string, ProviderData>();

    // First, process rate limiter buckets
    if (rateLimiterMetrics?.buckets) {
      rateLimiterMetrics.buckets.forEach((bucket) => {
        const provider = bucket.provider ?? "unknown";
        const maxRequests = bucket.maxTokens - bucket.bufferCapacity;
        const requestsInWindow = bucket.requestsInWindow ?? 0;

        const existing = providerMap.get(provider);
        if (!existing) {
          providerMap.set(provider, {
            provider,
            requestBuckets: 1,
            maxRequests,
            bufferCapacity: bucket.bufferCapacity,
            totalRequestsInWindow: requestsInWindow,
            totalQueueLength: bucket.queueLength,
            utilizationPercent: maxRequests > 0 ? Math.round((requestsInWindow / maxRequests) * 10000) / 100 : 0,
            // Retry fields - will be filled from retry metrics
            nonStreamingRetryAttempts: 0,
            streamingRetryAttempts: 0,
            totalRetryAttempts: 0,
            // Buffer fields
            currentBufferUsageMB: 0,
            maxBufferUsageMB: 0,
            bufferUtilizationPercent: 0,
            activeStreamingSessions: 0,
            maxRetries: 0,
          });
        } else {
          existing.requestBuckets += 1;
          existing.maxRequests += maxRequests;
          existing.bufferCapacity += bucket.bufferCapacity;
          existing.totalRequestsInWindow += requestsInWindow;
          existing.totalQueueLength += bucket.queueLength;
          existing.utilizationPercent = existing.maxRequests > 0
            ? Math.round((existing.totalRequestsInWindow / existing.maxRequests) * 10000) / 100
            : 0;
        }
      });
    }

    // Then, merge retry metrics
    if (retryMetrics?.providers) {
      retryMetrics.providers.forEach((retryProvider: RetryProviderMetrics) => {
        const provider = retryProvider.provider;
        const existing = providerMap.get(provider);
        
        if (!existing) {
          // Provider only exists in retry metrics
          providerMap.set(provider, {
            provider,
            requestBuckets: 0,
            maxRequests: 0,
            bufferCapacity: 0,
            totalRequestsInWindow: 0,
            totalQueueLength: 0,
            utilizationPercent: 0,
            nonStreamingRetryAttempts: retryProvider.nonStreamingRetryAttempts,
            streamingRetryAttempts: retryProvider.streamingRetryAttempts,
            totalRetryAttempts: retryProvider.totalRetryAttempts,
            currentBufferUsageMB: retryProvider.currentBufferUsageMB,
            maxBufferUsageMB: retryProvider.maxBufferUsageMB,
            bufferUtilizationPercent: retryProvider.bufferUtilizationPercent,
            activeStreamingSessions: retryProvider.activeStreamingSessions,
            maxRetries: retryProvider.maxRetries,
          });
        } else {
          // Merge retry data
          existing.nonStreamingRetryAttempts = retryProvider.nonStreamingRetryAttempts;
          existing.streamingRetryAttempts = retryProvider.streamingRetryAttempts;
          existing.totalRetryAttempts = retryProvider.totalRetryAttempts;
          existing.currentBufferUsageMB = retryProvider.currentBufferUsageMB;
          existing.maxBufferUsageMB = retryProvider.maxBufferUsageMB;
          existing.bufferUtilizationPercent = retryProvider.bufferUtilizationPercent;
          existing.activeStreamingSessions = retryProvider.activeStreamingSessions;
          existing.maxRetries = retryProvider.maxRetries;
        }
      });
    }

    // Convert to array and sort by total requests (most constrained first)
    return Array.from(providerMap.values()).sort((a, b) => {
      if (b.totalRequestsInWindow !== a.totalRequestsInWindow) return b.totalRequestsInWindow - a.totalRequestsInWindow;
      if (b.totalRetryAttempts !== a.totalRetryAttempts) return b.totalRetryAttempts - a.totalRetryAttempts;
      return b.currentBufferUsageMB - a.currentBufferUsageMB;
    });
  }, [rateLimiterMetrics?.buckets, retryMetrics?.providers]);

  // Downsample if needed
  const chartData = useMemo(() => {
    return downsampleData(providerData, maxDataPoints);
  }, [providerData, maxDataPoints]);

  const copyToClipboard = async () => {
    try {
      const dataToCopy = chartData.map(({ 
        provider, 
        requestBuckets,
        maxRequests, 
        bufferCapacity, 
        totalRequestsInWindow, 
        totalQueueLength, 
        utilizationPercent,
        nonStreamingRetryAttempts,
        streamingRetryAttempts,
        totalRetryAttempts,
        currentBufferUsageMB,
        maxBufferUsageMB,
        bufferUtilizationPercent,
        activeStreamingSessions,
        maxRetries,
      }) => ({
        provider,
        requestBuckets,
        maxRequests,
        bufferCapacity,
        requestsInWindow: totalRequestsInWindow,
        queueLength: totalQueueLength,
        utilizationPercent,
        nonStreamingRetryAttempts,
        streamingRetryAttempts,
        totalRetryAttempts,
        currentBufferUsageMB,
        maxBufferUsageMB,
        bufferUtilizationPercent,
        activeStreamingSessions,
        maxRetries,
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

  const isDownsampled = chartData.length < providerData.length;

  if (loading) {
    return (
      <div className="w-full flex flex-col items-center justify-center py-12">
        <Loader2 className="h-8 w-8 animate-spin text-primary" />
        <p className="mt-2 text-sm text-muted-foreground">Loading combined metrics...</p>
      </div>
    );
  }

  if (chartData.length === 0) {
    return (
      <div className="rounded-lg border p-8 text-center">
        <p className="text-muted-foreground">No combined metrics data to display</p>
      </div>
    );
  }

  // Find max for counts axis (requests + retries)
  const globalMaxRequests = Math.max(1, Math.max(...chartData.map((d) => d.totalRequestsInWindow)));
  const globalMaxRetries = Math.max(1, Math.max(...chartData.map((d) => d.totalRetryAttempts)));
  const globalMaxCounts = Math.max(globalMaxRequests, globalMaxRetries);
  
  // Find max for buffer axis (MB) - separate scale
  const globalMaxBuffer = Math.max(1, Math.max(...chartData.map((d) => d.maxBufferUsageMB)));

  return (
    <div className="w-full space-y-4">
      {/* Chart Header with Copy Button */}
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
            Showing {chartData.length} of {providerData.length} providers (max-sampled)
          </span>
        )}
      </div>

      <div id="combined-chart-description" className="sr-only">
        Grouped vertical bar chart displaying three metric groups per AI provider:
        1. Request Buckets (blue) — rate limiter usage showing requests used vs maximum capacity, with 70%, 90%, and 100% threshold lines.
        2. Retry Attempts (amber + purple stacked) — non-streaming and streaming retry counts with max retries reference line.
        3. Streaming Retry Buffer Usage (gray background with green overlay) — buffer capacity in MB with 70%, 90%, and 100% threshold lines.
        Each provider shown as a row. Hover or focus any bar for detailed metrics including utilization percentages, queue lengths, and active sessions.
        Color coding: Green = healthy (&lt;70&gt;), Amber = warning (70-89%), Red = critical (90&gt;). Blue represents request usage, purple represents streaming retries.
      </div>

      <div className="max-h-[700px] overflow-y-auto">
        <ResponsiveContainer width="100%" height={Math.min(700, Math.max(400, chartData.length * 60 + 160))}>
          <BarChart
            data={chartData}
            aria-labelledby="combined-chart-description"
            aria-label="Combined Rate Limiter and Retry Metrics Chart"
            role="img"
            layout="vertical"
            margin={{ top: 20, right: 20, bottom: 80, left: 160 }}
          >
            <CartesianGrid strokeDasharray="3 3" stroke="#e5e7eb" vertical={false} />

            {/* X Axis 1 - Counts (Requests + Retries) - Bottom */}
            <XAxis
              xAxisId={0}
              type="number"
              label={{
                value: "Count (Requests / Retries)",
                position: "outsideBottom",
                offset: 40,
                style: { textAnchor: "middle", fill: "#333", fontSize: 12, fontWeight: 500 },
              }}
              tick={{ fill: "#666", fontSize: 11 }}
              tickLine={{ stroke: "#999" }}
              axisLine={{ stroke: "#999" }}
              tickFormatter={(value) => {
                if (value >= 1000000) return formatNumber(value);
                if (value >= 1000) return formatNumber(value);
                return value.toFixed(value < 10 ? 1 : 0);
              }}
              domain={[0, globalMaxCounts * 1.2]}
            />
            
            {/* X Axis 2 - Buffer Usage (MB) - Top */}
            <XAxis
              xAxisId={1}
              type="number"
              label={{
                value: "Buffer Usage (MB)",
                position: "outsideTop",
                offset: 40,
                style: { textAnchor: "middle", fill: "#333", fontSize: 12, fontWeight: 500 },
              }}
              tick={{ fill: "#666", fontSize: 11 }}
              tickLine={{ stroke: "#999" }}
              axisLine={{ stroke: "#999" }}
              tickFormatter={(value) => value.toFixed(1)}
              domain={[0, globalMaxBuffer * 1.2]}
              orientation="top"
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
              formatter={(value: number, name: string, props: { xAxisId?: number } | undefined) => {
                // Format based on the metric name and xAxisId
                const isBufferAxis = props?.xAxisId === 1;
                if (isBufferAxis || name.includes("Buffer")) {
                  return [value.toFixed(1) + " MB", name];
                }
                return [formatNumber(value), name];
              }}
              labelFormatter={(label, payload) => {
                if (payload && payload.length > 0 && payload[0].payload) {
                  const p = payload[0].payload;
                  const parts = [`Provider: ${p.provider}`];
                  
                  // Request buckets info
                  if (p.requestBuckets > 0) {
                    const maxReq = p.maxRequests + p.bufferCapacity;
                    const queueInfo = p.totalQueueLength > 0 ? ` | Queued: ${formatNumber(p.totalQueueLength)}` : "";
                    const utilColor = p.utilizationPercent >= 90 ? "🔴" : p.utilizationPercent >= 70 ? "🟡" : "🟢";
                    parts.push(
                      `Buckets: ${p.requestBuckets} | Used: ${formatNumber(p.totalRequestsInWindow)}/${formatNumber(maxReq)} (${formatPercent(p.utilizationPercent)}% ${utilColor})${queueInfo}`
                    );
                  }
                  
                  // Retry attempts info
                  if (p.totalRetryAttempts > 0) {
                    const retryTotal = p.nonStreamingRetryAttempts + p.streamingRetryAttempts;
                    const retryRatio = p.maxRetries > 0 ? (retryTotal / p.maxRetries * 100).toFixed(1) : "0";
                    const retryColor = parseFloat(retryRatio) >= 90 ? "🔴" : parseFloat(retryRatio) >= 70 ? "🟡" : "🟢";
                    parts.push(
                      `Retries: Non-Stream ${formatNumber(p.nonStreamingRetryAttempts)} + Stream ${formatNumber(p.streamingRetryAttempts)} = ${formatNumber(retryTotal)} / ${p.maxRetries} (${retryRatio}% ${retryColor})`
                    );
                  }
                  
                  // Buffer usage info
                  if (p.maxBufferUsageMB > 0) {
                    const bufUtilColor = p.bufferUtilizationPercent >= 90 ? "🔴" : p.bufferUtilizationPercent >= 70 ? "🟡" : "🟢";
                    parts.push(
                      `Buffer: ${p.currentBufferUsageMB.toFixed(1)}/${p.maxBufferUsageMB.toFixed(1)} MB (${p.bufferUtilizationPercent.toFixed(1)}% ${bufUtilColor}) | Active Sessions: ${p.activeStreamingSessions}`
                    );
                  }
                  
                  return parts.join(" | ");
                }
                return `Provider: ${label}`;
              }}
              contentStyle={{
                backgroundColor: "rgba(255, 255, 255, 0.98)",
                border: "1px solid #ddd",
                borderRadius: "8px",
                boxShadow: "0 4px 12px rgba(0,0,0,0.1)",
                maxWidth: "480px",
                fontSize: "12px",
                lineHeight: "1.5",
              }}
              cursor={{ fill: "rgba(0, 0, 0, 0.05)" }}
            />

            <Legend
              verticalAlign="top"
              align="center"
              iconSize={12}
              wrapperStyle={{ fontSize: 11, fontWeight: 500, marginBottom: 8 }}
            />

            {/* GROUP 1: Request Buckets - Rate Limiter Usage */}
            <Bar
              xAxisId={0}
              dataKey="totalRequestsInWindow"
              name="Request Buckets: Requests Used"
              fill={CHART_COLORS.requestBucketsUsed}
              animationDuration={0}
            />

            {/* GROUP 2: Retry Attempts - Stacked Non-Streaming + Streaming */}
            <Bar
              xAxisId={0}
              dataKey="nonStreamingRetryAttempts"
              name="Retry Attempts: Non-Streaming"
              fill={CHART_COLORS.retryNonStreaming}
              animationDuration={0}
              stackId="retries"
            />
            <Bar
              xAxisId={0}
              dataKey="streamingRetryAttempts"
              name="Retry Attempts: Streaming"
              fill={CHART_COLORS.retryStreaming}
              animationDuration={0}
              stackId="retries"
            />

            {/* GROUP 3: Streaming Retry Buffer Usage - Custom shape with max as background, current as overlay */}
            <Bar
              xAxisId={1}
              dataKey="maxBufferUsageMB"
              name="Buffer Usage: Max Buffer (MB)"
              fill={CHART_COLORS.bufferMax}
              shape={BufferUsageShape}
              animationDuration={0}
            />

            {/* Reference lines for thresholds (counts axis - 70%, 90% of max) */}
            {chartData.map((p, idx) => (
              <React.Fragment key={p.provider}>
                {/* Max requests threshold lines (70%, 90%, max) on counts axis */}
                {p.maxRequests > 0 && (
                  <>
                    <ReferenceLine
                      xAxisId={0}
                      x={Math.round(p.maxRequests * 0.7)}
                      stroke={CHART_COLORS.threshold70}
                      strokeWidth={1}
                      strokeDasharray="4 4"
                      label={
                        <Label
                          value={`70% Max Requests (${Math.round(p.maxRequests * 0.7)})`}
                          position="center"
                          fill={CHART_COLORS.threshold70}
                          fontSize={8}
                          offset={10 + idx * 30}
                        />
                      }
                    />
                    <ReferenceLine
                      xAxisId={0}
                      x={Math.round(p.maxRequests * 0.9)}
                      stroke={CHART_COLORS.threshold90}
                      strokeWidth={1}
                      strokeDasharray="4 4"
                      label={
                        <Label
                          value={`90% Max Requests (${Math.round(p.maxRequests * 0.9)})`}
                          position="center"
                          fill={CHART_COLORS.threshold90}
                          fontSize={8}
                          offset={10 + idx * 30 + 15}
                        />
                      }
                    />
                    <ReferenceLine
                      xAxisId={0}
                      x={p.maxRequests + p.bufferCapacity}
                      stroke={CHART_COLORS.maxRequests}
                      strokeWidth={1}
                      strokeDasharray="6 4"
                      label={
                        <Label
                          value={`Max Requests (${formatNumber(p.maxRequests + p.bufferCapacity)})`}
                          position="center"
                          fill={CHART_COLORS.maxRequests}
                          fontSize={8}
                          fontWeight={600}
                          offset={10 + idx * 30 + 30}
                        />
                      }
                    />
                  </>
                )}
                {/* Max retries reference line on counts axis */}
                {p.maxRetries > 0 && (
                  <ReferenceLine
                    xAxisId={0}
                    x={p.maxRetries}
                    stroke={CHART_COLORS.maxRetries}
                    strokeWidth={1}
                    strokeDasharray="2 2"
                    label={
                      <Label
                        value={`${p.provider}: Max Retries (${p.maxRetries})`}
                        position="center"
                        fill={CHART_COLORS.maxRetries}
                        fontSize={8}
                        offset={10 + idx * 30 + 45}
                      />
                    }
                  />
                )}
                {/* Buffer usage threshold lines (70%, 90%, max) on buffer axis */}
                {p.maxBufferUsageMB > 0 && (
                  <>
                    <ReferenceLine
                      xAxisId={1}
                      x={p.maxBufferUsageMB * 0.7}
                      stroke={CHART_COLORS.threshold70}
                      strokeWidth={1}
                      strokeDasharray="4 4"
                      label={
                        <Label
                          value={`70% Max Buffer (${(p.maxBufferUsageMB * 0.7).toFixed(1)} MB)`}
                          position="center"
                          fill={CHART_COLORS.threshold70}
                          fontSize={8}
                          offset={10 + idx * 30}
                        />
                      }
                    />
                    <ReferenceLine
                      xAxisId={1}
                      x={p.maxBufferUsageMB * 0.9}
                      stroke={CHART_COLORS.threshold90}
                      strokeWidth={1}
                      strokeDasharray="4 4"
                      label={
                        <Label
                          value={`90% Max Buffer (${(p.maxBufferUsageMB * 0.9).toFixed(1)} MB)`}
                          position="center"
                          fill={CHART_COLORS.threshold90}
                          fontSize={8}
                          offset={10 + idx * 30 + 15}
                        />
                      }
                    />
                    <ReferenceLine
                      xAxisId={1}
                      x={p.maxBufferUsageMB}
                      stroke={CHART_COLORS.maxBuffer}
                      strokeWidth={1}
                      strokeDasharray="2 2"
                      label={
                        <Label
                          value={`${p.provider}: Max Buffer (${p.maxBufferUsageMB.toFixed(1)} MB)`}
                          position="center"
                          fill={CHART_COLORS.maxBuffer}
                          fontSize={8}
                          offset={10 + idx * 30 + 30}
                        />
                      }
                    />
                  </>
                )}
              </React.Fragment>
            ))}
          </BarChart>
        </ResponsiveContainer>
      </div>

      {/* Legend */}
      <div className="flex flex-wrap items-center gap-4 text-sm text-muted-foreground" role="list" aria-label="Chart legend">
        <div className="flex items-center gap-2" role="listitem">
          <div className="w-4 h-4 rounded" style={{ background: CHART_COLORS.requestBucketsUsed }} />
          <span>Request Buckets: Requests Used</span>
        </div>
        <div className="flex items-center gap-2" role="listitem">
          <div className="w-4 h-4 rounded" style={{ background: CHART_COLORS.retryNonStreaming }} />
          <span>Retry Attempts: Non-Streaming</span>
        </div>
        <div className="flex items-center gap-2" role="listitem">
          <div className="w-4 h-4 rounded" style={{ background: CHART_COLORS.retryStreaming }} />
          <span>Retry Attempts: Streaming</span>
        </div>
        <div className="flex items-center gap-2" role="listitem">
          <div className="w-8 h-4 rounded" style={{ background: `linear-gradient(90deg, ${CHART_COLORS.bufferMax} 50%, ${CHART_COLORS.bufferCurrent} 50%)` }} />
          <span>Buffer: Max (gray) / Active (green overlay)</span>
        </div>
        <div className="flex items-center gap-1 ml-4" role="listitem">
          <div className="w-4 h-1" style={{ background: CHART_COLORS.threshold70, borderTop: `1px dashed ${CHART_COLORS.threshold70}` }} />
          <span className="text-xs">70% Threshold</span>
        </div>
        <div className="flex items-center gap-1" role="listitem">
          <div className="w-4 h-1" style={{ background: CHART_COLORS.threshold90, borderTop: `1px dashed ${CHART_COLORS.threshold90}` }} />
          <span className="text-xs">90% Threshold</span>
        </div>
        <div className="flex items-center gap-1" role="listitem">
          <div className="w-4 h-1" style={{ background: CHART_COLORS.maxRequests, borderTop: `1px dashed ${CHART_COLORS.maxRequests}` }} />
          <span className="text-xs">Max Requests</span>
        </div>
        <div className="flex items-center gap-1" role="listitem">
          <div className="w-4 h-1" style={{ background: CHART_COLORS.maxRetries, borderTop: `1px dashed ${CHART_COLORS.maxRetries}` }} />
          <span className="text-xs">Max Retries</span>
        </div>
        <div className="flex items-center gap-1" role="listitem">
          <div className="w-4 h-1" style={{ background: CHART_COLORS.maxBuffer, borderTop: `1px dashed ${CHART_COLORS.maxBuffer}` }} />
          <span className="text-xs">Max Buffer</span>
        </div>
      </div>
    </div>
  );
}

export const CombinedRateLimiterRetryChart = memo(CombinedRateLimiterRetryChartComponent, chartDataEqual);