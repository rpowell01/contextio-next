import { DEFAULT_SETTINGS } from "@/lib/settings";

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
    enabled: DEFAULT_SETTINGS.captureCleanupEnabled,
    maxAgeDays: DEFAULT_SETTINGS.captureCleanupMaxAgeDays,
    intervalHours: DEFAULT_SETTINGS.captureCleanupIntervalHours,
  };
}

async function loadSettings(): Promise<{
  enabled: boolean;
  maxAgeDays: number;
  intervalHours: number;
}> {
  const { ensureSettingsFile, readSettingsFile } = await import("@/lib/settings-server");

  let capturedLogDir: string | undefined;
  let cleanupSettings: { enabled: boolean; maxAgeDays: number; intervalHours: number } | null = null;
  try {
    await ensureSettingsFile(DEFAULT_SETTINGS);
    const raw = await readSettingsFile();
    if (raw) {
      const parsed = JSON.parse(raw);
      if (typeof parsed === "object" && parsed !== null) {
        const obj = parsed as Record<string, unknown>;
        if (typeof obj.logDir === "string") capturedLogDir = obj.logDir;
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

  if (typeof capturedLogDir === "string") {
    applyLogDir(capturedLogDir);
  }

  return cleanupSettings ?? defaultSettings();
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

  for (const file of files) {
    const filepath = path.join(captureDir, file);
    try {
      const stats = await fs.stat(filepath);
      if (stats.mtimeMs >= cutoff) continue;
      await fs.unlink(filepath);
      await fs.unlink(path.join(captureDir, metaFilenameFor(file))).catch(() => {});
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