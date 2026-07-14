// Node.js-only utilities - this file should only be imported in Node.js runtime
// Next.js will not bundle this for edge runtime due to Node.js built-ins

async function getNodeModules(): Promise<{
  fs: typeof import("fs/promises");
  path: { join: typeof import("path").join };
}> {
  const [fs, path] = await Promise.all([
    import("fs/promises"),
    import("path"),
  ]);
  return {
    fs,
    path: { join: path.join },
  };
}

const SETTINGS_DIR = "/app/custom-policy";
const SETTINGS_FILE = "/app/custom-policy/settings.json";

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
  const { fs, path } = await getNodeModules();

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
  const { fs, path } = await getNodeModules();
  try {
    await fs.mkdir(SETTINGS_DIR, { recursive: true });
    await fs.access(SETTINGS_FILE);
  } catch {
    await fs.writeFile(SETTINGS_FILE, JSON.stringify(defaultSettings, null, 2));
  }
}

export async function readSettingsFile(): Promise<string | null> {
  const { fs } = await getNodeModules();
  try {
    return await fs.readFile(SETTINGS_FILE, "utf8");
  } catch {
    return null;
  }
}

export async function writeSettingsFile(settings: unknown): Promise<void> {
  const { fs } = await getNodeModules();
  await fs.writeFile(SETTINGS_FILE, JSON.stringify(settings, null, 2));
}