import { join } from "path";

import {
  getCaptureDir,
  readCaptureFile,
  CaptureReadError,
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
  matches: Array<{
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
      let captureData: Record<string, unknown>;
      try {
        captureData = await readCaptureFile(capturePath);
      } catch (error) {
        if (error instanceof CaptureReadError) {
          // Return 404 for corrupt/missing captures instead of 500
          console.warn(`Capture file not readable for ${captureId}: ${error.kind} - ${error.message}`);
          return Response.json(
            createErrorResponse({ message: "Capture file not found or corrupted", status: 404 }),
            { status: 404 }
          );
        }
        throw error;
      }

      if (!captureData) {
        return Response.json(createErrorResponse({ message: "Capture file not found", status: 404 }), { status: 404 });
      }

      // Load the redaction metadata from SQLite
      const meta = await getRedactionMetadataByCaptureIdFromDb(captureId.replace(/\.json$/, ""));

      if (!meta) {
        return Response.json(createErrorResponse({ message: "Redaction metadata not found", status: 404 }), { status: 404 });
      }

      // Use matches from SQLite which has actual pre/post values from the redaction plugin
      // NOTE: Previously we used extractRedactionMatches which incorrectly returned the entire
      // text as 'original'. Now we use meta.matches from SQLite which stores exact preValue/postValue.
      const metaMatches: MetaMatch[] = (meta.matches ?? []).map((m) => ({
        ruleId: m.ruleId,
        original: m.preValue,
        placeholder: m.postValue,
        preValue: m.preValue,
        postValue: m.postValue,
        path: m.path,
      }));

      // If no matches but we have byRule data (e.g., meta created by web UI), synthesize a match
      // from the first rule so the diff dialog can show the full body comparison.
      const byRule = meta.byRule ?? {};
      const hasByRuleData = Object.keys(byRule).length > 0;

      let match: MetaMatch;
      let redactionType: string;
      let allMatches: Array<{ ruleId: string; preValue: string; postValue: string; path: string }>;

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

        // Use preValue/postValue directly from SQLite matches
        const preRedactionValue = match.preValue ?? "";
        const postRedactionValue = match.postValue ?? "";
        redactionType = match.ruleId ?? "";

        // Build all matches for precise highlighting
        allMatches = metaMatches.map((m) => ({
          ruleId: m.ruleId ?? "",
          preValue: m.preValue ?? "",
          postValue: m.postValue ?? "",
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
          // Use meta.timestamp (consistent with list API using createdAt)
          timestamp: (meta.timestamp as string) ?? (captureData.timestamp as string) ?? new Date().toISOString(),
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
          matches: [{ ruleId: firstRule, preValue: "", postValue: "", path: "" }],
          // Use meta.timestamp (consistent with list API using createdAt)
          timestamp: (meta.timestamp as string) ?? (captureData.timestamp as string) ?? new Date().toISOString(),
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
