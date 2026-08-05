"use client";

import { Suspense, useEffect } from "react";
import { useSearchParams } from "next/navigation";

function AuthCallbackPageContent() {
  const searchParams = useSearchParams();

  useEffect(() => {
    // Proxy the callback to the proxy's auth callback endpoint
    const queryString = searchParams.toString();
    const proxyCallbackUrl = `/auth/callback${queryString ? "?" + queryString : ""}`;
    window.location.href = proxyCallbackUrl;
  }, [searchParams]);

  return (
    <div className="flex min-h-screen items-center justify-center bg-background">
      <div className="space-y-4 text-center">
        <svg
          className="mx-auto h-12 w-12 text-primary"
          fill="none"
          stroke="currentColor"
          viewBox="0 0 24 24"
          aria-hidden="true"
        >
          <path
            strokeLinecap="round"
            strokeLinejoin="round"
            strokeWidth={2}
            d="M9 12l2 2 4-4m6 2a9 9 0 11-18 0 9 9 0 0118 0z"
          />
        </svg>
        <p className="text-muted-foreground">Completing login...</p>
        <div className="animate-spin rounded-full h-8 w-8 border-b-2 border-primary mx-auto" />
      </div>
    </div>
  );
}

export default function AuthCallbackPage() {
  return (
    <Suspense fallback={<div className="flex min-h-screen items-center justify-center bg-background"><div className="animate-spin rounded-full h-8 w-8 border-b-2 border-primary" /></div>}>
      <AuthCallbackPageContent />
    </Suspense>
  );
}