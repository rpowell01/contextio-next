"use client";

import { MainLayout } from "@/components/main-layout";
import { PolicyEditor } from "@/components/policy-editor";
import { apiClient } from "@/lib/api";
import type { Settings } from "@/lib/settings";
import { useState, useEffect, useRef } from "react";
import { AlertDialog, AlertDialogCancel, AlertDialogContent, AlertDialogDescription, AlertDialogFooter, AlertDialogHeader, AlertDialogTitle, AlertDialogTrigger } from "@/components/ui/alert-dialog";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Switch } from "@/components/ui/switch";
import { Separator } from "@/components/ui/separator";
import { Loader2, Trash2 } from "lucide-react";

export default function SettingsPage() {
  const [settings, setSettings] = useState<Settings>({
    logDir: "./captures",
    maxSessions: 0,
    redactPreset: "pii",
    redactReversible: false,
    captureCleanupEnabled: false,
    captureCleanupIntervalHours: 24,
    captureCleanupMaxAgeDays: 30,
  });
  const [isCleaning, setIsCleaning] = useState(false);
  const [cleanupMessage, setCleanupMessage] = useState<{ type: "success" | "error"; message: string } | null>(null);
  const [loading, setLoading] = useState(true);
  const [deleteDialogOpen, setDeleteDialogOpen] = useState(false);
  const messageTimeoutRef = useRef<NodeJS.Timeout | null>(null);

  useEffect(() => {
    async function loadSettings() {
      try {
        const data = await apiClient.getSettings();
        if (data.settings) {
          setSettings(data.settings);
        }
      } catch (error) {
        console.error("Failed to load settings:", error);
      } finally {
        setLoading(false);
      }
    }
    loadSettings();
  }, []);

  useEffect(() => {
    return () => {
      if (messageTimeoutRef.current) {
        clearTimeout(messageTimeoutRef.current);
      }
    };
  }, []);

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    try {
      const result = await apiClient.saveSettings(settings);
      if (result.success) {
        setCleanupMessage({ type: "success", message: "Settings saved successfully" });
      } else {
        setCleanupMessage({ type: "error", message: "Failed to save settings" });
      }
    } catch (error) {
      setCleanupMessage({ type: "error", message: error instanceof Error ? error.message : "Failed to save settings" });
    }
    if (messageTimeoutRef.current) {
      clearTimeout(messageTimeoutRef.current);
    }
    messageTimeoutRef.current = setTimeout(() => setCleanupMessage(null), 3000);
  };

  const handleCleanupAll = async () => {
    setIsCleaning(true);
    try {
      const result = await apiClient.clearCaptures();
      if (result.success) {
        setCleanupMessage({ type: "success", message: result.message });
      } else {
        setCleanupMessage({ type: "error", message: `Error: ${result.message}` });
      }
    } catch (error) {
      setCleanupMessage({ type: "error", message: error instanceof Error ? error.message : "Failed to clean captures" });
    } finally {
      setIsCleaning(false);
      setDeleteDialogOpen(false);
    }
  };

  if (loading) {
    return (
      <MainLayout>
        <div className="space-y-6">
          <div>
            <h1 className="text-3xl font-bold tracking-tight">Settings</h1>
            <p className="text-muted-foreground">Configure ContextIO-Next proxy settings</p>
          </div>
          <div className="flex items-center justify-center py-12">
            <Loader2 className="h-8 w-8 animate-spin text-primary" />
          </div>
        </div>
      </MainLayout>
    );
  }

  return (
    <MainLayout>
      <div className="space-y-6">
        <div>
          <h1 className="text-3xl font-bold tracking-tight">Settings</h1>
          <p className="text-muted-foreground">Configure ContextIO-Next proxy settings</p>
        </div>

        {cleanupMessage && (
          <div className={`rounded-lg border p-4 ${
            cleanupMessage.type === "success"
              ? "border-green-200 bg-green-50 text-green-800"
              : "border-red-200 bg-red-50 text-red-800"
          }`}>
            {cleanupMessage.message}
          </div>
        )}

        <form onSubmit={handleSubmit} className="space-y-6">
          <div className="rounded-lg border p-6">
            <h3 className="font-semibold mb-4">Logging</h3>
            <div className="space-y-4">
              <div>
                <Label htmlFor="logDir" className="block text-sm font-medium mb-2">
                  Capture Directory
                </Label>
                <Input
                  id="logDir"
                  value={settings.logDir}
                  onChange={(e) => setSettings({ ...settings, logDir: e.target.value })}
                  placeholder="./captures"
                />
              </div>
              <div>
                <Label htmlFor="maxSessions" className="block text-sm font-medium mb-2">
                  Max Sessions (0 = unlimited)
                </Label>
                <Input
                  id="maxSessions"
                  type="number"
                  value={settings.maxSessions}
                  onChange={(e) => setSettings({ ...settings, maxSessions: parseInt(e.target.value) || 0 })}
                  min="0"
                />
              </div>
            </div>
          </div>

          <div className="rounded-lg border p-6">
            <h3 className="font-semibold mb-4">Redaction</h3>
            <div className="space-y-4">
              <div>
                <Label className="block text-sm font-medium mb-2">
                  Preset
                </Label>
                <select
                  value={settings.redactPreset}
                  onChange={(e) => setSettings({ ...settings, redactPreset: e.target.value as "secrets" | "pii" | "strict" })}
                  className="w-full px-3 py-2 border rounded-md"
                >
                  <option value="secrets">secrets - API keys and tokens only</option>
                  <option value="pii">pii - Email, SSN, credit cards, phone numbers</option>
                  <option value="strict">strict - PII + IP addresses, dates of birth</option>
                </select>
              </div>
              <div className="flex items-center gap-2">
                <input
                  type="checkbox"
                  id="redactReversible"
                  checked={settings.redactReversible}
                  onChange={(e) => setSettings({ ...settings, redactReversible: e.target.checked })}
                  className="w-4 h-4"
                />
                <Label htmlFor="redactReversible" className="text-sm">
                  Reversible redaction (restore originals in responses)
                </Label>
              </div>
            </div>
          </div>

          <div className="rounded-lg border p-6">
            <h3 className="font-semibold mb-4">Redaction Policy Editor</h3>
            <PolicyEditor />
          </div>

          <Separator />

          <div className="rounded-lg border p-6">
            <div className="flex items-center justify-between mb-4">
              <div>
                <h3 className="font-semibold mb-1">Capture File Cleanup</h3>
                <p className="text-sm text-muted-foreground">
                  Manage automatic and manual cleanup of captured API traffic files
                </p>
              </div>
              <div className="flex items-center gap-2">
                <Switch
                  id="captureCleanupEnabled"
                  checked={settings.captureCleanupEnabled}
                  onCheckedChange={(checked) => setSettings({ ...settings, captureCleanupEnabled: checked })}
                />
                <Label htmlFor="captureCleanupEnabled" className="text-sm">
                  Enable Automatic Cleanup
                </Label>
              </div>
            </div>

            {settings.captureCleanupEnabled && (
              <div className="space-y-4 pt-4 border-t">
                <div className="grid gap-4 md:grid-cols-2">
                  <div>
                    <Label htmlFor="cleanupIntervalHours" className="block text-sm font-medium mb-2">
                      Cleanup Interval (hours)
                    </Label>
                    <Input
                      id="cleanupIntervalHours"
                      type="number"
                      value={settings.captureCleanupIntervalHours}
                      onChange={(e) => setSettings({ ...settings, captureCleanupIntervalHours: Math.max(1, parseInt(e.target.value) || 1) })}
                      min="1"
                      max="168"
                      placeholder="24"
                    />
                    <p className="text-xs text-muted-foreground mt-1">
                      How often to run the cleanup job
                    </p>
                  </div>
                  <div>
                    <Label htmlFor="cleanupMaxAgeDays" className="block text-sm font-medium mb-2">
                      Max Age (days)
                    </Label>
                    <Input
                      id="cleanupMaxAgeDays"
                      type="number"
                      value={settings.captureCleanupMaxAgeDays}
                      onChange={(e) => setSettings({ ...settings, captureCleanupMaxAgeDays: Math.max(1, parseInt(e.target.value) || 1) })}
                      min="1"
                      max="365"
                      placeholder="30"
                    />
                    <p className="text-xs text-muted-foreground mt-1">
                      Delete capture files older than this many days
                    </p>
                  </div>
                </div>

<div className="flex flex-wrap gap-2">
                  <AlertDialog open={deleteDialogOpen} onOpenChange={setDeleteDialogOpen}>
                    <AlertDialogTrigger asChild>
                      <Button
                        type="button"
                        variant="destructive"
                        className="flex items-center gap-2"
                      >
                        <Trash2 className="h-4 w-4" />
                        Remove All Captures
                      </Button>
                    </AlertDialogTrigger>
                    <AlertDialogContent>
                      <AlertDialogHeader>
                        <AlertDialogTitle>Are you absolutely sure?</AlertDialogTitle>
                        <AlertDialogDescription>
                          This will permanently delete ALL capture files in the capture directory. This action cannot be undone. All captured API requests and responses will be lost.
                        </AlertDialogDescription>
                      </AlertDialogHeader>
                      <AlertDialogFooter>
                        <AlertDialogCancel>Cancel</AlertDialogCancel>
                        <Button
                          variant="destructive"
                          disabled={isCleaning}
                          onClick={handleCleanupAll}
                          className="flex items-center gap-2"
                        >
                          {isCleaning ? (
                            <>
                              <Loader2 className="h-4 w-4 animate-spin mr-2" />
                              Cleaning...
                            </>
                          ) : (
                            "Yes, delete all captures"
                          )}
                        </Button>
                      </AlertDialogFooter>
                    </AlertDialogContent>
                  </AlertDialog>
                </div>
              </div>
            )}
          </div>

          <Button type="submit" className="w-full md:w-auto">
            Save Settings
          </Button>
        </form>
      </div>
    </MainLayout>
  );
}