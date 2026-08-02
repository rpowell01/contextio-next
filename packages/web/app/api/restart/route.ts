import { consumeToken } from "@/lib/csrf";
import { createErrorResponse, createSuccessResponse } from "@contextio/core";

export async function POST(request: Request) {
  try {
    const csrfToken = request.headers.get("x-csrf-token");
    if (!(await consumeToken(csrfToken ?? ""))) {
      return Response.json(createErrorResponse({ message: "Invalid or missing CSRF token", status: 400 }), { status: 400 });
    }
    // In a real implementation, this would trigger a proxy restart
    // For now, return success
    return Response.json(createSuccessResponse({ success: true, message: "Proxy restart initiated" }));
  } catch (error) {
    console.error("Error in restart API:", error);
    return Response.json(createErrorResponse({ message: "Internal server error", status: 500 }), { status: 500 });
  }
}