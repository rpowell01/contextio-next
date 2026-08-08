#!/usr/bin/env node

import fs from "fs";
import path from "path";

import { getCaptureDir, metaFilenameFor } from "@/lib/sessions/server-utils";
import {
  computeCaptureRedactionCounts,
  getCaptureRedactionStats,
} from "@/lib/sessions/redaction-utils";
import { computeTokenUsage, type TokenUsageResult } from "@/lib/sessions/utils";
import { upsertRedactionMetadata, runMigrations } from "@contextio/core/db";
import { buildRedactionMetadata, metadataToJsonSidecar } from "@/lib/sessions/backfill-helpers";

interface BackfillStats {
  total: number;
  processed: number;
  skippedExisting: number;
  errors: number;
  totalRedactions: number;
}

function atomicWriteJson(filePath: string, data: unknown): void {
  const tmpPath = `${filePath}.tmp`;
  fs.writeFileSync(tmpPath, JSON.stringify(data, null, 2));
  fs.renameSync(tmpPath, filePath);
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

function processCapture(
  capturePath: string,
  stats: BackfillStats,
): void {
  const captureBasename = path.basename(capturePath);
  const metaPath = path.join(path.dirname(capturePath), metaFilenameFor(captureBasename));

  if (fs.existsSync(metaPath)) {
    stats.skippedExisting++;
    return;
  }

  try {
    const raw = fs.readFileSync(capturePath, "utf-8");
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

    const leanStats = toLeanStats(counts);

    // Compute token usage from response body (unconditionally to allow requestBody fallback)
    const responseBody = typeof data.responseBody === "string" ? data.responseBody : null;
    const tokenUsage: TokenUsageResult = computeTokenUsage(responseBody, data.requestBody);

    // Compute additional metrics (tokensPerSecond, successCount, errorCount)
    const timeSec = ((data.timings as Record<string, unknown>)?.total_ms as number || 0) / 1000 || 1;
    const tokensPerSecond = timeSec > 0 ? tokenUsage.output / timeSec : 0;
    const responseStatus = typeof data.responseStatus === "number" ? data.responseStatus : 200;
    const isSuccess = responseStatus >= 200 && responseStatus < 300;
    const successCount = isSuccess ? 1 : 0;
    const errorCount = isSuccess ? 0 : 1;

    // Build canonical RedactionMetadata first (single source of truth)
    const { metadata: sqliteMetadata, originalTimestamp } = buildRedactionMetadata({
      captureId: captureBasename,
      data,
      leanStats,
      tokenUsage,
      tokensPerSecond,
      successCount,
      errorCount,
    });

    // Derive JSON sidecar from RedactionMetadata (handles format differences)
    const jsonSidecar = metadataToJsonSidecar(sqliteMetadata, leanStats, originalTimestamp);

    atomicWriteJson(metaPath, jsonSidecar);

    // Persist to SQLite using the same canonical object
    try {
      upsertRedactionMetadata(sqliteMetadata);
    } catch (sqliteErr) {
      // SQLite upsert failed after JSON file was written.
      // Log the error but don't fail the backfill - the JSON sidecar is the source of truth.
      console.error(`  SQLite upsert failed for ${captureBasename}: ${sqliteErr instanceof Error ? sqliteErr.message : String(sqliteErr)}`);
    }

    stats.processed++;
    stats.totalRedactions += counts.totalRedactions;
  } catch (err) {
    stats.errors++;
    console.error(` ERROR: ${captureBasename} — ${(err as Error).message}`);
  }
}

function usage(): void {
  console.error(`Usage: backfill-redaction-meta [CAPTURE_DIR]`);
  console.error(` CAPTURE_DIR Override capture directory.`);
  console.error(
    ` Defaults to ~/.contextio/captures (or LOGGER_CAPTURE_DIR)`,
  );
  process.exit(1);
}

async function runBackfill(): Promise<void> {
  // Ensure database schema is initialized before any SQLite operations
  // Use runMigrations() instead of initDb() to avoid deleting .redact-meta.json files
  runMigrations();

  const resolvedCaptureDir = process.argv[2] ?? await getCaptureDir();

  if (process.argv[2] === "--help" || process.argv[2] === "-h") {
    usage();
  }

  if (!fs.existsSync(resolvedCaptureDir)) {
    console.error(
      `Capture directory does not exist: ${resolvedCaptureDir}`,
    );
    process.exit(1);
  }

  const entries = fs.readdirSync(resolvedCaptureDir);
  const captureFiles = entries
    .filter((f) => f.endsWith(".json") && !f.endsWith(".tmp"))
    .sort();

  const stats: BackfillStats = {
    total: captureFiles.length,
    processed: 0,
    skippedExisting: 0,
    errors: 0,
    totalRedactions: 0,
  };

  console.log(`Scanning ${resolvedCaptureDir}`);
  console.log(`Found ${stats.total} capture files`);

  for (const file of captureFiles) {
    const capturePath = path.join(resolvedCaptureDir, file);
    processCapture(capturePath, stats);
  }

  console.log("\n=== Backfill Summary ===");
  console.log(`Total capture files : ${stats.total}`);
  console.log(`Processed : ${stats.processed}`);
  console.log(`Skipped (existing) : ${stats.skippedExisting}`);
  console.log(`Errors : ${stats.errors}`);
  console.log(`Total redactions : ${stats.totalRedactions}`);

  if (stats.errors > 0) {
    process.exitCode = 1;
  }
}

await runBackfill();

