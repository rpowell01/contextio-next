import { NextResponse } from "next/server";
import { getCaptureDir, listCaptureFiles } from "@/lib/sessions/server-utils";
import { createErrorResponse, createSuccessResponse } from "@contextio/core";

export async function GET(): Promise<NextResponse> {
  try {
    const captureDir = await getCaptureDir();
    const captureFiles = await listCaptureFiles();

    return NextResponse.json(createSuccessResponse({
      captureDir,
      captureFileCount: captureFiles.length,
      samples: captureFiles.slice(0, 10),
    }));
  } catch (error) {
    return NextResponse.json(
      createErrorResponse({ message: error instanceof Error ? error.message : "Unknown error", status: 500 }),
      { status: 500 }
    );
  }
}