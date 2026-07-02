"use client";

import { MainLayout } from "@/components/main-layout";
import { apiClient } from "@/lib/api";
import { formatDateTime } from "@/lib/utils";
import type { CaptureDetail } from "@/types/api";
import Link from "next/link";
import { useState, useEffect } from "react";

function renderJson(data: unknown): string {
  if (typeof data === "string") {
    try {
      return JSON.stringify(JSON.parse(data), null, 2);
    } catch {
      return data;
    }
  }
  if (data === null || data === undefined) {
    return "{}";
  }
  return JSON.stringify(data, null, 2);
}

export default function CaptureDetailPage({
  params,
}: {
  params: Promise<{ id: string }>;
}) {
  const [capture, setCapture] = useState<CaptureDetail | null>(null);
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
    
    const fetchCapture = async () => {
      setLoading(true);
      setError(null);
      try {
        const data = await apiClient.getCapture(id);
        setCapture(data);
      } catch (e) {
        setError(e instanceof Error ? e.message : "Unknown error");
      } finally {
        setLoading(false);
      }
    };

    fetchCapture();
  }, [id]);

  return (
    <MainLayout>
      <div className="space-y-6">
        <div>
          <Link
            href="/captures"
            className="text-sm text-muted-foreground hover:text-foreground"
          >
            ← Back to captures
          </Link>
          <h1 className="text-3xl font-bold tracking-tight mt-2">
            Capture: #{id}
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
          </div>
        )}

        {!loading && !error && capture && (
          <>
            <div className="grid gap-6 md:grid-cols-2">
              <div className="rounded-lg border p-4">
                <h3 className="font-semibold mb-3">Request Details</h3>
                <div className="space-y-2 text-sm">
                  <div>
                    <span className="text-muted-foreground">Provider:</span>{" "}
                    {capture.provider}
                  </div>
                  <div>
                    <span className="text-muted-foreground">Method:</span>{" "}
                    {capture.method}
                  </div>
                  <div>
                    <span className="text-muted-foreground">Target:</span>{" "}
                    {capture.targetUrl}
                  </div>
                  <div>
                    <span className="text-muted-foreground">Request Size:</span>{" "}
                    {capture.requestBytes.toLocaleString()} bytes
                  </div>
                  <div>
                    <span className="text-muted-foreground">Timestamp:</span>{" "}
                    {formatDateTime(capture.timestamp)}
                  </div>
                </div>
              </div>

              <div className="rounded-lg border p-4">
                <h3 className="font-semibold mb-3">Response Details</h3>
                <div className="space-y-2 text-sm">
                  <div>
                    <span className="text-muted-foreground">Status:</span>{" "}
                    {capture.responseStatus}
                  </div>
                  <div>
                    <span className="text-muted-foreground">Streaming:</span>{" "}
                    {capture.responseIsStreaming ? "Yes" : "No"}
                  </div>
                  <div>
                    <span className="text-muted-foreground">Response Size:</span>{" "}
                    {capture.responseBytes.toLocaleString()} bytes
                  </div>
                  <div>
                    <span className="text-muted-foreground">Total Time:</span>{" "}
                    {capture.timings.total_ms.toLocaleString()} ms
                  </div>
                </div>
              </div>
            </div>

            <div className="rounded-lg border p-4">
              <h3 className="font-semibold mb-3">Request Body</h3>
              <pre className="rounded bg-muted p-4 text-xs overflow-x-auto max-h-96 whitespace-pre-wrap break-words">
                {renderJson(capture.requestBody)}
              </pre>
            </div>

            <div className="rounded-lg border p-4">
              <h3 className="font-semibold mb-3">Response Body</h3>
              <pre className="rounded bg-muted p-4 text-xs overflow-x-auto max-h-96 whitespace-pre-wrap break-words">
                {renderJson(capture.responseBody)}
              </pre>
            </div>
          </>
        )}

        {!loading && !error && !capture && (
          <div className="flex flex-col items-center justify-center rounded-lg border border-dashed p-12">
            <svg className="h-12 w-12 text-muted-foreground mb-4" fill="none" stroke="currentColor" viewBox="0 0 24 24">
              <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M9 5H7a2 2 0 00-2 2v12a2 2 0 002 2h5.5a2 2 0 002-2V9a2 2 0 00-2-2z" />
            </svg>
            <h3 className="font-semibold mb-2">Capture not found</h3>
            <p className="text-sm text-muted-foreground">
              The requested capture could not be found.
            </p>
          </div>
        )}
      </div>
    </MainLayout>
  );
}