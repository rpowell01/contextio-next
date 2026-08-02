import { NextResponse } from "next/server";
import { getCaptureDir } from "@/lib/sessions/server-utils";
import { promises as fs } from "fs";
import path from "path";
import { createErrorResponse, createSuccessResponse } from "@contextio/core";

export async function GET(request: Request): Promise<NextResponse> {
  try {
    const { searchParams } = new URL(request.url);
    const filename = searchParams.get("filename");

    if (!filename) {
      return NextResponse.json(
        createErrorResponse({ message: "filename parameter required", status: 400 }),
        { status: 400 }
      );
    }

    const captureDir = await getCaptureDir();
    const filepath = path.join(captureDir, filename);

    let raw: string;
    let parsed: unknown;
    let stat: Awaited<ReturnType<typeof fs.stat>>;

    try {
      raw = await fs.readFile(filepath, "utf8");
      parsed = JSON.parse(raw);
      stat = await fs.stat(filepath);
    } catch (e) {
      return NextResponse.json(
        createErrorResponse({ message: e instanceof Error ? e.message : "Unknown error", status: 500 }),
        { status: 500 }
      );
    }

    return NextResponse.json(createSuccessResponse({
      filename,
      filepath,
      size: stat.size,
      raw,
      parsed,
    }));
  } catch (error) {
    return NextResponse.json(
      createErrorResponse({ message: error instanceof Error ? error.message : "Unknown error", status: 500 }),
      { status: 500 }
    );
  }
}