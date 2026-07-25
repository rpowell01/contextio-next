"use client";

import { MainLayout } from "@/components/main-layout";
import { apiClient } from "@/lib/api";
import { formatDateTime } from "@/lib/utils";
import type { SessionSummary } from "@/types/api";
import Link from "next/link";
import { useState, useEffect } from "react";
import { ProgressBar } from "@/components/ui/progress-bar";

export default function SessionsPage() {
  const [summaries, setSummaries] = useState<SessionSummary[]>([]);
  const [sessionsError, setSessionsError] = useState<string | null>(null);
  const [sessionsLoading, setSessionsLoading] = useState(true);
  const [page, setPage] = useState<number>(1);
  const [pageSize] = useState<number>(20);
  const [totalPages, setTotalPages] = useState<number>(1);
  const [totalItems, setTotalItems] = useState<number>(0);

  useEffect(() => {
    async function fetchSessions() {
      try {
        setSessionsLoading(true);
        const data = await apiClient.getGroupedSessions(page, pageSize);
        setSummaries(data.summaries);
        setTotalPages(data.pagination?.totalPages || 1);
        setTotalItems(data.pagination?.totalItems || 0);
        setSessionsError(null);
      } catch (e) {
        setSessionsError(e instanceof Error ? e.message : "Unknown error");
      } finally {
        setSessionsLoading(false);
      }
    }
    fetchSessions();
  }, [page, pageSize]);

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

  // Loading state - show progress bar
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
            <ProgressBar indeterminate className="mb-4" height={3} />
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