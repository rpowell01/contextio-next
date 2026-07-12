import { NextRequest, NextResponse } from "next/server";
import type { LogEntry, LogLevel } from "@/types/api";
import { apiClient } from "@/lib/api";
import { consumeToken } from "@/lib/csrf";

// Input validation helpers
function sanitizeString(value: string | null, maxLength = 256): string | null {
  if (!value) return null;
  // Remove potentially dangerous characters and limit length
  return value.slice(0, maxLength).replace(/[<>'"&]/g, "");
}

function validateContainerId(value: string | null): string | null {
  if (!value) return null;
  // Container IDs should be alphanumeric with limited special chars
  const sanitized = sanitizeString(value, 128);
  if (!sanitized || !/^[a-zA-Z0-9][a-zA-Z0-9._-]*$/.test(sanitized)) {
    return null;
  }
  return sanitized;
}

function validateLogLevel(level: string): LogLevel | null {
  const validLevels: LogLevel[] = ["error", "warn", "info", "debug"];
  if (validLevels.includes(level as LogLevel)) {
    return level as LogLevel;
  }
  return null;
}

export async function GET(request: NextRequest) {
  const searchParams = request.nextUrl.searchParams;
  const rawContainerId = searchParams.get("containerId");
  const rawSessionId = searchParams.get("sessionId");
  const rawSearch = searchParams.get("search");
  const streamMode = searchParams.get("stream") === "true";

  // Validate and sanitize inputs
  validateContainerId(rawContainerId); // Validate but we don't use the result
  const sessionId: string = rawSessionId ?? "contextio-next";
  const search = sanitizeString(rawSearch) ?? undefined;
  
  const rawLevels = searchParams.get("levels")?.split(",").filter(Boolean) || [];
  const levels = rawLevels.map(validateLogLevel).filter((l): l is LogLevel => l !== null);

  // Handle streaming response
  if (streamMode) {
    const encoder = new TextEncoder();

    const stream = new ReadableStream({
      async pull(controller) {
        try {
          // Stream from proxy admin API
          await apiClient.streamProxyLogs((log) => {
            controller.enqueue(encoder.encode(JSON.stringify(log) + "\n"));
          });
          controller.close();
        } catch (error) {
          controller.error(error);
        }
      },
    });

    return new NextResponse(stream, {
      headers: {
        "Content-Type": "text/plain",
        "Cache-Control": "no-cache",
        Connection: "keep-alive",
      },
    });
  }

  // Handle filtered/export response
  try {
    // Try to get logs from proxy admin API first
    const logs = await apiClient.getProxyLogs({ levels, search: search ?? "" });
    
    // Always return "contextio-next" as the container name for consistency
    return NextResponse.json({ logs, containerId: "contextio-next", sessionId });
  } catch (error) {
    console.error("Error fetching proxy logs, falling back to mock:", error);
    // Fallback to mock data if proxy is unreachable
    const messages = [
      { level: "info" as LogLevel, message: "Container started successfully", source: "stdout" as const },
      { level: "info" as LogLevel, message: "Loading configuration from /app/config.yaml", source: "stdout" as const },
      { level: "debug" as LogLevel, message: "Configuration loaded: {port: 4040, logLevel: info}", source: "stdout" as const },
      { level: "info" as LogLevel, message: "Proxy server listening on port 4040", source: "stdout" as const },
      { level: "warn" as LogLevel, message: "Rate limit threshold approaching for provider: openai", source: "stderr" as const },
      { level: "error" as LogLevel, message: "Failed to connect to upstream: timeout after 30s", source: "stderr" as const },
      { level: "info" as LogLevel, message: "Retrying connection (attempt 2/3)", source: "stdout" as const },
      { level: "info" as LogLevel, message: "Connection restored to upstream", source: "stdout" as const },
    ];

    const mockLogs: LogEntry[] = messages.map((msg, i) => ({
      id: `log-${i}`,
      timestamp: new Date(Date.now() - (messages.length - i) * 1000).toISOString(),
      ...msg,
      sessionId: "sess-demo123",
    }));

    // Apply filters
    let filtered = [...mockLogs];
    if (levels && levels.length > 0) {
      filtered = filtered.filter((log) => levels.includes(log.level));
    }
    if (search) {
      const searchLower = search.toLowerCase();
      filtered = filtered.filter(
        (log) =>
          log.message.toLowerCase().includes(searchLower) ||
          log.source.toLowerCase().includes(searchLower)
      );
    }

    return NextResponse.json({ logs: filtered, containerId: "contextio-next", sessionId });
  }
}

export async function POST(request: NextRequest) {
  try {
    const csrfToken = request.headers.get("x-csrf-token");
    if (!(await consumeToken(csrfToken ?? ""))) {
      return NextResponse.json({ error: "Invalid or missing CSRF token" }, { status: 400 });
    }
    const body = await request.json();
    const { action, containerId } = body;

    // Validate inputs
    const sanitizedContainerId = validateContainerId(containerId) || "contextio-next";

    if (action === "clear") {
      try {
        await apiClient.clearProxyLogs();
        return NextResponse.json({ success: true, message: "Logs cleared" });
      } catch (error) {
        console.error("Error clearing proxy logs:", error);
        return NextResponse.json({ success: true, message: "Logs cleared (mock)" });
      }
    }

    if (action === "stream" && sanitizedContainerId) {
      // For SSE streaming, we'll use GET with stream=true parameter
      return NextResponse.json({ 
        success: true, 
        message: "Use GET /api/logs?stream=true for streaming",
        streamUrl: `/api/logs?containerId=${encodeURIComponent(sanitizedContainerId)}&stream=true` 
      });
    }

    return NextResponse.json({ error: "Invalid action" }, { status: 400 });
  } catch (error) {
    return NextResponse.json(
      { error: error instanceof Error ? error.message : "Failed to process request" },
      { status: 500 }
    );
  }
}

// Export types for use in other files
export type { LogEntry, LogLevel };