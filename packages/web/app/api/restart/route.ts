import { consumeToken } from "@/lib/csrf";

export async function POST(request: Request) {
  try {
    const csrfToken = request.headers.get("x-csrf-token");
    if (!(await consumeToken(csrfToken ?? ""))) {
      return Response.json({ error: "Invalid or missing CSRF token" }, { status: 400 });
    }
    // In a real implementation, this would trigger a proxy restart
    // For now, return success
    return Response.json({ success: true, message: "Proxy restart initiated" });
  } catch (error) {
    console.error("Error in restart API:", error);
    return Response.json({ error: "Internal server error" }, { status: 500 });
  }
}