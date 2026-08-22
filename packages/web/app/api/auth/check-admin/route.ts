import { NextResponse } from "next/server";
import { cookies } from "next/headers";

/**
 * Check if the current authenticated user has admin privileges.
 * Uses the proxy's /auth/session endpoint to validate session and get user info.
 */
export async function GET(): Promise<NextResponse> {
  try {
    // Forward cookies to the proxy's /auth/session endpoint
    const cookieStore = await cookies();
    const cookieHeader = cookieStore.getAll()
      .map((c) => `${c.name}=${c.value}`)
      .join("; ");

    const response = await fetch("/auth/session", {
      headers: {
        Cookie: cookieHeader,
      },
    });

    if (!response.ok) {
      return NextResponse.json(
        { isAdmin: false, authenticated: false, error: "No valid session" },
        { status: 401 }
      );
    }

    const data = await response.json();

    if (!data.authenticated || !data.user?.email) {
      return NextResponse.json(
        { isAdmin: false, authenticated: data.authenticated || false, error: "No user email in session" },
        { status: data.authenticated ? 200 : 401 }
      );
    }

    // Check against ADMIN_EMAILS environment variable (same logic as proxy)
    const adminEmails =
      process.env.ADMIN_EMAILS?.split(",").map((e) => e.trim().toLowerCase()) ?? [];

    if (adminEmails.length === 0) {
      return NextResponse.json(
        { isAdmin: false, authenticated: true, error: "ADMIN_EMAILS not configured on server" },
        { status: 200 }
      );
    }

    const userEmail = data.user.email.toLowerCase();
    const isAdmin = adminEmails.includes(userEmail);

    return NextResponse.json(
      { isAdmin, authenticated: true, email: userEmail },
      { status: 200 }
    );
  } catch (error) {
    console.error("Error checking admin status:", error);
    return NextResponse.json(
      { isAdmin: false, authenticated: false, error: "Internal server error" },
      { status: 500 }
    );
  }
}