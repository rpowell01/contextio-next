import fs from "fs/promises";
import { join, basename } from "path";
import { NextRequest, NextResponse } from "next/server";

import {
  getCaptureDir,
  MAX_FILE_SIZE,
  metaFilenameFor,
  isValidFilename,
  readCaptureFile,
  CaptureReadError,
} from "@/lib/sessions/server-utils";
import {
  extractCaptureMetadata,
  getSessionMetadata,
} from "@/lib/sessions/server-utils";
import { withRequestCache } from "@/lib/request-cache";
import {
  computeCaptureRedactionCounts,
  getCaptureRedactionStats,
  type CaptureRedactionStats,
  applyRedaction,
  normalizeRuleId,
} from "@/lib/sessions/redaction-utils";
import { computeTokenUsage } from "@/lib/sessions/utils";
import type { RedactionDetails } from "@/types/api";
import { consumeToken } from "@/lib/csrf";
import { withAuth } from "@/lib/auth/guards";

async function readRedactionMetaSidecar(captureFilepath: string): Promise<{
  captureId: string;
  totalRedactions: number;
  byRule: Record<string, number>;
  totalInputTokens?: number;
  totalOutputTokens?: number;
  tokensPerSecond?: number;
  model?: string | null;
  successCount?: number;
  errorCount?: number;
} | null> {
  const metaFilename = metaFilenameFor(basename(captureFilepath));
  const captureDir = await getCaptureDir();
  const metaPath = join(captureDir, metaFilename);
  try {
    const raw = await fs.readFile(metaPath, "utf8");
    const parsed = JSON.parse(raw) as Record<string, unknown>;
    if (
      typeof parsed.captureId !== "string" ||
      typeof parsed.totalRedactions !== "number" ||
      typeof parsed.byRule !== "object" ||
      parsed.byRule === null
    ) {
      return null;
    }
    return {
      captureId: parsed.captureId,
      totalRedactions: parsed.totalRedactions,
      byRule: parsed.byRule as Record<string, number>,
      totalInputTokens: typeof parsed.totalInputTokens === "number" ? parsed.totalInputTokens : undefined,
      totalOutputTokens: typeof parsed.totalOutputTokens === "number" ? parsed.totalOutputTokens : undefined,
      tokensPerSecond: typeof parsed.tokensPerSecond === "number" ? parsed.tokensPerSecond : undefined,
      model: typeof parsed.model === "string" ? parsed.model : null,
      successCount: typeof parsed.successCount === "number" ? parsed.successCount : undefined,
      errorCount: typeof parsed.errorCount === "number" ? parsed.errorCount : undefined,
    };
  } catch {
    return null;
  }
}

function buildRedactionMeta(
  captureId: string,
  source: CaptureRedactionStats | null,
  computed: { totalRedactions: number; byRule: Record<string, number> },
  requestBody?: unknown,
  responseBody?: string,
  timings?: Record<string, unknown>,
  responseStatus?: number,
  fallbackGeneratedAt = true,
) {
  const totalRedactions = source?.totalRedactions ?? computed.totalRedactions;
  const byRule = source?.byRule ?? computed.byRule;

  // Compute token metrics from request/response bodies
  const tokenUsage = computeTokenUsage(responseBody ?? null, requestBody);

  // Use actual timing if available, otherwise default to 1 sec
  const timeSec = (timings?.total_ms as number || 0) / 1000 || 1;
  const tokensPerSecond = timeSec > 0 ? tokenUsage.output / timeSec : 0;

  // Determine success/error count based on response status
  const isSuccess = responseStatus !== undefined
    ? responseStatus >= 200 && responseStatus < 300
    : true; // default to success if no status
  const successCount = isSuccess ? 1 : 0;
  const errorCount = isSuccess ? 0 : 1;

  return {
    captureId,
    totalRedactions,
    byRule,
    generatedAt: fallbackGeneratedAt ? new Date().toISOString() : undefined,
    totalInputTokens: tokenUsage.input,
    totalOutputTokens: tokenUsage.output,
    tokensPerSecond: Number(tokensPerSecond.toFixed(2)),
    model: tokenUsage.model,
    successCount,
    errorCount,
  };
}

async function handleGetCapture(
  _request: NextRequest,
  context: { params: Promise<{ id: string }>; session: import("@/lib/auth/session").AuthSession },
) {
  return withRequestCache(async () => {
    const { id } = await context.params;

    try {
      if (!isValidFilename(id)) {
        return NextResponse.json({ error: "Invalid capture id" }, { status: 400 });
      }

      const captureDir = await getCaptureDir();
      const filepath = join(captureDir, id);
      const stats = await fs.stat(filepath).catch(() => null);
      if (!stats) {
        return NextResponse.json({ error: "Capture not found" }, { status: 404 });
      }

      if (stats.size > MAX_FILE_SIZE) {
        return NextResponse.json(
          { error: "Capture file too large" },
          { status: 413 },
        );
      }

      const data = await readCaptureFile(filepath);
      const capture = extractCaptureMetadata(id, data);
      const sessionMeta = await getSessionMetadata(id, data);
      const sidecar = await readRedactionMetaSidecar(filepath);
      const persistedStatsFromCapture = getCaptureRedactionStats(data) ?? null;

      // "computed" is used for the redactions list (with matches).
      const computed = computeCaptureRedactionCounts(
        data,
        false,
        persistedStatsFromCapture ?? undefined,
        data.originalRequestBody,
      );

      // "redactionMeta" is what gets persisted as the sidecar.
      let redactionMeta: {
        captureId: string;
        totalRedactions: number;
        byRule: Record<string, number>;
        generatedAt?: string;
        totalInputTokens?: number;
        totalOutputTokens?: number;
        tokensPerSecond?: number;
        model?: string | null;
      };

      if (sidecar) {
        // Sidecar wins: preserves provider/targetUrl/timestamp/checksum/matches.
        redactionMeta = {
          captureId: sidecar.captureId,
          totalRedactions: sidecar.totalRedactions,
          byRule: sidecar.byRule,
          generatedAt: undefined,
          totalInputTokens: sidecar.totalInputTokens,
          totalOutputTokens: sidecar.totalOutputTokens,
          tokensPerSecond: sidecar.tokensPerSecond,
          model: sidecar.model,
        };
      } else {
        // Fallback: derive from persisted stats in the capture file.
        redactionMeta = buildRedactionMeta(
          id.replace(/\.json$/, ""),
          persistedStatsFromCapture,
          computed,
          data.requestBody,
          typeof data.responseBody === "string" ? data.responseBody : undefined,
          data.timings as Record<string, unknown> | undefined,
          typeof data.responseStatus === "number" ? data.responseStatus : undefined,
          false,
        );
      }

      // Surface request/response bodies from session metadata (the richer write).
      const requestBody = sessionMeta.requestBody ?? data.requestBody;
      const responseBody = sessionMeta.responseBody ?? data.responseBody;

      // Redaction summary for the list/detail consumers.
      const redactionStats = getCaptureRedactionStats(data) ?? undefined;
      const redaction = computeCaptureRedactionCounts(
        data,
        true,
        redactionStats,
        data.originalRequestBody,
      );
      const redactionDetails: RedactionDetails = {
        totalRedactions: redaction.totalRedactions,
        byRule: redaction.byRule,
        matches: redaction.matches.map((m) => ({
          ruleId: m.ruleId,
          original: m.original,
          placeholder: m.placeholder,
          path: m.path,
        })),
      };

      return NextResponse.json({
        ...capture,
        requestBody,
        responseBody,
        originalRequestBody: data.originalRequestBody,
        originalResponseBody: data.originalResponseBody,
        totalRedactions: redactionDetails.totalRedactions,
        byRule: redactionDetails.byRule,
        matches: redactionDetails.matches,
        redactionMeta,
        redaction: redactionDetails,
        redactions: redactionDetails,
      });
    } catch (error) {
      if (error instanceof CaptureReadError) {
        const status =
          error.kind === "notFound"
            ? 404
            : error.kind === "corrupt"
              ? 422
              : 500;
        return NextResponse.json(
          { error: error.message, kind: error.kind },
          { status },
        );
      }
      console.error("Error in capture detail API:", error);
      return NextResponse.json({ error: "Internal server error" }, { status: 500 });
    }
  });
}

async function handlePutCapture(
  request: NextRequest,
  context: { params: Promise<{ id: string }>; session: import("@/lib/auth/session").AuthSession },
) {
  const { id } = await context.params;

  try {
    if (!isValidFilename(id)) {
      return NextResponse.json({ error: "Invalid capture id" }, { status: 400 });
    }

    const csrfToken = request.headers.get("x-csrf-token");
    if (!(await consumeToken(csrfToken ?? ""))) {
      return NextResponse.json(
        { error: "Invalid or missing CSRF token" },
        { status: 400 },
      );
    }

    const filepath = join(await getCaptureDir(), id);
    const stats = await fs.stat(filepath).catch(() => null);
    if (!stats) {
      return NextResponse.json({ error: "Capture not found" }, { status: 404 });
    }
    if (stats.size > MAX_FILE_SIZE) {
      return NextResponse.json({ error: "Capture too large" }, { status: 413 });
    }

    const raw = await fs.readFile(filepath, "utf8");
    const data = JSON.parse(raw) as Record<string, unknown>;

    const persistedStats = getCaptureRedactionStats(data);
    const redaction = computeCaptureRedactionCounts(
      data,
      false,
      persistedStats ?? undefined,
      data.originalRequestBody,
    );

    // Read existing metadata to preserve token metrics
    const existingMeta = await readRedactionMetaSidecar(filepath);

    // Compute token metrics if not in existing metadata
    let totalInputTokens = existingMeta?.totalInputTokens;
    let totalOutputTokens = existingMeta?.totalOutputTokens;
    let tokensPerSecond = existingMeta?.tokensPerSecond;
    let model = existingMeta?.model;
    let successCount = existingMeta?.successCount;
    let errorCount = existingMeta?.errorCount;

    if (totalInputTokens === undefined || totalOutputTokens === undefined) {
      const tokenUsage = computeTokenUsage(
        typeof data.responseBody === "string" ? data.responseBody : null,
        data.requestBody,
      );
      totalInputTokens = tokenUsage.input;
      totalOutputTokens = tokenUsage.output;
      model = tokenUsage.model;

      const timeSec = ((data.timings as Record<string, unknown>)?.total_ms as number || 0) / 1000 || 1;
      tokensPerSecond = timeSec > 0 ? tokenUsage.output / timeSec : 0;
    }

    // Determine success/error from response status
    if (successCount === undefined || errorCount === undefined) {
      const responseStatus = typeof data.responseStatus === "number" ? data.responseStatus : 200;
      const isSuccess = responseStatus >= 200 && responseStatus < 300;
      successCount = isSuccess ? 1 : 0;
      errorCount = isSuccess ? 0 : 1;
    }

    const meta = {
      captureId: id.replace(/\.json$/, ""),
      totalRedactions: redaction.totalRedactions,
      byRule: redaction.byRule,
      generatedAt: new Date().toISOString(),
      totalInputTokens,
      totalOutputTokens,
      tokensPerSecond: Number((tokensPerSecond ?? 0).toFixed(2)),
      model,
      successCount,
      errorCount,
    };

    const metaPath = join(await getCaptureDir(), metaFilenameFor(id));
    const tmpMetaPath = `${metaPath}.tmp-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
    await fs.writeFile(tmpMetaPath, JSON.stringify(meta, null, 2), "utf8");
    await fs.rename(tmpMetaPath, metaPath);

    return NextResponse.json({
      success: true,
      redactionMeta: meta,
      redactions: redaction,
    });
  } catch (error) {
    console.error("Error in capture redact API:", error);
    return NextResponse.json({ error: "Internal server error" }, { status: 500 });
  }
}

// POST supports two actions:
//   • action: "rerun" (default) – re-evaluate and rewrite redaction stats/metadata
//       Accepts optional body overrides for requestBody/responseBody/redactionStats.
//   • action: "redact" – apply explicit redaction rules (mirrors original redact POST).
async function handlePostCapture(
  request: NextRequest,
  context: { params: Promise<{ id: string }>; session: import("@/lib/auth/session").AuthSession },
) {
  const { id } = await context.params;

  try {
    if (!isValidFilename(id)) {
      return NextResponse.json({ error: "Invalid capture id" }, { status: 400 });
    }

    const csrfToken = request.headers.get("x-csrf-token");
    if (!(await consumeToken(csrfToken ?? ""))) {
      return NextResponse.json(
        { error: "Invalid or missing CSRF token" },
        { status: 400 },
      );
    }

    const filepath = join(await getCaptureDir(), id);
    const stats = await fs.stat(filepath).catch(() => null);
    if (!stats) {
      return NextResponse.json({ error: "Capture not found" }, { status: 404 });
    }
    if (stats.size > MAX_FILE_SIZE) {
      return NextResponse.json(
        { error: "Capture file too large" },
        { status: 413 },
      );
    }

    const raw = await fs.readFile(filepath, "utf8");
    const rawData = JSON.parse(raw) as Record<string, unknown>;
    const body = (await request.json().catch(() => ({}))) as {
      action?: string;
      requestBody?: Record<string, unknown>;
      responseBody?: string;
      redactionStats?: Record<string, unknown>;
      originalRequestBody?: Record<string, unknown>;
      rules?: Array<{ id: string; pattern: string; replacement: string }>;
    };

    const action = body.action ?? "rerun";

    // ------------------------------------------------------------------
    // action: "redact" – apply explicit rules against original/current bodies
    // ------------------------------------------------------------------
    if (action === "redact") {
      const rules = body.rules ?? [];
      const originalReq = rawData.originalRequestBody ?? rawData.requestBody;
      const originalRes = rawData.originalResponseBody ?? rawData.responseBody;

      const redacted = applyRedaction(
        originalReq,
        originalRes as string | null,
        rules,
      );

      const redactionDetails: RedactionDetails = {
        totalRedactions: redacted.matches.length,
        byRule: redacted.matches.reduce(
          (acc, m) => {
            const normalizedId = normalizeRuleId(m.ruleId);
            acc[normalizedId] = (acc[normalizedId] ?? 0) + 1;
            return acc;
          },
          {} as Record<string, number>,
        ),
        matches: redacted.matches.map((m) => ({
          ruleId: normalizeRuleId(m.ruleId),
          original: m.original,
          placeholder: m.replacement,
          path: m.path,
        })),
      };

      const updatedData: Record<string, unknown> = {
        ...rawData,
        requestBody: redacted.requestBody,
        responseBody: redacted.responseBody,
        originalRequestBody: rawData.originalRequestBody ?? rawData.requestBody,
        originalResponseBody:
          rawData.originalResponseBody ?? rawData.responseBody,
        redactionStats: {
          totalRedactions: redactionDetails.totalRedactions,
          byRule: redactionDetails.byRule,
        },
      };

      await fs.writeFile(filepath, JSON.stringify(updatedData, null, 2));

      const capture = extractCaptureMetadata(id, updatedData);
      return NextResponse.json({
        ...capture,
        requestBody: redacted.requestBody,
        responseBody: redacted.responseBody,
        redaction: redactionDetails,
      });
    }

    // ------------------------------------------------------------------
    // action: "rerun" (default) – re-evaluate + rewrite with optional overrides
    // ------------------------------------------------------------------
    const patched: Record<string, unknown> = { ...rawData };

    if (body.requestBody !== undefined) {
      patched.requestBody = body.requestBody;
    }
    if (body.responseBody !== undefined) {
      patched.responseBody = body.responseBody;
    }
    if (body.originalRequestBody !== undefined) {
      patched.originalRequestBody = body.originalRequestBody;
    }
    if (body.redactionStats !== undefined) {
      patched.redactionStats = body.redactionStats;
    }

    const tmpPath = `${filepath}.tmp-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
    await fs.writeFile(tmpPath, JSON.stringify(patched, null, 2), "utf8");
    await fs.rename(tmpPath, filepath);

    const persistedStats = getCaptureRedactionStats(patched);
    const redaction = computeCaptureRedactionCounts(
      patched,
      false,
      persistedStats ?? undefined,
      patched.originalRequestBody,
    );

    // Compute token metrics for metadata
    const tokenUsage = computeTokenUsage(
      typeof patched.responseBody === "string" ? patched.responseBody : null,
      patched.requestBody,
    );

    // Fix operator precedence: timeSec = total_ms / 1000 || 1, then tokensPerSecond = output / timeSec
    const timeSec = ((patched.timings as Record<string, unknown>)?.total_ms as number || 0) / 1000 || 1;
    const tokensPerSecond = timeSec > 0 ? tokenUsage.output / timeSec : 0;

    // Determine success/error count based on response status
    const responseStatus = typeof patched.responseStatus === "number" ? patched.responseStatus : 200;
    const isSuccess = responseStatus >= 200 && responseStatus < 300;
    const successCount = isSuccess ? 1 : 0;
    const errorCount = isSuccess ? 0 : 1;

    const meta = {
      captureId: id.replace(/\.json$/, ""),
      totalRedactions: redaction.totalRedactions,
      byRule: redaction.byRule,
      generatedAt: new Date().toISOString(),
      totalInputTokens: tokenUsage.input,
      totalOutputTokens: tokenUsage.output,
      tokensPerSecond: Number(tokensPerSecond.toFixed(2)),
      model: tokenUsage.model,
      successCount,
      errorCount,
    };

    const metaPath = join(await getCaptureDir(), metaFilenameFor(id));
    const tmpMetaPath = `${metaPath}.tmp-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
    await fs.writeFile(tmpMetaPath, JSON.stringify(meta, null, 2), "utf8");
    await fs.rename(tmpMetaPath, metaPath);

    return NextResponse.json({
      success: true,
      capture: patched,
      redactionMeta: meta,
      redactions: redaction,
    });
  } catch (error) {
    console.error("Error in capture rerun API:", error);
    return NextResponse.json({ error: "Internal server error" }, { status: 500 });
  }
}

export const GET = withAuth(handleGetCapture);
export const PUT = withAuth(handlePutCapture);
export const POST = withAuth(handlePostCapture);