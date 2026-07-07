export const runtime = "nodejs";

import { NextResponse } from "next/server";
import { homedir } from "node:os";
import fs from "node:fs/promises";
import { join } from "node:path";
import { applyLogDir } from "@/lib/sessions/utils";
import { startCleanupScheduler } from "@/lib/cleanup-scheduler";

const SETTINGS_FILE = join(homedir(), ".contextio-next", "settings.json");
const NONCE_SET = new Set<string>();

// Apply the persisted logDir once at startup. With `runtime = "nodejs"`,
// this module is evaluated once per server worker and reused across
// requests for the lifetime of the process, so this promise only
// resolves/runs on the first request and the result is cached for all
// subsequent requests. This initializes the middleware-graph copy of
// CAPTURE_DIR before any capture/routes run.
const _initPromise = (async () => {
  const settings = await loadSettings();
  if (settings) {
    applyLogDir(settings.logDir);
  }
})();

export function issueNonce(): string {
  const nonce = Math.random().toString(36).slice(2) + Date.now().toString(36);
  NONCE_SET.add(nonce);
  return nonce;
}

export function consumeNonce(nonce: string): boolean {
  if (!nonce) return false;
  return NONCE_SET.delete(nonce);
}

async function loadSettings(): Promise<{ logDir: string } | null> {
  try {
    const raw = await fs.readFile(SETTINGS_FILE, "utf8");
    const parsed = JSON.parse(raw);
    if (typeof parsed !== "object" || parsed === null) return null;
    const obj = parsed as Record<string, unknown>;
    if (typeof obj.logDir !== "string") return null;
    return { logDir: obj.logDir };
  } catch {
    return null;
  }
}

export default async function middleware() {
  await _initPromise;
  await startCleanupScheduler();

  const nonce = issueNonce();
  const response = NextResponse.next();
  response.headers.set("x-csrf-nonce", nonce);
  return response;
}

export const config = {
  matcher: ["/api/:path*"],
};
