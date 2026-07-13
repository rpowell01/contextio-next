import { NextRequest, NextResponse } from "next/server";

import type { Settings } from "@/lib/settings";
import { DEFAULT_SETTINGS, validateSettingsLenient, mergeWithDefaults, getSettingMetadata, applyEnvOverrides } from "@/lib/settings";
import { applyLogDir } from "@/lib/sessions/utils";
import { consumeToken } from "@/lib/csrf";

async function ensureSettingsFile(): Promise<void> {
  const { ensureSettingsFile: ensureFile } = await import("@/lib/node-utils");
  await ensureFile(DEFAULT_SETTINGS);
}

async function getNodeUtils() {
  return import("@/lib/node-utils");
}

export async function GET(): Promise<NextResponse> {
  try {
    await ensureSettingsFile();
    const { readSettingsFile } = await getNodeUtils();
    const data = await readSettingsFile();
  if (!data) {
    return NextResponse.json({ settings: DEFAULT_SETTINGS, metadata: getSettingMetadata(DEFAULT_SETTINGS, new Set()) });
  }
  const parsed = JSON.parse(data);
  if (typeof parsed !== "object" || parsed === null) {
    return NextResponse.json({ settings: DEFAULT_SETTINGS, metadata: getSettingMetadata(DEFAULT_SETTINGS, new Set()) });
  }
    // Lenient per-field validation with defaults fallback - never fail the whole request
    const settings = validateSettingsLenient(parsed);
    const { settings: effectiveSettings, appliedKeys } = applyEnvOverrides(settings);
    applyLogDir(effectiveSettings.logDir);
    return NextResponse.json({ settings: effectiveSettings, metadata: getSettingMetadata(effectiveSettings, appliedKeys) });
  } catch (error) {
  console.error("Error reading settings:", error);
  return NextResponse.json({ settings: DEFAULT_SETTINGS, metadata: getSettingMetadata(DEFAULT_SETTINGS, new Set<keyof Settings>()) });
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
    const { writeSettingsFile } = await getNodeUtils();
    await writeSettingsFile(settings);

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