import { NextRequest, NextResponse } from "next/server";
import fs from "node:fs/promises";
import { join } from "node:path";
import { homedir } from "node:os";

import { DEFAULT_SETTINGS, validateSettings, mergeWithDefaults } from "@/lib/settings";
import { applyLogDir } from "@/lib/sessions/utils";

const SETTINGS_FILE = join(homedir(), ".contextio-next", "settings.json");

async function ensureSettingsFile(): Promise<void> {
  const dir = join(homedir(), ".contextio-next");
  try {
    await fs.mkdir(dir, { recursive: true });
    await fs.access(SETTINGS_FILE);
  } catch {
    await fs.writeFile(SETTINGS_FILE, JSON.stringify(DEFAULT_SETTINGS, null, 2));
  }
}

export async function GET(): Promise<NextResponse> {
  try {
    await ensureSettingsFile();
    const data = await fs.readFile(SETTINGS_FILE, "utf8");
    const parsed = JSON.parse(data);
    if (typeof parsed !== "object" || parsed === null) {
      return NextResponse.json({ settings: DEFAULT_SETTINGS });
    }
    // Per-field validation with defaults fallback - never fail the whole request
    const obj = parsed as Record<string, unknown>;
  const settings = {
    logDir: validateField(obj, "logDir", (v) => {
      if (typeof v !== "string" || !v.length) throw new Error("invalid");
      return v;
    }),
    maxSessions: validateField(obj, "maxSessions", (v) => {
      if (typeof v !== "number" || !Number.isInteger(v) || v < 0 || v > 10000) throw new Error("invalid");
      return v;
    }),
    redactPreset: validateField(obj, "redactPreset", (v) => {
      if (typeof v !== "string" || !["secrets", "pii", "strict"].includes(v)) throw new Error("invalid");
      return v as "secrets" | "pii" | "strict";
    }),
    redactReversible: validateField(obj, "redactReversible", (v) => {
      if (typeof v !== "boolean") throw new Error("invalid");
      return v;
    }),
    captureCleanupEnabled: validateField(obj, "captureCleanupEnabled", (v) => {
      if (typeof v !== "boolean") throw new Error("invalid");
      return v;
    }),
    captureCleanupIntervalHours: validateField(obj, "captureCleanupIntervalHours", (v) => {
      if (typeof v !== "number" || !Number.isInteger(v) || v < 1 || v > 168) throw new Error("invalid");
      return v;
    }),
    captureCleanupMaxAgeDays: validateField(obj, "captureCleanupMaxAgeDays", (v) => {
      if (typeof v !== "number" || !Number.isInteger(v) || v < 1 || v > 365) throw new Error("invalid");
      return v;
    }),
  };
  applyLogDir(settings.logDir);
  return NextResponse.json({ settings });
  } catch (error) {
    console.error("Error reading settings:", error);
    return NextResponse.json({ settings: DEFAULT_SETTINGS });
  }
}

export async function POST(request: NextRequest): Promise<NextResponse> {
  try {
    const body = await request.json();
    // Validate the incoming settings
    const validated = validateSettings(body);
    // Merge with defaults for any missing fields
    const settings = mergeWithDefaults(validated);

    await ensureSettingsFile();
    await fs.writeFile(SETTINGS_FILE, JSON.stringify(settings, null, 2));
    applyLogDir(settings.logDir);

    return NextResponse.json({ success: true, settings });
  } catch (error) {
    console.error("Error saving settings:", error);
    const message = error instanceof Error ? error.message : "Failed to save settings";
    return NextResponse.json(
      { error: message },
      { status: 400 }
    );
  }
}