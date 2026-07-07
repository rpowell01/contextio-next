import type { ProxyStatus } from "@/types/api";

// Proxy admin API URL (for server-side requests)
const PROXY_ADMIN_URL =
  process.env.NEXT_PUBLIC_PROXY_ADMIN_URL || "http://localhost:4040";

export async function GET() {
  try {
    // Fetch real status from the proxy admin API
    const response = await fetch(`${PROXY_ADMIN_URL}/admin/status`);
    if (!response.ok) {
      throw new Error(`Proxy admin API returned ${response.status}`);
    }
    let status: ProxyStatus;
    try {
      status = await response.json();
    } catch (e: unknown) {
      throw new Error(
        `Failed to parse proxy status JSON: ${
          e instanceof Error ? e.message : "Unknown error"
        }`,
      );
    }
    // Include container name for consistency
    return Response.json({ ...status, containerId: "contextio-next" });
  } catch (error) {
    console.error("Error in status API:", error);
    // Fallback to mock data if proxy is unreachable
    return Response.json({
      running: true,
      pid: process.pid,
      port: 4040,
      sessions: 0,
      uptime: "0s",
      plugins: [],
      logTraffic: false,
      containerId: "contextio-next",
    } satisfies ProxyStatus);
  }
}
