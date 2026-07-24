import { NextResponse } from "next/server";
import { getCaptureDir } from "@/lib/sessions/server-utils";
import { promises as fs } from "fs";
import path from "path";

export async function GET(request: Request): Promise<NextResponse> {
  try {
    const { searchParams } = new URL(request.url);
    const filename = searchParams.get("filename");

    if (!filename) {
      return NextResponse.json(
        { error: "filename parameter required" },
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
        { error: e instanceof Error ? e.message : "Unknown error" },
        { status: 500 }
      );
    }

    return NextResponse.json({
      filename,
      filepath,
      size: stat.size,
      raw,
      parsed,
    });
  } catch (error) {
    return NextResponse.json(
      { error: error instanceof Error ? error.message : "Unknown error" },
      { status: 500 }
    );
  }
}