// Server-only settings utilities.
// Uses Node.js built-ins (fs, path, os) - not for client bundling.

import { homedir } from "os";
import { join } from "path";
import { promises as fs } from "fs";

const SETTINGS_DIR = "/app/custom-policy";
const SETTINGS_FILE = "/app/custom-policy/settings.json";

export async function getSettingsFilePath(): Promise<string> {
  return SETTINGS_FILE;
}

export async function getSettingsDir(): Promise<string> {
  return SETTINGS_DIR;
}

export async function getDefaultCaptureDir(): Promise<string> {
  return join(homedir(), ".contextio", "captures");
}

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

export async function ensureSettingsFile(defaultSettings: unknown): Promise<void> {
  try {
    await fs.mkdir(SETTINGS_DIR, { recursive: true });
    await fs.access(SETTINGS_FILE);
  } catch {
    await fs.writeFile(SETTINGS_FILE, JSON.stringify(defaultSettings, null, 2));
  }
}

export async function readSettingsFile(): Promise<string | null> {
  try {
    return await fs.readFile(SETTINGS_FILE, "utf8");
  } catch {
    return null;
  }
}

export async function writeSettingsFile(settings: unknown): Promise<void> {
  await fs.writeFile(SETTINGS_FILE, JSON.stringify(settings, null, 2));
}