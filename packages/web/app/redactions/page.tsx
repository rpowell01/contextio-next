// @ts-nocheck
"use client";

import { MainLayout } from "@/components/main-layout";
import Link from "next/link";
import { useState } from "react";
import { X } from "lucide-react";

/**
 * Simple dialog component with scrollbars and close button.
 * Renders full text with a specific needle highlighted (all occurrences).
 */
function ContentDialog({
  isOpen,
  onClose,
  title,
  fullText,
  needle,
  isPreRedaction = false,
}: {
  isOpen: boolean;
  onClose: () => void;
  title: string;
  fullText: string;
  needle: string;
  isPreRedaction?: boolean;
}) {
  if (!isOpen) return null;

  // Highlight all occurrences of needle in fullText
  const highlightParts = () => {
    if (!needle) return <code className="font-mono text-xs">{fullText}</code>;
    const parts = fullText.split(needle);
    if (parts.length === 1) return <code className="font-mono text-xs">{fullText}</code>;
    return (
      <code className="font-mono text-xs">
        {parts.map((part, i) => (
          <>
            {part}
            {i < parts.length - 1 && (
              <mark className={`px-1 rounded font-medium ${isPreRedaction ? "bg-amber-100 text-amber-800" : "bg-red-100 text-red-800"}`}>
                {needle}
              </mark>
            )}
          </>
        ))}
      </code>
    );
  };

  if (!isOpen) return null;
  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/50">
      <div className="bg-white dark:bg-gray-900 rounded-lg shadow-xl max-w-3xl w-full mx-4 max-h-[80vh] flex flex-col">
        <div className="flex items-center justify-between p-4 border-b">
          <h3 className="text-lg font-semibold">{title}</h3>
          <button
            onClick={onClose}
            className="p-1 rounded hover:bg-gray-100 dark:hover:bg-gray-800"
            aria-label="Close"
          >
            <X className="h-5 w-5" />
          </button>
        </div>
        <div className="p-4 overflow-auto max-h-[70vh] font-mono text-xs whitespace-pre-wrap">
          {highlightParts()}
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
  const [preDialogOpen, setPreDialogOpen] = useState(false);
  const [preDialogContent, setPreDialogContent] = useState("");
  const [preNeedle, setPreNeedle] = useState("");
  const [postDialogOpen, setPostDialogOpen] = useState(false);
  const [postDialogContent, setPostDialogContent] = useState("");
  const [postNeedle, setPostNeedle] = useState("");
  const [sortConfig, setSortConfig] = useState<{ key: string; direction: 'asc' | 'desc' } | null>(null);
  const [filters, setFilters] = useState<Record<string, string>>({});
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
  };

  const filteredDetails = details.filter(row => {
    return Object.entries(filters).every(([key, val]) => {
      if (!val) return true;
      const cell = row[key as keyof RedactionDetailRow];
      return String(cell ?? '').toLowerCase().includes(val.toLowerCase());
    });
  });

  const sortedDetails = [...filteredDetails].sort((a, b) => {
    if (!sortConfig) return 0;
    const aVal = a[sortConfig.key as keyof RedactionDetailRow];
    const bVal = b[sortConfig.key as keyof RedactionDetailRow];
    if (aVal === null || aVal === undefined) return sortConfig.direction === 'asc' ? 1 : -1;
    if (bVal === null || bVal === undefined) return sortConfig.direction === 'asc' ? -1 : 1;
    if (aVal < bVal) return sortConfig.direction === 'asc' ? -1 : 1;
    if (aVal > bVal) return sortConfig.direction === 'asc' ? 1 : -1;
    return 0;
  });

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
                    {columnOrder.map((key) => {
                      const labelMap: Record<string, string> = {
                        redactionType: 'Redaction Type',
                        requestSource: 'Source',
                        requestProvider: 'Provider',
                        requestTarget: 'Target',
                        sessionId: 'Session ID',
                        captureId: 'Capture ID',
                        timestamp: 'Date/Time',
                      };
                      return (
                        <th
                          key={key}
                          className="text-left py-3 px-4 cursor-pointer hover:bg-muted"
                          onClick={() => handleSort(key)}
                          draggable
                          onDragStart={() => handleDragStart(key)}
                          onDragOver={handleDragOver}
                          onDrop={() => handleDrop(key)}
                          onDragEnd={handleDragEnd}
                        >
                          {labelMap[key]}
                          {sortConfig?.key === key && (
                            <span className="ml-1">{sortConfig.direction === 'asc' ? '▲' : '▼'}</span>
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
                          onChange={e => setFilters(prev => ({...prev, [key]: e.target.value}))}
                        />
                      </th>
                    ))}
                    <th className="py-1 px-4"></th>
                    <th className="py-1 px-4"></th>
                  </tr>
                </thead>
<tbody>
                  {sortedDetails.map((row, index) => {
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
                              setPreDialogContent(row.fullOriginal || row.preRedactionValue);
                              setPreNeedle(row.preRedactionValue);
                              setPreDialogOpen(true);
                            }}
                          >
                            <RedactionHighlight value={row.preRedactionValue} isPreRedaction />
                          </span>
                        </td>
                        <td className="py-3 px-4 max-w-xs truncate">
                          <span
                            className="text-primary underline cursor-pointer hover:text-primary/80"
                            onClick={() => {
                              setPostDialogContent(row.fullRedacted || row.postRedactionValue);
                              setPostNeedle(row.postRedactionValue);
                              setPostDialogOpen(true);
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

      {/* Pre-Redaction Dialog */}
      <ContentDialog
        isOpen={preDialogOpen}
        onClose={() => setPreDialogOpen(false)}
        title="Pre-Redaction (Original)"
        fullText={preDialogContent}
        needle={preNeedle}
        isPreRedaction={true}
      />

      {/* Post-Redaction Dialog */}
      <ContentDialog
        isOpen={postDialogOpen}
        onClose={() => setPostDialogOpen(false)}
        title="Post-Redaction (Redacted)"
        fullText={postDialogContent}
        needle={postNeedle}
        isPreRedaction={false}
      />
    </>
  );
                
}