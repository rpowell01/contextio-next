import fs from "node:fs/promises";
import { join } from "node:path";
import { CAPTURE_DIR, MAX_FILE_SIZE, extractCaptureMetadata } from "@/lib/sessions/utils";

export async function GET(
  _request: Request,
  { params }: { params: Promise<{ id: string }> }
) {
  const { id } = await params;

  try {
    const filepath = join(CAPTURE_DIR, id);
    const stats = await fs.stat(filepath).catch(() => null);
    
    if (!stats) {
      return Response.json({ error: "Capture not found" }, { status: 404 });
    }
    
    if (stats.size > MAX_FILE_SIZE) {
      return Response.json({ error: "Capture file too large" }, { status: 413 });
    }

    const raw = await fs.readFile(filepath, "utf8");
    const data = JSON.parse(raw) as Record<string, unknown>;
    const capture = extractCaptureMetadata(id, data);

    return Response.json({
      ...capture,
      requestBody: data.requestBody,
      responseBody: data.responseBody,
    });
  } catch (error) {
    console.error("Error in capture detail API:", error);
    return Response.json({ error: "Internal server error" }, { status: 500 });
  }
}