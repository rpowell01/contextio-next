// Provider CRUD utilities backed by providers.json.
// Uses file locking for concurrent write safety.

import fs from "fs/promises";
import { z } from "zod";
import type { ProviderConfig, ProviderMetadata } from "../types/api.ts";

export const PROVIDERS_DIR = "/app/custom-policy";
export const PROVIDERS_FILE = "/app/custom-policy/providers.json";

export const ProviderConfigSchema = z.object({
  id: z.string().min(1, "Provider id is required"),
  name: z.string().min(1, "Provider name is required"),
  baseUrl: z.string().min(1, "Base URL is required"),
  models: z.array(z.string()),
});

const DEFAULT_PROVIDERS: Omit<ProviderMetadata, "source" | "dynamic">[] = [
  { id: "openai", name: "OpenAI", baseUrl: "https://api.openai.com", models: [] },
  {
    id: "anthropic",
    name: "Anthropic",
    baseUrl: "https://api.anthropic.com",
    models: [],
  },
  { id: "chatgpt", name: "ChatGPT", baseUrl: "https://chatgpt.com", models: [] },
  {
    id: "gemini",
    name: "Gemini",
    baseUrl: "https://generativelanguage.googleapis.com",
    models: [],
  },
  {
    id: "vertex",
    name: "Vertex AI",
    baseUrl: "https://us-central1-aiplatform.googleapis.com",
    models: [],
  },
  {
    id: "nvidia",
    name: "NVIDIA",
    baseUrl: "https://integrate.api.nvidia.com",
    models: [],
  },
  {
    id: "openrouter",
    name: "OpenRouter",
    baseUrl: "https://openrouter.ai/api",
    models: [],
  },
  {
    id: "kilo",
    name: "Kilo",
    baseUrl: "https://api.kilo.ai/api/gateway",
    models: [],
  },
];

const ENV_PROVIDER_MAP: Record<string, string> = {
  openai: "UPSTREAM_OPENAI_URL",
  anthropic: "UPSTREAM_ANTHROPIC_URL",
  chatgpt: "UPSTREAM_CHATGPT_URL",
  gemini: "UPSTREAM_GEMINI_URL",
  geminiCodeAssist: "UPSTREAM_GEMINI_CODE_ASSIST_URL",
  vertex: "UPSTREAM_VERTEX_URL",
  nvidia: "UPSTREAM_NVIDIA_URL",
  openrouter: "UPSTREAM_OPENROUTER_URL",
  kilo: "UPSTREAM_KILO_URL",
};

function getEnvProviders(): ProviderMetadata[] {
  const providers: ProviderMetadata[] = [];
  for (const [id, envVar] of Object.entries(ENV_PROVIDER_MAP)) {
    const url = process.env[envVar];
    if (url) {
      providers.push({
        id,
        name: id
          .replace(/([A-Z])/g, " $1")
          .replace(/^./, (s) => s.toUpperCase())
          .trim(),
        baseUrl: url.replace(/\/v1$/, ""),
        models: [],
        source: "env",
        dynamic: false,
      });
    }
  }
  return providers;
}

async function ensureProvidersFile(): Promise<void> {
  try {
    await fs.mkdir(PROVIDERS_DIR, { recursive: true });
  } catch {
    // ignore mkdir errors
  }
  try {
    const handle = await fs.open(PROVIDERS_FILE, "wx");
    await handle.writeFile("[]", "utf8");
    await handle.close();
  } catch (error) {
    const errno = error as NodeJS.ErrnoException;
    if (errno.code !== "EEXIST") {
      throw error;
    }
  }
}

async function readFileProviders(): Promise<ProviderConfig[]> {
  await ensureProvidersFile();
  try {
    const raw = await fs.readFile(PROVIDERS_FILE, "utf8");
    const parsed = JSON.parse(raw);
    if (!Array.isArray(parsed)) return [];
    return parsed
      .map((p: unknown) => {
        try {
          return ProviderConfigSchema.parse(p);
        } catch {
          return null;
        }
      })
      .filter((p): p is ProviderConfig => p !== null);
  } catch {
    return [];
  }
}

// Lock file format version - increment when changing the lock file structure
export const LOCK_FILE_VERSION = 2;

// Configurable stale lock threshold (ms). Default: 30s on Unix, 5min on Windows to account for PID reuse.
export function getStaleLockThresholdMs(): number {
  const envThreshold = process.env.STALE_LOCK_THRESHOLD_MS;
  if (envThreshold) {
    const parsed = parseInt(envThreshold, 10);
    if (!isNaN(parsed) && parsed > 0) {
      return parsed;
    }
  }
  // Default: 5 minutes on Windows (PID reuse is common), 30 seconds on Unix
  return process.platform === "win32" ? 300000 : 30000;
}
export async function withFileLock<T>(
  lockPath: string,
  fn: () => Promise<T>,
  retries = 5,
  delayMs = 100,
): Promise<T> {
  for (let attempt = 0; attempt < retries; attempt++) {
    let lockHandle: fs.FileHandle | null = null;
    let lockAcquired = false;
    try {
      lockHandle = await fs.open(lockPath, "wx");
      // Write PID, timestamp, and version to lock file for stale lock detection
      const lockInfo = JSON.stringify({ 
        pid: process.pid, 
        timestamp: Date.now(),
        version: LOCK_FILE_VERSION
      });
      await lockHandle.writeFile(lockInfo, "utf8");
      lockAcquired = true;
      const result = await fn();
      return result;
    } catch (error) {
      const errno = error as NodeJS.ErrnoException;
      if (errno.code === "EEXIST") {
        // Check if existing lock is stale
        const isStale = await checkStaleLock(lockPath);
        if (isStale) {
          // Re-read and re-validate immediately before unlink to close TOCTOU race window
          // Another process may have acquired the lock between checkStaleLock and here
          const currentLock = await fs.readFile(lockPath, "utf8").catch(() => null);
          if (currentLock !== null) {
            // File exists (even if empty/invalid) - re-check staleness and unlink if still stale
            if (await checkStaleLock(lockPath)) {
              await fs.unlink(lockPath).catch(() => {});
              continue;
            }
          } else {
            // Lock file disappeared, retry immediately
            continue;
          }
        }
        await new Promise((resolve) => setTimeout(resolve, delayMs));
        continue;
      }
      throw error;
    } finally {
      if (lockHandle && lockAcquired) {
        // Close handle first (ignore errors)
        try {
          await lockHandle.close();
        } catch {
          // ignore close errors
        }
        // Then attempt to unlink if we still own the lock
        // Separate try block ensures unlink runs even if close() threw
        try {
          // Only unlink if we still own the lock (PID matches)
          // This prevents race condition where another process acquired the lock after we removed a stale one
          // Re-read immediately before unlink to close TOCTOU race window
          const currentLock = await fs.readFile(lockPath, "utf8").catch(() => null);
          if (currentLock) {
            const lockInfo = JSON.parse(currentLock);
            if (lockInfo.pid === process.pid) {
              await fs.unlink(lockPath).catch(() => {});
            }
          }
        } catch {
          // ignore cleanup errors
        }
      }
    }
  }
  throw new Error(`Failed to acquire file lock after ${retries} retries`);
}

export async function checkStaleLock(lockPath: string): Promise<boolean> {
  try {
    const lockContent = await fs.readFile(lockPath, "utf8");
    
    // Empty or whitespace-only lock file -> treat as stale
    if (!lockContent.trim()) {
      return true;
    }
    
    let lockInfo: { pid?: number; timestamp?: number; version?: number };
    try {
      lockInfo = JSON.parse(lockContent);
    } catch {
      // Invalid JSON -> treat as stale (corrupted/old format)
      return true;
    }
    
    // Old format (version 1 or missing) -> treat as stale to force upgrade
    if (!lockInfo.version || lockInfo.version < LOCK_FILE_VERSION) {
      return true;
    }
    
    const staleThresholdMs = getStaleLockThresholdMs();
    
    // Check if the owning process is still alive
    if (lockInfo.pid) {
      try {
        // process.kill(pid, 0) throws if process doesn't exist
        // On Windows, this may not work reliably, so we handle EPERM as inconclusive
        process.kill(lockInfo.pid, 0);
        // Process confirmed alive -> NOT stale, regardless of timestamp age
        // (fn() may legitimately take > threshold)
        return false;
      } catch (err) {
        // Process doesn't exist (ESRCH) or permission denied (EPERM)
        // If ESRCH, process is dead -> stale lock
        // If EPERM, process exists but we can't signal -> inconclusive, fall through to timestamp check
        const errno = err as NodeJS.ErrnoException;
        if (errno.code === "ESRCH") {
          return true; // Stale: process dead
        }
        // EPERM or other -> inconclusive, fall through to timestamp check
      }
    }
    
    // No PID in lock file, or liveness check inconclusive (EPERM):
    // use timestamp fallback (> configured threshold)
    if (lockInfo.timestamp && Date.now() - lockInfo.timestamp > staleThresholdMs) {
      return true;
    }
    
    // Can't determine, assume not stale to be safe
    return false;
  } catch {
    // Can't read lock file (ENOENT, EACCES, etc.), assume not stale
    return false;
  }
}



/**
 * Executes a read-modify-write operation on providers.json atomically within a file lock.
 * The callback receives the current providers array and should return the modified array.
 */
async function withProvidersLock<T>(
  fn: (providers: ProviderConfig[]) => Promise<{ providers: ProviderConfig[]; result: T }>
): Promise<T> {
  const lockPath = `${PROVIDERS_FILE}.lock`;

  return withFileLock(lockPath, async () => {
    // Read inside the lock
    const providers = await readFileProviders();
    // Execute the callback with the current providers
    const { providers: newProviders, result } = await fn(providers);
    // Write inside the lock
    const tmpPath = `${PROVIDERS_FILE}.tmp`;
    await fs.unlink(tmpPath).catch(() => {});

    const tmpHandle = await fs.open(tmpPath, "wx");
    await tmpHandle.writeFile(JSON.stringify(newProviders, null, 2), "utf8");
    await tmpHandle.datasync();
    await tmpHandle.close();

    await fs.rename(tmpPath, PROVIDERS_FILE);

    // Best-effort fsync of the directory to persist the rename
    try {
      const dirHandle = await fs.open(PROVIDERS_DIR, "r+");
      await dirHandle.datasync();
      await dirHandle.close();
    } catch {
      // directory fsync is best-effort
    }

    return result;
  });
}

export async function getAllProviders(): Promise<ProviderMetadata[]> {
  const [fileProviders, envProviders] = await Promise.all([
    readFileProviders(),
    Promise.resolve(getEnvProviders()),
  ]);

  const merged = new Map<string, ProviderMetadata>();

  for (const p of DEFAULT_PROVIDERS) {
    merged.set(p.id, { ...p, source: "default", dynamic: false });
  }
  for (const p of envProviders) {
    merged.set(p.id, p);
  }
  for (const p of fileProviders) {
    merged.set(p.id, { ...p, source: "file", dynamic: true });
  }

  return Array.from(merged.values());
}

export async function getProviderById(id: string): Promise<ProviderMetadata | null> {
  const all = await getAllProviders();
  return all.find((p) => p.id === id) ?? null;
}

export async function createProvider(config: ProviderConfig): Promise<ProviderMetadata> {
  const validated = ProviderConfigSchema.parse(config);

  const result = await withProvidersLock(async (providers) => {
    if (providers.some((p) => p.id === validated.id)) {
      throw new Error(`Provider with id "${validated.id}" already exists in file`);
    }

    const newProviders = [...providers, validated];
    return { providers: newProviders, result: { ...validated, source: "file" as const, dynamic: true } };
  });

  return result;
}

export async function updateProvider(id: string, config: ProviderConfig): Promise<ProviderMetadata> {
  const validated = ProviderConfigSchema.parse(config);

  if (validated.id !== id) {
    throw new Error(`Provider id in URL (${id}) does not match id in body (${validated.id})`);
  }

  const result = await withProvidersLock(async (providers) => {
    const index = providers.findIndex((p) => p.id === id);

    if (index === -1) {
      throw new Error(`Provider with id "${id}" not found in file`);
    }

    const newProviders = [...providers];
    newProviders[index] = validated;
    return { providers: newProviders, result: { ...validated, source: "file" as const, dynamic: true } };
  });

  return result;
}

export async function deleteProvider(id: string): Promise<void> {
  await withProvidersLock(async (providers) => {
    const filtered = providers.filter((p) => p.id !== id);

    if (filtered.length === providers.length) {
      throw new Error(`Provider with id "${id}" not found in file`);
    }

    return { providers: filtered, result: undefined };
  });
}
