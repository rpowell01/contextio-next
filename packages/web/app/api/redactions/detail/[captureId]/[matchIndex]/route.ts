import { join } from "path";

import {
  getCaptureDir,
  readCaptureFile,
  extractRedactionMatches,
} from "@/lib/sessions/utils";
import { withRequestCache } from "@/lib/request-cache";

interface RedactionDetailResponse {
  redactionType: string;
  requestSource: string | null;
  requestProvider: string;
  requestTarget: string;
  sessionId: string | null;
  captureId: string;
  preRedactionValue: string;
  postRedactionValue: string;
  timestamp: string;
  fullOriginal?: string;
  fullRedacted?: string;
}

export async function GET(
  _request: Request,
  { params }: { params: Promise<{ captureId: string; matchIndex: string }> }
): Promise<Response> {
  return withRequestCache(async () => {
    try {
      const { captureId, matchIndex } = await params;

      // Load the capture file to extract individual matches
      const captureDir = await getCaptureDir();
      const capturePath = join(captureDir, captureId);
      const captureData = await readCaptureFile(capturePath);

      if (!captureData) {
        return Response.json({ error: "Capture file not found" }, { status: 404 });
      }

      // Extract all matches from the capture
      const matches = extractRedactionMatches(captureData);

      if (matches.length === 0) {
        return Response.json({ error: "No redactions found in this capture" }, { status: 404 });
      }

      // Parse match index
      const index = parseInt(matchIndex, 10);
      if (isNaN(index) || index < 0 || index >= matches.length) {
        return Response.json({
          error: "Match index out of range",
          totalMatches: matches.length
        }, { status: 400 });
      }

      const match = matches[index];

      // Build the response
      const response: RedactionDetailResponse = {
        redactionType: match.rule,
        requestSource: (captureData.source as string | null) ?? null,
        requestProvider: (captureData.provider as string) ?? "unknown",
        requestTarget: (captureData.targetUrl as string) ?? "",
        sessionId: (captureData.sessionId as string | null) ?? null,
        captureId,
        preRedactionValue: match.original || "",
        postRedactionValue: match.placeholder || "",
        timestamp: (captureData.timestamp as string) ?? new Date().toISOString(),
      };

      // Include full original/redacted values if available
      const requestBody = captureData.requestBody;
      const originalRequestBody = captureData.originalRequestBody;

      if (originalRequestBody) {
        try {
          const str = JSON.stringify(originalRequestBody, null, 2);
          response.fullOriginal = str;
        } catch {
          response.fullOriginal = "(unable to serialize original body)";
        }
      }

      if (requestBody) {
        try {
          const str = JSON.stringify(requestBody, null, 2);
          response.fullRedacted = str;
        } catch {
          response.fullRedacted = "(unable to serialize redacted body)";
        }
      }

      return Response.json(response);
    } catch (error) {
      console.error("Error in redaction detail API:", error);
      return Response.json({ error: "Internal server error" }, { status: 500 });
    }
  });
}

export async function POST(_request: Request) {
  return Response.json({ error: "Method not allowed" }, { status: 405 });
}