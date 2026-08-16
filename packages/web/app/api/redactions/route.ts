import {
  getAllRedactionMetadataFromDb,
} from "@/lib/sessions/db-utils";
import { consumeToken } from "@/lib/csrf";
import { unstable_cache } from "next/cache";
import {
  ruleNameToPlaceholder,
} from "@/lib/sessions/placeholder-map";
import { createErrorResponse, createSuccessResponse } from "@contextio/core";

interface RedactionSummary {
  totalRedactions: number;
  byType: Record<string, number>;
}

/** Aggregated row: one per captureId, with comma-separated redaction list */
interface RedactionCaptureRow {
  captureId: string;
  sessionId: string | null;
  timestamp: string;
  requestSource: string | null;
  requestProvider: string;
  requestTarget: string;
  /** Comma-separated list like "[API_KEY_REDACTED] (1), [PHONE_REDACTED] (5)" */
  redactionSummary: string;
  /** Total redaction count for this capture */
  totalRedactions: number;
  /** Breakdown by placeholder for this capture */
  byPlaceholder: Record<string, number>;
}

interface PaginatedRedactionResponse {
  summary: RedactionSummary;
  details: RedactionCaptureRow[];
  page: number;
  pageSize: number;
  totalPages: number;
  totalCount: number;
}

// Cached summary computation - revalidates every 30 seconds
const getRedactionsSummary = unstable_cache(
  async (): Promise<RedactionSummary> => {
    const allMeta = await getAllRedactionMetadataFromDb();

    // Track max redactions per session (to match metrics page behavior)
    const maxRedactionsBySession = new Map<string, number>();
    // Track placeholder counts by session (from the max capture)
    const placeholderBySession = new Map<string, Record<string, number>>();

    for (const meta of allMeta) {
      try {
        const sessionId = meta.sessionId ?? "_no_session";

        // Skip title generation captures
        if (sessionId.startsWith("title-")) continue;

        // Use SQLite metadata directly - it contains complete ruleCounts and matches
        const byRule = meta.ruleCounts ?? {};
        const totalRedactions = meta.totalRedactions ?? 0;

        // Convert byRule to byPlaceholder using canonical placeholder format
        // ruleId is now the entity type label (e.g., "PERSON", "EMAIL_ADDRESS") from Presidio
        // Use ruleNameToPlaceholder to get canonical format "PERSON_REDACTED", "EMAIL_ADDRESS_REDACTED"
        const byPlaceholder: Record<string, number> = {};
        for (const [rule, count] of Object.entries(byRule)) {
          if (typeof count !== "number" || count <= 0) continue;
          const placeholder = ruleNameToPlaceholder(rule);
          byPlaceholder[placeholder] = (byPlaceholder[placeholder] ?? 0) + count;
        }

        // Track max total redactions per session
        const existingMax = maxRedactionsBySession.get(sessionId) ?? 0;
        if (totalRedactions > existingMax) {
          maxRedactionsBySession.set(sessionId, totalRedactions);
          // Also update placeholder breakdown to match the max capture
          placeholderBySession.set(sessionId, byPlaceholder);
        }
      } catch (error) {
        console.error(`Error processing redaction meta for ${meta.captureId}:`, error);
        continue;
      }
    }

    // Sum up max redactions across all sessions
    let totalRedactions = 0;
    const byPlaceholder: Record<string, number> = {};

    for (const [sessionId, maxCount] of maxRedactionsBySession) {
      totalRedactions += maxCount;

      // Add placeholder breakdown from the max capture for this session
      const counts = placeholderBySession.get(sessionId);
      if (counts) {
        for (const [placeholder, count] of Object.entries(counts)) {
          byPlaceholder[placeholder] = (byPlaceholder[placeholder] ?? 0) + count;
        }
      }
    }

    return { totalRedactions, byType: byPlaceholder };
  },
  ["redactions-summary"],
  { revalidate: 30, tags: ["redactions-summary"] },
);

// Get paginated detail rows from SQLite - ALL captures (not deduplicated by session)
async function getRedactionDetailsFromDb(
  page: number,
  pageSize: number,
  filters: Record<string, string>,
  sortKey: string | null,
  sortDir: "asc" | "desc" | null,
): Promise<PaginatedRedactionResponse> {
  const allMeta = await getAllRedactionMetadataFromDb();

  // Filter out title-* sessions and build rows with per-row error handling
  let allRows: RedactionCaptureRow[] = [];
  for (const meta of allMeta) {
    try {
      const sessionId = meta.sessionId ?? "_no_session";

      // Skip title generation captures
      if (sessionId.startsWith("title-")) continue;

      // Safely construct captureId - ensure we don't double-append .json
      const captureIdBase = meta.captureId.endsWith(".json") ? meta.captureId.slice(0, -5) : meta.captureId;
      const captureId = captureIdBase + ".json";
      const sessionIdOut = meta.sessionId;
      const source = meta.source ?? null;
      const provider = meta.provider ?? "unknown";
      const targetUrl = meta.targetUrl ?? "";
      // Use createdAt from DB for timestamp
      const timestamp = meta.createdAt ? new Date(meta.createdAt).toISOString() : new Date().toISOString();

      // Use SQLite metadata directly - it contains complete ruleCounts and matches
      const byRule = meta.ruleCounts ?? {};
      const totalRedactions = meta.totalRedactions ?? 0;

      // Convert byRule to byPlaceholder using canonical placeholder format
      // ruleId is now the entity type label (e.g., "PERSON", "EMAIL_ADDRESS") from Presidio
      // Use ruleNameToPlaceholder to get canonical format "PERSON_REDACTED", "EMAIL_ADDRESS_REDACTED"
      const byPlaceholder: Record<string, number> = {};
      for (const [rule, count] of Object.entries(byRule)) {
        if (typeof count !== "number" || count <= 0) continue;
        const placeholder = ruleNameToPlaceholder(rule);
        byPlaceholder[placeholder] = (byPlaceholder[placeholder] ?? 0) + count;
      }

      allRows.push({
        captureId,
        sessionId: sessionIdOut,
        timestamp,
        requestSource: source,
        requestProvider: provider,
        requestTarget: targetUrl,
        redactionSummary: Object.entries(byPlaceholder)
          .map(([placeholder, count]) => `[${placeholder}] (${count})`)
          .join(", "),
        totalRedactions,
        byPlaceholder,
      });
    } catch (error) {
      console.error(`Error processing redaction meta for ${meta.captureId}:`, error);
      continue;
    }
  }

  // Sort by timestamp descending (newest first)
  allRows.sort((a, b) => {
    const tsA = a.timestamp;
    const tsB = b.timestamp;
    return new Date(tsB).getTime() - new Date(tsA).getTime();
  });

  // Apply filters
  if (Object.keys(filters).length > 0) {
    allRows = allRows.filter((row) => {
      return Object.entries(filters).every(([key, val]) => {
        if (!val) return true;
        // Special handling for hideZeroRedactions filter
        if (key === "hideZeroRedactions") {
          return val === "true" ? row.totalRedactions > 0 : true;
        }
        // Special handling for redactionType filter - check if the placeholder exists in byPlaceholder
        if (key === "redactionType") {
          return Object.keys(row.byPlaceholder).some(
            (k) => k.toLowerCase() === val.toLowerCase(),
          );
        }
        // Only index valid keys of RedactionCaptureRow
        if (key in row) {
          const cell = row[key as keyof RedactionCaptureRow];
          return String(cell ?? "")
            .toLowerCase()
            .includes(val.toLowerCase());
        }
        return false;
      });
    });
  }

  // Apply sorting
  const sortableKeys = [
    "captureId",
    "requestSource",
    "requestProvider",
    "requestTarget",
    "sessionId",
    "timestamp",
    "totalRedactions",
  ] as const;
  if (sortKey && sortDir && sortableKeys.includes(sortKey as typeof sortableKeys[number])) {
    const key = sortKey as keyof RedactionCaptureRow;
    allRows = [...allRows].sort((a, b) => {
      const aVal = a[key];
      const bVal = b[key];
      if (aVal === null || aVal === undefined)
        return sortDir === "asc" ? 1 : -1;
      if (bVal === null || bVal === undefined)
        return sortDir === "asc" ? -1 : 1;
      if (aVal < bVal) return sortDir === "asc" ? -1 : 1;
      if (aVal > bVal) return sortDir === "asc" ? 1 : -1;
      return 0;
    });
  }

  // Apply pagination
  const totalCount = allRows.length;
  const totalPages = Math.max(1, Math.ceil(totalCount / pageSize));
  const clampedPage = Math.min(page, totalPages);
  const start = (clampedPage - 1) * pageSize;
  const end = start + pageSize;
  const pageRows = allRows.slice(start, end);

  // Get summary using cached max-per-session logic
  const summary = await getRedactionsSummary();

  return {
    summary,
    details: pageRows,
    page: clampedPage,
    pageSize,
    totalPages,
    totalCount,
  };
}

export async function GET(request: Request): Promise<Response> {
  try {
    const url = new URL(request.url);

    // Check for summary=true query parameter for fast aggregated counts
    const summaryOnly = url.searchParams.get("summary") === "true";

    if (summaryOnly) {
      // Fast path: use cached summary computation
      const summary = await getRedactionsSummary();
      return Response.json(createSuccessResponse({ summary }));
    }

    // Parse pagination params
    const page = Math.max(1, parseInt(url.searchParams.get("page") ?? "1", 10));
    const pageSize = Math.min(
      200,
      Math.max(1, parseInt(url.searchParams.get("pageSize") ?? "50", 10)),
    );

    // Parse sort params
    const sortKey = url.searchParams.get("sortKey");
    const sortDir =
      url.searchParams.get("sortDir") === "asc"
        ? "asc"
        : url.searchParams.get("sortDir") === "desc"
          ? "desc"
          : null;

    // Parse filters (only valid keys)
    const validFilterKeys = [
      "redactionType",
      "hideZeroRedactions",
      "requestSource",
      "requestProvider",
      "requestTarget",
      "sessionId",
      "captureId",
    ];
    const filters: Record<string, string> = {};
    for (const [key, value] of url.searchParams.entries()) {
      if (
        key.startsWith("filter_") &&
        validFilterKeys.includes(key.replace("filter_", ""))
      ) {
        const filterKey = key.replace("filter_", "");
        if (value) filters[filterKey] = value;
      }
    }

    const result = await getRedactionDetailsFromDb(
      page,
      pageSize,
      filters,
      sortKey,
      sortDir,
    );

    return Response.json(createSuccessResponse(result));
  } catch (error) {
    console.error("Error in redactions API:", error);
    return Response.json(createErrorResponse({ message: "Internal server error", status: 500 }), { status: 500 });
  }
}

export async function POST(request: Request) {
  try {
    const csrfToken = request.headers.get("x-csrf-token");
    if (!(await consumeToken(csrfToken ?? ""))) {
      return Response.json(
        createErrorResponse({ message: "Invalid or missing CSRF token", status: 400 }),
        { status: 400 },
      );
    }
    const body = (await request.json().catch(() => ({}))) as {
      action?: string;
    };
    if (body.action !== "clear") {
      return Response.json(createErrorResponse({ message: "Invalid action", status: 400 }), { status: 400 });
    }

    // Clear all redactions by returning empty summary
    const result: PaginatedRedactionResponse = {
      summary: { totalRedactions: 0, byType: {} },
      details: [],
      page: 1,
      pageSize: 50,
      totalPages: 1,
      totalCount: 0,
    };
    return Response.json(createSuccessResponse({ success: true, ...result }));
  } catch (error) {
    console.error("Error in redactions POST API:", error);
    return Response.json(createErrorResponse({ message: "Internal server error", status: 500 }), { status: 500 });
  }
}