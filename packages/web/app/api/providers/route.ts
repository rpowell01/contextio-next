import { NextResponse } from "next/server";
import { getAllProviders, isDatabaseAvailable } from "@/lib/providers";

export async function GET() {
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
