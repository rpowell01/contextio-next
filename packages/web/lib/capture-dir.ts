// Capture directory utilities - no logger dependency
// This module can be safely imported in instrumentation hooks

// Allow override via environment variable (used in Docker environments)
// Falls back to default ~/.contextio/captures for local development
let _captureDir: string | undefined;

// Import Node.js built-ins dynamically inside functions to avoid bundling issues
export async function getHomedir(): Promise<string> {
  const { homedir } = await import("node:os");
  return homedir();
}

export function getNodeUtils(): Promise<{
  fs: typeof import("node:fs/promises");
  path: { join: typeof import("node:path").join; resolve: typeof import("node:path").resolve };
}> {
  return Promise.all([
    import("node:fs/promises"),
    import("node:path"),
  ]).then(([fs, path]) => ({
    fs,
    path: { join: path.join, resolve: path.resolve },
  }));
}

/** Read the capture directory currently in effect. */
export async function getCaptureDir(): Promise<string> {
  if (!_captureDir) {
    const home = await getHomedir();
    _captureDir = process.env.LOGGER_CAPTURE_DIR || `${home}/.contextio/captures`;
    CAPTURE_DIR = _captureDir;
  }
  return _captureDir;
}

/** Update the capture directory seen by all server-side helpers. */
export function setCaptureDir(dir: string): void {
  _captureDir = dir;
  // Keep the deprecated re-export in sync for external callers
  CAPTURE_DIR = dir;
}

/** @deprecated Use `getCaptureDir()` — live ESM binding kept for external
 *  callers that haven't migrated. Internal code should call `getCaptureDir()`
 *  directly to avoid relying on live-binding propagation quirks. */
export let CAPTURE_DIR: string;

/** Canonical `logDir` → absolute capture-directory resolver. */
export async function resolveLogDir(logDir: string): Promise<string> {
  const { path } = await getNodeUtils();
  const trimmed = logDir.trim();
  if (!trimmed) {
    const home = await getHomedir();
    return process.env.LOGGER_CAPTURE_DIR || `${home}/.contextio/captures`;
  }
  if (trimmed === "~") return await getHomedir();
  if (trimmed.startsWith("~/")) return path.join(await getHomedir(), trimmed.slice(2));
  if (trimmed.startsWith("/")) return trimmed;
  return path.resolve(process.cwd(), trimmed);
}

/** Resolve and apply a Settings `logDir` value as the active capture directory. */
export async function applyLogDir(logDir: string): Promise<void> {
  const resolved = await resolveLogDir(logDir);
  setCaptureDir(resolved);
}