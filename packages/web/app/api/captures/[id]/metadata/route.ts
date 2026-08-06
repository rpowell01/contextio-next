import fs from "fs/promises";
import { join } from "path";
import { NextRequest, NextResponse } from "next/server";

import {
  getRedactionMetadataByCaptureIdFromDb,
} from "@/lib/sessions/db-utils";
import { getCaptureDir, isValidFilename, MAX_FILE_SIZE } from "@/lib/sessions/server-utils";
import { withRequestCache } from "@/lib/request-cache";
import { withAuth } from "@/lib/auth/guards";
import { createErrorResponse, createSuccessResponse } from "@contextio/core";

async function handleGetMetadata(
  _request: NextRequest,
  context: { params: Promise<{ id: string }>; session: import("@/lib/auth/session").AuthSession | undefined },
) {
  return withRequestCache(async () => {
    const { id } = await context.params;

    try {
      if (!isValidFilename(id)) {
        return NextResponse.json(createErrorResponse({ message: "Invalid capture id", status: 400 }), { status: 400 });
      }

      // Check if the capture file exists and its size is within limits
      const captureDir = await getCaptureDir();
      const filepath = join(captureDir, id);
      const stats = await fs.stat(filepath).catch(() => null);
      if (!stats) {
        return NextResponse.json(
          createErrorResponse({ message: "Capture not found", status: 404, details: { captureId: id } }),
          { status: 404 },
        );
      }
      if (stats.size > MAX_FILE_SIZE) {
        return NextResponse.json(
          createErrorResponse({ message: "Capture file too large", status: 413 }),
          { status: 413 },
        );
      }

      // Capture ID from route params always has .json extension (validated by isValidFilename)
      // Strip it for database lookup since SQLite stores IDs without extension
      const captureId = id.slice(0, -5);
      const meta = await getRedactionMetadataByCaptureIdFromDb(captureId);

      if (!meta) {
        return NextResponse.json(
          createErrorResponse({ message: "Metadata not found", status: 404, details: { captureId: id } }),
          { status: 404 },
        );
      }

      return NextResponse.json(createSuccessResponse(meta));
    } catch (error) {
      console.error("Error reading capture metadata:", error);
      return NextResponse.json(createErrorResponse({ message: "Internal server error", status: 500 }), { status: 500 });
    }
  });
}

export const GET = withAuth(handleGetMetadata);