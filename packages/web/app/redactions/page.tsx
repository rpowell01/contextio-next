"use client";

import React from "react";
import { MainLayout } from "@/components/main-layout";
import Link from "next/link";
import { useState, useEffect, useRef } from "react";
import { useRouter } from "next/navigation";
import { X } from "lucide-react";

/**
 * Simple dialog component with scrollbars and close button.
 */
function ContentDialog({
  isOpen,
  onClose,
  title,
  content,
}: {
  isOpen: boolean;
  onClose: () => void;
  title: string;
  content: string;
}) {
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
          {content}
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
}

interface PaginatedDetailResponse {
  details: RedactionDetailRow[];
  page: number;
  pageSize: number;
  totalPages: number;
  totalCount: number;
}

const PAGE_SIZE = 50;

/**
 * Highlight component for redacted strings.
 * Highlights the redaction placeholder (e.g., [EMAIL_REDACTED]) in the post-redaction value,
 * and highlights the original value that was replaced in the pre-redaction value.
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
    // For pre-redaction, the value IS the original string that was replaced
    // Highlight it with a yellow/amber background to indicate "this was replaced"
    return (
      <code className="font-mono text-xs">
        <mark className="bg-amber-100 text-amber-800 px-1 rounded font-medium">
          {value}
        </mark>
      </code>
    );
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

/**
 * Compute preview pieces for a redaction value.
 * Returns pieces for tooltip rendering.
 */
function computePreview(value: string, isPreRedaction: boolean) {
  const PREVIEW_CONTEXT = 100;
  const redactionPattern = /\[[A-Z][A-Z0-9_]*_REDACTED\]/g;

  if (isPreRedaction) {
    if (value.length <= PREVIEW_CONTEXT * 2 + 20) {
      return { beforeHighlight: "", highlighted: value, afterHighlight: "", previewStart: 0, previewEnd: value.length };
    }
    const mid = Math.floor(value.length / 2);
    const start = Math.max(0, mid - PREVIEW_CONTEXT);
    const end = Math.min(value.length, mid + PREVIEW_CONTEXT);
    return {
      beforeHighlight: value.slice(0, start),
      highlighted: value.slice(start, end),
      afterHighlight: value.slice(end),
      previewStart: start,
      previewEnd: end,
    };
  }

  const matches = [...value.matchAll(redactionPattern)];
  if (matches.length === 0) {
    return { beforeHighlight: "", highlighted: value, afterHighlight: "", previewStart: 0, previewEnd: value.length };
  }

  const match = matches[0];
  const matchIndex = match.index ?? 0;
  const matchLength = match[0].length;

  const start = Math.max(0, matchIndex - PREVIEW_CONTEXT);
  const end = Math.min(value.length, matchIndex + matchLength + PREVIEW_CONTEXT);

  return {
    beforeHighlight: value.slice(start, matchIndex),
    highlighted: value.slice(matchIndex, matchIndex + matchLength),
    afterHighlight: value.slice(matchIndex + matchLength, end),
    previewStart: start,
    previewEnd: end,
  };
}

/**
 * Pure presentational tooltip component.
 * Receives pre‑computed preview pieces and a fixed position, renders fixed positioned tooltip.
 */
function RedactionTooltip({
  beforeHighlight,
  highlighted,
  afterHighlight,
  previewStart,
  previewEnd,
  isPreRedaction,
  valueLength,
  position,
}: {
  beforeHighlight: string;
  highlighted: string;
  afterHighlight: string;
  previewStart: number;
  previewEnd: number;
  isPreRedaction: boolean;
  valueLength: number;
  position: { x: number; y: number };
}) {
  return (
    <div
      className="fixed z-50 max-w-2xl px-3 py-2 bg-gray-900 text-white rounded-lg shadow-lg border border-gray-700 shadow-xl font-mono text-xs whitespace-pre-wrap overflow-auto max-h-64"
      style={{ left: position.x, top: position.y, pointerEvents: 'none' }}
    >
      <div className="flex items-start gap-1">
        {beforeHighlight && <span className="text-gray-400">{beforeHighlight}</span>}
        <mark
          className={`px-1 rounded font-medium ${
            isPreRedaction
              ? "bg-amber-500 text-amber-950"
              : "bg-red-500 text-red-50"
          }`}
        >
          {highlighted}
        </mark>
        {afterHighlight && <span className="text-gray-400">{afterHighlight}</span>}
      </div>
      {(previewStart > 0 || previewEnd < valueLength) && (
        <div className="mt-1 text-xs text-gray-500 italic">
          … truncated ({valueLength} chars total) …
        </div>
      )}
    </div>
  );
}

/**
 * Wrapper component that shows tooltip on hover.
 * Positions tooltip fixed relative to viewport using the wrapper's bounding rect.
 */
function TooltipWrapper({
  children,
  value,
  isPreRedaction = false,
}: {
  children: React.ReactNode;
  value: string;
  isPreRedaction?: boolean;
}) {
  const [show, setShow] = useState(false);
  const [pos, setPos] = useState<{ x: number; y: number } | null>(null);
  const wrapperRef = useRef<HTMLSpanElement>(null);

  const preview = computePreview(value, isPreRedaction);

  const handleMouseEnter = (e: React.MouseEvent<HTMLSpanElement>) => {
    const rect = e.currentTarget.getBoundingClientRect();
    // Position tooltip just below the cell
    setPos({ x: rect.left + window.scrollX, y: rect.bottom + window.scrollY + 4 });
    setShow(true);
  };

  const handleMouseLeave = () => {
    setShow(false);
    setPos(null);
  };

  return (
    <span ref={wrapperRef} onMouseEnter={handleMouseEnter} onMouseLeave={handleMouseLeave} className="relative inline-block">
      {children}
      {show && pos && (
        <RedactionTooltip
          beforeHighlight={preview.beforeHighlight}
          highlighted={preview.highlighted}
          afterHighlight={preview.afterHighlight}
          previewStart={preview.previewStart}
          previewEnd={preview.previewEnd}
          isPreRedaction={isPreRedaction}
          valueLength={value.length}
          position={pos}
        />
      )}
    </span>
  );
}

export default function RedactionsPage() {
  const [summary, setSummary] = useState<RedactionSummary | null>(null);
  const [details, setDetails] = useState<RedactionDetailRow[]>([]);
  const [loadingSummary, setLoadingSummary] = useState(true);
  const [loadingDetails, setLoadingDetails] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [page, setPage] = useState(1);
  const [totalPages, setTotalPages] = useState(1);
  const [totalCount, setTotalCount] = useState(0);
  const [preDialogOpen, setPreDialogOpen] = useState(false);
  const [preDialogContent, setPreDialogContent] = useState("");
  const [postDialogOpen, setPostDialogOpen] = useState(false);
  const [postDialogContent, setPostDialogContent] = useState("");
  const router = useRouter();

  // Fetch summary (fast, cached)
  useEffect(() => {
    async function fetchSummary() {
      try {
        const response = await fetch("/api/redactions?summary=true");
        if (!response.ok) throw new Error("Failed to fetch redaction summary");
        const json = await response.json();
        setSummary(json.summary);
      } catch (e) {
        console.error("Error fetching summary:", e);
      }
    }
    fetchSummary();
  }, []);

  // Fetch details for current page
  useEffect(() => {
    async function fetchDetails() {
      try {
        setLoadingDetails(true);
        const response = await fetch(`/api/redactions/detail?page=${page}&pageSize=${PAGE_SIZE}`);
        if (!response.ok) throw new Error("Failed to fetch redaction details");
        const json: PaginatedDetailResponse = await response.json();
        setDetails(json.details);
        setTotalPages(json.totalPages);
        setTotalCount(json.totalCount);
        setError(null);
      } catch (e) {
        setError(e instanceof Error ? e.message : "Unknown error");
      } finally {
        setLoadingDetails(false);
        setLoadingSummary(false);
      }
    }
    fetchDetails();
  }, [page]);

  const handleRowClick = (row: RedactionDetailRow) => {
    if (row.sessionId) {
      router.push(`/sessions/${row.sessionId}?captureId=${row.captureId}`);
    }
  };

  const handlePageChange = (newPage: number) => {
    if (newPage >= 1 && newPage <= totalPages) {
      setPage(newPage);
    }
  };

  const [preDialogOpen, setPreDialogOpen] = useState(false);
  const [preDialogContent, setPreDialogContent] = useState("");
  const [postDialogOpen, setPostDialogOpen] = useState(false);
  const [postDialogContent, setPostDialogContent] = useState("");

  const openPreDialog = (content: string) => {
    setPreDialogContent(content);
    setPreDialogOpen(true);
  };
  const closePreDialog = () => setPreDialogOpen(false);
  const openPostDialog = (content: string) => {
    setPostDialogContent(content);
    setPostDialogOpen(true);
  };
  const closePostDialog = () => setPostDialogOpen(false);

  if (loadingSummary || loadingDetails) {
    return (
      <MainLayout>
        <div className="space-y-6">
          <div className="flex items-center justify-between">
            <div>
              <h1 className="text-3xl font-bold tracking-tight">Redactions</h1>
              <p className="text-muted-foreground">View all redacted data across captures</p>
            </div>
          </div>
          <div className="space-y-4">
            {[...Array(3)].map((_, i) => (
              <div key={i} className="rounded-lg border p-6">
                <div className="h-8 bg-muted-foreground/20 rounded mb-4" style={{ width: "300px" }} />
                <div className="space-y-3">
                  <div className="h-4 bg-muted-foreground/20 rounded" style={{ width: "400px" }} />
                  <div className="h-4 bg-muted-foreground/20 rounded" style={{ width: "300px" }} />
                </div>
              </div>
            ))}
          </div>
        </div>
      </MainLayout>
    );
  }

  if (error) {
    return (
      <MainLayout>
        <div className="space-y-6">
          <div className="flex items-center justify-between">
            <div>
              <h1 className="text-3xl font-bold tracking-tight">Redactions</h1>
              <p className="text-muted-foreground">View all redacted data across captures</p>
            </div>
          </div>
          <div className="rounded-lg border border-destructive bg-destructive/10 p-4">
            <p className="text-destructive">Error: {error}</p>
          </div>
        </div>
      </MainLayout>
    );
  }

  return (
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
                  <th className="text-left py-3 px-4">Redaction Type</th>
                  <th className="text-left py-3 px-4">Source</th>
                  <th className="text-left py-3 px-4">Provider</th>
                  <th className="text-left py-3 px-4">Target</th>
                  <th className="text-left py-3 px-4">Session ID</th>
                  <th className="text-left py-3 px-4">Capture ID</th>
                  <th className="text-left py-3 px-4">Pre-Redaction</th>
                  <th className="text-left py-3 px-4">Post-Redaction</th>
                </tr>
              </thead>
              <tbody>
                {details.map((row, index) => {
                  const rowKey = `${row.captureId}-${index}`;
                  return (
                    <tr
                      key={rowKey}
                      className="border-b hover:bg-accent/50"
                    >
                      <td className="py-3 px-4 font-medium capitalize">{row.redactionType.replace(/_/g, " ")}</td>
                      <td className="py-3 px-4 text-muted-foreground">{row.requestSource ?? "—"}</td>
                      <td className="py-3 px-4">{row.requestProvider}</td>
                      <td className="py-3 px-4 max-w-xs truncate">{row.requestTarget}</td>
                      <td className="py-3 px-4 font-mono text-xs">{row.sessionId ?? "—"}</td>
                      <td className="py-3 px-4 font-mono text-xs">
                        {row.sessionId ? (
                          <Link
                            href={`/sessions/${row.sessionId}?captureId=${row.captureId}`}
                            className="text-primary underline hover:text-primary/80"
                          >
                            {row.captureId}
                          </Link>
                        ) : (
                          <span className="text-muted-foreground">{row.captureId}</span>
                        )}
                      </td>
                      <td className="py-3 px-4 max-w-xs truncate">
                        <span
                          className="text-primary underline cursor-pointer hover:text-primary/80"
                          onClick={() => {
                            setPreDialogContent(row.preRedactionValue);
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
                            setPostDialogContent(row.postRedactionValue);
                            setPostDialogOpen(true);
                          }}
                        >
                          <RedactionHighlight value={row.postRedactionValue} />
                        </span>
                      </td>
                    </tr>
                  })}
                {(!details || details.length === 0) && (
                  <tr>
                    <td colSpan={8} className="py-12 text-center text-muted-foreground">
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
      content={preDialogContent}
    />

    {/* Post-Redaction Dialog */}
    <ContentDialog
      isOpen={postDialogOpen}
      onClose={() => setPostDialogOpen(false)}
      title="Post-Redaction (Redacted)"
      content={postDialogContent}
    />
  );
}