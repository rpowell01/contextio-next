"use client";

import { MainLayout } from "@/components/main-layout";
import { formatBytes, formatNumber } from "@/lib/utils";
import { apiClient, RequestAbortedError } from "@/lib/api";
import type {
  MetricsData,
  TimeRange,
  RateLimiterMetrics,
} from "@/types/api";
import { TrafficChart } from "@/components/traffic-chart";
import { RateLimiterChart } from "@/components/rate-limiter-chart";
import { useEffect, useState, useCallback, useRef, useMemo, Suspense } from "react";
import { usePageLoad } from "@/components/page-load-context";
import { ProgressBar } from "@/components/ui/progress-bar";
import { useSearchParams, useRouter } from "next/navigation";
import { Gauge, TrendingUp } from "lucide-react";

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
type MetricsTab = "rateLimiter" | "traffic";

const tabs: { id: MetricsTab; label: string; icon: React.ReactNode }[] = [
  { id: "rateLimiter", label: "Rate Limiter", icon: <Gauge className="h-4 w-4" /> },
  { id: "traffic", label: "Traffic", icon: <TrendingUp className="h-4 w-4" /> },
];

/**
 * Inner content component that uses usePageLoad and useSearchParams.
 * Must be rendered inside a Suspense boundary.
 */
function MetricsContent() {
  const searchParams = useSearchParams();
  const router = useRouter();

  const [metrics, setMetrics] = useState<MetricsData | null>(null);
  const [rateLimiterMetrics, setRateLimiterMetrics] = useState<RateLimiterMetrics | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const [progress, setProgress] = useState<{ current: number; total: number; message: string } | null>(null);
  const [timeRange, setTimeRange] = useState<TimeRange>(TIME_RANGES[2]); // default 24h
  const [maxDataPoints, setMaxDataPoints] = useState<number>(50);
  const [page, setPage] = useState<number>(1);
  const [pageSize] = useState<number>(50);
  const [rateLimiterError, setRateLimiterError] = useState<string | null>(null);
  const [rateLimiterLoading, setRateLimiterLoading] = useState(true);

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

  const progressPercent = progress && progress.total > 0
    ? Math.round((progress.current / progress.total) * 100)
    : 0;

  // Fetch traffic metrics (non-streaming, for polling + initial load when filters haven't changed)
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
      const data = await apiClient.getMetrics(
        timeRange.hours,
        maxDataPoints || undefined,
        page,
        pageSize,
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
  }, [timeRange, maxDataPoints, page, pageSize, registerPageReady]);

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

  // Fetch main metrics when time range, maxDataPoints, or page changes
  // Only fetch if traffic tab is active
  useEffect(() => {
    if (activeTab === "traffic") {
      fetchTrafficMetrics(undefined, undefined, true);
    }
  }, [fetchTrafficMetrics, activeTab]);

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
              className="rounded-lg border p-4 bg-red-50 border-red-200"
              title="Sum of all redactions across every capture. Every capture's redactions are counted individually (no deduplication)."
            >
              <div className="text-sm text-muted-foreground">
                Total Redactions (all captures)
              </div>
              <div className="text-2xl font-bold text-red-600">
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

          {/* Pagination Controls */}
          {metrics.pagination && metrics.pagination.totalPages > 1 && (
            <div className="rounded-lg border p-4">
              <h3 className="text-lg font-semibold mb-4">Pagination</h3>
              <div className="flex items-center justify-between">
                <div className="text-sm text-muted-foreground">
                  Page {metrics.pagination.page} of {metrics.pagination.totalPages} ({metrics.pagination.totalItems} total items)
                </div>
                <div className="flex items-center gap-2">
                  <button
                    onClick={() => setPage((p) => Math.max(1, p - 1))}
                    disabled={page <= 1}
                    className="rounded-md border px-3 py-1 text-sm hover:bg-accent disabled:opacity-50 disabled:cursor-not-allowed"
                  >
                    &larr; Previous
                  </button>
                  <button
                    onClick={() =>
                      setPage((p) =>
                        metrics.pagination && p >= metrics.pagination.totalPages
                          ? p
                          : p + 1,
                      )
                    }
                    disabled={
                      metrics.pagination && page >= metrics.pagination.totalPages
                    }
                    className="rounded-md border px-3 py-1 text-sm hover:bg-accent disabled:opacity-50 disabled:cursor-not-allowed"
                  >
                    Next &rarr;
                  </button>
                </div>
              </div>
            </div>
          )}

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