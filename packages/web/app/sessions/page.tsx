"use client";

import { MainLayout } from "@/components/main-layout";
import { formatDateTime } from "@/lib/utils";
import type { SessionSummary } from "@/types/api";
import Link from "next/link";
import { useState, useEffect, useCallback } from "react";
import { ProgressBar } from "@/components/ui/progress-bar";
import { usePageLoad } from "@/components/page-load-context";

interface StreamingProgress {
  type: "progress" | "complete" | "error";
  current?: number;
  total?: number;
  message?: string;
  data?: {
    summaries: SessionSummary[];
    metrics: Record<string, any>;
    pagination?: {
      page: number;
      pageSize: number;
      totalPages: number;
      totalItems: number;
    };
  };
  error?: string;
}

export default function SessionsPage() {
  const [summaries, setSummaries] = useState<SessionSummary[]>([]);
  const [sessionsError, setSessionsError] = useState<string | null>(null);
  const [sessionsLoading, setSessionsLoading] = useState(true);
  const [page, setPage] = useState<number>(1);
  const [pageSize] = useState<number>(20);
  const [totalPages, setTotalPages] = useState<number>(1);
  const [totalItems, setTotalItems] = useState<number>(0);

  // Progress state for streaming
  const [progressCurrent, setProgressCurrent] = useState(0);
  const [progressTotal, setProgressTotal] = useState(0);
  const [progressMessage, setProgressMessage] = useState("");

  // Page load tracking for footer
  const { registerPageLoad, registerPageReady } = usePageLoad();

  const fetchSessions = useCallback(async () => {
    // Signal that page loading has started
    registerPageLoad();
    setSessionsLoading(true);
    setSessionsError(null);
    setProgressCurrent(0);
    setProgressTotal(0);
    setProgressMessage("Starting...");

    try {
      const response = await fetch(`/api/sessions/stream?page=${page}&pageSize=${pageSize}`);

      if (!response.ok) {
        throw new Error(`HTTP error! status: ${response.status}`);
      }

      const reader = response.body?.getReader();
      if (!reader) {
        throw new Error("No reader available");
      }

      const decoder = new TextDecoder();
      let buffer = "";

      while (true) {
        const { done, value } = await reader.read();
        if (done) break;

        buffer += decoder.decode(value, { stream: true });
        const lines = buffer.split("\n");
        buffer = lines.pop() || "";

        for (const line of lines) {
          if (line.startsWith("data: ")) {
            try {
              const update: StreamingProgress = JSON.parse(line.slice(6));

              if (update.type === "progress") {
                setProgressCurrent(update.current || 0);
                setProgressTotal(update.total || 0);
                setProgressMessage(update.message || "");
              } else if (update.type === "complete" && update.data) {
                setSummaries(update.data.summaries);
                setTotalPages(update.data.pagination?.totalPages || 1);
                setTotalItems(update.data.pagination?.totalItems || 0);
                setSessionsLoading(false);
                setProgressCurrent(update.total || 0);
                setProgressTotal(update.total || 0);
                setProgressMessage("Complete");
                registerPageReady();
              } else if (update.type === "error") {
                throw new Error(update.error || "Streaming error");
              }
            } catch (parseError) {
              console.error("Failed to parse SSE message:", parseError, line);
            }
          }
        }
      }
    } catch (e) {
      setSessionsError(e instanceof Error ? e.message : "Unknown error");
      setSessionsLoading(false);
      registerPageReady();
    }
  }, [page, pageSize, registerPageLoad, registerPageReady]);

  useEffect(() => {
    fetchSessions();
  }, [fetchSessions]);

  // Progress percentage
  const progressPercent = progressTotal > 0 ? Math.round((progressCurrent / progressTotal) * 100) : 0;

  // Error state - show early
  if (sessionsError) {
    return (
      <MainLayout>
        <div className="space-y-6">
          <div className="flex items-center justify-between">
            <div>
              <h1 className="text-3xl font-bold tracking-tight">Sessions</h1>
              <p className="text-muted-foreground">Captured API request/response pairs</p>
            </div>
          </div>
          <div className="space-y-4">
            <h2 className="text-xl font-semibold">All Sessions</h2>
            <div className="rounded-lg border border-destructive bg-destructive/10 p-4">
              <p className="text-destructive">Error: {sessionsError}</p>
            </div>
          </div>
        </div>
      </MainLayout>
    );
  }

  // Loading state - show progress bar with actual percentage
  if (sessionsLoading) {
    return (
      <MainLayout>
        <div className="space-y-6">
          <div className="flex items-center justify-between">
            <div>
              <h1 className="text-3xl font-bold tracking-tight">Sessions</h1>
              <p className="text-muted-foreground">Captured API request/response pairs</p>
            </div>
          </div>
          <div className="space-y-4">
            <h2 className="text-xl font-semibold">All Sessions</h2>
            <div className="space-y-2">
              <ProgressBar
                value={progressPercent}
                className="mb-2"
                height={4}
              />
              <div className="flex items-center justify-between text-sm text-muted-foreground">
                <span>{progressMessage}</span>
                {progressTotal > 0 && <span>{progressCurrent} / {progressTotal} files</span>}
              </div>
            </div>
          </div>
        </div>
      </MainLayout>
    );
  }

  // Empty state
  if (summaries.length === 0) {
    return (
      <MainLayout>
        <div className="space-y-6">
          <div className="flex items-center justify-between">
            <div>
              <h1 className="text-3xl font-bold tracking-tight">Sessions</h1>
              <p className="text-muted-foreground">Captured API request/response pairs</p>
            </div>
          </div>
          <div className="space-y-4">
            <h2 className="text-xl font-semibold">All Sessions</h2>
            <div className="flex flex-col items-center justify-center rounded-lg border border-dashed p-12">
              <svg className="h-12 w-12 text-muted-foreground mb-4" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M9 5H7a2 2 0 00-2 2v12a2 2 0 002 2h5.5a2 2 0 002-2V9a2 2 0 00-2-2z" />
              </svg>
              <h3 className="font-semibold mb-2">No sessions captured yet</h3>
              <p className="text-sm text-muted-foreground">Start the proxy and make some API requests to see sessions here.</p>
            </div>
          </div>
        </div>
      </MainLayout>
    );
  }

  // Success state with data
  return (
    <MainLayout>
      <div className="space-y-6">
        <div className="flex items-center justify-between">
          <div>
            <h1 className="text-3xl font-bold tracking-tight">Sessions</h1>
            <p className="text-muted-foreground">Captured API request/response pairs</p>
          </div>
        </div>

        {/* Sessions List Section */}
        <div className="space-y-4">
          <h2 className="text-xl font-semibold">All Sessions</h2>
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

          {/* Pagination Controls */}
          {totalPages > 1 && (
            <div className="rounded-lg border p-4">
              <div className="flex items-center justify-between">
                <div className="text-sm text-muted-foreground">
                  Page {page} of {totalPages} ({totalItems} total sessions)
                </div>
                <div className="flex items-center gap-2">
                  <button
                    onClick={() => setPage((p) => Math.max(1, p - 1))}
                    disabled={page <= 1}
                    className="rounded-md border px-3 py-1 text-sm hover:bg-accent disabled:opacity-50 disabled:cursor-not-allowed"
                  >
                    ← Previous
                  </button>
                  <button
                    onClick={() => setPage((p) => p + 1)}
                    disabled={page >= totalPages}
                    className="rounded-md border px-3 py-1 text-sm hover:bg-accent disabled:opacity-50 disabled:cursor-not-allowed"
                  >
                    Next →
                  </button>
                </div>
              </div>
            </div>
          )}
        </div>
      </div>
    </MainLayout>
  );
}