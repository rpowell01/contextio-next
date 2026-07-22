import { NextResponse } from "next/server";
import { getCaptureDir, listCaptureFiles } from "@/lib/sessions/utils";

export async function GET(): Promise<NextResponse> {
  try {
    const captureDir = await getCaptureDir();
    const captureFiles = await listCaptureFiles();

    return NextResponse.json({
      captureDir,
      captureFileCount: captureFiles.length,
      samples: captureFiles.slice(0, 10),
    });
  } catch (error) {
    return NextResponse.json(
      { error: error instanceof Error ? error.message : "Unknown error" },
      { status: 500 }
    );
  }
}