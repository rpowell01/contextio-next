import fs from "fs/promises";
import { join } from "path";

import {
  getCaptureDir,
  listCaptureFiles,
  listRedactionMetaFiles,
  MAX_FILE_SIZE,
  readCaptureFile,
  readRedactionMetaFile,
} from "@/lib/sessions/utils";
import {
  computeCaptureRedactionCounts,
  getCaptureRedactionStats,
} from "@/lib/sessions/redaction-utils";
import { consumeToken } from "@/lib/csrf";
import { unstable_cache } from "next/cache";

interface RedactionSummary {
  totalRedactions: number;
  byType: Record<string, number>;
}

// Cached summary computation - revalidates every 30 seconds
const getRedactionsSummary = unstable_cache(
  async (): Promise<RedactionSummary> => {
    const metaFiles = await listRedactionMetaFiles();
    let totalRedactions = 0;
    const byType: Record<string, number> = {};

    for (const filename of metaFiles) {
      try {
        const filepath = join(getCaptureDir(), filename);
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

interface RedactionDetailRow {
  redactionType: string;
  requestSource: string | null;
  requestProvider: string;
  requestTarget: string;
  sessionId: string | null;
  captureId: string;
  preRedactionValue: string;
  postRedactionValue: string;
}

export async function GET(request: Request) {
  try {
    // Check for summary=true query parameter for fast aggregated counts
    const url = new URL(request.url);
    const summaryOnly = url.searchParams.get("summary") === "true";

    if (summaryOnly) {
      // Fast path: use cached summary computation
      const { totalRedactions, byType } = await getRedactionsSummary();
      return Response.json({ summary: { totalRedactions, byType } });
    }

    // Full detail path (existing behavior)
    const files = await listCaptureFiles();
    let totalRedactions = 0;
    const byType: Record<string, number> = {};
    const detailRows: RedactionDetailRow[] = [];

    for (const filename of files) {
      try {
        const filepath = join(getCaptureDir(), filename);
        const stats = await fs.stat(filepath);
        if (stats.size > MAX_FILE_SIZE) continue;

        const data = await readCaptureFile(filepath);
        if (!data) continue;

        // Extract capture metadata (similar to extractCaptureMetadata in captures/route.ts)
        const sessionId =
          (data.sessionId as string | null) ??
          extractSessionFromFilename(filename);
        const source = (data.source as string | null) ?? null;
        const provider = (data.provider as string) ?? "unknown";
        const targetUrl = (data.targetUrl as string) ?? "";
        const captureId = filename;

        const cached = getCaptureRedactionStats(data);

        if (cached) {
          // Canonical stats from the redact plugin
          totalRedactions += cached.totalRedactions;
          for (const [rule, count] of Object.entries(cached.byRule)) {
            byType[rule] = (byType[rule] ?? 0) + count;
          }

          let originalBody: unknown | undefined;
          try {
            if (
              typeof data.originalRequestBody === "object" &&
              data.originalRequestBody !== null &&
              JSON.stringify(data.originalRequestBody).length <= MAX_FILE_SIZE
            ) {
              originalBody = data.originalRequestBody;
            }
          } catch {
            // JSON.stringify threw (likely RangeError), skip original body
          }

          const redaction = computeCaptureRedactionCounts(
            data,
            false,
            cached,
            originalBody,
          );
          for (const match of redaction.matches) {
            detailRows.push({
              redactionType: match.ruleId,
              requestSource: source,
              requestProvider: provider,
              requestTarget: targetUrl,
              sessionId,
              captureId,
              preRedactionValue: match.original,
              postRedactionValue: match.placeholder,
            });
          }
        } else {
          // Legacy capture without redactionStats; recompute from raw bodies
          let originalBody: unknown | undefined;
          try {
            if (
              typeof data.originalRequestBody === "object" &&
              data.originalRequestBody !== null &&
              JSON.stringify(data.originalRequestBody).length <= MAX_FILE_SIZE
            ) {
              originalBody = data.originalRequestBody;
            }
          } catch {
            // JSON.stringify threw (likely RangeError), skip original body
          }

          const redaction = computeCaptureRedactionCounts(
            data,
            false,
            undefined,
            originalBody,
          );

          totalRedactions += redaction.totalRedactions;
          for (const [rule, count] of Object.entries(redaction.byRule)) {
            byType[rule] = (byType[rule] ?? 0) + count;
          }
          for (const match of redaction.matches) {
            detailRows.push({
              redactionType: match.ruleId,
              requestSource: source,
              requestProvider: provider,
              requestTarget: targetUrl,
              sessionId,
              captureId,
              preRedactionValue: match.original,
              postRedactionValue: match.placeholder,
            });
          }
        }
      } catch (error) {
        console.error(`Error processing capture ${filename}:`, error);
        continue;
      }
    }

    return Response.json({
      summary: { totalRedactions, byType },
      details: detailRows,
    });
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
    // Reuse GET logic to recompute stats from capture files
    const files = await listCaptureFiles();
    let totalRedactions = 0;
    const byType: Record<string, number> = {};
    const detailRows: RedactionDetailRow[] = [];
    for (const filename of files) {
      try {
        const filepath = join(getCaptureDir(), filename);
        const stats = await fs.stat(filepath);
        if (stats.size > MAX_FILE_SIZE) continue;
        const data = await readCaptureFile(filepath);
        if (!data) continue;
        const sessionId = (data.sessionId as string | null) ?? extractSessionFromFilename(filename);
        const source = (data.source as string | null) ?? null;
        const provider = (data.provider as string) ?? "unknown";
        const targetUrl = (data.targetUrl as string) ?? "";
        const captureId = filename;
        const cached = getCaptureRedactionStats(data);
        if (cached) {
          totalRedactions += cached.totalRedactions;
          for (const [rule, count] of Object.entries(cached.byRule)) {
            byType[rule] = (byType[rule] ?? 0) + count;
          }
          let originalBody: unknown | undefined;
          try {
            if (typeof data.originalRequestBody === "object" && data.originalRequestBody !== null && JSON.stringify(data.originalRequestBody).length <= MAX_FILE_SIZE) {
              originalBody = data.originalRequestBody;
            }
          } catch {
            // skip original body on error
          }
          const redaction = computeCaptureRedactionCounts(
            data,
            false,
            cached,
            originalBody,
          );
          for (const match of redaction.matches) {
            detailRows.push({
              redactionType: match.ruleId,
              requestSource: source,
              requestProvider: provider,
              requestTarget: targetUrl,
              sessionId,
              captureId,
              preRedactionValue: match.original,
              postRedactionValue: match.placeholder,
            });
          }
        } else {
          let originalBody: unknown | undefined;
          try {
            if (typeof data.originalRequestBody === "object" && data.originalRequestBody !== null && JSON.stringify(data.originalRequestBody).length <= MAX_FILE_SIZE) {
              originalBody = data.originalRequestBody;
            }
          } catch {
            // skip original body on error
          }
          const redaction = computeCaptureRedactionCounts(
            data,
            false,
            undefined,
            originalBody,
          );
          totalRedactions += redaction.totalRedactions;
          for (const [rule, count] of Object.entries(redaction.byRule)) {
            byType[rule] = (byType[rule] ?? 0) + count;
          }
          for (const match of redaction.matches) {
            detailRows.push({
              redactionType: match.ruleId,
              requestSource: source,
              requestProvider: provider,
              requestTarget: targetUrl,
              sessionId,
              captureId,
              preRedactionValue: match.original,
              postRedactionValue: match.placeholder,
            });
          }
        }
      } catch (error) {
        console.error(`Error processing capture ${filename}:`, error);
        continue;
      }
    }
    return Response.json({ success: true, summary: { totalRedactions, byType }, details: detailRows });
  } catch (error) {
    console.error("Error in redactions POST API:", error);
    return Response.json({ error: "Internal server error" }, { status: 500 });
  }
}

function extractSessionFromFilename(filename: string): string | null {
  // Filename format: <sessionId>-<index>.json or similar
  const match = filename.match(/^([a-f0-9-]+)-\d+\.json$/i);
  if (match) return match[1];
  return null;
}