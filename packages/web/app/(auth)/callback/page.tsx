"use client";

import { useEffect, useState } from "react";
import Link from "next/link";
import { useSearchParams, useRouter } from "next/navigation";

/**
 * OIDC callback page - handles the redirect from the OIDC provider after authentication.
 * The actual token exchange and session creation is handled by the proxy's /auth/callback endpoint,
 * which sets the session cookie and redirects back here with a redirect parameter.
 */
export default function AuthCallbackPage() {
  const searchParams = useSearchParams();
  const router = useRouter();
  const [status, setStatus] = useState<"loading" | "success" | "error">("loading");
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    // The proxy's /auth/callback does the actual OIDC token exchange
    // and sets the session cookie. It then redirects back here.
    // We just need to wait a moment and then redirect to the intended page.
    const redirect = searchParams.get("redirect") || "/";
    const error = searchParams.get("error");

    if (error) {
      setStatus("error");
      setError(`Authentication failed: ${decodeURIComponent(searchParams.get("error_description") || error)}`);
    } else {
      setStatus("success");
      // Small delay to allow cookie to be set, then redirect
      setTimeout(() => {
        router.push(redirect);
        router.refresh();
      }, 500);
    }
  }, [searchParams, router]);

  if (status === "loading") {
    return (
      <div className="flex min-h-screen flex-col items-center justify-center bg-background px-4">
        <div className="text-center">
          <div className="animate-spin rounded-full h-12 w-12 border-4 border-primary border-t-transparent mx-auto" />
          <p className="mt-4 text-muted-foreground">Completing sign in...</p>
        </div>
      </div>
    );
  }

  if (status === "error") {
    return (
      <div className="flex min-h-screen flex-col items-center justify-center bg-background px-4">
        <div className="w-full max-w-md text-center">
          <div className="rounded-full bg-destructive/10 p-4 mx-auto w-16 h-16">
            <svg
              className="h-8 w-8 text-destructive mx-auto"
              fill="none"
              stroke="currentColor"
              viewBox="0 0 24 24"
              aria-hidden="true"
            >
              <path
                strokeLinecap="round"
                strokeLinejoin="round"
                strokeWidth={2}
                d="M12 9v2m0 4h.01m-6.938 4h13.856c1.54 0 2.502-1.667 1.732-3L13.732 4c-.77-1.333-2.694-1.333-3.464 0L3.34 16c-.77 1.333.192 3 1.732 3z"
              />
            </svg>
          </div>
          <h1 className="mt-4 text-2xl font-bold">Authentication Failed</h1>
          <p className="mt-2 text-muted-foreground">{error}</p>
          <div className="mt-6 flex gap-4 justify-center">
            <Link
              href="/auth/login"
              className="rounded-md bg-primary px-4 py-2.5 text-sm font-medium text-primary-foreground hover:bg-primary/90 transition-colors"
            >
              Try Again
            </Link>
            <Link
              href="/"
              className="rounded-md border bg-background px-4 py-2.5 text-sm font-medium hover:bg-accent transition-colors"
            >
              Go Home
            </Link>
          </div>
        </div>
      </div>
    );
  }

  // Success - redirecting
  return (
    <div className="flex min-h-screen flex-col items-center justify-center bg-background px-4">
      <div className="text-center">
        <div className="rounded-full bg-green-100 p-4 mx-auto w-16 h-16">
          <svg
            className="h-8 w-8 text-green-600 mx-auto"
            fill="none"
            stroke="currentColor"
            viewBox="0 0 24 24"
            aria-hidden="true"
          >
            <path
              strokeLinecap="round"
              strokeLinejoin="round"
              strokeWidth={2}
              d="M5 13l4 4L19 7"
            />
          </svg>
        </div>
        <h1 className="mt-4 text-2xl font-bold">Signed In</h1>
        <p className="mt-2 text-muted-foreground">Redirecting to dashboard...</p>
      </div>
    </div>
  );
}