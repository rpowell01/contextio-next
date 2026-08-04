// Provider CRUD utilities backed by providers.json.
// Uses file locking for concurrent write safety.

import fs from "fs/promises";
import { z } from "zod";
import type { ProviderConfig as CoreProviderConfig, Provider, ApiFormat, AuthType } from "@contextio/core";
import { KNOWN_API_FORMATS, KNOWN_AUTH_TYPES, validateProviderConfig } from "@contextio/core";
import type { ProviderMetadata } from "../types/api.ts";

export const PROVIDERS_DIR = "/app/custom-policy";
export const PROVIDERS_FILE = "/app/custom-policy/providers.json";

// Web UI schema for provider creation/editing (subset of full ProviderConfig)
export const ProviderConfigSchema = z.object({
  id: z.string().min(1, "Provider id is required"),
  name: z.string().min(1, "Provider name is required"),
  baseUrl: z.string().min(1, "Base URL is required"),
  models: z.array(z.string()),
  allowBaseUrlOverride: z.boolean().default(true),
  baseUrlOverrideHeader: z.string().min(1, "Base URL override header is required").optional(),
  // Proxy-specific fields (optional in web UI, preserved from existing config)
  apiFormat: z.enum(KNOWN_API_FORMATS as unknown as [ApiFormat, ...ApiFormat[]]).optional(),
  authType: z.enum(KNOWN_AUTH_TYPES as unknown as [AuthType, ...AuthType[]]).optional(),
  enabled: z.boolean().optional(),
  rateLimit: z.object({
    maxRequests: z.number().int().min(1).max(10000),
    windowMs: z.number().int().min(100).max(24 * 60 * 60 * 1000),
    bufferCapacity: z.number().int().min(0).max(10000),
  }).optional(),
  retry: z.object({
    maxRetries: z.number().int().min(0),
    baseDelayMs: z.number().int().min(0),
    maxDelayMs: z.number().int().min(0),
    retryableStatuses: z.array(z.number().int().min(100).max(599)),
    jitterFactor: z.number().min(0).max(1),
  }).optional(),
  customHeaders: z.record(z.string()).optional(),
});

export type ProviderConfigInput = z.input<typeof ProviderConfigSchema>;
export type ProviderConfigOutput = z.output<typeof ProviderConfigSchema>;

// Map web UI field names to core field names
function toCoreProviderConfig(input: ProviderConfigOutput, existing?: CoreProviderConfig & { models?: string[] }): CoreProviderConfig & { models?: string[] } {
  const coreConfig: CoreProviderConfig & { models?: string[] } = {
    id: input.id as Provider,
    name: input.name,
    upstreamUrl: input.baseUrl,
    apiFormat: input.apiFormat ?? existing?.apiFormat ?? "unknown",
    authType: input.authType ?? existing?.authType ?? "none",
    enabled: input.enabled ?? existing?.enabled ?? true,
    rateLimit: input.rateLimit ?? existing?.rateLimit ?? { maxRequests: 60, windowMs: 60000, bufferCapacity: 10 },
    retry: input.retry ?? existing?.retry ?? { maxRetries: 3, baseDelayMs: 1000, maxDelayMs: 30000, retryableStatuses: [429, 500, 502, 503, 504], jitterFactor: 0.2 },
    customHeaders: input.customHeaders ?? existing?.customHeaders ?? {},
    allowBaseUrlOverride: input.allowBaseUrlOverride ?? existing?.allowBaseUrlOverride ?? true,
    baseUrlOverrideHeader: input.baseUrlOverrideHeader ?? existing?.baseUrlOverrideHeader ?? `x-${input.id}-baseurl`,
  };
  if (input.models !== undefined) {
    coreConfig.models = input.models;
  } else if (existing?.models !== undefined) {
    coreConfig.models = existing.models;
  }
  return coreConfig;
}

function fromCoreProviderConfig(core: CoreProviderConfig & { models?: string[] }): ProviderConfigOutput {
  return {
    id: core.id,
    name: core.name,
    baseUrl: core.upstreamUrl,
    models: core.models ?? [],
    allowBaseUrlOverride: core.allowBaseUrlOverride,
    baseUrlOverrideHeader: core.baseUrlOverrideHeader,
    apiFormat: core.apiFormat,
    authType: core.authType,
    enabled: core.enabled,
    rateLimit: core.rateLimit,
    retry: core.retry,
    customHeaders: core.customHeaders,
  };
}

const DEFAULT_PROVIDERS: Omit<ProviderMetadata, "source" | "dynamic">[] = [
  { id: "openai", name: "OpenAI", baseUrl: "https://api.openai.com", models: [], allowBaseUrlOverride: true, baseUrlOverrideHeader: "x-openai-baseurl" },
  {
    id: "anthropic",
    name: "Anthropic",
    baseUrl: "https://api.anthropic.com",
    models: [],
    allowBaseUrlOverride: true,
    baseUrlOverrideHeader: "x-anthropic-baseurl",
  },
  { id: "chatgpt", name: "ChatGPT", baseUrl: "https://chatgpt.com", models: [], allowBaseUrlOverride: true, baseUrlOverrideHeader: "x-chatgpt-baseurl" },
  {
    id: "gemini",
    name: "Gemini",
    baseUrl: "https://generativelanguage.googleapis.com",
    models: [],
    allowBaseUrlOverride: true,
    baseUrlOverrideHeader: "x-gemini-baseurl",
  },
  {
    id: "vertex",
    name: "Vertex AI",
    baseUrl: "https://us-central1-aiplatform.googleapis.com",
    models: [],
    allowBaseUrlOverride: true,
    baseUrlOverrideHeader: "x-vertex-baseurl",
  },
  {
    id: "nvidia",
    name: "NVIDIA",
    baseUrl: "https://integrate.api.nvidia.com",
    models: [],
    allowBaseUrlOverride: true,
    baseUrlOverrideHeader: "x-nvidia-baseurl",
  },
  {
    id: "openrouter",
    name: "OpenRouter",
    baseUrl: "https://openrouter.ai/api",
    models: [],
    allowBaseUrlOverride: true,
    baseUrlOverrideHeader: "x-openrouter-baseurl",
  },
  {
    id: "kilo",
    name: "Kilo",
    baseUrl: "https://api.kilo.ai/api/gateway",
    models: [],
    allowBaseUrlOverride: true,
    baseUrlOverrideHeader: "x-kilo-baseurl",
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
    await handle.writeFile("{}", "utf8");
    await handle.close();
  } catch (error) {
    const errno = error as NodeJS.ErrnoException;
    if (errno.code !== "EEXIST") {
      throw error;
    }
  }
}

/**
 * Migrates legacy array-format providers to the object (map) format.
 *
 * Pure function: no side effects, no file I/O. Called by readFileProviders
 * when an array-format providers.json is detected. The migration itself is
 * not persisted here — that is handled by withProvidersLock to avoid race
 * conditions in the unlocked getAllProviders read path.
 *
 * @param arr - Parsed JSON array from providers.json
 * @returns Object keyed by provider id
 */
export function migrateProvidersArray(
	arr: unknown[],
): Record<string, CoreProviderConfig> {
	const migrated: Record<string, CoreProviderConfig> = {};
	for (const p of arr) {
		try {
			const validated = ProviderConfigSchema.parse(p);
			migrated[validated.id] = toCoreProviderConfig(validated);
		} catch {
			// skip invalid entries
		}
	}
	return migrated;
}

async function readFileProviders(): Promise<Record<string, CoreProviderConfig>> {
  await ensureProvidersFile();
  try {
    const raw = await fs.readFile(PROVIDERS_FILE, "utf8");
    const parsed = JSON.parse(raw);
    if (Array.isArray(parsed)) {
      // Migrate from legacy array format to object format in-memory only.
      // The migration write is intentionally NOT performed here to avoid a
      // TOCTOU race: readFileProviders is called from getAllProviders without
      // the file lock, and a direct write could clobber concurrent locked
      // writes from createProvider/updateProvider/deleteProvider.
      // The migration is persisted by withProvidersLock when the next write
      // operation occurs (its callback writes the full providers object).
      return migrateProvidersArray(parsed);
    }
    if (typeof parsed === "object" && parsed !== null) {
      const result: Record<string, CoreProviderConfig> = {};
      for (const [key, value] of Object.entries(parsed)) {
        if (typeof value === "object" && value !== null) {
          try {
            const config = value as Record<string, unknown>;
            const configId = config.id as string;
            // Validate that object key matches provider id (consistent with proxy validation)
            if (configId !== key) {
              console.warn(`[providers] skip providers.json[${key}]: id mismatch (expected ${key}, got ${configId})`);
              continue;
            }
            validateProviderConfig(value as CoreProviderConfig);
            result[key] = value as CoreProviderConfig;
          } catch {
            // skip invalid
          }
        }
      }
      return result;
    }
    return {};
  } catch {
    return {};
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
 * The callback receives the current providers object and should return the modified object.
 */
async function withProvidersLock<T>(
  fn: (providers: Record<string, CoreProviderConfig>) => Promise<{ providers: Record<string, CoreProviderConfig>; result: T }>
): Promise<T> {
  const lockPath = `${PROVIDERS_FILE}.lock`;

  return withFileLock(lockPath, async () => {
    // Read inside the lock
    const providers = await readFileProviders();
    
    // Safeguard: ensure providers is an object (not array) to prevent spreading array with numeric keys
    if (Array.isArray(providers)) {
      throw new Error("providers.json is in legacy array format; migration should have been handled by readFileProviders");
    }
    
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
  for (const [id, coreConfig] of Object.entries(fileProviders)) {
    merged.set(id, { ...fromCoreProviderConfig(coreConfig), source: "file", dynamic: true });
  }

  return Array.from(merged.values());
}

export async function getProviderById(id: string): Promise<ProviderMetadata | null> {
  const all = await getAllProviders();
  return all.find((p) => p.id === id) ?? null;
}

export async function createProvider(config: ProviderConfigInput): Promise<ProviderMetadata> {
  const validated = ProviderConfigSchema.parse(config);

  const result = await withProvidersLock(async (providers) => {
    if (providers[validated.id]) {
      throw new Error(`Provider with id "${validated.id}" already exists in file`);
    }

    const coreConfig = toCoreProviderConfig(validated);
    validateProviderConfig(coreConfig);
    
    const newProviders = { ...providers, [validated.id]: coreConfig };
    return { providers: newProviders, result: { ...fromCoreProviderConfig(coreConfig), source: "file" as const, dynamic: true } };
  });

  return result;
}

export async function updateProvider(id: string, config: ProviderConfigInput): Promise<ProviderMetadata> {
  const validated = ProviderConfigSchema.parse(config);

  if (validated.id !== id) {
    throw new Error(`Provider id in URL (${id}) does not match id in body (${validated.id})`);
  }

  const result = await withProvidersLock(async (providers) => {
    if (!providers[id]) {
      throw new Error(`Provider with id "${id}" not found in file`);
    }

    // Merge with existing config to preserve proxy fields
    const existingCoreConfig = providers[id];
    const coreConfig = toCoreProviderConfig(validated, existingCoreConfig);
    validateProviderConfig(coreConfig);
    
    const newProviders = { ...providers, [id]: coreConfig };
    return { providers: newProviders, result: { ...fromCoreProviderConfig(coreConfig), source: "file" as const, dynamic: true } };
  });

  return result;
}

export async function deleteProvider(id: string): Promise<void> {
  await withProvidersLock(async (providers) => {
    if (!providers[id]) {
      throw new Error(`Provider with id "${id}" not found in file`);
    }

    const { [id]: _, ...filtered } = providers;
    return { providers: filtered, result: undefined };
  });
}
