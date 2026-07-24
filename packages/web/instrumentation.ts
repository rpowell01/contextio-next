// Use Node.js runtime for instrumentation to support Node.js built-ins (crypto, fs, etc.)
export const runtime = "nodejs";

// Static imports for Node.js built-ins - use default import for CommonJS interop
import os from "os";
import { join } from "path";
import fs from "fs/promises";

const SETTINGS_DIR = "/app/custom-policy";
const SETTINGS_FILE = "/app/custom-policy/settings.json";

function validateCsrfSecret(): void {
  if (process.env.NODE_ENV === "production") {
    if (!process.env.CSRF_SECRET) {
      throw new Error("CSRF_SECRET environment variable is required in production");
    }
  }
}

async function applyPersistedSettings(): Promise<void> {
  try {
    const raw = await fs.readFile(SETTINGS_FILE, "utf8");
    const parsed = JSON.parse(raw);
    if (typeof parsed === "object" && parsed !== null) {
      const obj = parsed as Record<string, unknown>;
      if (typeof obj.logDir === "string") {
        // Use inline applyLogDir instead of importing from server-utils
        const { applyLogDir } = await import("@/lib/sessions/server-utils");
        applyLogDir(obj.logDir);
      }
    }
  } catch {
    // Ignore settings read errors
  }
}

let cleanupTimer: NodeJS.Timeout | null = null;
let schedulerStarted = false;

function defaultSettings() {
  return {
    enabled: true,
    maxAgeDays: 30,
    intervalHours: 24,
  };
}

async function getCaptureDir(): Promise<string> {
  // Use default path or env var
  const captureDir = process.env.LOGGER_CAPTURE_DIR || join(os.homedir(), ".contextio", "captures");
  return captureDir;
}

async function listCaptureFiles(): Promise<string[]> {
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

async function loadSettings(): Promise<{
  enabled: boolean;
  maxAgeDays: number;
  intervalHours: number;
}> {
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

export async function register(): Promise<void> {
  // Validate CSRF secret in ALL runtimes (including Edge) before middleware runs
  validateCsrfSecret();

  // Validate CSRF secret before any middleware runs
  validateCsrfSecret();

  // Apply persisted settings at server startup
  await applyPersistedSettings();

  // Start the capture cleanup scheduler
  await startCleanupScheduler();
}