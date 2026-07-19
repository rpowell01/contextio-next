// @ts-nocheck
"use client";

import { MainLayout } from "@/components/main-layout";
import Link from "next/link";
import { useState, useEffect, useMemo, useRef, useCallback } from "react";

import { computeDiff, type DiffChunk, filterDiffWithContext } from "@/lib/diff";
import { DiffDialog } from "@/components/ui/diff-dialog";
import { RedactionHighlight } from "@/components/ui/redaction-highlight";

interface RedactionSummary {
  totalRedactions: number;
  byType: Record<string, number>;
}

interface RedactionDetailRow {
  redactionType: string;
  requestSource: string | null;
  requestProvider: string;
  requestTarget: string;
  sessionId: string | null;
  captureId: string;
  preRedactionValue: string;
  postRedactionValue: string;
  path: string;
  fullOriginal?: string;
  fullRedacted?: string;
  timestamp: string;
  matchIndex: number;
}

const PAGE_SIZE = 50;

export default function RedactionsPage() {
  const [summary, _setSummary] = useState<RedactionSummary | null>(null);
  const [details, _setDetails] = useState<RedactionDetailRow[]>([]);
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
    captureId: string;
    redactionType: string;
    provider: string;
    targetUrl: string;
    timestamp: string;
  } | null>(null);
  const [sortConfig, setSortConfig] = useState<{ key: string; direction: 'asc' | 'desc' } | null>(null);
  const [filters, setFilters] = useState<Record<string, string>>({});
  // Debounced filters for API calls - prevents firing on every keystroke
  const [debouncedFilters, setDebouncedFilters] = useState<Record<string, string>>({});
  // Selected redaction type filter from breakdown widgets
  const [selectedRedactionType, setSelectedRedactionType] = useState<string | null>(null);
  const [columnOrder, setColumnOrder] = useState<string[]>([
    'timestamp',
    'requestSource',
    'requestProvider',
    'requestTarget',
    'sessionId',
    'captureId',
  ]);
  const [columnWidths, setColumnWidths] = useState<Record<string, number>>({});
  const [draggedKey, setDraggedKey] = useState<string | null>(null);
  const [resizingKey, setResizingKey] = useState<string | null>(null);
  const [resizeStartX, setResizeStartX] = useState<number>(0);
  const [resizeStartWidth, setResizeStartWidth] = useState<number>(0);

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
    console.log("[Redactions] fetchSummary called, current refreshing:", refreshing);
    setRefreshing(true);
    console.log("[Redactions] setRefreshing(true) called");
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
    }
  }, []);

  useEffect(() => {
    fetchSummary();
  }, [fetchSummary]);

const handleOpenDiff = useCallback(async (e: React.MouseEvent, row: RedactionDetailRow) => {
    lastFocusedTrigger.current = e.currentTarget as HTMLElement;

    // Use the detail endpoint which returns fullOriginal/fullRedacted for the specific match
    let preContent = row.fullOriginal || row.preRedactionValue;
    let postContent = row.fullRedacted || row.postRedactionValue;

    try {
      const res = await fetch(`/api/redactions/detail/${row.captureId}/${row.matchIndex}`);
      if (res.ok) {
        const detail = await res.json();
        if (detail.fullOriginal) preContent = detail.fullOriginal;
        if (detail.fullRedacted) postContent = detail.fullRedacted;
      }
    } catch (err) {
      console.warn('Failed to fetch redaction detail for diff:', err);
      // Fall back to substring values
    }

    setDiffDialogData({
      preContent,
      postContent,
      captureId: row.captureId,
      redactionType: row.redactionType,
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

// Debounce filter changes to avoid firing API request on every keystroke

  useEffect(() => {
    const timer = setTimeout(() => {
      const newFilters = { ...filters };
      if (selectedRedactionType) {
        newFilters.redactionType = selectedRedactionType;
      }
      console.log('[RedactionFilter] Setting debouncedFilters:', newFilters);
      setDebouncedFilters(newFilters);
    }, 300);
    return () => clearTimeout(timer);
  }, [filters, selectedRedactionType]);

  // Also update debouncedFilters immediately for redactionType filter (click-based, no debounce needed)
  useEffect(() => {
    if (selectedRedactionType !== undefined) {
      setDebouncedFilters(prev => {
        const next = { ...prev };
        if (selectedRedactionType) {
          next.redactionType = selectedRedactionType;
        } else {
          delete next.redactionType;
        }
        return next;
      });
    }
  }, [selectedRedactionType]);

  // Fetch summary data
  useEffect(() => {
    let cancelled = false;
    const fetchSummary = async () => {
      try {
        const res = await fetch("/api/redactions?summary=true");
        if (!res.ok) throw new Error("Failed to fetch summary");
        const data = await res.json();
        if (!cancelled) {
          _setSummary(data.summary);
        }
      } catch (err) {
        if (!cancelled) {
          _setError(err instanceof Error ? err.message : "Failed to load summary");
        }
      } finally {
        if (!cancelled) {
          _setLoadingSummary(false);
        }
      }
    };
    fetchSummary();
    return () => { cancelled = true; };
  }, []);

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
        console.log('[RedactionFilter] Fetching:', url);
        const res = await fetch(url);
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

  const handleResizeStart = (key: string, e: React.MouseEvent) => {
    e.preventDefault();
    e.stopPropagation();
    const th = e.currentTarget.closest('th') as HTMLElement | null;
    const startWidth = th ? th.offsetWidth : 100;
    setResizingKey(key);
    setResizeStartX(e.clientX);
    setResizeStartWidth(startWidth);
    document.addEventListener('mousemove', handleResizeMove);
    document.addEventListener('mouseup', handleResizeEnd);
  };

  const handleResizeMove = (e: MouseEvent) => {
    if (!resizingKey) return;
    const delta = e.clientX - resizeStartX;
    const newWidth = Math.max(50, resizeStartWidth + delta);
    setColumnWidths(prev => ({ ...prev, [resizingKey]: newWidth }));
  };

  const handleResizeEnd = () => {
    document.removeEventListener('mousemove', handleResizeMove);
    document.removeEventListener('mouseup', handleResizeEnd);
    setResizingKey(null);
  };

  const handleDragStart = (key: string) => setDraggedKey(key);
  const handleDragOver = (e: React.DragEvent) => e.preventDefault();
  const handleDrop = (targetKey: string) => {
    if (!draggedKey || draggedKey === targetKey) return;
    setColumnOrder(prev => {
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

  const renderCell = (key: string, row: RedactionDetailRow) => {
    switch (key) {
      case 'redactionType':
        return <span className="font-medium capitalize">{row.redactionType.replace(/_/g, " ")}</span>;
      case 'requestSource':
        return <span className="text-muted-foreground">{row.requestSource ?? "—"}</span>;
      case 'requestProvider':
        return <span>{row.requestProvider}</span>;
      case 'requestTarget':
        return <span className="max-w-xs truncate">{row.requestTarget}</span>;
      case 'sessionId':
        return <span className="font-mono text-xs">{row.sessionId ?? "—"}</span>;
      case 'captureId':
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
      case 'timestamp':
        return <span className="font-mono text-xs">{new Date(row.timestamp).toLocaleString()}</span>;
      default:
        return null;
    }
  };

  const handleSort = (key: string) => {
    setSortConfig(prev => {
      if (prev && prev.key === key && prev.direction === 'asc') {
        return { key, direction: 'desc' };
      }
      return { key, direction: 'asc' };
    });
    setPage(1); // Reset to first page when sort changes
  };

  // Convert preset rule name to ruleId format
  // Rule names from presets use hyphens (e.g., "api-key-prefixed")
  // The redaction engine stores rule.name directly as ruleId
  // So we use the name as-is, no conversion needed
  const presetNameToRuleId = (presetName: string): string => {
    return presetName;
  };

  const handleFilterChange = (key: string, value: string) => {
    setFilters(prev => ({ ...prev, [key]: value }));
    setPage(1); // Reset to first page when filter changes
  };

  const handleRedactionTypeClick = (type: string) => {
    const ruleId = presetNameToRuleId(type);
    console.log('[RedactionFilter] Clicked type:', type, '-> ruleId:', ruleId, 'current:', selectedRedactionType);
    if (selectedRedactionType === ruleId) {
      setSelectedRedactionType(null);
    } else {
      setSelectedRedactionType(ruleId);
    }
    setPage(1); // Reset to first page when filter changes
  };

  return (
    <>
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
                ← Back to Dashboard
              </Link>
            </div>
          </div>

          {/* Summary Cards */}
          <div className="grid gap-4 md:grid-cols-2 lg:grid-cols-4">
            <div className="rounded-lg border p-4 bg-red-50 border-red-200">
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
                    <Spinner size={14} className="text-red-600" />
                  ) : (
                    <svg className="w-4 h-4 text-muted-foreground" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                      <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M4 4v5h.582m15.356 2A8.001 8.001 0 004.582 9m0 0H9m11 11v-5h-.581m0 0a8.003 8.003 0 01-15.357-2m15.357 2H15" />
                    </svg>
                  )}
                </button>
              </div>
              <div className="text-3xl font-bold text-red-600 mt-1">{summary?.totalRedactions ?? 0}</div>
            </div>
            {Object.entries(summary?.byType ?? {}).slice(0, 3).map(([type, count]) => (
              <div key={type} className="rounded-lg border p-4 bg-muted/50">
                <div className="text-sm text-muted-foreground capitalize">{type}</div>
                <div className="text-2xl font-bold">{count}</div>
              </div>
            ))}
          </div>

          {/* Breakdown by Type */}
          <div className="rounded-lg border p-4">
            <div className="flex items-center justify-between mb-4">
              <h2 className="text-xl font-semibold">Breakdown by Redaction Type</h2>
              {selectedRedactionType && (
                <button
                  onClick={() => handleRedactionTypeClick(presetNameToRuleId(selectedRedactionType))}
                  className="text-xs text-primary hover:underline"
                >
                  Clear filter
                </button>
              )}
            </div>
            <div className="grid gap-3 md:grid-cols-3 lg:grid-cols-5">
              {summary && Object.keys(summary.byType ?? {}).length > 0 ? (
                Object.entries(summary.byType ?? {}).map(([type, count]) => (
                  <button
                    key={type}
                    onClick={() => handleRedactionTypeClick(type)}
                    className={`rounded-lg border p-3 transition-colors text-left ${
                      selectedRedactionType === presetNameToRuleId(type)
                        ? 'bg-primary/10 border-primary'
                        : 'hover:bg-accent'
                    }`}
                  >
                    <div className="text-sm text-muted-foreground capitalize">{type.replace(/_/g, " ")}</div>
                    <div className="text-2xl font-bold">{count}</div>
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
                  {totalCount} total redaction entries • Page {page} of {totalPages || 1}
                </p>
              </div>
              {_loadingDetails && (
                <div className="flex items-center gap-2 text-sm text-muted-foreground">
                  <Spinner size={14} />
                  <span>Loading details...</span>
                </div>
              )}
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
                         requestSource: 'Source',
                         requestProvider: 'Provider',
                         requestTarget: 'Target',
                         sessionId: 'Session ID',
                         captureId: 'Capture ID',
                         timestamp: 'Date/Time',
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
                             <span className="ml-1">{sortConfig.direction === 'asc' ? '▲' : '▼'}</span>
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
<th className="text-left py-3 px-4">Redaction Diff</th>
                    </tr>
                 </thead>
<tbody>
                  {details.map((row, index) => {
                    const rowKey = `${row.captureId}-${index}`;
                    return (
                      <tr key={rowKey} className="border-b hover:bg-accent/50">
                        {columnOrder.map((key) => (
                          <td key={key}>{renderCell(key, row)}</td>
                        ))}
                        <td className="py-3 px-4 max-w-xs truncate">
              <span
                className="text-primary underline cursor-pointer hover:text-primary/80"
                onClick={(e) => handleOpenDiff(e, row)}
              >
                <RedactionHighlight value={row.postRedactionValue} />
              </span>
                        </td>
                      </tr>
                    );
                  })}
                  {(!details || details.length === 0) && (
                    <tr>
                      <td colSpan={columnOrder.length + 1} className="py-12 text-center text-muted-foreground">
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
                  Showing {Math.min((page - 1) * PAGE_SIZE + 1, totalCount)} to {Math.min(page * PAGE_SIZE, totalCount)} of {totalCount} entries
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
      </MainLayout>

      {/* Diff Dialog - Two-pane view showing pre/post redaction side by side */}
      <DiffDialog
        isOpen={diffDialogOpen}
        onClose={handleCloseDiff}
        preContent={diffDialogData?.preContent || ""}
        postContent={diffDialogData?.postContent || ""}
        title="Redaction Diff"
        captureId={diffDialogData?.captureId || ""}
        redactionType={diffDialogData?.redactionType || ""}
        provider={diffDialogData?.provider || ""}
        targetUrl={diffDialogData?.targetUrl || ""}
        timestamp={diffDialogData?.timestamp || ""}
      />
    </>
  );
}
