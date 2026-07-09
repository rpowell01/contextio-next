"use client";

import { MainLayout } from "@/components/main-layout";
import Link from "next/link";
import { formatDateTime } from "@/lib/utils";
import { useState, useEffect } from "react";
import { apiClient } from "@/lib/api";
import type { CaptureDetail } from "@/types/api";

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

interface RedactionsData {
summary: RedactionSummary;
details: RedactionDetailRow[];
}

export default function RedactionsPage() {
  const [data, setData] = useState<RedactionsData | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [selectedRow, setSelectedRow] = useState<RedactionDetailRow | null>(null);
  const [captureDetail, setCaptureDetail] = useState<CaptureDetail | null>(null);
  const [captureLoading, setCaptureLoading] = useState(false);

  useEffect(() => {
    async function fetchRedactions() {
      try {
        setLoading(true);
        const response = await fetch("/api/redactions");
        if (!response.ok) throw new Error("Failed to fetch redactions");
        const json = await response.json();
        setData(json);
        setError(null);
      } catch (e) {
        setError(e instanceof Error ? e.message : "Unknown error");
      } finally {
        setLoading(false);
      }
    }
    fetchRedactions();
  }, []);

  const handleRowClick = async (row: RedactionDetailRow) => {
    setSelectedRow(row);
    setCaptureLoading(true);
    try {
      const detail = await apiClient.getCapture(row.captureId);
      setCaptureDetail(detail);
    } catch (e) {
      console.error("Error fetching capture detail:", e);
      setCaptureDetail(null);
    } finally {
      setCaptureLoading(false);
    }
  };

  const closeModal = () => {
    setSelectedRow(null);
    setCaptureDetail(null);
  };

  if (loading) {
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
            <div className="text-3xl font-bold text-red-600">{data?.summary.totalRedactions ?? 0}</div>
          </div>
          {Object.entries(data?.summary.byType ?? {}).slice(0, 3).map(([type, count]) => (
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
            {Object.entries(data?.summary.byType ?? {}).map(([type, count]) => (
              <div key={type} className="rounded-lg border p-3 hover:bg-accent transition-colors">
                <div className="text-sm text-muted-foreground capitalize">{type.replace(/_/g, " ")}</div>
                <div className="text-2xl font-bold">{count}</div>
              </div>
            ))}
            {Object.keys(data?.summary.byType ?? {}).length === 0 && (
              <div className="col-span-full text-center text-muted-foreground py-8">
                No redactions found
              </div>
            )}
          </div>
        </div>

        {/* Details Table */}
        <div className="rounded-lg border">
          <div className="border-b p-4">
            <h2 className="text-xl font-semibold">Redaction Details</h2>
            <p className="text-sm text-muted-foreground">
              {data?.details.length ?? 0} total redaction entries
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
                {data?.details.map((row, index) => (
                  <tr
                    key={`${row.captureId}-${index}`}
                    className="border-b hover:bg-accent/50 cursor-pointer transition-colors"
                    onClick={() => handleRowClick(row)}
                  >
                    <td className="py-3 px-4 font-medium capitalize">{row.redactionType.replace(/_/g, " ")}</td>
                    <td className="py-3 px-4 text-muted-foreground">{row.requestSource ?? "—"}</td>
                    <td className="py-3 px-4">{row.requestProvider}</td>
                    <td className="py-3 px-4 max-w-xs truncate">{row.requestTarget}</td>
                    <td className="py-3 px-4 font-mono text-xs">{row.sessionId ?? "—"}</td>
                    <td className="py-3 px-4 font-mono text-xs">{row.captureId}</td>
                    <td className="py-3 px-4 font-mono text-xs max-w-xs truncate" title={row.preRedactionValue}>
                      {row.preRedactionValue}
                    </td>
                    <td className="py-3 px-4 font-mono text-xs max-w-xs truncate" title={row.postRedactionValue}>
                      {row.postRedactionValue}
                    </td>
                  </tr>
                ))}
                {(!data?.details || data.details.length === 0) && (
                  <tr>
                    <td colSpan={8} className="py-12 text-center text-muted-foreground">
                      No redaction details found
                    </td>
                  </tr>
                )}
              </tbody>
            </table>
          </div>
        </div>

        {/* Modal for Capture Details */}
        {selectedRow && (
          <div
            className="fixed inset-0 z-50 flex items-center justify-center bg-black/50"
            onClick={closeModal}
          >
            <div
              className="bg-background rounded-lg shadow-xl max-w-4xl w-full mx-4 max-h-[90vh] overflow-hidden"
              onClick={(e) => e.stopPropagation()}
            >
              <div className="flex items-center justify-between border-b p-4">
                <h2 className="text-lg font-semibold">Capture Details</h2>
                <button
                  onClick={closeModal}
                  className="text-muted-foreground hover:text-foreground p-1"
                >
                  <svg className="h-6 w-6" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                    <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M6 18L18 6M6 6l12 12" />
                  </svg>
                </button>
              </div>

              <div className="p-4 overflow-auto max-h-[70vh]">
                {captureLoading ? (
                  <div className="flex items-center justify-center py-12">
                    <svg className="h-8 w-8 text-primary animate-spin" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                      <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M4 4v5h.582m15.356 2A8.001 8.001 0 004.582 9m0 0H9m11 11v-5h-.581m0 0a8.003 8.003 0 01-15.357-2m15.357 2H15" />
                    </svg>
                  </div>
                ) : captureDetail ? (
                  <div className="space-y-6">
                    <div className="grid gap-4 md:grid-cols-2">
                      <div className="rounded-lg border p-4">
                        <h3 className="font-semibold mb-3">Request Details</h3>
                        <div className="space-y-2 text-sm">
                          <div>
                            <span className="text-muted-foreground">Provider:</span>{" "}
                            {captureDetail.provider}
                          </div>
                          <div>
                            <span className="text-muted-foreground">Method:</span>{" "}
                            {captureDetail.method}
                          </div>
                          <div>
                            <span className="text-muted-foreground">Target:</span>{" "}
                            {captureDetail.targetUrl}
                          </div>
                          <div>
                            <span className="text-muted-foreground">Source:</span>{" "}
                            {captureDetail.source ?? "—"}
                          </div>
                          <div>
                            <span className="text-muted-foreground">Request Size:</span>{" "}
                            {captureDetail.requestBytes.toLocaleString()} bytes
                          </div>
                          <div>
                            <span className="text-muted-foreground">Timestamp:</span>{" "}
                            {formatDateTime(captureDetail.timestamp)}
                          </div>
                        </div>
                      </div>

                      <div className="rounded-lg border p-4">
                        <h3 className="font-semibold mb-3">Response Details</h3>
                        <div className="space-y-2 text-sm">
                          <div>
                            <span className="text-muted-foreground">Status:</span>{" "}
                            {captureDetail.responseStatus}
                          </div>
                          <div>
                            <span className="text-muted-foreground">Streaming:</span>{" "}
                            {captureDetail.responseIsStreaming ? "Yes" : "No"}
                          </div>
                          <div>
                            <span className="text-muted-foreground">Response Size:</span>{" "}
                            {captureDetail.responseBytes.toLocaleString()} bytes
                          </div>
                          <div>
                            <span className="text-muted-foreground">Total Time:</span>{" "}
                            {captureDetail.timings.total_ms.toLocaleString()} ms
                          </div>
                        </div>
                      </div>
                    </div>

                    <div className="rounded-lg border p-4">
                      <h3 className="font-semibold mb-3">Request Body</h3>
                      <pre className="rounded bg-muted p-4 text-xs overflow-x-auto max-h-96 whitespace-pre-wrap break-words">
                        {JSON.stringify(captureDetail.requestBody, null, 2)}
                      </pre>
                    </div>

                    <div className="rounded-lg border p-4">
                      <h3 className="font-semibold mb-3">Response Body</h3>
                      <pre className="rounded bg-muted p-4 text-xs overflow-x-auto max-h-96 whitespace-pre-wrap break-words">
                        {captureDetail.responseBody ? JSON.stringify(JSON.parse(captureDetail.responseBody), null, 2) : "No response body"}
                      </pre>
                    </div>
                  </div>
                ) : (
                  <div className="text-center text-muted-foreground py-8">
                    Failed to load capture details
                  </div>
                )}
              </div>
            </div>
          </div>
        )}
      </div>
    </MainLayout>
  );
}