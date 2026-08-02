import { NextResponse } from "next/server";
import { createSuccessResponse } from "@contextio/core";

export async function GET() {
  // Build info injected at build time
  const buildTime = process.env.BUILD_TIME || new Date().toISOString();
  const gitCommit = process.env.GIT_COMMIT || "unknown";
  const version = process.env.VERSION || "dev";

  return NextResponse.json(createSuccessResponse({
    version,
    buildTime,
    gitCommit: gitCommit.slice(0, 8),
  }));
}