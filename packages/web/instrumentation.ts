// Use Node.js runtime for instrumentation to support Node.js built-ins
export const runtime = "nodejs";

/**
 * Check if we're running in the Node.js runtime (not Edge).
 * In Next.js 15, instrumentation can be bundled for both runtimes.
 * This check allows graceful degradation in Edge runtime.
 */
function isNodeRuntime(): boolean {
  return typeof process !== "undefined" && !!process.versions?.node;
}

const SETTINGS_DIR = "/app/custom-policy";
const SETTINGS_FILE = "/app/custom-policy/settings.json";

// Periodic sync interval for importing redaction metadata from .redact-meta.json files to SQLite
// Runs every 5 minutes to catch any files that the watcher might have missed
const REDACTION_META_SYNC_INTERVAL_MS = 5 * 60 * 1000;

async function getNodeModules() {
  const [os, path, fs] = await Promise.all([
    import("os"),
    import("path"),
    import("fs/promises"),
  ]);
  return { homedir: os.homedir, join: path.join, fs };
}

function validateCsrfSecret(): void {
  if (process.env.NODE_ENV === "production") {
    if (!process.env.CSRF_SECRET) {
      throw new Error("CSRF_SECRET environment variable is required in production");
    }
  }
}

async function applyPersistedSettings(): Promise<void> {
  try {
    const { readFile } = await import("fs/promises");
    const raw = await readFile(SETTINGS_FILE, "utf8");
    const parsed = JSON.parse(raw);
    if (typeof parsed === "object" && parsed !== null) {
      const obj = parsed as Record<string, unknown>;
      if (typeof obj.logDir === "string") {
        const { applyLogDir } = await import("@/lib/sessions/server-utils");
        applyLogDir(obj.logDir);
      }
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

registerCleanupHandlers();

function defaultSettings() {
  return {
    enabled: true,
    maxAgeDays: 30,
    intervalHours: 24,
  };
}

async function getCaptureDir(): Promise<string> {
  const { homedir, join } = await getNodeModules();
  const captureDir = process.env.LOGGER_CAPTURE_DIR || join(homedir(), ".contextio", "captures");
  return captureDir;
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

async function listCaptureFiles(): Promise<string[]> {
  const { homedir, join, fs } = await getNodeModules();
  const captureDir = await getCaptureDir();
  try {
    const files = await fs.readdir(captureDir);
    return files
      .filter((f) => /^[a-zA-Z0-9_-]+\.json$/.test(f) && !f.endsWith(".tmp") && !f.includes("redact-meta"))
      .sort();
  } catch {
    return [];
  }
}

function metaFilenameFor(captureFilename: string): string {
  const base = captureFilename.endsWith(".json")
    ? captureFilename.slice(0, -".json".length)
    : captureFilename;
  return `${base}.redact-meta.json`;
}

async function loadSettings(): Promise<{ enabled: boolean; maxAgeDays: number; intervalHours: number }> {
  let cleanupSettings: { enabled: boolean; maxAgeDays: number; intervalHours: number } | null = null;
  try {
    const { ensureSettingsFile } = await import("@/lib/settings-server");
    await ensureSettingsFile({});
    const { readSettingsFile } = await import("@/lib/settings-server");
    const raw = await readSettingsFile();
    if (raw) {
      const parsed = JSON.parse(raw);
      if (typeof parsed === "object" && parsed !== null) {
        const obj = parsed as Record<string, unknown>;
        cleanupSettings = {
          enabled:
            typeof obj.captureCleanupEnabled === "boolean"
              ? obj.captureCleanupEnabled
              : defaultSettings().enabled,
          maxAgeDays:
            typeof obj.captureCleanupMaxAgeDays === "number" && Number.isInteger(obj.captureCleanupMaxAgeDays)
              ? obj.captureCleanupMaxAgeDays
              : defaultSettings().maxAgeDays,
          intervalHours:
            typeof obj.captureCleanupIntervalHours === "number" && Number.isInteger(obj.captureCleanupIntervalHours)
              ? obj.captureCleanupIntervalHours
              : defaultSettings().intervalHours,
        };
      }
    }
  } catch {
    // ignore settings read errors; fall back to cleanup defaults below
  }

  return cleanupSettings ?? defaultSettings();
}

async function runCleanup() {
  const settings = await loadSettings();
  if (!settings.enabled || settings.maxAgeDays <= 0) return;

  const cutoff = Date.now() - settings.maxAgeDays * 24 * 60 * 60 * 1000;
  const files = await listCaptureFiles();
  const { join, fs } = await getNodeModules();
  const captureDir = await getCaptureDir();

  for (const file of files) {
    const filepath = join(captureDir, file);
    try {
      const stats = await fs.stat(filepath);
      if (stats.mtimeMs >= cutoff) continue;
      await fs.unlink(filepath);
      await fs.unlink(join(captureDir, metaFilenameFor(file))).catch(() => {});
    } catch {
      // ignore individual file errors (e.g., already deleted, permissions)
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

  // Validate CSRF secret in ALL runtimes (including Edge) before middleware runs
  validateCsrfSecret();

  // Apply persisted settings at server startup
  await applyPersistedSettings();

  // Start the capture cleanup scheduler
  await startCleanupScheduler();

  // Start the redaction metadata sync scheduler (periodic import of .redact-meta.json to SQLite)
  await startSyncScheduler();
}