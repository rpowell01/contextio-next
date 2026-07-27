#!/usr/bin/env node

import fs from "node:fs";
import { homedir } from "node:os";
import { join, basename, dirname } from "node:path";

// Treat the repo root as a package root so we can resolve workspace imports.
// When compiled to scripts/dist/, source maps two dirs up to repo root.
const PROJECT_ROOT = join(import.meta.dirname!, "..", "..");
const PACKAGE_ROOT = PROJECT_ROOT;

function importFromWeb(modulePath: string): unknown {
  const full = join(PACKAGE_ROOT, "packages", "web", modulePath);
  // @ts-expect-error dynamic ESM import for scripts/dir layout.
  return import(full);
}

// Resolve CAPTURE_DIR from env first, then fall back to the web package constant.
const captureDir =
  process.env.LOGGER_CAPTURE_DIR ??
  join(homedir(), ".contextio", "captures");

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

async function processCapture(
  capturePath: string,
  stats: BackfillStats,
  computeCounts: typeof computeCaptureRedactionCounts,
  getStats: typeof getCaptureRedactionStats,
): Promise<void> {
  const captureBasename = basename(capturePath);
  const metaBasename = `${captureBasename}.redact-meta.json`;
  const metaPath = join(dirname(capturePath), metaBasename);

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

    const persisted = getStats(data);
    const counts = computeCounts(data, false, persisted, data.originalRequestBody);

    const leanStats = toLeanStats(counts);

    atomicWriteJson(metaPath, {
      captureId: captureBasename,
      sessionId: typeof data.sessionId === "string" ? data.sessionId : null,
      timestamp: typeof data.timestamp === "string" ? data.timestamp : null,
      provider: typeof data.provider === "string" ? data.provider : null,
      targetUrl: typeof data.targetUrl === "string" ? data.targetUrl : null,
      ...leanStats,
    });

    stats.processed++;
    stats.totalRedactions += counts.totalRedactions;
  } catch (err) {
    stats.errors++;
    console.error(`  ERROR: ${captureBasename} — ${(err as Error).message}`);
  }
}

async function runBackfill(): Promise<void> {
  if (!fs.existsSync(captureDir)) {
    console.error(`Capture directory does not exist: ${captureDir}`);
    process.exit(1);
  }

  const entries = fs.readdirSync(captureDir);
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

  console.log(`Scanning ${captureDir}`);
  console.log(`Found ${stats.total} capture files`);

  const redactionUtils = await importFromWeb(
    "/lib/sessions/redaction-utils.ts",
  );
  const computeCounts = redactionUtils.computeCaptureRedactionCounts as (
    ...args: Parameters<typeof computeCaptureRedactionCounts>
  ) => Promise<{
    totalRedactions: number;
    byRule: Record<string, number>;
    matches: Array<{ ruleId: string }>;
  }>;
  const getStats = redactionUtils.getCaptureRedactionStats as (
    capture: Record<string, unknown>,
  ) => { totalRedactions: number; byRule: Record<string, number> } | null;

  for (const file of captureFiles) {
    const capturePath = join(captureDir, file);
    await processCapture(capturePath, stats, computeCounts, getStats);
  }

  console.log("\n=== Backfill Summary ===");
  console.log(`Total capture files : ${stats.total}`);
  console.log(`Processed          : ${stats.processed}`);
  console.log(`Skipped (existing) : ${stats.skippedExisting}`);
  console.log(`Errors             : ${stats.errors}`);
  console.log(`Total redactions   : ${stats.totalRedactions}`);

  if (stats.errors > 0) {
    process.exitCode = 1;
  }
}

runBackfill().catch((err) => {
  console.error("Fatal error:", err);
  process.exit(1);
});
