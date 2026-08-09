import { NextRequest, NextResponse } from "next/server";

import type { Settings } from "@/lib/settings";
import { DEFAULT_SETTINGS, validateSettingsLenient, mergeWithDefaults, applyEnvOverrides, getSettingMetadata } from "@/lib/settings";
import { applyLogDir } from "@/lib/sessions/server-utils";
import { consumeToken } from "@/lib/csrf";
import { createErrorResponse, createSuccessResponse } from "@contextio/core";
import { getSettingsWithMeta, upsertSettings, getSettings } from "@contextio/core/db";

// Ensure database is initialized before any operation
function ensureDbInitialized(): void {
  // The database is initialized at startup via instrumentation.ts
  // This is a no-op if already initialized
  getSettings(); // This will trigger lazy initialization if needed
}

export async function GET(): Promise<NextResponse> {
  try {
    // Ensure database is initialized
    ensureDbInitialized();

    // Single DB read - get raw settings from database
    const dbSettings = getSettings() ?? DEFAULT_SETTINGS;

    // Apply environment variable overrides to determine which keys are env-controlled
    const { settings: effectiveSettings, appliedKeys } = applyEnvOverrides(dbSettings);
    applyLogDir(effectiveSettings.logDir);

    // Get metadata using pure function (no DB read) with applied env keys for accurate source tracking
    const metadata = getSettingMetadata(effectiveSettings, appliedKeys);

    return NextResponse.json(createSuccessResponse({ settings: effectiveSettings, metadata }));
  } catch (error) {
    console.error("Error reading settings:", error);
    // Use pure function for metadata to avoid database I/O in error handler
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
    
    // Ensure database is initialized
    ensureDbInitialized();
    
    // Validate the incoming settings (lenient - never fail the whole request)
    const validated = validateSettingsLenient(body);
    // Merge with defaults for any missing fields
    const settings = mergeWithDefaults(validated);

    // Apply env overrides to determine which keys are controlled by env vars
    const { appliedKeys } = applyEnvOverrides(settings);

    // Remove env-var-overridden keys from settings before saving to database.
    // Environment variables should ALWAYS take precedence at runtime, so we don't
    // persist their values to the settings. This ensures that if an env var
    // is removed, the setting falls back to the default or database value.
    const settingsToPersist = { ...settings };
    for (const key of appliedKeys) {
      delete settingsToPersist[key];
    }

    // Persist to SQLite database
    upsertSettings(settingsToPersist);

    // Re-apply env overrides for the response to show effective values
    const { settings: effectiveSettings, appliedKeys: responseAppliedKeys } = applyEnvOverrides(settingsToPersist);
    applyLogDir(effectiveSettings.logDir);
    
    // Get metadata with applied env keys for consistent source tracking
    const { meta: metadata } = getSettingsWithMeta(responseAppliedKeys);
    
    return NextResponse.json(createSuccessResponse({ success: true, settings: effectiveSettings, metadata }));
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