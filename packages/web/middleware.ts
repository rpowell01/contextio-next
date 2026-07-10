export const runtime = "experimental-edge";

import { NextResponse } from "next/server";

import { issueToken } from "@/lib/csrf";

export default async function middleware(request: Request) {
  // Only issue token on safe methods (GET, HEAD) so mutating requests
  // can use the token from the previous response
  if (request.method === "GET" || request.method === "HEAD") {
    const token = await issueToken();
    const response = NextResponse.next();
    response.headers.set("x-csrf-token", token);
    return response;
  }
  return NextResponse.next();
}

export const config = {
  matcher: ["/api/:path*"],
};