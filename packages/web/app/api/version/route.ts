import { NextResponse } from "next/server";
import { createSuccessResponse } from "@contextio/core";
import { readFileSync } from "fs";
import { join } from "path";

export async function GET() {
  // Read version info from file written at build time
  let version = "dev";
  let buildTime = new Date().toISOString();
  let gitCommit = "unknown";

  try {
    const versionInfo = JSON.parse(
      readFileSync(join(process.cwd(), "version-info.json"), "utf-8")
    );
    version = versionInfo.version;
    buildTime = versionInfo.buildTime;
    gitCommit = versionInfo.gitCommit;
  } catch {
    // Fallback to env vars if file not found
    version = process.env.NEXT_PUBLIC_VERSION || process.env.VERSION || "dev";
    buildTime = process.env.NEXT_PUBLIC_BUILD_TIME || process.env.BUILD_TIME || new Date().toISOString();
    gitCommit = process.env.NEXT_PUBLIC_GIT_COMMIT || process.env.GIT_COMMIT || "unknown";
  }

  return NextResponse.json(createSuccessResponse({
    version,
    buildTime,
    gitCommit: gitCommit.slice(0, 8),
  }));
}