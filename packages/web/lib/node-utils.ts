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

export async function getSettingsFilePath(): Promise<string> {
  const { path, os } = await getNodeModules();
  return path.join(os.homedir(), ".contextio-next", "settings.json");
}

export async function getSettingsDir(): Promise<string> {
  const { path, os } = await getNodeModules();
  return path.join(os.homedir(), ".contextio-next");
}

export async function getDefaultCaptureDir(): Promise<string> {
  const { path, os } = await getNodeModules();
  return path.join(os.homedir(), ".contextio", "captures");
}

export async function applyPersistedSettings(applyLogDir: (dir: string) => void): Promise<void> {
  const { fs, path, os } = await getNodeModules();
  const SETTINGS_FILE = path.join(os.homedir(), ".contextio-next", "settings.json");

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
  const { fs, path, os } = await getNodeModules();
  const dir = path.join(os.homedir(), ".contextio-next");
  const SETTINGS_FILE = path.join(dir, "settings.json");
  try {
    await fs.mkdir(dir, { recursive: true });
    await fs.access(SETTINGS_FILE);
  } catch {
    await fs.writeFile(SETTINGS_FILE, JSON.stringify(defaultSettings, null, 2));
  }
}

export async function readSettingsFile(): Promise<string | null> {
  const { fs, path, os } = await getNodeModules();
  const SETTINGS_FILE = path.join(os.homedir(), ".contextio-next", "settings.json");
  try {
    return await fs.readFile(SETTINGS_FILE, "utf8");
  } catch {
    return null;
  }
}

export async function writeSettingsFile(settings: unknown): Promise<void> {
  const { fs, path, os } = await getNodeModules();
  const SETTINGS_FILE = path.join(os.homedir(), ".contextio-next", "settings.json");
  await fs.writeFile(SETTINGS_FILE, JSON.stringify(settings, null, 2));
}