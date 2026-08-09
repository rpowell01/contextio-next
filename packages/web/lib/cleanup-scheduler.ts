import { DEFAULT_SETTINGS, applyEnvOverrides } from "@/lib/settings";
import { isDbInitialized, deleteCapturesByFilepaths } from "@contextio/core/db";

let cleanupTimer: NodeJS.Timeout | null = null;
let schedulerStarted = false;

let _captureDir: string | undefined;

async function getCaptureDir(): Promise<string> {
  if (!_captureDir) {
    const { homedir } = await import("os");
    const home = await homedir();
    _captureDir = process.env.LOGGER_CAPTURE_DIR || `${home}/.contextio/captures`;
  }
  return _captureDir;
}

function setCaptureDir(dir: string): void {
  _captureDir = dir;
}

async function resolveLogDir(logDir: string): Promise<string> {
  const { join, resolve } = await import("path");
  const { homedir } = await import("os");
  const trimmed = logDir.trim();
  if (!trimmed) {
    const home = await homedir();
    return process.env.LOGGER_CAPTURE_DIR || `${home}/.contextio/captures`;
  }
  if (trimmed === "~") return homedir();
  if (trimmed.startsWith("~/")) return join(await homedir(), trimmed.slice(2));
  if (trimmed.startsWith("/")) return trimmed;
  return resolve(process.cwd(), trimmed);
}

async function applyLogDir(logDir: string): Promise<void> {
  const resolved = await resolveLogDir(logDir);
  setCaptureDir(resolved);
}

function metaFilenameFor(captureFilename: string): string {
  const base = captureFilename.endsWith(".json")
    ? captureFilename.slice(0, -".json".length)
    : captureFilename;
  return `${base}.redact-meta.json`;
}

async function listCaptureFiles(): Promise<string[]> {
  const captureDir = await getCaptureDir();
  const { readdir } = await import("fs/promises");
  try {
    const files = await readdir(captureDir);
    return files
      .filter((f) => /^[a-zA-Z0-9_-]+\.json$/.test(f) && !f.endsWith(".tmp") && !f.includes("redact-meta"))
      .sort();
  } catch {
    return [];
  }
}

function defaultSettings() {
  return {
    enabled: true,
    maxAgeDays: DEFAULT_SETTINGS.captureCleanupMaxAgeDays,
    intervalHours: DEFAULT_SETTINGS.captureCleanupIntervalHours,
  };
}

async function loadSettings(): Promise<{
  enabled: boolean;
  maxAgeDays: number;
  intervalHours: number;
}> {
  try {
    // Ensure database schema is initialized and migrate settings.json if needed
    const { initDb } = await import("@contextio/core/db");
    initDb();
    
    const { getSettings } = await import("@contextio/core/db");
    const dbSettings = getSettings() ?? DEFAULT_SETTINGS;
    
    // Apply environment variable overrides (same pattern as API route)
    const { settings: effectiveSettings } = applyEnvOverrides(dbSettings);
    
    if (typeof effectiveSettings.logDir === "string") {
      await applyLogDir(effectiveSettings.logDir);
    }
    
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

// Use dynamic require for Node.js modules to avoid bundling in client
async function runCleanup(): Promise<void> {
  const settings = await loadSettings();
  if (!settings.enabled || settings.maxAgeDays <= 0) return;
  const cutoff = Date.now() - settings.maxAgeDays * 24 * 60 * 60 * 1000;
  const files = await listCaptureFiles();
  const captureDir = await getCaptureDir();

  // Dynamic import for Node.js built-ins - only runs on server
  const fs = await import("fs/promises");
  const path = await import("path");

  const deletedFilepaths: string[] = [];

  for (const file of files) {
    const filepath = path.join(captureDir, file);
    try {
      const stats = await fs.stat(filepath);
      if (stats.mtimeMs >= cutoff) continue;
      await fs.unlink(filepath);
      await fs.unlink(path.join(captureDir, metaFilenameFor(file))).catch(() => {});
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

export async function startCleanupScheduler(): Promise<NodeJS.Timeout | null> {
  if (schedulerStarted) return cleanupTimer;
  schedulerStarted = true;

  const settings = await loadSettings();
  const intervalMs = settings.intervalHours * 60 * 60 * 1000;

  cleanupTimer = setInterval(runWithCatch, intervalMs);
  // In Node.js, Timer has unref(). In Edge/workerd, setInterval returns a number.
  // Guard against environments without unref().
  if (cleanupTimer && typeof cleanupTimer.unref === "function") {
    cleanupTimer.unref();
  }
  runWithCatch();

  return cleanupTimer;
}