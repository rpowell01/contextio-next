import { NextRequest, NextResponse } from "next/server";
import { listCaptureFiles, loadRedactionMeta, metaFilenameFor, getCaptureDir } from "@/lib/sessions/server-utils";
import {
  computeCaptureRedactionCounts,
  getCaptureRedactionStats,
} from "@/lib/sessions/redaction-utils";
import { computeTokenUsage } from "@/lib/sessions/utils";
import { decryptCapture } from "@contextio/logger";
import { createErrorResponse, createSuccessResponse } from "@contextio/core";
import { upsertRedactionMetadata, runMigrations } from "@contextio/core/db";
import { buildRedactionMetadata, metadataToJsonSidecar } from "@/lib/sessions/backfill-helpers";

async function atomicWriteJson(filePath: string, data: unknown): Promise<void> {
  const fs = await import("fs/promises");
  const tmpPath = `${filePath}.tmp`;
  await fs.writeFile(tmpPath, JSON.stringify(data, null, 2));
  await fs.rename(tmpPath, filePath);
}

function toLeanStats(counts: {
  totalRedactions: number;
  byRule: Record<string, number>;
  matches: Array<{ ruleId: string; original: string; placeholder: string; path: string }>;
}): { totalRedactions: number; byRule: Record<string, number>; matches: Array<{ ruleId: string; preValue: string; postValue: string; path: string }> } {
  // Limit matches to first 20 to keep meta files small (matches redact package behavior)
  const MATCHES_LIMIT = 20;
  const limitedMatches = counts.matches?.slice(0, MATCHES_LIMIT).map(m => ({
    ruleId: m.ruleId,
    preValue: m.original,
    postValue: m.placeholder,
    path: m.path,
  })) ?? [];

  return {
    totalRedactions: counts.totalRedactions,
    byRule: counts.byRule,
    matches: limitedMatches,
  };
}

export async function POST(request: NextRequest): Promise<NextResponse> {
  try {
    // Ensure database schema is initialized before any SQLite operations
    // Use runMigrations() instead of initDb() to avoid deleting .redact-meta.json files
    runMigrations();

    const captureDir = await getCaptureDir();
    const captureFiles = await listCaptureFiles();
    const encryptionKey = process.env.CONTEXTIO_LOGGER_ENCRYPTION_KEY ?? "";

    // Check for force flag in query params or body
    const { searchParams } = new URL(request.url);
    const force = searchParams.get("force") === "true";

    let processed = 0;
    let skippedExisting = 0;
    let errors = 0;
    let totalRedactions = 0;

    for (const filename of captureFiles) {
      const metaFilename = metaFilenameFor(filename);

      // Check if meta file already exists (unless force)
      if (!force) {
        const existingMeta = await loadRedactionMeta(metaFilename);
        if (existingMeta) {
          skippedExisting++;
          continue;
        }
      }

      try {
        const path = await import("path");
        const capturePath = path.join(captureDir, filename);
        const metaPath = path.join(captureDir, metaFilename);

        // Read and decrypt capture file
        const data = (await decryptCapture(capturePath, encryptionKey || null)) as Record<string, unknown> | null;
        if (!data) {
          throw new Error("Capture file is empty or could not be decrypted");
        }

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

        // Build canonical RedactionMetadata first (single source of truth)
        const { metadata: sqliteMetadata, originalTimestamp } = buildRedactionMetadata({
          captureId: filename,
          data,
          leanStats,
          tokenUsage,
          tokensPerSecond,
          successCount,
          errorCount,
        });

        // Derive JSON sidecar from RedactionMetadata (handles format differences)
        const jsonSidecar = metadataToJsonSidecar(sqliteMetadata, leanStats, originalTimestamp);

        await atomicWriteJson(metaPath, jsonSidecar);

        // Persist to SQLite using the same canonical object
        try {
          upsertRedactionMetadata(sqliteMetadata);
        } catch (sqliteErr) {
          // SQLite upsert failed after JSON file was written.
          // Log the error but don't fail the request - the JSON sidecar is the source of truth.
          console.error(`SQLite upsert failed for ${filename}: ${sqliteErr instanceof Error ? sqliteErr.message : String(sqliteErr)}`);
        }

        processed++;
        totalRedactions += counts.totalRedactions;
      } catch (err) {
        errors++;
        console.error(`ERROR: ${filename} — ${err instanceof Error ? err.message : String(err)}`);
      }
    }

    return NextResponse.json(createSuccessResponse({
      success: true,
      total: captureFiles.length,
      processed,
      skippedExisting,
      errors,
      totalRedactions,
    }));
  } catch (error) {
    console.error("Backfill error:", error);
    return NextResponse.json(
      createErrorResponse({ message: error instanceof Error ? error.message : "Unknown error", status: 500 }),
      { status: 500 },
    );
  }
}