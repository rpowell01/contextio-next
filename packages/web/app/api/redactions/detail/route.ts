import { join } from "path";

import {
  getCaptureDir,
  listRedactionMetaFiles,
  MAX_FILE_SIZE,
  readCaptureFile,
  readRedactionMetaFile,
  extractRedactionMatches,
} from "@/lib/sessions/utils";

interface RedactionDetailRow {
  redactionType: string;
  requestSource: string | null;
  requestProvider: string;
  requestTarget: string;
  sessionId: string | null;
  captureId: string;
  preRedactionValue: string;
  postRedactionValue: string;
  fullOriginal?: string;
  fullRedacted?: string;
  timestamp: string;
}

// Minimal row for initial collection (without heavy stringified bodies)
interface MinimalRedactionRow {
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

interface PaginatedDetailResponse {
  details: RedactionDetailRow[];
  page: number;
  pageSize: number;
  totalPages: number;
  totalCount: number;
}

// Valid column keys for filtering/sorting (must match RedactionDetailRow / MinimalRedactionRow)
const VALID_COLUMN_KEYS = [
  "redactionType",
  "requestSource",
  "requestProvider",
  "requestTarget",
  "sessionId",
  "captureId",
  "timestamp",
  "preRedactionValue",
  "postRedactionValue",
] as const;

type ValidColumnKey = typeof VALID_COLUMN_KEYS[number];

function isValidColumnKey(key: string): key is ValidColumnKey {
  return VALID_COLUMN_KEYS.includes(key as ValidColumnKey);
}

interface SortParams {
  key: ValidColumnKey;
  direction: "asc" | "desc";
}

// Use a stricter type for filters: only valid column keys with string values
type FilterParams = Partial<Record<ValidColumnKey, string>>;

function applyFilters(rows: MinimalRedactionRow[], filters: FilterParams): MinimalRedactionRow[] {
  if (!filters || Object.keys(filters).length === 0) return rows;
  return rows.filter(row => {
    return Object.entries(filters).every(([key, val]) => {
      if (!val) return true;
      const cell = row[key as keyof MinimalRedactionRow];
      return String(cell ?? "").toLowerCase().includes(val.toLowerCase());
    });
  });
}

function applySort(rows: MinimalRedactionRow[], sort: SortParams | null): MinimalRedactionRow[] {
  if (!sort) return rows;
  const { key, direction } = sort;
  return [...rows].sort((a, b) => {
    const aVal = a[key];
    const bVal = b[key];
    if (aVal === null || aVal === undefined) return direction === "asc" ? 1 : -1;
    if (bVal === null || bVal === undefined) return direction === "asc" ? -1 : 1;
    if (aVal < bVal) return direction === "asc" ? -1 : 1;
    if (aVal > bVal) return direction === "asc" ? 1 : -1;
    return 0;
  });
}

// Enrich page rows with fullOriginal/fullRedacted (stringified bodies)
function enrichPageRows(
  pageRows: MinimalRedactionRow[],
  captureBodies: Map<string, { originalRequestBody: unknown; requestBody: unknown }>
): RedactionDetailRow[] {
  return pageRows.map(row => {
    const bodies = captureBodies.get(row.captureId);
    
    // Safely stringify bodies with size/circular guards
    let fullOriginal = "";
    if (bodies?.originalRequestBody !== undefined) {
      try {
        const str = JSON.stringify(bodies.originalRequestBody, null, 2);
        fullOriginal = str.length > MAX_FILE_SIZE ? "" : str;
      } catch {
        fullOriginal = "";
      }
    }
    
    let fullRedacted = "";
    if (bodies?.requestBody !== undefined) {
      try {
        const str = JSON.stringify(bodies.requestBody, null, 2);
        fullRedacted = str.length > MAX_FILE_SIZE ? "" : str;
      } catch {
        fullRedacted = "";
      }
    }
    
    return {
      redactionType: row.redactionType,
      requestSource: row.requestSource,
      requestProvider: row.requestProvider,
      requestTarget: row.requestTarget,
      sessionId: row.sessionId,
      captureId: row.captureId,
      preRedactionValue: row.preRedactionValue,
      postRedactionValue: row.postRedactionValue,
      fullOriginal,
      fullRedacted,
      timestamp: row.timestamp,
    };
  });
}

export async function GET(request: Request): Promise<Response> {
  try {
    const url = new URL(request.url);
    const pageParam = parseInt(url.searchParams.get("page") ?? "1", 10);
    const pageSizeParam = parseInt(url.searchParams.get("pageSize") ?? "50", 10);
    const page = Number.isNaN(pageParam) ? 1 : Math.max(1, pageParam);
    const pageSize = Number.isNaN(pageSizeParam)
      ? 50
      : Math.min(200, Math.max(1, pageSizeParam));

    // Parse filter parameters
    const filters: FilterParams = {};
    for (const [key, value] of url.searchParams.entries()) {
      if (key.startsWith("filter_")) {
        const filterKey = key.replace("filter_", "");
        if (isValidColumnKey(filterKey)) {
          filters[filterKey] = value;
        }
      }
    }

    // Parse sort parameters
    let sort: SortParams | null = null;
    const sortKey = url.searchParams.get("sortKey");
    const sortDir = url.searchParams.get("sortDir");
    if (sortKey && isValidColumnKey(sortKey) && (sortDir === "asc" || sortDir === "desc")) {
      sort = { key: sortKey, direction: sortDir };
    }

    // Use pre-aggregated redaction meta files for fast listing
    const metaFiles = await listRedactionMetaFiles();
    
    // Collect ALL redaction matches across all meta files (not paginated yet)
    // This is necessary for correct filtering/sorting across the entire dataset
    const allDetailRows: MinimalRedactionRow[] = [];

    for (const metaFilename of metaFiles) {
      try {
        const metaPath = join(getCaptureDir(), metaFilename);
        const meta = await readRedactionMetaFile(metaPath);
        if (!meta) continue;

        // Extract capture ID from meta filename
        const captureId = metaFilename.replace(/\.redact-meta\.json$/, "");

// Use meta file fields directly - no need to read capture file for metadata
        const source = (meta.source as string | null) ?? null;
        const provider = (meta.provider as string) ?? "unknown";
        const sessionId = (meta.sessionId as string | null) ?? null;

        // For the full list we need individual match rows.
        // We'll load the capture file to extract matches (on-demand, but for all files during init).
        // This is heavier but only done once per request.
        const capturePath = join(getCaptureDir(), captureId);
        const captureData = await readCaptureFile(capturePath);
        
        let matches: Array<{ ruleId: string; original: string; placeholder: string }> = [];
        if (captureData) {
          const extracted = extractRedactionMatches(captureData);
          matches = extracted.map(m => ({
            ruleId: m.rule,
            original: m.original,
            placeholder: m.placeholder
          }));
        }
        
        if (matches.length === 0) continue;

        for (const match of matches) {
          allDetailRows.push({
            redactionType: match.rule,
            requestSource: source,
            requestProvider: provider,
            requestTarget: (meta.targetUrl as string) ?? "",
            sessionId,
            captureId,
            preRedactionValue: match.original,
            postRedactionValue: match.placeholder,
            timestamp: (typeof meta.generatedAt === "string" ? meta.generatedAt : "") ?? new Date().toISOString(),
          });
        }
      } catch (error) {
        console.error(`Error processing redaction meta ${metaFilename}:`, error);
        continue;
      }
    }

    // Apply filters and sorting to the full dataset
    const filteredRows = applyFilters(allDetailRows, filters);
    const sortedRows = applySort(filteredRows, sort);

    const totalCount = sortedRows.length;
    const totalPages = Math.ceil(totalCount / pageSize);

    // Clamp page to valid range
    const clampedPage = Math.min(page, totalPages || 1);
    const start = (clampedPage - 1) * pageSize;
    const end = Math.min(start + pageSize, totalCount);

    const pageRows = sortedRows.slice(start, end);

    // Fetch bodies only for page rows (memory optimization)
    const neededCaptureIds = new Set(pageRows.map(r => r.captureId));
    const captureBodies = new Map<string, { originalRequestBody: unknown; requestBody: unknown }>();

    for (const captureId of neededCaptureIds) {
      try {
        const capturePath = join(getCaptureDir(), captureId);
        const data = await readCaptureFile(capturePath);
        if (!data) continue;

        captureBodies.set(captureId, {
          originalRequestBody: data.originalRequestBody,
          requestBody: data.requestBody,
        });
      } catch (error) {
        console.error(`Error fetching body for capture ${captureId}:`, error);
      }
    }

    // Enrich only the page rows with fullOriginal/fullRedacted (stringified bodies)
    const enrichedPageRows = enrichPageRows(pageRows, captureBodies);

    const response: PaginatedDetailResponse = {
      details: enrichedPageRows,
      page: clampedPage,
      pageSize,
      totalPages: totalPages || 1,
      totalCount,
    };

    return Response.json(response);
  } catch (error) {
    console.error("Error in redactions detail API:", error);
    return Response.json(
      { error: "Internal server error" },
      { status: 500 },
    );
  }
}