import { join } from "path";

import {
  getCaptureDir,
  listRedactionMetaFiles,
  readRedactionMetaFile,
} from "@/lib/sessions/utils";
import { consumeToken } from "@/lib/csrf";
import { unstable_cache } from "next/cache";

interface RedactionSummary {
  totalRedactions: number;
  byType: Record<string, number>;
}

interface RedactionDetailRow {
  redactionType: string;
  requestSource: string | null;
  requestProvider: string;
  requestTarget: string;
  sessionId: string | null;
  captureId: string;
  preRedactionValue: string;
  postRedactionValue: string;
  timestamp: string;
}

interface PaginatedRedactionResponse {
  summary: RedactionSummary;
  details: RedactionDetailRow[];
  page: number;
  pageSize: number;
  totalPages: number;
  totalCount: number;
}

// Cached summary computation - revalidates every 30 seconds
const getRedactionsSummary = unstable_cache(
  async (): Promise<RedactionSummary> => {
    const metaFiles = await listRedactionMetaFiles();
    let totalRedactions = 0;
    const byType: Record<string, number> = {};

    for (const filename of metaFiles) {
      try {
        const captureDir = await getCaptureDir();
        const filepath = join(captureDir, filename);
        const meta = await readRedactionMetaFile(filepath);
        if (!meta) continue;

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
        console.error(`Error reading redaction meta ${filename}:`, error);
        continue;
      }
    }

    return { totalRedactions, byType };
  },
  ["redactions-summary"],
  { revalidate: 30, tags: ["redactions-summary"] }
);

// Get paginated detail rows from meta files only
async function getRedactionDetailsFromMeta(
  page: number,
  pageSize: number,
  filters: Record<string, string>,
  sortKey: string | null,
  sortDir: "asc" | "desc" | null,
): Promise<PaginatedRedactionResponse> {
  const metaFiles = await listRedactionMetaFiles();
  let totalRedactions = 0;
  const byType: Record<string, number> = {};

  // First pass: collect all data from meta files
  const allRows: RedactionDetailRow[] = [];

  for (const filename of metaFiles) {
    try {
      const captureDir = await getCaptureDir();
      const filepath = join(captureDir, filename);
      const meta = await readRedactionMetaFile(filepath);
      if (!meta) continue;

      const captureId = filename.replace(/\.redact-meta\.json$/, "") + ".json";
      const sessionId = (meta.sessionId as string | null) ?? null;
      const source = (meta.source as string | null) ?? null;
      const provider = (meta.provider as string) ?? "unknown";
      const targetUrl = (meta.targetUrl as string) ?? "";
      const timestamp = (meta.generatedAt as string) ?? new Date().toISOString();

      // Add counts to summary
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

      // Create one detail row per match (using matches array if available in meta)
      const matches = (meta.matches as Array<{ rule: string; original: string; placeholder: string; path: string }> | undefined) ?? [];
      
      if (matches.length > 0) {
        for (const match of matches) {
          allRows.push({
            redactionType: match.rule,
            requestSource: source,
            requestProvider: provider,
            requestTarget: targetUrl,
            sessionId,
            captureId,
            preRedactionValue: match.original,
            postRedactionValue: match.placeholder,
            timestamp,
          });
        }
      } else {
        // If no individual matches in meta, create a summary row
        // This indicates the meta file has counts but not individual matches
        allRows.push({
          redactionType: "summary",
          requestSource: source,
          requestProvider: provider,
          requestTarget: targetUrl,
          sessionId,
          captureId,
          preRedactionValue: `(total: ${meta.totalRedactions ?? 0})`,
          postRedactionValue: `(total: ${meta.totalRedactions ?? 0})`,
          timestamp,
        });
      }
    } catch (error) {
      console.error(`Error processing redaction meta ${filename}:`, error);
      continue;
    }
  }

  // Apply filters
  let filteredRows = allRows;
  if (Object.keys(filters).length > 0) {
    filteredRows = allRows.filter(row => {
      return Object.entries(filters).every(([key, val]) => {
        if (!val) return true;
        const cell = row[key as keyof RedactionDetailRow];
        return String(cell ?? "").toLowerCase().includes(val.toLowerCase());
      });
    });
  }

  // Apply sorting
  const sortableKeys = ["redactionType", "requestSource", "requestProvider", "requestTarget", "sessionId", "captureId"];
  if (sortKey && sortDir && sortableKeys.includes(sortKey)) {
    filteredRows = [...filteredRows].sort((a, b) => {
      const aVal = a[sortKey as keyof RedactionDetailRow];
      const bVal = b[sortKey as keyof RedactionDetailRow];
      if (aVal === null || aVal === undefined) return sortDir === "asc" ? 1 : -1;
      if (bVal === null || bVal === undefined) return sortDir === "asc" ? -1 : 1;
      if (aVal < bVal) return sortDir === "asc" ? -1 : 1;
      if (aVal > bVal) return sortDir === "asc" ? 1 : -1;
      return 0;
    });
  }

  // Apply pagination
  const totalCount = filteredRows.length;
  const totalPages = Math.max(1, Math.ceil(totalCount / pageSize));
  const clampedPage = Math.min(page, totalPages);
  const start = (clampedPage - 1) * pageSize;
  const end = start + pageSize;
  const pageRows = filteredRows.slice(start, end);

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
    const pageSize = Math.min(200, Math.max(1, parseInt(url.searchParams.get("pageSize") ?? "50", 10)));
    
    // Parse sort params
    const sortKey = url.searchParams.get("sortKey");
    const sortDir = url.searchParams.get("sortDir") === "asc" ? "asc" : 
                    url.searchParams.get("sortDir") === "desc" ? "desc" : null;
    
    // Parse filters (only valid keys)
    const validFilterKeys = ["redactionType", "requestSource", "requestProvider", "requestTarget", "sessionId", "captureId"];
    const filters: Record<string, string> = {};
    for (const [key, value] of url.searchParams.entries()) {
      if (key.startsWith("filter_") && validFilterKeys.includes(key.replace("filter_", ""))) {
        const filterKey = key.replace("filter_", "");
        if (value) filters[filterKey] = value;
      }
    }
    
    const result = await getRedactionDetailsFromMeta(page, pageSize, filters, sortKey, sortDir);
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
      return Response.json({ error: "Invalid or missing CSRF token" }, { status: 400 });
    }
    const body = (await request.json().catch(() => ({}))) as { action?: string };
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