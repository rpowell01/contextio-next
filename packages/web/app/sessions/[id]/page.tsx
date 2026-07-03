"use client";

import { MainLayout } from "@/components/main-layout";
import { formatDateTime, safeJsonStringify } from "@/lib/utils";
import type { SessionDetail } from "@/types/api";
import Link from "next/link";
import { apiClient } from "@/lib/api";
import { useState, useEffect } from "react";

export default function SessionDetailPage({
  params,
}: {
  params: Promise<{ id: string }>;
}) {
  const [session, setSession] = useState<SessionDetail | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [id, setId] = useState<string | null>(null);

  useEffect(() => {
    const unwrapParams = async () => {
      const resolved = await params;
      setId(resolved.id);
    };
    unwrapParams();
  }, [params]);

  useEffect(() => {
    if (!id) return;
    
    const fetchSession = async () => {
      setLoading(true);
      setError(null);
      try {
        const data = await apiClient.getSession(id);
        setSession(data);
      } catch (e) {
        setError(e instanceof Error ? e.message : "Unknown error");
      } finally {
        setLoading(false);
      }
    };

    fetchSession();
  }, [id]);

  return (
    <MainLayout>
      <div className="space-y-6">
        <div>
          <Link
            href="/sessions"
            className="text-sm text-muted-foreground hover:text-foreground"
          >
            ← Back to sessions
          </Link>
          <h1 className="text-3xl font-bold tracking-tight mt-2">
            Session: {session?.sessionId || id || "Unknown"}
          </h1>
        </div>

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

        {error && (
          <div className="rounded-lg border border-destructive bg-destructive/10 p-4">
            <p className="text-destructive">Error: {error}</p>
            <p className="text-sm text-muted-foreground mt-2">
              Please try again or contact support if the problem persists.
            </p>
          </div>
        )}

{!error && session && (
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

  {/* Capture Breakdown */}
  {session.captures && session.captures.length > 0 && (
    <div className="rounded-lg border p-4">
      <h3 className="font-semibold mb-3">Capture Breakdown</h3>
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
            </tr>
          </thead>
          <tbody>
            {session.captures.map((capture) => (
              <tr key={capture.id} className="border-b">
                <td className="py-2 font-mono text-xs">{capture.id}</td>
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
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </div>
  )}

  {/* Metrics Section */}
  {session.metrics && (
    <div className="rounded-lg border p-4">
      <h3 className="font-semibold mb-3">Session Metrics</h3>
      <div className="grid gap-4 md:grid-cols-2 lg:grid-cols-3">
<div>
  <span className="text-muted-foreground">Total Context Values:</span>{" "}
  <span className="font-medium">
    {session.metrics.totalContextValues}
  </span>
</div>
<div>
  <span className="text-muted-foreground">Total Input Tokens:</span>{" "}
  <span className="font-medium">
    {session.metrics.totalInputTokens ?? 0}
  </span>
</div>
<div>
  <span className="text-muted-foreground">Total Output Tokens:</span>{" "}
  <span className="font-medium">
    {session.metrics.totalOutputTokens ?? 0}
  </span>
</div>
<div>
  <span className="text-muted-foreground">Tokens / Second:</span>{" "}
  <span className="font-medium">
    {(session.metrics.tokensPerSecond ?? 0).toFixed(2)}
  </span>
</div>
<div>
  <span className="text-muted-foreground">Total Redactions:</span>{" "}
  <span className="font-medium">
    {session.metrics.redactionStats?.totalRedactions ?? 0}
  </span>
</div>
      </div>
    </div>
  )}

{/* Redaction Statistics */}
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

  {/* Context Values */}
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
                  {typeof value === "string" ? value : safeJsonStringify(value)}
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
            <svg className="h-12 w-12 text-muted-foreground mb-4" fill="none" stroke="currentColor" viewBox="0 0 24 24">
              <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M9 5H7a2 2 0 00-2 2v12a2 2 0 002 2h5.5a2 2 0 002-2V9a2 2 0 00-2-2z" />
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