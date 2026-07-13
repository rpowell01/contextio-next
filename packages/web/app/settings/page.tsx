"use client";

import { MainLayout } from "@/components/main-layout";
import { apiClient } from "@/lib/api";
import type { Settings, SettingMeta } from "@/lib/settings";
import { useState, useEffect, useRef } from "react";

import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import {
  AlertDialog,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
  AlertDialogTrigger,
} from "@/components/ui/alert-dialog";
import { Loader2, Trash2 } from "lucide-react";

// NOTE: /api/settings (GET and POST) has no authentication. Any client that can reach
// the web server can read or overwrite settings. Treat the settings file as sensitive
// and restrict network access to the web UI accordingly.
// NOTE: /api/captures?action=clear also has no authentication. The client-side
// "Remove All Captures" confirmation dialog is a usability control, not a security
// control. The server requires a typed action ("DELETE_ALL_CAPTURES") plus a
// per-request CSRF nonce issued by the server middleware to prevent cross-origin
// or accidental invocation.

// "Bottom Line" descriptions shown beneath each setting.
const SETTING_DESCRIPTIONS: Record<keyof Settings, string> = {
  logDir:
    "Where captured API traffic files are written. Changing this only takes effect after the proxy is restarted.",
  maxSessions:
    "Maximum number of capture sessions kept concurrently (0 = unlimited). Requires a proxy restart to apply.",
  redactPreset:
    "Built-in redaction rules applied to captures. Re-read on every request, so changes apply immediately.",
  redactReversible:
    "Store originals so redacted values can be restored in responses. Applied dynamically per request.",
  redactPolicyFile:
    "Path to a custom redaction policy YAML file. When set, it overrides the preset dropdown and is applied per request.",
  encryptionAtRest:
    "Encrypt captured API traffic files at rest using AES-256. Requires a proxy restart to apply.",
  captureCleanupEnabled:
    "Automatically delete old capture files on a schedule. Changing this only takes effect after the proxy is restarted.",
  captureCleanupIntervalHours:
    "How often the cleanup job runs. Changing this only takes effect after the proxy is restarted.",
  captureCleanupMaxAgeDays:
    "Capture files older than this are deleted. Changing this only takes effect after the proxy is restarted.",
};

function SettingBadges({ meta }: { meta: SettingMeta | undefined }) {
  if (!meta) return null;
  return (
    <div className="mt-1 flex flex-wrap items-center gap-2">
      {meta.source === "environment-variable" && meta.envVar && (
        <span
          className="inline-flex items-center rounded-full bg-amber-100 px-2 py-0.5 text-xs font-medium text-amber-800"
          title={`This value is controlled by the ${meta.envVar} environment variable and cannot be changed here`}
        >
          Overridden by {meta.envVar}
        </span>
      )}
      <span
        className={`inline-flex items-center rounded-full px-2 py-0.5 text-xs font-medium ${
          meta.dynamic
            ? "bg-green-100 text-green-800"
            : "bg-orange-100 text-orange-800"
        }`}
        title={
          meta.dynamic
            ? "Changes take effect immediately"
            : "Requires an app/proxy restart to take effect"
        }
      >
        {meta.dynamic ? "Dynamic" : "Requires restart"}
      </span>
    </div>
  );
}

function SettingHelp({
  meta,
  description,
}: {
  meta: SettingMeta | undefined;
  description: string;
}) {
  return (
    <div className="mt-1">
      <p className="text-xs text-muted-foreground">{description}</p>
      <SettingBadges meta={meta} />
    </div>
  );
}

export default function SettingsPage() {
  const [settings, setSettings] = useState<Settings>({
    logDir: "./captures",
    maxSessions: 0,
    redactPreset: "pii",
    redactReversible: false,
    redactPolicyFile: "",
    encryptionAtRest: false,
    captureCleanupEnabled: false,
    captureCleanupIntervalHours: 24,
    captureCleanupMaxAgeDays: 30,
  });
  const [metadata, setMetadata] = useState<Record<
    keyof Settings,
    SettingMeta
  > | null>(null);
  const [cleanupMessage, setCleanupMessage] = useState<{
    type: "success" | "error";
    message: string;
  } | null>(null);
  const [loading, setLoading] = useState(true);
  const [policyFileContents, setPolicyFileContents] = useState<string | null>(null);
  const [policyFileLoadError, setPolicyFileLoadError] = useState<string | null>(null);
  const [editedPolicyContent, setEditedPolicyContent] = useState<string>("");
  const messageTimeoutRef = useRef<NodeJS.Timeout | null>(null);
  const [deleteDialogOpen, setDeleteDialogOpen] = useState(false);
  const [isCleaning, setIsCleaning] = useState(false);

  useEffect(() => {
    async function loadSettings() {
      try {
        const data = await apiClient.getSettings();
        if (data.settings) {
          setSettings(data.settings);
        }
        if (data.metadata) {
          setMetadata(data.metadata as Record<keyof Settings, SettingMeta>);
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

useEffect(() => {
 if (loading) return;
 const policyPath = (settings.redactPolicyFile ?? "").trim();
 if (!policyPath) {
   setPolicyFileContents(null);
   setPolicyFileLoadError(null);
   return;
 }
 setPolicyFileLoadError(null);
 const controller = new AbortController();
 let cancelled = false;
 (async () => {
   try {
     const response = await fetch("/api/policy", {
       signal: controller.signal,
     });
     if (!response.ok) {
       const errorBody = (await response.json().catch(() => ({}))) as { error?: string };
       throw new Error(errorBody.error ?? `Request failed with status ${response.status}`);
     }
     const payload = await response.json();
     if (!cancelled) setPolicyFileContents(JSON.stringify(payload, null, 2));
     if (!cancelled) setEditedPolicyContent(JSON.stringify(payload, null, 2));
   } catch (error) {
     if (!cancelled) {
       setPolicyFileLoadError(error instanceof Error ? error.message : "Unable to load policy file");
       setPolicyFileContents(null);
     }
   }
 })();
 return () => {
   cancelled = true;
   controller.abort();
 };
}, [loading, settings.redactPolicyFile]);

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    try {
      const result = await apiClient.saveSettings(settings);
      if (result.success) {
        setCleanupMessage({
          type: "success",
          message: "Settings saved successfully",
        });
        if (result.metadata) {
          setMetadata(result.metadata as Record<keyof Settings, SettingMeta>);
        }
      } else {
        setCleanupMessage({
          type: "error",
          message: "Failed to save settings",
        });
      }
    } catch (error) {
      setCleanupMessage({
        type: "error",
        message:
          error instanceof Error ? error.message : "Failed to save settings",
      });
    }
    if (messageTimeoutRef.current) {
      clearTimeout(messageTimeoutRef.current);
    }
    messageTimeoutRef.current = setTimeout(() => setCleanupMessage(null), 3000);
  };

  const getMeta = (key: keyof Settings): SettingMeta | undefined => {
    return metadata?.[key];
  };

  const isOverridden = (key: keyof Settings): boolean => {
    return metadata?.[key]?.source === "environment-variable";
  };

  const updateSetting = (
    key: keyof Settings,
    value: Settings[keyof Settings],
  ) => {
    if (isOverridden(key)) {
      return;
    }
    setSettings((prev) => ({ ...prev, [key]: value }));
  };

  const handleCleanupAll = async () => {
    setIsCleaning(true);
    try {
      const result = await apiClient.clearCaptures();
      if (result.success) {
        setCleanupMessage({ type: "success", message: result.message });
      } else {
        setCleanupMessage({
          type: "error",
          message: `Error: ${result.message}`,
        });
      }
    } catch (error) {
      setCleanupMessage({
        type: "error",
        message:
          error instanceof Error ? error.message : "Failed to clean captures",
      });
    } finally {
      setIsCleaning(false);
      setDeleteDialogOpen(false);
    }
  };

  const renderSetting = (key: keyof Settings) => {
    switch (key) {
      case "logDir":
        return (
          <div>
            <Label htmlFor="logDir" className="block text-sm font-medium mb-2">
              Capture Directory
            </Label>
            <Input
              id="logDir"
              value={settings.logDir}
              onChange={(e) => updateSetting("logDir", e.target.value)}
              placeholder="./captures"
              disabled={isOverridden("logDir")}
              className={
                isOverridden("logDir") ? "bg-muted cursor-not-allowed" : ""
              }
            />
            <SettingHelp
              meta={getMeta("logDir")}
              description={SETTING_DESCRIPTIONS.logDir}
            />
          </div>
        );
      case "maxSessions":
        return (
          <div>
            <Label
              htmlFor="maxSessions"
              className="block text-sm font-medium mb-2"
            >
              Max Sessions (0 = unlimited)
            </Label>
            <Input
              id="maxSessions"
              type="number"
              value={settings.maxSessions}
              onChange={(e) =>
                updateSetting("maxSessions", parseInt(e.target.value) || 0)
              }
              min="0"
              disabled={isOverridden("maxSessions")}
              className={
                isOverridden("maxSessions") ? "bg-muted cursor-not-allowed" : ""
              }
            />
            <SettingHelp
              meta={getMeta("maxSessions")}
              description={SETTING_DESCRIPTIONS.maxSessions}
            />
          </div>
        );
case "redactPreset": {
        const presetDisabled = isOverridden("redactPreset") || Boolean(settings.redactPolicyFile?.trim());
        const presetOverrideReason = isOverridden("redactPreset")
          ? "Set by environment variable"
          : settings.redactPolicyFile?.trim()
            ? "Overridden by custom policy file"
            : null;
        return (
          <div>
            <Label
              htmlFor="redactPreset"
              className="block text-sm font-medium mb-2"
            >
              Redaction Preset
              {presetOverrideReason && (
                <span className="ml-2 text-xs text-amber-600 dark:text-amber-400 font-normal">
                  ({presetOverrideReason})
                </span>
              )}
            </Label>
            <select
              id="redactPreset"
              value={settings.redactPreset}
              onChange={(e) =>
                updateSetting("redactPreset", e.target.value as "secrets" | "pii" | "strict")
              }
              disabled={presetDisabled}
              className={`w-full rounded-md px-3 py-2 text-sm border rounded-md ${
                presetDisabled ? "bg-muted cursor-not-allowed" : "focus:outline-none focus:ring-2 focus:ring-primary"
              }`}
            >
              <option value="secrets">Secrets (API keys, tokens, passwords)</option>
              <option value="pii">PII (emails, names, phones, SSN)</option>
              <option value="strict">Strict (all of the above + more)</option>
            </select>
            <SettingHelp
              meta={getMeta("redactPreset")}
              description={SETTING_DESCRIPTIONS.redactPreset}
            />
          </div>
        );
      }
case "redactPolicyFile":
        return (
          <div>
            <Label htmlFor="redactPolicyFile" className="block text-sm font-medium mb-2">
              Redaction Policy File
            </Label>
            <Input
              id="redactPolicyFile"
              value={settings.redactPolicyFile}
              onChange={(e) => updateSetting("redactPolicyFile", e.target.value)}
              placeholder="/path/to/policy.yaml"
              disabled={isOverridden("redactPolicyFile")}
              className={
                isOverridden("redactPolicyFile")
                  ? "bg-muted cursor-not-allowed"
                  : ""
              }
            />
            <SettingHelp
              meta={getMeta("redactPolicyFile")}
              description={SETTING_DESCRIPTIONS.redactPolicyFile}
            />
            {(policyFileContents || policyFileLoadError) && (
              <div className="mt-3 space-y-2">
                <div className="flex items-center justify-between">
                  <h4 className="text-sm font-medium text-muted-foreground">
                    Active redaction policy
                  </h4>
                  {policyFileContents && !policyFileLoadError && (
                    <Button
                      type="button"
                      variant="outline"
                      size="sm"
                      onClick={() => {
                        navigator.clipboard.writeText(policyFileContents);
                      }}
                    >
                      Copy
                    </Button>
                  )}
                </div>
                {policyFileLoadError ? (
                  <div className="rounded-md border border-red-200 bg-red-50 p-3 text-sm text-red-800">
                    {policyFileLoadError}
                  </div>
                ) : (
                  <>
                    <textarea
                      value={editedPolicyContent}
                      onChange={(e) => setEditedPolicyContent(e.target.value)}
                      className="font-mono text-xs min-h-[300px] p-2 border rounded"
                      disabled={isOverridden("redactPolicyFile")}
                    />
                    {editedPolicyContent && editedPolicyContent !== policyFileContents && (
                      <Button
                        type="button"
                        variant="default"
                        size="sm"
                        onClick={async () => {
                          try {
                            const response = await fetch("/api/policy", {
                              method: "PUT",
                              headers: {
                                "Content-Type": "application/json",
                                "x-csrf-token": (apiClient.getCsrfHeaders() as Record<string, string>)["x-csrf-token"] || "",
                              },
                              body: JSON.stringify(JSON.parse(editedPolicyContent)),
                            });
                            if (response.ok) {
                              setPolicyFileContents(editedPolicyContent);
                              setCleanupMessage({
                                type: "success",
                                message: "Policy file saved successfully",
                              });
                            } else {
                              const error = await response.json();
                              setCleanupMessage({
                                type: "error",
                                message: `Failed to save policy: ${error.error || "Unknown error"}`,
                              });
                            }
                          } catch (err) {
                            setCleanupMessage({
                              type: "error",
                              message: err instanceof Error ? err.message : "Failed to save policy",
                            });
                          }
                        }}
                      >
                        Save Policy
                      </Button>
                    )}
                  </>
                )}
              </div>
            )}
          </div>
        );
case "redactReversible":
  return (
    <div className="flex items-center gap-2">
      <input
        type="checkbox"
        id="redactReversible"
        checked={settings.redactReversible}
        onChange={(e) =>
          updateSetting("redactReversible", e.target.checked)
        }
        className="w-4 h-4"
        disabled={isOverridden("redactReversible")}
      />
      <Label htmlFor="redactReversible" className="text-sm">
        Reversible redaction (restore originals in responses)
      </Label>
      <SettingHelp
        meta={getMeta("redactReversible")}
        description={SETTING_DESCRIPTIONS.redactReversible}
      />
    </div>
  );
case "encryptionAtRest":
        return (
          <div className="flex items-center gap-2">
            <input
              type="checkbox"
              id="encryptionAtRest"
              checked={settings.encryptionAtRest}
              onChange={(e) =>
                updateSetting("encryptionAtRest", e.target.checked)
              }
              className="w-4 h-4"
              disabled={isOverridden("encryptionAtRest")}
            />
            <Label htmlFor="encryptionAtRest" className="text-sm">
              Enable encryption at rest for capture files
            </Label>
            <SettingHelp
              meta={getMeta("encryptionAtRest")}
              description={SETTING_DESCRIPTIONS.encryptionAtRest}
            />
          </div>
        );
      case "captureCleanupEnabled":
        return (
          <div className="flex items-center justify-between mb-4">
            <div>
              <h3 className="font-semibold mb-1">Capture File Cleanup</h3>
              <p className="text-sm text-muted-foreground">
                Manage automatic and manual cleanup of captured API traffic
                files
              </p>
              <SettingHelp
                meta={getMeta("captureCleanupEnabled")}
                description={SETTING_DESCRIPTIONS.captureCleanupEnabled}
              />
            </div>
            <div className="flex items-center gap-2">
              <input
                id="captureCleanupEnabled"
                type="checkbox"
                checked={settings.captureCleanupEnabled}
                onChange={(e) =>
                  updateSetting("captureCleanupEnabled", e.target.checked)
                }
                disabled={isOverridden("captureCleanupEnabled")}
                className="h-4 w-4 rounded border-gray-300"
              />
              <Label htmlFor="captureCleanupEnabled" className="text-sm font-medium">
                Enable Automatic Cleanup
              </Label>
            </div>
          </div>
        );
      case "captureCleanupIntervalHours":
        return (
          <div>
            <Label
              htmlFor="cleanupIntervalHours"
              className="block text-sm font-medium mb-2"
            >
              Cleanup Interval (hours)
            </Label>
            <Input
              id="cleanupIntervalHours"
              type="number"
              value={settings.captureCleanupIntervalHours}
              onChange={(e) =>
                updateSetting(
                  "captureCleanupIntervalHours",
                  Math.max(1, parseInt(e.target.value) || 1),
                )
              }
              min="1"
              max="168"
              placeholder="24"
              disabled={isOverridden("captureCleanupIntervalHours")}
              className={
                isOverridden("captureCleanupIntervalHours")
                  ? "bg-muted cursor-not-allowed"
                  : ""
              }
            />
            <SettingHelp
              meta={getMeta("captureCleanupIntervalHours")}
              description={SETTING_DESCRIPTIONS.captureCleanupIntervalHours}
            />
          </div>
        );
      case "captureCleanupMaxAgeDays":
        return (
          <div>
            <Label
              htmlFor="cleanupMaxAgeDays"
              className="block text-sm font-medium mb-2"
            >
              Max Age (days)
            </Label>
            <Input
              id="cleanupMaxAgeDays"
              type="number"
              value={settings.captureCleanupMaxAgeDays}
              onChange={(e) =>
                updateSetting(
                  "captureCleanupMaxAgeDays",
                  Math.max(1, parseInt(e.target.value) || 1),
                )
              }
              min="1"
              max="365"
              placeholder="30"
              disabled={isOverridden("captureCleanupMaxAgeDays")}
              className={
                isOverridden("captureCleanupMaxAgeDays")
                  ? "bg-muted cursor-not-allowed"
                  : ""
              }
            />
            <SettingHelp
              meta={getMeta("captureCleanupMaxAgeDays")}
              description={SETTING_DESCRIPTIONS.captureCleanupMaxAgeDays}
            />
          </div>
        );
      default:
        return null;
    }
  };

  if (loading) {
    return (
      <MainLayout>
        <div className="space-y-6">
          <div>
            <h1 className="text-3xl font-bold tracking-tight">Settings</h1>
            <p className="text-muted-foreground">
              Configure ContextIO-Next proxy settings
            </p>
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
          <p className="text-muted-foreground">
            Configure ContextIO-Next proxy settings
          </p>
        </div>

        {cleanupMessage && (
          <div
            className={`rounded-lg border p-4 ${
              cleanupMessage.type === "success"
                ? "border-green-200 bg-green-50 text-green-800"
                : "border-red-200 bg-red-50 text-red-800"
            }`}
          >
            {cleanupMessage.message}
          </div>
        )}

<form onSubmit={handleSubmit} className="space-y-6">
  <div className="rounded-lg border p-6">
   <h3 className="font-semibold mb-4">Logging</h3>
            <div className="space-y-4">
              {renderSetting("logDir")}
              {renderSetting("maxSessions")}
              {renderSetting("captureCleanupEnabled")}
              {settings.captureCleanupEnabled && (
                <div className="grid gap-4 md:grid-cols-2 pt-2 border-t">
                  {renderSetting("captureCleanupIntervalHours")}
                  {renderSetting("captureCleanupMaxAgeDays")}
                </div>
              )}

              <div className="pt-4 border-t">
                <AlertDialog
                  open={deleteDialogOpen}
                  onOpenChange={setDeleteDialogOpen}
                >
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
                        This will permanently delete ALL capture files in the
                        capture directory. This action cannot be undone. All
                        captured API requests and responses will be lost.
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
          </div>

          <div className="rounded-lg border p-6">
            <h3 className="font-semibold mb-4">Redaction</h3>
            <div className="space-y-4">
              {renderSetting("redactPreset")}
              {renderSetting("redactReversible")}
              {renderSetting("redactPolicyFile")}
            </div>
          </div>
          <div className="rounded-lg border p-6">
            <h3 className="font-semibold mb-4">Security</h3>
            <div className="space-y-4">{renderSetting("encryptionAtRest")}</div>
          </div>

          <Button type="submit" className="w-full md:w-auto" disabled={loading}>
            {loading ? "Loading..." : "Save Settings"}
          </Button>
        </form>
      </div>
    </MainLayout>
  );
}
