"use client";

import { MainLayout } from "@/components/main-layout";
import { ThemeSelector } from "@/components/theme-selector";
import Link from "next/link";
import Image from "next/image";
import { useEffect, useState, useCallback } from "react";
import { useTheme } from "@/components/theme-provider";
import { apiClient } from "@/lib/api";
import type { Settings } from "@/lib/settings";

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
    xmlns="[URL_4]
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

  // Persist theme changes to database (replicates settings page handleSubmit logic for theme)
  const persistTheme = useCallback(async (newTheme: Settings["theme"]) => {
    try {
      const response = await apiClient.getSettings();
      const currentSettings = response.settings as Settings;
      const mergedSettings: Settings = {
        ...currentSettings,
        theme: newTheme,
      };
      await apiClient.saveSettings(mergedSettings);
    } catch (error) {
      console.error("Failed to persist theme:", error);
    }
  }, []);

  // Wrap setTheme to also persist to database
  const handleThemeChange = useCallback(
    (newTheme: Settings["theme"]) => {
      setTheme(newTheme);
      persistTheme(newTheme);
    },
    [setTheme, persistTheme]
  );

  const fetchSummary = useCallback(async () => {
    console.log("[Dashboard] fetchSummary called, current refreshing:", refreshing);
    setRefreshing(true);
    console.log("[Dashboard] setRefreshing(true) called");
    // Safety timeout: force refreshing to false after 15 seconds no matter what
    const safetyTimeout = setTimeout(() => {
      console.warn("[Dashboard] Safety timeout triggered, forcing refreshing to false");
      setRefreshing(false);
    }, 15000);
    try {
      const fetchPromise = fetch("/api/redactions?summary=true");
      const timeoutPromise = new Promise<Response>((_, reject) =>
        setTimeout(() => reject(new Error("Fetch timeout")), 120000)
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
                <div className="font-medium text-foreground">v{buildInfo.version}</div>
                <div>{new Date(buildInfo.buildTime).toLocaleString()}</div>
              </div>
            )}
            <ThemeSelector value={theme} onChange={handleThemeChange} />
          </div>
        </div>

        <div className="grid gap-4 md:grid-cols-2 lg:grid-cols-4">
          <div className="rounded-lg border p-6 hover:bg-accent transition-colors flex items-center justify-center min-h-[120px]">
            <Image
              src="/contextio-next-brand.png"
              alt="ContextIO-Next brand logo"
              width={200}
              height={200}
              className="w-full h-full max-w-[200px] max-h-[200px] object-contain"
              sizes="(max-width: 768px) 50vw, 25vw"
            />
          </div>

          <Link
            href="/redactions"
            className="rounded-lg border p-6 hover:bg-accent transition-colors border-border bg-accent"
          >
            <div className="flex items-center gap-4">
              <div className="rounded-full bg-primary/10 p-3">
                <svg className="h-6 w-6 text-primary" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                  <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M12 9v2m0 4h.01m-6.938 4h13.856c1.54 0 2.502-1.667 1.732-3L13.732 4c-.77-1.333-2.694-1.333-3.464 0L3.34 16c-.77 1.333.192 3 1.732 3z" />
                </svg>
              </div>
              <div>
                <div className="flex items-center gap-2">
                  <h3 className="font-semibold text-foreground">Total Redactions</h3>
                  <button
                    onClick={(e) => {
                      e.preventDefault();
                      e.stopPropagation();
                      fetchSummary();
                    }}
                    disabled={refreshing}
                    className="p-1.5 rounded hover:bg-accent transition-colors disabled:opacity-50 disabled:cursor-not-allowed"
                    aria-label="Refresh redaction counts"
                    title="Refresh counts"
                  >
                    {refreshing ? (
                      <Spinner size={14} className="text-primary" />
                    ) : (
                      <svg className="w-4 h-4 text-muted-foreground" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                        <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M4 4v5h.582m15.356 2A8.001 8.001 0 004.582 9m0 0H9m11 11v-5h-.581m0 0a8.003 8.003 0 01-15.357-2m15.357 2H15" />
                      </svg>
                    )}
                  </button>
                </div>
                <p className="text-sm text-muted-foreground">
                  <span
                    title="Sum of maximum redactions per session. For each session, the highest count of each placeholder type across all its captures is used. This avoids double-counting when a session has multiple captures."
                  >
                    {redactionsSummary?.totalRedactions ?? 0}
                  </span> redactions found
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
          <h2 className="text-xl font-semibold mb-4">Quick Start (Docker)</h2>
          <div className="space-y-5 text-sm">
            <div>
              <h3 className="font-medium mb-2">1. Create environment file</h3>
              <p className="text-muted-foreground mb-2">Copy the example and fill in required secrets:</p>
              <pre className="rounded bg-muted p-3 text-xs overflow-x-auto">
{`cp .env.example .env
# edit .env with your secrets`}
              </pre>
            </div>

            <div>
              <h3 className="font-medium mb-2">2. Required Environment Variables</h3>
              <div className="space-y-2 text-xs">
                <div className="bg-muted p-3 rounded">
                  <code className="font-mono text-primary">CSRF_SECRET</code> <span className="text-muted-foreground ml-2">— Session cookie signing secret (min 32 chars). Generate: <code className="bg-background px-1 rounded">openssl rand -base64 32</code></span>
                </div>
                <div className="bg-muted p-3 rounded">
                  <code className="font-mono text-primary">CONTEXTIO_LOGGER_ENCRYPTION_KEY</code> <span className="text-muted-foreground ml-2">— Encryption key for capture data at rest (min 32 chars). Generate: <code className="bg-background px-1 rounded">openssl rand -base64 32</code></span>
                </div>
              </div>
            </div>

            <div>
              <h3 className="font-medium mb-2">3. Optional: OIDC Authentication</h3>
              <div className="space-y-1 text-xs bg-muted p-3 rounded">
                <div><code className="font-mono">OIDC_ENABLED=true</code> <span className="text-muted-foreground">— Enable OIDC</span></div>
                <div><code className="font-mono">OIDC_ISSUER=https://accounts.google.com</code> <span className="text-muted-foreground">— OIDC issuer URL</span></div>
                <div><code className="font-mono">OIDC_CLIENT_ID=...</code> <span className="text-muted-foreground">— OAuth2 client ID</span></div>
                <div><code className="font-mono">OIDC_CLIENT_SECRET=...</code> <span className="text-muted-foreground">— OAuth2 client secret</span></div>
                <div><code className="font-mono">OIDC_PUBLIC_URL=http://your-domain:4040</code> <span className="text-muted-foreground">— Public callback URL</span></div>
                <div><code className="font-mono">OIDC_SCOPE=openid profile email</code> <span className="text-muted-foreground">— Scopes (default shown)</span></div>
              </div>
              <p className="text-xs text-muted-foreground mt-1">Secrets (CLIENT_SECRET, etc.) MUST be in .env — not in web UI settings.</p>
            </div>

            <div>
              <h3 className="font-medium mb-2">4. Start the stack</h3>
              <pre className="rounded bg-muted p-3 text-xs overflow-x-auto">
{`docker compose up -d`}
              </pre>
              <p className="text-muted-foreground mt-1">Access web UI at <code className="font-mono bg-muted px-1 rounded">http://localhost:4040</code></p>
            </div>

            <div>
              <h3 className="font-medium mb-2">5. Configure via Web UI</h3>
              <p className="text-xs text-muted-foreground mb-2">Open <strong>Settings</strong> in the sidebar to configure:</p>
              <ul className="list-disc list-inside space-y-1 text-xs text-muted-foreground">
                <li>Redaction policy (preset or custom JSON)</li>
                <li>Rate limits per provider</li>
                <li>Retry behavior per provider</li>
                <li>Capture cleanup retention</li>
                <li>Provider API keys (encrypted at rest)</li>
              </ul>
            </div>

            <div>
              <h3 className="font-medium mb-2">6. Client Configuration</h3>
              <p className="text-xs text-muted-foreground mb-2">Point your AI tool to the proxy and include required headers:</p>
              <pre className="rounded bg-muted p-3 text-xs overflow-x-auto">
{`# Base URL
export ANTHROPIC_BASE_URL=http://localhost:4040
export OPENAI_BASE_URL=http://localhost:4040/v1

# Required: Provider selection header
# Values: anthropic, openai, google, openrouter, custom
# Can also be set per-request via x-contextio-provider header`}
              </pre>
              <p className="text-xs text-muted-foreground mt-1">
                <strong>Per-request headers (optional):</strong>
              </p>
              <pre className="rounded bg-muted p-3 text-xs overflow-x-auto">
{`x-contextio-provider: anthropic        # Override default provider
x-contextio-redact: true               # Enable/disable redaction per-request
x-contextio-log: true                  # Enable/disable logging per-request
x-api-key: sk-...                      # Provider API key (if not in settings)

# Override provider's default base URL (per-request)
x-anthropic-baseurl: https://api.anthropic.com
x-openai-baseurl: https://api.openai.com/v1
x-google-baseurl: https://generativelanguage.googleapis.com
x-openrouter-baseurl: https://openrouter.ai/api/v1
x-custom-baseurl: https://your-proxy.example.com`}
              </pre>
            </div>
          </div>
        </div>
      </div>
    </MainLayout>
  );
}