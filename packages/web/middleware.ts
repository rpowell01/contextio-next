import { NextResponse } from "next/server";
import type { NextRequest } from "next/server";

import { getSession } from "@/lib/auth/session";

// Public paths that don't require authentication
const PUBLIC_PATHS = [
  "/login",
  "/auth/callback",
  "/auth/logout",
  "/auth/logged-out",
  "/_next",
  "/favicon.ico",
  "/api/auth/providers",
  "/api/auth/logout",
  "/api/auth/callback",
];

// Also allow all public folder assets (images, manifests, etc.)
function isPublicAsset(pathname: string): boolean {
  return (
    pathname.startsWith("/contextio-next-brand.png") ||
    pathname.startsWith("/ContextIO-Next-") ||
    pathname === "/site.webmanifest"
  );
}

function isPublicPath(pathname: string): boolean {
  return PUBLIC_PATHS.some((publicPath) => pathname.startsWith(publicPath)) || isPublicAsset(pathname);
}

export default async function middleware(request: NextRequest) {
  const { pathname } = request.nextUrl;

  // Skip auth check for public paths
  if (isPublicPath(pathname)) {
    return NextResponse.next();
  }

  // Check for valid session
  const session = await getSession();

  if (!session) {
    // Redirect to login with return URL
    const loginUrl = new URL("/login", request.url);
    loginUrl.searchParams.set("redirect", pathname);
    return NextResponse.redirect(loginUrl);
  }

  // Issue CSRF token on safe methods
  if (request.method === "GET" || request.method === "HEAD") {
    try {
      const { issueToken } = await import("@/lib/csrf");
      const token = await issueToken();
      const response = NextResponse.next();
      response.headers.set("x-csrf-token", token);
      return response;
    } catch (err) {
      console.error("[middleware] CSRF token issuance failed:", err);
      return NextResponse.next();
    }
  }

  return NextResponse.next();
}

export const config = {
  matcher: [
    /*
     * Match all request paths except for the ones starting with:
     * - /api (API routes)
     * - /_next/static (static files)
     * - /_next/image (image optimization files)
     * - /favicon.ico (favicon file)
     * - /site.webmanifest (PWA manifest)
     * - /contextio-next-brand.png (brand logo)
     * - /ContextIO-Next- (favicon sizes)
     */
    "/((?!api|_next/static|_next/image|favicon\\.ico|site\\.webmanifest|contextio-next-brand\\.png|ContextIO-Next-).*)",
  ],
};