"use client";

import { MainLayout } from "@/components/main-layout";
import { apiClient } from "@/lib/api";
import type { Settings, SettingMeta, Provider, RateLimitConfig } from "@/lib/settings";
import type { ProviderConfig, ProviderMetadata } from "@/types/api";
import { useState, useEffect, useRef } from "react";
import { useTheme } from "@/components/theme-provider";

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
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
  DialogDescription,
  DialogFooter,
} from "@/components/ui/dialog";
import { Loader2, Trash2, Edit2, Plus } from "lucide-react";

// NOTE: /api/settings (GET and POST) has no authentication. Any client that can reach
// the web server can read or overwrite settings. Treat the settings file as sensitive
// and restrict network access to the web UI accordingly.
// NOTE: /api/captures?action=clear also has no authentication. The client-side
// "Remove All Captures" confirmation dialog is a usability control, not a security
// control. The server requires a typed action ("DELETE_ALL_CAPTURES") plus a
// per-request CSRF nonce issued by the server middleware to prevent cross-origin
// or accidental invocation.

// "Bottom Line" descriptions shown beneath each setting.
const SETTING_DESCRIPTIONS: Record<keyof Omit<Settings, "theme">, string> = {
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
  oidcEnabled:
    "Enable OpenID Connect authentication for the web UI. Requires a proxy restart and valid OIDC config (issuer, client ID, client secret, session secret) via environment variables.",
  oidcPublicUrl:
    "Public-facing URL for the proxy (e.g., https://contextio.example.com). Used for OIDC callback URLs when behind a reverse proxy. Requires a proxy restart to apply.",
  showPageLoadTime:
    "Display page load time in the bottom-left corner. Measures time from navigation start to fully interactive page (hydration + data fetch + render complete). Changes apply immediately.",
  detectorMode:
    "Detection mode: 'rules' (fast, deterministic patterns), 'llm' (semantic PII detection via GLiNER), 'hybrid' (rules + LLM with priority merge), or 'auto' (automatically choose). Changes apply dynamically per request.",
  detectorModelDir:
    "Path to the local GLiNER ONNX model directory (required for llm/hybrid/auto modes). Contains model.onnx, vocab.txt, and tokenizer config. Changes apply dynamically.",
  detectorThreshold:
    "Minimum confidence threshold for LLM-based detections (0-1). Higher values reduce false positives but may miss some entities. Applied dynamically per request.",
  rateLimiter:
    "Rate limiting configuration per provider. Controls max requests, time window, and burst capacity. Requires a proxy restart to apply.",
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
  const [settings, setSettings] = useState<Omit<Settings, "theme">>({
    logDir: "./captures",
    maxSessions: 0,
    redactPreset: "pii",
    redactReversible: false,
    redactPolicyFile: "",
    encryptionAtRest: false,
    captureCleanupEnabled: false,
    captureCleanupIntervalHours: 24,
    captureCleanupMaxAgeDays: 30,
    oidcEnabled: false,
    oidcPublicUrl: "",
    showPageLoadTime: false,
    detectorMode: "rules",
    detectorModelDir: "",
    detectorThreshold: 0.5,
    rateLimiter: {
      anthropic: { maxRequests: 60, windowMs: 60000, bufferCapacity: 10 },
      openai: { maxRequests: 60, windowMs: 60000, bufferCapacity: 10 },
      chatgpt: { maxRequests: 60, windowMs: 60000, bufferCapacity: 10 },
      gemini: { maxRequests: 60, windowMs: 60000, bufferCapacity: 10 },
      vertex: { maxRequests: 60, windowMs: 60000, bufferCapacity: 10 },
      nvidia: { maxRequests: 60, windowMs: 60000, bufferCapacity: 10 },
      openrouter: { maxRequests: 60, windowMs: 60000, bufferCapacity: 10 },
      kilo: { maxRequests: 60, windowMs: 60000, bufferCapacity: 10 },
      unknown: { maxRequests: 60, windowMs: 60000, bufferCapacity: 10 },
    },
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
  
  // Providers state
  const [providers, setProviders] = useState<ProviderMetadata[]>([]);
  const [providersLoading, setProvidersLoading] = useState(true);
  const [providersError, setProvidersError] = useState<string | null>(null);
  const [addProviderDialogOpen, setAddProviderDialogOpen] = useState(false);
  const [editProviderDialogOpen, setEditProviderDialogOpen] = useState(false);
  const [deleteProviderDialogOpen, setDeleteProviderDialogOpen] = useState(false);
  const [editingProvider, setEditingProvider] = useState<ProviderMetadata | null>(null);
  const [deletingProvider, setDeletingProvider] = useState<ProviderMetadata | null>(null);
  const [providerFormData, setProviderFormData] = useState<ProviderConfig>({
    id: "",
    name: "",
    baseUrl: "",
    models: [],
    allowBaseUrlOverride: true,
    baseUrlOverrideHeader: "x-openai-baseurl",
  });
  const [providerFormError, setProviderFormError] = useState<string | null>(null);
  const [providerFormSubmitting, setProviderFormSubmitting] = useState(false);
  const [deleteProviderSubmitting, setDeleteProviderSubmitting] = useState(false);
  const [isEditingDefault, setIsEditingDefault] = useState(false);
  
  const { theme, setTheme, isOverridden: themeIsOverridden } = useTheme();

  useEffect(() => {
    async function loadSettings() {
      try {
        const data = await apiClient.getSettings();
        if (data.settings) {
          // Omit theme from local settings state since it's managed by ThemeProvider
          const { theme: _theme, ...restSettings } = data.settings as Settings;
          setSettings(restSettings);
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

  // Load providers
  useEffect(() => {
    async function loadProviders() {
      try {
        setProvidersLoading(true);
        setProvidersError(null);
        const response = await apiClient.getProviders();
        if (response.data) {
          setProviders(response.data);
        }
      } catch (error) {
        console.error("Failed to load providers:", error);
        setProvidersError(error instanceof Error ? error.message : "Failed to load providers");
      } finally {
        setProvidersLoading(false);
      }
    }
    loadProviders();
  }, []);

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    try {
      // Fetch fresh settings to avoid overwriting concurrent changes
      const response = await apiClient.getSettings();
      const currentSettings = response.settings as Settings;
      // Merge with local changes (theme from ThemeProvider, other settings from local state)
      const mergedSettings: Settings = {
        ...currentSettings,
        ...settings,
        theme,
      };
      const result = await apiClient.saveSettings(mergedSettings);
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

  const isSettingOverridden = (key: keyof Settings): boolean => {
    return metadata?.[key]?.source === "environment-variable";
  };

  const updateSetting = <K extends keyof Omit<Settings, "theme">>(
    key: K,
    value: Settings[K],
  ) => {
    if (isSettingOverridden(key)) {
      return;
    }
    setSettings((prev) => ({ ...prev, [key]: value }));
  };

  const updateRateLimiter = (
    provider: Provider,
    field: keyof RateLimitConfig,
    value: number,
  ) => {
    setSettings((prev) => ({
      ...prev,
      rateLimiter: {
        ...prev.rateLimiter,
        [provider]: {
          ...prev.rateLimiter?.[provider],
          [field]: value,
        },
      },
    }));
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

  // Provider handler functions
  const openAddProviderDialog = () => {
    setProviderFormData({ id: "", name: "", baseUrl: "", models: [], allowBaseUrlOverride: true, baseUrlOverrideHeader: "x-openai-baseurl" });
    setProviderFormError(null);
    setAddProviderDialogOpen(true);
  };

  const openEditProviderDialog = (provider: ProviderMetadata) => {
    setEditingProvider(provider);
    setIsEditingDefault(provider.source === "default");
    setProviderFormData({
      id: provider.id,
      name: provider.name,
      baseUrl: provider.baseUrl,
      models: provider.models,
      allowBaseUrlOverride: provider.allowBaseUrlOverride ?? true,
      baseUrlOverrideHeader: provider.baseUrlOverrideHeader ?? "x-openai-baseurl",
    });
    setProviderFormError(null);
    setEditProviderDialogOpen(true);
  };

  const openDeleteProviderDialog = (provider: ProviderMetadata) => {
    setDeletingProvider(provider);
    setProviderFormError(null);
    setDeleteProviderDialogOpen(true);
  };

  const handleProviderFormChange = (field: keyof ProviderConfig, value: string | string[] | boolean) => {
    setProviderFormData((prev) => ({ ...prev, [field]: value }));
  };

  const handleProviderFormSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    
    // Client-side validation
    if (!providerFormData.id.trim()) {
      setProviderFormError("Provider ID is required");
      return;
    }
    if (!providerFormData.name.trim()) {
      setProviderFormError("Display Name is required");
      return;
    }
    if (!providerFormData.baseUrl.trim()) {
      setProviderFormError("Base URL is required");
      return;
    }
    // Basic URL validation
    try {
      new URL(providerFormData.baseUrl);
    } catch {
      setProviderFormError("Base URL must be a valid URL");
      return;
    }
    
    setProviderFormSubmitting(true);
    setProviderFormError(null);
    try {
      if (editProviderDialogOpen && editingProvider) {
        if (isEditingDefault) {
          // Editing a default provider - create a new custom copy
          await apiClient.createProvider(providerFormData);
        } else {
          // Update existing custom provider
          await apiClient.updateProvider(editingProvider.id, providerFormData);
        }
      } else {
        // Create new provider
        await apiClient.createProvider(providerFormData);
      }
      // Refresh providers list
      const response = await apiClient.getProviders();
      if (response.data) {
        setProviders(response.data);
      }
      setAddProviderDialogOpen(false);
      setEditProviderDialogOpen(false);
      setEditingProvider(null);
      setIsEditingDefault(false);
    } catch (error) {
      setProviderFormError(error instanceof Error ? error.message : "Failed to save provider");
    } finally {
      setProviderFormSubmitting(false);
    }
  };

  const handleDeleteProvider = async () => {
    if (!deletingProvider) return;
    setDeleteProviderSubmitting(true);
    setProviderFormError(null);
    try {
      await apiClient.deleteProvider(deletingProvider.id);
      // Refresh providers list
      const response = await apiClient.getProviders();
      if (response.data) {
        setProviders(response.data);
      }
      setDeleteProviderDialogOpen(false);
      setDeletingProvider(null);
    } catch (error) {
      setProviderFormError(error instanceof Error ? error.message : "Failed to delete provider");
    } finally {
      setDeleteProviderSubmitting(false);
    }
  };

  const renderSetting = (key: keyof Settings) => {
    // Theme is handled by ThemeProvider, not local state
    if (key === "theme") {
      return renderThemeSetting();
    }
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
              disabled={isSettingOverridden("logDir")}
              className={
                isSettingOverridden("logDir") ? "bg-muted cursor-not-allowed" : ""
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
              disabled={isSettingOverridden("maxSessions")}
              className={
                isSettingOverridden("maxSessions") ? "bg-muted cursor-not-allowed" : ""
              }
            />
            <SettingHelp
              meta={getMeta("maxSessions")}
              description={SETTING_DESCRIPTIONS.maxSessions}
            />
          </div>
        );
      case "redactPreset": {
        const presetDisabled = isSettingOverridden("redactPreset") || Boolean(settings.redactPolicyFile?.trim());
        const presetOverrideReason = isSettingOverridden("redactPreset")
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
              disabled={isSettingOverridden("redactPolicyFile")}
              className={
                isSettingOverridden("redactPolicyFile")
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
                      className="font-mono text-xs min-h-[600px] min-w-[600px] p-2 border rounded"
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
              disabled={isSettingOverridden("redactReversible")}
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
              disabled={isSettingOverridden("encryptionAtRest")}
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
      case "oidcEnabled":
        return (
          <div className="flex items-center gap-2">
            <input
              type="checkbox"
              id="oidcEnabled"
              checked={settings.oidcEnabled}
              onChange={(e) => updateSetting("oidcEnabled", e.target.checked)}
              className="w-4 h-4"
              disabled={isSettingOverridden("oidcEnabled")}
            />
            <Label htmlFor="oidcEnabled" className="text-sm">
              Enable OpenID Connect authentication
            </Label>
            <SettingHelp
              meta={getMeta("oidcEnabled")}
              description={SETTING_DESCRIPTIONS.oidcEnabled}
            />
          </div>
        );
      case "oidcPublicUrl":
        return (
          <div>
            <Label htmlFor="oidcPublicUrl" className="block text-sm font-medium mb-2">
              OIDC Public URL
            </Label>
            <Input
              id="oidcPublicUrl"
              value={settings.oidcPublicUrl}
              onChange={(e) => updateSetting("oidcPublicUrl", e.target.value)}
              placeholder="https://contextio.example.com"
              disabled={isSettingOverridden("oidcPublicUrl")}
              className={
                isSettingOverridden("oidcPublicUrl") ? "bg-muted cursor-not-allowed" : ""
              }
            />
            <SettingHelp
              meta={getMeta("oidcPublicUrl")}
              description={SETTING_DESCRIPTIONS.oidcPublicUrl}
            />
          </div>
        );
      case "showPageLoadTime":
        return (
          <div className="flex items-center gap-2">
            <input
              type="checkbox"
              id="showPageLoadTime"
              checked={settings.showPageLoadTime}
              onChange={(e) => updateSetting("showPageLoadTime", e.target.checked)}
              className="w-4 h-4"
              disabled={isSettingOverridden("showPageLoadTime")}
            />
            <Label htmlFor="showPageLoadTime" className="text-sm">
              Show page load time in footer
            </Label>
            <SettingHelp
              meta={getMeta("showPageLoadTime")}
              description={SETTING_DESCRIPTIONS.showPageLoadTime}
            />
          </div>
        );
      case "detectorMode":
        return (
          <div>
            <Label htmlFor="detectorMode" className="block text-sm font-medium mb-2">
              Detector Mode
            </Label>
            <select
              id="detectorMode"
              value={settings.detectorMode}
              onChange={(e) =>
                updateSetting("detectorMode", e.target.value as "rules" | "llm" | "hybrid" | "auto")
              }
              disabled={isSettingOverridden("detectorMode")}
              className={`w-full rounded-md px-3 py-2 text-sm border ${
                isSettingOverridden("detectorMode")
                  ? "bg-muted cursor-not-allowed"
                  : "focus:outline-none focus:ring-2 focus:ring-primary"
              }`}
            >
              <option value="rules">Rules only (fast, deterministic patterns)</option>
              <option value="llm">LLM only (semantic detection via GLiNER)</option>
              <option value="hybrid">Hybrid (rules + LLM, rules take priority)</option>
              <option value="auto">Auto (choose based on content)</option>
            </select>
            <SettingHelp
              meta={getMeta("detectorMode")}
              description={SETTING_DESCRIPTIONS.detectorMode}
            />
          </div>
        );
      case "detectorModelDir":
        return (
          <div>
            <Label htmlFor="detectorModelDir" className="block text-sm font-medium mb-2">
              GLiNER Model Directory
            </Label>
            <Input
              id="detectorModelDir"
              value={settings.detectorModelDir}
              onChange={(e) => updateSetting("detectorModelDir", e.target.value)}
              placeholder="/path/to/gliner-model"
              disabled={isSettingOverridden("detectorModelDir")}
              className={
                isSettingOverridden("detectorModelDir") ? "bg-muted cursor-not-allowed" : ""
              }
            />
            <SettingHelp
              meta={getMeta("detectorModelDir")}
              description={SETTING_DESCRIPTIONS.detectorModelDir}
            />
          </div>
        );
      case "detectorThreshold":
        return (
          <div>
            <Label htmlFor="detectorThreshold" className="block text-sm font-medium mb-2">
              LLM Detection Threshold (0-1)
            </Label>
            <Input
              id="detectorThreshold"
              type="number"
              step="0.05"
              min="0"
              max="1"
              value={settings.detectorThreshold}
              onChange={(e) => {
                const val = parseFloat(e.target.value);
                if (!isNaN(val) && val >= 0 && val <= 1) {
                  updateSetting("detectorThreshold", val);
                }
              }}
              placeholder="0.5"
              disabled={isSettingOverridden("detectorThreshold")}
              className={
                isSettingOverridden("detectorThreshold") ? "bg-muted cursor-not-allowed" : ""
              }
            />
            <SettingHelp
              meta={getMeta("detectorThreshold")}
              description={SETTING_DESCRIPTIONS.detectorThreshold}
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
                disabled={isSettingOverridden("captureCleanupEnabled")}
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
              disabled={isSettingOverridden("captureCleanupIntervalHours")}
              className={
                isSettingOverridden("captureCleanupIntervalHours")
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
              disabled={isSettingOverridden("captureCleanupMaxAgeDays")}
              className={
                isSettingOverridden("captureCleanupMaxAgeDays")
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
      case "rateLimiter": {
        const providers: Provider[] = [
          "anthropic",
          "openai",
          "chatgpt",
          "gemini",
          "vertex",
          "nvidia",
          "openrouter",
          "kilo",
          "unknown",
        ];
        return (
          <div className="space-y-4">
            <h3 className="font-semibold mb-2">Rate Limiter Configuration</h3>
            <p className="text-sm text-muted-foreground mb-4">
              Configure rate limits per provider. Controls max requests, time window, and burst capacity.
            </p>
            <SettingHelp
              meta={getMeta("rateLimiter")}
              description={SETTING_DESCRIPTIONS.rateLimiter}
            />
            <div className="overflow-x-auto">
              <table className="w-full text-sm border rounded">
                <thead className="bg-muted">
                  <tr>
                    <th className="px-3 py-2 text-left font-medium">Provider</th>
                    <th className="px-3 py-2 text-left font-medium">Max Requests</th>
                    <th className="px-3 py-2 text-left font-medium">Window (ms)</th>
                    <th className="px-3 py-2 text-left font-medium">Buffer Capacity</th>
                  </tr>
                </thead>
                <tbody>
                  {providers.map((provider) => {
                    const config = settings.rateLimiter?.[provider];
                    const providerLabel = provider.charAt(0).toUpperCase() + provider.slice(1);
                    const rowId = `ratelimit-${provider}`;
                    return (
                      <tr key={provider} className="border-t">
                        <td className="px-3 py-2 font-medium">{providerLabel}</td>
                        <td className="px-3 py-2">
                          <Label htmlFor={`${rowId}-max`} className="sr-only">
                            {providerLabel} max requests
                          </Label>
                          <Input
                            id={`${rowId}-max`}
                            type="number"
                            min="1"
                            max="10000"
                            value={config?.maxRequests ?? 60}
                            onChange={(e) =>
                              updateRateLimiter(provider, "maxRequests", parseInt(e.target.value) || 1)
                            }
                            disabled={isSettingOverridden("rateLimiter")}
                            className="w-20"
                          />
                        </td>
                        <td className="px-3 py-2">
                          <Label htmlFor={`${rowId}-window`} className="sr-only">
                            {providerLabel} window milliseconds
                          </Label>
                          <Input
                            id={`${rowId}-window`}
                            type="number"
                            min="100"
                            max="86400000"
                            value={config?.windowMs ?? 60000}
                            onChange={(e) =>
                              updateRateLimiter(provider, "windowMs", parseInt(e.target.value) || 60000)
                            }
                            disabled={isSettingOverridden("rateLimiter")}
                            className="w-24"
                          />
                        </td>
                        <td className="px-3 py-2">
                          <Label htmlFor={`${rowId}-buffer`} className="sr-only">
                            {providerLabel} buffer capacity
                          </Label>
                          <Input
                            id={`${rowId}-buffer`}
                            type="number"
                            min="0"
                            max="10000"
                            value={config?.bufferCapacity ?? 10}
                            onChange={(e) =>
                              updateRateLimiter(provider, "bufferCapacity", parseInt(e.target.value) || 0)
                            }
                            disabled={isSettingOverridden("rateLimiter")}
                            className="w-16"
                          />
                        </td>
                      </tr>
                    );
                  })}
                </tbody>
              </table>
            </div>
          </div>
        );
      }
      default:
        return null;
    }
  };

  const renderThemeSetting = () => {
    const themeDisabled = themeIsOverridden;
    // Theme options organized by category
    const themeOptions = [
      { value: "light", label: "Light" },
      { value: "dark", label: "Dark" },
      { value: "system", label: "System (follows OS preference)" },
      { value: "high-contrast", label: "High Contrast" },
      // Material Design (Google Material 3)
      { value: "material-light", label: "Material (Light)" },
      { value: "material-dark", label: "Material (Dark)" },
      // Solarized
      { value: "solarized-light", label: "Solarized (Light)" },
      { value: "solarized-dark", label: "Solarized (Dark)" },
      // Dracula
      { value: "dracula", label: "Dracula" },
      // Nord
      { value: "nord", label: "Nord" },
      // GitHub
      { value: "github-light", label: "GitHub (Light)" },
      { value: "github-dark", label: "GitHub (Dark)" },
      // One Dark (Atom/VS Code)
      { value: "one-dark", label: "One Dark" },
      // Monokai
      { value: "monokai", label: "Monokai" },
    ];

    return (
      <div>
        <Label htmlFor="theme" className="block text-sm font-medium mb-2">
          Theme
          {themeIsOverridden && (
            <span className="ml-2 text-xs text-amber-600 dark:text-amber-400 font-normal">
              (Set by environment variable)
            </span>
          )}
        </Label>
        <select
          id="theme"
          value={theme}
          onChange={(e) =>
            setTheme(e.target.value as "light" | "dark" | "system" | "high-contrast" | "material-light" | "material-dark" | "solarized-light" | "solarized-dark" | "dracula" | "nord" | "github-light" | "github-dark" | "one-dark" | "monokai")
          }
          disabled={themeDisabled}
          className={`w-full rounded-md px-3 py-2 text-sm border ${
            themeDisabled ? "bg-muted cursor-not-allowed" : "focus:outline-none focus:ring-2 focus:ring-primary"
          }`}
        >
          {themeOptions.map(({ value, label }) => (
            <option key={value} value={value}>
              {label}
            </option>
          ))}
        </select>
        <SettingHelp
          meta={getMeta("theme")}
          description="Select the color theme for the web UI. System follows your OS preference. Changes apply immediately."
        />
      </div>
    );
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
              <div className="pt-2 border-t">
                <h4 className="text-sm font-medium text-muted-foreground mb-3">Detector Settings</h4>
                <div className="space-y-4">
                  {renderSetting("detectorMode")}
                  {renderSetting("detectorModelDir")}
                  {renderSetting("detectorThreshold")}
                </div>
              </div>
            </div>
          </div>
          <div className="rounded-lg border p-6">
            <h3 className="font-semibold mb-4">Security</h3>
            <div className="space-y-4">
              {renderSetting("encryptionAtRest")}
              {renderSetting("oidcEnabled")}
              {renderSetting("oidcPublicUrl")}
            </div>
          </div>
          <div className="rounded-lg border p-6">
            <h3 className="font-semibold mb-4">Rate Limiter</h3>
            <div className="space-y-4">
              {renderSetting("rateLimiter")}
            </div>
          </div>
          <div className="rounded-lg border p-6">
            <h3 className="font-semibold mb-4">Appearance</h3>
            <div className="space-y-4">
              {renderSetting("theme")}
              {renderSetting("showPageLoadTime")}
            </div>
          </div>

          {/* Providers Section */}
          <div className="rounded-lg border p-6">
            <div className="flex items-center justify-between mb-4">
              <h3 className="font-semibold">Providers</h3>
              <Button
                type="button"
                variant="outline"
                size="sm"
                onClick={openAddProviderDialog}
                disabled={providersLoading}
              >
                <Plus className="h-4 w-4 mr-2" />
                Add Provider
              </Button>
            </div>
            <p className="text-xs text-muted-foreground mb-4">
              Default and environment-configured providers are managed externally. 
              Click "Add Provider" to create your own custom provider, which you can then edit or delete.
            </p>
            
            {providersError && (
              <div className="rounded-md border border-red-200 bg-red-50 p-3 text-sm text-red-800 mb-4">
                {providersError}
              </div>
            )}

            {providersLoading ? (
              <div className="flex items-center justify-center py-8">
                <Loader2 className="h-8 w-8 animate-spin text-primary" />
              </div>
            ) : providers.length === 0 ? (
              <div className="text-center py-8 text-muted-foreground">
                <p>No providers configured. Click "Add Provider" to create one.</p>
              </div>
            ) : (
              <div className="overflow-x-auto">
                <table className="w-full text-sm border rounded">
                  <thead className="bg-muted">
                    <tr>
                      <th className="px-3 py-2 text-left font-medium">Name</th>
                      <th className="px-3 py-2 text-left font-medium">ID</th>
                      <th className="px-3 py-2 text-left font-medium">Base URL</th>
                      <th className="px-3 py-2 text-left font-medium">Models</th>
                      <th className="px-3 py-2 text-left font-medium">Status</th>
                      <th className="px-3 py-2 text-left font-medium">Actions</th>
                    </tr>
                  </thead>
                  <tbody>
                    {providers.map((provider) => (
                      <tr key={provider.id} className="border-t">
                        <td className="px-3 py-2 font-medium">{provider.name}</td>
                        <td className="px-3 py-2 font-mono text-xs">{provider.id}</td>
                        <td className="px-3 py-2 font-mono text-xs max-w-xs truncate" title={provider.baseUrl}>
                          {provider.baseUrl}
                        </td>
<td className="px-3 py-2">
                           {provider.models.length > 0 ? (
                             <span className="text-xs text-muted-foreground whitespace-pre-wrap">{provider.models.join("\n")}</span>
                           ) : (
                             <span className="text-xs text-muted-foreground">—</span>
                           )}
                         </td>
                        <td className="px-3 py-2">
                          <span
                            className={`inline-flex items-center rounded-full px-2 py-0.5 text-xs font-medium ${
                              provider.source === "file"
                                ? "bg-blue-100 text-blue-800"
                                : provider.source === "env"
                                ? "bg-amber-100 text-amber-800"
                                : "bg-gray-100 text-gray-800"
                            }`}
                            title={
                              provider.source === "file"
                                ? "Configured in providers.json (user-defined)"
                                : provider.source === "env"
                                ? "Configured via environment variable"
                                : "Default built-in provider"
                            }
                          >
                            {provider.source === "file" ? "File" : provider.source === "env" ? "Env" : "Default"}
                          </span>
                          {provider.dynamic && (
                            <span className="ml-1 inline-flex items-center rounded-full px-1.5 py-0.5 text-[10px] font-medium bg-green-100 text-green-800" title="User-created">
                              Custom
                            </span>
                          )}
                          {provider.source === "env" && (
                            <span className="ml-1 inline-flex items-center rounded-full px-1.5 py-0.5 text-[10px] font-medium bg-amber-100 text-amber-800" title="Overridden by environment variable">
                              Env Override
                            </span>
                          )}
                        </td>
<td className="px-3 py-2">
                           <div className="flex items-center gap-2">
                             {provider.source === "file" && provider.dynamic && (
                               <>
                                 <Button
                                   type="button"
                                   variant="ghost"
                                   size="sm"
                                   onClick={() => openEditProviderDialog(provider)}
                                   disabled={providerFormSubmitting}
                                   className="h-8 w-8 p-0"
                                   title="Edit provider"
                                 >
                                   <Edit2 className="h-4 w-4" />
                                 </Button>
                                 <Button
                                   type="button"
                                   variant="ghost"
                                   size="sm"
                                   onClick={() => openDeleteProviderDialog(provider)}
                                   disabled={deleteProviderSubmitting}
                                   className="h-8 w-8 p-0 text-red-600 hover:text-red-700 hover:bg-red-50"
                                   title="Delete provider"
                                 >
                                   <Trash2 className="h-4 w-4" />
                                 </Button>
                               </>
                             )}
                             {provider.source === "default" && (
                               <Button
                                 type="button"
                                 variant="ghost"
                                 size="sm"
                                 onClick={() => openEditProviderDialog(provider)}
                                 disabled={providerFormSubmitting}
                                 className="h-8 w-8 p-0"
                                 title="Edit provider (creates custom copy)"
                               >
                                 <Edit2 className="h-4 w-4" />
                               </Button>
                             )}
                             {provider.source !== "file" && provider.source !== "default" && (
                               <span className="text-xs text-muted-foreground">Managed externally</span>
                             )}
                           </div>
                         </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            )}
          </div>

          <Button type="submit" className="w-full md:w-auto" disabled={loading}>
            {loading ? "Loading..." : "Save Settings"}
          </Button>
        </form>
      </div>

      {/* Add Provider Dialog */}
      <Dialog open={addProviderDialogOpen} onOpenChange={setAddProviderDialogOpen}>
        <DialogContent className="max-w-md">
          <DialogHeader>
            <DialogTitle>Add Provider</DialogTitle>
            <DialogDescription>
              Configure a new API provider. All fields are required.
            </DialogDescription>
          </DialogHeader>
          <form onSubmit={handleProviderFormSubmit}>
            <div className="grid gap-4 py-4">
              <div className="space-y-2">
                <Label htmlFor="provider-id">Provider ID</Label>
                <Input
                  id="provider-id"
                  value={providerFormData.id}
                  onChange={(e) => handleProviderFormChange("id", e.target.value)}
                  placeholder="e.g., my-custom-provider"
                  disabled={providerFormSubmitting}
                />
              </div>
              <div className="space-y-2">
                <Label htmlFor="provider-name">Display Name</Label>
                <Input
                  id="provider-name"
                  value={providerFormData.name}
                  onChange={(e) => handleProviderFormChange("name", e.target.value)}
                  placeholder="e.g., My Custom Provider"
                  disabled={providerFormSubmitting}
                />
              </div>
              <div className="space-y-2">
                <Label htmlFor="provider-baseurl">Base URL</Label>
                <Input
                  id="provider-baseurl"
                  value={providerFormData.baseUrl}
                  onChange={(e) => handleProviderFormChange("baseUrl", e.target.value)}
                  placeholder="https://api.example.com"
                  disabled={providerFormSubmitting}
                />
              </div>
              <div className="space-y-2">
                <Label htmlFor="provider-models">Models (one per line)</Label>
                <textarea
                  id="provider-models"
                  value={providerFormData.models.join("\n")}
                  onChange={(e) => handleProviderFormChange("models", e.target.value.split("\n").map(s => s.trim()).filter(Boolean))}
                  placeholder="model-1&#10;model-2&#10;model-3"
                  disabled={providerFormSubmitting}
                  className="flex min-h-[80px] w-full rounded-md border border-input bg-background px-3 py-2 text-sm ring-offset-background file:border-0 file:bg-transparent file:text-sm file:font-medium placeholder:text-muted-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2 disabled:cursor-not-allowed disabled:opacity-50"
                  rows={4}
                />
                <p className="text-xs text-muted-foreground">Optional: one model name per line (commas in names are supported)</p>
              </div>
              <div className="space-y-2">
                <div className="flex items-center gap-2">
                  <input
                    type="checkbox"
                    id="provider-allow-baseurl-override"
                    checked={providerFormData.allowBaseUrlOverride}
                    onChange={(e) => handleProviderFormChange("allowBaseUrlOverride", e.target.checked)}
                    disabled={providerFormSubmitting}
                    className="h-4 w-4 rounded border-gray-300"
                  />
                  <Label htmlFor="provider-allow-baseurl-override" className="text-sm">
                    Allow base URL override via header
                  </Label>
                </div>
                <p className="text-xs text-muted-foreground">When enabled, clients can override the base URL using the header below</p>
              </div>
              <div className="space-y-2">
                <Label htmlFor="provider-baseurl-override-header">Override Header Name</Label>
                <Input
                  id="provider-baseurl-override-header"
                  value={providerFormData.baseUrlOverrideHeader}
                  onChange={(e) => handleProviderFormChange("baseUrlOverrideHeader", e.target.value)}
                  placeholder="e.g., x-openai-baseurl"
                  disabled={providerFormSubmitting || !providerFormData.allowBaseUrlOverride}
                  className={!providerFormData.allowBaseUrlOverride ? "bg-muted cursor-not-allowed" : ""}
                />
                <p className="text-xs text-muted-foreground">Header name clients use to override the base URL (e.g., x-openai-baseurl)</p>
              </div>
              {providerFormError && (
                <div className="rounded-md border border-red-200 bg-red-50 p-3 text-sm text-red-800">
                  {providerFormError}
                </div>
              )}
            </div>
            <DialogFooter>
              <Button type="button" variant="outline" onClick={() => setAddProviderDialogOpen(false)} disabled={providerFormSubmitting}>
                Cancel
              </Button>
              <Button type="submit" disabled={providerFormSubmitting}>
                {providerFormSubmitting ? (
                  <>
                    <Loader2 className="h-4 w-4 animate-spin mr-2" />
                    Saving...
                  </>
                ) : (
                  "Add Provider"
                )}
              </Button>
            </DialogFooter>
          </form>
        </DialogContent>
      </Dialog>

      {/* Edit Provider Dialog */}
      <Dialog open={editProviderDialogOpen} onOpenChange={setEditProviderDialogOpen}>
        <DialogContent className="max-w-md">
          <DialogHeader>
            <DialogTitle>Edit Provider</DialogTitle>
            <DialogDescription>
              {isEditingDefault
                ? "Create a custom copy of this default provider with your modifications. The original default provider remains unchanged."
                : "Modify the provider configuration. Provider ID cannot be changed."}
            </DialogDescription>
          </DialogHeader>
          <form onSubmit={handleProviderFormSubmit}>
            <div className="grid gap-4 py-4">
              <div className="space-y-2">
                <Label htmlFor="edit-provider-id">Provider ID</Label>
                <Input
                  id="edit-provider-id"
                  value={providerFormData.id}
                  disabled
                  className="bg-muted cursor-not-allowed"
                />
                <p className="text-xs text-muted-foreground">Provider ID cannot be changed</p>
              </div>
              <div className="space-y-2">
                <Label htmlFor="edit-provider-name">Display Name</Label>
                <Input
                  id="edit-provider-name"
                  value={providerFormData.name}
                  onChange={(e) => handleProviderFormChange("name", e.target.value)}
                  placeholder="e.g., My Custom Provider"
                  disabled={providerFormSubmitting}
                />
              </div>
              <div className="space-y-2">
                <Label htmlFor="edit-provider-baseurl">Base URL</Label>
                <Input
                  id="edit-provider-baseurl"
                  value={providerFormData.baseUrl}
                  onChange={(e) => handleProviderFormChange("baseUrl", e.target.value)}
                  placeholder="https://api.example.com"
                  disabled={providerFormSubmitting}
                />
              </div>
              <div className="space-y-2">
                <Label htmlFor="edit-provider-models">Models (one per line)</Label>
                <textarea
                  id="edit-provider-models"
                  value={providerFormData.models.join("\n")}
                  onChange={(e) => handleProviderFormChange("models", e.target.value.split("\n").map(s => s.trim()).filter(Boolean))}
                  placeholder="model-1&#10;model-2&#10;model-3"
                  disabled={providerFormSubmitting}
                  className="flex min-h-[80px] w-full rounded-md border border-input bg-background px-3 py-2 text-sm ring-offset-background file:border-0 file:bg-transparent file:text-sm file:font-medium placeholder:text-muted-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2 disabled:cursor-not-allowed disabled:opacity-50"
                  rows={4}
                />
                <p className="text-xs text-muted-foreground">Optional: one model name per line (commas in names are supported)</p>
              </div>
              <div className="space-y-2">
                <div className="flex items-center gap-2">
                  <input
                    type="checkbox"
                    id="edit-provider-allow-baseurl-override"
                    checked={providerFormData.allowBaseUrlOverride}
                    onChange={(e) => handleProviderFormChange("allowBaseUrlOverride", e.target.checked)}
                    disabled={providerFormSubmitting}
                    className="h-4 w-4 rounded border-gray-300"
                  />
                  <Label htmlFor="edit-provider-allow-baseurl-override" className="text-sm">
                    Allow base URL override via header
                  </Label>
                </div>
                <p className="text-xs text-muted-foreground">When enabled, clients can override the base URL using the header below</p>
              </div>
              <div className="space-y-2">
                <Label htmlFor="edit-provider-baseurl-override-header">Override Header Name</Label>
                <Input
                  id="edit-provider-baseurl-override-header"
                  value={providerFormData.baseUrlOverrideHeader}
                  onChange={(e) => handleProviderFormChange("baseUrlOverrideHeader", e.target.value)}
                  placeholder="e.g., x-openai-baseurl"
                  disabled={providerFormSubmitting || !providerFormData.allowBaseUrlOverride}
                  className={!providerFormData.allowBaseUrlOverride ? "bg-muted cursor-not-allowed" : ""}
                />
                <p className="text-xs text-muted-foreground">Header name clients use to override the base URL (e.g., x-openai-baseurl)</p>
              </div>
              {providerFormError && (
                <div className="rounded-md border border-red-200 bg-red-50 p-3 text-sm text-red-800">
                  {providerFormError}
                </div>
              )}
            </div>
            <DialogFooter>
              <Button type="button" variant="outline" onClick={() => { setEditProviderDialogOpen(false); setEditingProvider(null); setIsEditingDefault(false); }} disabled={providerFormSubmitting}>
                Cancel
              </Button>
              <Button type="submit" disabled={providerFormSubmitting}>
                {providerFormSubmitting ? (
                  <>
                    <Loader2 className="h-4 w-4 animate-spin mr-2" />
                    Saving...
                  </>
                ) : (
                  "Save Changes"
                )}
              </Button>
            </DialogFooter>
          </form>
        </DialogContent>
      </Dialog>

      {/* Delete Provider Dialog */}
      <Dialog open={deleteProviderDialogOpen} onOpenChange={setDeleteProviderDialogOpen}>
        <DialogContent className="max-w-md">
          <DialogHeader>
            <DialogTitle>Delete Provider</DialogTitle>
            <DialogDescription>
              Are you sure you want to delete this provider? This action cannot be undone.
            </DialogDescription>
          </DialogHeader>
          <div className="py-4">
            {deletingProvider && (
              <div className="space-y-2 text-sm">
                <p><strong>Name:</strong> {deletingProvider.name}</p>
                <p><strong>ID:</strong> <code className="text-xs bg-muted px-1 rounded">{deletingProvider.id}</code></p>
                <p><strong>Base URL:</strong> <code className="text-xs bg-muted px-1 rounded">{deletingProvider.baseUrl}</code></p>
              </div>
            )}
            {providerFormError && (
              <div className="rounded-md border border-red-200 bg-red-50 p-3 text-sm text-red-800 mt-4">
                {providerFormError}
              </div>
            )}
          </div>
          <DialogFooter>
            <Button
              type="button"
              variant="outline"
              onClick={() => { setDeleteProviderDialogOpen(false); setDeletingProvider(null); }}
              disabled={deleteProviderSubmitting}
            >
              Cancel
            </Button>
            <Button
              type="button"
              variant="destructive"
              onClick={handleDeleteProvider}
              disabled={deleteProviderSubmitting}
            >
              {deleteProviderSubmitting ? (
                <>
                  <Loader2 className="h-4 w-4 animate-spin mr-2" />
                  Deleting...
                </>
              ) : (
                "Delete Provider"
              )}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </MainLayout>
  );
}