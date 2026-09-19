"use client";

import React, { memo, useMemo, useState, useRef, useEffect } from "react";
import { formatNumber } from "@/lib/utils";
import type { RateLimiterMetrics, RetryMetrics, RetryProviderMetrics, TokensPerSecondMetrics, TokensPerSecondProviderMetrics, TtftMetrics, TtftByProviderAndModel } from "@/types/client-api";
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
  LabelList,
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

  // Session header
  if (p.sessionId && p.sessionId !== "all") {
    parts.push(
      <div key="session" style={{ fontWeight: 600, marginBottom: 4, color: "rgb(var(--color-primary))", fontSize: "12px" }}>
        📊 Session: {p.sessionId.slice(0, 20)}{p.sessionId.length > 20 ? "..." : ""}
      </div>
    );
  }

  // Provider name header
  parts.push(
    <div key="provider" style={{ fontWeight: 600, marginBottom: 4, color: "rgb(var(--color-popover-foreground))" }}>
      Provider: {p.provider}{p.model ? ` (${p.model})` : ""}
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

  // TTFT info
  if (p.avgTtftMs !== undefined && p.avgTtftMs > 0) {
    const modelInfo = p.model ? ` (${p.model})` : "";
    parts.push(
      <div key="ttft" style={{ marginBottom: 2, fontSize: "11px", color: "rgb(var(--color-popover-foreground))" }}>
        Avg TTFT{modelInfo}: {((p.avgTtftMs ?? 0) / 1000).toFixed(3)}s
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
  ttftMetrics?: TtftMetrics | null;
  loading?: boolean;
  maxDataPoints?: number;
  activeSessionIds?: string[]; // Active session IDs for grouping
}

interface ProviderData {
  provider: string;
  // Session ID for grouping
  sessionId?: string;
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
  // TTFT (Time to First Token) (from redaction metadata)
  avgTtftMs?: number;
  ttftTotalCaptures?: number;
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
  ttft: "#06b6d4", // Cyan/teal for TTFT (distinct from other chart bars)
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
  if (prevProps.activeSessionIds !== nextProps.activeSessionIds) {
    // Compare arrays
    const prevSessions = prevProps.activeSessionIds || [];
    const nextSessions = nextProps.activeSessionIds || [];
    if (prevSessions.length !== nextSessions.length) return false;
    for (let i = 0; i < prevSessions.length; i++) {
      if (prevSessions[i] !== nextSessions[i]) return false;
    }
  }

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
  if (JSON.stringify(prevProps.tokensPerSecondMetrics) !== JSON.stringify(nextProps.tokensPerSecondMetrics)) return false;
  if (JSON.stringify(prevProps.ttftMetrics) !== JSON.stringify(nextProps.ttftMetrics)) return false;

  return true;
}

function CombinedRateLimiterRetryChartComponent({
  rateLimiterMetrics,
  retryMetrics,
  tokensPerSecondMetrics,
  ttftMetrics,
  loading = false,
  maxDataPoints = 50,
  activeSessionIds = [],
}: CombinedRateLimiterRetryChartProps) {
  const [copied, setCopied] = useState(false);
  const copyTimeoutRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const renderCountRef = useRef(0);
  renderCountRef.current++;

  // Debug: log render count and data changes
  const prevTokensPerSecondRef = useRef(tokensPerSecondMetrics);
  const prevTtftRef = useRef(ttftMetrics);
  if (prevTokensPerSecondRef.current !== tokensPerSecondMetrics) {
    console.log('[CombinedChart] tokensPerSecondMetrics changed', {
      renderCount: renderCountRef.current,
      prevTimestamp: prevTokensPerSecondRef.current?.timestamp,
      newTimestamp: tokensPerSecondMetrics?.timestamp,
      prevByProviderAndModelLength: prevTokensPerSecondRef.current?.byProviderAndModel?.length,
      newByProviderAndModelLength: tokensPerSecondMetrics?.byProviderAndModel?.length,
    });
    prevTokensPerSecondRef.current = tokensPerSecondMetrics;
  }
  if (prevTtftRef.current !== ttftMetrics) {
    console.log('[CombinedChart] ttftMetrics changed', {
      renderCount: renderCountRef.current,
      prevTimestamp: prevTtftRef.current?.timestamp,
      newTimestamp: ttftMetrics?.timestamp,
      prevByProviderAndModelLength: prevTtftRef.current?.byProviderAndModel?.length,
      newByProviderAndModelLength: ttftMetrics?.byProviderAndModel?.length,
    });
    prevTtftRef.current = ttftMetrics;
  }

  // Build session-grouped data: group by session first, then by provider/model
  const providerData = useMemo((): ProviderData[] => {
// Get active session IDs - from prop or extract from rate limiter buckets
    const sessionIds = activeSessionIds.length > 0
      ? activeSessionIds
      : Array.from(new Set(
          rateLimiterMetrics?.buckets
            ?.map(b => b.sessionId)
            .filter((s): s is string => Boolean(s)) || []
        ));

    // Check if we have global metrics that need an "all" session
    const hasGlobalMetrics = 
      (retryMetrics?.providers?.length ?? 0) > 0 ||
      (tokensPerSecondMetrics?.byProviderAndModel?.length ?? 0) > 0 ||
      (ttftMetrics?.byProviderAndModel?.length ?? 0) > 0;

    // If no sessions found, fall back to "all" (shared buckets)
    // Also include "all" if we have global metrics to display
    const sessions = sessionIds.length > 0 
      ? (hasGlobalMetrics ? [...sessionIds, "all"] : sessionIds)
      : ["all"];
    
    // Build a map of session -> provider/model -> ProviderData
    const sessionProviderMap = new Map<string, Map<string, ProviderData>>();
    
    // Initialize maps for each session
    sessions.forEach(sessionId => {
      sessionProviderMap.set(sessionId, new Map());
    });

    // Helper to get or create ProviderData for a session/provider/model combination
    const getOrCreateProviderData = (sessionId: string, provider: string, model?: string) => {
      const sessionMap = sessionProviderMap.get(sessionId)!;
      const key = model ? `${provider}:${model}` : provider;
      let existing = sessionMap.get(key);
      if (!existing) {
        existing = {
          provider,
          sessionId,
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
          model,
        };
        sessionMap.set(key, existing);
      }
      return existing;
    };

    // First, process rate limiter buckets - group by session
    if (rateLimiterMetrics?.buckets) {
      rateLimiterMetrics.buckets.forEach((bucket) => {
        const provider = bucket.provider ?? "unknown";
        const sessionId = bucket.sessionId ?? "all";
        const maxRequests = bucket.maxTokens - bucket.bufferCapacity;
        const bufferCapacity = bucket.bufferCapacity;
        const totalMaxRequests = bucket.maxTokens; // maxRequests + bufferCapacity
        const requestsInWindow = bucket.requestsInWindow ?? 0;

        const data = getOrCreateProviderData(sessionId, provider);
        data.requestBuckets += 1;
        data.maxRequests += maxRequests;
        data.bufferCapacity += bufferCapacity;
        data.totalMaxRequests += totalMaxRequests;
        data.totalRequestsInWindow += requestsInWindow;
        data.totalQueueLength += bucket.queueLength;
        data.utilizationPercent = data.totalMaxRequests > 0
          ? Math.round((data.totalRequestsInWindow / data.totalMaxRequests) * 10000) / 100
          : 0;
      });
    }

    // Then, merge retry metrics - these are aggregated per provider (not per session)
    // Assign to "all" session (global) since they don't have session breakdown
    if (retryMetrics?.providers) {
      const sessionMap = sessionProviderMap.get("all");
      if (sessionMap) {
        retryMetrics.providers.forEach((retryProvider: RetryProviderMetrics) => {
          const provider = retryProvider.provider;
          const key = provider; // retry metrics don't have model breakdown
          let existing = sessionMap.get(key);
          if (!existing) {
            existing = getOrCreateProviderData("all", provider);
          }
          existing.nonStreamingRetryAttempts = retryProvider.nonStreamingRetryAttempts;
          existing.streamingRetryAttempts = retryProvider.streamingRetryAttempts;
          existing.totalRetryAttempts = retryProvider.totalRetryAttempts;
          existing.activeStreamingSessions = retryProvider.activeStreamingSessions;
          existing.maxRetries = retryProvider.maxRetries;
        });
      }
    }

    // Finally, merge tokens per second metrics - per provider and model (aggregated across active sessions)
    // Assign to "all" session (global) only if not already present in a session-specific map
    if (tokensPerSecondMetrics?.byProviderAndModel) {
      const sessionMap = sessionProviderMap.get("all");
      if (sessionMap) {
        // Get session-specific maps (excluding "all")
        const sessionMaps = Array.from(sessionProviderMap.entries())
          .filter(([sessionId]) => sessionId !== "all")
          .map(([, sMap]) => sMap);
        
        tokensPerSecondMetrics.byProviderAndModel.forEach((tpsProvider: TokensPerSecondProviderMetrics) => {
          const provider = tpsProvider.provider;
          const model = tpsProvider.model;
          const fullKey = model ? `${provider}:${model}` : provider;
          const providerOnlyKey = provider;
          
          // Check if this provider/model already exists in any session-specific map
          // First try full key (provider:model), then fall back to provider-only key
          // since rate limiter buckets don't have model information
          let foundInSession = false;
          for (const sMap of sessionMaps) {
            if (sMap.has(fullKey) || sMap.has(providerOnlyKey)) {
              // Update existing entry in session-specific map
              const existingKey = sMap.has(fullKey) ? fullKey : providerOnlyKey;
              const existing = sMap.get(existingKey)!;
              existing.avgTokensPerSecond = tpsProvider.avgTokensPerSecond;
              existing.model = model;
              foundInSession = true;
              break;
            }
          }
          
          // Only add to "all" if not found in any session-specific map
          if (!foundInSession) {
            let existing = sessionMap.get(fullKey);
            if (!existing) {
              existing = getOrCreateProviderData("all", provider, model);
            }
            existing.avgTokensPerSecond = tpsProvider.avgTokensPerSecond;
            existing.model = model;
          }
        });
      }
    }

    // Finally, merge TTFT metrics - per provider and model (aggregated across active sessions)
    // Assign to "all" session (global) only if not already present in a session-specific map
    if (ttftMetrics?.byProviderAndModel) {
      const sessionMap = sessionProviderMap.get("all");
      if (sessionMap) {
        // Get session-specific maps (excluding "all")
        const sessionMaps = Array.from(sessionProviderMap.entries())
          .filter(([sessionId]) => sessionId !== "all")
          .map(([, sMap]) => sMap);
        
        ttftMetrics.byProviderAndModel.forEach((ttftProvider: TtftByProviderAndModel) => {
          const provider = ttftProvider.provider;
          const model = ttftProvider.model;
          const fullKey = model ? `${provider}:${model}` : provider;
          const providerOnlyKey = provider;
          
          // Check if this provider/model already exists in any session-specific map
          // First try full key (provider:model), then fall back to provider-only key
          // since rate limiter buckets don't have model information
          let foundInSession = false;
          for (const sMap of sessionMaps) {
            if (sMap.has(fullKey) || sMap.has(providerOnlyKey)) {
              // Update existing entry in session-specific map
              const existingKey = sMap.has(fullKey) ? fullKey : providerOnlyKey;
              const existing = sMap.get(existingKey)!;
              existing.avgTtftMs = ttftProvider.avgTtftMs;
              existing.ttftTotalCaptures = ttftProvider.totalCaptures;
              existing.model = model;
              foundInSession = true;
              break;
            }
          }
          
          // Only add to "all" if not found in any session-specific map
          if (!foundInSession) {
            let existing = sessionMap.get(fullKey);
            if (!existing) {
              existing = getOrCreateProviderData("all", provider, model);
            }
            existing.avgTtftMs = ttftProvider.avgTtftMs;
            existing.ttftTotalCaptures = ttftProvider.totalCaptures;
            existing.model = model;
          }
        });
      }
    }

    // Convert to flat array with session grouping
    // Sort sessions first, then within each session sort by provider/model
    const result: ProviderData[] = [];
    sessions.forEach((sessionId, sessionIndex) => {
      const sessionMap = sessionProviderMap.get(sessionId);
      if (!sessionMap) return;
      
      const sessionEntries = Array.from(sessionMap.values());
      // Sort by total requests (most constrained first), then by provider name
      sessionEntries.sort((a, b) => {
        if (b.totalRequestsInWindow !== a.totalRequestsInWindow) return b.totalRequestsInWindow - a.totalRequestsInWindow;
        return b.totalRetryAttempts - a.totalRetryAttempts;
      });
      
      // Add session index for rendering separators
      sessionEntries.forEach(entry => {
        (entry as any)._sessionIndex = sessionIndex;
        (entry as any)._isFirstInSession = entry === sessionEntries[0];
        (entry as any)._isLastInSession = entry === sessionEntries[sessionEntries.length - 1];
      });
      
      result.push(...sessionEntries);
    });

    return result;
  }, [rateLimiterMetrics?.buckets, retryMetrics?.providers, tokensPerSecondMetrics?.byProviderAndModel, ttftMetrics?.byProviderAndModel, activeSessionIds]);

  // Downsample if needed
  const chartData = useMemo(() => {
    const raw = downsampleData(providerData, maxDataPoints);
    // Transform to ensure no NaN values propagate to Recharts dataKey accessors
    // Recharts Bar components access dataKey directly and Math.max(1, NaN) === NaN
    return raw.map((d) => {
      // Create a composite Y-axis label: Session + Provider + Model
      // For "all" session (global metrics), show "retries" instead of "shared"
      const sessionShort = d.sessionId && d.sessionId !== "all" 
        ? d.sessionId.slice(0, 8) 
        : "retries";
      const modelPart = d.model ? ` (${d.model})` : "";
      const yAxisLabel = `${sessionShort} | ${d.provider}${modelPart}`;

      return {
        ...d,
        yAxisLabel,
        nonStreamingRetryAttempts:
          Number.isFinite(d.nonStreamingRetryAttempts) ? d.nonStreamingRetryAttempts : 0,
        streamingRetryAttempts:
          Number.isFinite(d.streamingRetryAttempts) ? d.streamingRetryAttempts : 0,
        totalMaxRequests: Number.isFinite(d.totalMaxRequests) ? d.totalMaxRequests : 0,
        totalRequestsInWindow:
          Number.isFinite(d.totalRequestsInWindow) ? d.totalRequestsInWindow : 0,
        totalRetryAttempts:
          Number.isFinite(d.totalRetryAttempts) ? d.totalRetryAttempts : 0,
        avgTokensPerSecond:
          Number.isFinite(d.avgTokensPerSecond) ? d.avgTokensPerSecond : 0,
        avgTtftMs: Number.isFinite(d.avgTtftMs) ? d.avgTtftMs : 0,
      };
    });
  }, [providerData, maxDataPoints, ttftMetrics?.byProviderAndModel]);

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

  // Get unique session count for display (exclude "all" session which is for global metrics)
  const sessionCount = Array.from(new Set(
    chartData
      .map(d => d.sessionId)
      .filter((s): s is string => Boolean(s) && s !== "all")
  )).length;

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
  // Use ?? 0 to handle undefined, and protect against NaN with || 0
  const globalMaxTokensPerSecond = Math.max(1, ...chartData.map((d) => (d.avgTokensPerSecond ?? 0) || 0));

  // Find max for TTFT axis
  // Use ?? 0 to handle undefined, and protect against NaN with || 0
  const globalMaxTtft = Math.max(1, ...chartData.map((d) => (d.avgTtftMs ?? 0) || 0));

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
        <div className="flex items-center gap-4 text-xs text-muted-foreground">
          {isDownsampled && (
            <span>Showing {chartData.length} of {providerData.length} provider/model entries (max-sampled)</span>
          )}
          {sessionCount > 1 && (
            <span className="px-2 py-0.5 rounded bg-primary/10 text-primary border border-primary/20">
              {sessionCount} Active Session{sessionCount > 1 ? "s" : ""}
            </span>
          )}
        </div>
      </div>

      <div id="combined-chart-description" className="sr-only">
        Grouped vertical bar chart displaying four metric groups per AI provider/model, grouped by active session:
        1. Request Buckets (blue) \u2014 rate limiter usage showing requests used vs maximum capacity, with 70%, 90%, and 100% threshold lines.
        2. Retry Attempts (amber + purple stacked) \u2014 non-streaming and streaming retry counts with max retries reference line.
        3. Average Tokens/sec (emerald) \u2014 average token generation speed per provider/model.
        4. Average TTFT (s) \u2014 average time to first token per provider/model in seconds.
        Each session group separated by dashed horizontal lines. Each provider/model shown as a row within its session group.
        Hover or focus any bar for detailed metrics including utilization percentages, queue lengths, active sessions, tokens/sec, and TTFT.
        Color coding: Green = healthy (less than 70%), Amber = warning (70-89%), Red = critical (greater than 90%). Blue represents request usage, purple represents streaming retries, emerald represents tokens/sec, orange represents TTFT.
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
            {/* group 0: grid */}
            <CartesianGrid strokeDasharray="3 3" stroke="rgb(var(--color-border))" vertical={false} />
            {/* group 1: axes */}
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
            <XAxis
              xAxisId="ttft"
              type="number"
              label={{
                value: "Avg TTFT (s)",
                position: "outsideBottom",
                offset: 80, // Offset further down to avoid overlapping with tokensPerSecond
                style: { textAnchor: "middle", fill: "rgb(var(--color-text))", fontSize: 12, fontWeight: 500 },
              }}
              tick={{ fill: "rgb(var(--color-text-muted))", fontSize: 11 }}
              tickLine={{ stroke: "rgb(var(--color-border))" }}
              axisLine={{ stroke: "rgb(var(--color-border))" }}
tickFormatter={(value) => {
                // Display in seconds with 3 decimal places
                const valueInSeconds = value / 1000;
                return valueInSeconds.toFixed(3) + "s";
              }}
              domain={[0, globalMaxTtft * 1.2]}
              orientation="bottom"
            />
            <YAxis
              dataKey="yAxisLabel"
              type="category"
              width={180}
              tick={{ fill: "rgb(var(--color-text))", fontSize: 11 }}
              tickLine={{ stroke: "rgb(var(--color-border))" }}
              axisLine={{ stroke: "rgb(var(--color-border))" }}
              label={{
                value: "Session / Provider / Model",
                position: "insideLeft",
                offset: -50,
                angle: -90,
                style: {
                  fill: "rgb(var(--color-text))",
                  fontSize: 12,
                  fontWeight: 500,
                  textAnchor: "middle",
                },
              }}
            />
            {/* group 2: tooltip */}
            <Tooltip
              content={<CustomTooltipContent />}
              cursor={{ fill: "rgb(var(--color-border) / 0.1)" }}
            />
            {/* group 3: request buckets (custom shape) */}
            <Bar
              xAxisId="counts"
              dataKey="totalMaxRequests"
              name="Request Buckets: Max (gray) / Used (blue overlay)"
              shape={RequestBucketsShape}
              animationDuration={0}
            />
            {/* group 4: retry attempts (stacked) */}
            <Bar
              xAxisId="counts"
              dataKey="nonStreamingRetryAttempts"
              name="Retry Attempts: Non-Streaming"
              fill={CHART_COLORS.retryNonStreaming}
              animationDuration={0}
              stackId="retries"
            />
            <Bar
              xAxisId="counts"
              dataKey="streamingRetryAttempts"
              name="Retry Attempts: Streaming"
              fill={CHART_COLORS.retryStreaming}
              animationDuration={0}
              stackId="retries"
            />
            {/* group 5: tokens per second */}
            <Bar
              xAxisId="tokensPerSecond"
              dataKey="avgTokensPerSecond"
              name="Avg Tokens/sec"
              fill={CHART_COLORS.tokensPerSecond} // Emerald green for tokens/sec
              animationDuration={300}
            >
              <LabelList
                dataKey="avgTokensPerSecond"
                position="right"
                offset={5}
                formatter={(value: number) => (value > 0 ? formatNumber(value) : "")}
                fontSize={11}
                fill="rgb(var(--color-text-muted))"
              />
            </Bar>
            {/* group 6: TTFT (Time to First Token) */}
            <Bar
              xAxisId="ttft"
              dataKey="avgTtftMs"
              name="Avg TTFT"
              fill={CHART_COLORS.ttft} // Distinct color for TTFT
              animationDuration={300}
            >
              <LabelList
                dataKey="avgTtftMs"
                position="right"
                offset={5}
                formatter={(value: number) => (value > 0 ? `${(value / 1000).toFixed(3)}s` : "")}
                fontSize={11}
                fill="rgb(var(--color-text-muted))"
              />
            </Bar>
{/* group 7: reference lines */}
            {chartData.map((p, idx) => (
              <React.Fragment key={`${p.provider}-${idx}-${(p as any)._sessionIndex ?? 0}`}>
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
            {/* group 8: session separator lines - DISABLED for debugging */}
            {/* {(() => {
              const separators: React.ReactNode[] = [];
              let lastSessionIndex = -1;
              chartData.forEach((p, idx) => {
                const sessionIndex = (p as any)._sessionIndex ?? 0;
                const isLastInSession = (p as any)._isLastInSession;
                if (sessionIndex !== lastSessionIndex && isLastInSession && sessionIndex > 0) {
                  separators.push(
                    <ReferenceLine
                      key={`session-sep-${sessionIndex}`}
                      y={idx + 0.5}
                      stroke="rgb(var(--color-border))"
                      strokeWidth={2}
                      strokeDasharray="8 4"
                    />
                  );
                }
                lastSessionIndex = sessionIndex;
              });
              return separators;
            })()} */}
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
        <div className="flex items-center gap-2" role="listitem">
          <div className="w-4 h-4 rounded" style={{ background: CHART_COLORS.ttft }} title="Average Time to First Token (seconds)" />
          <span>Avg TTFT</span>
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
