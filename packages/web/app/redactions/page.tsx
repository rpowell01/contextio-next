"use client";

import { MainLayout } from "@/components/main-layout";
import Link from "next/link";
import { useState, useEffect } from "react";
import { useRouter } from "next/navigation";

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
  const router = useRouter();

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

  const handleRowClick = (row: RedactionDetailRow) => {
    if (row.sessionId) {
      router.push(`/sessions/${row.sessionId}?captureId=${row.captureId}`);
    }
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
      </div>
    </MainLayout>
  );
}