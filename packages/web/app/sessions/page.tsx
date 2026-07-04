"use client";

import { MainLayout } from "@/components/main-layout";
import { apiClient } from "@/lib/api";
import { formatDateTime } from "@/lib/utils";
import type { Capture, CaptureWithRedaction, SessionSummary, PaginationMeta } from "@/types/api";
import Link from "next/link";
import { useState, useEffect, useCallback } from "react";

const DEFAULT_CAPTURE_PAGE_SIZE = 20;

interface CaptureFilters {
  sessionId: string;
  source: string;
  status: string;
  from: string;
  to: string;
  redactionType: string;
}

interface PaginationPage {
  page: number;
  isEllipsis?: boolean;
}

function generatePaginationPages(current_page: number, total_pages: number): PaginationPage[] {
  const pages: PaginationPage[] = [];
  const maxVisiblePages = 5;

  if (total_pages <= maxVisiblePages) {
    for (let i = 1; i <= total_pages; i++) {
      pages.push({ page: i });
    }
  } else {
    pages.push({ page: 1 });

    if (current_page <= 3) {
      pages.push({ page: 2 }, { page: 3 });
      pages.push({ page: -1, isEllipsis: true } as const);
      pages.push({ page: total_pages - 1 }, { page: total_pages });
    } else if (current_page >= total_pages - 2) {
      pages.push({ page: 2 });
      pages.push({ page: -1, isEllipsis: true } as const);
      pages.push({ page: total_pages - 2 }, { page: total_pages - 1 }, { page: total_pages });
    } else {
      pages.push({ page: -1, isEllipsis: true } as const);
      pages.push({ page: current_page - 1 });
      pages.push({ page: current_page });
      pages.push({ page: current_page + 1 });
      pages.push({ page: -1, isEllipsis: true } as const);
      pages.push({ page: total_pages });
    }
  }

  return pages;
}

export default function SessionsPage() {
  // Sessions list state
  const [summaries, setSummaries] = useState<SessionSummary[]>([]);
  const [sessionsError, setSessionsError] = useState<string | null>(null);
  const [sessionsLoading, setSessionsLoading] = useState(true);

  // Captures state
  const [captures, setCaptures] = useState<(Capture | CaptureWithRedaction)[]>([]);
  const [capturesPagination, setCapturesPagination] = useState<PaginationMeta | null>(null);
  const [capturesError, setCapturesError] = useState<string | null>(null);
  const [capturesLoading, setCapturesLoading] = useState(true);
  const [capturePageSize, setCapturePageSize] = useState(DEFAULT_CAPTURE_PAGE_SIZE);
  const [filters, setFilters] = useState<CaptureFilters>({
    sessionId: "",
    source: "",
    status: "",
    from: "",
    to: "",
    redactionType: "",
  });

  const fetchCaptures = useCallback(async (page: number, pageSizeParam: number) => {
    setCapturesLoading(true);
    setCapturesError(null);
    try {
      const response = await apiClient.getCaptures({
        page,
        pageSize: pageSizeParam,
        sessionId: filters.sessionId || undefined,
        source: filters.source || undefined,
        status: filters.status || undefined,
        from: filters.from || undefined,
        to: filters.to || undefined,
        redactionType: filters.redactionType || undefined,
      });
      setCaptures(response.data);
      setCapturesPagination(response.pagination ?? null);
    } catch (e) {
      setCapturesError(e instanceof Error ? e.message : "Unknown error");
    } finally {
      setCapturesLoading(false);
    }
  }, [filters]);

  useEffect(() => {
    fetchCaptures(1, capturePageSize);
  }, [fetchCaptures, capturePageSize]);

  useEffect(() => {
    async function fetchSessions() {
      try {
        setSessionsLoading(true);
        const data = await apiClient.getGroupedSessions();
        setSummaries(data.summaries);
        setSessionsError(null);
      } catch (e) {
        setSessionsError(e instanceof Error ? e.message : "Unknown error");
      } finally {
        setSessionsLoading(false);
      }
    }
    fetchSessions();
  }, []);

  const handleFilterChange = (key: keyof CaptureFilters, value: string) => {
    setFilters((prev) => ({ ...prev, [key]: value }));
  };

  const clearFilters = () => {
    setFilters({
      sessionId: "",
      source: "",
      status: "",
      from: "",
      to: "",
      redactionType: "",
    });
  };

  const hasActiveFilters = Object.values(filters).some((v) => v !== "");

  const handleApplyFilters = () => {
    fetchCaptures(1, capturePageSize);
  };

  return (
    <MainLayout>
      <div className="space-y-6">
        <div className="flex items-center justify-between">
          <div>
            <h1 className="text-3xl font-bold tracking-tight">Sessions</h1>
            <p className="text-muted-foreground">Captured API request/response pairs</p>
          </div>
        </div>

        {/* Captures Section */}
        <div className="space-y-4">
          <h2 className="text-xl font-semibold">Captures</h2>

          {/* Filters */}
          <div className="rounded-lg border p-4">
            <div className="flex items-center justify-between mb-4">
              <h3 className="text-lg font-semibold">Filters</h3>
              {hasActiveFilters && (
                <button
                  onClick={clearFilters}
                  className="text-sm text-muted-foreground hover:text-foreground underline"
                >
                  Clear filters
                </button>
              )}
            </div>
            <div className="grid grid-cols-1 gap-4 md:grid-cols-2 lg:grid-cols-3">
              <div>
                <label htmlFor="sessionId" className="block text-sm font-medium mb-1">
                  Session ID
                </label>
                <input
                  id="sessionId"
                  type="text"
                  placeholder="Enter session ID..."
                  value={filters.sessionId}
                  onChange={(e) => handleFilterChange("sessionId", e.target.value)}
                  className="w-full rounded-md border border-input bg-background px-3 py-2 text-sm"
                />
              </div>
              <div>
                <label htmlFor="source" className="block text-sm font-medium mb-1">
                  Source
                </label>
                <input
                  id="source"
                  type="text"
                  placeholder="Enter source..."
                  value={filters.source}
                  onChange={(e) => handleFilterChange("source", e.target.value)}
                  className="w-full rounded-md border border-input bg-background px-3 py-2 text-sm"
                />
              </div>
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
            <div className="mt-4 flex items-center justify-between">
              <div className="flex items-center gap-2">
                <label htmlFor="capturePageSize" className="text-sm text-muted-foreground">
                  Per page:
                </label>
                <select
                  id="capturePageSize"
                  value={capturePageSize}
                  onChange={(e) => {
                    const newPageSize = parseInt(e.target.value, 10);
                    setCapturePageSize(newPageSize);
                  }}
                  className="rounded border border-input bg-background px-2 py-1 text-sm"
                >
                  <option value={10}>10</option>
                  <option value={20}>20</option>
                  <option value={50}>50</option>
                  <option value={100}>100</option>
                </select>
              </div>
              <div className="flex items-center gap-2">
                <button
                  onClick={clearFilters}
                  className="rounded-md border border-input bg-background px-3 py-1.5 text-sm hover:bg-accent"
                >
                  Reset
                </button>
                <button
                  onClick={handleApplyFilters}
                  className="rounded-md bg-primary px-4 py-1.5 text-sm font-medium text-primary-foreground hover:bg-primary/90"
                >
                  Apply Filters
                </button>
              </div>
            </div>
          </div>

          {capturesError && (
            <div className="rounded-lg border border-destructive bg-destructive/10 p-4">
              <p className="text-destructive">Error: {capturesError}</p>
              <button
                onClick={() => fetchCaptures(capturesPagination?.page ?? 1, capturePageSize)}
                className="mt-2 text-sm underline hover:no-underline"
              >
                Try again
              </button>
            </div>
          )}

          {capturesLoading && !capturesError ? (
            <div className="space-y-4">
              {[...Array(5)].map((_, i) => (
                <div key={i} className="flex items-center justify-between rounded-lg border p-4">
                  <div className="flex items-center gap-4">
                    <div className="rounded-full bg-muted p-3">
                      <div className="h-5 w-5 bg-muted-foreground/20 rounded" />
                    </div>
                    <div>
                      <div className="h-4 bg-muted-foreground/20 rounded mb-1" style={{ width: "200px" }} />
                      <div className="h-3 bg-muted-foreground/10 rounded" style={{ width: "150px" }} />
                    </div>
                  </div>
                  <div className="text-right">
                    <div className="h-3 bg-muted-foreground/20 rounded mb-1" style={{ width: "60px" }} />
                    <div className="h-3 bg-muted-foreground/10 rounded" style={{ width: "100px" }} />
                  </div>
                </div>
              ))}
            </div>
          ) : !capturesError && captures.length === 0 ? (
            <div className="flex flex-col items-center justify-center rounded-lg border border-dashed p-12">
              <svg className="h-12 w-12 text-muted-foreground mb-4" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M7 10h10M7 14h6m-1 8l-4-4m0 0l4-4" />
              </svg>
              <h3 className="font-semibold mb-2">No captures yet</h3>
              <p className="text-sm text-muted-foreground">Start the logger plugin to capture API requests.</p>
            </div>
          ) : (
            <div className="space-y-4">
              {captures.map((capture) => (
<Link
                    key={capture.id}
                    href={`/sessions/${capture.sessionId ?? "unknown"}?captureId=${capture.id}`}
                    className="flex items-center justify-between rounded-lg border p-4 hover:bg-accent transition-colors"
                  >
                  <div className="flex items-center gap-4">
                    <div className="rounded-full bg-primary/10 p-3">
                      <svg className="h-5 w-5 text-primary" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                        <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M9 5H7a2 2 0 00-2 2v12a2 2 0 002 2h5.5a2 2 0 002-2V9a2 2 0 00-2-2z" />
                      </svg>
                    </div>
                    <div>
                      <div className="font-medium">
                        {capture.provider} - {capture.method}
                      </div>
                      <div className="text-sm text-muted-foreground">
                        Status: {capture.responseStatus} • Source: {capture.source ?? "Unknown"}
                        {"redaction" in capture && capture.redaction && (
                          <span className="ml-2 text-indigo-600">
                            • {capture.redaction.totalRedactions} redactions
                          </span>
                        )}
                      </div>
                    </div>
                  </div>
                  <div className="text-right">
                    <div className="text-sm font-mono">#{capture.sessionId?.slice(0, 8) ?? "N/A"}</div>
                    <div className="text-xs text-muted-foreground">{formatDateTime(capture.timestamp)}</div>
                  </div>
                </Link>
              ))}
            </div>
          )}

          {/* Pagination Controls */}
          {capturesPagination && capturesPagination.totalPages > 1 && (
            <div className="flex items-center justify-between border-t pt-4">
              <div className="text-sm text-muted-foreground">
                Showing {captures.length} of {capturesPagination.total} captures
              </div>
              <div className="flex items-center gap-2">
                <button
                  onClick={() => fetchCaptures(1, capturePageSize)}
                  disabled={capturesPagination.page <= 1}
                  className="rounded px-3 py-1 text-sm border border-input bg-background hover:bg-accent disabled:opacity-50"
                  aria-label="First page"
                  title="First page"
                >
                  <span aria-hidden="true">««</span>
                </button>
                <button
                  onClick={() => fetchCaptures(Math.max(1, capturesPagination.page - 1), capturePageSize)}
                  disabled={capturesPagination.page <= 1}
                  className="rounded px-3 py-1 text-sm border border-input bg-background hover:bg-accent disabled:opacity-50"
                  aria-label="Previous page"
                  title="Previous page"
                >
                  <span aria-hidden="true">«</span>
                </button>
                {generatePaginationPages(capturesPagination.page, capturesPagination.totalPages).map((p, index) => {
                  if (p.isEllipsis) {
                    return (
                      <span key={`ellipsis-${index}`} className="px-2 text-muted-foreground" aria-hidden="true">
                        ...
                      </span>
                    );
                  }
                  return (
                    <button
                      key={p.page}
                      onClick={() => fetchCaptures(p.page, capturePageSize)}
                      className={`rounded px-3 py-1 text-sm border transition-colors ${
                        p.page === capturesPagination.page
                          ? "bg-primary text-primary-foreground border-primary"
                          : "border-input bg-background hover:bg-accent"
                      }`}
                      aria-current={p.page === capturesPagination.page ? "page" : undefined}
                      aria-label={`Page ${p.page}`}
                    >
                      {p.page}
                    </button>
                  );
                })}
                <button
                  onClick={() => fetchCaptures(Math.min(capturesPagination.totalPages, capturesPagination.page + 1), capturePageSize)}
                  disabled={capturesPagination.page >= capturesPagination.totalPages}
                  className="rounded px-3 py-1 text-sm border border-input bg-background hover:bg-accent disabled:opacity-50"
                  aria-label="Next page"
                  title="Next page"
                >
                  <span aria-hidden="true">»</span>
                </button>
                <button
                  onClick={() => fetchCaptures(capturesPagination.totalPages, capturePageSize)}
                  disabled={capturesPagination.page >= capturesPagination.totalPages}
                  className="rounded px-3 py-1 text-sm border border-input bg-background hover:bg-accent disabled:opacity-50"
                  aria-label="Last page"
                  title="Last page"
                >
                  <span aria-hidden="true">»»</span>
                </button>
              </div>
            </div>
          )}
        </div>

        {/* Sessions List Section */}
        <div className="space-y-4">
          <h2 className="text-xl font-semibold">All Sessions</h2>
          {sessionsError && (
            <div className="rounded-lg border border-destructive bg-destructive/10 p-4">
              <p className="text-destructive">Error: {sessionsError}</p>
            </div>
          )}

          {sessionsLoading ? (
            <div className="flex flex-col items-center justify-center rounded-lg border border-dashed p-12">
              <svg className="h-12 w-12 text-muted-foreground mb-4 animate-spin" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M4 4v5h.582m15.356 2A8.001 8.001 0 004.582 9m0 0H9m11 11v-5h-.581m0 0a8.003 8.003 0 01-15.357-2m15.357 2H15" />
              </svg>
              <h3 className="font-semibold mb-2">Loading sessions...</h3>
            </div>
          ) : !sessionsError && summaries.length === 0 ? (
            <div className="flex flex-col items-center justify-center rounded-lg border border-dashed p-12">
              <svg className="h-12 w-12 text-muted-foreground mb-4" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M9 5H7a2 2 0 00-2 2v12a2 2 0 002 2h5.5a2 2 0 002-2V9a2 2 0 00-2-2z" />
              </svg>
              <h3 className="font-semibold mb-2">No sessions captured yet</h3>
              <p className="text-sm text-muted-foreground">Start the proxy and make some API requests to see sessions here.</p>
            </div>
          ) : (
            <div className="space-y-4">
              {summaries.map((session) => (
                <Link
                  key={session.sessionId}
                  href={`/sessions/${session.sessionId}`}
                  className="flex items-center justify-between rounded-lg border p-4 hover:bg-accent transition-colors"
                >
                  <div className="flex items-center gap-4">
                    <div className="rounded-full bg-primary/10 p-3">
                      <svg className="h-5 w-5 text-primary" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                        <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M9 5H7a2 2 0 00-2 2v12a2 2 0 002 2h5.5a2 2 0 002-2V9a2 2 0 00-2-2z" />
                      </svg>
                    </div>
                    <div>
                      <div className="font-medium">
                        {session.source} → {session.destination}
                      </div>
                      <div className="text-sm text-muted-foreground">
                        {session.captureCount} captures • {formatDateTime(session.firstTimestamp)}
                      </div>
                    </div>
                  </div>
                  <svg className="h-5 w-5 text-muted-foreground" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                    <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M9 5l7 7-7 7" />
                  </svg>
                </Link>
              ))}
            </div>
          )}
        </div>
      </div>
    </MainLayout>
  );
}
