export const runtime = "nodejs";

import { NextResponse } from "next/server";
import { homedir } from "node:os";
import fs from "node:fs/promises";
import { join } from "node:path";
import { applyLogDir } from "@/lib/sessions/utils";
import { startCleanupScheduler } from "@/lib/cleanup-scheduler";

const SETTINGS_FILE = join(homedir(), ".contextio-next", "settings.json");

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
  const settings = await loadSettings();
  if (settings) {
    applyLogDir(settings.logDir);
  }
  await startCleanupScheduler();

  const nonce = issueNonce();
  const response = NextResponse.next();
  response.headers.set("x-csrf-nonce", nonce);
  return response;
}

export const config = {
  matcher: ["/api/:path*"],
};
