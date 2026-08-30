"use client";

import { MainLayout } from "@/components/main-layout";
import { LogsViewer } from "@/components/logs-viewer";
import { useState } from "react";
import { useAdminProtection } from "@/hooks/use-admin-auth";
import { AdminAccessDeniedDialog } from "@/components/admin-access-denied-dialog";

export default function LogsPage() {
  const [containerId, setContainerId] = useState("contextio-next");

  // Admin authentication protection
  const { showContent, showAccessDenied, setShowAccessDenied, authState } = useAdminProtection();

  return (
    <>
      <AdminAccessDeniedDialog
        open={showAccessDenied}
        onClose={() => setShowAccessDenied(false)}
        userEmail={authState.userEmail}
        isAuthenticated={authState.isAuthenticated}
      />
      {showContent && (
        <MainLayout>
          <div className="space-y-6">
        <div>
          <h1 className="text-3xl font-bold tracking-tight">Container Logs</h1>
          <p className="text-muted-foreground">
            View and search logs from containers
          </p>
        </div>

        <div className="flex items-end gap-4">
          <div>
            <label htmlFor="containerId" className="block text-sm font-medium mb-1">
              Container ID
            </label>
            <input
              id="containerId"
              type="text"
              placeholder="Enter container ID..."
              value={containerId}
              onChange={(e) => setContainerId(e.target.value)}
              className="rounded-md border border-input bg-background px-3 py-2 text-sm min-w-[200px]"
            />
          </div>
        </div>

        <div className="h-[calc(100vh-200px)]">
          <LogsViewer containerId={containerId} />
        </div>
      </div>
    </MainLayout>
      )}
    </>
  );
}