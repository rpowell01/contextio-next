import {
  listRedactionMetaFiles,
  loadRedactionMeta,
} from "@/lib/sessions/utils";
import { consumeToken } from "@/lib/csrf";
import { unstable_cache } from "next/cache";

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
  /** Breakdown by rule for this capture */
  byRule: Record<string, number>;
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
    const metaFiles = await listRedactionMetaFiles();
    
    // Group meta files by sessionId to avoid duplicate counts from multiple captures per session
    const metaBySession = new Map<string, { filename: string; meta: Record<string, unknown> }>();
    
    for (const filename of metaFiles) {
      try {
        const meta = await loadRedactionMeta(filename);
        if (!meta) continue;
        
        const sessionId = (meta.sessionId as string | null) ?? "_no_session";
        
        // Skip title generation captures
        if (sessionId.startsWith("title-")) continue;
        
        // Keep first meta file per session
        if (!metaBySession.has(sessionId)) {
          metaBySession.set(sessionId, { filename, meta });
        }
      } catch (error) {
        console.error(`Error reading redaction meta ${filename}:`, error);
        continue;
      }
    }

    let totalRedactions = 0;
    const byType: Record<string, number> = {};

for (const [_sessionId, { filename, meta }] of metaBySession) {
      try {
        if (typeof meta.totalRedactions === "number") {
          totalRedactions += meta.totalRedactions;
        }
        if (meta.byRule && typeof meta.byRule === "object") {
          for (const [rule, count] of Object.entries(meta.byRule)) {
            if (typeof count === "number") {
              byType[rule] = (byType[rule] ?? 0) + count;
            }
          }
        }
      } catch (error) {
        console.error(`Error processing redaction meta ${filename}:`, error);
        continue;
      }
    }

    return { totalRedactions, byType };
  },
  ["redactions-summary"],
  { revalidate: 30, tags: ["redactions-summary"] },
);

// Get paginated detail rows from meta files only - grouped by captureId
async function getRedactionDetailsFromMeta(
  page: number,
  pageSize: number,
  filters: Record<string, string>,
  sortKey: string | null,
  sortDir: "asc" | "desc" | null,
): Promise<PaginatedRedactionResponse> {
  const metaFiles = await listRedactionMetaFiles();

  // Group meta files by sessionId to avoid duplicate counts from multiple captures per session
  const metaBySession = new Map<string, { filename: string; meta: Record<string, unknown> }>();

  for (const filename of metaFiles) {
    try {
      const meta = await loadRedactionMeta(filename);
      if (!meta) continue;

      const sessionId = (meta.sessionId as string | null) ?? "_no_session";

      // Skip title generation captures
      if (sessionId.startsWith("title-")) continue;

      // Keep first meta file per session
      if (!metaBySession.has(sessionId)) {
        metaBySession.set(sessionId, { filename, meta });
      }
    } catch {
      continue;
    }
  }

  let totalRedactions = 0;
  const byType: Record<string, number> = {};

  // First pass: collect all data from meta files (deduplicated by sessionId)
  const captureMap = new Map<string, {
    captureId: string;
    sessionId: string | null;
    timestamp: string;
    requestSource: string | null;
    requestProvider: string;
    requestTarget: string;
    byRule: Record<string, number>;
    totalCount: number;
  }>();

  for (const [sessionId, { filename, meta }] of metaBySession) {
    try {
      const captureId = filename.replace(/\.redact-meta\.json$/, "") + ".json";
      const source = (meta.source as string | null) ?? null;
      const provider = (meta.provider as string) ?? "unknown";
      const targetUrl = (meta.targetUrl as string) ?? "";
      const timestamp =
        (meta.generatedAt as string) ?? new Date().toISOString();

      // Add counts to summary (once per session)
      if (typeof meta.totalRedactions === "number") {
        totalRedactions += meta.totalRedactions;
      }
      if (meta.byRule && typeof meta.byRule === "object") {
        for (const [rule, count] of Object.entries(meta.byRule)) {
          if (typeof count === "number") {
            byType[rule] = (byType[rule] ?? 0) + count;
          }
        }
      }

      // Get matches from meta
      const matches =
        (meta.matches as
          | Array<{
              ruleId: string;
              original: string;
              placeholder: string;
              path: string;
            }>
          | undefined) ?? [];

      // Aggregate by captureId
      const existing = captureMap.get(captureId);
      if (existing) {
        // Merge into existing capture
        existing.totalCount += matches.length;
        for (const match of matches) {
          const ruleId: string = (match as Record<string, unknown>).ruleId as string ?? "unknown";
          existing.byRule[ruleId] = (existing.byRule[ruleId] ?? 0) + 1;
        }
      } else {
        // New capture
        const byRule: Record<string, number> = {};
        for (const match of matches) {
          const ruleId: string = (match as Record<string, unknown>).ruleId as string ?? "unknown";
          byRule[ruleId] = (byRule[ruleId] ?? 0) + 1;
        }
        captureMap.set(captureId, {
          captureId,
          sessionId: sessionId === "_no_session" ? null : sessionId,
          timestamp,
          requestSource: source,
          requestProvider: provider,
          requestTarget: targetUrl,
          byRule,
          totalCount: matches.length,
        });
      }
    } catch (error) {
      console.error(`Error processing redaction meta ${filename}:`, error);
      continue;
    }
  }

  // Build aggregated rows
  let allRows: RedactionCaptureRow[] = Array.from(captureMap.values()).map(c => ({
    captureId: c.captureId,
    sessionId: c.sessionId,
    timestamp: c.timestamp,
    requestSource: c.requestSource,
    requestProvider: c.requestProvider,
    requestTarget: c.requestTarget,
    redactionSummary: Object.entries(c.byRule)
      .map(([rule, count]) => `[${rule.toUpperCase()}_REDACTED] (${count})`)
      .join(", "),
    totalRedactions: c.totalCount,
    byRule: c.byRule,
  }));

  // Apply filters
  if (Object.keys(filters).length > 0) {
    allRows = allRows.filter((row) => {
      return Object.entries(filters).every(([key, val]) => {
        if (!val) return true;
        // Special handling for redactionType filter - check if the rule exists in byRule
        if (key === "redactionType") {
          return Object.keys(row.byRule).some(
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

  return {
    summary: { totalRedactions, byType },
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
      return Response.json({ summary });
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

    const result = await getRedactionDetailsFromMeta(
      page,
      pageSize,
      filters,
      sortKey,
      sortDir,
    );

    return Response.json(result);
  } catch (error) {
    console.error("Error in redactions API:", error);
    return Response.json({ error: "Internal server error" }, { status: 500 });
  }
}

export async function POST(request: Request) {
  try {
    const csrfToken = request.headers.get("x-csrf-token");
    if (!(await consumeToken(csrfToken ?? ""))) {
      return Response.json(
        { error: "Invalid or missing CSRF token" },
        { status: 400 },
      );
    }
    const body = (await request.json().catch(() => ({}))) as {
      action?: string;
    };
    if (body.action !== "clear") {
      return Response.json({ error: "Invalid action" }, { status: 400 });
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
    return Response.json({ success: true, ...result });
  } catch (error) {
    console.error("Error in redactions POST API:", error);
    return Response.json({ error: "Internal server error" }, { status: 500 });
  }
}
