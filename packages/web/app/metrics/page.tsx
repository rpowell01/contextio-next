"use client";

import { MainLayout } from "@/components/main-layout";
import { formatBytes, formatNumber } from "@/lib/utils";
import { apiClient, RequestAbortedError } from "@/lib/api";
import type {
  MetricsData,
  TimeRange,
} from "@/types/api";
import type { RateLimiterMetrics, RetryMetrics, RetryProviderMetrics } from "@/types/client-api";
import { TrafficChart } from "@/components/traffic-chart";
import { CombinedRateLimiterRetryChart } from "@/components/combined-rate-limiter-retry-chart";
import { useEffect, useState, useCallback, useRef, useMemo, Suspense } from "react";
import React from "react";
import { usePageLoad } from "@/components/page-load-context";
import { ProgressBar } from "@/components/ui/progress-bar";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
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
  { id: "rateLimiter", label: "Rate Limiter / Retry Metrics", icon: <Gauge className="h-4 w-4" /> },
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
  const [retryMetrics, setRetryMetrics] = useState<RetryMetrics | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const [progress, setProgress] = useState<{ current: number; total: number; message: string } | null>(null);
  const [timeRange, setTimeRange] = useState<TimeRange>(TIME_RANGES[2]); // default 24h
  const [maxDataPoints, setMaxDataPoints] = useState<number>(50);
  const [rateLimiterError, setRateLimiterError] = useState<string | null>(null);
  const [rateLimiterLoading, setRateLimiterLoading] = useState(true);
  const [retryError, setRetryError] = useState<string | null>(null);
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


  const { registerPageReady } = usePageLoad();

  // Refs for polling
  const rateLimiterPollingIntervalRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const metricsPollingIntervalRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const retryPollingIntervalRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const rateLimiterAbortControllerRef = useRef<AbortController | null>(null);
  const metricsAbortControllerRef = useRef<AbortController | null>(null);
  const retryAbortControllerRef = useRef<AbortController | null>(null);
  const isMountedRef = useRef(true);
  const requestIdRef = useRef(0);
  const metricsRequestIdRef = useRef(0);
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
      // Only update if this request is still the latest one
      if (isMountedRef.current && (requestId === undefined || requestId === retryRequestIdRef.current)) {
        setRetryMetrics(prev => {
          // Compare providers to avoid unnecessary re-renders
          if (!prev || !prev.providers) return data;

          const prevProviders = prev.providers;
          const newProviders = data.providers;

          if (prevProviders.length !== newProviders.length) return data;

          for (let i = 0; i < prevProviders.length; i++) {
            const pp = prevProviders[i];
            const np = newProviders[i];
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
              return data;
            }
          }

          // Also check totals
          if (prev.totals.totalRetryAttempts !== data.totals.totalRetryAttempts ||
              prev.totals.totalNonStreamingRetries !== data.totals.totalNonStreamingRetries ||
              prev.totals.totalStreamingRetries !== data.totals.totalStreamingRetries ||
              prev.totals.totalActiveStreamingSessions !== data.totals.totalActiveStreamingSessions ||
              prev.totals.totalCurrentBufferUsageMB !== data.totals.totalCurrentBufferUsageMB ||
              prev.totals.totalMaxBufferUsageMB !== data.totals.totalMaxBufferUsageMB) {
            return data;
          }

          return prev;
        });
        setRetryError(null);
      }
      return true;
    } catch (e) {
      if (e instanceof RequestAbortedError) {
        return false;
      }
      if (isMountedRef.current && (requestId === undefined || requestId === retryRequestIdRef.current)) {
        const errorMessage = e instanceof Error ? e.message : String(e);
        setRetryMetrics(null);
        setRetryError(`Failed to fetch retry metrics: ${errorMessage}`);
      }
      if (isConnectionError(e)) {
        throw e;
      }
      return false;
    } finally {
      if (isMountedRef.current && (requestId === undefined || requestId === retryRequestIdRef.current) && isInitialLoad) {
        setRetryLoading(false);
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

  // Poll for retry metrics (only when rate limiter tab is active) - every 5 seconds
  useEffect(() => {
    // Only poll if rate limiter tab is active
    const shouldPoll = activeTab === "rateLimiter";

    if (!shouldPoll) {
      // Clear any existing polling when not on rate limiter tab
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
      // Abort any in-flight request from previous poll
      if (retryAbortControllerRef.current) {
        retryAbortControllerRef.current.abort();
      }
      // Increment request ID to track this request
      const requestId = ++retryRequestIdRef.current;
      // Create new abort controller for this request
      const abortController = new AbortController();
      retryAbortControllerRef.current = abortController;
      try {
        await fetchRetryMetrics(abortController.signal, requestId, isFirstPoll);
      } catch (e) {
        // Connection error - stop polling to avoid infinite failed requests
        if (isConnectionError(e)) {
          console.error("[metrics] Retry polling stopped due to connection error:", e.message);
          return;
        }
      }
      isFirstPoll = false;
      // Schedule next poll after current one completes
      if (!cancelled) {
        retryPollingIntervalRef.current = setTimeout(runPoll, 5000);
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
  }, [fetchTrafficMetrics, activeTab, timeRange, maxDataPoints]);

  // Fetch retry metrics when rate limiter tab becomes active
  useEffect(() => {
    if (activeTab === "rateLimiter") {
      fetchRetryMetrics(undefined, undefined, true);
    }
  }, [fetchRetryMetrics, activeTab]);

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
            <h3 className="text-lg font-semibold mb-4">Rate Limiter / Retry Metrics</h3>
            {(rateLimiterError || retryError) && (
              <div className="rounded-lg border border-destructive bg-destructive/10 p-4 mb-4">
                {rateLimiterError && <p className="text-destructive">Rate Limiter: {rateLimiterError}</p>}
                {retryError && <p className="text-destructive">Retry Metrics: {retryError}</p>}
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
              <div className="space-y-6">
                {/* Retry Summary Cards */}
                {retryMetrics && (
                  <div className="grid gap-4 md:grid-cols-2 lg:grid-cols-5">
                    <div className="rounded-lg border p-4 bg-amber/10 border-amber/20">
                      <div className="text-sm text-muted-foreground">Total Retry Attempts</div>
                      <div className="text-2xl font-bold text-amber-600">
                        {formatNumber(retryMetrics.totals.totalRetryAttempts)}
                      </div>
                    </div>
                    <div className="rounded-lg border p-4 bg-amber/10 border-amber/20">
                      <div className="text-sm text-muted-foreground">Non-Streaming Retries</div>
                      <div className="text-2xl font-bold text-amber-600">
                        {formatNumber(retryMetrics.totals.totalNonStreamingRetries)}
                      </div>
                    </div>
                    <div className="rounded-lg border p-4 bg-purple/10 border-purple/20">
                      <div className="text-sm text-muted-foreground">Streaming Retries</div>
                      <div className="text-2xl font-bold text-purple-600">
                        {formatNumber(retryMetrics.totals.totalStreamingRetries)}
                      </div>
                    </div>
                    <div className="rounded-lg border p-4 bg-blue/10 border-blue/20">
                      <div className="text-sm text-muted-foreground">Active Streaming Sessions</div>
                      <div className="text-2xl font-bold text-blue-600">
                        {formatNumber(retryMetrics.totals.totalActiveStreamingSessions)}
                      </div>
                    </div>
                    <div className="rounded-lg border p-4 bg-green/10 border-green/20">
                      <div className="text-sm text-muted-foreground">Buffer Memory Active</div>
                      <div className="text-2xl font-bold text-green-600">
                        {retryMetrics.totals.totalCurrentBufferUsageMB.toFixed(1)} MB
                      </div>
                    </div>
                  </div>
                )}

                {/* Combined Chart */}
                <div className="rounded-lg border p-4">
                  <h4 className="text-md font-medium mb-3">Combined Rate Limiter & Retry Metrics</h4>
                  <CombinedRateLimiterRetryChart
                    rateLimiterMetrics={rateLimiterMetrics}
                    retryMetrics={retryMetrics}
                    loading={rateLimiterLoading || retryLoading}
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
                                    <span className="inline-flex items-center gap-1 px-2 py-0.5 rounded text-xs bg-primary/10 text-primary">
                                      <span>🔗</span>
                                      Shared
                                    </span>
                                  ) : (
                                    bucket.sessionId ?? "unknown"
                                  )}
                                </td>
                                <td className="p-2 text-right">
                                  {(rateLimiterMetrics.upstream429Counts?.[bucket.provider ?? ""] ?? 0) > 0 ? (
                                    <span className="font-mono font-bold text-destructive">
                                      {formatNumber(rateLimiterMetrics.upstream429Counts?.[bucket.provider ?? ""] ?? 0)}
                                    </span>
                                  ) : (
                                    <span className="text-muted-foreground">0</span>
                                  )}
                                </td>
                                <td className="p-2 text-right">
                                  {bucket.provider === "nvidia" && (rateLimiterMetrics.nvidiaWorkerRetryCount ?? 0) > 0 ? (
                                    <span className="font-mono font-bold text-primary">
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

                {/* Provider Retry Details Table */}
                {retryMetrics && retryMetrics.providers.length > 0 && (
                  <div className="rounded-lg border p-4">
                    <h4 className="text-md font-medium mb-3">Provider Retry Details</h4>
                    <div className="overflow-x-auto max-h-[400px] overflow-y-auto">
                      <table className="w-full text-sm">
                        <thead>
                          <tr className="border-b">
                            <th className="text-left p-2 font-medium">Provider</th>
                            <th className="text-right p-2 font-medium">Non-Streaming Retries</th>
                            <th className="text-right p-2 font-medium">Streaming Retries</th>
                            <th className="text-right p-2 font-medium">Total Retries</th>
                            <th className="text-right p-2 font-medium">Max Retries</th>
                            <th className="text-right p-2 font-medium">Buffer Usage (MB)</th>
                            <th className="text-right p-2 font-medium">Max Buffer (MB)</th>
                            <th className="text-right p-2 font-medium">Buffer Util %</th>
                            <th className="text-right p-2 font-medium">Active Sessions</th>
                          </tr>
                        </thead>
                        <tbody>
                          {retryMetrics.providers.map((provider: RetryProviderMetrics) => (
                            <tr key={provider.provider} className="border-b last:border-0">
                              <td className="p-2 font-medium">{provider.provider}</td>
                              <td className="p-2 text-right">{formatNumber(provider.nonStreamingRetryAttempts)}</td>
                              <td className="p-2 text-right">{formatNumber(provider.streamingRetryAttempts)}</td>
                              <td className="p-2 text-right font-mono">{formatNumber(provider.totalRetryAttempts)}</td>
                              <td className="p-2 text-right">{formatNumber(provider.maxRetries)}</td>
                              <td className="p-2 text-right">{provider.currentBufferUsageMB.toFixed(1)}</td>
                              <td className="p-2 text-right">{provider.maxBufferUsageMB.toFixed(1)}</td>
                              <td className="p-2 text-right">
                                <span className={provider.bufferUtilizationPercent > 80 ? "text-destructive font-medium" : ""}>
                                  {provider.bufferUtilizationPercent.toFixed(1)}%
                                </span>
                              </td>
                              <td className="p-2 text-right">{formatNumber(provider.activeStreamingSessions)}</td>
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
              <Select value={timeRange.value} onValueChange={(value) => {
                const selected = TIME_RANGES.find((r) => r.value === value);
                if (selected) setTimeRange(selected);
              }}>
                <SelectTrigger>
                  <SelectValue placeholder="Select time range" />
                </SelectTrigger>
                <SelectContent>
                  {TIME_RANGES.map((range) => (
                    <SelectItem key={range.value} value={range.value}>
                      {range.label}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </div>

            <div className="flex items-center gap-2">
              <label
                htmlFor="data-points"
                className="text-sm font-medium text-muted-foreground"
              >
                Data Points:
              </label>
              <Select value={String(maxDataPoints)} onValueChange={(value) => {
                const val = parseInt(value, 10);
                setMaxDataPoints(Number.isFinite(val) ? val : 0);
              }}>
                <SelectTrigger>
                  <SelectValue placeholder="Select data points" />
                </SelectTrigger>
                <SelectContent>
                  {MAX_DATA_POINTS_OPTIONS.map((opt) => (
                    <SelectItem key={opt.value} value={String(opt.value)}>
                      {opt.label}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
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
              className="rounded-lg border p-4 bg-primary/10 border-primary/20"
              title="Sum of max redactions per placeholder per session. For each session, take the highest count of each placeholder type across all its captures, then sum across all sessions."
            >
              <div className="text-sm text-muted-foreground">
                Unique Redactions (per session)
              </div>
              <div className="text-2xl font-bold text-primary">
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