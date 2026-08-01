import { NextRequest, NextResponse } from "next/server";

import { withAuth } from "@/lib/auth/guards";
import { consumeToken } from "@/lib/csrf";
import { getProviderById, updateProvider, deleteProvider } from "@/lib/providers";
import type { ProviderConfig } from "@/types/api";

async function handleGetProvider(
  _request: NextRequest,
  context: { params: Promise<{ id: string }> },
) {
  try {
    const { id } = await context.params;
    const provider = await getProviderById(id);
    if (!provider) {
      return NextResponse.json({ error: "Provider not found" }, { status: 404 });
    }
    return NextResponse.json({ data: provider });
  } catch (error) {
    console.error("Error in provider detail API:", error);
    return NextResponse.json({ error: "Internal server error" }, { status: 500 });
  }
}

async function handlePutProvider(
  request: NextRequest,
  context: { params: Promise<{ id: string }> },
) {
  try {
    const csrfToken = request.headers.get("x-csrf-token");
    if (!(await consumeToken(csrfToken ?? ""))) {
      return NextResponse.json({ error: "Invalid or missing CSRF token" }, { status: 400 });
    }

    const { id } = await context.params;
    let body: unknown;
    try {
      body = await request.json();
    } catch {
      return NextResponse.json({ error: "Invalid JSON body" }, { status: 400 });
    }
    const provider = await updateProvider(id, body as ProviderConfig);
    return NextResponse.json({ data: provider });
  } catch (error) {
    const details = (error as any)?.errors;
    const errorMessage = error instanceof Error ? error.message : String(error);
    if (Array.isArray(details)) {
      return NextResponse.json({ error: "Validation failed", details }, { status: 400 });
    }
    if (errorMessage.includes("does not match id in body")) {
      return NextResponse.json({ error: errorMessage }, { status: 400 });
    }
    if (errorMessage.includes("not found in file")) {
      return NextResponse.json({ error: errorMessage }, { status: 404 });
    }
    console.error("Error updating provider:", error);
    return NextResponse.json({ error: "Internal server error" }, { status: 500 });
  }
}

async function handleDeleteProvider(
  request: NextRequest,
  context: { params: Promise<{ id: string }> },
) {
  try {
    const csrfToken = request.headers.get("x-csrf-token");
    if (!(await consumeToken(csrfToken ?? ""))) {
      return NextResponse.json({ error: "Invalid or missing CSRF token" }, { status: 400 });
    }

    const { id } = await context.params;
    await deleteProvider(id);
    return NextResponse.json({ data: { success: true } });
  } catch (error) {
    const errorMessage = error instanceof Error ? error.message : String(error);
    if (errorMessage.includes("not found in file")) {
      return NextResponse.json({ error: errorMessage }, { status: 404 });
    }
    console.error("Error deleting provider:", error);
    return NextResponse.json({ error: "Internal server error" }, { status: 500 });
  }
}

export const GET = withAuth(handleGetProvider);
export const PUT = withAuth(handlePutProvider);
export const DELETE = withAuth(handleDeleteProvider);
