// Provider CRUD utilities backed by providers.json.
// Uses file locking for concurrent write safety.

import fs from "fs/promises";
import { z } from "zod";
import type { ProviderConfig, ProviderMetadata } from "@/types/api";

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

async function withFileLock<T>(
  lockPath: string,
  fn: () => Promise<T>,
  retries = 5,
  delayMs = 100,
): Promise<T> {
  for (let attempt = 0; attempt < retries; attempt++) {
    let lockHandle: fs.FileHandle | null = null;
    try {
      lockHandle = await fs.open(lockPath, "wx");
      const result = await fn();
      return result;
    } catch (error) {
      const errno = error as NodeJS.ErrnoException;
      if (errno.code === "EEXIST") {
        await new Promise((resolve) => setTimeout(resolve, delayMs));
        continue;
      }
      throw error;
    } finally {
      if (lockHandle) {
        try {
          await lockHandle.close();
          await fs.unlink(lockPath).catch(() => {});
        } catch {
          // ignore cleanup errors
        }
      }
    }
  }
  throw new Error(`Failed to acquire file lock after ${retries} retries`);
}

async function writeFileProviders(providers: ProviderConfig[]): Promise<void> {
  const lockPath = `${PROVIDERS_FILE}.lock`;
  const tmpPath = `${PROVIDERS_FILE}.tmp`;

  await withFileLock(lockPath, async () => {
    // Clean up any orphaned temp file from a previous failed write
    await fs.unlink(tmpPath).catch(() => {});

    const tmpHandle = await fs.open(tmpPath, "wx");
    await tmpHandle.writeFile(JSON.stringify(providers, null, 2), "utf8");
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
  const providers = await readFileProviders();

  if (providers.some((p) => p.id === validated.id)) {
    throw new Error(`Provider with id "${validated.id}" already exists in file`);
  }

  providers.push(validated);
  await writeFileProviders(providers);

  return { ...validated, source: "file", dynamic: true };
}

export async function updateProvider(id: string, config: ProviderConfig): Promise<ProviderMetadata> {
  const validated = ProviderConfigSchema.parse(config);

  if (validated.id !== id) {
    throw new Error(`Provider id in URL (${id}) does not match id in body (${validated.id})`);
  }

  const providers = await readFileProviders();
  const index = providers.findIndex((p) => p.id === id);

  if (index === -1) {
    throw new Error(`Provider with id "${id}" not found in file`);
  }

  providers[index] = validated;
  await writeFileProviders(providers);

  return { ...validated, source: "file", dynamic: true };
}

export async function deleteProvider(id: string): Promise<void> {
  const providers = await readFileProviders();
  const filtered = providers.filter((p) => p.id !== id);

  if (filtered.length === providers.length) {
    throw new Error(`Provider with id "${id}" not found in file`);
  }

  await writeFileProviders(filtered);
}
