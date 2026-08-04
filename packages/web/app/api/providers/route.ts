import { NextResponse } from "next/server";

// Proxy admin API URL (for server-side requests)
const PROXY_ADMIN_URL =
  process.env.NEXT_PUBLIC_PROXY_ADMIN_URL || "http://localhost:4040";

export async function GET() {
  try {
    // Fetch providers from the proxy admin API
    const response = await fetch(`${PROXY_ADMIN_URL}/admin/providers`, {
      cache: "no-store",
      headers: {
        "Cache-Control": "no-cache, no-store, must-revalidate",
        Pragma: "no-cache",
        Expires: "0",
      },
    });
    if (!response.ok) {
      throw new Error(`Proxy admin API returned ${response.status}`);
    }
    let data: { providers: any[]; total: number };
    try {
      data = await response.json();
    } catch (e: unknown) {
      throw new Error(
        `Failed to parse providers JSON: ${
          e instanceof Error ? e.message : "Unknown error"
        }`,
      );
    }
    return NextResponse.json({
      data: data.providers,
      total: data.total,
    });
  } catch (error) {
    console.error("Error in providers list API:", error);
    return new Response(
      JSON.stringify({ error: "Failed to load providers" }),
      { status: 500, headers: { "Content-Type": "application/json" } }
    );
  }
}
