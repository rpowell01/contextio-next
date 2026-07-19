"use client";

import { MainLayout } from "@/components/main-layout";
import { ThemeSelector } from "@/components/theme-selector";
import Link from "next/link";
import { useEffect, useState, useCallback } from "react";
import { useTheme } from "@/components/theme-provider";

interface BuildInfo {
  version: string;
  buildTime: string;
  gitCommit: string;
}

interface RedactionsSummary {
  totalRedactions: number;
  byType: Record<string, number>;
}

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

export default function HomePage() {
  const [buildInfo, setBuildInfo] = useState<BuildInfo | null>(null);
  const [redactionsSummary, setRedactionsSummary] = useState<RedactionsSummary | null>(null);
  const [refreshing, setRefreshing] = useState(false);
  const { theme, setTheme } = useTheme();

  const fetchSummary = useCallback(async () => {
    console.log("[Dashboard] fetchSummary called, current refreshing:", refreshing);
    setRefreshing(true);
    console.log("[Dashboard] setRefreshing(true) called");
    // Safety timeout: force refreshing to false after 10 seconds no matter what
    const safetyTimeout = setTimeout(() => {
      console.warn("[Dashboard] Safety timeout triggered, forcing refreshing to false");
      setRefreshing(false);
    }, 10000);
    try {
      const fetchPromise = fetch("/api/redactions?summary=true");
      const timeoutPromise = new Promise<Response>((_, reject) =>
        setTimeout(() => reject(new Error("Fetch timeout")), 5000)
      );
      const res = await Promise.race([fetchPromise, timeoutPromise]);
      console.log("[Dashboard] Fetch completed, status:", res.status);
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const data = await res.json();
      console.log("[Dashboard] Data received:", data);
      setRedactionsSummary(data.summary);
    } catch (e) {
      console.error("Summary fetch failed:", e);
    } finally {
      console.log("[Dashboard] Finally block - clearing timeout and setting refreshing false");
      clearTimeout(safetyTimeout);
      setRefreshing(false);
    }
  }, []);

  useEffect(() => {
    fetch("/api/version")
      .then((res) => res.json())
      .then(setBuildInfo)
      .catch(console.error);
  }, []);

  useEffect(() => {
    fetchSummary();
  }, [fetchSummary]);

  return (
    <MainLayout>
      <div className="space-y-6">
        <div className="flex flex-col md:flex-row md:items-center md:justify-between gap-4">
          <div>
            <h1 className="text-3xl font-bold tracking-tight">Dashboard</h1>
            <p className="text-muted-foreground">
              Monitor and inspect your LLM API traffic through ContextIO-Next proxy.
            </p>
          </div>
          <div className="flex items-center gap-4">
            {buildInfo && (
              <div className="text-right text-xs text-muted-foreground font-mono hidden sm:block">
                <div>v{buildInfo.version}</div>
                <div>{buildInfo.gitCommit}</div>
                <div>{new Date(buildInfo.buildTime).toLocaleString()}</div>
              </div>
            )}
            <ThemeSelector value={theme} onChange={setTheme} />
          </div>
        </div>

        <div className="grid gap-4 md:grid-cols-2 lg:grid-cols-4">
          <Link
            href="/redactions"
            className="rounded-lg border p-6 hover:bg-accent transition-colors border-red-200 bg-red-50"
          >
            <div className="flex items-center gap-4">
              <div className="rounded-full bg-red-100 p-3">
                <svg className="h-6 w-6 text-red-600" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                  <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M12 9v2m0 4h.01m-6.938 4h13.856c1.54 0 2.502-1.667 1.732-3L13.732 4c-.77-1.333-2.694-1.333-3.464 0L3.34 16c-.77 1.333.192 3 1.732 3z" />
                </svg>
              </div>
              <div>
                <div className="flex items-center gap-2">
<h3 className="font-semibold text-red-700">Total Redactions</h3>
                    {refreshing && (
                      <button
                        onClick={fetchSummary}
                        disabled={refreshing}
                        className="p-1 rounded hover:bg-accent transition-colors disabled:opacity-50 disabled:cursor-not-allowed"
                        aria-label="Refresh redaction counts"
                        title="Refresh counts"
                      >
                        <Spinner size={14} className="text-red-600" />
                      </button>
                    )}
                </div>
                <p className="text-sm text-muted-foreground">
                  {redactionsSummary?.totalRedactions ?? 0} redactions found
                </p>
              </div>
            </div>
          </Link>

          <Link
            href="/sessions"
            className="rounded-lg border p-6 hover:bg-accent transition-colors"
          >
            <div className="flex items-center gap-4">
              <div className="rounded-full bg-primary/10 p-3">
                <svg className="h-6 w-6 text-primary" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                  <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M9 5H7a2 2 0 00-2 2v12a2 2 0 002 2h5.5a2 2 0 002-2V9a2 2 0 00-2-2z" />
                </svg>
              </div>
              <div>
                <h3 className="font-semibold">View Sessions</h3>
                <p className="text-sm text-muted-foreground">
                  Inspect captured API requests and responses
                </p>
              </div>
            </div>
          </Link>

          <Link
            href="/settings"
            className="rounded-lg border p-6 hover:bg-accent transition-colors"
          >
            <div className="flex items-center gap-4">
              <div className="rounded-full bg-primary/10 p-3">
                <svg className="h-6 w-6 text-primary" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                  <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M10.325 4.317c.426-1.755 2.872-1.755 3.246 0l.527 2.147a1 1 0 00.956.69h2.178a1.978 1.978 0 001.928-1.427l.825-2.906a1.978 1.978 0 00-1.77-2.465h-2.178a1 1 0 00-.956.69l-.527 2.147zM15 13.5H9a1 1 0 000 2h6a1 1 0 000-2z" />
                </svg>
              </div>
              <div>
                <h3 className="font-semibold">Settings</h3>
                <p className="text-sm text-muted-foreground">
                  Configure proxy and redaction settings
                </p>
              </div>
            </div>
          </Link>
        </div>

        <div className="rounded-lg border p-6">
          <h2 className="text-xl font-semibold mb-4">Quick Start</h2>
          <div className="space-y-3 text-sm">
            <p>
              <strong>1.</strong> Start the ContextIO-Next proxy:
            </p>
            <pre className="rounded bg-muted p-3 text-xs">
              ctxio proxy --log-dir ./captures
            </pre>
            <p>
              <strong>2.</strong> Configure your AI tool to use the proxy:
            </p>
            <pre className="rounded bg-muted p-3 text-xs">
              export ANTHROPIC_BASE_URL=http://localhost:4040
            </pre>
            <p>
              <strong>3.</strong> View captured sessions in this interface.
            </p>
          </div>
        </div>
      </div>
    </MainLayout>
  );
}