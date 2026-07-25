"use client";

import Link from "next/link";
import { useEffect, useState, Suspense } from "react";
import { useSearchParams } from "next/navigation";

interface ProvidersResponse {
  providers: Array<{
    id: string;
    name: string;
    authUrl: string;
  }>;
}

function LoginPageContent() {
  const searchParams = useSearchParams();
  const redirect = searchParams.get("redirect") || "/";
  const [providers, setProviders] = useState<ProvidersResponse["providers"]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    async function fetchProviders() {
      try {
        const response = await fetch("/api/auth/providers");
        if (!response.ok) {
          throw new Error("Failed to fetch providers");
        }
        const data = await response.json();
        // Append redirect parameter to each provider's authUrl
        const providersWithRedirect = (data.providers || []).map((p: ProvidersResponse["providers"][0]) => ({
          ...p,
          authUrl: `${p.authUrl}&redirect=${encodeURIComponent(redirect)}`,
        }));
        setProviders(providersWithRedirect);
      } catch (err) {
        setError("Failed to load authentication options");
        console.error("Providers fetch failed:", err);
      } finally {
        setLoading(false);
      }
    }
    fetchProviders();
  }, [redirect]);

  if (loading) {
    return (
      <div className="flex min-h-[60vh] items-center justify-center">
        <div className="animate-spin rounded-full h-8 w-8 border-b-2 border-primary" />
      </div>
    );
  }

  return (
    <div className="flex min-h-[calc(100vh-4rem)] items-center justify-center px-4 py-12">
      <div className="w-full max-w-md space-y-8">
        <div className="text-center">
          <h1 className="text-3xl font-bold tracking-tight">Sign in to ContextIO-Next</h1>
          <p className="mt-2 text-muted-foreground">
            Access your API proxy dashboard and capture logs
          </p>
        </div>

        <div className="space-y-4">
          {error && (
            <div className="rounded-md bg-destructive/10 p-4 text-sm text-destructive">
              {error}
            </div>
          )}

          {providers.length === 0 ? (
            <div className="rounded-lg border p-6 text-center">
              <svg
                className="mx-auto h-12 w-12 text-muted-foreground"
                fill="none"
                stroke="currentColor"
                viewBox="0 0 24 24"
                aria-hidden="true"
              >
                <path
                  strokeLinecap="round"
                  strokeLinejoin="round"
                  strokeWidth={1.5}
                  d="M12 15v2m-6 4h12a2 2 0 002-2v-6a2 2 0 00-2-2H6a2 2 0 00-2 2v6a2 2 0 002 2zm10-10V7a4 4 0 00-8 0v4h8z"
                />
              </svg>
              <h3 className="mt-4 text-lg font-medium">Authentication not configured</h3>
              <p className="mt-2 text-sm text-muted-foreground">
                No OpenID Connect providers are configured. Please contact your
                administrator or set the OIDC environment variables to enable
                authentication.
              </p>
            </div>
          ) : (
            <div className="space-y-3">
              {providers.map((provider) => (
                <Link
                  key={provider.id}
                  href={provider.authUrl}
                  prefetch={false}
                  className="flex w-full items-center justify-center gap-3 rounded-lg border bg-background px-4 py-3 text-sm font-medium transition-colors hover:bg-accent hover:text-accent-foreground focus:outline-none focus:ring-2 focus:ring-ring focus:ring-offset-2"
                >
                  <span className="font-medium">{provider.name}</span>
                </Link>
              ))}
            </div>
          )}
        </div>

        <p className="text-center text-xs text-muted-foreground">
          By signing in, you agree to the terms of service and privacy policy of
          your identity provider.
        </p>
      </div>
    </div>
  );
}

export default function LoginPage() {
  return (
    <Suspense fallback={<div className="flex min-h-[60vh] items-center justify-center"><div className="animate-spin rounded-full h-8 w-8 border-b-2 border-primary" /></div>}>
      <LoginPageContent />
    </Suspense>
  );
}