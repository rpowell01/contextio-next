"use client";

import { MainLayout } from "@/components/main-layout";
import { formatDateTime } from "@/lib/utils";
import type { SessionDetail, CaptureDetail } from "@/types/api";
import Link from "next/link";
import { apiClient } from "@/lib/api";
import { useState, useEffect, useMemo, Suspense } from "react";
import { useSearchParams } from "next/navigation";
import { ProgressBar } from "@/components/ui/progress-bar";
import { usePageLoad } from "@/components/page-load-context";

function renderJson(data: unknown): string {
  if (typeof data === "string") {
    try {
      return JSON.stringify(JSON.parse(data), null, 2);
    } catch {
      return data;
    }
  }
  if (data === null || data === undefined) {
    return "{}";
  }
  return JSON.stringify(data, null, 2);
}

interface CaptureFilters {
  status: string;
  from: string;
  to: string;
  redactionType: string;
}

const DEFAULT_FILTERS: CaptureFilters = {
  status: "",
  from: "",
  to: "",
  redactionType: "",
};

// Skeleton components for loading states
function CaptureSkeleton() {
  return (
    <div className="space-y-4">
      {[...Array(4)].map((_, i) => (
        <div key={i} className="rounded-lg border p-4">
          <div className="h-4 bg-muted-foreground/20 rounded mb-2" style={{ width: "200px" }} />
          <div className="h-64 bg-muted/20 rounded" />
        </div>
      ))}
    </div>
  );
}

function SessionView({
  params,
}: {
  params: Promise<{ id: string }>;
}) {
  const [session, setSession] = useState<SessionDetail | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [progress, setProgress] = useState<{ current: number; total: number; message: string } | null>(null);
  const [id, setId] = useState<string | null>(null);
  const [selectedCaptureId, setSelectedCaptureId] = useState<string | null>(null);
  const [captureDetail, setCaptureDetail] = useState<
    (CaptureDetail & {
      requestBody: Record<string, unknown>;
      responseBody: string | null;
    }) | null
  >(null);
  const [captureDetailLoading, setCaptureDetailLoading] = useState(false);
  const [captureDetailError, setCaptureDetailError] = useState<string | null>(null);
  const [filters, setFilters] = useState<CaptureFilters>(DEFAULT_FILTERS);
  const searchParams = useSearchParams();

  // Page load tracking for footer
  const { registerPageLoad, registerPageReady } = usePageLoad();

  // Read captureId from query string to support deep-linking to a capture detail
  const queryCaptureId = searchParams.get("captureId");

  useEffect(() => {
    const unwrapParams = async () => {
      const resolved = await params;
      setId(resolved.id);
    };
    unwrapParams();
  }, [params]);

  useEffect(() => {
    if (!queryCaptureId) {
      setSelectedCaptureId(null);
      setCaptureDetail(null);
      return;
    }
    setSelectedCaptureId(queryCaptureId);
  }, [queryCaptureId]);

  const progressPercent = progress && progress.total > 0
    ? Math.round((progress.current / progress.total) * 100)
    : 0;

  useEffect(() => {
    if (!id) return;

    const fetchSession = async () => {
      registerPageLoad();
      setLoading(true);
      setError(null);
      setProgress({ current: 0, total: 0, message: "Starting..." });

      try {
        const stream = await apiClient.getSessionStream(id);

        for await (const update of stream) {
          if (update.type === "progress") {
            setProgress({
              current: update.current || 0,
              total: update.total || 0,
              message: update.message || "",
            });
          } else if (update.type === "complete" && update.data) {
            // Build the session detail from the streamed data
            const { session: sessionSummary, metrics, captures } = update.data;
            const sessionDetail: SessionDetail = {
              id: sessionSummary.sessionId,
              sessionId: sessionSummary.sessionId,
              source: sessionSummary.source,
              provider: sessionSummary.destination,
              apiFormat: "unknown",
              targetUrl: captures[0]?.targetUrl || "",
              requestBody: {},
              responseStatus: 200,
              responseIsStreaming: false,
              responseBody: null,
              timestamp: sessionSummary.firstTimestamp,
              timings: { total_ms: sessionSummary.totalTimeMs },
              metrics: {
                totalInboundBytes: metrics?.totalInboundBytes ?? 0,
                totalOutboundBytes: metrics?.totalOutboundBytes ?? 0,
                inboundThroughput: metrics?.inboundThroughput ?? 0,
                outboundThroughput: metrics?.outboundThroughput ?? 0,
                totalContextValues: metrics?.totalContextValues ?? 0,
                totalInputTokens: metrics?.totalInputTokens,
                totalOutputTokens: metrics?.totalOutputTokens,
                redactionStats: {
                  totalRedactions: metrics?.redactionStats?.totalRedactions ?? 0,
                  byRule: metrics?.redactionStats?.byRule ?? {},
                },
              },
              contextValues: {},
              redactionStats: {
                totalRedactions: metrics?.redactionStats?.totalRedactions ?? 0,
                byRule: metrics?.redactionStats?.byRule ?? {},
              },
              captures: captures.map((c: any) => ({
                id: c.id,
                timestamp: c.timestamp,
                targetUrl: c.targetUrl,
                requestBytes: c.requestBytes,
                responseBytes: c.responseBytes,
                responseStatus: c.responseStatus,
                responseIsStreaming: c.responseIsStreaming,
                timings: c.timings,
                source: c.source,
                metrics: c.metrics,
                redactionStats: c.redactionStats,
              })),
            };
            setSession(sessionDetail);
            setProgress({ current: update.total || 0, total: update.total || 0, message: "Complete" });
            setLoading(false);
            registerPageReady();
          } else if (update.type === "error") {
            throw new Error(update.error || "Streaming error");
          }
        }
      } catch (e) {
        setError(e instanceof Error ? e.message : "Unknown error");
        setLoading(false);
        registerPageReady();
      }
    };

    fetchSession();
  }, [id, registerPageLoad, registerPageReady]);

  useEffect(() => {
    if (!selectedCaptureId) return;

    const fetchCaptureDetail = async () => {
      setCaptureDetailLoading(true);
      setCaptureDetailError(null);
      try {
        const data = await apiClient.getCapture(selectedCaptureId);
        setCaptureDetail(data);
      } catch (e) {
        setCaptureDetailError(
          e instanceof Error ? e.message : "Unknown error",
        );
        setCaptureDetail(null);
      } finally {
        setCaptureDetailLoading(false);
      }
    };

    fetchCaptureDetail();
  }, [selectedCaptureId]);

  const handleFilterChange = (key: keyof CaptureFilters, value: string) => {
    setFilters((prev) => ({ ...prev, [key]: value }));
  };

  const clearFilters = () => {
    setFilters(DEFAULT_FILTERS);
  };

  const hasActiveFilters = Object.values(filters).some((v) => v !== "");

  // Filter and sort captures: newest first (by timestamp descending)
  const filteredAndSortedCaptures = useMemo(() => {
    if (!session?.captures) return [];

    let captures = [...session.captures];

    // Apply filters
    if (filters.status) {
      captures = captures.filter((c) => c.responseStatus?.toString() === filters.status);
    }
    if (filters.from) {
      const fromDate = new Date(filters.from);
      captures = captures.filter((c) => new Date(c.timestamp) >= fromDate);
    }
    if (filters.to) {
      const toDate = new Date(filters.to);
      toDate.setHours(23, 59, 59, 999);
      captures = captures.filter((c) => new Date(c.timestamp) <= toDate);
    }
    if (filters.redactionType) {
      // Note: redaction info would need to be fetched separately or included in capture data
      // For now, we skip this filter as it's not available in session.captures
    }

    // Sort by timestamp descending (newest first)
    captures.sort((a, b) => new Date(b.timestamp).getTime() - new Date(a.timestamp).getTime());

    return captures;
  }, [session?.captures, filters]);

  return (
    <MainLayout>
      <div className="space-y-6">
        <div>
          <Link href="/sessions" className="text-sm text-muted-foreground hover:text-foreground">
            ← Back to sessions
          </Link>
          <h1 className="text-3xl font-bold tracking-tight mt-2">
            Session: {session?.sessionId || id || "Unknown"}
          </h1>
        </div>

        {/* Progress Bar */}
        {(loading || progress) && (
          <div className="space-y-2">
            <ProgressBar
              value={loading ? progressPercent : 100}
              indeterminate={loading && progress && progress.total === 0 ? true : undefined}
              height={6}
              className="w-full"
            />
            <div className="flex items-center justify-between text-sm text-muted-foreground">
              <span>{progress?.message || "Loading session..."}</span>
              {progress && progress.total > 0 && (
                <span>{progress.current} / {progress.total} ({progressPercent}%)</span>
              )}
            </div>
          </div>
        )}

        {(captureDetailLoading || captureDetail) ? (
          <div className="space-y-6">
            <div>
              <Link href={`/sessions/${id ?? ""}`} className="text-sm text-muted-foreground hover:text-foreground">
                ← Back to session
              </Link>
              <h2 className="text-3xl font-bold tracking-tight mt-2">
                Capture: {selectedCaptureId ? `#${selectedCaptureId}` : "Loading..."}
              </h2>
            </div>

            {captureDetailLoading && (
              <CaptureSkeleton />
            )}

            {captureDetailError && (
              <div className="rounded-lg border border-destructive bg-destructive/10 p-4">
                <p className="text-destructive">Error: {captureDetailError}</p>
                <p className="text-sm text-muted-foreground mt-2">
                  Please try again or contact support if the problem persists.
                </p>
              </div>
            )}

            {!captureDetailLoading && captureDetail && (
              <>
                <div className="grid gap-6 md:grid-cols-2">
                  <div className="rounded-lg border p-4">
                    <h3 className="font-semibold mb-3">Request Details</h3>
                    <div className="space-y-2 text-sm">
                      <div>
                        <span className="text-muted-foreground">Provider:</span> {captureDetail.provider}
                      </div>
                      <div>
                        <span className="text-muted-foreground">Method:</span> {captureDetail.method}
                      </div>
                      <div>
                        <span className="text-muted-foreground">Target:</span> {captureDetail.targetUrl}
                      </div>
                      <div>
                        <span className="text-muted-foreground">Request Size:</span> {captureDetail.requestBytes.toLocaleString()} bytes
                      </div>
                      <div>
                        <span className="text-muted-foreground">Timestamp:</span> {formatDateTime(captureDetail.timestamp)}
                      </div>
                    </div>
                  </div>

                  <div className="rounded-lg border p-4">
                    <h3 className="font-semibold mb-3">Response Details</h3>
                    <div className="space-y-2 text-sm">
                      <div>
                        <span className="text-muted-foreground">Status:</span> {captureDetail.responseStatus}
                      </div>
                      <div>
                        <span className="text-muted-foreground">Streaming:</span> {captureDetail.responseIsStreaming ? "Yes" : "No"}
                      </div>
                      <div>
                        <span className="text-muted-foreground">Response Size:</span> {captureDetail.responseBytes.toLocaleString()} bytes
                      </div>
                      <div>
                        <span className="text-muted-foreground">Total Time:</span> {captureDetail.timings.total_ms.toLocaleString()} ms
                      </div>
                    </div>
                  </div>
                </div>

                <div className="rounded-lg border p-4">
                  <h3 className="font-semibold mb-3">Request Body</h3>
                  <pre className="rounded bg-muted p-4 text-xs overflow-x-auto max-h-96 whitespace-pre-wrap break-words">
                    {renderJson(captureDetail.requestBody)}
                  </pre>
                </div>

                <div className="rounded-lg border p-4">
                  <h3 className="font-semibold mb-3">Response Body</h3>
                  <pre className="rounded bg-muted p-4 text-xs overflow-x-auto max-h-96 whitespace-pre-wrap break-words">
                    {renderJson(captureDetail.responseBody)}
                  </pre>
                </div>
              </>
            )}
          </div>
        ) : null}

        {!loading && !captureDetailLoading && selectedCaptureId === null && error && (
          <div className="rounded-lg border border-destructive bg-destructive/10 p-4">
            <p className="text-destructive">Error: {error}</p>
            <p className="text-sm text-muted-foreground mt-2">
              Please try again or contact support if the problem persists.
            </p>
          </div>
        )}

        {!loading && !captureDetailLoading && selectedCaptureId === null && !error && session && (
          <>
            <div className="grid gap-6 md:grid-cols-2">
              <div className="rounded-lg border p-4">
                <h3 className="font-semibold mb-3">Request Details</h3>
                <div className="space-y-2 text-sm">
                  <div>
                    <span className="text-muted-foreground">Source:</span> {session.source}
                  </div>
                  <div>
                    <span className="text-muted-foreground">Provider:</span> {session.provider}
                  </div>
                  <div>
                    <span className="text-muted-foreground">Target:</span> {session.targetUrl}
                  </div>
                  <div>
                    <span className="text-muted-foreground">Timestamp:</span> {formatDateTime(session.timestamp)}
                  </div>
                </div>
              </div>

              <div className="rounded-lg border p-4">
                <h3 className="font-semibold mb-3">Response Details</h3>
                <div className="space-y-2 text-sm">
                  <div>
                    <span className="text-muted-foreground">Status:</span> {session.responseStatus}
                  </div>
                  <div>
                    <span className="text-muted-foreground">Streaming:</span> {session.responseIsStreaming ? "Yes" : "No"}
                  </div>
                </div>
              </div>
            </div>

            {session.metrics && (
              <div className="rounded-lg border p-4">
                <h3 className="font-semibold mb-3">Session Metrics</h3>
                <div className="grid gap-4 md:grid-cols-2 lg:grid-cols-4">
                  {/* Total cumulative tokens - new metrics */}
                  <div>
                    <span className="text-muted-foreground">Total Cumulative Input Tokens:</span> <span className="font-medium">
                      {filteredAndSortedCaptures.reduce((sum, c) => sum + (c.metrics?.totalInputTokens ?? 0), 0).toLocaleString()}
                    </span>
                  </div>
                  <div>
                    <span className="text-muted-foreground">Total Cumulative Output Tokens:</span> <span className="font-medium">
                      {filteredAndSortedCaptures.reduce((sum, c) => sum + (c.metrics?.totalOutputTokens ?? 0), 0).toLocaleString()}
                    </span>
                  </div>
                  <div>
                    <span className="text-muted-foreground">Avg Success Count:</span> <span className="font-medium">
                      {filteredAndSortedCaptures.length > 0
                        ? (filteredAndSortedCaptures.reduce((sum, c) => sum + (c.metrics?.successCount ?? 0), 0) / filteredAndSortedCaptures.length).toFixed(2)
                        : "0.00"}
                    </span>
                  </div>
                  <div>
                    <span className="text-muted-foreground">Avg Error Count:</span> <span className="font-medium">
                      {filteredAndSortedCaptures.length > 0
                        ? (filteredAndSortedCaptures.reduce((sum, c) => sum + (c.metrics?.errorCount ?? 0), 0) / filteredAndSortedCaptures.length).toFixed(2)
                        : "0.00"}
                    </span>
                  </div>
                  <div>
                    <span className="text-muted-foreground">Avg Error Rate:</span> <span className="font-medium">
                      {filteredAndSortedCaptures.length > 0
                        ? (filteredAndSortedCaptures.reduce((sum, c) => sum + (c.metrics?.errorRate ?? 0), 0) / filteredAndSortedCaptures.length).toFixed(4)
                        : "0.0000"}
                    </span>
                  </div>
                  <div>
                    <span className="text-muted-foreground">Avg Input Tokens:</span> <span className="font-medium">
                      {filteredAndSortedCaptures.length > 0
                        ? (filteredAndSortedCaptures.reduce((sum, c) => sum + (c.metrics?.totalInputTokens ?? 0), 0) / filteredAndSortedCaptures.length).toFixed(2)
                        : "0.00"}
                    </span>
                  </div>
                  <div>
                    <span className="text-muted-foreground">Avg Output Tokens:</span> <span className="font-medium">
                      {filteredAndSortedCaptures.length > 0
                        ? (filteredAndSortedCaptures.reduce((sum, c) => sum + (c.metrics?.totalOutputTokens ?? 0), 0) / filteredAndSortedCaptures.length).toFixed(2)
                        : "0.00"}
                    </span>
                  </div>
                  <div>
                    <span className="text-muted-foreground">Avg Tokens / Second:</span> <span className="font-medium">
                      {filteredAndSortedCaptures.length > 0
                        ? (filteredAndSortedCaptures.reduce((sum, c) => sum + (c.metrics?.tokensPerSecond ?? 0), 0) / filteredAndSortedCaptures.length).toFixed(2)
                        : "0.00"}
                    </span>
                  </div>
                  <div>
                    <span className="text-muted-foreground">Avg Redactions:</span> <span className="font-medium">
                      {filteredAndSortedCaptures.length > 0
                        ? (filteredAndSortedCaptures.reduce((sum, c) => sum + (c.metrics?.totalRedactions ?? 0), 0) / filteredAndSortedCaptures.length).toFixed(2)
                        : "0.00"}
                    </span>
                  </div>
                </div>
              </div>
            )}

            {session.redactionStats && session.redactionStats.totalRedactions > 0 && (
              <div className="rounded-lg border p-4">
                <h3 className="font-semibold mb-3">Redaction Statistics</h3>
                <div className="space-y-2">
                  <div className="text-sm">
                    <span
                      className="text-muted-foreground"
                      title="Sum of all redactions across every capture in this session. Multiple captures with the same placeholder are all counted."
                    >
                      Total Cumulative Redactions:
                    </span> <span
                      title="Sum of all redactions across every capture in this session. Multiple captures with the same placeholder are all counted."
                    >
                      {session.redactionStats.totalRedactions}
                    </span>
                  </div>
                  {session.redactionStats.uniqueRedactions !== undefined && session.redactionStats.uniqueRedactions > 0 && (
                    <div className="text-sm text-blue-600">
                      <span
                        className="text-muted-foreground"
                        title="Deduplicated count: for each placeholder type, takes the maximum count found in any single capture within this session, then sums across placeholder types. Matches the 'Unique per Session' metric on the Metrics page."
                      >
                        Unique Redactions (per rule max):
                      </span> <span
                        title="Deduplicated count: for each placeholder type, takes the maximum count found in any single capture within this session, then sums across placeholder types. Matches the 'Unique per Session' metric on the Metrics page."
                      >
                        {session.redactionStats.uniqueRedactions}
                      </span>
                    </div>
                  )}
                  {Object.keys(session.redactionStats.byRule).length > 0 && (
                    <div className="text-sm">
                      <span className="text-muted-foreground">By Rule:</span>
                      <ul className="ml-2 mt-1 list-disc list-inside">
                        {Object.entries(session.redactionStats.byRule).map(([rule, count]) => (
                          <li key={rule}>
                            <span className="font-medium">{rule}:</span> <span
                              title="Max count of this placeholder in any single capture within this session."
                            >
                              {count}
                            </span>
                          </li>
                        ))}
                      </ul>
                    </div>
                  )}
                </div>
              </div>
            )}

            {session.contextValues && Object.keys(session.contextValues).length > 0 && (
              <div className="rounded-lg border p-4">
                <h3 className="font-semibold mb-3">Context Values</h3>
                <div className="max-h-64 overflow-y-auto">
                  <table className="w-full text-sm">
                    <thead>
                      <tr className="border-b">
                        <th className="text-left py-2">Key</th>
                        <th className="text-left py-2">Value</th>
                      </tr>
                    </thead>
                    <tbody>
                      {Object.entries(session.contextValues).map(([key, value]) => (
                        <tr key={key} className="border-b">
                          <td className="py-2 font-mono text-xs">{key}</td>
                          <td className="py-2 font-mono text-xs max-w-xs truncate">
                            {typeof value === "string" ? value : JSON.stringify(value)}
                          </td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
              </div>
            )}

            {filteredAndSortedCaptures.length > 0 && (
              <div className="rounded-lg border p-4">
                <div className="flex items-center justify-between mb-4">
                  <h3 className="font-semibold">Capture Breakdown</h3>
                  {hasActiveFilters && (
                    <button
                      onClick={clearFilters}
                      className="text-sm text-muted-foreground hover:text-foreground underline"
                    >
                      Clear filters
                    </button>
                  )}
                </div>

                {/* Filters */}
                <div className="rounded-lg border p-4 mb-4 bg-muted/30">
                  <div className="grid grid-cols-1 gap-4 md:grid-cols-2 lg:grid-cols-3">
                    <div>
                      <label htmlFor="status" className="block text-sm font-medium mb-1">
                        Status
                      </label>
                      <select
                        id="status"
                        value={filters.status}
                        onChange={(e) => handleFilterChange("status", e.target.value)}
                        className="w-full rounded-md border border-input bg-background px-3 py-2 text-sm"
                      >
                        <option value="">All statuses</option>
                        <option value="200">200</option>
                        <option value="201">201</option>
                        <option value="400">400</option>
                        <option value="401">401</option>
                        <option value="403">403</option>
                        <option value="404">404</option>
                        <option value="500">500</option>
                        <option value="502">502</option>
                        <option value="503">503</option>
                      </select>
                    </div>
                    <div>
                      <label htmlFor="from" className="block text-sm font-medium mb-1">
                        From Date
                      </label>
                      <input
                        id="from"
                        type="date"
                        value={filters.from}
                        onChange={(e) => handleFilterChange("from", e.target.value)}
                        className="w-full rounded-md border border-input bg-background px-3 py-2 text-sm"
                      />
                    </div>
                    <div>
                      <label htmlFor="to" className="block text-sm font-medium mb-1">
                        To Date
                      </label>
                      <input
                        id="to"
                        type="date"
                        value={filters.to}
                        onChange={(e) => handleFilterChange("to", e.target.value)}
                        className="w-full rounded-md border border-input bg-background px-3 py-2 text-sm"
                      />
                    </div>
                    <div>
                      <label htmlFor="redactionType" className="block text-sm font-medium mb-1">
                        Redaction Type
                      </label>
                      <select
                        id="redactionType"
                        value={filters.redactionType}
                        onChange={(e) => handleFilterChange("redactionType", e.target.value)}
                        className="w-full rounded-md border border-input bg-background px-3 py-2 text-sm"
                      >
                        <option value="">All types</option>
                        <option value="email">Email</option>
                        <option value="api_key">API Key</option>
                        <option value="password">Password</option>
                        <option value="token">Token</option>
                        <option value="phone">Phone</option>
                        <option value="ssn">SSN</option>
                      </select>
                    </div>
                  </div>
                </div>

                <div className="overflow-x-auto">
                  <table className="w-full text-sm">
                    <thead>
                      <tr className="border-b">
                        <th className="text-left py-2">Timestamp</th>
                        <th className="text-left py-2">Capture</th>
                        <th className="text-right py-2">Req (bytes)</th>
                        <th className="text-right py-2">Res (bytes)</th>
                        <th className="text-right py-2">Total (bytes)</th>
                        <th className="text-left py-2">Status</th>
                        <th className="text-left py-2">Time</th>
                        <th className="text-right py-2">Success</th>
                        <th className="text-right py-2">Error</th>
                        <th className="text-right py-2">Error Rate</th>
                        <th className="text-left py-2">Model</th>
                        <th className="text-right py-2">Input Tokens</th>
                        <th className="text-right py-2">Output Tokens</th>
                        <th className="text-right py-2">Tokens/sec</th>
                        <th className="text-right py-2">Redactions</th>
                      </tr>
                    </thead>
                    <tbody>
                      {filteredAndSortedCaptures.map((capture) => (
                        <tr key={capture.id} className="border-b">
                          <td className="py-2 text-xs">{formatDateTime(capture.timestamp)}</td>
                          <td className="py-2 font-mono text-xs">
                            <Link href={`/sessions/${session.sessionId}?captureId=${capture.id}`} className="text-primary hover:underline">{capture.id}</Link>
                          </td>
                          <td className="py-2 text-right font-mono text-xs">{capture.requestBytes.toLocaleString()}</td>
                          <td className="py-2 text-right font-mono text-xs">{capture.responseBytes.toLocaleString()}</td>
                          <td className="py-2 text-right font-mono text-xs">{(capture.requestBytes + capture.responseBytes).toLocaleString()}</td>
                          <td className="py-2 text-xs">{capture.responseStatus ?? "—"}</td>
                          <td className="py-2 text-xs">{capture.timings.total_ms.toLocaleString()} ms</td>
                          <td className="py-2 text-right font-mono text-xs">{capture.metrics?.successCount ?? 0}</td>
                          <td className="py-2 text-right font-mono text-xs">{capture.metrics?.errorCount ?? 0}</td>
                          <td className="py-2 text-right font-mono text-xs">{(capture.metrics?.errorRate ?? 0).toFixed(2)}</td>
                          <td className="py-2 text-left text-xs font-mono text-muted-foreground">{capture.metrics?.model ?? "—"}</td>
                          <td className="py-2 text-right font-mono text-xs">{capture.metrics?.totalInputTokens.toLocaleString() ?? 0}</td>
                          <td className="py-2 text-right font-mono text-xs">{capture.metrics?.totalOutputTokens.toLocaleString() ?? 0}</td>
                          <td className="py-2 text-right font-mono text-xs">{capture.metrics?.tokensPerSecond.toLocaleString() ?? 0}</td>
                          <td className="py-2 text-right font-mono text-xs">{capture.metrics?.totalRedactions ?? 0}</td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
              </div>
            )}
          </>
        )}

        {!error && !session && (
          <div className="flex flex-col items-center justify-center rounded-lg border border-dashed p-12">
            <svg className="h-12 w-12 text-muted-foreground mb-4" fill="none" stroke="currentColor" viewBox="0 0 24 24">
              <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M9 5H7a2 2 0 00-2 2v12a2 2 0 002 2h5.5a2 2 0 002-2V9a2 2 0 00-2-2z" />
            </svg>
            <h3 className="font-semibold mb-2">Session not found</h3>
            <p className="text-sm text-muted-foreground">
              The requested session could not be found. It may have been deleted or the ID is incorrect.
            </p>
          </div>
        )}
      </div>
    </MainLayout>
  );
}

export default function SessionDetailPage({
  params,
}: {
  params: Promise<{ id: string }>;
}) {
  return (
    <Suspense fallback={<div>Loading…</div>}>
      <SessionView params={params} />
    </Suspense>
  );
}