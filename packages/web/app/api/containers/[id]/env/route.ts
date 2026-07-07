import type { ProxyEnvVar } from "@/types/api";

// Proxy admin API URL (for server-side requests)
const PROXY_ADMIN_URL =
  process.env.NEXT_PUBLIC_PROXY_ADMIN_URL || "http://localhost:4040";

export async function GET(
  _request: Request,
  { params }: { params: Promise<{ id: string }> },
) {
  await params; // consume params but we don't need the ID since we query the proxy directly

  try {
    // Fetch real environment variables from the proxy admin API (server-side)
    const response = await fetch(`${PROXY_ADMIN_URL}/admin/env`);
    if (!response.ok) {
      throw new Error(`Proxy admin API returned ${response.status}`);
    }
    let envVars: ProxyEnvVar[];
    try {
      envVars = await response.json();
    } catch (e: unknown) {
      throw new Error(
        `Failed to parse environment variables JSON: ${
          e instanceof Error ? e.message : "Unknown error"
        }`,
      );
    }
    return Response.json(envVars);
  } catch (error) {
    console.error("Error in container env API:", error);
    // Fallback to mock data if proxy is unreachable
    const mockEnvVars: ProxyEnvVar[] = [
      { key: "CONTEXT_PROXY_BIND_HOST", value: "0.0.0.0", source: "default" },
      { key: "CONTEXT_PROXY_PORT", value: "4040", source: "default" },
      {
        key: "CONTEXT_PROXY_PLUGINS",
        value: "/app/logger-plugin.js,/app/redact-plugin.js",
        source: "default",
      },
      {
        key: "REDACT_POLICY_FILE",
        value: "/app/custom-policy.json",
        source: "default",
      },
      { key: "REDACT_REVERSIBLE", value: "true", source: "default" },
      {
        key: "LOGGER_CAPTURE_DIR",
        value: "/home/node/.contextio/captures",
        source: "default",
      },
      { key: "LOGGER_MAX_SESSIONS", value: "0", source: "default" },
      { key: "REDACT_PRESET", value: "pii", source: "default" },
      {
        key: "UPSTREAM_OPENAI_URL",
        value: "https://api.openai.com/v1",
        source: "default",
      },
      {
        key: "UPSTREAM_ANTHROPIC_URL",
        value: "https://api.anthropic.com",
        source: "default",
      },
    ];
    return Response.json(mockEnvVars);
  }
}
