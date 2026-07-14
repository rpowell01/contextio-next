import fs from "fs/promises";
import { join } from "path";

import {
  getCaptureDir,
  listCaptureFiles,
  MAX_FILE_SIZE,
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
  fullOriginal?: string;
  fullRedacted?: string;
}

interface PaginatedDetailResponse {
  details: RedactionDetailRow[];
  page: number;
  pageSize: number;
  totalPages: number;
  totalCount: number;
}

function extractSessionFromFilename(filename: string): string | null {
  const match = filename.match(/^([a-f0-9-]+)-\d+\.json$/i);
  if (match) return match[1];
  return null;
}

export async function GET(request: Request): Promise<Response> {
  try {
    const url = new URL(request.url);
    const page = Math.max(1, parseInt(url.searchParams.get("page") ?? "1", 10));
    const pageSize = Math.min(
      200,
      Math.max(1, parseInt(url.searchParams.get("pageSize") ?? "50", 10)),
    );

    const files = await listCaptureFiles();
    const totalCount = files.length;
    const totalPages = Math.ceil(totalCount / pageSize);

    // Clamp page to valid range
    const clampedPage = Math.min(page, totalPages || 1);
    const start = (clampedPage - 1) * pageSize;
    const end = Math.min(start + pageSize, totalCount);

    const pageFiles = files.slice(start, end);

    const detailRows: RedactionDetailRow[] = [];

    for (const filename of pageFiles) {
      try {
        const filepath = join(getCaptureDir(), filename);
        const stats = await fs.stat(filepath);
        if (stats.size > MAX_FILE_SIZE) continue;

        const raw = await fs.readFile(filepath, "utf8");
        const data = JSON.parse(raw) as Record<string, unknown>;

        const sessionId =
          (data.sessionId as string | null) ??
          extractSessionFromFilename(filename);
        const source = (data.source as string | null) ?? null;
        const provider = (data.provider as string) ?? "unknown";
        const targetUrl = (data.targetUrl as string) ?? "";
        const captureId = filename;

        const cached = getCaptureRedactionStats(data);

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

        // Prepare full original and redacted request bodies for dialog context
        const fullOriginal = data.originalRequestBody !== undefined
          ? JSON.stringify(data.originalRequestBody, null, 2)
          : "";
        const fullRedacted = data.requestBody !== undefined
          ? JSON.stringify(data.requestBody, null, 2)
          : "";

        const redaction = computeCaptureRedactionCounts(
          data,
          false,
          cached ?? undefined,
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
            fullOriginal,
            fullRedacted,
          });
        }
      } catch (error) {
        console.error(`Error processing capture ${filename}:`, error);
        continue;
      }
    }

    const response: PaginatedDetailResponse = {
      details: detailRows,
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