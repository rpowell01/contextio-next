import { NextRequest, NextResponse } from "next/server";

import { apiClient } from "@/lib/api";
import type { ProxyEnvVar } from "@/types/api";

// Fallback env vars when proxy is unreachable — mirrors the resilience pattern
// used by /api/status so the container env page doesn't hard-error when the
// proxy admin API is temporarily down.
const FALLBACK_ENV_VARS: ProxyEnvVar[] = [
  { key: "NEXT_PUBLIC_SITE_URL", value: "http://localhost:4041", source: "default" },
  { key: "CONTEXT_PROXY_PORT", value: "4040", source: "default" },
  { key: "CONTEXT_PROXY_BIND_HOST", value: "0.0.0.0", source: "default" },
  { key: "LOGGER_CAPTURE_DIR", value: "/app/captures", source: "default" },
  { key: "REDACT_POLICY_FILE", value: "/app/custom-policy/custom-policy.json", source: "default" },
  { key: "REDACT_PRESET", value: "pii", source: "default" },
  { key: "REDACT_REVERSIBLE", value: "false", source: "default" },
  { key: "LOG_TRAFFIC", value: "false", source: "default" },
  { key: "DEBUG_ROUTING", value: "false", source: "default" },
  { key: "LOG_LEVEL", value: "info", source: "default" },
];

export async function GET(
  _request: NextRequest,
  { params }: { params: Promise<{ id: string }> },
) {
  await params;
  try {
    const envVars = await apiClient.getProxyEnvVars();
    return NextResponse.json(envVars);
  } catch (error) {
    console.error("Error fetching proxy env vars:", error);
    // Graceful fallback — returns default config values when proxy is down
    return NextResponse.json(FALLBACK_ENV_VARS);
  }
}
