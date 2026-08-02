import { NextRequest, NextResponse } from "next/server";

import type { Settings } from "@/lib/settings";
import { DEFAULT_SETTINGS, validateSettingsLenient, mergeWithDefaults, getSettingMetadata, applyEnvOverrides } from "@/lib/settings";
import { applyLogDir } from "@/lib/sessions/server-utils";
import { consumeToken } from "@/lib/csrf";
import { createErrorResponse, createSuccessResponse } from "@contextio/core";

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
    return NextResponse.json(createSuccessResponse({ settings: DEFAULT_SETTINGS, metadata: getSettingMetadata(DEFAULT_SETTINGS, new Set()) }));
  }
  const parsed = JSON.parse(data);
  if (typeof parsed !== "object" || parsed === null) {
    return NextResponse.json(createSuccessResponse({ settings: DEFAULT_SETTINGS, metadata: getSettingMetadata(DEFAULT_SETTINGS, new Set()) }));
  }
    // Lenient per-field validation with defaults fallback - never fail the whole request
    const settings = validateSettingsLenient(parsed);
    const { settings: effectiveSettings, appliedKeys } = applyEnvOverrides(settings);
    applyLogDir(effectiveSettings.logDir);
    return NextResponse.json(createSuccessResponse({ settings: effectiveSettings, metadata: getSettingMetadata(effectiveSettings, appliedKeys) }));
  } catch (error) {
  console.error("Error reading settings:", error);
  return NextResponse.json(createSuccessResponse({ settings: DEFAULT_SETTINGS, metadata: getSettingMetadata(DEFAULT_SETTINGS, new Set<keyof Settings>()) }));
}
}

export async function POST(request: NextRequest): Promise<NextResponse> {
  try {
    const csrfToken = request.headers.get("x-csrf-token");
    if (!(await consumeToken(csrfToken ?? ""))) {
      return NextResponse.json(createErrorResponse({ message: "Invalid or missing CSRF token", status: 400 }), { status: 400 });
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
    return NextResponse.json(createSuccessResponse({ success: true, settings: effectiveSettings, metadata: getSettingMetadata(effectiveSettings, appliedKeys) }));
  } catch (error) {
    const errorMessage = error instanceof Error ? error.message : String(error);
    const errorStack = error instanceof Error ? error.stack : undefined;
    const errorCode = (error as NodeJS.ErrnoException)?.code;
    const errorErrno = (error as NodeJS.ErrnoException)?.errno;
    const errorSyscall = (error as NodeJS.ErrnoException)?.syscall;
    const errorPath = (error as NodeJS.ErrnoException)?.path;
    console.error("Failed to save settings:", error);
    return NextResponse.json(
      createErrorResponse({ 
        message: "Failed to save settings", 
        status: 500, 
        details: errorMessage, 
        stack: errorStack,
        code: errorCode,
        errno: errorErrno,
        syscall: errorSyscall,
        path: errorPath
      }),
      { status: 500 }
    );
  }
}