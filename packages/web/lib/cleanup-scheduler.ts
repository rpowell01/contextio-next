import { applyLogDir, getCaptureDir, listCaptureFiles, metaFilenameFor } from "@/lib/sessions/utils";
import { DEFAULT_SETTINGS } from "@/lib/settings";
import { ensureSettingsFile, readSettingsFile } from "@/lib/node-utils";

let cleanupTimer: NodeJS.Timeout | null = null;
let schedulerStarted = false;

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
  
  // Dynamic require for Node.js built-ins - only runs on server
  const fs = await import("node:fs/promises");
  const path = await import("node:path");
  
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
  cleanupTimer.unref();
  runWithCatch();

  return cleanupTimer;
}