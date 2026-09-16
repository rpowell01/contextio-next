"use client";

import React, { memo, useMemo, useState, useRef, useEffect } from "react";
import { formatNumber } from "@/lib/utils";
import type { RateLimiterMetrics, RetryMetrics, RetryProviderMetrics, TokensPerSecondMetrics, TokensPerSecondProviderMetrics } from "@/types/client-api";
import {
  BarChart,
  Bar,
  XAxis,
  YAxis,
  CartesianGrid,
  ResponsiveContainer,
  Tooltip,
  ReferenceLine,
  Label,
} from "recharts";
import { Copy, Loader2 } from "lucide-react";

/**
 * Custom tooltip content that renders each metric group on its own line
 * to prevent overflow from combining multiple metrics on the first line.
 */
function CustomTooltipContent({ active, payload }: { active?: boolean; payload?: Array<{ payload: ProviderData; name: string; value: number; color: string }> }) {
  if (!active || !payload || payload.length === 0) return null;

  const p = payload[0].payload;
  const parts: React.ReactNode[] = [];

  // Provider name header
  parts.push(
    <div key="provider" style={{ fontWeight: 600, marginBottom: 4, color: "rgb(var(--color-popover-foreground))" }}>
      Provider: {p.provider}
    </div>
  );

  // Request buckets info
  if (p.requestBuckets > 0) {
    const maxReq = p.maxRequests + p.bufferCapacity;
    const queueInfo = p.totalQueueLength > 0 ? ` | Queued: ${formatNumber(p.totalQueueLength)}` : "";
    const utilColor = p.utilizationPercent >= 90 ? "🔴" : p.utilizationPercent >= 70 ? "🟡" : "🟢";
    parts.push(
      <div key="buckets" style={{ marginBottom: 2, fontSize: "11px", color: "rgb(var(--color-popover-foreground))" }}>
        Rate Limiter Requests Used: {formatNumber(p.totalRequestsInWindow)}/{formatNumber(maxReq)} ({formatPercent(p.utilizationPercent)}% {utilColor}){queueInfo}
      </div>
    );
  }

  // Retry attempts info
  if (p.totalRetryAttempts > 0) {
    const retryTotal = p.nonStreamingRetryAttempts + p.streamingRetryAttempts;
    const retryRatio = p.maxRetries > 0 ? (retryTotal / p.maxRetries * 100).toFixed(1) : "0";
    const retryColor = parseFloat(retryRatio) >= 90 ? "🔴" : parseFloat(retryRatio) >= 70 ? "🟡" : "🟢";
    parts.push(
      <div key="retries" style={{ marginBottom: 2, fontSize: "11px", color: "rgb(var(--color-popover-foreground))" }}>
        Retries: Non-Stream {formatNumber(p.nonStreamingRetryAttempts)} + Stream {formatNumber(p.streamingRetryAttempts)} = {formatNumber(retryTotal)} / {p.maxRetries} ({retryRatio}% {retryColor})
      </div>
    );
  }

  // Tokens per second info
  if (p.avgTokensPerSecond !== undefined && p.avgTokensPerSecond > 0) {
    const modelInfo = p.model ? ` (${p.model})` : "";
    parts.push(
      <div key="tokensPerSecond" style={{ marginBottom: 2, fontSize: "11px", color: "rgb(var(--color-popover-foreground))" }}>
        Avg Tokens/sec{modelInfo}: {formatNumber(p.avgTokensPerSecond)}
      </div>
    );
  }

  return (
    <div
      style={{
        backgroundColor: "rgb(var(--color-popover))",
        border: "1px solid rgb(var(--color-border))",
        borderRadius: "8px",
        boxShadow: "0 4px 12px rgba(0,0,0,0.1)",
        padding: "8px 12px",
        maxWidth: "480px",
        fontSize: "12px",
        lineHeight: "1.5",
        color: "rgb(var(--color-popover-foreground))",
      }}
    >
      {parts}
    </div>
  );
}

interface CombinedRateLimiterRetryChartProps {
  rateLimiterMetrics: RateLimiterMetrics | null;
  retryMetrics: RetryMetrics | null;
  tokensPerSecondMetrics?: TokensPerSecondMetrics | null;
  loading?: boolean;
  maxDataPoints?: number;
}

interface ProviderData {
  provider: string;
  // Request Buckets (from rate limiter)
  requestBuckets: number;
  maxRequests: number;
  bufferCapacity: number;
  totalMaxRequests: number; // maxRequests + bufferCapacity (total capacity)
  totalRequestsInWindow: number;
  totalQueueLength: number;
  utilizationPercent: number; // totalRequestsInWindow / totalMaxRequests * 100
  // Retry Attempts (from retry metrics)
  nonStreamingRetryAttempts: number;
  streamingRetryAttempts: number;
  totalRetryAttempts: number;
  activeStreamingSessions: number;
  maxRetries: number;
  // Tokens Per Second (from redaction metadata)
  avgTokensPerSecond?: number;
  model?: string; // Optional model name when tracking by provider+model
}

// Color constants for consistent theming across charts
const CHART_COLORS = {
  // Request buckets
  requestBucketsUsed: "#3b82f6",        // Blue
  requestBucketsQueue: "#60a5fa",       // Light blue for queue
  // Retry attempts
  retryNonStreaming: "#f59e0b",         // Amber
  retryStreaming: "#8b5cf6",            // Purple (distinct from blue)
  // Tokens per second
  tokensPerSecond: "#10b981",           // Emerald green
  // Reference lines
  threshold70: "#fbbf24",               // Amber for 70%
  threshold90: "#ef4444",               // Red for 90%
  maxRetries: "#f59e0b",                // Amber for max retries
  maxRequests: "#6b7280",               // Gray for max requests
} as const;

/**
 * Format a percentage value to maximum 2 decimal places, trimming trailing zeros.
 * e.g., 50 -> "50", 50.5 -> "50.5", 50.555 -> "50.56", 50.50 -> "50.5"
 */
function formatPercent(value: number): string {
  return value.toFixed(2).replace(/\.?0+$/, "");
}

/**
 * Custom shape for request buckets bar - renders max requests as background
 * and current usage as a blue overlay capped at max.
 * Accepts the full Bar props from recharts (including payload).
 */
const RequestBucketsShape = (props: any) => {
  const { x, y, width, height, payload } = props;
  const data = payload;
  // Validate all required numeric props
  if (!data || typeof x !== 'number' || typeof y !== 'number' || typeof width !== 'number' || typeof height !== 'number' ||
      !isFinite(x) || !isFinite(y) || !isFinite(width) || !isFinite(height)) return <g />;

  const maxRequests = data.totalMaxRequests ?? 0;
  const currentRequests = data.totalRequestsInWindow ?? 0;
  const utilizationPercent = data.utilizationPercent ?? 0;

  if (maxRequests === 0) return <g />;

  // Current usage cannot exceed max - cap it visually
  const cappedCurrent = Math.min(currentRequests, maxRequests);
  const usageRatio = cappedCurrent / maxRequests;
  const usageWidth = usageRatio * width;

  return (
    <g>
      {/* Max requests background - gray */}
      <rect
        x={x}
        y={y}
        width={width}
        height={height}
        fill={CHART_COLORS.maxRequests}
        stroke="rgb(var(--color-border))"
        strokeWidth={0.5}
      />
      {/* Current usage overlay - blue, capped at max */}
      {cappedCurrent > 0 && (
        <rect
          x={x}
          y={y}
          width={Math.min(usageWidth, width)}
          height={height}
          fill={CHART_COLORS.requestBucketsUsed}
          opacity={0.9}
        />
      )}
      {/* Utilization percentage label at end of max bar */}
      {utilizationPercent > 0 && (
        <text
          x={x + width + 8}
          y={y + height / 2 + 4}
          fill="rgb(var(--color-text-muted))"
          fontSize={10}
          fontWeight={500}
          dominantBaseline="middle"
        >
          {utilizationPercent.toFixed(1)}%
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
  tokensPerSecondMetrics,
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
        const bufferCapacity = bucket.bufferCapacity;
        const totalMaxRequests = bucket.maxTokens; // maxRequests + bufferCapacity
        const requestsInWindow = bucket.requestsInWindow ?? 0;

        const existing = providerMap.get(provider);
        if (!existing) {
          providerMap.set(provider, {
            provider,
            requestBuckets: 1,
            maxRequests,
            bufferCapacity,
            totalMaxRequests,
            totalRequestsInWindow: requestsInWindow,
            totalQueueLength: bucket.queueLength,
            utilizationPercent: totalMaxRequests > 0 ? Math.round((requestsInWindow / totalMaxRequests) * 10000) / 100 : 0,
            // Retry fields - will be filled from retry metrics
            nonStreamingRetryAttempts: 0,
            streamingRetryAttempts: 0,
            totalRetryAttempts: 0,
            activeStreamingSessions: 0,
            maxRetries: 0,
          });
        } else {
          existing.requestBuckets += 1;
          existing.maxRequests += maxRequests;
          existing.bufferCapacity += bufferCapacity;
          existing.totalMaxRequests += totalMaxRequests;
          existing.totalRequestsInWindow += requestsInWindow;
          existing.totalQueueLength += bucket.queueLength;
          existing.utilizationPercent = existing.totalMaxRequests > 0
            ? Math.round((existing.totalRequestsInWindow / existing.totalMaxRequests) * 10000) / 100
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
            totalMaxRequests: 0,
            totalRequestsInWindow: 0,
            totalQueueLength: 0,
            utilizationPercent: 0,
            nonStreamingRetryAttempts: retryProvider.nonStreamingRetryAttempts,
            streamingRetryAttempts: retryProvider.streamingRetryAttempts,
            totalRetryAttempts: retryProvider.totalRetryAttempts,
            activeStreamingSessions: retryProvider.activeStreamingSessions,
            maxRetries: retryProvider.maxRetries,
          });
        } else {
          // Merge retry data
          existing.nonStreamingRetryAttempts = retryProvider.nonStreamingRetryAttempts;
          existing.streamingRetryAttempts = retryProvider.streamingRetryAttempts;
          existing.totalRetryAttempts = retryProvider.totalRetryAttempts;
          existing.activeStreamingSessions = retryProvider.activeStreamingSessions;
          existing.maxRetries = retryProvider.maxRetries;
        }
      });
    }

    // Finally, merge tokens per second metrics
    if (tokensPerSecondMetrics?.byProviderAndModel) {
      tokensPerSecondMetrics.byProviderAndModel.forEach((tpsProvider: TokensPerSecondProviderMetrics) => {
        // Create a composite key for provider+model to allow multiple models per provider
        const key = tpsProvider.model ? `${tpsProvider.provider}:${tpsProvider.model}` : tpsProvider.provider;
        const existing = providerMap.get(key);
        
        if (!existing) {
          // Provider+model only exists in tokens per second metrics
          providerMap.set(key, {
            provider: key,
            requestBuckets: 0,
            maxRequests: 0,
            bufferCapacity: 0,
            totalMaxRequests: 0,
            totalRequestsInWindow: 0,
            totalQueueLength: 0,
            utilizationPercent: 0,
            nonStreamingRetryAttempts: 0,
            streamingRetryAttempts: 0,
            totalRetryAttempts: 0,
            activeStreamingSessions: 0,
            maxRetries: 0,
            avgTokensPerSecond: tpsProvider.avgTokensPerSecond,
            model: tpsProvider.model,
          });
        } else {
          // Merge tokens per second data
          existing.avgTokensPerSecond = tpsProvider.avgTokensPerSecond;
          existing.model = tpsProvider.model;
        }
      });
    }

    // Convert to array and sort by total requests (most constrained first)
    return Array.from(providerMap.values()).sort((a, b) => {
      if (b.totalRequestsInWindow !== a.totalRequestsInWindow) return b.totalRequestsInWindow - a.totalRequestsInWindow;
      return b.totalRetryAttempts - a.totalRetryAttempts;
    });
  }, [rateLimiterMetrics?.buckets, retryMetrics?.providers, tokensPerSecondMetrics?.byProviderAndModel]);

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
  // Use Number.isFinite to avoid NaN propagation (Math.max(1, NaN) === NaN)
  const globalMaxRequests = Math.max(1, ...chartData.map((d) => (Number.isFinite(d.totalRequestsInWindow) ? d.totalRequestsInWindow : 0)));
  const globalMaxTotalRequests = Math.max(1, ...chartData.map((d) => (Number.isFinite(d.totalMaxRequests) ? d.totalMaxRequests : 0)));
  const globalMaxRetries = Math.max(1, ...chartData.map((d) => (Number.isFinite(d.totalRetryAttempts) ? d.totalRetryAttempts : 0)));
  const globalMaxCounts = Math.max(globalMaxRequests, globalMaxTotalRequests, globalMaxRetries);

  // Find max for tokens per second axis
  const globalMaxTokensPerSecond = Math.max(1, Math.max(...chartData.map((d) => d.avgTokensPerSecond ?? 0)));

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
        1. Request Buckets (blue) \u2014 rate limiter usage showing requests used vs maximum capacity, with 70%, 90%, and 100% threshold lines.
        2. Retry Attempts (amber + purple stacked) \u2014 non-streaming and streaming retry counts with max retries reference line.
        3. Average Tokens/sec (emerald) \u2014 average token generation speed per provider/model.
        Each provider shown as a row. Hover or focus any bar for detailed metrics including utilization percentages, queue lengths, active sessions, and tokens/sec.
        Color coding: Green = healthy (less than 70%), Amber = warning (70-89%), Red = critical (greater than 90%). Blue represents request usage, purple represents streaming retries, emerald represents tokens/sec.
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
            <CartesianGrid strokeDasharray="3 3" stroke="rgb(var(--color-border))" vertical={false} />

            {/* Single X Axis - Counts (Requests + Retries) - Top */}
            <XAxis
              xAxisId="counts"
              type="number"
              label={{
                value: "Count (Requests / Retries)",
                position: "outsideTop",
                offset: 40,
                style: { textAnchor: "middle", fill: "rgb(var(--color-text))", fontSize: 12, fontWeight: 500 },
              }}
              tick={{ fill: "rgb(var(--color-text-muted))", fontSize: 11 }}
              tickLine={{ stroke: "rgb(var(--color-border))" }}
              axisLine={{ stroke: "rgb(var(--color-border))" }}
              tickFormatter={(value) => {
                if (value >= 1000000) return formatNumber(value);
                if (value >= 1000) return formatNumber(value);
                return value.toFixed(value < 10 ? 1 : 0);
              }}
              domain={[0, globalMaxCounts * 1.2]}
              orientation="top"
            />

            {/* Second X Axis - Tokens Per Second - Bottom */}
            <XAxis
              xAxisId="tokensPerSecond"
              type="number"
              label={{
                value: "Avg Tokens/sec",
                position: "outsideBottom",
                offset: 40,
                style: { textAnchor: "middle", fill: "rgb(var(--color-text))", fontSize: 12, fontWeight: 500 },
              }}
              tick={{ fill: "rgb(var(--color-text-muted))", fontSize: 11 }}
              tickLine={{ stroke: "rgb(var(--color-border))" }}
              axisLine={{ stroke: "rgb(var(--color-border))" }}
              tickFormatter={(value) => {
                if (value >= 1000000) return formatNumber(value);
                if (value >= 1000) return formatNumber(value);
                return value.toFixed(value < 10 ? 1 : 0);
              }}
              domain={[0, globalMaxTokensPerSecond * 1.2]}
              orientation="bottom"
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
                style: { textAnchor: "middle", fill: "rgb(var(--color-text))", fontSize: 12, fontWeight: 500 },
              }}
              tick={{ fill: "rgb(var(--color-text))", fontSize: 11 }}
              tickLine={{ stroke: "rgb(var(--color-border))" }}
              axisLine={{ stroke: "rgb(var(--color-border))" }}
            />

            <Tooltip
              content={<CustomTooltipContent />}
              cursor={{ fill: "rgb(var(--color-border) / 0.1)" }}
            />

            {/* GROUP 1: Request Buckets - Rate Limiter Usage (renders first/top) */}
            <Bar
              dataKey="totalMaxRequests"
              name="Request Buckets: Max (gray) / Used (blue overlay)"
              shape={RequestBucketsShape}
              animationDuration={0}
            />

            {/* GROUP 2: Retry Attempts - Stacked Non-Streaming + Streaming */}
            <Bar
              dataKey="nonStreamingRetryAttempts"
              name="Retry Attempts: Non-Streaming"
              fill={CHART_COLORS.retryNonStreaming}
              animationDuration={0}
              stackId="retries"
            />
            <Bar
              dataKey="streamingRetryAttempts"
              name="Retry Attempts: Streaming"
              fill={CHART_COLORS.retryStreaming}
              animationDuration={0}
              stackId="retries"
            />

            {/* GROUP 3: Tokens Per Second (Avg) - Emerald green */}
            <Bar
              xAxisId="tokensPerSecond"
              dataKey="avgTokensPerSecond"
              name="Avg Tokens/sec"
              fill={CHART_COLORS.tokensPerSecond}
              animationDuration={0}
            />

            {/* Reference lines for thresholds */}
            {chartData.map((p, idx) => (
              <React.Fragment key={p.provider}>
                {/* Max requests threshold lines (70%, 90%, max) */}
                {p.maxRequests > 0 && (
                  <>
                    <ReferenceLine
                      x={Math.round((p.maxRequests + p.bufferCapacity) * 0.7)}
                      stroke={CHART_COLORS.threshold70}
                      strokeWidth={1}
                      strokeDasharray="4 4"
                      label={
                        <Label
                          value={`70% Max Requests (${Math.round((p.maxRequests + p.bufferCapacity) * 0.7)})`}
                          position="center"
                          fill={CHART_COLORS.threshold70}
                          fontSize={8}
                          offset={10 + idx * 30}
                        />
                      }
                    />
                    <ReferenceLine
                      x={Math.round((p.maxRequests + p.bufferCapacity) * 0.9)}
                      stroke={CHART_COLORS.threshold90}
                      strokeWidth={1}
                      strokeDasharray="4 4"
                      label={
                        <Label
                          value={`90% Max Requests (${Math.round((p.maxRequests + p.bufferCapacity) * 0.9)})`}
                          position="center"
                          fill={CHART_COLORS.threshold90}
                          fontSize={8}
                          offset={10 + idx * 30 + 15}
                        />
                      }
                    />
                    <ReferenceLine
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
                {/* Max retries reference line */}
                {p.maxRetries > 0 && (
                  <ReferenceLine
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
              </React.Fragment>
            ))}
          </BarChart>
        </ResponsiveContainer>
      </div>

      {/* Legend */}
      <div className="flex flex-wrap items-center gap-4 text-sm text-muted-foreground" role="list" aria-label="Chart legend">
        <div className="flex items-center gap-2" role="listitem">
          <div className="w-8 h-4 rounded" style={{ background: `linear-gradient(90deg, ${CHART_COLORS.maxRequests} 50%, ${CHART_COLORS.requestBucketsUsed} 50%)` }} />
          <span>Request Buckets: Max (gray) / Used (blue overlay)</span>
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
          <div className="w-4 h-4 rounded" style={{ background: CHART_COLORS.tokensPerSecond }} />
          <span>Avg Tokens/sec</span>
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
      </div>
    </div>
  );
}

export const CombinedRateLimiterRetryChart = memo(CombinedRateLimiterRetryChartComponent, chartDataEqual);