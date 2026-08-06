import { NextRequest, NextResponse } from "next/server";

import {
  getRedactionMetadataByCaptureIdFromDb,
} from "@/lib/sessions/db-utils";
import { isValidFilename } from "@/lib/sessions/server-utils";
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