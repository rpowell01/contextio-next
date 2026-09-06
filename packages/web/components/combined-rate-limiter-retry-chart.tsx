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

/**
 * Format a percentage value to maximum 2 decimal places, trimming trailing zeros.
 * e.g., 50 -> "50", 50.5 -> "50.5", 50.555 -> "50.56", 50.50 -> "50.5"
 */
function formatPercent(value: number): string {
  return value.toFixed(2).replace(/\.?0+$/, "");
}

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

  // Find global max for X axis domain - we need to consider all three bar groups
  const globalMaxRequests = Math.max(1, Math.max(...chartData.map((d) => d.totalRequestsInWindow)));
  const globalMaxRetries = Math.max(1, Math.max(...chartData.map((d) => d.totalRetryAttempts)));
  const globalMaxBuffer = Math.max(1, Math.max(...chartData.map((d) => d.maxBufferUsageMB)));
  
  // For grouped bar chart, we need a common scale. Use the max of all three.
  const globalMax = Math.max(globalMaxRequests, globalMaxRetries, globalMaxBuffer);

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
        Grouped vertical bar chart displaying three metric groups per provider:
        Request Buckets (rate limiter usage), Retry Attempts (non-streaming + streaming stacked),
        and Streaming Retry Buffer Usage (max vs active grouped). Hover bars for exact values and provider details.
      </div>

      <div className="max-h-[700px] overflow-y-auto">
        <ResponsiveContainer width="100%" height={Math.min(700, Math.max(400, chartData.length * 60 + 160))}>
          <BarChart
            data={chartData}
            aria-labelledby="combined-chart-description"
            role="img"
            layout="vertical"
            margin={{ top: 20, right: 20, bottom: 80, left: 160 }}
          >
            <CartesianGrid strokeDasharray="3 3" stroke="#e5e7eb" vertical={false} />

            {/* X Axis - Unified numeric scale */}
            <XAxis
              type="number"
              label={{
                value: "Count / MB",
                position: "outsideBottom",
                offset: 100,
                style: { textAnchor: "middle", fill: "#333", fontSize: 12, fontWeight: 500 },
              }}
              tick={{ fill: "#666", fontSize: 11 }}
              tickLine={{ stroke: "#999" }}
              axisLine={{ stroke: "#999" }}
              tickFormatter={(value) => {
                // Format differently based on magnitude
                if (value >= 1000000) return formatNumber(value);
                if (value >= 1000) return formatNumber(value);
                return value.toFixed(value < 10 ? 1 : 0);
              }}
              domain={[0, globalMax * 1.2]}
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
              formatter={(value: number, name: string) => {
                // Format based on the metric name
                if (name.includes("Buffer")) {
                  return [value.toFixed(1) + " MB", name];
                }
                return [formatNumber(value), name];
              }}
              labelFormatter={(label, payload) => {
                if (payload && payload.length > 0 && payload[0].payload) {
                  const p = payload[0].payload;
                  const parts = [`${p.provider}`];
                  
                  // Request buckets info
                  if (p.requestBuckets > 0) {
                    parts.push(
                      `Buckets: ${p.requestBuckets} | Used: ${formatNumber(p.totalRequestsInWindow)}/${formatNumber(p.maxRequests + p.bufferCapacity)} (${formatPercent(p.utilizationPercent)}%)${p.totalQueueLength > 0 ? ` | Queued: ${p.totalQueueLength}` : ""}`
                    );
                  }
                  
                  // Retry attempts info
                  if (p.totalRetryAttempts > 0) {
                    parts.push(
                      `Retries: Non-Stream ${formatNumber(p.nonStreamingRetryAttempts)} + Stream ${formatNumber(p.streamingRetryAttempts)} = ${formatNumber(p.totalRetryAttempts)} (Max: ${p.maxRetries})`
                    );
                  }
                  
                  // Buffer usage info
                  if (p.maxBufferUsageMB > 0) {
                    parts.push(
                      `Buffer: ${p.currentBufferUsageMB.toFixed(1)}/${p.maxBufferUsageMB.toFixed(1)} MB (${p.bufferUtilizationPercent.toFixed(1)}%) | Sessions: ${p.activeStreamingSessions}`
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
                maxWidth: "400px",
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
              dataKey="totalRequestsInWindow"
              name="Request Buckets: Requests Used"
              fill="#3b82f6" // Blue for requests
              animationDuration={0}
            />

            {/* GROUP 2: Retry Attempts - Stacked Non-Streaming + Streaming */}
            <Bar
              dataKey="nonStreamingRetryAttempts"
              name="Retry Attempts: Non-Streaming"
              fill="#f59e0b" // Amber for non-streaming
              animationDuration={0}
              stackId="retries"
            />
            <Bar
              dataKey="streamingRetryAttempts"
              name="Retry Attempts: Streaming"
              fill="#8b5cf6" // Purple for streaming (distinct from Request Buckets blue)
              animationDuration={0}
              stackId="retries"
            />

            {/* GROUP 3: Streaming Retry Buffer Usage - Grouped bars (not stacked) */}
            <Bar
              dataKey="maxBufferUsageMB"
              name="Buffer Usage: Max Buffer (MB)"
              fill="#d1d5db" // Light gray for max
              animationDuration={0}
              stackId="buffer-max"
            />
            <Bar
              dataKey="currentBufferUsageMB"
              name="Buffer Usage: Active Buffer (MB)"
              fill="#10b981" // Green for active buffer
              opacity={0.9}
              animationDuration={0}
              stackId="buffer-current"
            />

            {/* Reference lines for max retries and max buffer */}
            {chartData.map((p, idx) => (
              <React.Fragment key={p.provider}>
                {p.maxRetries > 0 && (
                  <ReferenceLine
                    x={p.maxRetries}
                    stroke="#f59e0b"
                    strokeWidth={1}
                    strokeDasharray="2 2"
                    label={
                      <Label
                        value={`${p.provider}: Max Retries (${p.maxRetries})`}
                        position="center"
                        fill="#f59e0b"
                        fontSize={8}
                        offset={10 + idx * 25}
                      />
                    }
                  />
                )}
                {p.maxBufferUsageMB > 0 && (
                  <ReferenceLine
                    x={p.maxBufferUsageMB}
                    stroke="#6b7280"
                    strokeWidth={1}
                    strokeDasharray="2 2"
                    label={
                      <Label
                        value={`${p.provider}: Max Buffer (${p.maxBufferUsageMB.toFixed(1)} MB)`}
                        position="center"
                        fill="#6b7280"
                        fontSize={8}
                        offset={10 + idx * 25 + (p.maxRetries > 0 ? 15 : 0)}
                      />
                    }
                  />
                )}
              </React.Fragment>
            ))}
          </BarChart>
        </ResponsiveContainer>
      </div>

      {/* Legend */}
      <div className="flex flex-wrap items-center gap-4 text-sm text-muted-foreground">
        <div className="flex items-center gap-2">
          <div className="w-4 h-4 rounded" style={{ background: "#3b82f6" }} />
          <span>Request Buckets: Used</span>
        </div>
        <div className="flex items-center gap-2">
          <div className="w-4 h-4 rounded" style={{ background: "#f59e0b" }} />
          <span>Retry Attempts: Non-Streaming</span>
        </div>
        <div className="flex items-center gap-2">
          <div className="w-4 h-4 rounded" style={{ background: "#8b5cf6" }} />
          <span>Retry Attempts: Streaming</span>
        </div>
        <div className="flex items-center gap-2">
          <div className="w-4 h-4 rounded" style={{ background: "#d1d5db" }} />
          <span>Buffer: Max</span>
        </div>
        <div className="flex items-center gap-2">
          <div className="w-4 h-4 rounded" style={{ background: "#10b981" }} />
          <span>Buffer: Active</span>
        </div>
        <div className="flex items-center gap-1 ml-4">
          <div className="w-4 h-1" style={{ background: "#f59e0b", borderTop: "1px dashed #f59e0b" }} />
          <span className="text-xs">Max Retries</span>
        </div>
        <div className="flex items-center gap-1">
          <div className="w-4 h-1" style={{ background: "#6b7280", borderTop: "1px dashed #6b7280" }} />
          <span className="text-xs">Max Buffer</span>
        </div>
      </div>
    </div>
  );
}

export const CombinedRateLimiterRetryChart = memo(CombinedRateLimiterRetryChartComponent, chartDataEqual);