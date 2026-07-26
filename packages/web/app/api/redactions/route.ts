import {
  listRedactionMetaFiles,
  loadRedactionMeta,
} from "@/lib/sessions/server-utils";
import { consumeToken } from "@/lib/csrf";
import { unstable_cache } from "next/cache";
import { computePlaceholderCounts, convertByRuleToByPlaceholder } from "@/lib/sessions/placeholder-map";

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
    const metaFiles = await listRedactionMetaFiles();

    // Track max redactions per session (to match metrics page behavior)
    const maxRedactionsBySession = new Map<string, number>();
    // Track placeholder counts by session (max per session)
    const placeholderBySession = new Map<string, Record<string, number>>();

    for (const filename of metaFiles) {
      try {
        const meta = await loadRedactionMeta(filename);
        if (!meta) continue;

        const sessionId = (meta.sessionId as string | null) ?? "_no_session";

        // Skip title generation captures
        if (sessionId.startsWith("title-")) continue;

        // Get placeholder counts from matches or fallback to byRule
        const matches = (meta.matches as Array<{
          ruleId: string;
          preValue: string;
          postValue: string;
          path: string;
        }> | undefined) ?? [];

        let counts: Record<string, number>;
        if (matches.length > 0) {
          counts = computePlaceholderCounts(matches);
        } else if (meta.byRule && typeof meta.byRule === "object") {
          // Fallback: convert from byRule (rule names) to byPlaceholder (placeholder names)
          // This handles meta files created by web UI which don't have matches array
          counts = convertByRuleToByPlaceholder(
            meta.byRule as Record<string, number>
          );
        } else {
          counts = {};
        }
        const totalRedactions = meta.totalRedactions ?? 0;

        // Track max total redactions per session
        const existingMax = maxRedactionsBySession.get(sessionId) ?? 0;
        if (totalRedactions > existingMax) {
          maxRedactionsBySession.set(sessionId, totalRedactions);
          // Also update placeholder breakdown to match the max capture
          placeholderBySession.set(sessionId, counts);
        }
      } catch (error) {
        console.error(`Error reading redaction meta ${filename}:`, error);
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

// Get paginated detail rows from meta files - ALL captures (not deduplicated by session)
async function getRedactionDetailsFromMeta(
  page: number,
  pageSize: number,
  filters: Record<string, string>,
  sortKey: string | null,
  sortDir: "asc" | "desc" | null,
): Promise<PaginatedRedactionResponse> {
  const metaFiles = await listRedactionMetaFiles();

  // Collect ALL meta files (not deduplicated by session) to show full detail
  const allMeta: Array<{ filename: string; meta: Record<string, unknown> }> = [];

  for (const filename of metaFiles) {
    try {
      const meta = await loadRedactionMeta(filename);
      if (!meta) continue;

      const sessionId = (meta.sessionId as string | null) ?? "_no_session";

      // Skip title generation captures
      if (sessionId.startsWith("title-")) continue;

      allMeta.push({ filename, meta });
    } catch {
      continue;
    }
  }

  // Sort by timestamp descending (newest first)
  allMeta.sort((a, b) => {
    const tsA = (a.meta.generatedAt as string) ?? (a.meta.timestamp as string) ?? "";
    const tsB = (b.meta.generatedAt as string) ?? (b.meta.timestamp as string) ?? "";
    return new Date(tsB).getTime() - new Date(tsA).getTime();
  });

  // Build rows from ALL meta files (each capture is a row)
  let allRows: RedactionCaptureRow[] = allMeta.map(({ filename, meta }) => {
    const captureId = filename.replace(/\.redact-meta\.json$/, "") + ".json";
    const sessionId = (meta.sessionId as string | null) ?? "_no_session";
    const source = (meta.source as string | null) ?? null;
    const provider = (meta.provider as string) ?? "unknown";
    const targetUrl = (meta.targetUrl as string) ?? "";
    const timestamp =
      (meta.generatedAt as string) ?? (meta.timestamp as string) ?? new Date().toISOString();

    // Get matches from meta - use postValue which contains the placeholder
    const matches =
      (meta.matches as
        | Array<{
            ruleId: string;
            preValue: string;
            postValue: string;
            path: string;
          }>
        | undefined) ?? [];

    const byPlaceholder: Record<string, number> = {};
    if (matches.length > 0) {
      // Prefer matches array (from logger plugin) for accurate placeholder names
      for (const match of matches) {
        const rawPlaceholder = match.postValue ?? "unknown";
        const placeholder = rawPlaceholder.replace(/^\[|\]$/g, "");
        byPlaceholder[placeholder] = (byPlaceholder[placeholder] ?? 0) + 1;
      }
    } else if (meta.byRule && typeof meta.byRule === "object") {
      // Fallback: convert from byRule (rule names) to byPlaceholder (placeholder names)
      // This handles meta files created by web UI which don't have matches array
      const converted = convertByRuleToByPlaceholder(
        meta.byRule as Record<string, number>
      );
      Object.assign(byPlaceholder, converted);
    }

    return {
      captureId,
      sessionId: sessionId === "_no_session" ? null : sessionId,
      timestamp,
      requestSource: source,
      requestProvider: provider,
      requestTarget: targetUrl,
      redactionSummary: Object.entries(byPlaceholder)
        .map(([placeholder, count]) => `[${placeholder}] (${count})`)
        .join(", "),
      totalRedactions: (meta.totalRedactions as number) ?? (matches.length || Object.values(byPlaceholder).reduce((a, b) => a + b, 0)),
      byPlaceholder,
    };
  });

  // Apply filters
  if (Object.keys(filters).length > 0) {
    allRows = allRows.filter((row) => {
      return Object.entries(filters).every(([key, val]) => {
        if (!val) return true;
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
