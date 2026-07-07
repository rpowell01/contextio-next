export const runtime = "nodejs";

import { NextResponse } from "next/server";
import { startCleanupScheduler } from "@/lib/cleanup-scheduler";

export default async function middleware() {
  await startCleanupScheduler();
  return NextResponse.next();
}

export const config = {
  matcher: ["/api/:path*"],
};
