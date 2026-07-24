import { NextResponse } from "next/server";
import { getCaptureDir, listRedactionMetaFiles, loadRedactionMeta } from "@/lib/sessions/server-utils";

export async function GET(): Promise<NextResponse> {
  try {
    const captureDir = await getCaptureDir();
    const metaFiles = await listRedactionMetaFiles();

    const results = [];
    for (const filename of metaFiles.slice(0, 20)) {
      const meta = await loadRedactionMeta(filename);
      results.push({
        filename,
        meta: meta ? {
          totalRedactions: meta.totalRedactions,
          byRule: meta.byRule,
          sessionId: meta.sessionId,
          provider: meta.provider,
          timestamp: meta.timestamp,
          requestBytes: meta.requestBytes,
          responseBytes: meta.responseBytes,
          timings: meta.timings,
        } : null
      });
    }

    return NextResponse.json({
      captureDir,
      metaFileCount: metaFiles.length,
      samples: results,
    });
  } catch (error) {
    return NextResponse.json(
      { error: error instanceof Error ? error.message : "Unknown error" },
      { status: 500 }
    );
  }
}