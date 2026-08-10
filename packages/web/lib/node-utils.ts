// Node.js-only utilities - this file should only be imported in Node.js runtime
// Next.js will not bundle this for edge runtime due to Node.js built-ins

async function getNodeModules(): Promise<{
  fs: typeof import("fs/promises");
  path: { join: typeof import("path").join };
  os: { homedir: typeof import("os").homedir };
}> {
  const [fs, path, os] = await Promise.all([
    import("fs/promises"),
    import("path"),
    import("os"),
  ]);
  return {
    fs,
    path: { join: path.join },
    os: { homedir: os.homedir },
  };
}

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
  const { path, os } = await getNodeModules();
  return path.join(os.homedir(), ".contextio", "captures");
}

export async function applyPersistedSettings(applyLogDir: (dir: string) => void): Promise<void> {
  // Read settings from SQLite database instead of JSON file
  try {
    const { getSettingsWithMeta } = await import("@contextio/core/db");
    const { settings } = getSettingsWithMeta();
    if (settings && typeof settings.logDir === "string") {
      applyLogDir(settings.logDir);
    }
  } catch {
    // Ignore settings read errors - fall back to defaults
  }
}