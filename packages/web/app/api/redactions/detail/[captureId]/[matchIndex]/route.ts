import { join } from "path";

import {
  getCaptureDir,
  readRedactionMetaFile,
  readCaptureFile,
  metaFilenameFor,
} from "@/lib/sessions/server-utils";

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

interface MetaMatch {
  ruleId?: string;
  rule?: string;
  original?: string;
  placeholder?: string;
  preValue?: string;
  postValue?: string;
  pre?: string;
  post?: string;
  path?: string;
}

export async function GET(
  _request: Request,
  { params }: { params: Promise<{ captureId: string; matchIndex: string }> }
): Promise<Response> {
  return withRequestCache(async () => {
    try {
      const { captureId, matchIndex } = await params;

      // Load the capture file for metadata and body content
      const captureDir = await getCaptureDir();

      // Load the capture file (metadata + body content)
      const captureFileName = captureId.replace(/\.json$/, "") + ".json";
      const capturePath = join(captureDir, captureFileName);
      const captureData = await readCaptureFile(capturePath);

      if (!captureData) {
        return Response.json({ error: "Capture file not found" }, { status: 404 });
      }

      // Load the redaction meta file to get matches (authoritative source)
      const metaFilename = metaFilenameFor(captureId);
      const metaPath = join(captureDir, metaFilename);
      const meta = await readRedactionMetaFile(metaPath);

      if (!meta) {
        return Response.json({ error: "Redaction metadata not found" }, { status: 404 });
      }

      // Get matches from meta file (authoritative source for match ordering)
      const matches = (meta.matches as MetaMatch[] | undefined) ?? [];

      // If no matches but we have byRule data (e.g., meta created by web UI), synthesize a match
      // from the first rule so the diff dialog can show the full body comparison.
      const byRule = (meta.byRule as Record<string, number> | undefined) ?? {};
      const hasByRuleData = Object.keys(byRule).length > 0;

      let match: MetaMatch;
      let redactionType: string;

      if (matches.length > 0) {
        const index = parseInt(matchIndex, 10);
        if (isNaN(index) || index < 0 || index >= matches.length) {
          return Response.json(
            {
              error: "Match index out of range",
              totalMatches: matches.length,
            },
            { status: 400 }
          );
        }
        match = matches[index];

        // Use same field fallback logic as list API
        const preRedactionValue =
          (match.original ?? match.preValue ?? match.pre ?? "") as string;
        const postRedactionValue =
          (match.placeholder ?? match.postValue ?? match.post ?? "") as string;
        redactionType = (match.ruleId ?? match.rule ?? "") as string;

        // Build the response
        const response: RedactionDetailResponse = {
          redactionType,
          requestSource: (captureData.source as string | null) ?? null,
          requestProvider: (captureData.provider as string) ?? "unknown",
          requestTarget: (captureData.targetUrl as string) ?? "",
          sessionId: (captureData.sessionId as string | null) ?? null,
          captureId,
          preRedactionValue,
          postRedactionValue,
          // Use meta.generatedAt with fallback to capture timestamp (consistent with list API)
          timestamp: (meta.generatedAt as string) ?? (captureData.timestamp as string) ?? new Date().toISOString(),
        };

        // Include full original/redacted values where available
        return buildFullBodyResponse(response, captureData, match);
      } else if (hasByRuleData) {
        // No matches array (meta created by web UI), but we have byRule counts.
        // Synthesize a response with the first rule type and full body diff.
        const firstRule = Object.keys(byRule)[0];
        redactionType = firstRule;

        // For synthesized matches, we don't have specific pre/post values,
        // but we can still show the full body diff.
        const response: RedactionDetailResponse = {
          redactionType,
          requestSource: (captureData.source as string | null) ?? null,
          requestProvider: (captureData.provider as string) ?? "unknown",
          requestTarget: (captureData.targetUrl as string) ?? "",
          sessionId: (captureData.sessionId as string | null) ?? null,
          captureId,
          preRedactionValue: "",
          postRedactionValue: "",
          // Use meta.generatedAt with fallback to capture timestamp
          timestamp: (meta.generatedAt as string) ?? (captureData.timestamp as string) ?? new Date().toISOString(),
        };

        // Build synthetic match for full body response logic
        const syntheticMatch: MetaMatch = { ruleId: firstRule, path: "" };
        return buildFullBodyResponse(response, captureData, syntheticMatch);
      } else {
        return Response.json({ error: "No redactions found in this capture" }, { status: 404 });
      }
    } catch (error) {
      console.error("Error in redaction detail API:", error);
      return Response.json({ error: "Internal server error" }, { status: 500 });
    }
  });
}

function buildFullBodyResponse(
  response: RedactionDetailResponse,
  captureData: Record<string, unknown>,
  match: MetaMatch
): Response {
  // Include full original/redacted values where available
  const requestBody = captureData.requestBody;
  const originalRequestBody = captureData.originalRequestBody;
  const responseBody = captureData.responseBody;
  const originalResponseBody = captureData.originalResponseBody;

  // Determine if this is a response body redaction.
  // - Watcher writes paths with "requestBody." or "responseBody" prefix
  // - Redact plugin writes paths without prefix (e.g., "user.email") and only redacts request bodies
  const path = match.path ?? "";
  const isResponseRedaction = path.startsWith("responseBody");

  if (isResponseRedaction && originalResponseBody) {
    try {
      response.fullOriginal = JSON.stringify(originalResponseBody, null, 2);
    } catch {
      response.fullOriginal = "(unable to serialize original body)";
    }
  } else if (originalRequestBody) {
    try {
      response.fullOriginal = JSON.stringify(originalRequestBody, null, 2);
    } catch {
      response.fullOriginal = "(unable to serialize original body)";
    }
  }

  if (isResponseRedaction && responseBody) {
    try {
      response.fullRedacted = JSON.stringify(responseBody, null, 2);
    } catch {
      response.fullRedacted = "(unable to serialize redacted body)";
    }
  } else if (requestBody) {
    try {
      response.fullRedacted = JSON.stringify(requestBody, null, 2);
    } catch {
      response.fullRedacted = "(unable to serialize redacted body)";
    }
  }

  return Response.json(response);
}

export async function POST(_request: Request) {
  return Response.json({ error: "Method not allowed" }, { status: 405 });
}
