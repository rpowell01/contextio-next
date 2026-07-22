"use client";

import Link from "next/link";
import { useEffect } from "react";

export default function LoggedOutPage() {
  // Clear any remaining auth cookies on client side
  useEffect(() => {
    document.cookie = "contextio_session=; Path=/; Expires=Thu, 01 Jan 1970 00:00:00 GMT; Secure; SameSite=Lax";
    document.cookie = "contextio_login_redirect=; Path=/; Expires=Thu, 01 Jan 1970 00:00:00 GMT; Secure; SameSite=Lax";
  }, []);

  return (
    <div className="flex min-h-screen items-center justify-center bg-background px-4">
      <div className="text-center">
        <h1 className="mb-4 text-3xl font-bold">You have been logged out</h1>
        <p className="mb-6 text-muted-foreground">
          Your session has been ended successfully.
        </p>
        <Link
          href="/auth/login"
          className="rounded-md bg-primary px-4 py-2 text-sm font-medium text-primary-foreground hover:bg-primary/90 transition-colors"
        >
          Sign in again
        </Link>
      </div>
    </div>
  );
}