// Server-only settings utilities.
// Uses Node.js built-ins (fs, path, os) - not for client bundling.

import { homedir } from "os";
import { join } from "path";
import { promises as fs } from "fs";

const SETTINGS_DIR = "/app/custom-policy";
const SETTINGS_FILE = "/app/custom-policy/settings.json";

/** @deprecated Use database-backed settings via @contextio/core/db instead */
export async function getSettingsFilePath(): Promise<string> {
  return SETTINGS_FILE;
}

export async function getSettingsDir(): Promise<string> {
  return SETTINGS_DIR;
}

export async function getDefaultCaptureDir(): Promise<string> {
  return join(homedir(), ".contextio", "captures");
}

/** @deprecated Use database-backed settings via @contextio/core/db instead */
export async function applyPersistedSettings(applyLogDir: (dir: string) => void): Promise<void> {
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

/** @deprecated Use database-backed settings via @contextio/core/db instead */
export async function ensureSettingsFile(defaultSettings: unknown): Promise<void> {
  try {
    await fs.mkdir(SETTINGS_DIR, { recursive: true });
    await fs.access(SETTINGS_FILE);
  } catch {
    await fs.writeFile(SETTINGS_FILE, JSON.stringify(defaultSettings, null, 2));
  }
}

/** @deprecated Use database-backed settings via @contextio/core/db instead */
export async function readSettingsFile(): Promise<string | null> {
  try {
    return await fs.readFile(SETTINGS_FILE, "utf8");
  } catch {
    return null;
  }
}

/** @deprecated Use database-backed settings via @contextio/core/db instead */
export async function writeSettingsFile(settings: unknown): Promise<void> {
  await fs.writeFile(SETTINGS_FILE, JSON.stringify(settings, null, 2));
 }

// OIDC settings interface for server-side use
export interface OidcSettings {
  oidcEnabled: boolean;
  oidcPublicUrl: string | null;
}

/** @deprecated Use database-backed settings via @contextio/core/db instead */
export async function getOidcSettings(): Promise<OidcSettings> {
  try {
    const { getSettings } = await import("@contextio/core/db");
    const settings = getSettings();
    if (settings) {
      return {
        oidcEnabled: settings.oidcEnabled,
        oidcPublicUrl: settings.oidcPublicUrl,
      };
    }
  } catch {
    // Ignore settings read errors
  }
  return { oidcEnabled: false, oidcPublicUrl: null };
 }