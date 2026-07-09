"use client";

import { Suspense } from "react";
import SessionView from "@/components/session/SessionView";

function SessionViewLoading() {
  return (
    <div className="flex items-center justify-center p-12">
      <div className="h-4 w-32 animate-pulse rounded bg-muted" />
    </div>
  );
}

export default function SessionDetailPage({
  params,
}: {
  params: Promise<{ id: string }>;
}) {
  return (
    <Suspense fallback={<SessionViewLoading />}>
      <SessionView params={params} />
    </Suspense>
  );
}
