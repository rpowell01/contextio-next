"use client";

import { MainLayout } from "@/components/main-layout";
import { formatBytes, formatNumber } from "@/lib/utils";
import { apiClient, RequestAbortedError } from "@/lib/api";
import type {
  MetricsData,
  TimeRange,
} from "@/types/api";
import type { RateLimiterMetrics, RateLimiterBucketState, RetryMetrics, RetryProviderMetrics } from "@/types/client-api";
import { TrafficChart } from "@/components/traffic-chart";
import { RateLimiterChart } from "@/components/rate-limiter-chart";
import { useEffect, useState, useCallback, useRef, useMemo, Suspense } from "react";
import React from "react";
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
import { usePageLoad } from "@/components/page-load-context";
import { ProgressBar } from "@/components/ui/progress-bar";
import { useSearchParams, useRouter } from "next/navigation";
import { Gauge, TrendingUp, RefreshCw, Loader2 } from "lucide-react";

/**
 * Checks if an error is a connection error that should stop polling.
 * Browser-specific: ERR_CONNECTION_REFUSED is Node.js-specific and not used here.
 */
function isConnectionError(error: unknown): error is Error {
  return (
    error instanceof Error &&
    ((error.name === "TypeError" && error.message === "Failed to fetch") ||
      error.message.includes("NetworkError"))
  );
}

const TIME_RANGES: TimeRange[] = [
  { value: "1h", label: "Last hour", hours: 1 },
  { value: "6h", label: "Last 6 hours", hours: 6 },
  { value: "24h", label: "Last 24 hours", hours: 24 },
  { value: "7d", label: "Last 7 days", hours: 168 },
  { value: "30d", label: "Last 30 days", hours: 720 },
];

const MAX_DATA_POINTS_OPTIONS = [
  { value: "50", label: "50 points" },
  { value: "100", label: "100 points" },
  { value: "200", label: "200 points" },
  { value: "500", label: "500 points" },
  { value: "1000", label: "1000 points" },
  { value: "0", label: "Unlimited" },
];

// Tab configuration
type MetricsTab = "rateLimiter" | "traffic" | "providerRetry";

const tabs: { id: MetricsTab; label: string; icon: React.ReactNode }[] = [
  { id: "rateLimiter", label: "Rate Limiter", icon: <Gauge className="h-4 w-4" /> },
  { id: "traffic", label: "Traffic", icon: <TrendingUp className="h-4 w-4" /> },
  { id: "providerRetry", label: "Provider Retries", icon: <RefreshCw className="h-4 w-4" /> },
];
 
// Chart components for Provider Retry Metrics tab
interface ProviderRetryChartProps {
  buckets: RateLimiterBucketState[];
  upstream429Counts: Record<string, number>;
  nvidiaWorkerRetryCount: number;
  loading?: boolean;
}

function ProviderRetryChart({ buckets, upstream429Counts, nvidiaWorkerRetryCount, loading = false }: ProviderRetryChartProps) {
  if (loading) {
    return (
      <div className="w-full flex flex-col items-center justify-center py-12">
        <Loader2 className="h-8 w-8 animate-spin text-primary" />
        <p className="mt-2 text-sm text-muted-foreground">Loading retry metrics...</p>
      </div>
    );
  }

  const providerMap = useMemo(() => {
    const map = new Map<string, { upstream429s: number; nvidiaRetries: number }>();
    buckets.forEach((bucket: RateLimiterBucketState) => {
      const provider = bucket.provider ?? "unknown";
      const existing = map.get(provider);
      // upstream429Counts and nvidiaWorkerRetryCount are global per-provider, not per-bucket
      // Only set on first encounter to avoid overcounting
      if (!existing) {
        const upstream429s = upstream429Counts[provider] ?? 0;
        const nvidiaRetries = provider === "nvidia" ? nvidiaWorkerRetryCount : 0;
        map.set(provider, { upstream429s, nvidiaRetries });
      }
    });
    return Array.from(map.entries()).map(([provider, data]: [string, { upstream429s: number; nvidiaRetries: number }]) => ({ provider, upstream429s: data.upstream429s, nvidiaRetries: data.nvidiaRetries }));
  }, [buckets, upstream429Counts, nvidiaWorkerRetryCount]);

  if (providerMap.length === 0) {
    return (
      <div className="rounded-lg border p-8 text-center">
        <p className="text-muted-foreground">No provider retry data available</p>
      </div>
    );
  }

  return (
    <div className="space-y-4">
      <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-4">
        {providerMap.map((p: { provider: string; upstream429s: number; nvidiaRetries: number }) => (
          <div key={p.provider} className="rounded-lg border p-3">
            <div className="font-medium text-sm">{p.provider}</div>
            <div className="flex gap-4 mt-2 text-sm">
              <span className={p.upstream429s > 0 ? "font-bold text-red-700" : "text-muted-foreground"}>
                429s: {formatNumber(p.upstream429s)}
              </span>
              <span className={p.provider === "nvidia" && p.nvidiaRetries > 0 ? "font-bold text-amber-700" : "text-muted-foreground"}>
                NVIDIA Retries: {formatNumber(p.nvidiaRetries)}
              </span>
            </div>
          </div>
        ))}
      </div>
    </div>
  );
}

// Buffer size estimation - 1MB per buffer unit
const BUFFER_SIZE_MB_PER_UNIT = 1;

interface BufferUsageChartProps {
  buckets: RateLimiterBucketState[];
  loading?: boolean;
}

interface BufferProviderSummary {
  provider: string;
  bufferCapacity: number;
  entriesInUse: number;
  maxTokens: number;
  maxRequests: number;
  activeBuffersInUse: number;
  bufferMemoryTotalMB: number;
  bufferMemoryActiveMB: number;
  utilizationPercent: number;
}

function BufferUsageChart({ buckets, loading = false }: BufferUsageChartProps) {
  if (loading) {
    return (
      <div className="w-full flex flex-col items-center justify-center py-12">
        <Loader2 className="h-8 w-8 animate-spin text-primary" />
        <p className="mt-2 text-sm text-muted-foreground">Loading buffer metrics...</p>
      </div>
    );
  }

  const providerSummaries = useMemo((): BufferProviderSummary[] => {
    const providerMap = new Map<string, { bufferCapacity: number; entriesInUse: number; maxTokens: number }>();
    buckets.forEach((bucket: RateLimiterBucketState) => {
      const provider = bucket.provider ?? "unknown";
      const existing = providerMap.get(provider);
      if (!existing) {
        providerMap.set(provider, {
          bufferCapacity: bucket.bufferCapacity ?? 0,
          entriesInUse: bucket.requestsInWindow ?? 0,
          maxTokens: bucket.maxTokens ?? 0,
        });
      } else {
        existing.bufferCapacity += bucket.bufferCapacity ?? 0;
        existing.entriesInUse += bucket.requestsInWindow ?? 0;
        existing.maxTokens += bucket.maxTokens ?? 0;
      }
    });

    return Array.from(providerMap.entries()).map(([provider, data]) => {
      const maxRequests = data.maxTokens - data.bufferCapacity;
      const activeBuffersInUse = Math.max(0, data.entriesInUse - maxRequests);
      const bufferMemoryTotalMB = data.bufferCapacity * BUFFER_SIZE_MB_PER_UNIT;
      const bufferMemoryActiveMB = activeBuffersInUse * BUFFER_SIZE_MB_PER_UNIT;
      const utilizationPercent = data.maxTokens > 0 ? ((data.entriesInUse / data.maxTokens) * 100) : 0;

      return {
        provider,
        bufferCapacity: data.bufferCapacity,
        entriesInUse: data.entriesInUse,
        maxTokens: data.maxTokens,
        maxRequests,
        activeBuffersInUse,
        bufferMemoryTotalMB,
        bufferMemoryActiveMB,
        utilizationPercent,
      };
    }).sort((a, b) => b.bufferMemoryActiveMB - a.bufferMemoryActiveMB);
  }, [buckets]);

  if (providerSummaries.length === 0) {
    return (
      <div className="rounded-lg border p-8 text-center">
        <p className="text-muted-foreground">No buffer data available</p>
      </div>
    );
  }

  // Summary cards for total memory
  const totalBufferMemoryMB = providerSummaries.reduce((sum, p) => sum + p.bufferMemoryTotalMB, 0);
  const totalActiveBufferMemoryMB = providerSummaries.reduce((sum, p) => sum + p.bufferMemoryActiveMB, 0);
  const totalActiveBuffers = providerSummaries.reduce((sum, p) => sum + p.activeBuffersInUse, 0);

  return (
    <div className="space-y-6">
      {/* Memory Summary Cards */}
      <div className="grid gap-4 md:grid-cols-3">
        <div className="rounded-lg border p-4 bg-blue-50 border-blue-200">
          <div className="text-sm text-muted-foreground">Total Buffer Memory</div>
          <div className="text-2xl font-bold text-blue-600">{totalBufferMemoryMB.toFixed(1)} MB</div>
          <div className="text-xs text-muted-foreground">{formatNumber(providerSummaries.reduce((s, p) => s + p.bufferCapacity, 0))} buffer units × {BUFFER_SIZE_MB_PER_UNIT} MB</div>
        </div>
        <div className="rounded-lg border p-4 bg-green-50 border-green-200">
          <div className="text-sm text-muted-foreground">Active Buffer Memory</div>
          <div className="text-2xl font-bold text-green-600">{totalActiveBufferMemoryMB.toFixed(1)} MB</div>
          <div className="text-xs text-muted-foreground">{formatNumber(totalActiveBuffers)} active buffers × {BUFFER_SIZE_MB_PER_UNIT} MB</div>
        </div>
        <div className="rounded-lg border p-4 bg-amber-50 border-amber-200">
          <div className="text-sm text-muted-foreground">Buffer Memory Utilization</div>
          <div className="text-2xl font-bold text-amber-700">
            {totalBufferMemoryMB > 0 ? ((totalActiveBufferMemoryMB / totalBufferMemoryMB) * 100).toFixed(1) : 0}%
          </div>
          <div className="text-xs text-muted-foreground">Active / Total buffer memory</div>
        </div>
      </div>

      {/* Buffer Utilization Chart */}
      <div className="rounded-lg border p-4">
        <h4 className="text-md font-medium mb-3">Buffer Utilization by Provider</h4>
        <BufferUtilizationBarChart data={providerSummaries} />
      </div>

      {/* Provider Detail Cards */}
      <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-4">
        {providerSummaries.map((p) => (
          <div key={p.provider} className="rounded-lg border p-3">
            <div className="font-medium text-sm">{p.provider}</div>
            <div className="space-y-1 mt-2 text-sm">
              <div className="flex justify-between">
                <span>Total Buffers:</span>
                <span className="font-mono">{formatNumber(p.bufferCapacity)}</span>
              </div>
              <div className="flex justify-between">
                <span>Active Buffers:</span>
                <span className={p.activeBuffersInUse > 0 ? "font-bold text-blue-600" : "text-muted-foreground"}>
                  {formatNumber(p.activeBuffersInUse)}
                </span>
              </div>
              <div className="flex justify-between">
                <span>Buffer Memory:</span>
                <span className="font-mono text-blue-600">{p.bufferMemoryActiveMB.toFixed(1)} / {p.bufferMemoryTotalMB.toFixed(1)} MB</span>
              </div>
              <div className={p.utilizationPercent >= 90 ? "text-destructive font-medium" : p.utilizationPercent >= 70 ? "text-amber-700 font-medium" : "text-muted-foreground"}>
                Utilization: {p.utilizationPercent.toFixed(1)}%
              </div>
            </div>
          </div>
        ))}
      </div>
    </div>
  );
}

// Bar chart component for buffer utilization (similar to RateLimiterChart)
function BufferUtilizationBarChart({ data }: { data: BufferProviderSummary[] }) {
  const globalMaxCapacity = Math.max(
    1,
    Math.max(...data.map((d) => d.bufferCapacity)),
    Math.max(...data.map((d) => d.maxRequests))
  );

  return (
    <div className="max-h-[400px] overflow-y-auto">
      <ResponsiveContainer width="100%" height={Math.min(400, Math.max(200, data.length * 50 + 80))}>
        <BarChart
          data={data}
          layout="vertical"
          margin={{ top: 20, right: 20, bottom: 60, left: 140 }}
        >
          <CartesianGrid strokeDasharray="3 3" stroke="#e5e7eb" vertical={false} />
          
          <XAxis
            type="number"
            label={{
              value: "Requests",
              position: "outsideBottom",
              offset: 80,
              style: { textAnchor: "middle", fill: "#333", fontSize: 12, fontWeight: 500 },
            }}
            tick={{ fill: "#666", fontSize: 11 }}
            tickLine={{ stroke: "#999" }}
            axisLine={{ stroke: "#999" }}
            tickFormatter={(value) => formatNumber(value)}
            domain={[0, globalMaxCapacity * 1.15]}
          />

          <YAxis
            dataKey="provider"
            type="category"
            width={140}
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
            formatter={(value: number, name: string) => [formatNumber(value), name]}
            labelFormatter={(label, payload) => {
              if (payload && payload.length > 0 && payload[0].payload) {
                const p = payload[0].payload;
                return `${p.provider} | Max: ${p.maxRequests} | Buffer: ${p.bufferCapacity} | Active: ${p.activeBuffersInUse} | Memory: ${p.bufferMemoryActiveMB.toFixed(1)}/${p.bufferMemoryTotalMB.toFixed(1)} MB | Util: ${p.utilizationPercent.toFixed(1)}%`;
              }
              return `Provider: ${label}`;
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

          {/* Max Requests (base capacity) - gray */}
          <Bar
            dataKey="maxRequests"
            name="Max Requests"
            fill="#9ca3af"
            animationDuration={0}
            stackId="a"
          />

          {/* Buffer Capacity - lighter gray */}
          <Bar
            dataKey="bufferCapacity"
            name="Buffer Capacity"
            fill="#d1d5db"
            animationDuration={0}
            stackId="a"
          />

          {/* Active Buffers in Use - blue overlay */}
          <Bar
            dataKey="activeBuffersInUse"
            name="Active Buffers"
            fill="#3b82f6"
            opacity={0.9}
            animationDuration={0}
            stackId="a"
          />

          {/* Reference line for max requests limit */}
          {data.map((p, idx) => (
            <React.Fragment key={p.provider}>
              <ReferenceLine
                x={p.maxRequests}
                stroke="#6b7280"
                strokeWidth={1}
                strokeDasharray="2 2"
                label={
                  <Label
                    value={`${p.provider}: Limit`}
                    position="center"
                    fill="#6b7280"
                    fontSize={8}
                    offset={10 + idx * 20}
                  />
                }
              />
            </React.Fragment>
          ))}
        </BarChart>
      </ResponsiveContainer>
    </div>
  );
}
 
// Retry Attempts Chart
interface RetryAttemptsChartProps {
  providers: RetryProviderMetrics[];
  loading?: boolean;
}
 
function RetryAttemptsChart({ providers, loading = false }: RetryAttemptsChartProps) {
  if (loading) {
    return (
      <div className="w-full flex flex-col items-center justify-center py-12">
        <Loader2 className="h-8 w-8 animate-spin text-primary" />
        <p className="mt-2 text-sm text-muted-foreground">Loading retry metrics...</p>
      </div>
    );
  }
 
  if (providers.length === 0) {
    return (
      <div className="rounded-lg border p-8 text-center">
        <p className="text-muted-foreground">No retry data available</p>
      </div>
    );
  }
 
  const globalMaxRetries = Math.max(1, Math.max(...providers.map((p) => p.totalRetryAttempts)));
 
  return (
    <div className="max-h-[400px] overflow-y-auto">
      <ResponsiveContainer width="100%" height={Math.min(400, Math.max(200, providers.length * 50 + 80))}>
        <BarChart
          data={providers}
          layout="vertical"
          margin={{ top: 20, right: 20, bottom: 60, left: 140 }}
        >
          <CartesianGrid strokeDasharray="3 3" stroke="#e5e7eb" vertical={false} />
 
          <XAxis
            type="number"
            label={{
              value: "Retry Attempts",
              position: "outsideBottom",
              offset: 80,
              style: { textAnchor: "middle", fill: "#333", fontSize: 12, fontWeight: 500 },
            }}
            tick={{ fill: "#666", fontSize: 11 }}
            tickLine={{ stroke: "#999" }}
            axisLine={{ stroke: "#999" }}
            tickFormatter={(value) => formatNumber(value)}
            domain={[0, globalMaxRetries * 1.15]}
          />
 
          <YAxis
            dataKey="provider"
            type="category"
            width={140}
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
            formatter={(value: number, name: string) => [formatNumber(value), name]}
            labelFormatter={(label, payload) => {
              if (payload && payload.length > 0 && payload[0].payload) {
                const p = payload[0].payload;
                return `${p.provider} | Non-Stream: ${p.nonStreamingRetryAttempts} | Stream: ${p.streamingRetryAttempts} | Total: ${p.totalRetryAttempts} | Max Retries: ${p.maxRetries}`;
              }
              return `Provider: ${label}`;
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
 
          {/* Non-Streaming Retries - amber */}
          <Bar
            dataKey="nonStreamingRetryAttempts"
            name="Non-Streaming Retries"
            fill="#f59e0b"
            animationDuration={0}
            stackId="a"
          />
 
          {/* Streaming Retries - blue */}
          <Bar
            dataKey="streamingRetryAttempts"
            name="Streaming Retries"
            fill="#3b82f6"
            animationDuration={0}
            stackId="a"
          />
 
          {/* Reference line for max retries */}
          {providers.map((p, idx) => (
            <React.Fragment key={p.provider}>
              <ReferenceLine
                x={p.maxRetries}
                stroke="#6b7280"
                strokeWidth={1}
                strokeDasharray="2 2"
                label={
                  <Label
                    value={`${p.provider}: Max (${p.maxRetries})`}
                    position="center"
                    fill="#6b7280"
                    fontSize={8}
                    offset={10 + idx * 20}
                  />
                }
              />
            </React.Fragment>
          ))}
        </BarChart>
      </ResponsiveContainer>
    </div>
  );
}
 
// Retry Buffer Chart
interface RetryBufferChartProps {
  providers: RetryProviderMetrics[];
  loading?: boolean;
}
 
function RetryBufferChart({ providers, loading = false }: RetryBufferChartProps) {
  if (loading) {
    return (
      <div className="w-full flex flex-col items-center justify-center py-12">
        <Loader2 className="h-8 w-8 animate-spin text-primary" />
        <p className="mt-2 text-sm text-muted-foreground">Loading buffer metrics...</p>
      </div>
    );
  }
 
  if (providers.length === 0) {
    return (
      <div className="rounded-lg border p-8 text-center">
        <p className="text-muted-foreground">No buffer data available</p>
      </div>
    );
  }
 
  const globalMaxBuffer = Math.max(1, Math.max(...providers.map((p) => p.maxBufferUsageMB)));
 
  return (
    <div className="max-h-[400px] overflow-y-auto">
      <ResponsiveContainer width="100%" height={Math.min(400, Math.max(200, providers.length * 50 + 80))}>
        <BarChart
          data={providers}
          layout="vertical"
          margin={{ top: 20, right: 20, bottom: 60, left: 140 }}
        >
          <CartesianGrid strokeDasharray="3 3" stroke="#e5e7eb" vertical={false} />
 
          <XAxis
            type="number"
            label={{
              value: "Buffer (MB)",
              position: "outsideBottom",
              offset: 80,
              style: { textAnchor: "middle", fill: "#333", fontSize: 12, fontWeight: 500 },
            }}
            tick={{ fill: "#666", fontSize: 11 }}
            tickLine={{ stroke: "#999" }}
            axisLine={{ stroke: "#999" }}
            tickFormatter={(value) => value.toFixed(1)}
            domain={[0, globalMaxBuffer * 1.15]}
          />
 
          <YAxis
            dataKey="provider"
            type="category"
            width={140}
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
            formatter={(value: number, name: string) => [value.toFixed(1), name]}
            labelFormatter={(label, payload) => {
              if (payload && payload.length > 0 && payload[0].payload) {
                const p = payload[0].payload;
                return `${p.provider} | Active: ${p.currentBufferUsageMB.toFixed(1)} MB | Max: ${p.maxBufferUsageMB.toFixed(1)} MB | Util: ${p.bufferUtilizationPercent.toFixed(1)}% | Sessions: ${p.activeStreamingSessions}`;
              }
              return `Provider: ${label}`;
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
 
          {/* Max Buffer - lighter gray */}
          <Bar
            dataKey="maxBufferUsageMB"
            name="Max Buffer (MB)"
            fill="#d1d5db"
            animationDuration={0}
            stackId="a"
          />
 
          {/* Active Buffer - blue overlay */}
          <Bar
            dataKey="currentBufferUsageMB"
            name="Active Buffer (MB)"
            fill="#3b82f6"
            opacity={0.9}
            animationDuration={0}
            stackId="a"
          />
 
          {/* Reference line for max buffer */}
          {providers.map((p, idx) => (
            <React.Fragment key={p.provider}>
              <ReferenceLine
                x={p.maxBufferUsageMB}
                stroke="#6b7280"
                strokeWidth={1}
                strokeDasharray="2 2"
                label={
                  <Label
                    value={`${p.provider}: Max (${p.maxBufferUsageMB.toFixed(1)} MB)`}
                    position="center"
                    fill="#6b7280"
                    fontSize={8}
                    offset={10 + idx * 20}
                  />
                }
              />
            </React.Fragment>
          ))}
        </BarChart>
      </ResponsiveContainer>
    </div>
  );
}
 
/**
 * Inner content component that uses usePageLoad and useSearchParams.
 * Must be rendered inside a Suspense boundary.
 */
function MetricsContent() {
  const searchParams = useSearchParams();
  const router = useRouter();

  const [metrics, setMetrics] = useState<MetricsData | null>(null);
  const [rateLimiterMetrics, setRateLimiterMetrics] = useState<RateLimiterMetrics | null>(null);
  const [retryMetrics, setRetryMetrics] = useState<RetryMetrics | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const [progress, setProgress] = useState<{ current: number; total: number; message: string } | null>(null);
  const [timeRange, setTimeRange] = useState<TimeRange>(TIME_RANGES[2]); // default 24h
  const [maxDataPoints, setMaxDataPoints] = useState<number>(50);
  const [rateLimiterError, setRateLimiterError] = useState<string | null>(null);
  const [rateLimiterLoading, setRateLimiterLoading] = useState(true);
  const [retryLoading, setRetryLoading] = useState(true);

  // Tab state - initialize to default, then sync from URL/localStorage
  const [activeTab, setActiveTab] = useState<MetricsTab>("rateLimiter");
  const [tabInitialized, setTabInitialized] = useState(false);

  // Sync tab from URL/localStorage after initial render
  useEffect(() => {
    if (tabInitialized) return;

    // Check URL param first
    const urlTab = searchParams.get("tab");
    const isValidTab = (tab: string): tab is MetricsTab => tabs.some((t) => t.id === tab);

    if (urlTab && isValidTab(urlTab)) {
      setActiveTab(urlTab);
    } else {
      // Fall back to localStorage
      const saved = localStorage.getItem("metrics-active-tab");
      if (saved && isValidTab(saved)) {
        setActiveTab(saved);
      }
    }
    setTabInitialized(true);
  }, [searchParams, tabInitialized]);

  // Persist active tab to localStorage and URL (without searchParams in deps to avoid infinite loop)
  useEffect(() => {
    localStorage.setItem("metrics-active-tab", activeTab);
    // Read current params from window to avoid depending on searchParams
    const params = new URLSearchParams(window.location.search);
    params.set("tab", activeTab);
    router.replace(`/metrics?${params.toString()}`, { scroll: false });
  }, [activeTab, router]);

  // Memoized sorted buckets for the table to avoid re-sorting on every render
  // Sort by provider name, then by utilization (most constrained first)
  const sortedBuckets = useMemo(
    () =>
      rateLimiterMetrics?.buckets
        ? [...rateLimiterMetrics.buckets].sort((a, b) => {
            // First sort by provider name
            const providerA = a.provider ?? "unknown";
            const providerB = b.provider ?? "unknown";
            if (providerA !== providerB) return providerA.localeCompare(providerB);
            // Then by utilization (ascending = most used first)
            const maxA = a.maxTokens;
            const maxB = b.maxTokens;
            const utilA = maxA > 0 ? 1 - a.tokens / maxA : 0;
            const utilB = maxB > 0 ? 1 - b.tokens / maxB : 0;
            return utilB - utilA;
          })
        : [],
    [rateLimiterMetrics?.buckets],
  );

  // Provider retry summary for the new tab
  const providerRetrySummary = useMemo(() => {
    const providerMap = new Map<string, {
      provider: string;
      upstream429s: number;
      nvidiaRetries: number;
      bufferCapacity: number;
      entriesInUse: number;
      queueLength: number;
      maxTokens: number;
    }>();

    rateLimiterMetrics?.buckets?.forEach((bucket: RateLimiterBucketState) => {
      const provider = bucket.provider ?? "unknown";
      const existing = providerMap.get(provider);
      const upstream429s = (rateLimiterMetrics?.upstream429Counts?.[provider] ?? 0);
      const nvidiaRetries = provider === "nvidia" ? (rateLimiterMetrics?.nvidiaWorkerRetryCount ?? 0) : 0;

      if (!existing) {
        providerMap.set(provider, {
          provider,
          upstream429s,
          nvidiaRetries,
          bufferCapacity: bucket.bufferCapacity ?? 0,
          entriesInUse: bucket.requestsInWindow ?? 0,
          queueLength: bucket.queueLength ?? 0,
          maxTokens: bucket.maxTokens ?? 0,
        });
      } else {
        existing.bufferCapacity += bucket.bufferCapacity ?? 0;
        existing.entriesInUse += bucket.requestsInWindow ?? 0;
        existing.queueLength += bucket.queueLength ?? 0;
        existing.maxTokens += bucket.maxTokens ?? 0;
      }
    });

    return Array.from(providerMap.values()).map((p) => ({
      ...p,
      utilizationPercent: p.maxTokens > 0 ? ((p.entriesInUse / p.maxTokens) * 100) : 0,
    })).sort((a, b) => b.entriesInUse - a.entriesInUse);
  }, [rateLimiterMetrics?.buckets, rateLimiterMetrics?.upstream429Counts, rateLimiterMetrics?.nvidiaWorkerRetryCount]);

  // Page load tracking for footer
  const { registerPageReady } = usePageLoad();

  // Refs for polling
  const rateLimiterPollingIntervalRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const metricsPollingIntervalRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const rateLimiterAbortControllerRef = useRef<AbortController | null>(null);
  const metricsAbortControllerRef = useRef<AbortController | null>(null);
  const isMountedRef = useRef(true);
  const requestIdRef = useRef(0);
  const metricsRequestIdRef = useRef(0);
  const retryPollingIntervalRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const retryAbortControllerRef = useRef<AbortController | null>(null);
  const retryRequestIdRef = useRef(0);

  const progressPercent = progress && progress.total > 0
    ? Math.round((progress.current / progress.total) * 100)
    : 0;

  // Fetch traffic metrics - fetches downsampled data for chart/summary
  const fetchTrafficMetrics = useCallback(async (
    signal?: AbortSignal,
    requestId?: number,
    isInitialLoad = false
  ): Promise<boolean> => {
    if (!isMountedRef.current) return false;
    if (isInitialLoad) {
      setLoading(true);
      setError(null);
      setProgress({ current: 0, total: 0, message: "Loading..." });
    } else {
      console.log("[metrics] Polling for traffic metrics...");
    }
    try {
      // Omit page parameter to trigger server-side downsampling on the full dataset
      // maxDataPoints controls the downsampling resolution
      const data = await apiClient.getMetrics(
        timeRange.hours,
        maxDataPoints || undefined,
        undefined,  // No page - triggers server downsampling
        undefined,  // No pageSize - not needed for downsampling
        signal,
      );
      // Only update if this request is still the latest one
      if (isMountedRef.current && (requestId === undefined || requestId === metricsRequestIdRef.current)) {
        console.log("[metrics] Traffic data received:", {
          trafficPoints: data.traffic?.length,
          totalRequestBytes: data.totalRequestBytes,
          totalResponseBytes: data.totalResponseBytes,
          providers: data.providers?.length,
        });
        // Always update - simpler and more reliable than diffing
        setMetrics(data);
        setError(null);
        setLoading(false);
        setProgress({ current: 1, total: 1, message: "Complete" });
        registerPageReady();
      }
      return true;
    } catch (e) {
      // Ignore aborted requests
      if (e instanceof RequestAbortedError) {
        return false;
      }
      // On any other error, clear metrics to avoid stale data
      if (isMountedRef.current && (requestId === undefined || requestId === metricsRequestIdRef.current)) {
        const errorMessage = e instanceof Error ? e.message : String(e);
        console.error("[metrics] Traffic fetch error:", errorMessage);
        setMetrics(null);
        setError(`Failed to fetch metrics: ${errorMessage}`);
        setLoading(false);
        registerPageReady();
      }
      // Re-throw connection errors so polling can stop
      if (isConnectionError(e)) {
        throw e;
      }
      return false;
    }
  }, [timeRange, maxDataPoints, registerPageReady]);

  // Fetch rate limiter metrics
  const fetchRateLimiterMetrics = useCallback(async (signal?: AbortSignal, requestId?: number, isInitialLoad = false): Promise<boolean> => {
    if (!isMountedRef.current) return false;
    if (isInitialLoad) {
      setRateLimiterLoading(true);
    }
    try {
      const data = await apiClient.getRateLimiterMetrics(signal);
      // Only update if this request is still the latest one
      if (isMountedRef.current && (requestId === undefined || requestId === requestIdRef.current)) {
        // Only update state if data actually changed to avoid unnecessary re-renders
        setRateLimiterMetrics(prev => {
          // Compare buckets by key - check if any bucket's tokens, maxTokens, or queueLength changed
          if (!prev || !prev.buckets) return data;

          const prevBuckets = prev.buckets;
          const newBuckets = data.buckets;

          // Create maps for key-based comparison
          const prevMap = new Map(prevBuckets.map(b => [b.key, b]));
          const newMap = new Map(newBuckets.map(b => [b.key, b]));

          // Check if keys changed (added/removed buckets)
          if (prevMap.size !== newMap.size) return data;

          // Check if any bucket values changed
          for (const [key, newBucket] of newMap) {
            const prevBucket = prevMap.get(key);
            if (!prevBucket) return data; // New bucket added
            if (prevBucket.tokens !== newBucket.tokens ||
                prevBucket.maxTokens !== newBucket.maxTokens ||
                prevBucket.queueLength !== newBucket.queueLength ||
                prevBucket.provider !== newBucket.provider ||
                prevBucket.sessionId !== newBucket.sessionId ||
                (prevBucket.requestsInWindow ?? 0) !== (newBucket.requestsInWindow ?? 0)) {
              return data; // Bucket data changed
            }
          }

          // Also check nvidiaWorkerRetryCount
          if (prev.nvidiaWorkerRetryCount !== data.nvidiaWorkerRetryCount) {
            return data;
          }

          return prev; // Data unchanged, keep previous state
        });
        setRateLimiterError(null);
      }
      return true;
    } catch (e) {
      // Ignore aborted requests - the API throws RequestAbortedError
      if (e instanceof RequestAbortedError) {
        return false;
      }
      // On any other error, clear metrics to avoid stale data
      if (isMountedRef.current && (requestId === undefined || requestId === requestIdRef.current)) {
        const errorMessage = e instanceof Error ? e.message : String(e);
        setRateLimiterMetrics(null);
        setRateLimiterError(`Failed to fetch metrics: ${errorMessage}`);
      }
      // Re-throw connection errors so polling can stop
      if (isConnectionError(e)) {
        throw e;
      }
      return false;
    } finally {
      if (isMountedRef.current && (requestId === undefined || requestId === requestIdRef.current) && isInitialLoad) {
        setRateLimiterLoading(false);
      }
    }
  }, []);

  // Fetch retry metrics
  const fetchRetryMetrics = useCallback(async (signal?: AbortSignal, requestId?: number, isInitialLoad = false): Promise<boolean> => {
    if (!isMountedRef.current) return false;
    if (isInitialLoad) {
      setRetryLoading(true);
    }
    try {
      const data = await apiClient.getRetryMetrics(signal);
      if (isMountedRef.current && (requestId === undefined || requestId === requestIdRef.current)) {
        setRetryMetrics(data);
        setRetryLoading(false);
      }
      return true;
    } catch (e) {
      if (e instanceof RequestAbortedError) {
        return false;
      }
      if (isMountedRef.current && (requestId === undefined || requestId === requestIdRef.current)) {
        const errorMessage = e instanceof Error ? e.message : String(e);
        setRetryMetrics(null);
        console.error("[metrics] Retry fetch error:", errorMessage);
      }
      if (isConnectionError(e)) {
        throw e;
      }
      return false;
    }
  }, []);

  // Poll for rate limiter metrics (only when rate limiter tab is active or on initial load)
  useEffect(() => {
    // Only poll if rate limiter tab is active or we're doing initial load
    const shouldPoll = activeTab === "rateLimiter";

    if (!shouldPoll) {
      // Clear any existing polling when not on rate limiter tab
      if (rateLimiterPollingIntervalRef.current) {
        clearTimeout(rateLimiterPollingIntervalRef.current);
        rateLimiterPollingIntervalRef.current = null;
      }
      if (rateLimiterAbortControllerRef.current) {
        rateLimiterAbortControllerRef.current.abort();
        rateLimiterAbortControllerRef.current = null;
      }
      return;
    }

    let cancelled = false;
    let isFirstPoll = true;

    const runPoll = async () => {
      if (cancelled) return;
      // Abort any in-flight request from previous poll
      if (rateLimiterAbortControllerRef.current) {
        rateLimiterAbortControllerRef.current.abort();
      }
      // Increment request ID to track this request
      const requestId = ++requestIdRef.current;
      // Create new abort controller for this request
      const abortController = new AbortController();
      rateLimiterAbortControllerRef.current = abortController;
      try {
        await fetchRateLimiterMetrics(abortController.signal, requestId, isFirstPoll);
      } catch (e) {
        // Connection error - stop polling to avoid infinite failed requests
        if (isConnectionError(e)) {
          console.error("[metrics] Rate limiter polling stopped due to connection error:", e.message);
          return;
        }
      }
      isFirstPoll = false;
      // Schedule next poll after current one completes
      if (!cancelled) {
        rateLimiterPollingIntervalRef.current = setTimeout(runPoll, 5000);
      }
    };

    runPoll();

    return () => {
      cancelled = true;
      if (rateLimiterPollingIntervalRef.current) {
        clearTimeout(rateLimiterPollingIntervalRef.current);
        rateLimiterPollingIntervalRef.current = null;
      }
      if (rateLimiterAbortControllerRef.current) {
        rateLimiterAbortControllerRef.current.abort();
        rateLimiterAbortControllerRef.current = null;
      }
    };
  }, [fetchRateLimiterMetrics, activeTab]);

  // Poll for traffic metrics (only when traffic tab is active) - every 60 seconds
  useEffect(() => {
    // Only poll if traffic tab is active
    const shouldPoll = activeTab === "traffic";

    if (!shouldPoll) {
      // Clear any existing polling when not on traffic tab
      if (metricsPollingIntervalRef.current) {
        clearTimeout(metricsPollingIntervalRef.current);
        metricsPollingIntervalRef.current = null;
      }
      if (metricsAbortControllerRef.current) {
        metricsAbortControllerRef.current.abort();
        metricsAbortControllerRef.current = null;
      }
      return;
    }

    let cancelled = false;
    let isFirstPoll = true;

    const runPoll = async () => {
      if (cancelled) return;
      // Abort any in-flight request from previous poll
      if (metricsAbortControllerRef.current) {
        metricsAbortControllerRef.current.abort();
      }
      // Increment request ID to track this request
      const requestId = ++metricsRequestIdRef.current;
      // Create new abort controller for this request
      const abortController = new AbortController();
      metricsAbortControllerRef.current = abortController;
      try {
        await fetchTrafficMetrics(abortController.signal, requestId, isFirstPoll);
      } catch (e) {
        // Connection error - stop polling to avoid infinite failed requests
        if (isConnectionError(e)) {
          console.error("[metrics] Traffic polling stopped due to connection error:", e.message);
          return;
        }
      }
      isFirstPoll = false;
      // Schedule next poll after current one completes (60 seconds)
      if (!cancelled) {
        metricsPollingIntervalRef.current = setTimeout(runPoll, 60000);
      }
    };

    runPoll();

    return () => {
      cancelled = true;
      if (metricsPollingIntervalRef.current) {
        clearTimeout(metricsPollingIntervalRef.current);
        metricsPollingIntervalRef.current = null;
      }
      if (metricsAbortControllerRef.current) {
        metricsAbortControllerRef.current.abort();
        metricsAbortControllerRef.current = null;
      }
    };
  }, [fetchTrafficMetrics, activeTab]);

  // Poll for retry metrics (only when provider retry tab is active) - every 10 seconds
  useEffect(() => {
    const shouldPoll = activeTab === "providerRetry";

    if (!shouldPoll) {
      if (retryPollingIntervalRef.current) {
        clearTimeout(retryPollingIntervalRef.current);
        retryPollingIntervalRef.current = null;
      }
      if (retryAbortControllerRef.current) {
        retryAbortControllerRef.current.abort();
        retryAbortControllerRef.current = null;
      }
      return;
    }

    let cancelled = false;
    let isFirstPoll = true;

    const runPoll = async () => {
      if (cancelled) return;
      if (retryAbortControllerRef.current) {
        retryAbortControllerRef.current.abort();
      }
      const requestId = ++retryRequestIdRef.current;
      const abortController = new AbortController();
      retryAbortControllerRef.current = abortController;
      try {
        await fetchRetryMetrics(abortController.signal, requestId, isFirstPoll);
      } catch (e) {
        if (isConnectionError(e)) {
          console.error("[metrics] Retry polling stopped due to connection error:", e.message);
          return;
        }
      }
      isFirstPoll = false;
      if (!cancelled) {
        retryPollingIntervalRef.current = setTimeout(runPoll, 10000);
      }
    };

    runPoll();

    return () => {
      cancelled = true;
      if (retryPollingIntervalRef.current) {
        clearTimeout(retryPollingIntervalRef.current);
        retryPollingIntervalRef.current = null;
      }
      if (retryAbortControllerRef.current) {
        retryAbortControllerRef.current.abort();
        retryAbortControllerRef.current = null;
      }
    };
  }, [fetchRetryMetrics, activeTab]);

  // Fetch main metrics when time range, maxDataPoints, or page changes
  // Only fetch if traffic tab is active
  useEffect(() => {
    if (activeTab === "traffic") {
      fetchTrafficMetrics(undefined, undefined, true);
    }
  }, [fetchTrafficMetrics, activeTab, timeRange, maxDataPoints]);

  // Cleanup on unmount
  useEffect(() => {
    return () => {
      isMountedRef.current = false;
    };
  }, []);

  // Keyboard navigation for tabs
  const handleTabKeyDown = (event: React.KeyboardEvent, _tabId: MetricsTab, index: number) => {
    let newIndex = index;
    switch (event.key) {
      case "ArrowRight":
        event.preventDefault();
        newIndex = (index + 1) % tabs.length;
        break;
      case "ArrowLeft":
        event.preventDefault();
        newIndex = (index - 1 + tabs.length) % tabs.length;
        break;
      case "Home":
        event.preventDefault();
        newIndex = 0;
        break;
      case "End":
        event.preventDefault();
        newIndex = tabs.length - 1;
        break;
      default:
        return;
    }
    setActiveTab(tabs[newIndex].id);
  };

  // Focus the active tab when it changes (handles keyboard navigation focus)
  const tabRefs = useRef<(HTMLButtonElement | null)[]>([]);
  useEffect(() => {
    const activeIndex = tabs.findIndex((t) => t.id === activeTab);
    if (activeIndex >= 0 && tabRefs.current[activeIndex]) {
      tabRefs.current[activeIndex]?.focus();
    }
  }, [activeTab]);

  return (
    <div className="space-y-6">
      <div>
        <h1 className="text-3xl font-bold tracking-tight">Metrics</h1>
        <p className="text-muted-foreground">
          Monitor API traffic, usage, and redaction statistics
        </p>
      </div>

      {/* Tab Navigation */}
      <div className="rounded-lg border">
        <nav aria-label="Metrics sections" className="border-b">
          <ul role="tablist" aria-orientation="horizontal" className="flex flex-wrap gap-1 p-1 bg-muted/50">
            {tabs.map((tab, index) => (
              <li key={tab.id} role="presentation">
                <button
                  ref={(el) => {
                    tabRefs.current[index] = el;
                  }}
                  role="tab"
                  id={`tab-${tab.id}`}
                  aria-selected={activeTab === tab.id}
                  aria-controls={`panel-${tab.id}`}
                  tabIndex={activeTab === tab.id ? 0 : -1}
                  onClick={() => setActiveTab(tab.id)}
                  onKeyDown={(e) => handleTabKeyDown(e, tab.id, index)}
                  className={`inline-flex items-center gap-2 px-3 py-2 text-sm font-medium rounded-md transition-colors focus:outline-none focus:ring-2 focus:ring-ring focus:ring-offset-2 ${
                    activeTab === tab.id
                      ? "bg-background text-foreground shadow-sm"
                      : "text-muted-foreground hover:text-foreground hover:bg-background"
                  }`}
                >
                  <span aria-hidden="true">{tab.icon}</span>
                  {tab.label}
                </button>
              </li>
            ))}
          </ul>
        </nav>
      </div>

      {/* Progress Bar - only show for traffic tab since rate limiter has its own loading state */}
      {(activeTab === "traffic" && (loading || progress)) && (
        <div className="space-y-2">
          <ProgressBar
            value={loading ? progressPercent : 100}
            indeterminate={Boolean(loading && progress && progress.total === 0)}
            height={6}
            className="w-full"
          />
          <div className="flex items-center justify-between text-sm text-muted-foreground">
            <span>{progress?.message || "Loading metrics..."}</span>
            {progress && progress.total > 0 && (
              <span>{progress.current} / {progress.total} ({progressPercent}%)</span>
            )}
          </div>
        </div>
      )}

      {error && (
        <div className="rounded-lg border border-destructive bg-destructive/10 p-4">
          <p className="text-destructive">Error: {error}</p>
        </div>
      )}

      {/* Rate Limiter Tab Panel */}
      {activeTab === "rateLimiter" && (
        <div className="rounded-lg border p-4" role="tabpanel" id="panel-rateLimiter" aria-labelledby="tab-rateLimiter">
          <div className="space-y-4">
            <h3 className="text-lg font-semibold mb-4">Rate Limiter Status</h3>
            {rateLimiterError && (
              <div className="rounded-lg border border-destructive bg-destructive/10 p-4 mb-4">
                <p className="text-destructive">{rateLimiterError}</p>
              </div>
            )}
            {rateLimiterMetrics && !rateLimiterMetrics.config.enabled && (
              <div className="text-center py-8">
                <p className="text-muted-foreground">
                  Rate limiter is not enabled. Enable it in the proxy configuration to see metrics.
                </p>
              </div>
            )}
            {!rateLimiterMetrics && rateLimiterError && (
              <div className="text-center py-8">
                <p className="text-muted-foreground">
                  Unable to load rate limiter metrics. Check the proxy connection and try again.
                </p>
              </div>
            )}
            {rateLimiterMetrics && rateLimiterMetrics.config.enabled && (
              <div className="space-y-4">
                {/* Chart */}
                <div className="rounded-lg border p-4">
                  <h4 className="text-md font-medium mb-3">Request Bucket States</h4>
                  <RateLimiterChart
                    buckets={rateLimiterMetrics.buckets}
                    loading={rateLimiterLoading}
                    maxDataPoints={maxDataPoints}
                  />
                </div>

                {/* Bucket Details Table */}
                {sortedBuckets.length > 0 && (
                  <div className="rounded-lg border p-4">
                    <h4 className="text-md font-medium mb-3">Bucket Details</h4>
                    <div className="overflow-x-auto max-h-[400px] overflow-y-auto">
                      <table className="w-full text-sm">
                        <thead>
                          <tr className="border-b">
                            <th className="text-left p-2 font-medium">Key</th>
                            <th className="text-right p-2 font-medium">Requests Used / Window</th>
                            <th className="text-right p-2 font-medium">Requests Remaining (Window)</th>
                            <th className="text-right p-2 font-medium">Max Requests</th>
                            <th className="text-right p-2 font-medium">Buffer Capacity</th>
                            <th className="text-right p-2 font-medium">Queue</th>
                            <th className="text-left p-2 font-medium">Provider</th>
                            <th className="text-left p-2 font-medium">Scope</th>
                            <th className="text-right p-2 font-medium">Upstream 429s</th>
                            <th className="text-right p-2 font-medium">NVIDIA Worker Retries</th>
                          </tr>
                        </thead>
                        <tbody>
                          {sortedBuckets.map((bucket) => (
                              <tr key={bucket.key} className="border-b last:border-0">
                                <td className="p-2 font-mono text-xs truncate max-w-xs" title={bucket.key}>
                                  {bucket.key}
                                </td>
                                <td className="p-2 text-right text-muted-foreground">{formatNumber(bucket.requestsInWindow ?? 0)}</td>
                                <td className="p-2 text-right">
                                  <span className={bucket.maxTokens - (bucket.requestsInWindow ?? 0) < 5 ? "text-destructive font-medium" : ""}>
                                    {formatNumber(Math.max(0, bucket.maxTokens - (bucket.requestsInWindow ?? 0)))}
                                  </span>
                                </td>
                                <td className="p-2 text-right text-muted-foreground">{formatNumber(bucket.maxTokens)}</td>
                                <td className="p-2 text-right text-muted-foreground">{formatNumber(bucket.bufferCapacity)}</td>
                                <td className="p-2 text-right">
                                  <span className={bucket.queueLength > 0 ? "text-destructive font-medium" : "text-muted-foreground"}>
                                    {formatNumber(bucket.queueLength)}
                                  </span>
                                </td>
                                <td className="p-2 text-muted-foreground">{bucket.provider ?? "unknown"}</td>
                                <td className="p-2 text-muted-foreground">
                                  {bucket.sessionId === "all" ? (
                                    <span className="inline-flex items-center gap-1 px-2 py-0.5 rounded text-xs bg-blue-50 text-blue-700">
                                      <span>🔗</span>
                                      Shared
                                    </span>
                                  ) : (
                                    bucket.sessionId ?? "unknown"
                                  )}
                                </td>
                                <td className="p-2 text-right">
                                  {(rateLimiterMetrics.upstream429Counts?.[bucket.provider ?? ""] ?? 0) > 0 ? (
                                    <span className="font-mono font-bold text-red-700">
                                      {formatNumber(rateLimiterMetrics.upstream429Counts?.[bucket.provider ?? ""] ?? 0)}
                                    </span>
                                  ) : (
                                    <span className="text-muted-foreground">0</span>
                                  )}
                                </td>
                                <td className="p-2 text-right">
                                  {bucket.provider === "nvidia" && (rateLimiterMetrics.nvidiaWorkerRetryCount ?? 0) > 0 ? (
                                    <span className="font-mono font-bold text-amber-700">
                                      {rateLimiterMetrics.nvidiaWorkerRetryCount}
                                    </span>
                                  ) : (
                                    <span className="text-muted-foreground">0</span>
                                  )}
                                </td>
                              </tr>
                            ))}
                        </tbody>
                      </table>
                    </div>
                  </div>
                )}
              </div>
            )}
            {!rateLimiterMetrics && !rateLimiterError && (
              <div className="text-center py-8">
                <p className="text-muted-foreground">Loading rate limiter metrics...</p>
              </div>
            )}
          </div>
        </div>
      )}

      {/* Traffic Tab Panel */}
      {activeTab === "traffic" && metrics && (
        <div role="tabpanel" id="panel-traffic" aria-labelledby="tab-traffic">
          {/* Filter Controls */}
          <div className="flex flex-wrap items-center gap-4">
            <div className="flex items-center gap-2">
              <label
                htmlFor="time-range"
                className="text-sm font-medium text-muted-foreground"
              >
                Time Range:
              </label>
              <select
                id="time-range"
                value={timeRange.value}
                onChange={(e) => {
                  const selected = TIME_RANGES.find(
                    (r) => r.value === e.target.value,
                  );
                  if (selected) setTimeRange(selected);
                }}
                className="h-9 rounded-md border border-input bg-transparent px-3 py-1 text-sm shadow-sm transition-colors focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring"
              >
                {TIME_RANGES.map((range) => (
                  <option key={range.value} value={range.value}>
                    {range.label}
                  </option>
                ))}
              </select>
            </div>

            <div className="flex items-center gap-2">
              <label
                htmlFor="data-points"
                className="text-sm font-medium text-muted-foreground"
              >
                Data Points:
              </label>
              <select
                id="data-points"
                value={String(maxDataPoints)}
                onChange={(e) => {
                  const val = parseInt(e.target.value, 10);
                  setMaxDataPoints(Number.isFinite(val) ? val : 0);
                }}
                className="h-9 rounded-md border border-input bg-transparent px-3 py-1 text-sm shadow-sm transition-colors focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring"
              >
                {MAX_DATA_POINTS_OPTIONS.map((opt) => (
                  <option key={opt.value} value={opt.value}>
                    {opt.label}
                  </option>
                ))}
              </select>
            </div>
          </div>

          {/* Summary Cards */}
          <div className="grid gap-4 md:grid-cols-2 lg:grid-cols-5">
            <div className="rounded-lg border p-4">
              <div className="text-sm text-muted-foreground">
                Total Requests
              </div>
              <div className="text-2xl font-bold">
                {formatNumber(
                  metrics.providers.reduce(
                    (sum, p) => sum + p.requestCount,
                    0,
                  ),
                )}
              </div>
            </div>

            {/* Unique Redactions (deduplicated by session) */}
            <div
              className="rounded-lg border p-4 bg-blue-50 border-blue-200"
              title="Sum of max redactions per placeholder per session. For each session, take the highest count of each placeholder type across all its captures, then sum across all sessions."
            >
              <div className="text-sm text-muted-foreground">
                Unique Redactions (per session)
              </div>
              <div className="text-2xl font-bold text-blue-600">
                <span
                  title="Sum of maximum redactions per session. For each session, the highest count of each placeholder type across all its captures is used, then summed across all sessions. This avoids double-counting when a session has multiple captures."
                >
                  {formatNumber(metrics.redactionStatsDeduped?.totalRedactions ?? 0)}
                </span>
              </div>
            </div>

            {/* Total Redactions (sum across all captures) */}
            <div
              className="rounded-lg border p-4 bg-accent border-border"
              title="Sum of all redactions across every capture. Every capture's redactions are counted individually (no deduplication)."
            >
              <div className="text-sm text-muted-foreground">
                Total Redactions (all captures)
              </div>
              <div className="text-2xl font-bold text-primary">
                <span
                  title="Sum of all redactions across every capture. Every capture's redactions are counted individually with no deduplication. A single session with multiple captures will have its redactions counted multiple times."
                >
                  {formatNumber(metrics.redactionStatsSum?.totalRedactions ?? 0)}
                </span>
              </div>
            </div>

            <div className="rounded-lg border p-4">
              <div className="text-sm text-muted-foreground">
                Request Bytes
              </div>
              <div className="text-2xl font-bold">
                {formatBytes(metrics.totalRequestBytes)}
              </div>
            </div>
            <div className="rounded-lg border p-4">
              <div className="text-sm text-muted-foreground">
                Response Bytes
              </div>
              <div className="text-2xl font-bold">
                {formatBytes(metrics.totalResponseBytes)}
              </div>
            </div>
          </div>

          {/* Traffic Chart */}
          {metrics.traffic.length > 0 ? (
            <div className="rounded-lg border p-4">
              <h3 className="text-lg font-semibold mb-4">
                Traffic Over Time
              </h3>
              <TrafficChart
                data={metrics.traffic}
                maxDataPoints={maxDataPoints || undefined}
                loading={loading}
                timeRangeHours={timeRange.hours}
              />
            </div>
          ) : (
            <div className="rounded-lg border p-4">
              <h3 className="text-lg font-semibold mb-4">
                Traffic Over Time
              </h3>
              <p className="text-muted-foreground">
                No traffic data available for the selected time range.
              </p>
            </div>
          )}

          {/* Traffic Summary */}
          <div className="rounded-lg border p-4">
            <h3 className="text-lg font-semibold mb-4">Traffic Summary</h3>
            <div className="grid gap-4 md:grid-cols-2">
              <div>
                <div className="text-sm text-muted-foreground">
                  Request Bytes
                </div>
                <div className="text-xl font-medium">
                  {formatBytes(metrics.totalRequestBytes)}
                </div>
              </div>
              <div>
                <div className="text-sm text-muted-foreground">
                  Response Bytes
                </div>
                <div className="text-xl font-medium">
                  {formatBytes(metrics.totalResponseBytes)}
                </div>
              </div>
            </div>
          </div>

          {/* Provider Usage */}
          <div className="rounded-lg border p-4">
            <h3 className="text-lg font-semibold mb-4">Provider Usage</h3>
            <div className="space-y-2">
              {metrics?.providers.map((provider) => (
                <div
                  key={provider.provider}
                  className="flex items-center justify-between rounded border p-3"
                >
                  <span className="font-medium">{provider.provider}</span>
                  <div className="text-right text-sm">
                    <div>{formatNumber(provider.requestCount)} requests</div>
                    <div className="text-muted-foreground">
                      Tokens not available in metadata-only mode
                    </div>
                  </div>
                </div>
              ))}
            </div>
          </div>
        </div>
      )}

      {/* Provider Retry Metrics Tab Panel */}
      {activeTab === "providerRetry" && (
        <div className="space-y-6" role="tabpanel" id="panel-providerRetry" aria-labelledby="tab-providerRetry">
          <div className="space-y-4">
            <h3 className="text-lg font-semibold mb-4">Provider Streaming Retry Metrics</h3>
            {retryLoading && !retryMetrics && (
              <div className="text-center py-8">
                <p className="text-muted-foreground">Loading retry metrics...</p>
              </div>
            )}
            {!retryLoading && !retryMetrics && (
              <div className="text-center py-8">
                <p className="text-muted-foreground">Unable to load retry metrics. Check the proxy connection and try again.</p>
              </div>
            )}
            {retryMetrics && (
              <div className="space-y-6">
                {/* Summary Cards */}
                <div className="grid gap-4 md:grid-cols-2 lg:grid-cols-5">
                  <div className="rounded-lg border p-4 bg-red-50 border-red-200">
                    <div className="text-sm text-muted-foreground">Total Retry Attempts</div>
                    <div className="text-2xl font-bold text-red-600">
                      {formatNumber(retryMetrics.totals.totalRetryAttempts)}
                    </div>
                  </div>
                  <div className="rounded-lg border p-4 bg-amber-50 border-amber-200">
                    <div className="text-sm text-muted-foreground">Non-Streaming Retries</div>
                    <div className="text-2xl font-bold text-amber-700">
                      {formatNumber(retryMetrics.totals.totalNonStreamingRetries)}
                    </div>
                  </div>
                  <div className="rounded-lg border p-4 bg-blue-50 border-blue-200">
                    <div className="text-sm text-muted-foreground">Streaming Retries</div>
                    <div className="text-2xl font-bold text-blue-600">
                      {formatNumber(retryMetrics.totals.totalStreamingRetries)}
                    </div>
                  </div>
                  <div className="rounded-lg border p-4 bg-green-50 border-green-200">
                    <div className="text-sm text-muted-foreground">Active Streaming Sessions</div>
                    <div className="text-2xl font-bold text-green-700">
                      {formatNumber(retryMetrics.totals.totalActiveStreamingSessions)}
                    </div>
                  </div>
                  <div className="rounded-lg border p-4 bg-purple-50 border-purple-200">
                    <div className="text-sm text-muted-foreground">Buffer Memory Active</div>
                    <div className="text-2xl font-bold text-purple-700">
                      {retryMetrics.totals.totalCurrentBufferUsageMB.toFixed(1)} MB
                    </div>
                  </div>
                </div>

                {/* Retry Attempts by Provider */}
                <div className="rounded-lg border p-4">
                  <h4 className="text-md font-medium mb-3">Retry Attempts by Provider</h4>
                  <RetryAttemptsChart
                    providers={retryMetrics.providers}
                    loading={retryLoading}
                  />
                </div>

                {/* Buffer Usage by Provider */}
                <div className="rounded-lg border p-4">
                  <h4 className="text-md font-medium mb-3">Streaming Retry Buffer Usage by Provider</h4>
                  <RetryBufferChart
                    providers={retryMetrics.providers}
                    loading={retryLoading}
                  />
                </div>

                {/* Detailed Table */}
                <div className="rounded-lg border p-4">
                  <h4 className="text-md font-medium mb-3">Provider Details</h4>
                  <div className="overflow-x-auto max-h-[400px] overflow-y-auto">
                    <table className="w-full text-sm">
                      <thead>
                        <tr className="border-b">
                          <th className="text-left p-2 font-medium">Provider</th>
                          <th className="text-right p-2 font-medium">Max Retries</th>
                          <th className="text-right p-2 font-medium">Max Buffer (MB)</th>
                          <th className="text-right p-2 font-medium">Non-Stream Retries</th>
                          <th className="text-right p-2 font-medium">Stream Retries</th>
                          <th className="text-right p-2 font-medium">Total Retries</th>
                          <th className="text-right p-2 font-medium">Active Sessions</th>
                          <th className="text-right p-2 font-medium">Buffer Active (MB)</th>
                          <th className="text-right p-2 font-medium">Buffer Max (MB)</th>
                          <th className="text-right p-2 font-medium">Buffer Util %</th>
                        </tr>
                      </thead>
                      <tbody>
                        {retryMetrics.providers.map((provider) => (
                          <tr key={provider.provider} className="border-b last:border-0">
                            <td className="p-2 font-medium">{provider.provider}</td>
                            <td className="p-2 text-right text-muted-foreground">{provider.maxRetries}</td>
                            <td className="p-2 text-right text-muted-foreground">{provider.maxResponseBufferSizeMB.toFixed(1)}</td>
                            <td className="p-2 text-right">
                              <span className={provider.nonStreamingRetryAttempts > 0 ? "font-bold text-amber-700" : "text-muted-foreground"}>
                                {formatNumber(provider.nonStreamingRetryAttempts)}
                              </span>
                            </td>
                            <td className="p-2 text-right">
                              <span className={provider.streamingRetryAttempts > 0 ? "font-bold text-blue-700" : "text-muted-foreground"}>
                                {formatNumber(provider.streamingRetryAttempts)}
                              </span>
                            </td>
                            <td className="p-2 text-right">
                              <span className={provider.totalRetryAttempts > 0 ? "font-bold text-red-700" : "text-muted-foreground"}>
                                {formatNumber(provider.totalRetryAttempts)}
                              </span>
                            </td>
                            <td className="p-2 text-right">
                              <span className={provider.activeStreamingSessions > 0 ? "font-bold text-green-700" : "text-muted-foreground"}>
                                {formatNumber(provider.activeStreamingSessions)}
                              </span>
                            </td>
                            <td className="p-2 text-right text-blue-600 font-mono">{provider.currentBufferUsageMB.toFixed(1)}</td>
                            <td className="p-2 text-right text-muted-foreground">{provider.maxBufferUsageMB.toFixed(1)}</td>
                            <td className="p-2 text-right">
                              <span className={provider.bufferUtilizationPercent >= 90 ? "text-destructive font-medium" : provider.bufferUtilizationPercent >= 70 ? "text-amber-700 font-medium" : "text-muted-foreground"}>
                                {provider.bufferUtilizationPercent.toFixed(1)}%
                              </span>
                            </td>
                          </tr>
                        ))}
                      </tbody>
                    </table>
                  </div>
                </div>
              </div>
            )}
          </div>
        </div>
      )}


      {/* Traffic tab loading state */}
      {activeTab === "traffic" && loading && (
        <div role="tabpanel" id="panel-traffic" aria-labelledby="tab-traffic" className="text-center py-8">
          <p className="text-muted-foreground">Loading traffic metrics...</p>
        </div>
      )}

      {/* Traffic tab empty state */}
      {activeTab === "traffic" && !loading && !metrics && !error && (
        <div role="tabpanel" id="panel-traffic" aria-labelledby="tab-traffic" className="text-center py-8">
          <p className="text-muted-foreground">No traffic data available.</p>
        </div>
      )}
    </div>
  );
}

export default function MetricsPage() {
  return (
    <MainLayout>
      <Suspense fallback={<div className="flex items-center justify-center py-12"><p className="text-muted-foreground">Loading metrics...</p></div>}>
        <MetricsContent />
      </Suspense>
    </MainLayout>
  );
}