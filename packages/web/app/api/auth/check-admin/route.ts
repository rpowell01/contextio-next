import { NextResponse } from "next/server";
import { cookies } from "next/headers";

/**
 * Check if the current authenticated user has admin privileges.
 * This mirrors the proxy's admin check logic using ADMIN_EMAILS environment variable.
 */
export async function GET(): Promise<NextResponse> {
  try {
    // Get the session cookie
    const cookieStore = await cookies();
    const sessionCookie = cookieStore.get("session");

    if (!sessionCookie?.value) {
      return NextResponse.json(
        { isAdmin: false, authenticated: false, error: "No session found" },
        { status: 401 }
      );
    }

    // Decode the session cookie to get user info
    // The session cookie is a JWT or similar format
    try {
      const sessionData = JSON.parse(
        Buffer.from(sessionCookie.value.split(".")[1], "base64").toString()
      );

      const userEmail = sessionData.email?.toLowerCase();

      if (!userEmail) {
        return NextResponse.json(
          { isAdmin: false, authenticated: true, error: "No email in session" },
          { status: 200 }
        );
      }

      // Check against ADMIN_EMAILS environment variable (same logic as proxy)
      const adminEmails =
        process.env.ADMIN_EMAILS?.split(",").map((e) => e.trim().toLowerCase()) ?? [];

      if (adminEmails.length === 0) {
        return NextResponse.json(
          { isAdmin: false, authenticated: true, error: "ADMIN_EMAILS not configured" },
          { status: 200 }
        );
      }

      const isAdmin = adminEmails.includes(userEmail);

      return NextResponse.json(
        { isAdmin, authenticated: true, email: userEmail },
        { status: 200 }
      );
    } catch (parseError) {
      console.error("Failed to parse session cookie:", parseError);
      return NextResponse.json(
        { isAdmin: false, authenticated: false, error: "Invalid session format" },
        { status: 401 }
      );
    }
  } catch (error) {
    console.error("Error checking admin status:", error);
    return NextResponse.json(
      { isAdmin: false, authenticated: false, error: "Internal server error" },
      { status: 500 }
    );
  }
}