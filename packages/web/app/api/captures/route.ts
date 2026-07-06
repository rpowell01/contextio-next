import fs from "node:fs/promises";
import { join } from "node:path";

import type { Capture, CaptureWithRedaction, RedactionDetails, PaginationMeta } from "@/types/api";

import { getCaptureRedactionStats, computeCaptureRedactionCounts } from "@/lib/sessions/redaction-utils";
import { CAPTURE_DIR, MAX_FILE_SIZE, listCaptureFiles } from "@/lib/sessions/utils";

function extractCaptureMetadata(
  filename: string,
  data: Record<string, unknown>,
): Capture {
  const sessionId = extractSessionId(filename, data);

  const requestBytes = typeof data.requestBytes === "number" ? data.requestBytes : Number(data.requestBytes) || 0;
  const responseBytes = typeof data.responseBytes === "number" ? data.responseBytes : Number(data.responseBytes) || 0;
  const responseStatus = typeof data.responseStatus === "number" ? data.responseStatus : Number(data.responseStatus) || 0;
  const responseIsStreaming = typeof data.responseIsStreaming === "boolean"
    ? data.responseIsStreaming
    : data.responseIsStreaming === true || data.responseIsStreaming === "true";

  const rawTimings = data.timings && typeof data.timings === "object" ? (data.timings as Record<string, unknown>) : {};
  const timings = {
    send_ms: typeof rawTimings.send_ms === "number" ? rawTimings.send_ms : Number(rawTimings.send_ms) || 0,
    wait_ms: typeof rawTimings.wait_ms === "number" ? rawTimings.wait_ms : Number(rawTimings.wait_ms) || 0,
    receive_ms: typeof rawTimings.receive_ms === "number" ? rawTimings.receive_ms : Number(rawTimings.receive_ms) || 0,
    total_ms: typeof rawTimings.total_ms === "number" ? rawTimings.total_ms : Number(rawTimings.total_ms) || 0,
  };

  const validatedTimestamp = validateCaptureTimestamp(data.timestamp);

  const extractedSource = typeof data.source === "string"
    ? data.source
    : (extractSource(filename) ?? "unknown");

  return {
    id: filename,
    sessionId,
    source: extractedSource,
    provider: typeof data.provider === "string" ? data.provider : "unknown",
    apiFormat: typeof data.apiFormat === "string" ? data.apiFormat : "unknown",
    targetUrl: typeof data.targetUrl === "string" ? data.targetUrl : "",
    method: typeof data.method === "string" ? data.method : "POST",
    requestBytes,
    responseBytes,
    responseStatus,
    responseIsStreaming,
    timestamp: validatedTimestamp ?? new Date().toISOString(),
    timings,
  };
}

function validateDate(dateStr: string | null): Date | null {
  if (!dateStr) return null;
  const date = new Date(dateStr);
  return isNaN(date.getTime()) ? null : date;
}

function validateCaptureTimestamp(timestamp: unknown): string | null {
  if (typeof timestamp !== "string") return null;
  const date = new Date(timestamp);
  return isNaN(date.getTime()) ? null : timestamp;
}

function extractSessionId(filename: string, data?: Record<string, unknown>): string | null {
  if (data && typeof data.sessionId === "string" && data.sessionId.length > 0) {
    return data.sessionId;
  }
  const match = filename.match(/_([a-f0-9]{8})_\d{13}-\d{6}\.json$/i);
  if (match) return match[1].toLowerCase();
  return null;
}

function extractSource(filename: string): string | null {
  const withSessionMatch = filename.match(/^([a-zA-Z0-9_-]+)_[a-f0-9]{8}_\d{13}-\d{6}\.json$/i);
  if (withSessionMatch) return withSessionMatch[1];

  const withoutSessionMatch = filename.match(/^([a-zA-Z0-9_-]+)_\d{13}-\d{6}\.json$/i);
  if (withoutSessionMatch) return withoutSessionMatch[1];

  return null;
}

export async function GET(request: Request) {
  try {
    const url = new URL(request.url);
    const id = url.pathname.split("/").pop();

    if (id && id !== "captures") {
      const filepath = join(CAPTURE_DIR, id);
      const stats = await fs.stat(filepath).catch(() => null);
      if (!stats) {
        return Response.json({ error: "Capture not found" }, { status: 404 });
      }
      if (stats.size > MAX_FILE_SIZE) {
        return Response.json({ error: "Capture file too large" }, { status: 413 });
      }

      const raw = await fs.readFile(filepath, "utf8");
      const data = JSON.parse(raw) as Record<string, unknown>;
      const capture = extractCaptureMetadata(id, data);

      return Response.json({
        ...capture,
        requestBody: data.requestBody,
        responseBody: data.responseBody,
      });
    }

    const sessionId = url.searchParams.get("sessionId");
    const source = url.searchParams.get("source");
    const statusParam = url.searchParams.get("status");
    const from = url.searchParams.get("from");
    const to = url.searchParams.get("to");
    const redactionType = url.searchParams.get("redactionType");
    const includeRedaction = url.searchParams.get("includeRedaction") === "true";
    const page = parseInt(url.searchParams.get("page") ?? "1", 10);
    const pageSize = parseInt(url.searchParams.get("pageSize") ?? "20", 10);
    const validPage = page > 0 ? page : 1;
    const validPageSize = pageSize > 0 && pageSize <= 100 ? pageSize : 20;

    const fromDate = validateDate(from);
    const toDate = validateDate(to);

    if (from && !fromDate) {
      return Response.json({ error: "Invalid 'from' date parameter" }, { status: 400 });
    }
    if (to && !toDate) {
      return Response.json({ error: "Invalid 'to' date parameter" }, { status: 400 });
    }

    const files = await listCaptureFiles();
    const captures: (Capture | CaptureWithRedaction)[] = [];

    for (const filename of files) {
      const filepath = join(CAPTURE_DIR, filename);
      let capture: Capture | null = null;
      let redaction: RedactionDetails | null = null;

      try {
        const stats = await fs.stat(filepath);
        if (stats.size > MAX_FILE_SIZE) {
          console.warn(`Capture file too large, skipping: ${filename}`);
          continue;
        }

        const raw = await fs.readFile(filepath, "utf8");
        const data = JSON.parse(raw) as Record<string, unknown>;

        capture = extractCaptureMetadata(filename, data);

        // Compute redaction details if needed (includeRedaction or redactionType filtering)
        if (includeRedaction || (redactionType && redactionType !== "all")) {
          const cachedStats = getCaptureRedactionStats(data);
          redaction = computeCaptureRedactionCounts(
            data,
            false,
            cachedStats ?? undefined,
            data.originalRequestBody,
          );

          // Filter by redaction type if specified
          if (
            redactionType &&
            redactionType !== "all" &&
            !redaction.byRule[redactionType]
          ) {
            continue;
          }
        }

        const captureTimestamp = validateCaptureTimestamp(capture.timestamp);
        if (!captureTimestamp) continue;
        const captureDate = new Date(captureTimestamp);
        if (isNaN(captureDate.getTime())) continue;
        if (fromDate && captureDate < fromDate) continue;
        if (toDate && captureDate > toDate) continue;

        if (sessionId && capture.sessionId !== sessionId) continue;
        if (source && capture.source !== source) continue;
        if (statusParam && String(capture.responseStatus) !== statusParam) continue;

        if (includeRedaction && redaction) {
          captures.push({ ...capture, redaction });
        } else {
          captures.push(capture);
        }
      } catch (error) {
        console.error(`Error processing capture ${filename}:`, error);
        continue;
      }
    }

    const filtered = captures;

    filtered.sort((a, b) => {
      const dateA = new Date(a.timestamp).getTime();
      const dateB = new Date(b.timestamp).getTime();
      return dateB - dateA;
    });

    const pagination: PaginationMeta = {
      page: validPage,
      pageSize: validPageSize,
      total: filtered.length,
      totalPages: Math.ceil(filtered.length / validPageSize),
    };

    const startIndex = (validPage - 1) * validPageSize;
    const paginatedCaptures = filtered.slice(startIndex, startIndex + validPageSize);

    return Response.json({
      data: paginatedCaptures,
      total: filtered.length,
      pagination,
    });
  } catch (error) {
    console.error("Error in captures API:", error);
    return Response.json({ error: "Internal server error" }, { status: 500 });
  }
}

export async function POST(request: Request) {
  try {
    const url = new URL(request.url);

    if (url.pathname !== "/api/captures") {
      return Response.json({ error: "Not found" }, { status: 404 });
    }

    const action = url.searchParams.get("action");
    if (action !== "clear") {
      return Response.json({ error: "Invalid action" }, { status: 400 });
    }

    const body = (await request.json().catch(() => ({}))) as { confirm?: boolean };
    if (!body.confirm) {
      return Response.json({ error: "Confirmation required" }, { status: 400 });
    }

    const files = await listCaptureFiles();
    let deleted = 0;
    let errors = 0;

    for (const filename of files) {
      const filepath = join(CAPTURE_DIR, filename);
      try {
        await fs.unlink(filepath);
        deleted++;
      } catch (error) {
        errors++;
        console.error(`Error deleting capture ${filename}:`, error);
      }
    }

    return Response.json({
      success: true,
      deleted,
      errors,
      message: `Deleted ${deleted} capture(s)${errors > 0 ? `, ${errors} error(s)` : ""}`,
    });
  } catch (error) {
    console.error("Error clearing captures:", error);
    return Response.json({ error: "Internal server error" }, { status: 500 });
  }
}
