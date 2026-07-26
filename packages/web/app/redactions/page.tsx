"use client";

import { MainLayout } from "@/components/main-layout";
import Link from "next/link";
import { useState, useEffect, useRef, useCallback } from "react";

import { DiffDialog } from "@/components/ui/diff-dialog";
import { usePageLoad } from "@/components/page-load-context";

interface RedactionSummary {
  totalRedactions: number;
  byType: Record<string, number>;
}

interface RedactionCaptureRow {
  captureId: string;
  sessionId: string | null;
  timestamp: string;
  requestSource: string | null;
  requestProvider: string;
  requestTarget: string;
  /** Comma-separated list like "[API_KEY_REDACTED] (1), [PHONE_REDACTED] (5)" */
  redactionSummary: string;
  /** Total redaction count for this capture */
  totalRedactions: number;
  /** Breakdown by placeholder for this capture */
  byPlaceholder: Record<string, number>;
}

const PAGE_SIZE = 50;

const DEFAULT_COLUMNS = [
  'timestamp',
  'requestSource',
  'requestProvider',
  'requestTarget',
  'sessionId',
  'captureId',
  'totalRedactions',
];

/**
 * Inner content component that uses usePageLoad.
 * Must be rendered inside MainLayout (which provides PageLoadProvider).
 */
function RedactionsContent() {
  const [summary, _setSummary] = useState<RedactionSummary | null>(null);
  const [details, _setDetails] = useState<RedactionCaptureRow[]>([]);
  const [_loadingSummary, _setLoadingSummary] = useState(true);
  const [_loadingDetails, _setLoadingDetails] = useState(true);
  const [refreshing, setRefreshing] = useState(false);
  const [_error, _setError] = useState<string | null>(null);
  const [page, setPage] = useState(1);
  const [totalPages, setTotalPages] = useState(1);
  const [totalCount, setTotalCount] = useState(0);
  const [diffDialogOpen, setDiffDialogOpen] = useState(false);
  const [diffDialogData, setDiffDialogData] = useState<{
    preContent: string;
    postContent: string;
    fullOriginal?: string;
    fullRedacted?: string;
    captureId: string;
    redactionType: string;
    provider: string;
    targetUrl: string;
    timestamp: string;
  } | null>(null);
  const [sortConfig, setSortConfig] = useState<{ key: string; direction: 'asc' | 'desc' } | null>({ key: 'timestamp', direction: 'desc' });
  // Selected redaction type filter from breakdown widgets
  const [selectedRedactionType, setSelectedRedactionType] = useState<string | null>(null);

  const lastFocusedTrigger = useRef<HTMLElement | null>(null);

  // Page load tracking for footer
  const { registerPageLoad, registerPageReady } = usePageLoad();

  const incrementPending = useCallback(() => {
    registerPageLoad();
  }, [registerPageLoad]);

  const decrementPending = useCallback(() => {
    registerPageReady();
  }, [registerPageReady]);

  const Spinner = ({ size = 16, className = "" }: { size?: number; className?: string }) => (
    <svg
      className={`animate-spin ${className}`}
      width={size}
      height={size}
      viewBox="0 0 24 24"
      fill="none"
      xmlns="http://www.w3.org/2000/svg"
    >
      <circle
        className="opacity-25"
        cx="12"
        cy="12"
        r="10"
        stroke="currentColor"
        strokeWidth="4"
      />
      <path
        className="opacity-75"
        fill="currentColor"
        d="M4 12a8 8 0 018-8V0C5.373 0 0 5.373 0 12h4zm2 5.291A7.962 7.962 0 014 12H0c0 3.042 1.135 5.824 3 7.938l3-2.647z"
      />
    </svg>
  );

  const fetchSummary = useCallback(async () => {
    console.log("[Redactions] fetchSummary called, current refreshing:", refreshing);
    setRefreshing(true);
    console.log("[Redactions] setRefreshing(true) called");
    incrementPending();
    // Safety timeout: force refreshing to false after 10 seconds no matter what
    const safetyTimeout = setTimeout(() => {
      console.warn("[Redactions] Safety timeout triggered, forcing refreshing to false");
      setRefreshing(false);
    }, 10000);
    try {
      const fetchPromise = fetch("/api/redactions?summary=true");
      const timeoutPromise = new Promise<Response>((_, reject) =>
        setTimeout(() => reject(new Error("Fetch timeout")), 5000)
      );
      const res = await Promise.race([fetchPromise, timeoutPromise]);
      console.log("[Redactions] Fetch completed, status:", res.status);
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const data = await res.json();
      console.log("[Redactions] Data received:", data);
      _setSummary(data.summary);
    } catch (err) {
      console.error("Summary fetch failed:", err);
    } finally {
      console.log("[Redactions] Finally block - clearing timeout and setting refreshing false");
      clearTimeout(safetyTimeout);
      setRefreshing(false);
      decrementPending();
    }
  }, [refreshing, incrementPending, decrementPending]);

  const fetchDetails = useCallback(async () => {
    console.log("[Redactions] fetchDetails called, page:", page, "selectedRedactionType:", selectedRedactionType);
    incrementPending();
    try {
      const params = new URLSearchParams({
        page: String(page),
        pageSize: String(PAGE_SIZE),
      });
      if (selectedRedactionType) {
        params.set("redactionType", selectedRedactionType);
      }
      if (sortConfig) {
        params.set("sort", sortConfig.key);
        params.set("order", sortConfig.direction);
      }
      const res = await fetch(`/api/redactions?${params.toString()}`);
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const data = await res.json();
      console.log("[Redactions] Details data received, captures:", data.captures?.length);
      _setDetails(data.captures || []);
      setTotalPages(data.totalPages || 1);
      setTotalCount(data.totalCount || 0);
    } catch (err) {
      console.error("Details fetch failed:", err);
    } finally {
      decrementPending();
    }
  }, [page, selectedRedactionType, sortConfig, incrementPending, decrementPending]);

  useEffect(() => {
    fetchSummary();
  }, [fetchSummary]);

  useEffect(() => {
    fetchDetails();
  }, [fetchDetails]);

  const handleRefresh = useCallback(() => {
    console.log("[Redactions] handleRefresh: calling fetchSummary and fetchDetails");
    fetchSummary();
    fetchDetails();
  }, [fetchSummary, fetchDetails]);

  const handleSort = useCallback((key: string) => {
    setSortConfig(current => {
      if (current?.key === key) {
        return { key, direction: current.direction === 'asc' ? 'desc' : 'asc' };
      }
      return { key, direction: 'desc' };
    });
    setPage(1);
  }, []);

  const handlePageChange = useCallback((newPage: number) => {
    if (newPage >= 1 && newPage <= totalPages) {
      setPage(newPage);
    }
  }, [totalPages]);

  const handleOpenDiff = useCallback(async (e: React.MouseEvent, row: RedactionCaptureRow) => {
    lastFocusedTrigger.current = e.currentTarget as HTMLElement;

    // Fetch first match for this capture from the detail API
    // We use the first match for the diff view; the full redaction list is shown in the summary
    let preContent = "";
    let postContent = "";
    let fullOriginal: string | undefined;
    let fullRedacted: string | undefined;

    try {
      const res = await fetch(`/api/redactions/detail/${row.captureId}/0`);
      if (res.ok) {
        const detail = await res.json();
        preContent = detail.preRedactionValue || "";
        postContent = detail.postRedactionValue || "";
        fullOriginal = detail.fullOriginal;
        fullRedacted = detail.fullRedacted;
      } else {
        console.warn('Failed to fetch redaction detail:', res.status);
      }
    } catch (err) {
      console.warn('Failed to fetch redaction detail:', err);
    }

    // For comma-separated list, we show the summary and open with first redaction
    // The dialog could be enhanced to show multiple redactions
    setDiffDialogData({
      preContent,
      postContent,
      fullOriginal,
      fullRedacted,
      captureId: row.captureId,
      redactionType: row.redactionSummary, // Show summary in dialog title
      provider: row.requestProvider,
      targetUrl: row.requestTarget,
      timestamp: row.timestamp,
    });
    setDiffDialogOpen(true);
  }, []);

  const handleCloseDiff = useCallback(() => {
    if (lastFocusedTrigger.current) {
      lastFocusedTrigger.current.focus();
    }
    setDiffDialogOpen(false);
  }, []);

  // Error state - show early
  if (_error) {
    return (
      <div className="space-y-6">
        <div className="flex items-center justify-between">
          <div>
            <h1 className="text-3xl font-bold tracking-tight">Redactions</h1>
            <p className="text-muted-foreground">Redacted content captured from API traffic</p>
          </div>
        </div>
        <div className="space-y-4">
          <h2 className="text-xl font-semibold">Redaction Summary</h2>
          <div className="rounded-lg border border-destructive bg-destructive/10 p-4">
            <p className="text-destructive">Error: {_error}</p>
          </div>
        </div>
      </div>
    );
  }

  // Loading summary state
  if (_loadingSummary) {
    return (
      <div className="space-y-6">
        <div className="flex items-center justify-between">
          <div>
            <h1 className="text-3xl font-bold tracking-tight">Redactions</h1>
            <p className="text-muted-foreground">Redacted content captured from API traffic</p>
          </div>
        </div>
        <div className="space-y-4">
          <h2 className="text-xl font-semibold">Redaction Summary</h2>
          <div className="flex items-center gap-4">
            <Spinner size={24} />
            <span className="text-muted-foreground">Loading summary...</span>
          </div>
        </div>
      </div>
    );
  }

  // Success state with data
  return (
    <div className="space-y-6">
      <div className="flex items-center justify-between">
        <div>
          <h1 className="text-3xl font-bold tracking-tight">Redactions</h1>
          <p className="text-muted-foreground">Redacted content captured from API traffic</p>
        </div>
        <button
          onClick={handleRefresh}
          disabled={refreshing}
          className="rounded-md border px-4 py-2 text-sm hover:bg-accent disabled:opacity-50 disabled:cursor-not-allowed flex items-center gap-2"
        >
          {refreshing ? <Spinner size={16} /> : <svg className="h-4 w-4" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M4 4v5h.582m15.356 2A8.001 8.001 0 004.582 9m0 0H9m11 11v-5h-.581m0 0a8.003 8.003 0 01-15.357-2m15.357 2H15" /></svg>}
          <span>{refreshing ? "Refreshing..." : "Refresh"}</span>
        </button>
      </div>

      {/* Summary Cards */}
      <div className="space-y-4">
        <h2 className="text-xl font-semibold">Redaction Summary</h2>
        <div className="grid gap-4 md:grid-cols-2 lg:grid-cols-5">
          <div className="rounded-lg border p-4">
            <div className="text-sm text-muted-foreground">Total Redactions</div>
            <div className="text-2xl font-bold">{summary?.totalRedactions ?? 0}</div>
          </div>
          {Object.entries(summary?.byType || {}).map(([type, count]) => (
            <div
              key={type}
              className="rounded-lg border p-4 cursor-pointer hover:bg-accent transition-colors"
              onClick={() => setSelectedRedactionType(type === selectedRedactionType ? null : type)}
            >
              <div className="text-sm text-muted-foreground capitalize">{type.replace(/_/g, " ")}</div>
              <div className="flex items-center justify-between">
                <div className="text-2xl font-bold text-primary">{count}</div>
                {selectedRedactionType === type && (
                  <svg className="h-5 w-5 text-primary" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                    <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M5 13l4 4L19 7" />
                  </svg>
                )}
              </div>
            </div>
          ))}
        </div>
      </div>

      {/* Redaction Details Table */}
      <div className="space-y-4">
        <div className="flex items-center justify-between">
          <h2 className="text-xl font-semibold">Redaction Details</h2>
          {selectedRedactionType && (
            <button
              onClick={() => setSelectedRedactionType(null)}
              className="text-sm text-muted-foreground hover:text-foreground flex items-center gap-1"
            >
              <svg className="h-4 w-4" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M6 18L18 6M6 6l12 12" />
              </svg>
              Clear filter: {selectedRedactionType.replace(/_/g, " ")}
            </button>
          )}
        </div>

        <div className="rounded-lg border">
          <div className="overflow-x-auto">
            <table className="w-full">
              <thead className="bg-muted/50">
                <tr>
                  {DEFAULT_COLUMNS.map(key => (
                    <th
                      key={key}
                      className="px-4 py-3 text-left text-xs font-medium text-muted-foreground uppercase tracking-wider cursor-pointer select-none"
                      onClick={() => handleSort(key)}
                    >
                      <div className="flex items-center gap-2">
                        <span>{getColumnLabel(key)}</span>
                        {sortConfig?.key === key && (
                          <svg
                            className={`h-4 w-4 ${sortConfig.direction === 'asc' ? 'rotate-180' : ''}`}
                            fill="none"
                            stroke="currentColor"
                            viewBox="0 0 24 24"
                          >
                            <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M5 15l7-7 7 7" />
                          </svg>
                        )}
                      </div>
                    </th>
                  ))}
                </tr>
              </thead>
              <tbody className="divide-y divide-border">
                {_loadingDetails ? (
                  <tr>
                    <td colSpan={DEFAULT_COLUMNS.length + 1} className="py-12 text-center text-muted-foreground">
                      <div className="flex items-center justify-center gap-2">
                        <Spinner size={20} />
                        <span>Loading details...</span>
                      </div>
                    </td>
                  </tr>
                ) : details.length === 0 ? (
                  <tr>
                    <td colSpan={DEFAULT_COLUMNS.length + 1} className="py-12 text-center text-muted-foreground">
                      No redaction details found
                    </td>
                  </tr>
                ) : (
                  details.map(row => (
                    <tr key={row.captureId} className="hover:bg-accent/50 cursor-pointer">
                      {DEFAULT_COLUMNS.map(key => (
                        <td key={key} className="px-4 py-3 text-sm">
                          {renderCell(row, key)}
                        </td>
                      ))}
                      <td className="px-4 py-3 text-sm">
                        <button
                          onClick={e => handleOpenDiff(e, row)}
                          className="text-primary hover:underline"
                          aria-label={`View diff for capture ${row.captureId}`}
                        >
                          View Diff
                        </button>
                      </td>
                    </tr>
                  ))
                )}
              </tbody>
            </table>
          </div>

          {/* Pagination Controls */}
          {totalPages > 1 && (
            <div className="border-t p-4 flex items-center justify-between">
              <div className="text-sm text-muted-foreground">
                Showing {Math.min((page - 1) * PAGE_SIZE + 1, totalCount)} to {Math.min(page * PAGE_SIZE, totalCount)} of {totalCount} captures
              </div>
              <div className="flex items-center gap-2">
                <button
                  onClick={() => handlePageChange(page - 1)}
                  disabled={page <= 1}
                  className="rounded-md border px-3 py-1 text-sm hover:bg-accent disabled:opacity-50 disabled:cursor-not-allowed"
                >
                  ← Previous
                </button>
                <span className="px-3 text-sm">
                  Page {page} of {totalPages}
                </span>
                <button
                  onClick={() => handlePageChange(page + 1)}
                  disabled={page >= totalPages}
                  className="rounded-md border px-3 py-1 text-sm hover:bg-accent disabled:opacity-50 disabled:cursor-not-allowed"
                >
                  Next →
                </button>
              </div>
            </div>
          )}
        </div>
      </div>

      {/* Diff Dialog - Two-pane view showing pre/post redaction side by side */}
      <DiffDialog
        isOpen={diffDialogOpen}
        onClose={handleCloseDiff}
        preContent={diffDialogData?.preContent || ""}
        postContent={diffDialogData?.postContent || ""}
        fullOriginal={diffDialogData?.fullOriginal}
        fullRedacted={diffDialogData?.fullRedacted}
        title="Redaction Diff"
        captureId={diffDialogData?.captureId || ""}
        redactionType={diffDialogData?.redactionType || ""}
        provider={diffDialogData?.provider || ""}
        targetUrl={diffDialogData?.targetUrl || ""}
        timestamp={diffDialogData?.timestamp || ""}
      />
    </div>
  );
}

function getColumnLabel(key: string): string {
  const labels: Record<string, string> = {
    timestamp: "Timestamp",
    requestSource: "Source",
    requestProvider: "Provider",
    requestTarget: "Target",
    sessionId: "Session ID",
    captureId: "Capture ID",
    totalRedactions: "Redactions",
  };
  return labels[key] || key;
}

function renderCell(row: RedactionCaptureRow, key: string): React.ReactNode {
  switch (key) {
    case "timestamp":
      return new Date(row.timestamp).toLocaleString();
    case "requestSource":
      return row.requestSource || "—";
    case "requestProvider":
      return row.requestProvider;
    case "requestTarget":
      return <span className="font-mono text-xs truncate block max-w-xs" title={row.requestTarget}>{row.requestTarget}</span>;
    case "sessionId":
      return row.sessionId ? (
        <Link href={`/sessions/${row.sessionId}`} className="text-primary hover:underline">
          {row.sessionId.slice(0, 12)}…
        </Link>
      ) : (
        <span className="text-muted-foreground">—</span>
      );
    case "captureId":
      return <span className="font-mono text-xs">{row.captureId.slice(0, 12)}…</span>;
    case "totalRedactions":
      return row.totalRedactions;
    default:
      return "—";
  }
}

export default function RedactionsPage() {
  return (
    <MainLayout>
      <RedactionsContent />
    </MainLayout>
  );
}