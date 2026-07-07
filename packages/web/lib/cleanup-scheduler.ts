import fs from "node:fs/promises";
import { join } from "node:path";

import { applyLogDir, getCaptureDir, listCaptureFiles, metaFilenameFor } from "@/lib/sessions/utils";
import { DEFAULT_SETTINGS } from "@/lib/settings";

const SETTINGS_FILE = join(process.env.HOME ?? "~/.contextio-next", ".contextio-next", "settings.json");

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
    const raw = await fs.readFile(SETTINGS_FILE, "utf8");
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
  } catch {
    // ignore settings read errors; fall back to cleanup defaults below
  }

  if (typeof capturedLogDir === "string") {
    applyLogDir(capturedLogDir);
  }

  return cleanupSettings ?? defaultSettings();
}

async function runCleanup(): Promise<void> {
  const settings = await loadSettings();
  if (!settings.enabled || settings.maxAgeDays <= 0) return;
  const cutoff = Date.now() - settings.maxAgeDays * 24 * 60 * 60 * 1000;
  const files = await listCaptureFiles();
  const captureDir = getCaptureDir();
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
