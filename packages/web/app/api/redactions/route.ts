import fs from "fs/promises";
import { join } from "path";

import {
  getCaptureDir,
  MAX_FILE_SIZE,
  listCaptureFiles,
} from "@/lib/sessions/utils";
import {
  computeCaptureRedactionCounts,
  getCaptureRedactionStats,
} from "@/lib/sessions/redaction-utils";

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

export async function GET(_request: Request) {
  try {
    const files = await listCaptureFiles();
    let totalRedactions = 0;
    const byType: Record<string, number> = {};
    const detailRows: RedactionDetailRow[] = [];

    for (const filename of files) {
      try {
        const filepath = join(getCaptureDir(), filename);
        const stats = await fs.stat(filepath);
        if (stats.size > MAX_FILE_SIZE) continue;

        const raw = await fs.readFile(filepath, "utf8");
        const data = JSON.parse(raw) as Record<string, unknown>;

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
    if (
      typeof data.originalRequestBody === "object" &&
      data.originalRequestBody !== null &&
      JSON.stringify(data.originalRequestBody).length <= MAX_FILE_SIZE
    ) {
      originalBody = data.originalRequestBody;
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
    if (
      typeof data.originalRequestBody === "object" &&
      data.originalRequestBody !== null &&
      JSON.stringify(data.originalRequestBody).length <= MAX_FILE_SIZE
    ) {
      originalBody = data.originalRequestBody;
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

function extractSessionFromFilename(filename: string): string | null {
  // Filename format: <sessionId>-<index>.json or similar
  const match = filename.match(/^([a-f0-9-]+)-\d+\.json$/i);
  if (match) return match[1];
  return null;
}
