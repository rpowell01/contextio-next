import { NextRequest, NextResponse } from "next/server";

import { withAuth } from "@/lib/auth/guards";
import { consumeToken } from "@/lib/csrf";
import { getProviderById, updateProvider, deleteProvider } from "@/lib/providers";
import type { ProviderConfig } from "@/types/api";
import { createErrorResponse, createSuccessResponse } from "@contextio/core";

async function handleGetProvider(
  _request: NextRequest,
  context: { params: Promise<{ id: string }> },
) {
  try {
    const { id } = await context.params;
    const provider = await getProviderById(id);
    if (!provider) {
      return NextResponse.json(createErrorResponse({ message: "Provider not found", status: 404 }), { status: 404 });
    }
    return NextResponse.json(createSuccessResponse({ data: provider }));
  } catch (error) {
    console.error("Error in provider detail API:", error);
    return NextResponse.json(createErrorResponse({ message: "Internal server error", status: 500 }), { status: 500 });
  }
}

async function handlePutProvider(
  request: NextRequest,
  context: { params: Promise<{ id: string }> },
) {
  try {
    const csrfToken = request.headers.get("x-csrf-token");
    if (!(await consumeToken(csrfToken ?? ""))) {
      return NextResponse.json(createErrorResponse({ message: "Invalid or missing CSRF token", status: 400 }), { status: 400 });
    }

    const { id } = await context.params;
    let body: unknown;
    try {
      body = await request.json();
    } catch {
      return NextResponse.json(createErrorResponse({ message: "Invalid JSON body", status: 400 }), { status: 400 });
    }
    const provider = await updateProvider(id, body as ProviderConfig);
    return NextResponse.json(createSuccessResponse({ data: provider }));
  } catch (error) {
    const details = (error as any)?.errors;
    const errorMessage = error instanceof Error ? error.message : String(error);
    if (Array.isArray(details)) {
      return NextResponse.json(createErrorResponse({ message: "Validation failed", status: 400, details }), { status: 400 });
    }
    if (errorMessage.includes("does not match id in body")) {
      return NextResponse.json(createErrorResponse({ message: errorMessage, status: 400 }), { status: 400 });
    }
    if (errorMessage.includes("not found in file")) {
      return NextResponse.json(createErrorResponse({ message: errorMessage, status: 404 }), { status: 404 });
    }
    console.error("Error updating provider:", error);
    return NextResponse.json(createErrorResponse({ message: "Internal server error", status: 500 }), { status: 500 });
  }
}

async function handleDeleteProvider(
  request: NextRequest,
  context: { params: Promise<{ id: string }> },
) {
  try {
    const csrfToken = request.headers.get("x-csrf-token");
    if (!(await consumeToken(csrfToken ?? ""))) {
      return NextResponse.json(createErrorResponse({ message: "Invalid or missing CSRF token", status: 400 }), { status: 400 });
    }

    const { id } = await context.params;
    await deleteProvider(id);
    return NextResponse.json(createSuccessResponse({ data: { success: true } }));
  } catch (error) {
    const errorMessage = error instanceof Error ? error.message : String(error);
    if (errorMessage.includes("not found in file")) {
      return NextResponse.json(createErrorResponse({ message: errorMessage, status: 404 }), { status: 404 });
    }
    console.error("Error deleting provider:", error);
    return NextResponse.json(createErrorResponse({ message: "Internal server error", status: 500 }), { status: 500 });
  }
}

export const GET = withAuth(handleGetProvider);
export const PUT = withAuth(handlePutProvider);
export const DELETE = withAuth(handleDeleteProvider);
