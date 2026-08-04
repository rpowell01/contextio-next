import { NextResponse } from "next/server";
import { getAllProviders } from "@/lib/providers";
import { createErrorResponse, createSuccessResponse } from "@contextio/core";

export async function GET() {
  try {
    const providers = await getAllProviders();
    return NextResponse.json({ data: providers, total: providers.length });
  } catch (error) {
    console.error("Error in providers list API:", error);
    return NextResponse.json(
      { error: "Failed to load providers" },
      { status: 500 }
    );
  }
}
