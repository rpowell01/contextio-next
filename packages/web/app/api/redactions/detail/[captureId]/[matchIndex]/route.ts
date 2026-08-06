import { join } from "path";

import {
  getCaptureDir,
  readCaptureFile,
  extractRedactionMatches,
} from "@/lib/sessions/server-utils";
import {
  getRedactionMetadataByCaptureIdFromDb,
} from "@/lib/sessions/db-utils";

import { withRequestCache } from "@/lib/request-cache";
import { createErrorResponse, createSuccessResponse } from "@contextio/core";

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
  // All matches for this capture with their pre/post values for precise diff highlighting
  matches?: Array<{
    ruleId: string;
    preValue: string;
    postValue: string;
    path: string;
  }>;
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
    const { captureId, matchIndex } = await params;
    try {

      // Load the capture file for metadata and body content
      const captureDir = await getCaptureDir();

      // Load the capture file (metadata + body content)
      const captureFileName = captureId.replace(/\.json$/, "") + ".json";
      const capturePath = join(captureDir, captureFileName);
      const captureData = await readCaptureFile(capturePath);

      if (!captureData) {
        return Response.json(createErrorResponse({ message: "Capture file not found", status: 404 }), { status: 404 });
      }

      // Load the redaction metadata from SQLite
      const meta = await getRedactionMetadataByCaptureIdFromDb(captureId.replace(/\.json$/, ""));

      if (!meta) {
        return Response.json(createErrorResponse({ message: "Redaction metadata not found", status: 404 }), { status: 404 });
      }

      // Get matches from capture data (since SQLite doesn't store individual matches)
      // Note: extractRedactionMatches returns the full string as 'original', not the pre-redaction value.
      // This is a known limitation; the old meta.matches had actual pre/post values.
      const matches = extractRedactionMatches(captureData);

      // Convert matches to MetaMatch format
      const metaMatches: MetaMatch[] = matches.map((m) => ({
        ruleId: m.rule,
        original: m.original,
        placeholder: m.placeholder,
        preValue: m.original,
        postValue: m.placeholder,
        path: m.path,
      }));

      // If no matches but we have byRule data (e.g., meta created by web UI), synthesize a match
      // from the first rule so the diff dialog can show the full body comparison.
      const byRule = meta.byRule ?? {};
      const hasByRuleData = Object.keys(byRule).length > 0;

      let match: MetaMatch;
      let redactionType: string;

      if (metaMatches.length > 0) {
        const index = parseInt(matchIndex, 10);
        if (isNaN(index) || index < 0 || index >= metaMatches.length) {
          return Response.json(
            createErrorResponse({ 
              message: "Match index out of range", 
              status: 400, 
              details: { totalMatches: metaMatches.length } 
            }),
            { status: 400 }
          );
        }
        match = metaMatches[index];

        // Use same field fallback logic as list API
        const preRedactionValue =
          (match.original ?? match.preValue ?? match.pre ?? "") as string;
        const postRedactionValue =
          (match.placeholder ?? match.postValue ?? match.post ?? "") as string;
        redactionType = (match.ruleId ?? match.rule ?? "") as string;

        // Build all matches for precise highlighting
        const allMatches = metaMatches.map((m) => ({
          ruleId: m.ruleId ?? m.rule ?? "",
          preValue: m.original ?? m.preValue ?? m.pre ?? "",
          postValue: m.placeholder ?? m.postValue ?? m.post ?? "",
          path: m.path ?? "",
        }));

        // Build the response - use meta from SQLite for source/provider/targetUrl/sessionId
        const response: RedactionDetailResponse = {
          redactionType,
          requestSource: meta.source ?? null,
          requestProvider: meta.provider ?? "unknown",
          requestTarget: meta.targetUrl ?? "",
          sessionId: meta.sessionId,
          captureId,
          preRedactionValue,
          postRedactionValue,
          matches: allMatches,
          // Use meta.generatedAt with fallback to capture timestamp (consistent with list API)
          timestamp: (meta.generatedAt as string) ?? (meta.timestamp as string) ?? (captureData.timestamp as string) ?? new Date().toISOString(),
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
          requestSource: meta.source ?? null,
          requestProvider: meta.provider ?? "unknown",
          requestTarget: meta.targetUrl ?? "",
          sessionId: meta.sessionId,
          captureId,
          preRedactionValue: "",
          postRedactionValue: "",
          // Use meta.generatedAt with fallback to capture timestamp
          timestamp: (meta.generatedAt as string) ?? (meta.timestamp as string) ?? (captureData.timestamp as string) ?? new Date().toISOString(),
        };

        // Build synthetic match for full body response logic
        const syntheticMatch: MetaMatch = { ruleId: firstRule, path: "" };
        return buildFullBodyResponse(response, captureData, syntheticMatch);
      } else {
        return Response.json(createErrorResponse({ message: "No redactions found in this capture", status: 404 }), { status: 404 });
      }
    } catch (error) {
      console.error(`Error in redaction detail API for capture ${captureId}:`, error);
      return Response.json(createErrorResponse({ message: "Internal server error", status: 500 }), { status: 500 });
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

  return Response.json(createSuccessResponse(response));
}

export async function POST(_request: Request) {
  return Response.json(createErrorResponse({ message: "Method not allowed", status: 405 }), { status: 405 });
}
