import fs from "node:fs/promises";
import { join } from "node:path";

import type {
  Capture,
  CaptureWithRedaction,
  RedactionDetails,
  PaginationMeta,
} from "@/types/api";

import { CAPTURE_DIR, MAX_FILE_SIZE, isValidFilename } from "@/lib/sessions/utils";
import {
  getCaptureRedactionStats,
  computeCaptureRedactionCounts,
} from "@/lib/sessions/redaction-utils";

/**
 * Extract capture metadata from parsed data.
 */
function extractCaptureMetadata(
  filename: string,
  data: Record<string, unknown>,
): Capture {
  // Extract session ID from filename or data
  const sessionId = extractSessionId(filename, data);

  // Extract and convert numeric fields
  const requestBytes =
    typeof data.requestBytes === "number"
      ? data.requestBytes
      : Number(data.requestBytes) || 0;
  const responseBytes =
    typeof data.responseBytes === "number"
      ? data.responseBytes
      : Number(data.responseBytes) || 0;
  const responseStatus =
    typeof data.responseStatus === "number"
      ? data.responseStatus
      : Number(data.responseStatus) || 0;

  // Extract and convert boolean field
  const responseIsStreaming =
    typeof data.responseIsStreaming === "boolean"
      ? data.responseIsStreaming
      : data.responseIsStreaming === true ||
        data.responseIsStreaming === "true";

  // Extract and convert timings subfields
  const rawTimings =
    data.timings && typeof data.timings === "object"
      ? (data.timings as Record<string, unknown>)
      : {};
  const timings = {
    send_ms:
      typeof rawTimings.send_ms === "number"
        ? rawTimings.send_ms
        : Number(rawTimings.send_ms) || 0,
    wait_ms:
      typeof rawTimings.wait_ms === "number"
        ? rawTimings.wait_ms
        : Number(rawTimings.wait_ms) || 0,
    receive_ms:
      typeof rawTimings.receive_ms === "number"
        ? rawTimings.receive_ms
        : Number(rawTimings.receive_ms) || 0,
    total_ms:
      typeof rawTimings.total_ms === "number"
        ? rawTimings.total_ms
        : Number(rawTimings.total_ms) || 0,
  };

  // Validate timestamp before using it
  const validatedTimestamp = validateCaptureTimestamp(data.timestamp);

  // Extract source from data or filename
  const extractedSource =
    typeof data.source === "string"
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

async function listCaptureFiles(): Promise<string[]> {
  try {
    const files = await fs.readdir(CAPTURE_DIR);
    return files
      .filter((f) => isValidFilename(f) && !f.endsWith(".tmp"))
      .sort();
  } catch (error) {
    console.error("Error listing capture files:", error);
    return [];
  }
}

/**
 * Validate date string and return Date object or null if invalid.
 */
function validateDate(dateStr: string | null): Date | null {
  if (!dateStr) return null;
  const date = new Date(dateStr);
  return isNaN(date.getTime()) ? null : date;
}

/**
 * Validate capture timestamp and return ISO string or null if invalid.
 */
function validateCaptureTimestamp(timestamp: unknown): string | null {
  if (typeof timestamp !== "string") return null;
  const date = new Date(timestamp);
  return isNaN(date.getTime()) ? null : timestamp;
}

/**
 * Safely extract session ID from filename or data.
 * Supports filename format: {source}_{sessionId}_{timestamp}-{counter}.json
 * where timestamp is 13-digit Unix epoch milliseconds.
 * Session ID is expected to be 8 lowercase hex chars.
 * Session ID is optional - if not present, returns null.
 * Also checks for sessionId in the data object.
 *
 * @param filename - The capture filename to parse
 * @param data - Optional parsed data to extract sessionId from
 * @returns The extracted session ID or null if not found
 */
function extractSessionId(filename: string, data?: Record<string, unknown>): string | null {
  // First check if sessionId exists in the data
  if (data && typeof data.sessionId === "string" && data.sessionId.length > 0) {
    return data.sessionId;
  }
  
  // Fall back to filename extraction
  // Match: source_{sessionId}_{13digitTimestamp}-{counter}.json
  // Session ID is 8 lowercase hex chars between underscores
  // Session ID is optional - only match if present
  const match = filename.match(/_([a-f0-9]{8})_\d{13}-\d{6}\.json$/i);
  if (match) return match[1].toLowerCase();

  return null;
}

/**
 * Safely extract source from filename.
 * Supports filename format: {source}_{sessionId}_{timestamp}-{counter}.json
 * where source is alphanumeric with hyphens/underscores.
 * Session ID is optional - if present, it's 8 hex chars before timestamp.
 *
 * @param filename - The capture filename to parse
 * @returns The extracted source or null if not found
 */
function extractSource(filename: string): string | null {
  // With session ID: {source}_{sessionId}_{13digitTimestamp}-{counter}.json
  // Source is everything before the session ID (8 hex chars before timestamp)
  const withSessionMatch = filename.match(
    /^([a-zA-Z0-9_-]+)_[a-f0-9]{8}_\d{13}-\d{6}\.json$/i,
  );
  if (withSessionMatch) return withSessionMatch[1];

  // Without session ID: {source}_{13digitTimestamp}-{counter}.json
  // Source is everything before the timestamp
  const withoutSessionMatch = filename.match(
    /^([a-zA-Z0-9_-]+)_\d{13}-\d{6}\.json$/i,
  );
  if (withoutSessionMatch) return withoutSessionMatch[1];

  return null;
}

export async function GET(request: Request) {
  try {
    const url = new URL(request.url);
    const id = url.pathname.split("/").pop(); // Get capture ID from path
    
    // If we have a specific capture ID, return full details
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
    const status = url.searchParams.get("status");
    const from = url.searchParams.get("from");
    const to = url.searchParams.get("to");
    const redactionType = url.searchParams.get("redactionType");
    const includeRedaction =
      url.searchParams.get("includeRedaction") === "true";

    // Pagination parameters
    const page = parseInt(url.searchParams.get("page") ?? "1", 10);
    const pageSize = parseInt(url.searchParams.get("pageSize") ?? "20", 10);

    // Validate pagination parameters
    const validPage = page > 0 ? page : 1;
    const validPageSize = pageSize > 0 && pageSize <= 100 ? pageSize : 20;

    // Validate date parameters
    const fromDate = validateDate(from);
    const toDate = validateDate(to);

    if (from && !fromDate) {
      return Response.json(
        { error: "Invalid 'from' date parameter" },
        { status: 400 },
      );
    }
    if (to && !toDate) {
      return Response.json(
        { error: "Invalid 'to' date parameter" },
        { status: 400 },
      );
    }

    const files = await listCaptureFiles();
    const captures: (Capture | CaptureWithRedaction)[] = [];

    for (const filename of files) {
      const filepath = join(CAPTURE_DIR, filename);
      let capture: Capture | null = null;
      let redaction: RedactionDetails | null = null;

      try {
        // Check file size before reading
        const stats = await fs.stat(filepath);
        if (stats.size > MAX_FILE_SIZE) {
          console.warn(`Capture file too large, skipping: ${filename}`);
          continue;
        }

        const raw = await fs.readFile(filepath, "utf8");
        const data = JSON.parse(raw) as Record<string, unknown>;

        // Extract capture metadata
        capture = extractCaptureMetadata(filename, data);

      // Compute redaction details if needed (includeRedaction or redactionType filtering)
      if (includeRedaction || (redactionType && redactionType !== "all")) {
        const cachedStats = getCaptureRedactionStats(data);
        if (cachedStats) {
          redaction = {
            totalRedactions: cachedStats.totalRedactions,
            byRule: cachedStats.byRule,
            matches: [],
          };
        } else {
          redaction = computeCaptureRedactionCounts(data);
        }

        // Filter by redaction type if specified
        if (
          redactionType &&
          redactionType !== "all" &&
          !redaction.byRule[redactionType]
        ) {
          continue;
        }
      }

        // Apply date filters - skip records with invalid timestamps
        const captureTimestamp = validateCaptureTimestamp(capture.timestamp);
        if (!captureTimestamp) continue;
        const captureDate = new Date(captureTimestamp);
        if (isNaN(captureDate.getTime())) continue;
        if (fromDate && captureDate < fromDate) continue;
        if (toDate && captureDate > toDate) continue;

        // Apply other filters
        if (sessionId && capture.sessionId !== sessionId) continue;
        if (source && capture.source !== source) continue;
        if (status && String(capture.responseStatus) !== status) continue;

        // Build result based on includeRedaction flag
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

    // Filter captures for pagination
    const filtered = captures;

    // Sort by timestamp descending (newest first)
    filtered.sort((a, b) => {
      const dateA = new Date(a.timestamp).getTime();
      const dateB = new Date(b.timestamp).getTime();
      return dateB - dateA;
    });

    // Build pagination metadata
    const pagination: PaginationMeta = {
      page: validPage,
      pageSize: validPageSize,
      total: filtered.length,
      totalPages: Math.ceil(filtered.length / validPageSize),
    };

    // Apply pagination
    const startIndex = (validPage - 1) * validPageSize;
    const paginatedCaptures = filtered.slice(
      startIndex,
      startIndex + validPageSize,
    );

    // Always return consistent response format
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
