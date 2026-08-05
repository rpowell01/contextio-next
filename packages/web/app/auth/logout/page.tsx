"use client";

import { Suspense, useEffect } from "react";
import { useSearchParams } from "next/navigation";

function AuthLogoutPageContent() {
  const searchParams = useSearchParams();

  useEffect(() => {
    // Proxy to the proxy's auth logout endpoint
    const redirectUrl = searchParams.get("redirect") || "/";
    const proxyLogoutUrl = `/auth/logout?redirect=${encodeURIComponent(redirectUrl)}`;
    window.location.href = proxyLogoutUrl;
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
            d="M17 16l4-4m0 0l-4-4m4 4H7m6 4v1a3 3 0 01-3 3H6a3 3 0 01-3-3V7a3 3 0 013-3h4a3 3 0 013 3v1"
          />
        </svg>
        <p className="text-muted-foreground">Logging out...</p>
        <div className="animate-spin rounded-full h-8 w-8 border-b-2 border-primary mx-auto" />
      </div>
    </div>
  );
}

export default function AuthLogoutPage() {
  return (
    <Suspense fallback={<div className="flex min-h-screen items-center justify-center bg-background"><div className="animate-spin rounded-full h-8 w-8 border-b-2 border-primary" /></div>}>
      <AuthLogoutPageContent />
    </Suspense>
  );
}