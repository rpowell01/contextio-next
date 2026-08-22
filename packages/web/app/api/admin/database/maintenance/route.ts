import { NextRequest, NextResponse } from "next/server";
import { getDb, isDbInitialized } from "@contextio/core/db";
import { createSuccessResponse, createErrorResponse } from "@contextio/core";

export type MaintenanceOperation =
  | "vacuum"
  | "analyze"
  | "reindex"
  | "integrity_check"
  | "quick_check";

interface MaintenanceResult {
  operation: MaintenanceOperation;
  success: boolean;
  message: string;
  durationMs: number;
  details?: Record<string, unknown>;
}

interface MaintenanceResponse {
  results: MaintenanceResult[];
  overallSuccess: boolean;
  totalDurationMs: number;
}

const OPERATIONS: MaintenanceOperation[] = [
  "vacuum",
  "analyze",
  "reindex",
  "integrity_check",
  "quick_check",
];

function runMaintenanceOperation(
  db: ReturnType<typeof getDb>,
  operation: MaintenanceOperation
): MaintenanceResult {
  const startTime = Date.now();
  try {
    let message = "";
    let details: Record<string, unknown> | undefined;

    switch (operation) {
      case "vacuum": {
        // VACUUM reclaims unused space and defragments the database
        // Cannot run inside a transaction
        const beforeSize = db.pragma("page_count") as number;
        const pageSize = db.pragma("page_size") as number;
        db.exec("VACUUM");
        const afterSize = db.pragma("page_count") as number;
        const pagesFreed = beforeSize - afterSize;
        const bytesFreed = pagesFreed * pageSize;
        message = `VACUUM completed. Freed ${pagesFreed} pages (${formatBytes(bytesFreed)}).`;
        details = { pagesFreed, bytesFreed, pageSize, beforeSize, afterSize };
        break;
      }
      case "analyze": {
        // ANALYZE updates query planner statistics
        db.exec("ANALYZE");
        message = "ANALYZE completed. Query planner statistics updated.";
        break;
      }
      case "reindex": {
        // REINDEX rebuilds all indexes
        db.exec("REINDEX");
        message = "REINDEX completed. All indexes rebuilt.";
        break;
      }
      case "integrity_check": {
        // Full integrity check - can be slow on large databases
        const result = db.prepare("PRAGMA integrity_check").get() as { integrity_check: string };
        const success = result.integrity_check === "ok";
        message = success
          ? "Integrity check passed. Database is healthy."
          : `Integrity check failed: ${result.integrity_check}`;
        details = { integrityCheck: result.integrity_check };
        if (!success) {
          throw new Error(message);
        }
        break;
      }
      case "quick_check": {
        // Quick integrity check - faster but less thorough
        const result = db.prepare("PRAGMA quick_check").get() as { quick_check: string };
        const success = result.quick_check === "ok";
        message = success
          ? "Quick check passed. Database appears healthy."
          : `Quick check failed: ${result.quick_check}`;
        details = { quickCheck: result.quick_check };
        if (!success) {
          throw new Error(message);
        }
        break;
      }
    }

    return {
      operation,
      success: true,
      message,
      durationMs: Date.now() - startTime,
      details,
    };
  } catch (error) {
    return {
      operation,
      success: false,
      message: error instanceof Error ? error.message : String(error),
      durationMs: Date.now() - startTime,
    };
  }
}

function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(2)} KB`;
  if (bytes < 1024 * 1024 * 1024) return `${(bytes / (1024 * 1024)).toFixed(2)} MB`;
  return `${(bytes / (1024 * 1024 * 1024)).toFixed(2)} GB`;
}

export async function POST(request: NextRequest): Promise<NextResponse> {
  try {
    const body = await request.json();
    const { operations } = body as { operations?: MaintenanceOperation[] };

    // Validate operations
    const requestedOps = operations ?? OPERATIONS;
    const invalidOps = requestedOps.filter((op) => !OPERATIONS.includes(op));
    if (invalidOps.length > 0) {
      return NextResponse.json(
        createErrorResponse({
          message: `Invalid operations: ${invalidOps.join(", ")}`,
          status: 400,
        }),
        { status: 400 }
      );
    }

    // Ensure database is initialized
    if (!isDbInitialized()) {
      getDb(); // This will initialize
    }

    const db = getDb();
    const results: MaintenanceResult[] = [];
    let overallSuccess = true;

    // Run each operation sequentially
    for (const op of requestedOps) {
      const result = runMaintenanceOperation(db, op);
      results.push(result);
      if (!result.success) {
        overallSuccess = false;
      }
    }

    const totalDurationMs = results.reduce((sum, r) => sum + r.durationMs, 0);

    const response: MaintenanceResponse = {
      results,
      overallSuccess,
      totalDurationMs,
    };

    return NextResponse.json(createSuccessResponse(response));
  } catch (error) {
    console.error("Database maintenance failed:", error);
    return NextResponse.json(
      createErrorResponse({
        message: "Database maintenance failed",
        status: 500,
        details: error instanceof Error ? error.message : String(error),
      }),
      { status: 500 }
    );
  }
}

export async function GET(): Promise<NextResponse> {
  try {
    // Return available operations and database info
    if (!isDbInitialized()) {
      getDb();
    }
    const db = getDb();

    const pageCount = db.pragma("page_count") as number;
    const pageSize = db.pragma("page_size") as number;
    const freelistCount = db.pragma("freelist_count") as number;
    const journalMode = db.pragma("journal_mode") as string;
    const synchronous = db.pragma("synchronous") as number;

    return NextResponse.json(
      createSuccessResponse({
        availableOperations: OPERATIONS,
        databaseInfo: {
          pageCount,
          pageSize,
          totalSizeBytes: pageCount * pageSize,
          freelistCount,
          freelistBytes: freelistCount * pageSize,
          journalMode,
          synchronous,
        },
      })
    );
  } catch (error) {
    console.error("Failed to get database info:", error);
    return NextResponse.json(
      createErrorResponse({
        message: "Failed to get database info",
        status: 500,
        details: error instanceof Error ? error.message : String(error),
      }),
      { status: 500 }
    );
  }
}