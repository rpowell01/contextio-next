import { NextResponse } from "next/server";
import { listCaptureFiles, loadRedactionMeta, metaFilenameFor, getCaptureDir } from "@/lib/sessions/server-utils";
import {
  computeCaptureRedactionCounts,
  getCaptureRedactionStats,
} from "@/lib/sessions/redaction-utils";
import { computeTokenUsage } from "@/lib/sessions/utils";

async function atomicWriteJson(filePath: string, data: unknown): Promise<void> {
  const fs = await import("fs/promises");
  const tmpPath = `${filePath}.tmp`;
  await fs.writeFile(tmpPath, JSON.stringify(data, null, 2));
  await fs.rename(tmpPath, filePath);
}

function toLeanStats(counts: {
  totalRedactions: number;
  byRule: Record<string, number>;
}): { totalRedactions: number; byRule: Record<string, number> } {
  return {
    totalRedactions: counts.totalRedactions,
    byRule: counts.byRule,
  };
}

export async function POST(): Promise<NextResponse> {
  try {
    const captureDir = await getCaptureDir();
    const captureFiles = await listCaptureFiles();

    let processed = 0;
    let skippedExisting = 0;
    let errors = 0;
    let totalRedactions = 0;

    for (const filename of captureFiles) {
      const metaFilename = metaFilenameFor(filename);

      // Check if meta file already exists
      const existingMeta = await loadRedactionMeta(metaFilename);
      if (existingMeta) {
        skippedExisting++;
        continue;
      }

      try {
        const fs = await import("fs/promises");
        const path = await import("path");
        const capturePath = path.join(captureDir, filename);
        const metaPath = path.join(captureDir, metaFilename);
        const raw = await fs.readFile(capturePath, "utf-8");
        const data = JSON.parse(raw) as Record<string, unknown>;

        if (typeof data.requestBody === "undefined") {
          throw new Error("Capture has no requestBody field");
        }

        const persisted = getCaptureRedactionStats(data);
        const counts = computeCaptureRedactionCounts(
          data,
          false,
          persisted ?? undefined,
          data.originalRequestBody,
        );

        // Compute token metrics
        const tokenUsage = computeTokenUsage(
          typeof data.responseBody === "string" ? data.responseBody : null,
          data.requestBody,
        );
        const timeSec = ((data.timings as Record<string, unknown>)?.total_ms as number || 0) / 1000 || 1;
        const tokensPerSecond = timeSec > 0 ? tokenUsage.output / timeSec : 0;

        // Determine success/error
        const responseStatus = typeof data.responseStatus === "number" ? data.responseStatus : 200;
        const isSuccess = responseStatus >= 200 && responseStatus < 300;
        const successCount = isSuccess ? 1 : 0;
        const errorCount = isSuccess ? 0 : 1;

        const leanStats = toLeanStats(counts);

        await atomicWriteJson(metaPath, {
          captureId: filename,
          sessionId:
            typeof data.sessionId === "string" ? data.sessionId : null,
          timestamp: typeof data.timestamp === "string" ? data.timestamp : null,
          provider: typeof data.provider === "string" ? data.provider : null,
          targetUrl: typeof data.targetUrl === "string" ? data.targetUrl : null,
          source: typeof data.source === "string" ? data.source : null,
          timings: data.timings
            ? { total_ms: (data.timings as Record<string, unknown>).total_ms ?? 0 }
            : { total_ms: 0 },
          requestBytes: typeof data.requestBytes === "number" ? data.requestBytes : 0,
          responseBytes: typeof data.responseBytes === "number" ? data.responseBytes : 0,
          totalInputTokens: tokenUsage.input,
          totalOutputTokens: tokenUsage.output,
          tokensPerSecond: Number(tokensPerSecond.toFixed(2)),
          successCount,
          errorCount,
          model: tokenUsage.model,
          ...leanStats,
        });

        processed++;
        totalRedactions += counts.totalRedactions;
      } catch (err) {
        errors++;
        console.error(`ERROR: ${filename} — ${err instanceof Error ? err.message : String(err)}`);
      }
    }

    return NextResponse.json({
      success: true,
      total: captureFiles.length,
      processed,
      skippedExisting,
      errors,
      totalRedactions,
    });
  } catch (error) {
    console.error("Backfill error:", error);
    return NextResponse.json(
      { success: false, error: error instanceof Error ? error.message : "Unknown error" },
      { status: 500 },
    );
  }
}