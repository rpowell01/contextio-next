import { NextRequest, NextResponse } from "next/server";
import { getAllProviders, isDatabaseAvailable, createProvider } from "@/lib/providers";
import { withAuth } from "@/lib/auth/guards";
import { consumeToken } from "@/lib/csrf";
import { createErrorResponse, createSuccessResponse } from "@contextio/core";
import type { ProviderConfigInput } from "@/lib/providers";
import type { AuthSession } from "@/lib/auth/session";

async function handleGetProviders(_request: NextRequest, _context: { params: any; session: AuthSession | undefined }) {
  try {
    // Check database availability first
    if (!isDatabaseAvailable()) {
      return NextResponse.json(
        { error: "Database not available. Providers cannot be loaded." },
        { status: 503 }
      );
    }
    
    const providers = await getAllProviders();
    return NextResponse.json({ data: providers, total: providers.length });
  } catch (error) {
    const errorMessage = error instanceof Error ? error.message : String(error);
    console.error("Error in providers list API:", error);
    return NextResponse.json(
      { error: "Failed to load providers", details: errorMessage },
      { status: 500 }
    );
  }
}

async function handleCreateProvider(request: NextRequest, _context: { params: any; session: AuthSession | undefined }) {
  try {
    const csrfToken = request.headers.get("x-csrf-token");
    if (!(await consumeToken(csrfToken ?? ""))) {
      return NextResponse.json(createErrorResponse({ message: "Invalid or missing CSRF token", status: 400 }), { status: 400 });
    }

    let body: unknown;
    try {
      body = await request.json();
    } catch {
      return NextResponse.json(createErrorResponse({ message: "Invalid JSON body", status: 400 }), { status: 400 });
    }

    const provider = await createProvider(body as ProviderConfigInput);
    return NextResponse.json(createSuccessResponse({ data: provider }), { status: 201 });
  } catch (error) {
    const details = (error as any)?.errors;
    const errorMessage = error instanceof Error ? error.message : String(error);
    if (Array.isArray(details)) {
      return NextResponse.json(createErrorResponse({ message: "Validation failed", status: 400, details }), { status: 400 });
    }
    if (errorMessage.includes("UNIQUE constraint failed") || errorMessage.includes("already exists")) {
      return NextResponse.json(createErrorResponse({ message: "Provider with this ID already exists", status: 409 }), { status: 409 });
    }
    console.error("Error creating provider:", error);
    return NextResponse.json(createErrorResponse({ message: "Internal server error", status: 500 }), { status: 500 });
  }
}

export const GET = withAuth(handleGetProviders);
export const POST = withAuth(handleCreateProvider);
