async function applyPersistedSettings(): Promise<void> {
  // Dynamic imports for Node.js only
  const { homedir } = await import("os");
  const fs = await import("fs/promises");
  const { join } = await import("path");
  const { applyLogDir } = await import("@/lib/sessions/utils");
  
  const SETTINGS_FILE = join(homedir(), ".contextio-next", "settings.json");
  
  try {
    const raw = await fs.readFile(SETTINGS_FILE, "utf8");
    const parsed = JSON.parse(raw);
    if (typeof parsed === "object" && parsed !== null) {
      const obj = parsed as Record<string, unknown>;
      if (typeof obj.logDir === "string") {
        applyLogDir(obj.logDir);
      }
    }
  } catch {
    // Ignore settings read errors
  }
}

function validateCsrfSecret(): void {
  if (process.env.NODE_ENV === "production") {
    if (!process.env.CSRF_SECRET) {
      throw new Error("CSRF_SECRET environment variable is required in production");
    }
  }
}

export async function register(): Promise<void> {
  // Validate CSRF secret in ALL runtimes (including Edge) before middleware runs
  validateCsrfSecret();

  // Validate CSRF secret before any middleware runs
  validateCsrfSecret();

  // Apply persisted settings at server startup
  await applyPersistedSettings();

  // Start the capture cleanup scheduler
  const { startCleanupScheduler } = await import("@/lib/cleanup-scheduler");
  await startCleanupScheduler();
}