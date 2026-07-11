export const runtime = "nodejs";

import { NextResponse } from "next/server";

import { issueToken } from "@/lib/csrf";

export default async function middleware(request: Request) {
  // Only issue token on safe methods (GET, HEAD) so mutating requests
  // can use the token from the previous response
  if (request.method === "GET" || request.method === "HEAD") {
    try {
      const token = await issueToken();
      const response = NextResponse.next();
      response.headers.set("x-csrf-token", token);
      return response;
    } catch (err) {
      // Do not crash the request if CSRF token issuance fails;
      // the downstream API will reject mutating requests without a token.
      console.error("[middleware] CSRF token issuance failed:", err);
      return NextResponse.next();
    }
  }
  return NextResponse.next();
}

export const config = {
  matcher: ["/api/:path*"],
};