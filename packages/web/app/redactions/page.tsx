"use client";

import { MainLayout } from "@/components/main-layout";
import Link from "next/link";
import { useState, useEffect, useRef, useCallback } from "react";

import { DiffDialog } from "@/components/ui/diff-dialog";
import { FalsePositiveManager } from "@/components/FalsePositiveManager";
import { AdminAccessDeniedDialog } from "@/components/admin-access-denied-dialog";

// Admin status cache key and TTL (5 minutes)
const ADMIN_CACHE_KEY = "contextio_admin_status";
const ADMIN_CACHE_TTL = 5 * 60 * 1000; // 5 minutes

interface AdminStatus {
  isAdmin: boolean;
  authenticated: boolean;
  email?: string;
  timestamp: number;
}

// Get cached admin status if valid
function getCachedAdminStatus(): AdminStatus | null {
  if (typeof window === "undefined") return null;
  try {
    const cached = localStorage.getItem(ADMIN_CACHE_KEY);
    if (!cached) return null;
    const data: AdminStatus = JSON.parse(cached);
    if (Date.now() - data.timestamp > ADMIN_CACHE_TTL) {
      localStorage.removeItem(ADMIN_CACHE_KEY);
      return null;
    }
    return data;
  } catch {
    return null;
  }
}

// Cache admin status
function setCachedAdminStatus(status: Omit<AdminStatus, "timestamp">): void {
  if (typeof window === "undefined") return;
  try {
    localStorage.setItem(ADMIN_CACHE_KEY, JSON.stringify({
      ...status,
      timestamp: Date.now(),
    }));
  } catch {
    // Ignore localStorage errors
  }
}

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

export default function RedactionsPage() {
  const [summary, _setSummary] = useState<RedactionSummary | null>(null);
  const [details, _setDetails] = useState<RedactionCaptureRow[]>([]);
  const [_loadingSummary, _setLoadingSummary] = useState(true);
  const [_loadingDetails, _setLoadingDetails] = useState(true);
  const [refreshing, setRefreshing] = useState(false);
  const [_error, _setError] = useState<string | null>(null);

  // Admin access denied dialog state - only shown when user tries to access protected feature
  const [showAccessDenied, setShowAccessDenied] = useState(false);
  const [accessDeniedAuthState, setAccessDeniedAuthState] = useState<{ userEmail?: string; isAuthenticated?: boolean }>({});
  const [page, setPage] = useState(1);
  const [totalPages, setTotalPages] = useState(1);
  const [totalCount, setTotalCount] = useState(0);
  const [diffDialogOpen, setDiffDialogOpen] = useState(false);
  const [diffDialogLoading, setDiffDialogLoading] = useState(false);
  const [diffDialogData, setDiffDialogData] = useState<{
    preContent: string;
    postContent: string;
    fullOriginal?: string;
    fullRedacted?: string;
    captureId: string;
    sessionId: string | null;
    redactionType: string;
    provider: string;
    targetUrl: string;
    timestamp: string;
    matches?: Array<{ ruleId: string; preValue: string; postValue: string; path: string }>;
  } | null>(null);
  const [sortConfig, setSortConfig] = useState<{ key: string; direction: "asc" | "desc" } | null>({ key: "timestamp", direction: "desc" });
  // Filter to only show rows with positive redactions (enabled by default)
  const [hideZeroRedactions, setHideZeroRedactions] = useState(true);
  // Debounced filters for API calls - only redactionType is used (from breakdown clicks)
  const [debouncedFilters, setDebouncedFilters] = useState<Record<string, string>>({});
  // Selected redaction type filter from breakdown widgets
  const [selectedRedactionType, setSelectedRedactionType] = useState<string | null>(null);
  const [columnOrder, setColumnOrder] = useState<string[]>([
    "timestamp",
    "totalRedactions",
    "redactionsByType",
    "requestSource",
    "requestProvider",
    "requestTarget",
    "sessionId",
    "captureId",
  ]);
  const [columnWidths, setColumnWidths] = useState<Record<string, number>>({});
  const [draggedKey, setDraggedKey] = useState<string | null>(null);
  const [resizingKey, setResizingKey] = useState<string | null>(null);
  const [resizeStartX, setResizeStartX] = useState<number>(0);
  const [resizeStartWidth, setResizeStartWidth] = useState<number>(0);
  
  // False positive dialog state
  const [fpDialogOpen, setFpDialogOpen] = useState(false);
  const [fpDialogData, setFpDialogData] = useState<{
    value: string;
    ruleId: string;
    label: string;
    path: string;
  } | null>(null);

  const lastFocusedTrigger = useRef<HTMLElement | null>(null);

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
    console.log("[Redactions] fetchSummary called");
    setRefreshing(true);
    // Safety timeout: force refreshing to false after 15 seconds no matter what
    const safetyTimeout = setTimeout(() => {
      console.warn("[Redactions] Safety timeout triggered, forcing refreshing to false");
      setRefreshing(false);
    }, 15000);
    try {
      let cancelled = false;
      const fetchPromise = fetch("/api/redactions?summary=true");
      const timeoutPromise = new Promise<Response>((_, reject) =>
        setTimeout(() => reject(new Error("Fetch timeout")), 120000)
      );
      const res = await Promise.race([fetchPromise, timeoutPromise]);
      console.log("[Redactions] Fetch completed, status:", res.status);
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const data = await res.json();
      console.log("[Redactions] Data received:", data);
      if (!cancelled) {
        _setSummary(data.summary);
      }
    } catch (err) {
      console.error("Summary fetch failed:", err);
    } finally {
      console.log("[Redactions] Finally block - clearing timeout and setting refreshing false");
      clearTimeout(safetyTimeout);
      setRefreshing(false);
    }
  }, []);

  // Fetch summary data on mount
  useEffect(() => {
    fetchSummary();
  }, [fetchSummary]);

  const handleOpenDiff = useCallback(async (e: React.MouseEvent, row: RedactionCaptureRow) => {
    lastFocusedTrigger.current = e.currentTarget as HTMLElement;

    // Check admin auth before opening diff dialog
    try {
      const response = await fetch("/api/auth/check-admin");
      const adminData = await response.json();
      
      // Require authentication and admin status to view diff dialog
      if (!adminData.authenticated) {
        setAccessDeniedAuthState({ userEmail: adminData.email, isAuthenticated: false });
        setShowAccessDenied(true);
        return;
      }
      
      if (!adminData.isAdmin) {
        setAccessDeniedAuthState({ userEmail: adminData.email, isAuthenticated: true });
        setShowAccessDenied(true);
        return;
      }
    } catch (error) {
      console.error("Failed to check admin status:", error);
      // On error, deny access to be safe
      setAccessDeniedAuthState({ isAuthenticated: false });
      setShowAccessDenied(true);
      return;
    }

    setDiffDialogLoading(true);

    // Fetch first match for this capture from the detail API
    // We use the first match for the diff view; the full redaction list is shown in the summary
    let preContent = "";
    let postContent = "";
    let fullOriginal: string | undefined;
    let fullRedacted: string | undefined;
    let matches: Array<{ ruleId: string; preValue: string; postValue: string; path: string }> | undefined;

    try {
      const fetchPromise = fetch(`/api/redactions/detail/${row.captureId}/0`);
      const timeoutPromise = new Promise<Response>((_, reject) =>
        setTimeout(() => reject(new Error("Fetch timeout")), 120000)
      );
      const res = await Promise.race([fetchPromise, timeoutPromise]);
      if (res.ok) {
        const detail = await res.json();
        preContent = detail.preRedactionValue || "";
        postContent = detail.postRedactionValue || "";
        fullOriginal = detail.fullOriginal;
        fullRedacted = detail.fullRedacted;
        matches = detail.matches;
      } else {
        console.warn("Failed to fetch redaction detail:", res.status);
      }
    } catch (err) {
      console.warn("Failed to fetch redaction detail:", err);
    }

    // Set data first, then open dialog - loading stays true until DiffDialog signals ready
    setDiffDialogData({
      preContent,
      postContent,
      fullOriginal,
      fullRedacted,
      matches,
      captureId: row.captureId,
      sessionId: row.sessionId,
      redactionType: row.redactionSummary,
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
    setDiffDialogLoading(false);
  }, []);

  // Debounce filter changes to avoid firing API request on every keystroke
  // selectedRedactionType is included in deps so clicks apply immediately (300ms debounce is fine for clicks too)
  useEffect(() => {
    const timer = setTimeout(() => {
      const newFilters: Record<string, string> = {};
      if (selectedRedactionType) {
        newFilters.redactionType = selectedRedactionType;
      }
      if (hideZeroRedactions) {
        newFilters.hideZeroRedactions = "true";
      }
      console.log("[RedactionFilter] Setting debouncedFilters:", newFilters);
      setDebouncedFilters(newFilters);
    }, 300);
    return () => clearTimeout(timer);
  }, [selectedRedactionType, hideZeroRedactions]);

  // Fetch detail data with pagination
  useEffect(() => {
    let cancelled = false;
    const fetchDetails = async () => {
      try {
        _setLoadingDetails(true);
        // Build query params with filters and sort
        const params = new URLSearchParams({
          page: String(page),
          pageSize: String(PAGE_SIZE),
        });
        // Add filters (using debounced version)
        Object.entries(debouncedFilters).forEach(([key, val]) => {
          if (val) params.set(`filter_${key}`, val);
        });
        // Add sort
        if (sortConfig) {
          params.set("sortKey", sortConfig.key);
          params.set("sortDir", sortConfig.direction);
        }
        const url = `/api/redactions?${params.toString()}`;
        console.log("[RedactionFilter] Fetching:", url);
        const fetchPromise = fetch(url);
        const timeoutPromise = new Promise<Response>((_, reject) =>
          setTimeout(() => reject(new Error("Fetch timeout")), 120000)
        );
        const res = await Promise.race([fetchPromise, timeoutPromise]);
        if (!res.ok) throw new Error("Failed to fetch details");
        const data = await res.json();
        if (!cancelled) {
          _setDetails(data.details);
          setTotalPages(data.totalPages);
          setTotalCount(data.totalCount);
          // Sync client page to server-clamped page to avoid desync when dataset shrinks
          if (data.page && data.page !== page) setPage(data.page);
        }
      } catch (err) {
        if (!cancelled) {
          _setError(err instanceof Error ? err.message : "Failed to load details");
        }
      } finally {
        if (!cancelled) {
          _setLoadingDetails(false);
        }
      }
    };
    fetchDetails();
    return () => { cancelled = true; };
  }, [page, debouncedFilters, sortConfig]);

  const handlePageChange = (newPage: number) => {
    if (newPage >= 1 && newPage <= totalPages) {
      setPage(newPage);
    }
  };

  // Handle click on redaction in diff dialog to add as false positive
  const handleAddFalsePositive = useCallback(async (fpData: {
    value: string;
    ruleId: string;
    label: string;
    path: string;
  }) => {
    // Check cached admin status first
    const cached = getCachedAdminStatus();
    if (cached) {
      if (!cached.authenticated) {
        setAccessDeniedAuthState({ userEmail: cached.email, isAuthenticated: false });
        setShowAccessDenied(true);
        return;
      }
      if (!cached.isAdmin) {
        setAccessDeniedAuthState({ userEmail: cached.email, isAuthenticated: true });
        setShowAccessDenied(true);
        return;
      }
      // Cached admin status is valid, open dialog immediately
      setFpDialogData(fpData);
      setFpDialogOpen(true);
      return;
    }

    // No valid cache, check with server
    try {
      const response = await fetch("/api/auth/check-admin");
      const adminData = await response.json();
      
      // Cache the result for future calls
      setCachedAdminStatus({
        isAdmin: adminData.isAdmin ?? false,
        authenticated: adminData.authenticated ?? false,
        email: adminData.email,
      });
      
      if (!adminData.authenticated) {
        setAccessDeniedAuthState({ userEmail: adminData.email, isAuthenticated: false });
        setShowAccessDenied(true);
        return;
      }
      
      if (!adminData.isAdmin) {
        setAccessDeniedAuthState({ userEmail: adminData.email, isAuthenticated: true });
        setShowAccessDenied(true);
        return;
      }
      
      // User is admin, proceed to open the false positive dialog
      setFpDialogData(fpData);
      setFpDialogOpen(true);
    } catch (error) {
      console.error("Failed to check admin status:", error);
      alert("Failed to verify admin status. Please try again.");
    }
  }, []);

  const handleResizeStart = (key: string, e: React.MouseEvent) => {
    e.preventDefault();
    e.stopPropagation();
    const th = e.currentTarget.closest("th") as HTMLElement | null;
    const startWidth = th ? th.offsetWidth : 100;
    setResizingKey(key);
    setResizeStartX(e.clientX);
    setResizeStartWidth(startWidth);
    document.addEventListener("mousemove", handleResizeMove);
    document.addEventListener("mouseup", handleResizeEnd);
  };

  const handleResizeMove = (e: MouseEvent) => {
    if (!resizingKey) return;
    const delta = e.clientX - resizeStartX;
    const newWidth = Math.max(50, resizeStartWidth + delta);
    setColumnWidths((prev) => ({ ...prev, [resizingKey]: newWidth }));
  };

  const handleResizeEnd = () => {
    document.removeEventListener("mousemove", handleResizeMove);
    document.removeEventListener("mouseup", handleResizeEnd);
    setResizingKey(null);
  };

  const handleDragStart = (key: string) => setDraggedKey(key);
  const handleDragOver = (e: React.DragEvent) => e.preventDefault();
  const handleDrop = (targetKey: string) => {
    if (!draggedKey || draggedKey === targetKey) return;
    setColumnOrder((prev) => {
      const arr = [...prev];
      const from = arr.indexOf(draggedKey);
      const to = arr.indexOf(targetKey);
      if (from === -1 || to === -1) return prev;
      arr.splice(from, 1);
      arr.splice(to, 0, draggedKey);
      return arr;
    });
    setDraggedKey(null);
  };
  const handleDragEnd = () => setDraggedKey(null);

  const renderCell = (key: string, row: RedactionCaptureRow) => {
    switch (key) {
      case "redactionsByType":
        return (
          <span
            className="text-primary underline cursor-pointer hover:text-primary/80"
            onClick={(e) => { e.stopPropagation(); handleOpenDiff(e as React.MouseEvent, row); }}
            title={row.redactionSummary}
          >
            {row.redactionSummary.split(", ").map((item, idx) => (
              <span key={idx} className="block whitespace-nowrap">
                {item}
              </span>
            ))}
          </span>
        );
      case "requestSource":
        return <span className="text-muted-foreground">{row.requestSource ?? "—"}</span>;
      case "requestProvider":
        return <span className="text-center">{row.requestProvider}</span>;
      case "requestTarget":
        return <span className="max-w-xs truncate">{row.requestTarget}</span>;
      case "sessionId":
        return <span className="font-mono text-xs">{row.sessionId ?? "—"}</span>;
      case "captureId":
        return (
          row.sessionId ? (
            <Link
              href={`/sessions/${row.sessionId}?captureId=${row.captureId}`}
              className="text-primary underline hover:text-primary/80"
            >
              {row.captureId}
            </Link>
          ) : (
            <span className="text-muted-foreground">{row.captureId}</span>
          )
        );
      case "timestamp":
        return <span className="font-mono text-xs">{new Date(row.timestamp).toLocaleString()}</span>;
      case "totalRedactions":
        return <span className="font-medium text-primary text-center">{row.totalRedactions}</span>;
      default:
        return null;
    }
  };

  const handleSort = (key: string) => {
    setSortConfig((prev) => {
      if (prev && prev.key === key && prev.direction === "asc") {
        return { key, direction: "desc" };
      }
      return { key, direction: "asc" };
    });
    setPage(1); // Reset to first page when sort changes
  };

  const handleRedactionTypeClick = (placeholderType: string) => {
    console.log("[RedactionFilter] Clicked placeholder type:", placeholderType, "current:", selectedRedactionType);
    if (selectedRedactionType === placeholderType) {
      setSelectedRedactionType(null);
    } else {
      setSelectedRedactionType(placeholderType);
    }
    setPage(1); // Reset to first page when filter changes
  };

  return (
    <>
      <AdminAccessDeniedDialog
        open={showAccessDenied}
        onClose={() => setShowAccessDenied(false)}
        userEmail={accessDeniedAuthState.userEmail}
        isAuthenticated={accessDeniedAuthState.isAuthenticated}
      />
      <MainLayout>
          <div className="space-y-6">
          <div className="flex items-center justify-between">
            <div>
              <h1 className="text-3xl font-bold tracking-tight">Redactions</h1>
              <p className="text-muted-foreground">View all redacted data across captures</p>
            </div>
            <div className="flex items-center gap-4">
              <button
                onClick={fetchSummary}
                disabled={refreshing}
                className="p-1.5 rounded hover:bg-accent transition-colors disabled:opacity-50 disabled:cursor-not-allowed"
                aria-label="Refresh redaction counts"
                title="Refresh counts"
              >
                {refreshing ? (
                  <Spinner size={16} className="text-primary" />
                ) : (
                  <svg className="w-5 h-5 text-muted-foreground" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                    <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M4 4v5h.582m15.356 2A8.001 8.001 0 004.582 9m0 0H9m11 11v-5h-.581m0 0a8.003 8.003 0 01-15.357-2m15.357 2H15" />
                  </svg>
                )}
              </button>
              <Link
                href="/"
                className="rounded-md bg-primary px-4 py-2 text-sm font-medium text-primary-foreground hover:bg-primary/90"
              >
                &larr; Back to Dashboard
              </Link>
            </div>
          </div>

          {/* Summary Cards */}
          <div className="grid gap-4 md:grid-cols-2 lg:grid-cols-4">
            <div className="rounded-lg border p-4 bg-accent border-border"
                 title="Sum of maximum redactions per session. For each session, the highest count of each placeholder type across all its captures is used. This matches the 'Unique Redactions (per session)' on the Metrics page.">
              <div className="flex items-center justify-between">
                <div className="text-sm text-muted-foreground">Total Redactions</div>
                <button
                  onClick={fetchSummary}
                  disabled={refreshing}
                  className="p-1 rounded hover:bg-accent transition-colors disabled:opacity-50 disabled:cursor-not-allowed"
                  aria-label="Refresh redaction count"
                  title="Refresh count"
                >
                  {refreshing ? (
                    <Spinner size={14} className="text-primary" />
                  ) : (
                    <svg className="w-4 h-4 text-muted-foreground" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                      <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M4 4v5h.582m15.356 2A8.001 8.001 0 004.582 9m0 0H9m11 11v-5h-.581m0 0a8.003 8.003 0 01-15.357-2m15.357 2H15" />
                    </svg>
                  )}
                </button>
              </div>
              <div className="text-3xl font-bold text-primary mt-1">
                <span title="Sum of maximum redactions per session. For each session, the highest count of each placeholder type across all its captures is used. This avoids double-counting when a session has multiple captures.">
                  {summary?.totalRedactions ?? 0}
                </span>
              </div>
            </div>
          </div>

          {/* Breakdown by Type */}
          <div className="rounded-lg border p-4">
            <div className="flex items-center justify-between mb-4">
              <h2 className="text-xl font-semibold">Breakdown by Redaction Type</h2>
              {selectedRedactionType && (
                <button
                  onClick={() => handleRedactionTypeClick(selectedRedactionType)}
                  className="text-xs text-primary hover:underline"
                >
                  Clear filter
                </button>
              )}
            </div>
            <div className="grid gap-3 md:grid-cols-3 lg:grid-cols-5">
              {summary && Object.keys(summary.byType ?? {}).length > 0 ? (
                Object.entries(summary.byType ?? {}).map(([placeholder, count]) => (
                  <button
                    key={placeholder}
                    onClick={() => handleRedactionTypeClick(placeholder)}
                    className={`rounded-lg border p-3 transition-colors text-left ${
                      selectedRedactionType === placeholder
                        ? "bg-primary/10 border-primary"
                        : "hover:bg-accent"
                    }`}
                    title="Maximum count of this placeholder type in any single session. Click to filter the details table below."
                  >
                    <div className="text-sm text-muted-foreground capitalize">{placeholder.replace(/_/g, " ")}</div>
                    <div className="text-2xl font-bold">
                      <span title="Max count of this placeholder in any single capture per session, summed across all sessions.">
                        {count}
                      </span>
                    </div>
                  </button>
                ))
              ) : (
                <div className="col-span-full text-center text-muted-foreground py-8">
                  {_loadingSummary ? (
                    <>Loading breakdown...</>
                  ) : (
                    <>No redactions found</>
                  )}
                </div>
              )}
            </div>
          </div>

          {/* Details Table with Pagination */}
          <div className="rounded-lg border">
            <div className="border-b p-4 flex items-center justify-between">
              <div>
                <h2 className="text-xl font-semibold">Redaction Details</h2>
                <p className="text-sm text-muted-foreground">
                  {totalCount} total captures &bull; Page {page} of {totalPages || 1}
                </p>
              </div>
              <div className="flex items-center gap-4">
                {_loadingDetails && (
                  <div className="flex items-center gap-2 text-sm text-muted-foreground">
                    <Spinner size={14} />
                    <span>Loading details...</span>
                  </div>
                )}
                <label className="flex items-center gap-2 text-sm">
                  <input
                    type="checkbox"
                    checked={hideZeroRedactions}
                    onChange={(e) => setHideZeroRedactions(e.target.checked)}
                    className="rounded border-border text-primary focus:ring-primary"
                  />
                  <span className="text-muted-foreground">Hide rows with 0 total redactions</span>
                </label>
              </div>
            </div>
            <div className="relative overflow-x-auto">
              {_loadingDetails && (
                <div className="absolute inset-0 bg-background/80 flex items-center justify-center z-10">
                  <div className="flex flex-col items-center gap-3">
                    <Spinner size={32} className="text-primary" />
                    <span className="text-muted-foreground">Loading redaction details...</span>
                  </div>
                </div>
              )}
              <table className="w-full text-sm">
                <thead>
                  <tr className="border-b bg-muted/50">
                    {columnOrder.map((key, idx) => {
                      const labelMap: Record<string, string> = {
                        requestSource: "Source",
                        requestProvider: "Provider",
                        requestTarget: "Target",
                        sessionId: "Session ID",
                        captureId: "Capture ID",
                        timestamp: "Date/Time",
                        totalRedactions: "Total Redactions",
                        redactionsByType: "Redactions by Type",
                      };
                      const isLast = idx === columnOrder.length - 1;
                      return (
                        <th
                          key={key}
                          className="text-left py-3 px-4 cursor-pointer hover:bg-muted relative"
                          onClick={() => handleSort(key)}
                          draggable
                          onDragStart={() => handleDragStart(key)}
                          onDragOver={handleDragOver}
                          onDrop={() => handleDrop(key)}
                          onDragEnd={handleDragEnd}
                          style={{ width: columnWidths[key] ? `${columnWidths[key]}px` : undefined }}
                        >
                          {labelMap[key]}
                          {sortConfig?.key === key && (
                            <span className="ml-1">{sortConfig.direction === "asc" ? "▲" : "▼"}</span>
                          )}
                          {!isLast && (
                            <div
                              className="resize-handle absolute right-0 top-0 h-full w-1 cursor-col-resize bg-transparent hover:bg-primary"
                              onMouseDown={(e) => handleResizeStart(key, e)}
                            />
                          )}
                        </th>
                      );
                    })}
                  </tr>
                </thead>
                <tbody>
                  {details.map((row, index) => {
                    const rowKey = `${row.captureId}-${index}`;
                    return (
                      <tr key={rowKey} className="border-b hover:bg-accent/50">
                        {columnOrder.map((key) => (
                          <td
                            key={key}
                            className={
                              key === "requestProvider" || key === "totalRedactions"
                                ? "text-center"
                                : undefined
                            }
                          >
                            {renderCell(key, row)}
                          </td>
                        ))}
                      </tr>
                    );
                  })}
                  {(!details || details.length === 0) && (
                    <tr>
                      <td colSpan={columnOrder.length} className="py-12 text-center text-muted-foreground">
                        No redaction details found
                      </td>
                    </tr>
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
                    &larr; Previous
                  </button>
                  <span className="px-3 text-sm">
                    Page {page} of {totalPages}
                  </span>
                  <button
                    onClick={() => handlePageChange(page + 1)}
                    disabled={page >= totalPages}
                    className="rounded-md border px-3 py-1 text-sm hover:bg-accent disabled:opacity-50 disabled:cursor-not-allowed"
                  >
                    Next &rarr;
                  </button>
                </div>
              </div>
            )}
          </div>
        </div>
      </MainLayout>

      {/* Diff Dialog - Two-pane view showing pre/post redaction side by side */}
      <DiffDialog
        isOpen={diffDialogOpen}
        onClose={handleCloseDiff}
        preContent={diffDialogData?.preContent || ""}
        postContent={diffDialogData?.postContent || ""}
        fullOriginal={diffDialogData?.fullOriginal}
        fullRedacted={diffDialogData?.fullRedacted}
        matches={diffDialogData?.matches}
        title="Redaction Diff"
        captureId={diffDialogData?.captureId || ""}
        sessionId={diffDialogData?.sessionId || null}
        redactionType={diffDialogData?.redactionType || ""}
        provider={diffDialogData?.provider || ""}
        targetUrl={diffDialogData?.targetUrl || ""}
        timestamp={diffDialogData?.timestamp || ""}
        onAddFalsePositive={handleAddFalsePositive}
        isLoading={diffDialogLoading}
        onReady={() => setDiffDialogLoading(false)}
      />

      {/* Add False Positive Dialog - triggered from diff dialog */}
      {fpDialogOpen && fpDialogData && (
        <FalsePositiveManager
          initialData={fpDialogData}
          onEntryAdded={(entry) => {
            // Optionally refresh or show success message
            console.log("False positive added:", entry);
          }}
          onEntryRemoved={() => {}}
          onCleared={() => {}}
          onClose={() => {
            setFpDialogOpen(false);
            setFpDialogData(null);
          }}
        />
      )}
    </>
  );
}