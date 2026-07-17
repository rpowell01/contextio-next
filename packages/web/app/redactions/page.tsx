// @ts-nocheck
"use client";

import { MainLayout } from "@/components/main-layout";
import Link from "next/link";
import { useState, useEffect, useMemo } from "react";
import { X } from "lucide-react";

/**
 * Simple line-based diff algorithm.
 * Returns array of { type: 'equal' | 'delete' | 'insert', value: string, lineNumber?: number }
 */
function computeDiff(oldText: string, newText: string) {
  const oldLines = oldText.split('\n');
  const newLines = newText.split('\n');
  const result: Array<{ type: 'equal' | 'delete' | 'insert'; value: string; oldLineNum?: number; newLineNum?: number }> = [];

  // Simple longest common subsequence for lines
  const dp: number[][] = Array(oldLines.length + 1).fill(null).map(() => Array(newLines.length + 1).fill(0));
  
  for (let i = oldLines.length - 1; i >= 0; i--) {
    for (let j = newLines.length - 1; j >= 0; j--) {
      if (oldLines[i] === newLines[j]) {
        dp[i][j] = dp[i + 1][j + 1] + 1;
      } else {
        dp[i][j] = Math.max(dp[i + 1][j], dp[i][j + 1]);
      }
    }
  }

  let i = 0, j = 0;
  let oldLineNum = 1, newLineNum = 1;
  
  while (i < oldLines.length || j < newLines.length) {
    if (i < oldLines.length && j < newLines.length && oldLines[i] === newLines[j]) {
      result.push({ type: 'equal', value: oldLines[i], oldLineNum, newLineNum });
      i++; j++; oldLineNum++; newLineNum++;
    } else if (j < newLines.length && (i >= oldLines.length || dp[i][j + 1] >= dp[i + 1][j])) {
      result.push({ type: 'insert', value: newLines[j], newLineNum });
      j++; newLineNum++;
    } else if (i < oldLines.length) {
      result.push({ type: 'delete', value: oldLines[i], oldLineNum });
      i++; oldLineNum++;
    }
  }

  return result;
}

/**
 * DiffDialog component with two-pane layout showing pre-redaction (left) and post-redaction (right).
 */
function DiffDialog({
  isOpen,
  onClose,
  title,
  preContent,
  postContent,
  captureId,
  redactionType,
  provider,
  targetUrl,
  timestamp,
}: {
  isOpen: boolean;
  onClose: () => void;
  title: string;
  preContent: string;
  postContent: string;
  captureId: string;
  redactionType: string;
  provider: string;
  targetUrl: string;
  timestamp: string;
}) {
  if (!isOpen) return null;

  const diff = useMemo(() => computeDiff(preContent, postContent), [preContent, postContent]);

  const renderLine = (item: typeof diff[0], side: 'left' | 'right') => {
    const isLeft = side === 'left';
    const showLine = isLeft ? (item.type !== 'insert') : (item.type !== 'delete');
    
    if (!showLine) {
      return <div style={{ height: '1.25rem' }} />;
    }
    
    const lineNum = isLeft ? item.oldLineNum : item.newLineNum;
    const lineClass = `font-mono text-xs whitespace-pre-wrap ${
      item.type === 'delete' ? 'bg-red-100 dark:bg-red-900/30 line-through' :
      item.type === 'insert' ? 'bg-green-100 dark:bg-green-900/30' :
      'bg-transparent'
    }`;
    
    return (
      <div className={lineClass} style={{ padding: '2px 8px', borderRadius: '4px', minHeight: '1.25rem' }}>
        <span className="text-muted-foreground mr-2 select-none" style={{ width: '3rem', display: 'inline-block', textAlign: 'right' }}>
          {lineNum ?? ''}
        </span>
        {item.value || ' '}
      </div>
    );
  };

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/50">
      <div className="bg-white dark:bg-gray-900 rounded-lg shadow-xl max-w-6xl w-full mx-4 max-h-[85vh] flex flex-col">
        <div className="flex items-center justify-between p-4 border-b">
          <div>
            <h3 className="text-lg font-semibold">{title}</h3>
            <div className="flex flex-wrap gap-4 text-xs text-muted-foreground mt-1">
              <span>Type: <span className="font-mono capitalize">{redactionType.replace(/_/g, ' ')}</span></span>
              <span>Capture: <span className="font-mono">{captureId}</span></span>
              {provider && <span>Provider: <span className="font-mono">{provider}</span></span>}
              {targetUrl && <span>Target: <span className="font-mono truncate max-w-[200px]">{targetUrl}</span></span>}
              {timestamp && <span>Time: <span className="font-mono">{new Date(timestamp).toLocaleString()}</span></span>}
            </div>
          </div>
          <button
            onClick={onClose}
            className="p-1 rounded hover:bg-gray-100 dark:hover:bg-gray-800"
            aria-label="Close"
          >
            <X className="h-5 w-5" />
          </button>
        </div>
        <div className="flex flex-col md:flex-row overflow-hidden max-h-[75vh]">
          {/* Left pane - Pre-redaction (Original) */}
          <div className="flex-1 min-w-0 border-r border-gray-200 dark:border-gray-700 flex flex-col">
            <div className="p-2 bg-red-50 dark:bg-red-900/20 border-b border-gray-200 dark:border-gray-700">
              <h4 className="text-xs font-semibold text-red-700 dark:text-red-300">Pre-Redaction (Original)</h4>
            </div>
            <div className="flex-1 overflow-auto p-4 font-mono text-xs">
              {diff.map((chunk, idx) => (
                <div key={idx}>{renderLine(chunk, 'left')}</div>
              ))}
            </div>
          </div>
          
          {/* Right pane - Post-redaction (Redacted) */}
          <div className="flex-1 min-w-0 flex flex-col">
            <div className="p-2 bg-green-50 dark:bg-green-900/20 border-b border-gray-200 dark:border-gray-700">
              <h4 className="text-xs font-semibold text-green-700 dark:text-green-300">Post-Redaction (Redacted)</h4>
            </div>
            <div className="flex-1 overflow-auto p-4 font-mono text-xs">
              {diff.map((chunk, idx) => (
                <div key={idx}>{renderLine(chunk, 'right')}</div>
              ))}
            </div>
          </div>
        </div>
      </div>
    </div>
  );
}

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
  fullOriginal?: string;
  fullRedacted?: string;
  timestamp: string;
}
 
const PAGE_SIZE = 50;

/**
 * Highlights the redaction placeholder (e.g., [EMAIL_REDACTED]) in the post-redaction value,
 * and shows the original value that was replaced in the pre-redaction value (without extra markup).
 */
function RedactionHighlight({
  value,
  isPreRedaction = false,
}: {
  value: string;
  isPreRedaction?: boolean;
}) {
  // The placeholder format: [RULE_REDACTED] where RULE is uppercase with underscores
  const redactionPattern = /\[[A-Z][A-Z0-9_]*_REDACTED\]/g;

  if (isPreRedaction) {
    // For pre-redaction, the value IS the original string that was replaced.
    // Display it plainly (the dialog already isolates this substring).
    return <code className="font-mono text-xs">{value}</code>;
  }

  // For post-redaction, highlight the redaction placeholders
  const parts = value.split(redactionPattern);
  const matches = value.match(redactionPattern);

  if (!matches || matches.length === 0) {
    return <code className="font-mono text-xs">{value}</code>;
  }

  return (
    <code className="font-mono text-xs">
      {parts.map((part, i) => (
        <span key={i}>
          {part}
          {i < matches.length && (
            <mark className="bg-red-100 text-red-800 px-1 rounded font-medium">
              {matches[i]}
            </mark>
          )}
        </span>
      ))}
    </code>
  );
}

export default function RedactionsPage() {
  const [summary, _setSummary] = useState<RedactionSummary | null>(null);
  const [details, _setDetails] = useState<RedactionDetailRow[]>([]);
  const [_loadingSummary, _setLoadingSummary] = useState(true);
  const [_loadingDetails, _setLoadingDetails] = useState(true);
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
  const [columnOrder, setColumnOrder] = useState<string[]>([
    'redactionType',
    'requestSource',
    'requestProvider',
    'requestTarget',
    'sessionId',
    'captureId',
    'timestamp',
  ]);
  const [draggedKey, setDraggedKey] = useState<string | null>(null);
  const [columnWidths, setColumnWidths] = useState<Record<string, number>>({});
  const [resizingKey, setResizingKey] = useState<string | null>(null);
  const [resizeStartX, setResizeStartX] = useState<number>(0);
  const [resizeStartWidth, setResizeStartWidth] = useState<number>(0);

  // Debounce filter changes to avoid firing API request on every keystroke
  useEffect(() => {
    const timer = setTimeout(() => {
      setDebouncedFilters(filters);
    }, 300);
    return () => clearTimeout(timer);
  }, [filters]);

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
        const res = await fetch(`/api/redactions?${params.toString()}`);
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

  const handleFilterChange = (key: string, value: string) => {
    setFilters(prev => ({ ...prev, [key]: value }));
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
            <Link
              href="/"
              className="rounded-md bg-primary px-4 py-2 text-sm font-medium text-primary-foreground hover:bg-primary/90"
            >
              ← Back to Dashboard
            </Link>
          </div>

          {/* Summary Cards */}
          <div className="grid gap-4 md:grid-cols-2 lg:grid-cols-4">
            <div className="rounded-lg border p-4 bg-red-50 border-red-200">
              <div className="text-sm text-muted-foreground">Total Redactions</div>
              <div className="text-3xl font-bold text-red-600">{summary?.totalRedactions ?? 0}</div>
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
            <h2 className="text-xl font-semibold mb-4">Breakdown by Redaction Type</h2>
            <div className="grid gap-3 md:grid-cols-3 lg:grid-cols-5">
              {Object.entries(summary?.byType ?? {}).map(([type, count]) => (
                <div key={type} className="rounded-lg border p-3 hover:bg-accent transition-colors">
                  <div className="text-sm text-muted-foreground capitalize">{type.replace(/_/g, " ")}</div>
                  <div className="text-2xl font-bold">{count}</div>
                </div>
              ))}
              {Object.keys(summary?.byType ?? {}).length === 0 && (
                <div className="col-span-full text-center text-muted-foreground py-8">
                  No redactions found
                </div>
              )}
            </div>
          </div>

          {/* Details Table with Pagination */}
          <div className="rounded-lg border">
            <div className="border-b p-4">
              <h2 className="text-xl font-semibold">Redaction Details</h2>
              <p className="text-sm text-muted-foreground">
                {totalCount} total redaction entries • Page {page} of {totalPages || 1}
              </p>
            </div>
            <div className="overflow-x-auto">
              <table className="w-full text-sm">
                <thead>
                  <tr className="border-b bg-muted/50">
                    {columnOrder.map((key, idx) => {
                      const labelMap: Record<string, string> = {
                        redactionType: 'Redaction Type',
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
                    <th className="text-left py-3 px-4">Pre-Redaction</th>
                    <th className="text-left py-3 px-4">Post-Redaction</th>
                  </tr>
                  <tr className="border-b bg-muted/50">
                    {columnOrder.map((key) => (
                      <th key={key} className="py-1 px-4">
                        <input
                          type="text"
                          placeholder="Filter…"
                          className="w-full text-xs rounded border px-2 py-1"
                          value={filters[key] || ''}
                          onChange={e => handleFilterChange(key, e.target.value)}
                        />
                      </th>
                    ))}
                    <th className="py-1 px-4"></th>
                    <th className="py-1 px-4"></th>
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
                            onClick={() => {
                              setDiffDialogData({
                                preContent: row.fullOriginal || row.preRedactionValue,
                                postContent: row.fullRedacted || row.postRedactionValue,
                                captureId: row.captureId,
                                redactionType: row.redactionType,
                                provider: row.requestProvider,
                                targetUrl: row.requestTarget,
                                timestamp: row.timestamp,
                              });
                              setDiffDialogOpen(true);
                            }}
                          >
                            <RedactionHighlight value={row.preRedactionValue} isPreRedaction />
                          </span>
                        </td>
                        <td className="py-3 px-4 max-w-xs truncate">
                          <span
                            className="text-primary underline cursor-pointer hover:text-primary/80"
                            onClick={() => {
                              setDiffDialogData({
                                preContent: row.fullOriginal || row.preRedactionValue,
                                postContent: row.fullRedacted || row.postRedactionValue,
                                captureId: row.captureId,
                                redactionType: row.redactionType,
                                provider: row.requestProvider,
                                targetUrl: row.requestTarget,
                                timestamp: row.timestamp,
                              });
                              setDiffDialogOpen(true);
                            }}
                          >
                            <RedactionHighlight value={row.postRedactionValue} />
                          </span>
                        </td>
                      </tr>
                    );
                  })}
                  {(!details || details.length === 0) && (
                    <tr>
                      <td colSpan={columnOrder.length + 2} className="py-12 text-center text-muted-foreground">
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
        onClose={() => setDiffDialogOpen(false)}
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
