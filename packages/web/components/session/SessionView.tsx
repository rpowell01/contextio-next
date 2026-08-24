"use client";

import { useState, useEffect, useMemo } from "react";
import Link from "next/link";
import { useSearchParams } from "next/navigation";
import { MainLayout } from "@/components/main-layout";
import { formatDateTime, safeJsonStringify } from "@/lib/utils";
import { apiClient } from "@/lib/api";
import type { SessionDetail } from "@/types/api";
import { RedactionBadges } from "@/components/session/RedactionBadges";
import { RedactionPanel } from "@/components/session/RedactionPanel";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";

interface CaptureFilters {
  source: string;
  status: string;
  from: string;
  to: string;
  redactionType: string;
}

const DEFAULT_FILTERS: CaptureFilters = {
  source: "",
  status: "",
  from: "",
  to: "",
  redactionType: "",
};

export default function SessionView({
  params,
}: {
  params: Promise<{ id: string }>;
}) {
  const [session, setSession] = useState<SessionDetail | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [id, setId] = useState<string | null>(null);
  const [selectedCaptureId, setSelectedCaptureId] = useState<string | null>(null);
  const [filters, setFilters] = useState<CaptureFilters>(DEFAULT_FILTERS);
  const searchParams = useSearchParams();

  const queryCaptureId = searchParams.get("captureId");

  useEffect(() => {
    const unwrapParams = async () => {
      try {
        const resolved = await params;
        setId(resolved.id);
      } catch {
        setError("Failed to read session id");
      }
    };
    unwrapParams();
  }, [params]);

  useEffect(() => {
    if (!queryCaptureId) {
      setSelectedCaptureId(null);
      return;
    }
    setSelectedCaptureId(queryCaptureId);
  }, [queryCaptureId]);

  useEffect(() => {
    if (!id) return;
    let cancelled = false;

    const fetchSession = async () => {
      setLoading(true);
      setError(null);
      try {
        const data = await apiClient.getSession(id);
        if (!cancelled) {
          setSession(data);
        }
      } catch (e) {
        if (!cancelled) {
          setError(e instanceof Error ? e.message : "Unknown error");
        }
      } finally {
        if (!cancelled) {
          setLoading(false);
        }
      }
    };

    fetchSession();

    return () => {
      cancelled = true;
    };
  }, [id]);

  const captures = useMemo(() => {
    if (!session?.captures) {
      return [];
    }
    return [...session.captures].sort(
      (a, b) => new Date(b.timestamp).getTime() - new Date(a.timestamp).getTime(),
    );
  }, [session?.captures]);

  const filteredCaptures = useMemo(() => {
    if (!captures) return [];
    return captures.filter((capture) => {
      if (filters.source && capture.source !== filters.source) return false;
      if (filters.status && capture.responseStatus?.toString() !== filters.status) return false;
      if (filters.from && new Date(capture.timestamp) < new Date(filters.from)) return false;
      if (filters.to && new Date(capture.timestamp) > new Date(new Date(filters.to).setHours(23, 59, 59, 999))) return false;
      if (filters.redactionType) {
        const byRule = capture.redactionStats?.byRule ?? {};
        if (!Object.keys(byRule).includes(filters.redactionType)) return false;
      }
      return true;
    });
  }, [captures, filters]);

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

        {!loading && session && (
          <div className="rounded-lg border p-4 mb-4">
            <h3 className="font-semibold mb-3">Capture Filters</h3>
            <div className="grid gap-4 md:grid-cols-5">
              <div>
                <label className="text-sm text-muted-foreground">Source</label>
                <Select value={filters.source} onValueChange={(value) => setFilters({ ...filters, source: value })}>
                  <SelectTrigger className="mt-1">
                    <SelectValue placeholder="All Sources" />
                  </SelectTrigger>
                  <SelectContent>
                    <SelectItem value="">All Sources</SelectItem>
                    {session.captures &&
                      [...new Set(
                        session.captures.map((c) => c.source).filter((s): s is string => typeof s === "string"),
                      )].map(
                        (source) => (
                          <SelectItem key={source} value={source}>
                            {source}
                          </SelectItem>
                        ),
                      )}
                  </SelectContent>
                </Select>
              </div>
              <div>
                <label className="text-sm text-muted-foreground">Status</label>
                <Select value={filters.status} onValueChange={(value) => setFilters({ ...filters, status: value })}>
                  <SelectTrigger className="mt-1">
                    <SelectValue placeholder="All Status" />
                  </SelectTrigger>
                  <SelectContent>
                    <SelectItem value="">All Status</SelectItem>
                    <SelectItem value="200">200 OK</SelectItem>
                    <SelectItem value="400">400 Bad Request</SelectItem>
                    <SelectItem value="401">401 Unauthorized</SelectItem>
                    <SelectItem value="403">403 Forbidden</SelectItem>
                    <SelectItem value="404">404 Not Found</SelectItem>
                    <SelectItem value="500">500 Server Error</SelectItem>
                  </SelectContent>
                </Select>
              </div>
              <div>
                <label className="text-sm text-muted-foreground">From</label>
                <input
                  type="datetime-local"
                  value={filters.from}
                  onChange={(e) => setFilters({ ...filters, from: e.target.value })}
                  className="mt-1 w-full rounded-md border border-input bg-background px-3 py-2 text-sm"
                />
              </div>
              <div>
                <label className="text-sm text-muted-foreground">To</label>
                <input
                  type="datetime-local"
                  value={filters.to}
                  onChange={(e) => setFilters({ ...filters, to: e.target.value })}
                  className="mt-1 w-full rounded-md border border-input bg-background px-3 py-2 text-sm"
                />
              </div>
              <div>
                <label className="text-sm text-muted-foreground">Redaction Type</label>
                <Select value={filters.redactionType} onValueChange={(value) => setFilters({ ...filters, redactionType: value })}>
                  <SelectTrigger className="mt-1">
                    <SelectValue placeholder="All Types" />
                  </SelectTrigger>
                  <SelectContent>
                    <SelectItem value="">All Types</SelectItem>
                    {session.captures &&
                      [...new Set(
                        session.captures
                          .flatMap((c) =>
                            Object.keys(c.redactionStats?.byRule ?? {}),
                          )
                          .filter((r): r is string => typeof r === "string"),
                      )].map((rule) => (
                        <SelectItem key={rule} value={rule}>
                          {rule.replace(/_/g, " ")}
                        </SelectItem>
                      ))}
                  </SelectContent>
                </Select>
              </div>
            </div>
          </div>
        )}

        {loading && (
          <div className="space-y-4">
            {[...Array(4)].map((_, i) => (
              <div key={i} className="rounded-lg border p-4">
                <div className="h-4 bg-muted-foreground/20 rounded mb-2" style={{ width: "200px" }} />
                <div className="h-64 bg-muted/20 rounded" />
              </div>
            ))}
          </div>
        )}

        <RedactionPanel captureId={selectedCaptureId} />

        {!loading && selectedCaptureId === null && error && (
          <div className="rounded-lg border border-destructive bg-destructive/10 p-4">
            <p className="text-destructive">Error: {error}</p>
            <p className="text-sm text-muted-foreground mt-2">
              Please try again or contact support if the problem persists.
            </p>
          </div>
        )}

        {!loading && selectedCaptureId === null && !error && session && (
          <>
            <div className="grid gap-6 md:grid-cols-2">
              <div className="rounded-lg border p-4">
                <h3 className="font-semibold mb-3">Request Details</h3>
                <div className="space-y-2 text-sm">
                  <div>
                    <span className="text-muted-foreground">Source:</span>{" "}
                    {session.source}
                  </div>
                  <div>
                    <span className="text-muted-foreground">Provider:</span>{" "}
                    {session.provider}
                  </div>
                  <div>
                    <span className="text-muted-foreground">Target:</span>{" "}
                    {session.targetUrl}
                  </div>
                  <div>
                    <span className="text-muted-foreground">Timestamp:</span>{" "}
                    {formatDateTime(session.timestamp)}
                  </div>
                </div>
              </div>

              <div className="rounded-lg border p-4">
                <h3 className="font-semibold mb-3">Response Details</h3>
                <div className="space-y-2 text-sm">
                  <div>
                    <span className="text-muted-foreground">Status:</span>{" "}
                    {session.responseStatus}
                  </div>
                  <div>
                    <span className="text-muted-foreground">Streaming:</span>{" "}
                    {session.responseIsStreaming ? "Yes" : "No"}
                  </div>
                </div>
              </div>
            </div>

            {session.metrics && (
              <div className="rounded-lg border p-4">
                <h3 className="font-semibold mb-3">Session Metrics (Average per Capture)</h3>
                <div className="grid gap-4 md:grid-cols-2 lg:grid-cols-3">
                  <div>
                    <span className="text-muted-foreground">Avg Success Count:</span>{" "}
                    <span className="font-medium">
                      {filteredCaptures.length > 0
                        ? (
                            filteredCaptures.reduce(
                              (sum, c) => sum + (c.metrics?.successCount ?? 0),
                              0,
                            ) / filteredCaptures.length
                          ).toFixed(2)
                        : "0.00"}
                    </span>
                  </div>
                  <div>
                    <span className="text-muted-foreground">Avg Error Count:</span>{" "}
                    <span className="font-medium">
                      {filteredCaptures.length > 0
                        ? (
                            filteredCaptures.reduce(
                              (sum, c) => sum + (c.metrics?.errorCount ?? 0),
                              0,
                            ) / filteredCaptures.length
                          ).toFixed(2)
                        : "0.00"}
                    </span>
                  </div>
                  <div>
                    <span className="text-muted-foreground">Avg Error Rate:</span>{" "}
                    <span className="font-medium">
                      {filteredCaptures.length > 0
                        ? (
                            filteredCaptures.reduce(
                              (sum, c) => sum + (c.metrics?.errorRate ?? 0),
                              0,
                            ) / filteredCaptures.length
                          ).toFixed(4)
                        : "0.0000"}
                    </span>
                  </div>
                  <div>
                    <span className="text-muted-foreground">Avg Context Values:</span>{" "}
                    <span className="font-medium">
                      {filteredCaptures.length > 0
                        ? (
                            filteredCaptures.reduce(
                              (sum, c) => sum + (c.metrics?.totalContextValues ?? 0),
                              0,
                            ) / filteredCaptures.length
                          ).toFixed(2)
                        : "0.00"}
                    </span>
                  </div>
                  <div>
                    <span className="text-muted-foreground">Avg Input Tokens:</span>{" "}
                    <span className="font-medium">
                      {filteredCaptures.length > 0
                        ? (
                            filteredCaptures.reduce(
                              (sum, c) => sum + (c.metrics?.totalInputTokens ?? 0),
                              0,
                            ) / filteredCaptures.length
                          ).toFixed(2)
                        : "0.00"}
                    </span>
                  </div>
                  <div>
                    <span className="text-muted-foreground">Avg Output Tokens:</span>{" "}
                    <span className="font-medium">
                      {filteredCaptures.length > 0
                        ? (
                            filteredCaptures.reduce(
                              (sum, c) => sum + (c.metrics?.totalOutputTokens ?? 0),
                              0,
                            ) / filteredCaptures.length
                          ).toFixed(2)
                        : "0.00"}
                    </span>
                  </div>
                  <div>
                    <span className="text-muted-foreground">Avg Tokens / Second:</span>{" "}
                    <span className="font-medium">
                      {filteredCaptures.length > 0
                        ? (
                            filteredCaptures.reduce(
                              (sum, c) => sum + (c.metrics?.tokensPerSecond ?? 0),
                              0,
                            ) / filteredCaptures.length
                          ).toFixed(2)
                        : "0.00"}
                    </span>
                  </div>
                  <div>
                    <span className="text-muted-foreground">Avg Redactions:</span>{" "}
                    <span className="font-medium">
                      {filteredCaptures.length > 0
                        ? (
                            filteredCaptures.reduce(
                              (sum, c) => sum + (c.metrics?.totalRedactions ?? 0),
                              0,
                            ) / filteredCaptures.length
                          ).toFixed(2)
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
                    <span className="text-muted-foreground">Total Redactions:</span>{" "}
                    {session.redactionStats.totalRedactions}
                  </div>
                  {Object.keys(session.redactionStats.byRule).length > 0 && (
                    <div className="text-sm">
                      <span className="text-muted-foreground">By Rule:</span>
                      <ul className="ml-2 mt-1 list-disc list-inside">
                        {Object.entries(session.redactionStats.byRule).map(([rule, count]) => (
                          <li key={rule}>
                            <span className="font-medium">{rule}:</span> {count}
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
                            {typeof value === "string" ? value : value === undefined ? "" : safeJsonStringify(value)}
                          </td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
              </div>
            )}

            {filteredCaptures.length > 0 && (
              <div className="rounded-lg border p-4">
                <div className="flex items-center justify-between mb-4">
                  <h3 className="font-semibold">Capture Breakdown</h3>
                </div>

                <div className="overflow-x-auto">
                  <table className="w-full text-sm">
                    <thead>
                      <tr className="border-b">
                        <th className="text-left py-2">Capture</th>
                        <th className="text-left py-2">Timestamp</th>
                        <th className="text-right py-2">Req (bytes)</th>
                        <th className="text-right py-2">Res (bytes)</th>
                        <th className="text-right py-2">Total (bytes)</th>
                        <th className="text-left py-2">Status</th>
                        <th className="text-left py-2">Time</th>
                        <th className="text-right py-2">Success</th>
                        <th className="text-right py-2">Error</th>
                        <th className="text-right py-2">Error Rate</th>
                        <th className="text-right py-2">Context Values</th>
                        <th className="text-left py-2">Model</th>
                        <th className="text-right py-2">Input Tokens</th>
                        <th className="text-right py-2">Output Tokens</th>
                        <th className="text-right py-2">Tokens/sec</th>
                        <th className="text-left py-2">Redactions</th>
                      </tr>
                    </thead>
                    <tbody>
                      {filteredCaptures.map((capture) => (
                        <tr
                          key={capture.id}
                          className="border-b cursor-pointer hover:bg-accent/50 transition-colors"
                          onClick={() => setSelectedCaptureId(capture.id)}
                        >
                          <td className="py-2 font-mono text-xs">
                            <Link
                              href={`/sessions/${session.sessionId}?captureId=${capture.id}`}
                              className="text-primary hover:underline"
                              onClick={(event) => event.stopPropagation()}
                            >
                              {capture.id}
                            </Link>
                          </td>
                          <td className="py-2 text-xs">{formatDateTime(capture.timestamp)}</td>
                          <td className="py-2 text-right font-mono text-xs">
                            {capture.requestBytes.toLocaleString()}
                          </td>
                          <td className="py-2 text-right font-mono text-xs">
                            {capture.responseBytes.toLocaleString()}
                          </td>
                          <td className="py-2 text-right font-mono text-xs">
                            {(capture.requestBytes + capture.responseBytes).toLocaleString()}
                          </td>
                          <td className="py-2 text-xs">{capture.responseStatus ?? "—"}</td>
                          <td className="py-2 text-xs">{capture.timings.total_ms.toLocaleString()} ms</td>
                          <td className="py-2 text-right font-mono text-xs">
                            {capture.metrics?.successCount ?? 0}
                          </td>
                          <td className="py-2 text-right font-mono text-xs">
                            {capture.metrics?.errorCount ?? 0}
                          </td>
                          <td className="py-2 text-right font-mono text-xs">
                            {(capture.metrics?.errorRate ?? 0).toFixed(2)}
                          </td>
                          <td className="py-2 text-right font-mono text-xs">
                            {capture.metrics?.totalContextValues ?? 0}
                          </td>
                          <td className="py-2 text-left text-xs font-mono text-muted-foreground">
                            {capture.metrics?.model ?? "—"}
                          </td>
                          <td className="py-2 text-right font-mono text-xs">
                            {(capture.metrics?.totalInputTokens ?? 0).toLocaleString()}
                          </td>
                          <td className="py-2 text-right font-mono text-xs">
                            {(capture.metrics?.totalOutputTokens ?? 0).toLocaleString()}
                          </td>
                          <td className="py-2 text-right font-mono text-xs">
                            {(capture.metrics?.tokensPerSecond ?? 0).toLocaleString()}
                          </td>
                          <td className="py-2">
                            <RedactionBadges stats={capture.redactionStats} />
                          </td>
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
            <svg
              className="h-12 w-12 text-muted-foreground mb-4"
              fill="none"
              stroke="currentColor"
              viewBox="0 0 24 24"
            >
              <path
                strokeLinecap="round"
                strokeLinejoin="round"
                strokeWidth={2}
                d="M9 5H7a2 2 0 00-2 2v12a2 2 0 002 2h5.5a2 2 0 002-2V9a2 2 0 00-2-2z"
              />
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