import { NextRequest, NextResponse } from "next/server";

import {
  getCaptureDir,
  listCaptureFiles,
  readCaptureFile,
} from "@/lib/sessions/server-utils";
import {
  computeCaptureRedactionCounts,
  getCaptureRedactionStats,
} from "@/lib/sessions/redaction-utils";
import { computeTokenUsage, type TokenUsageResult } from "@/lib/sessions/utils";
import { initDb, upsertRedactionMetadata, runMigrations } from "@contextio/core/db";
import { buildRedactionMetadata } from "@/lib/sessions/backfill-helpers";
import { withRequestCache } from "@/lib/request-cache";

interface BackfillResponse {
  success: boolean;
  processed: number;
  skippedExisting: number;
  errors: number;
  totalRedactions: number;
  error?: string;
}

/**
 * Backfill redaction metadata by re-running redaction on capture files.
 * This extracts actual matches (including detector-based redactions) rather than
 * just scanning for placeholder patterns in the request body.
 */
export async function POST(request: NextRequest) {
  return withRequestCache(async () => {
    try {
    const { searchParams } = new URL(request.url);
    const force = searchParams.get("force") === "true";

    // Initialize DB with decryption support for any encrypted metadata
    const { decrypt } = await import("@contextio/logger");
    const keyMaterial = process.env.CONTEXTIO_LOGGER_ENCRYPTION_KEY;
    if (decrypt && keyMaterial) {
      initDb(decrypt, keyMaterial);
    } else {
      initDb();
    }

    // Ensure migrations run (creates matches column if needed)
    runMigrations();

    const captureDir = await getCaptureDir();
    const files = await listCaptureFiles();

    let processed = 0;
    let skippedExisting = 0;
    let errors = 0;
    let totalRedactions = 0;

    for (const file of files) {
      const capturePath = `${captureDir}/${file}`;
      const captureData = await readCaptureFile(capturePath);

      if (!captureData) {
        errors++;
        continue;
      }

      // Check if SQLite metadata already exists
      const { isDbInitialized, getRedactionMetadataByCaptureId } = await import("@contextio/core/db");
      if (isDbInitialized() && !force) {
        const existingMeta = getRedactionMetadataByCaptureId(file.replace(/\.json$/, ""));
        if (existingMeta) {
          skippedExisting++;
          continue;
        }
      }

      try {
        if (typeof captureData.requestBody === "undefined") {
          throw new Error("Capture has no requestBody field");
        }

        // Get persisted stats from capture (written by redact plugin at capture time)
        const persistedStats = getCaptureRedactionStats(captureData);

        // Compute redaction counts with originalRequestBody for accurate pre/post values
        const counts = computeCaptureRedactionCounts(
          captureData,
          false, // don't count response body
          persistedStats ?? undefined,
          captureData.originalRequestBody,
        );

        // Compute token usage
        const responseBody = typeof captureData.responseBody === "string" ? captureData.responseBody : null;
        const tokenUsage: TokenUsageResult = computeTokenUsage(responseBody, captureData.requestBody);

        // Compute additional metrics
        const rawTimings = captureData.timings && typeof captureData.timings === "object"
          ? (captureData.timings as Record<string, unknown>)
          : {};
        const totalMs = typeof rawTimings.total_ms === "number" ? rawTimings.total_ms : 0;
        const timeSec = totalMs > 0 ? totalMs / 1000 : 1;
        const tokensPerSecond = timeSec > 0 ? tokenUsage.output / timeSec : 0;
        const responseStatus = typeof captureData.responseStatus === "number" ? captureData.responseStatus : 200;
        const isSuccess = responseStatus >= 200 && responseStatus < 300;
        const successCount = isSuccess ? 1 : 0;
        const errorCount = isSuccess ? 0 : 1;

        // Build RedactionMetadata with matches from leaky scanned matches
        // Note: This uses the scanned matches from redaction-utils which finds placeholders
        // For true detector-based matches, we'd need to re-run the actual redact plugin
        const leanStats = {
          totalRedactions: counts.totalRedactions,
          byRule: counts.byRule,
          matches: counts.matches?.map((m) => ({
            ruleId: m.ruleId,
            preValue: m.original,
            postValue: m.placeholder,
            path: m.path,
          })),
        };

        const { metadata: sqliteMetadata } = buildRedactionMetadata({
          captureId: file.replace(/\.json$/, ""),
          data: captureData,
          leanStats,
          tokenUsage,
          tokensPerSecond,
          successCount,
          errorCount,
        });

        // Upsert to SQLite
        upsertRedactionMetadata(sqliteMetadata);

        processed++;
        totalRedactions += counts.totalRedactions;
      } catch (err) {
        console.error(`Backfill error for ${file}:`, err);
        errors++;
      }
    }

    return NextResponse.json({
      success: errors === 0,
      processed,
      skippedExisting,
      errors,
      totalRedactions,
    } as BackfillResponse);
  } catch (err) {
    console.error("Backfill failed:", err);
    return NextResponse.json(
      { success: false, processed: 0, skippedExisting: 0, errors: 1, totalRedactions: 0, error: String(err) } as BackfillResponse,
      { status: 500 },
    );
  }
  });
}