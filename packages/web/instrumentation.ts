// Use Node.js runtime for instrumentation to support Node.js built-ins
export const runtime = "nodejs";

import { DEFAULT_SETTINGS, applyEnvOverrides } from "@/lib/settings";
import { isDbInitialized, deleteCapturesByFilepaths } from "@contextio/core/db";
import {
  getCaptureDir,
  listCaptureFiles,
  metaFilenameFor,
  applyLogDir,
} from "@/lib/sessions/server-utils";

/**
 * Check if we're running in the Node.js runtime (not Edge).
 * In Next.js 15, instrumentation can be bundled for both runtimes.
 * This check allows graceful degradation in Edge runtime.
 */
function isNodeRuntime(): boolean {
  return typeof process !== "undefined" && !!process.versions?.node;
}

// Periodic sync interval for importing redaction metadata from .redact-meta.json files to SQLite
// Runs every 5 minutes to catch any files that the watcher might have missed
const REDACTION_META_SYNC_INTERVAL_MS = 5 * 60 * 1000;

function validateCsrfSecret(): void {
  if (process.env.NODE_ENV === "production") {
    if (!process.env.CSRF_SECRET) {
      throw new Error("CSRF_SECRET environment variable is required in production");
    }
  }
}

async function applyPersistedSettings(): Promise<void> {
  try {
    // Ensure database schema is initialized and migrate settings.json if needed
    const { initDb } = await import("@contextio/core/db");
    initDb();
    
    const { getSettingsWithMeta } = await import("@contextio/core/db");
    const { settings: dbSettings } = getSettingsWithMeta();
    
    // Apply environment variable overrides
    const { settings: effectiveSettings } = applyEnvOverrides(dbSettings ?? DEFAULT_SETTINGS);
    
    if (typeof effectiveSettings.logDir === "string") {
      await applyLogDir(effectiveSettings.logDir);
    }
  } catch {
    // Ignore settings read errors
  }
}

let cleanupTimer: NodeJS.Timeout | null = null;
let syncTimer: NodeJS.Timeout | null = null;
let schedulerStarted = false;
let syncStarted = false;

function stopSyncScheduler(): void {
  if (syncTimer) {
    clearInterval(syncTimer);
    syncTimer = null;
    syncStarted = false;
  }
}

function stopCleanupScheduler(): void {
  if (cleanupTimer) {
    clearInterval(cleanupTimer);
    cleanupTimer = null;
    schedulerStarted = false;
  }
}

let cleanupHandlersRegistered = false;

function registerCleanupHandlers(): void {
  if (cleanupHandlersRegistered || !isNodeRuntime()) return;
  cleanupHandlersRegistered = true;
  const cleanup = () => {
    stopSyncScheduler();
    stopCleanupScheduler();
  };
  process.on("SIGTERM", cleanup);
  process.on("SIGINT", cleanup);
  process.on("beforeExit", cleanup);
  process.on("exit", cleanup);
}

function defaultSettings() {
  return {
    enabled: true,
    maxAgeDays: DEFAULT_SETTINGS.captureCleanupMaxAgeDays,
    intervalHours: DEFAULT_SETTINGS.captureCleanupIntervalHours,
  };
}

async function runRedactionMetaSync(): Promise<void> {
  // Skip in Edge runtime as an additional safety measure
  if (!isNodeRuntime()) {
    return;
  }
  try {
    const { importRedactionMetaFromFiles } = await import("@contextio/core/db");
    const { decrypt } = await import("@contextio/logger");
    const captureDir = await getCaptureDir();

    // Import any .redact-meta.json files that aren't in SQLite yet
    // Pass decrypt function to handle encrypted sidecar files
    const imported = await importRedactionMetaFromFiles(captureDir, decrypt);
    if (imported > 0) {
      console.log(`[redaction-meta-sync] Imported ${imported} redaction metadata files to SQLite`);
    }
  } catch (error) {
    console.error("[redaction-meta-sync] Failed to sync redaction metadata:", error);
  }
}

function runSyncWithCatch(): void {
  runRedactionMetaSync().catch((error) => {
    console.error("Scheduled redaction metadata sync failed:", error);
  });
}

async function startSyncScheduler(): Promise<NodeJS.Timeout | null> {
  // Skip in Edge runtime
  if (!isNodeRuntime()) {
    return null;
  }
  if (syncStarted) return syncTimer;
  syncStarted = true;

  // Ensure database schema is initialized (runs once at startup)
  try {
    const { runMigrations } = await import("@contextio/core/db");
    runMigrations();
  } catch (error) {
    console.error("[redaction-meta-sync] Failed to run migrations:", error);
  }

  syncTimer = setInterval(runSyncWithCatch, REDACTION_META_SYNC_INTERVAL_MS);
  if (syncTimer && typeof syncTimer.unref === "function") {
    syncTimer.unref();
  }
  // Run an initial sync at startup
  runSyncWithCatch();

  return syncTimer;
}

async function loadSettings(): Promise<{ enabled: boolean; maxAgeDays: number; intervalHours: number }> {
  try {
    // Ensure database schema is initialized and migrate settings.json if needed
    const { initDb } = await import("@contextio/core/db");
    initDb();
    
    const { getSettings } = await import("@contextio/core/db");
    const dbSettings = getSettings() ?? DEFAULT_SETTINGS;
    
    // Apply environment variable overrides (same pattern as API route)
    const { settings: effectiveSettings } = applyEnvOverrides(dbSettings);
    
    return {
      enabled: effectiveSettings.captureCleanupEnabled,
      maxAgeDays: effectiveSettings.captureCleanupMaxAgeDays,
      intervalHours: effectiveSettings.captureCleanupIntervalHours,
    };
  } catch {
    // Ignore settings read errors; fall back to cleanup defaults
    return defaultSettings();
  }
}

async function runCleanup() {
  const settings = await loadSettings();
  if (!settings.enabled || settings.maxAgeDays <= 0) return;

  const cutoff = Date.now() - settings.maxAgeDays * 24 * 60 * 60 * 1000;
  const files = await listCaptureFiles();
  const { join } = await import("path");
  const { stat, unlink } = await import("fs/promises");
  const captureDir = await getCaptureDir();

  const deletedFilepaths: string[] = [];

  for (const file of files) {
    const filepath = join(captureDir, file);
    try {
      const stats = await stat(filepath);
      if (stats.mtimeMs >= cutoff) continue;
      await unlink(filepath);
      await unlink(join(captureDir, metaFilenameFor(file))).catch(() => {});
      deletedFilepaths.push(filepath);
    } catch {
      // ignore individual file errors (e.g., already deleted, permissions)
    }
  }

  // Clean up corresponding SQLite metadata records
  if (deletedFilepaths.length > 0 && isDbInitialized()) {
    try {
      const deletedCount = deleteCapturesByFilepaths(deletedFilepaths);
      if (deletedCount > 0) {
        console.log(`[cleanup] Removed ${deletedCount} orphaned capture metadata records from SQLite`);
      }
    } catch (err) {
      console.warn(`[cleanup] Failed to clean up SQLite capture metadata: ${err instanceof Error ? err.message : String(err)}`);
    }
  }
}

function runWithCatch(): void {
  runCleanup().catch((error) => {
    console.error("Scheduled capture cleanup failed:", error);
  });
}

async function startCleanupScheduler() {
  // Skip in Edge runtime
  if (!isNodeRuntime()) {
    return null;
  }
  if (schedulerStarted) return cleanupTimer;
  schedulerStarted = true;

  const settings = await loadSettings();
  const intervalMs = settings.intervalHours * 60 * 60 * 1000;

  cleanupTimer = setInterval(runWithCatch, intervalMs);
  if (cleanupTimer && typeof cleanupTimer.unref === "function") {
    cleanupTimer.unref();
  }
  runWithCatch();

  return cleanupTimer;
}

export async function register(): Promise<void> {
  // Skip Node.js-specific initialization in Edge runtime
  if (!isNodeRuntime()) {
    console.log("[instrumentation] Running in Edge runtime, skipping Node.js-specific initialization");
    // Still validate CSRF secret in Edge runtime
    validateCsrfSecret();
    await applyPersistedSettings();
    return;
  }

  // Register process exit handlers (deduplicated for HMR safety)
  registerCleanupHandlers();

  // Validate CSRF secret in ALL runtimes (including Edge) before middleware runs
  validateCsrfSecret();

  // Apply persisted settings at server startup
  await applyPersistedSettings();

  // Start the capture cleanup scheduler
  await startCleanupScheduler();

  // Start the redaction metadata sync scheduler (periodic import of .redact-meta.json to SQLite)
  await startSyncScheduler();
}