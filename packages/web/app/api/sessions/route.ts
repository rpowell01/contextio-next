import fs from "fs/promises";
import { join } from "path";
import type { Session } from "@/types/api";
import {
  listCaptureFiles,
  getCaptureDir,
  MAX_FILE_SIZE,
  readCaptureFile,
  listRedactionMetaFiles,
  loadRedactionMeta,
  getSessionMetadata,
} from "@/lib/sessions/server-utils";
import { withRequestCache } from "@/lib/request-cache";
import { groupCapturesIntoSessions } from "@/lib/sessions/grouping";
import {
  convertByRuleToByPlaceholder,
  computePlaceholderCounts,
} from "@/lib/sessions/placeholder-map";

interface RawCaptureData extends Record<string, unknown> {
  sessionId: string | null;
  source: string | null;
  provider: string;
  apiFormat?: string;
  targetUrl: string;
  requestBytes: number;
  responseBytes: number;
  timings: { total_ms: number };
  timestamp: string;
  requestBody?: unknown;
  responseBody?: string;
  responseStatus?: number;
  responseIsStreaming?: boolean;
  redactionStats?: {
    totalRedactions: number;
    byRule: Record<string, number>;
  };
}

async function handleGet(request: Request): Promise<Response> {
  const url = new URL(request.url);
  const groupBySourceDest =
    url.searchParams.get("groupBySourceDest") === "true";
  const pageValue = Number(url.searchParams.get("page"));
  const page = Number.isFinite(pageValue) && pageValue > 0 ? pageValue : 1;
  const pageSizeValue = Number(url.searchParams.get("pageSize"));
  const pageSize =
    Number.isFinite(pageSizeValue) && pageSizeValue > 0
      ? pageSizeValue
      : 20;
  const pathParts = url.pathname.split("/").filter(Boolean);

  // Check if we're requesting a specific session by ID
  if (
    pathParts.length >= 2 &&
    pathParts[0] === "api" &&
    pathParts[1] === "sessions" &&
    pathParts[2]
  ) {
    // ... existing session detail code unchanged ...
  }

  const files = await listCaptureFiles();
  const sessions: Session[] = [];

  for (const filename of files) {
    try {
      const captureDir = await getCaptureDir();
      const filepath = join(captureDir, filename);
      const stats = await fs.stat(filepath);
      if (stats.size > MAX_FILE_SIZE) continue;
      const data = await readCaptureFile(filepath);
      if (!data) continue;
      const session = await getSessionMetadata(filename, data);
      sessions.push(session);
    } catch (error) {
      console.error(
        `Error processing session capture ${filename}:`,
        error,
      );
      continue;
    }
  }

  // Sort by timestamp descending (newest first)
  sessions.sort(
    (a, b) =>
      new Date(b.timestamp).getTime() - new Date(a.timestamp).getTime(),
  );

  // Strip heavy body fields from list responses to avoid RangeError in JSON.stringify
  const listSessions = sessions.map(
    ({ requestBody: _rb, responseBody: _rsp, ...rest }) => rest,
  );

  // Apply pagination for non-grouped list
  if (!groupBySourceDest) {
    const startIndex = (page - 1) * pageSize;
    const endIndex = startIndex + pageSize;
    const paginatedSessions = listSessions.slice(startIndex, endIndex);
    const totalPages = Math.ceil(listSessions.length / pageSize);
    return Response.json({
      sessions: paginatedSessions,
      pagination: {
        page,
        pageSize,
        totalPages,
        totalItems: listSessions.length,
      },
    });
  }

  // Return grouped summaries if requested
  if (groupBySourceDest) {
    // Load pre-aggregated redaction metadata from .redact-meta.json files
    // Include ALL captures per session to accurately count captures per session
    // (skip title-* sessions only, no deduping by sessionId)
    const metaFiles = await listRedactionMetaFiles();
    metaFiles.sort();

    const redactionMetaBySession = new Map<
      string,
      { totalRedactions: number; byRule: Record<string, number> }
    >();

    const rawCaptures: RawCaptureData[] = [];

    for (const filename of metaFiles) {
      try {
        const meta = await loadRedactionMeta(filename);
        if (!meta) continue;

        // Skip title-* sessions (match Redactions page behavior)
        if (meta.sessionId?.startsWith("title-")) continue;

        // Store redaction metadata for this session - use matches for accurate placeholders
        // Accumulate across all captures for the same session
        if (meta.sessionId) {
          // Prefer computing placeholders from actual matches (what's in content)
          const byPlaceholder = meta.matches && Array.isArray(meta.matches)
            ? computePlaceholderCounts(meta.matches as unknown as Array<{ ruleId: string; placeholder?: string; postValue?: string }>)
            : convertByRuleToByPlaceholder((meta.byRule as Record<string, number>) ?? {});

          const existing = redactionMetaBySession.get(meta.sessionId);
          if (existing) {
            // Accumulate redaction counts across all captures in this session
            existing.totalRedactions += meta.totalRedactions ?? 0;
            for (const [rule, count] of Object.entries(byPlaceholder)) {
              existing.byRule[rule] = (existing.byRule[rule] ?? 0) + count;
            }
          } else {
            redactionMetaBySession.set(meta.sessionId, {
              totalRedactions: meta.totalRedactions ?? 0,
              byRule: byPlaceholder,
            });
          }
        }

        // Extract timings - default to 0 if not present
        const timings = meta.timings
          ? { total_ms: meta.timings.total_ms ?? 0 }
          : { total_ms: 0 };

        rawCaptures.push({
          sessionId: meta.sessionId,
          source: meta.source ?? "unknown",
          provider: meta.provider ?? "unknown",
          targetUrl: meta.targetUrl ?? "",
          requestBytes: meta.requestBytes ?? 0,
          responseBytes: meta.responseBytes ?? 0,
          timings,
          timestamp: meta.timestamp ?? new Date().toISOString(),
          requestBody: undefined,
          responseBody: undefined,
        });
      } catch (error) {
        console.error(
          `Error reading metadata for grouped sessions ${filename}:`,
          error,
        );
        continue;
      }
    }

    const { summaries, metrics } = groupCapturesIntoSessions(
      rawCaptures,
      redactionMetaBySession,
    );
    summaries.sort(
      (a, b) =>
        new Date(b.firstTimestamp).getTime() -
        new Date(a.firstTimestamp).getTime(),
    );

    // Apply pagination to summaries
    const startIndex = (page - 1) * pageSize;
    const endIndex = startIndex + pageSize;
    const paginatedSummaries = summaries.slice(startIndex, endIndex);
    const totalPages = Math.ceil(summaries.length / pageSize);

    return Response.json({
      sessions: [],
      summaries: paginatedSummaries,
      metrics,
      pagination: {
        page,
        pageSize,
        totalPages,
        totalItems: summaries.length,
      },
    });
  }

  // For non-grouped list without pagination params, return all
  return Response.json(listSessions);
}

export async function GET(request: Request) {
  try {
    return await withRequestCache(() => handleGet(request));
  } catch (error) {
    console.error("Error in sessions API:", error);
    return Response.json({ error: "Internal server error" }, { status: 500 });
  }
}
