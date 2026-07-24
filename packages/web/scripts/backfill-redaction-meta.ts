#!/usr/bin/env node

import fs from "fs";
import path from "path";

import { getCaptureDir, metaFilenameFor } from "@/lib/sessions/server-utils";
import {
  computeCaptureRedactionCounts,
  getCaptureRedactionStats,
} from "@/lib/sessions/redaction-utils";

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

    atomicWriteJson(metaPath, {
      captureId: captureBasename,
      sessionId:
        typeof data.sessionId === "string" ? data.sessionId : null,
      timestamp: typeof data.timestamp === "string" ? data.timestamp : null,
      provider: typeof data.provider === "string" ? data.provider : null,
      targetUrl: typeof data.targetUrl === "string" ? data.targetUrl : null,
      source: typeof data.source === "string" ? data.source : null,
      timings: data.timings
        ? { total_ms: data.timings.total_ms ?? 0 }
        : { total_ms: 0 },
      requestBytes: typeof data.requestBytes === "number" ? data.requestBytes : 0,
      responseBytes: typeof data.responseBytes === "number" ? data.responseBytes : 0,
      ...leanStats,
    });

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
