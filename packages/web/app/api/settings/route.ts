import { NextRequest, NextResponse } from "next/server";
import fs from "fs/promises";
import { join } from "path";
import { homedir } from "os";

import { DEFAULT_SETTINGS, validateSettingsLenient, mergeWithDefaults, getSettingMetadata, applyEnvOverrides } from "@/lib/settings";
import { applyLogDir } from "@/lib/sessions/utils";
import { consumeToken } from "@/lib/csrf";

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
      return NextResponse.json({ settings: DEFAULT_SETTINGS, metadata: getSettingMetadata(DEFAULT_SETTINGS) });
    }
  // Lenient per-field validation with defaults fallback - never fail the whole request
  const settings = validateSettingsLenient(parsed);
  const { settings: effectiveSettings, appliedKeys } = applyEnvOverrides(settings);
  applyLogDir(effectiveSettings.logDir);
  return NextResponse.json({ settings: effectiveSettings, metadata: getSettingMetadata(effectiveSettings, appliedKeys) });
  } catch (error) {
    console.error("Error reading settings:", error);
    return NextResponse.json({ settings: DEFAULT_SETTINGS, metadata: getSettingMetadata(DEFAULT_SETTINGS) });
  }
}

export async function POST(request: NextRequest): Promise<NextResponse> {
  try {
    const csrfToken = request.headers.get("x-csrf-token");
    if (!(await consumeToken(csrfToken ?? ""))) {
      return NextResponse.json({ error: "Invalid or missing CSRF token" }, { status: 400 });
    }
    const body = await request.json();
  // Validate the incoming settings
  const validated = validateSettingsLenient(body);
  // Merge with defaults for any missing fields
  const settings = mergeWithDefaults(validated);

  await ensureSettingsFile();
  await fs.writeFile(SETTINGS_FILE, JSON.stringify(settings, null, 2));

  const { settings: effectiveSettings, appliedKeys } = applyEnvOverrides(settings);
  applyLogDir(effectiveSettings.logDir);
  return NextResponse.json({ success: true, settings: effectiveSettings, metadata: getSettingMetadata(effectiveSettings, appliedKeys) });
  } catch (error) {
    console.error("Error saving settings:", error);
    const message = error instanceof Error ? error.message : "Failed to save settings";
    return NextResponse.json(
      { error: message },
      { status: 400 }
    );
  }
}