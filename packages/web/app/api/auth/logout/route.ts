import { NextRequest, NextResponse } from "next/server";
import { cookies } from "next/headers";

/**
 * POST /api/auth/logout
 *
 * Invalidates the session by clearing the session cookie.
 * Also redirects to the OIDC provider's logout endpoint if configured.
 */
export async function POST(request: NextRequest) {
  try {
    // Clear the local session cookie
    const cookieStore = await cookies();
    cookieStore.delete("contextio_session");

    // Also clear the redirect cookie if present
    cookieStore.delete("contextio_login_redirect");

    // Optionally redirect to OIDC provider's end_session_endpoint for full logout
    // This would require the provider metadata, but the proxy handles this on /auth/logout
    // For now, we just clear the client-side session

    return NextResponse.json({ success: true });
  } catch (error) {
    console.error("Logout error:", error);
    return NextResponse.json(
      { error: "Internal server error" },
      { status: 500 }
    );
  }
}