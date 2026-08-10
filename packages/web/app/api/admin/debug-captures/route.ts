import { NextResponse } from "next/server";
import {
  getRedactionAggregateStats,
} from "@contextio/core/db";
import { getCaptureDir } from "@/lib/sessions/server-utils";
import { createErrorResponse, createSuccessResponse } from "@contextio/core";

export async function GET(): Promise<NextResponse> {
  try {
    const captureDir = await getCaptureDir();
    const aggregate = getRedactionAggregateStats();

    return NextResponse.json(createSuccessResponse({
      captureDir,
      totalCaptures: aggregate.totalCaptures,
      totalRedactions: aggregate.totalRedactions,
      byRule: aggregate.byRule,
    }));
  } catch (error) {
    return NextResponse.json(
      createErrorResponse({ message: error instanceof Error ? error.message : "Unknown error", status: 500 }),
      { status: 500 }
    );
  }
}