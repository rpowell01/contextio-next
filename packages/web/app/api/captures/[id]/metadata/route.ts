import { NextRequest, NextResponse } from "next/server";
import { join } from "path";

import {
  getCaptureDir,
  MAX_FILE_SIZE,
  metaFilenameFor,
  isValidFilename,
  loadRedactionMeta,
} from "@/lib/sessions/server-utils";
import { withRequestCache } from "@/lib/request-cache";
import { withAuth } from "@/lib/auth/guards";
import { createErrorResponse, createSuccessResponse } from "@contextio/core";

async function handleGetMetadata(
  _request: NextRequest,
  context: { params: Promise<{ id: string }>; session: import("@/lib/auth/session").AuthSession },
) {
  return withRequestCache(async () => {
    const { id } = await context.params;

    try {
      if (!isValidFilename(id)) {
        return NextResponse.json(createErrorResponse({ message: "Invalid capture id", status: 400 }), { status: 400 });
      }

      const captureDir = await getCaptureDir();
      const filepath = join(captureDir, id);
      const stats = await import("fs/promises").then((fs) => fs.stat(filepath).catch(() => null));
      if (!stats) {
        return NextResponse.json(createErrorResponse({ message: "Capture not found", status: 404 }), { status: 404 });
      }

      if (stats.size > MAX_FILE_SIZE) {
        return NextResponse.json(createErrorResponse({ message: "Capture file too large", status: 413 }), { status: 413 });
      }

      const metaFilename = metaFilenameFor(id);
      const meta = await loadRedactionMeta(metaFilename);

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