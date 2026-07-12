"use client";

import { MainLayout } from "@/components/main-layout";
import Link from "next/link";
import { useEffect, useState } from "react";

interface BuildInfo {
  version: string;
  buildTime: string;
  gitCommit: string;
}

interface RedactionsSummary {
  totalRedactions: number;
  byType: Record<string, number>;
}

export default function HomePage() {
  const [buildInfo, setBuildInfo] = useState<BuildInfo | null>(null);
  const [redactionsSummary, setRedactionsSummary] = useState<RedactionsSummary | null>(null);

  useEffect(() => {
    fetch("/api/version")
      .then((res) => res.json())
      .then(setBuildInfo)
      .catch(console.error);
  }, []);

useEffect(() => {
  fetch("/api/redactions?summary=true")
  .then((res) => res.json())
  .then((data: { summary: { totalRedactions: number; byType: Record<string, number> } }) => setRedactionsSummary(data.summary))
  .catch(console.error);
}, []);

  return (
    <MainLayout>
      <div className="space-y-6">
        <div className="flex items-center justify-between">
          <div>
            <h1 className="text-3xl font-bold tracking-tight">Dashboard</h1>
            <p className="text-muted-foreground">
              Monitor and inspect your LLM API traffic through ContextIO-Next proxy.
            </p>
          </div>
          {buildInfo && (
            <div className="text-right text-xs text-muted-foreground font-mono">
              <div>v{buildInfo.version}</div>
              <div>{buildInfo.gitCommit}</div>
              <div>{new Date(buildInfo.buildTime).toLocaleString()}</div>
            </div>
          )}
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
                <h3 className="font-semibold text-red-700">Total Redactions</h3>
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