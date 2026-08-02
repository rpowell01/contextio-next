import { NextRequest, NextResponse } from "next/server";

import { withAuth } from "@/lib/auth/guards";
import { consumeToken } from "@/lib/csrf";
import { getAllProviders, createProvider } from "@/lib/providers";
import type { ProviderConfig } from "@/types/api";
import { createErrorResponse, createSuccessResponse } from "@contextio/core";

async function handleGetProviders(
  _request: NextRequest,
  _context: { params: Promise<Record<string, string | string[]>> },
) {
  try {
    const providers = await getAllProviders();
    return NextResponse.json(createSuccessResponse({ data: providers, total: providers.length }));
  } catch (error) {
    console.error("Error in providers list API:", error);
    return NextResponse.json(createErrorResponse({ message: "Internal server error", status: 500 }), { status: 500 });
  }
}

async function handlePostProviders(
  request: NextRequest,
  _context: { params: Promise<Record<string, string | string[]>> },
) {
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
    const provider = await createProvider(body as ProviderConfig);
    return NextResponse.json(createSuccessResponse({ data: provider }), { status: 201 });
  } catch (error) {
    const details = (error as any)?.errors;
    const errorMessage = error instanceof Error ? error.message : String(error);
    if (Array.isArray(details)) {
      return NextResponse.json(createErrorResponse({ message: "Validation failed", status: 400, details }), { status: 400 });
    }
    if (errorMessage.includes("already exists in file")) {
      return NextResponse.json(createErrorResponse({ message: errorMessage, status: 409 }), { status: 409 });
    }
    console.error("Error creating provider:", error);
    return NextResponse.json(createErrorResponse({ message: "Internal server error", status: 500 }), { status: 500 });
  }
}

export const GET = withAuth(handleGetProviders);
export const POST = withAuth(handlePostProviders);
