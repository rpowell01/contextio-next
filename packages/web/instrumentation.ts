async function applyPersistedSettings(): Promise<void> {
  // Dynamic import to avoid bundling Node.js modules in edge runtime
  const { applyPersistedSettings: applySettingsNode } = await import("@/lib/node-utils");
  await applySettingsNode(applyLogDir);
}

function validateCsrfSecret(): void {
  if (process.env.NODE_ENV === "production") {
    if (!process.env.CSRF_SECRET) {
      throw new Error("CSRF_SECRET environment variable is required in production");
    }
  }
}

// Use Node.js runtime for instrumentation to support Node.js built-ins (crypto, fs, etc.)
export const runtime = "nodejs";

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

import { applyLogDir } from "@/lib/capture-dir";