import { NextResponse } from "next/server";
import { createSuccessResponse } from "@contextio/core";

export async function GET() {
  // Build info injected at build time via NEXT_PUBLIC_ env vars
  const buildTime = process.env.NEXT_PUBLIC_BUILD_TIME || new Date().toISOString();
  const gitCommit = process.env.NEXT_PUBLIC_GIT_COMMIT || "unknown";
  const version = process.env.NEXT_PUBLIC_VERSION || "dev";

  return NextResponse.json(createSuccessResponse({
    version,
    buildTime,
    gitCommit: gitCommit.slice(0, 8),
  }));
}