"use client";

import { MainLayout } from "@/components/main-layout";
import { apiClient } from "@/lib/api";
import { DEFAULT_SETTINGS } from "@/lib/settings";
import type { Settings, SettingMeta, Provider, RateLimitConfig, StreamingRetryConfig } from "@/lib/settings";
import type { ProviderConfig, ProviderMetadata, MaintenanceOperation, MaintenanceResult } from "@/types/api";
import type { PresetName } from "@contextio/redact";
import { useState, useEffect, useRef } from "react";
import { useTheme } from "@/components/theme-provider";
import { FalsePositiveManager } from "@/components/FalsePositiveManager";
import { LogsViewer } from "@/components/logs-viewer";
import { EnvironmentVariablesPanel } from "@/components/environment-variables-panel";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Tooltip } from "@/components/ui/tooltip";
import { cn } from "@/lib/utils";

/** Preset rule names for UI display (avoids importing @contextio/redact which brings Node.js deps) */
const PRESET_RULES: Record<PresetName, string[]> = {
  secrets: [
    "private-key",
    "credential_aws_key",
    "aws-secret-key",
    "credential_github",
    "credential_anthropic",
    "credential_openai",
    "credential_gcp_api_key",
    "credential_gcp_service_account",
    "credential_gitlab",
    "credential_jwt",
    "credential_stripe",
    "credential_slack",
    "credential_huggingface",
    "credential_databricks",
    "credential_npm",
    "credential_pypi",
    "credential_vault",
    "credential_sendgrid",
    "credential_nvidia",
    "credential_openrouter",
    "credential_kilo",
    "authorization-header",
    "bearer-token",
    "api-key-prefixed",
    "credential_generic",
  ],
  pii: [
    "EMAIL",
    "PHONE",
    "URL",
    "IP_ADDRESS",
    "IPV6",
    "ORGANIZATION",
    "PERSON",
    "LOCATION",
    "DATE_TIME",
    "US_SSN",
    "CREDIT_CARD",
    "IBAN",
    "PASSPORT",
    "DRIVERS_LICENSE",
    "MAC_ADDRESS",
  ],
  strict: [
    "EMAIL",
    "PHONE",
    "URL",
    "IP_ADDRESS",
    "IPV6",
    "ORGANIZATION",
    "PERSON",
    "LOCATION",
    "DATE_TIME",
    "US_SSN",
    "CREDIT_CARD",
    "IBAN",
    "PASSPORT",
    "DRIVERS_LICENSE",
    "MAC_ADDRESS",
    "AGE",
    "BLOOD_TYPE",
    "MEDICAL_RECORD",
    "VEHICLE_ID",
    "USERNAME",
    "PASSWORD",
    "API_KEY",
    "CRYPTO_WALLET",
    "US_BANK_ACCOUNT",
    "US_ROUTING_NUMBER",
    "SWIFT_BIC",
    "CVV",
    "EXPIRY",
  ],
};

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
import { AlertCircle, Loader2, Trash2, Edit2, Plus, Database, Shield, Gauge, Palette, Server, EyeOff, HardDrive, RotateCcw } from "lucide-react";

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
  redactPolicyEnabled:
    "Enable or disable the custom policy file. When disabled, the preset dropdown is used instead even if a policy file path is configured. Changes apply dynamically per request.",
  redactPathsOnly:
    "JSON paths where redaction should be applied (e.g., ['messages[*].content']). Only values at these paths will be checked for redaction. Changes apply dynamically per request.",
  redactPathsSkip:
    "JSON paths where redaction should be skipped (e.g., tool call IDs, function arguments). These are checked before 'only' paths. Default includes all tool call and structured data paths to prevent NER false positives. Changes apply dynamically per request.",
  redactDisabledRules:
    "List of redaction rule IDs to disable. Use this to selectively disable specific redaction types (e.g., URL, ORGANIZATION) while keeping others active. Changes apply dynamically per request.",
  redactProviders:
    "Enable or disable PII/secrets redaction per provider. When a provider is disabled, traffic for that provider passes through unredacted. Requires a proxy restart to apply.",
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
  oidcIssuer:
    "OIDC issuer URL (e.g., https://accounts.google.com). Used to discover OIDC configuration and validate tokens. Requires a proxy restart to apply.",
  showPageLoadTime:
    "Display page load time in the bottom-left corner. Measures time from navigation start to fully interactive page (hydration + data fetch + render complete). Changes apply immediately.",
  feedbackStoreEnabled:
    "Enable the feedback store for persisting false positive entries. When enabled, false positives are stored and survive proxy restarts. Requires a proxy restart to apply.",
  feedbackStoreType:
    "Storage backend for false positives: 'sqlite' (persistent, file-based) or 'memory' (in-memory, lost on restart). Requires a proxy restart to apply.",
  feedbackStorePath:
    "File path for SQLite feedback store (e.g., /app/data/false-positives.db). Only used when type is 'sqlite'. Leave empty for default location. Requires a proxy restart to apply.",
  detectorMode:
    "Detection mode: 'rules' (fast, deterministic patterns), 'llm' (semantic PII detection via LLM), 'hybrid' (rules + LLM with priority merge), or 'auto' (automatically choose). Changes apply dynamically per request.",
  detectorModelName:
    "Name of the Hugging Face model used for LLM-based PII detection (e.g., 'Xenova/bert-base-NER'). Used in llm/hybrid/auto modes. Changes apply dynamically.",
  detectorThreshold:
    "Minimum confidence threshold for LLM-based detections (0-1). Higher values reduce false positives but may miss some entities. Applied dynamically per request.",
  detectorLabels:
    "Entity types for LLM-based PII detection (e.g., PERSON, ORGANIZATION, LOCATION, EMAIL_ADDRESS, PHONE_NUMBER, CREDIT_CARD, US_SSN, IP_ADDRESS, URL, DATE_TIME). Used in llm/hybrid/auto modes. Changes apply dynamically per request.",
  strictBoundaries:
    "Enable strict word boundary checking for LLM-based detections. When enabled, prevents substring matches (e.g., 10-digit phone number within a 25-digit string, organization names within longer text). Applied dynamically per request. Requires LLM detector mode (llm, hybrid, or auto).",
  rateLimiter:
    "Rate limiting configuration per provider. Controls max requests, time window, and burst capacity. Requires a proxy restart to apply.",
  streamingRetry:
    "Streaming retry configuration per provider. Controls retry attempts and buffer size for rate-limited streaming responses. Requires a proxy restart to apply.",
  // Feature flags
  enableLogger:
    "Enable or disable request/response logging to capture files. When disabled, no API traffic is captured. Requires a proxy restart to apply.",
  logTraffic:
    "Enable detailed raw traffic logging (headers, body). This can be verbose and impact performance. Requires a proxy restart to apply.",
  enableRedact:
    "Enable or disable PII/secrets redaction on captured traffic. When disabled, no redaction occurs regardless of preset or policy. Requires a proxy restart to apply.",
  enableRateLimiter:
    "Enable or disable rate limiting across all providers. When disabled, no rate limits are enforced. Requires a proxy restart to apply.",
  // Advanced rate limiter cache
  rateLimiterMaxEntries:
    "Maximum number of entries in the rate limiter cache. Higher values use more memory but track more clients. Requires a proxy restart to apply.",
  rateLimiterCleanupIntervalMs:
    "How often the rate limiter cache cleanup job runs (milliseconds). Lower values clean more aggressively. Requires a proxy restart to apply.",
  rateLimiterEntryTtlMs:
    "Time-to-live for rate limiter cache entries (milliseconds). Entries older than this are eligible for cleanup. Requires a proxy restart to apply.",
  // Advanced streaming retry cache
  retryMaxEntries:
    "Maximum number of entries in the streaming retry cache. Higher values use more memory but track more streams. Requires a proxy restart to apply.",
  retryEntryTtlMs:
    "Time-to-live for streaming retry cache entries (milliseconds). Requires a proxy restart to apply.",
  retryCleanupIntervalMs:
    "How often the streaming retry cache cleanup job runs (milliseconds). Requires a proxy restart to apply.",
  retryMaxBufferSize:
    "Maximum buffer size for streaming response buffering (bytes). Larger values allow bigger responses but use more memory. Requires a proxy restart to apply.",
  retryMaxStreamRetries:
    "Maximum number of retry attempts for rate-limited streaming responses. Requires a proxy restart to apply.",
  // Proxy configuration
  proxyBindHost:
    "Host address the proxy binds to. Use 0.0.0.0 to listen on all interfaces, or a specific IP. Requires a proxy restart to apply.",
  proxyPort:
    "Port the proxy listens on. Requires a proxy restart to apply.",
  proxyAllowTargetOverride:
    "Allow clients to override the target upstream via header. Requires a proxy restart to apply.",
  strictUrlForwarding:
    "Enforce strict URL forwarding rules (reject unknown paths). Requires a proxy restart to apply.",
  upstreamOpenRouterUrl:
    "Upstream OpenRouter URL for forwarding. If empty, uses default OpenRouter endpoint. Requires a proxy restart to apply.",
  upstreamOpenAiUrl:
    "Upstream OpenAI URL for forwarding. If empty, uses default OpenAI endpoint. Requires a proxy restart to apply.",
  upstreamAnthropicUrl:
    "Upstream Anthropic URL for forwarding. If empty, uses default Anthropic endpoint. Requires a proxy restart to apply.",
  upstreamChatGptUrl:
    "Upstream ChatGPT URL for forwarding. If empty, uses default ChatGPT endpoint. Requires a proxy restart to apply.",
  upstreamGeminiUrl:
    "Upstream Gemini URL for forwarding. If empty, uses default Gemini endpoint. Requires a proxy restart to apply.",
  upstreamVertexUrl:
    "Upstream Vertex AI URL for forwarding. If empty, uses default Vertex AI endpoint. Requires a proxy restart to apply.",
  upstreamNvidiaUrl:
    "Upstream NVIDIA URL for forwarding. If empty, uses default NVIDIA endpoint. Requires a proxy restart to apply.",
  upstreamKiloUrl:
    "Upstream Kilo URL for forwarding. If empty, uses default Kilo endpoint. Requires a proxy restart to apply.",
  upstreamGeminiCodeAssistUrl:
    "Upstream Gemini Code Assist URL for forwarding. If empty, uses default Gemini Code Assist endpoint. Requires a proxy restart to apply.",
};

function SettingBadges({ meta }: { meta: SettingMeta | undefined }) {
  if (!meta) return null;
  return (
    <div className="mt-1 flex flex-wrap items-center gap-2">
      {meta.source === "environment-variable" && meta.envVar && (
        <span
          className="inline-flex items-center rounded-full bg-primary/10 px-2 py-0.5 text-xs font-medium text-primary"
          title={`This value is controlled by the ${meta.envVar} environment variable and cannot be changed here`}
        >
          Overridden by {meta.envVar}
        </span>
      )}
        <span
          className={`inline-flex items-center rounded-full px-2 py-0.5 text-xs font-medium ${
            meta.dynamic
              ? "bg-primary/10 text-primary"
              : "bg-muted text-foreground"
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

// Detector Mode Warnings Component
// Shows which policy features are active/ignored based on the current detector mode
function DetectorModeWarnings({
  detectorMode,
  detectorModelName,
  detectorThreshold,
  detectorLabels,
  hasCustomPolicy,
}: {
  detectorMode: "rules" | "llm" | "hybrid" | "auto";
  detectorModelName: string;
  detectorThreshold: number;
  detectorLabels: string[];
  hasCustomPolicy: boolean;
}) {
  const warnings: Array<{ title: string; description: string; type: "info" | "warning" | "success" }> = [];

  if (detectorMode === "rules") {
    warnings.push({
      title: "Detector Mode: Rules Only",
      description: "Only regex-based pattern matching is active. LLM-based semantic detection (PERSON, ORGANIZATION, LOCATION via NER) is disabled. Detector model name and threshold settings are ignored.",
      type: "info",
    });
  } else if (detectorMode === "llm") {
    warnings.push({
      title: "Detector Mode: LLM Only",
      description: "Only semantic PII detection via transformers.js (NER) is active. Custom regex rules from presets/policy file are ignored. Path filtering (only/skip) is still applied. Context-gated rules will not run.",
      type: "warning",
    });
    if (detectorLabels.length > 0) {
      warnings.push({
        title: "Active LLM Entity Labels",
        description: `The LLM detector will identify: ${detectorLabels.join(", ")}`,
        type: "info",
      });
    }
    if (hasCustomPolicy) {
      warnings.push({
        title: "Custom Policy File Detected",
        description: "A custom policy file is configured but its custom regex rules will be ignored in LLM-only mode. Only path filtering and allowlists from the policy will be applied.",
        type: "warning",
      });
    }
  } else if (detectorMode === "hybrid") {
    warnings.push({
      title: "Detector Mode: Hybrid",
      description: "Both regex rules and LLM detection run. Rule detections take priority (rules win overlaps). Presidio NER is disabled for entity types already covered by policy rules (e.g., email, phone, SSN) to avoid duplicates. Path filtering and allowlists apply to both.",
      type: "success",
    });
  } else if (detectorMode === "auto") {
    warnings.push({
      title: "Detector Mode: Auto",
      description: "Currently behaves as Hybrid mode. Future enhancement: will automatically choose Rules or Hybrid based on content complexity. Presidio NER disabled for entity types covered by policy rules. Path filtering and allowlists apply.",
      type: "info",
    });
  }

  // Common warnings for LLM modes
  if (detectorMode !== "rules") {
    // Model name is user-configurable but only specific models are supported
    if (!detectorModelName.startsWith("Xenova/")) {
      warnings.push({
        title: "Model Name",
        description: `Using custom model "${detectorModelName}". The preset detector (@siddicky/anonymizerts) only supports Xenova/bert-base-NER based models. Other models may not work correctly.`,
        type: "warning",
      });
    }
    if (detectorThreshold < 0.3) {
      warnings.push({
        title: "Low Confidence Threshold",
        description: `Threshold is ${detectorThreshold}. Values below 0.3 may produce many false positives. Recommended: 0.5 for balanced precision/recall.`,
        type: "warning",
      });
    }
  }

  // Custom policy file warnings
  if (hasCustomPolicy && detectorMode !== "rules") {
    warnings.push({
      title: "Policy File Integration",
      description: "Custom policy file is loaded. Note: detector.options (custom analyzer options) are parsed but not passed to the Presidio analyzer due to library limitations. Custom regex rules with context gating may be redundant with LLM NER for PERSON/ORG/LOCATION.",
      type: "info",
    });
  }

  if (warnings.length === 0) return null;

  return (
    <div className="space-y-3 mt-4">
      {warnings.map((w, i) => (
        <div
          key={i}
          className={`rounded-lg border p-3 text-sm ${
            w.type === "info"
              ? "border-primary/30 bg-primary/10 text-primary"
              : w.type === "warning"
              ? "border-primary/30 bg-primary/10 text-primary"
              : "border-primary/30 bg-primary/10 text-primary"
          }`}
        >
          <div className="font-medium mb-1">{w.title}</div>
          <div className="text-xs">{w.description}</div>
        </div>
      ))}
    </div>
  );
}

// Disabled Rules List Component
// Shows all available redaction rules grouped by category with checkboxes to enable/disable
function DisabledRulesList({
  disabledRules,
  onChange,
  disabled,
  preset,
  hasCustomPolicy,
  detectorMode,
}: {
  disabledRules: string[];
  onChange: (rules: string[]) => void;
  disabled: boolean;
  preset: PresetName;
  hasCustomPolicy: boolean;
  detectorMode: "rules" | "llm" | "hybrid" | "auto";
}) {
  const disabledSet = new Set(disabledRules);

  // Custom policy takes precedence - disabled rules are managed in the policy file
  // Only applies when a policy file is configured AND policy file usage is enabled
  const isCustomPolicyMode = hasCustomPolicy;

  // Build a mapping of rule name to human-readable description
  const ruleDescriptions: Record<string, string> = {
    // Secrets rules
    "private-key": "Private key blocks (RSA, EC, DSA, OPENSSH)",
    "credential_aws_key": "AWS access keys",
    "aws-secret-key": "AWS secret access keys",
    "credential_github": "GitHub tokens",
    "credential_anthropic": "Anthropic API keys",
    "credential_openai": "OpenAI API keys",
    "credential_gcp_api_key": "Google Cloud API keys",
    "credential_gcp_service_account": "GCP service account JSON",
    "credential_gitlab": "GitLab tokens",
    "credential_jwt": "JWT tokens",
    "credential_stripe": "Stripe keys",
    "credential_slack": "Slack tokens",
    "credential_huggingface": "Hugging Face tokens",
    "credential_databricks": "Databricks tokens",
    "credential_npm": "NPM tokens",
    "credential_pypi": "PyPI tokens",
    "credential_vault": "HashiCorp Vault tokens",
    "credential_sendgrid": "SendGrid API keys",
    "credential_nvidia": "NVIDIA API keys",
    "credential_openrouter": "OpenRouter API keys",
    "credential_kilo": "Kilo API keys",
    "authorization-header": "Authorization: Bearer headers",
    "bearer-token": "Bearer tokens in text",
    "api-key-prefixed": "Prefixed API keys (sk-, pk-, api-, key-, token-)",
    "credential_generic": "Generic secret assignments",

    // PII rules
    "email": "Email addresses",
    "ssn": "US Social Security Numbers",
    "credit-card": "Credit card numbers",
    "phone-us": "US phone numbers",
    "phone-eu": "European phone numbers",
    "iban": "IBAN bank account numbers",

    // Strict rules
    "ipv4": "IPv4 addresses",
    "ipv6": "IPv6 addresses",
    "date-of-birth": "Dates of birth (with context)",
    "bsn-dutch": "Dutch BSN numbers",
    "ni-number-uk": "UK National Insurance numbers",
    "passport-number": "Passport numbers",
  };

  // Group rules by preset/category
  const categories: Array<{ label: string; preset: "secrets" | "pii" | "strict"; rules: string[] }> = [
    { label: "Secrets (API keys, tokens, credentials)", preset: "secrets", rules: PRESET_RULES.secrets },
    { label: "PII (emails, phones, IDs)", preset: "pii", rules: PRESET_RULES.pii },
    { label: "Strict (IPs, dates, international IDs)", preset: "strict", rules: PRESET_RULES.strict },
  ];

  // Determine which categories are active based on current preset
  const activePresets: PresetName[] = preset === "strict" ? ["secrets", "pii", "strict"] : preset === "pii" ? ["secrets", "pii"] : ["secrets"];

  const handleToggle = (ruleName: string) => {
    if (disabled || isCustomPolicyMode) return;
    const newDisabled = disabledSet.has(ruleName)
      ? disabledRules.filter((r) => r !== ruleName)
      : [...disabledRules, ruleName];
    onChange(newDisabled);
  };

  return (
    <div className="space-y-4">
      {isCustomPolicyMode && (
        <div className="rounded-lg border border-destructive/30 bg-destructive/10 p-3 text-sm text-destructive">
          <strong>Custom policy file active:</strong> Disabled rules are managed in your custom policy file.
          Edit the policy file directly to enable/disable specific rules. The checkboxes below are disabled
          because they only apply to built-in presets.
        </div>
      )}
      {detectorMode === "llm" && (
        <div className="rounded-lg border border-destructive/30 bg-destructive/10 p-3 text-sm text-destructive">
          <strong>Disabled in LLM mode:</strong> Rules-based settings only apply in Rules, Hybrid, or Auto detector modes.
        </div>
      )}
      <div className="text-xs text-muted-foreground mb-2 font-medium">Rules-Based Settings</div>
      {categories
        .filter((cat) => activePresets.includes(cat.preset))
        .map((category) => (
          <div key={category.preset} className="space-y-2">
            <h5 className="text-sm font-medium text-muted-foreground uppercase tracking-wider">
              {category.label}
            </h5>
            <div className="grid gap-2 sm:grid-cols-2 lg:grid-cols-3">
              {category.rules.map((ruleName) => {
                const description = ruleDescriptions[ruleName] ?? ruleName;
                const isDisabled = disabledSet.has(ruleName);
                const isCheckboxDisabled = disabled || isCustomPolicyMode;
                return (
                  <label
                    key={ruleName}
                    className={`flex items-center gap-2 p-3 rounded-lg border transition-colors ${
                      isDisabled
                        ? "border-border bg-muted dark:bg-muted/50"
                        : "border-border bg-background hover:border-primary/50 dark:hover:border-primary"
                    } ${isCheckboxDisabled ? "opacity-50 cursor-not-allowed" : "cursor-pointer"}`}
                    title={description}
                  >
                    <input
                      type="checkbox"
                      checked={!isDisabled}
                      onChange={() => handleToggle(ruleName)}
                      disabled={isCheckboxDisabled}
                      className="w-4 h-4 rounded border-border text-primary focus:ring-primary"
                    />
                    <span className="text-sm font-mono text-foreground/80">{ruleName}</span>
                    <span className="text-xs text-muted-foreground flex-1 min-w-0 truncate">{description}</span>
                  </label>
                );
              })}
            </div>
          </div>
        ))}
      {disabled && !isCustomPolicyMode && (
        <div className="rounded-lg border border-destructive/30 bg-destructive/10 p-3 text-sm text-destructive">
          This setting is controlled by the <code>CONTEXTIO_REDACT_DISABLED_RULES</code> environment variable
          and cannot be changed here.
        </div>
      )}
    </div>
  );
}

// Tab configuration (module scope for stability)
type SettingsTab =
  | "appearance"
  | "database"
  | "envVars"
  | "falsePositives"
  | "logging"
  | "proxy"
  | "providers"
  | "rateLimiter"
  | "redaction"
  | "security"
  | "streamingRetry";

// Logging sub-tab types
type LoggingSubTab = "captureLogging" | "containerLogs";

const tabs: { id: SettingsTab; label: string; icon: React.ReactNode }[] = [
  { id: "appearance", label: "Appearance", icon: <Palette className="h-4 w-4" /> },
  { id: "database", label: "Database", icon: <Database className="h-4 w-4" /> },
  { id: "envVars", label: "Environment Variables", icon: <Server className="h-4 w-4" /> },
  { id: "falsePositives", label: "False Positives", icon: <AlertCircle className="h-4 w-4" /> },
  { id: "logging", label: "Logging", icon: <Database className="h-4 w-4" /> },
  { id: "proxy", label: "Proxy", icon: <Server className="h-4 w-4" /> },
  { id: "providers", label: "Providers", icon: <Server className="h-4 w-4" /> },
  { id: "rateLimiter", label: "Rate Limiter", icon: <Gauge className="h-4 w-4" /> },
  { id: "redaction", label: "Redaction", icon: <EyeOff className="h-4 w-4" /> },
  { id: "security", label: "Security", icon: <Shield className="h-4 w-4" /> },
  { id: "streamingRetry", label: "Streaming Retry", icon: <Gauge className="h-4 w-4" /> },
];

const loggingSubTabs: { id: LoggingSubTab; label: string }[] = [
  { id: "captureLogging", label: "Capture Logging" },
  { id: "containerLogs", label: "Container Logs" },
];

export default function SettingsPage() {
  const [settings, setSettings] = useState<Omit<Settings, "theme">>({
    logDir: "./captures",
    maxSessions: 0,
    redactPreset: "pii",
    redactReversible: false,
    redactPolicyFile: "",
    redactPolicyEnabled: true,
    redactPathsOnly: ["messages[*].content"],
    redactPathsSkip: [
      "tools",
      "tool_calls",
      "toolChoice",
      "tool_choice",
      "functions",
      "function_call",
      "messages[*].tool_calls[*].id",
      "messages[*].tool_calls[*].function.name",
      "messages[*].tool_calls[*].function.arguments",
      "messages[*].tools[*].id",
      "messages[*].tools[*].function.name",
      "messages[*].tools[*].function.arguments",
      "messages[*].function_call.id",
      "messages[*].function_call.name",
      "messages[*].function_call.arguments",
      "tool_calls[*].id",
      "tool_calls[*].function.name",
      "tool_calls[*].function.arguments",
      "tools[*].id",
      "tools[*].function.name",
      "tools[*].function.arguments",
      "function_call.id",
      "function_call.name",
      "function_call.arguments",
      "messages[*].content[*].id",
      "messages[*].content[*].name",
      "messages[*].content[*].input",
      "messages[*].content[*].tool_use_id",
      "messages[*].content[*].content",
      "messages[*].content[*].thinking",
      "messages[*].content[*].signature",
      "messages[*].content[*].type",
      "content[*].id",
      "content[*].name",
      "content[*].input",
      "content[*].tool_use_id",
      "content[*].content",
      "content[*].thinking",
      "content[*].signature",
      "content[*].type",
    ],
    redactDisabledRules: [],
    encryptionAtRest: false,
    captureCleanupEnabled: false,
    captureCleanupIntervalHours: 24,
    captureCleanupMaxAgeDays: 30,
    oidcEnabled: false,
    oidcPublicUrl: "",
    oidcIssuer: "",
    showPageLoadTime: false,
    feedbackStoreEnabled: true,
    feedbackStoreType: "sqlite",
    feedbackStorePath: "",
    detectorMode: "rules",
    detectorModelName: "Xenova/bert-base-NER",
    detectorThreshold: 0.5,
    detectorLabels: [
      "PERSON",
      "ORGANIZATION",
      "LOCATION",
      "EMAIL_ADDRESS",
      "PHONE_NUMBER",
      "CREDIT_CARD",
      "US_SSN",
      "IP_ADDRESS",
      "URL",
      "DATE_TIME",
    ],
    rateLimiter: {
      anthropic: { maxRequests: 60, windowMs: 60000, bufferCapacity: 10 },
      openai: { maxRequests: 60, windowMs: 60000, bufferCapacity: 10 },
      chatgpt: { maxRequests: 60, windowMs: 60000, bufferCapacity: 10 },
      gemini: { maxRequests: 60, windowMs: 60000, bufferCapacity: 10 },
      geminiCodeAssist: { maxRequests: 60, windowMs: 60000, bufferCapacity: 10 },
      vertex: { maxRequests: 60, windowMs: 60000, bufferCapacity: 10 },
      nvidia: { maxRequests: 60, windowMs: 60000, bufferCapacity: 10 },
      openrouter: { maxRequests: 60, windowMs: 60000, bufferCapacity: 10 },
      kilo: { maxRequests: 60, windowMs: 60000, bufferCapacity: 10 },
    },
    streamingRetry: {
      anthropic: { enabled: true, maxRetries: 3, maxBufferSizeMB: 10 },
      openai: { enabled: true, maxRetries: 3, maxBufferSizeMB: 10 },
      chatgpt: { enabled: true, maxRetries: 3, maxBufferSizeMB: 10 },
      gemini: { enabled: true, maxRetries: 3, maxBufferSizeMB: 10 },
      geminiCodeAssist: { enabled: true, maxRetries: 3, maxBufferSizeMB: 10 },
      vertex: { enabled: true, maxRetries: 3, maxBufferSizeMB: 10 },
      nvidia: { enabled: true, maxRetries: 3, maxBufferSizeMB: 10 },
      openrouter: { enabled: true, maxRetries: 3, maxBufferSizeMB: 10 },
      kilo: { enabled: true, maxRetries: 3, maxBufferSizeMB: 10 },
    },
    // Redaction enabled per provider
    redactProviders: {
      anthropic: true,
      openai: true,
      chatgpt: true,
      gemini: true,
      geminiCodeAssist: true,
      vertex: true,
      nvidia: true,
      openrouter: true,
      kilo: true,
    },
    // Feature flags
    enableLogger: true,
    logTraffic: false,
    enableRedact: true,
    enableRateLimiter: true,
    // Advanced rate limiter cache
    rateLimiterMaxEntries: 2000,
    rateLimiterCleanupIntervalMs: 60000,
    rateLimiterEntryTtlMs: 300000,
    // Advanced streaming retry cache
    retryMaxEntries: 1000,
    retryEntryTtlMs: 300000,
    retryCleanupIntervalMs: 30000,
    retryMaxBufferSize: 5242880,
    retryMaxStreamRetries: 3,
    // Proxy configuration
    proxyBindHost: "0.0.0.0",
    proxyPort: 4040,
    proxyAllowTargetOverride: false,
    strictUrlForwarding: false,
    upstreamOpenAiUrl: "",
    upstreamAnthropicUrl: "",
    upstreamChatGptUrl: "",
    upstreamGeminiUrl: "",
    upstreamVertexUrl: "",
    upstreamNvidiaUrl: "",
    upstreamOpenRouterUrl: "",
    upstreamKiloUrl: "",
    upstreamGeminiCodeAssistUrl: "",
    // Presidio strict boundaries for LLM detector
    strictBoundaries: false,
  });
  const [metadata, setMetadata] = useState<Record<
    keyof Settings,
    SettingMeta
  > | null>(null);
  const [saveMessage, setSaveMessage] = useState<{
    type: "success" | "error";
    message: string;
  } | null>(null);
  const [saveDialogOpen, setSaveDialogOpen] = useState(false);
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
  const [envContainerId, setEnvContainerId] = useState("contextio-next");

  // State for collapsible sections in the Redaction tab
  const [openSections, setOpenSections] = useState<Record<string, boolean>>({
    global: true,
    mode: true,
    rules: true,
    llm: true,
  });

  // Initialize active tab from localStorage or default to "logging"
  const [activeTab, setActiveTab] = useState<SettingsTab>(() => {
    if (typeof window !== "undefined") {
      const saved = localStorage.getItem("settings-active-tab");
      if (saved && tabs.some((t) => t.id === saved)) {
        return saved as SettingsTab;
      }
    }
    return "logging";
  });

  // Initialize active logging sub-tab from localStorage or default to "captureLogging"
  const [activeLoggingSubTab, setActiveLoggingSubTab] = useState<LoggingSubTab>(() => {
    if (typeof window !== "undefined") {
      const saved = localStorage.getItem("settings-logging-subtab");
      if (saved && loggingSubTabs.some((t) => t.id === saved)) {
        return saved as LoggingSubTab;
      }
    }
    return "captureLogging";
  });

  // Persist active tab to localStorage
  useEffect(() => {
    localStorage.setItem("settings-active-tab", activeTab);
  }, [activeTab]);

  // Persist active logging sub-tab to localStorage
  useEffect(() => {
    localStorage.setItem("settings-logging-subtab", activeLoggingSubTab);
  }, [activeLoggingSubTab]);

  // Keyboard navigation for tabs
  const handleTabKeyDown = (event: React.KeyboardEvent, _tabId: SettingsTab, index: number) => {
    let newIndex = index;
    switch (event.key) {
      case "ArrowRight":
        event.preventDefault();
        newIndex = (index + 1) % tabs.length;
        break;
      case "ArrowLeft":
        event.preventDefault();
        newIndex = (index - 1 + tabs.length) % tabs.length;
        break;
      case "Home":
        event.preventDefault();
        newIndex = 0;
        break;
      case "End":
        event.preventDefault();
        newIndex = tabs.length - 1;
        break;
      default:
        return;
    }
    setActiveTab(tabs[newIndex].id);
  };

  // Focus the active tab when it changes (handles keyboard navigation focus)
  const tabRefs = useRef<(HTMLButtonElement | null)[]>([]);
  const loggingSubTabRefs = useRef<(HTMLButtonElement | null)[]>([]);
  useEffect(() => {
    const activeIndex = tabs.findIndex((t) => t.id === activeTab);
    if (activeIndex >= 0 && tabRefs.current[activeIndex]) {
      tabRefs.current[activeIndex]?.focus();
    }
  }, [activeTab]);

  // Focus the active logging sub-tab when it changes
  useEffect(() => {
    const activeIndex = loggingSubTabs.findIndex((t) => t.id === activeLoggingSubTab);
    if (activeIndex >= 0 && loggingSubTabRefs.current[activeIndex]) {
      loggingSubTabRefs.current[activeIndex]?.focus();
    }
  }, [activeLoggingSubTab]);

  // Keyboard navigation for logging sub-tabs
  const handleLoggingSubTabKeyDown = (event: React.KeyboardEvent, _subTabId: LoggingSubTab, index: number) => {
    let newIndex = index;
    switch (event.key) {
      case "ArrowRight":
        event.preventDefault();
        newIndex = (index + 1) % loggingSubTabs.length;
        break;
      case "ArrowLeft":
        event.preventDefault();
        newIndex = (index - 1 + loggingSubTabs.length) % loggingSubTabs.length;
        break;
      case "Home":
        event.preventDefault();
        newIndex = 0;
        break;
      case "End":
        event.preventDefault();
        newIndex = loggingSubTabs.length - 1;
        break;
      default:
        return;
    }
    setActiveLoggingSubTab(loggingSubTabs[newIndex].id);
  };

  // Render tab panel content
  const renderTabPanel = () => {
    switch (activeTab) {
      case "logging":
        return (
          <div className="rounded-lg border p-6" role="tabpanel" id="panel-logging" aria-labelledby="tab-logging">
            {/* Logging sub-tabs */}
            <div className="mb-4">
              <nav className="flex gap-1 bg-muted rounded-lg p-1" role="tablist" aria-label="Logging options">
                {loggingSubTabs.map((subTab, index) => (
                  <button
                    key={subTab.id}
                    ref={(el) => { loggingSubTabRefs.current[index] = el; }}
                    role="tab"
                    aria-selected={activeLoggingSubTab === subTab.id}
                    aria-controls={`panel-logging-${subTab.id}`}
                    id={`tab-logging-${subTab.id}`}
                    onClick={() => setActiveLoggingSubTab(subTab.id)}
                    onKeyDown={(e) => handleLoggingSubTabKeyDown(e, subTab.id, index)}
                    className={`
                      flex items-center gap-2 px-3 py-2 text-sm font-medium rounded-md transition-colors
                      ${activeLoggingSubTab === subTab.id
                        ? "bg-background text-foreground shadow-sm"
                        : "text-muted-foreground hover:bg-background/50"
                      }
                    `}
                  >
                    {subTab.label}
                  </button>
                ))}
              </nav>
            </div>

            {/* Sub-tab panels */}
            {activeLoggingSubTab === "captureLogging" && (
              <div
                role="tabpanel"
                id="panel-logging-captureLogging"
                aria-labelledby="tab-logging-captureLogging"
                className="space-y-4"
              >
                <h3 className="font-semibold mb-4">Capture Logging</h3>
                <div className="space-y-4">
                  {renderSetting("logDir")}
                  {renderSetting("maxSessions")}
                  {renderSetting("enableLogger")}
                  {renderSetting("logTraffic")}
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
            )}
            {activeLoggingSubTab === "containerLogs" && (
              <div
                role="tabpanel"
                id="panel-logging-containerLogs"
                aria-labelledby="tab-logging-containerLogs"
              >
                <h3 className="font-semibold mb-4">Container Logs</h3>
                <div className="h-[calc(100vh-300px)]">
                  <LogsViewer containerId="contextio-next" />
                </div>
              </div>
            )}
          </div>
        );
      case "redaction":
        return (
          <div className="rounded-lg border p-6" role="tabpanel" id="panel-redaction" aria-labelledby="tab-redaction">
            <h3 className="font-semibold mb-4">Redaction</h3>
            {/* ============================================================
                 REDACTION TAB - REORGANIZED
                 ============================================================ */}
              <div className="space-y-4">
                {/* Collapsible Section Component */}
                {(() => {
                  // Theme-aware background colors for each section
                  const sectionStyles = {
                    global: "bg-green-50/50 dark:bg-green-900/10 border-green-200/50 dark:border-green-800/30",
                    mode: "bg-blue-50/50 dark:bg-blue-900/10 border-blue-200/50 dark:border-blue-800/30",
                    rules: "bg-emerald-50/50 dark:bg-emerald-900/10 border-emerald-200/50 dark:border-emerald-800/30",
                    llm: "bg-purple-50/50 dark:bg-purple-900/10 border-purple-200/50 dark:border-purple-800/30",
                  };

                  const sectionIcons = {
                    global: "🌐",
                    mode: "⚙️",
                    rules: "📋",
                    llm: "🤖",
                  };

                  const toggleSection = (section: string, isOpen: boolean) => {
                    setOpenSections((prev) => ({ ...prev, [section]: isOpen }));
                  };

                  const Section = ({
                    id,
                    title,
                    icon,
                    status,
                    description,
                    children,
                    disabled,
                  }: {
                    id: string;
                    title: string;
                    icon: string;
                    status: React.ReactNode;
                    description: string;
                    children: React.ReactNode;
                    disabled?: boolean;
                  }) => {
                    const isOpen = openSections[id];
                    return (
                      <details
                        className={`group rounded-lg border p-4 transition-all ${
                          sectionStyles[id as keyof typeof sectionStyles]
                        } ${disabled ? "opacity-50" : ""}`}
                        open={isOpen}
                        onToggle={(e: React.ToggleEvent<HTMLDetailsElement>) => toggleSection(id, (e.target as HTMLDetailsElement).open)}
                      >
                        <summary
                          className="flex items-center gap-3 cursor-pointer list-none select-none"
                        >
                          <span className="text-xl" aria-hidden="true">{icon}</span>
                          <div className="flex-1 min-w-0">
                            <h4 className="font-semibold text-foreground truncate">{title}</h4>
                            <Tooltip delayDuration={300} content={<p className="max-w-[300px]">{description}</p>}>
                              <span className="text-xs text-muted-foreground underline dotted cursor-help">
                                {description}
                              </span>
                            </Tooltip>
                          </div>
                          <div className="flex items-center gap-2">
                            {status}
                            <span
                              className={cn(
                                "transition-transform duration-200",
                                isOpen ? "rotate-180" : "rotate-0"
                              )}
                            >
                              <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
                                <path d="M6 9l6 6 6-6" />
                              </svg>
                            </span>
                          </div>
                        </summary>
                        <div className="mt-4 space-y-4 animate-in slide-in-from-top-2 duration-200">
                          {disabled && (
                            <div className="rounded-lg border border-destructive/30 bg-destructive/10 p-3 text-sm text-destructive">
                              {settings.detectorMode === "llm" && id === "rules" && (
                                <>Disabled in LLM Only mode — Rules-based settings only apply in Rules, Hybrid, or Auto modes.</>
                              )}
                              {settings.detectorMode === "rules" && id === "llm" && (
                                <>Disabled in Rules Only mode — LLM-based settings only apply in LLM, Hybrid, or Auto modes.</>
                              )}
                            </div>
                          )}
                          {children}
                        </div>
                      </details>
                    );
                  };

                  return (
                    <>
                      {/* SECTION 1: GLOBAL CONFIGURATION */}
                      <Section
                        id="global"
                        title="Global Configuration"
                        icon={sectionIcons.global}
                        status={
                          <span className="text-xs px-2 py-0.5 rounded bg-muted text-muted-foreground font-medium">
                            Always Active
                          </span>
                        }
                        description="Master switches that control whether redaction runs at all and for which providers."
                      >
                        <div className="space-y-4">
                          {renderSetting("enableRedact")}
                          {renderSetting("redactProviders")}
                        </div>
                      </Section>

                      {/* SECTION 2: REDACTION MODE SELECTION */}
                      <Section
                        id="mode"
                        title="Redaction Mode"
                        icon={sectionIcons.mode}
                        status={
                          <span className="text-xs px-2 py-0.5 rounded bg-primary/10 text-primary font-medium">
                            Core Setting
                          </span>
                        }
                        description="Choose the detection engine. This determines which settings below are active."
                      >
                        <div className="space-y-4">
                          {renderSetting("detectorMode")}
                        </div>
                        {/* Detector mode capabilities & warnings */}
                        <DetectorModeWarnings
                          detectorMode={settings.detectorMode}
                          detectorModelName={settings.detectorModelName}
                          detectorThreshold={settings.detectorThreshold}
                          detectorLabels={settings.detectorLabels}
                          hasCustomPolicy={Boolean(settings.redactPolicyFile?.trim() && settings.redactPolicyEnabled)}
                        />
                      </Section>

                      {/* SECTION 3: RULES-BASED SETTINGS */}
                      <Section
                        id="rules"
                        title="Rules-Based Settings"
                        icon={sectionIcons.rules}
                        status={
                          <span className={`text-xs px-2 py-0.5 rounded font-medium ${
                            settings.detectorMode === "llm"
                              ? "bg-muted text-muted-foreground"
                              : "bg-green/10 text-green"
                          }`}>
                            {settings.detectorMode === "llm" ? "Disabled in LLM Mode" : "Active"}
                          </span>
                        }
                        description="Regex/pattern-based redaction using built-in presets or custom policy files."
                        disabled={settings.detectorMode === "llm"}
                      >
                        <div className="space-y-4" style={{ opacity: settings.detectorMode === "llm" ? 0.5 : 1 }}>
                          {renderSetting("redactPreset")}
                          {renderSetting("redactReversible")}
                          {renderSetting("redactPolicyFile")}
                          {renderSetting("redactPolicyEnabled")}

                          {/* Path filtering settings */}
                          <div className="pt-2 border-t">
                            <h5 className="text-sm font-medium text-muted-foreground mb-3">Path Filtering</h5>
                            <Tooltip delayDuration={300} content={<p className="max-w-[300px]">
                                  Configure which JSON paths are redacted ("only") and which are skipped ("skip").
                                  Skip paths are checked before only paths. Defaults cover all LLM tool call formats
                                  (OpenAI tool_calls, Anthropic content blocks) to prevent NER false positives.
                                </p>}>
                              <span className="text-xs text-muted-foreground underline dotted cursor-help mb-4 block">
                                Configure which JSON paths are redacted ("only") and which are skipped ("skip"). Skip paths are checked before only paths. Defaults cover all LLM tool call formats (OpenAI tool_calls, Anthropic content blocks) to prevent NER false positives.
                              </span>
                            </Tooltip>
                            <div className="space-y-4">
                              {renderSetting("redactPathsOnly")}
                              {renderSetting("redactPathsSkip")}
                            </div>
                          </div>

                          {/* Disabled Rules Settings */}
                          <div className="pt-2 border-t">
                            <h5 className="text-sm font-medium text-muted-foreground mb-3">Disabled Redaction Rules</h5>
                            <Tooltip delayDuration={300} content={<p className="max-w-[300px]">
                                  Selectively disable specific redaction rule types. Uncheck a rule to stop it from
                                  redacting values. Changes apply dynamically per request.
                                </p>}>
                              <span className="text-xs text-muted-foreground underline dotted cursor-help mb-4 block">
                                Selectively disable specific redaction rule types. Uncheck a rule to stop it from redacting values. Changes apply dynamically per request.
                              </span>
                            </Tooltip>
                            <DisabledRulesList
                              disabledRules={settings.redactDisabledRules}
                              onChange={(rules) => updateSetting("redactDisabledRules", rules)}
                              disabled={isSettingOverridden("redactDisabledRules") || settings.detectorMode === "llm"}
                              preset={settings.redactPreset}
                              hasCustomPolicy={Boolean(settings.redactPolicyFile?.trim() && settings.redactPolicyEnabled)}
                              detectorMode={settings.detectorMode}
                            />
                          </div>
                        </div>
                      </Section>

                      {/* SECTION 4: LLM-BASED SETTINGS */}
                      <Section
                        id="llm"
                        title="LLM-Based Settings"
                        icon={sectionIcons.llm}
                        status={
                          <span className={`text-xs px-2 py-0.5 rounded font-medium ${
                            settings.detectorMode === "rules"
                              ? "bg-muted text-muted-foreground"
                              : "bg-blue/10 text-blue"
                          }`}>
                            {settings.detectorMode === "rules" ? "Disabled in Rules Mode" : "Active"}
                          </span>
                        }
                        description="Semantic PII detection via transformer models (Presidio/NER)."
                        disabled={settings.detectorMode === "rules"}
                      >
                        <div className="space-y-4" style={{ opacity: settings.detectorMode === "rules" ? 0.5 : 1 }}>
                          {renderSetting("detectorModelName")}
                          {renderSetting("detectorThreshold")}
                          {renderSetting("detectorLabels")}
                          {renderSetting("strictBoundaries")}
                        </div>
                      </Section>
                    </>
                  );
                })()}
              </div>
          </div>
        );
      case "security":
        return (
          <div className="rounded-lg border p-6" role="tabpanel" id="panel-security" aria-labelledby="tab-security">
            <h3 className="font-semibold mb-4">Security</h3>
            <div className="space-y-4">
              {renderSetting("encryptionAtRest")}
              {renderSetting("oidcEnabled")}
              {renderSetting("oidcPublicUrl")}
              {renderSetting("oidcIssuer")}
            </div>
          </div>
        );
      case "rateLimiter":
        return (
          <div className="rounded-lg border p-6" role="tabpanel" id="panel-rateLimiter" aria-labelledby="tab-rateLimiter">
            <h3 className="font-semibold mb-4">Rate Limiter</h3>
            <div className="space-y-4">
              {renderSetting("enableRateLimiter")}
              {renderSetting("rateLimiter")}

              {/* Advanced Rate Limiter Cache Settings */}
              <div className="pt-4 border-t">
                <h4 className="text-sm font-medium text-muted-foreground mb-3">Advanced: Rate Limiter Cache</h4>
                <p className="text-xs text-muted-foreground mb-4">
                  Configure the internal cache behavior for rate limiting. Changes require a proxy restart.
                </p>
                <div className="grid gap-4 md:grid-cols-3">
                  {renderSetting("rateLimiterMaxEntries")}
                  {renderSetting("rateLimiterCleanupIntervalMs")}
                  {renderSetting("rateLimiterEntryTtlMs")}
                </div>
              </div>
            </div>
          </div>
        );
      case "streamingRetry":
        return (
          <div className="rounded-lg border p-6" role="tabpanel" id="panel-streamingRetry" aria-labelledby="tab-streamingRetry">
            <div className="flex items-center justify-between mb-4">
              <h3 className="font-semibold">Streaming Retry Configuration</h3>
              <Button
                type="button"
                variant="outline"
                size="sm"
                onClick={() => {
                  setSettings((prev) => ({
                    ...prev,
                    streamingRetry: DEFAULT_SETTINGS.streamingRetry,
                    retryMaxEntries: DEFAULT_SETTINGS.retryMaxEntries,
                    retryEntryTtlMs: DEFAULT_SETTINGS.retryEntryTtlMs,
                    retryCleanupIntervalMs: DEFAULT_SETTINGS.retryCleanupIntervalMs,
                    retryMaxBufferSize: DEFAULT_SETTINGS.retryMaxBufferSize,
                    retryMaxStreamRetries: DEFAULT_SETTINGS.retryMaxStreamRetries,
                  }));
                  setSaveMessage({ type: "success", message: "All streaming retry settings reset to defaults. Click Save to persist." });
                }}
                className="flex items-center gap-2"
              >
                <RotateCcw className="h-4 w-4" />
                Reset to Defaults
              </Button>
            </div>
            <div className="space-y-4">
              <p className="text-sm text-muted-foreground mb-4">
                Configure streaming retry behavior per provider. Controls retry attempts and buffer size for rate-limited streaming responses.
              </p>
              {renderSetting("streamingRetry")}

              {/* Advanced Streaming Retry Cache Settings */}
              <div className="pt-4 border-t">
                <h4 className="text-sm font-medium text-muted-foreground mb-3">Advanced: Streaming Retry Cache</h4>
                <p className="text-xs text-muted-foreground mb-4">
                  Configure the internal cache behavior for streaming response retries. Changes require a proxy restart.
                </p>
                <div className="grid gap-4 md:grid-cols-3">
                  {renderSetting("retryMaxEntries")}
                  {renderSetting("retryEntryTtlMs")}
                  {renderSetting("retryCleanupIntervalMs")}
                  {renderSetting("retryMaxBufferSize")}
                  {renderSetting("retryMaxStreamRetries")}
                </div>
              </div>
            </div>
          </div>
        );
      case "falsePositives":
        return (
          <div className="rounded-lg border p-6" role="tabpanel" id="panel-falsePositives" aria-labelledby="tab-falsePositives">
            <h3 className="font-semibold mb-4">False Positives</h3>
            <p className="text-sm text-muted-foreground mb-4">
              Manage false positive entries that exempt specific values from redaction.
              These values will not be redacted in captured API traffic.
            </p>

            {/* Feedback Store Configuration */}
            <div className="rounded-lg border bg-muted/30 p-4 mb-6">
              <h4 className="font-medium mb-3 flex items-center gap-2">
                <Database className="h-4 w-4" />
                Feedback Store Configuration
              </h4>
              <p className="text-sm text-muted-foreground mb-4">
                Configure the storage backend for false positive entries. The feedback store persists
                false positive records so they survive proxy restarts.
              </p>
              <div className="grid gap-4 md:grid-cols-3">
                {renderSetting("feedbackStoreEnabled")}
                {renderSetting("feedbackStoreType")}
                {renderSetting("feedbackStorePath")}
              </div>
            </div>

            <FalsePositiveManager
              onEntryAdded={() => {
                // False positives are managed by the FeedbackStore, not settings state.
                // The table refreshes automatically via loadFalsePositives.
              }}
              onEntryRemoved={() => {
                // False positives are managed by the FeedbackStore, not settings state.
                // The table refreshes automatically via loadFalsePositives.
              }}
              onEntryUpdated={() => {
                // False positives are managed by the FeedbackStore, not settings state.
                // The table refreshes automatically via loadFalsePositives.
              }}
              onCleared={(_cleared) => {
                // Optionally show a message
              }}
            />
          </div>
        );
      case "database":
        return (
          <div className="rounded-lg border p-6" role="tabpanel" id="panel-database" aria-labelledby="tab-database">
            <h3 className="font-semibold mb-4">Database Maintenance</h3>
            <p className="text-sm text-muted-foreground mb-4">
              Perform SQLite database maintenance operations to optimize performance and reclaim space.
              These operations run directly on the SQLite database file used for metadata storage.
            </p>
            <DatabaseMaintenance />
          </div>
        );
      case "envVars":
        return (
          <div className="rounded-lg border p-6" role="tabpanel" id="panel-envVars" aria-labelledby="tab-envVars">
            <h3 className="font-semibold mb-4">Environment Variables</h3>
            <p className="text-sm text-muted-foreground mb-4">
              View environment variables for containers
            </p>
            <div className="flex items-end gap-4 mb-4">
              <div>
                <label htmlFor="envContainerId" className="block text-sm font-medium mb-1">
                  Container ID
                </label>
                <input
                  id="envContainerId"
                  type="text"
                  placeholder="Enter container ID..."
                  value={envContainerId}
                  onChange={(e) => setEnvContainerId(e.target.value)}
                  className="rounded-md border border-input bg-background px-3 py-2 text-sm min-w-[200px]"
                />
              </div>
            </div>
            <EnvironmentVariablesPanel containerId={envContainerId} />
          </div>
        );
      case "appearance":
        return (
          <div className="rounded-lg border p-6" role="tabpanel" id="panel-appearance" aria-labelledby="tab-appearance">
            <h3 className="font-semibold mb-4">Appearance</h3>
            <div className="space-y-4">
              {renderSetting("theme")}
              {renderSetting("showPageLoadTime")}
            </div>
          </div>
        );
      case "proxy":
        return (
          <div className="rounded-lg border p-6" role="tabpanel" id="panel-proxy" aria-labelledby="tab-proxy">
            <h3 className="font-semibold mb-4">Proxy</h3>
            <div className="space-y-4">
              <p className="text-xs text-muted-foreground mb-4">
                Configure proxy server settings. Changes require a proxy restart to apply.
              </p>
              <div className="grid gap-4 md:grid-cols-2">
                {renderSetting("proxyBindHost")}
                {renderSetting("proxyPort")}
                {renderSetting("proxyAllowTargetOverride")}
                {renderSetting("strictUrlForwarding")}
              </div>
              <div className="pt-2 border-t">
                <h4 className="text-sm font-medium text-muted-foreground mb-3">Upstream Configuration</h4>
                <p className="text-xs text-muted-foreground mb-4">
                  Override default upstream API base URLs. Leave empty to use built-in defaults. Environment variables (UPSTREAM_*_URL) take precedence.
                </p>
                <div className="grid gap-4 md:grid-cols-2">
                  {renderSetting("upstreamOpenAiUrl")}
                  {renderSetting("upstreamAnthropicUrl")}
                  {renderSetting("upstreamChatGptUrl")}
                  {renderSetting("upstreamGeminiUrl")}
                  {renderSetting("upstreamVertexUrl")}
                  {renderSetting("upstreamNvidiaUrl")}
                  {renderSetting("upstreamOpenRouterUrl")}
                  {renderSetting("upstreamKiloUrl")}
                  {renderSetting("upstreamGeminiCodeAssistUrl")}
                </div>
              </div>
            </div>
          </div>
        );
      case "providers":
        return (
          <div className="rounded-lg border p-6" role="tabpanel" id="panel-providers" aria-labelledby="tab-providers">
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
              <div className="rounded-md border border-destructive/30 bg-destructive/10 p-3 text-sm text-destructive mb-4">
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
                                ? "bg-primary/10 text-primary"
                                : provider.source === "env"
                                ? "bg-primary/10 text-primary"
                                : "bg-muted text-foreground"
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
                            <span className="ml-1 inline-flex items-center rounded-full px-1.5 py-0.5 text-[10px] font-medium bg-primary/10 text-primary" title="User-created">
                              Custom
                            </span>
                          )}
                          {provider.source === "env" && (
                            <span className="ml-1 inline-flex items-center rounded-full px-1.5 py-0.5 text-[10px] font-medium bg-primary/10 text-primary" title="Overridden by environment variable">
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
                                  className="h-8 w-8 p-0 text-destructive hover:text-destructive hover:bg-destructive/10"
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
        );
      default:
        return null;
    }
  };

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
    baseUrlOverrideHeader: "",
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
        setSaveMessage({
          type: "success",
          message: "Settings saved successfully",
        });
        setSaveDialogOpen(true);
        if (result.metadata) {
          setMetadata(result.metadata as Record<keyof Settings, SettingMeta>);
        }
      } else {
        setSaveMessage({
          type: "error",
          message: "Failed to save settings",
        });
        setSaveDialogOpen(true);
      }
    } catch (error) {
      setSaveMessage({
        type: "error",
        message:
          error instanceof Error ? error.message : "Failed to save settings",
      });
      setSaveDialogOpen(true);
    }
  };

  const dismissSaveMessage = () => {
    setSaveMessage(null);
    setSaveDialogOpen(false);
  };

  // Auto-dismiss success dialog after 3 seconds
  useEffect(() => {
    if (saveDialogOpen && saveMessage?.type === "success") {
      const timer = setTimeout(() => {
        dismissSaveMessage();
      }, 3000);
      return () => clearTimeout(timer);
    }
  }, [saveDialogOpen, saveMessage]);

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

  const updateStreamingRetry = (
    provider: Provider,
    field: keyof StreamingRetryConfig,
    value: number | boolean,
  ) => {
    setSettings((prev) => ({
      ...prev,
      streamingRetry: {
        ...prev.streamingRetry,
        [provider]: {
          ...prev.streamingRetry?.[provider],
          [field]: value,
        },
      },
    }));
  };

  const updateRedactProviders = (provider: Provider, enabled: boolean) => {
    setSettings((prev) => ({
      ...prev,
      redactProviders: {
        ...prev.redactProviders,
        [provider]: enabled,
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
    setProviderFormData({ id: "", name: "", baseUrl: "", models: [], allowBaseUrlOverride: true, baseUrlOverrideHeader: "" });
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
      baseUrlOverrideHeader: provider.baseUrlOverrideHeader ?? `x-${provider.id}-baseurl`,
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
    setProviderFormData((prev) => {
      const next = { ...prev, [field]: value };
      // Auto-generate baseUrlOverrideHeader when provider ID changes and header is empty or matches old pattern
      if (field === "id" && typeof value === "string") {
        const newId = value.trim();
        const currentHeader = prev.baseUrlOverrideHeader;
        const shouldAutoGenerate = !currentHeader || currentHeader === `x-${prev.id}-baseurl` || currentHeader === "x-openai-baseurl";
        if (shouldAutoGenerate && newId) {
          next.baseUrlOverrideHeader = `x-${newId}-baseurl`;
        }
      }
      return next;
    });
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
        const presetDisabled = isSettingOverridden("redactPreset") || Boolean(settings.redactPolicyFile?.trim()) || settings.detectorMode === "llm";
        const presetOverrideReason = isSettingOverridden("redactPreset")
          ? "Set by environment variable"
          : settings.redactPolicyFile?.trim()
            ? "Overridden by custom policy file"
            : settings.detectorMode === "llm"
            ? "Disabled in LLM mode"
            : null;
        return (
          <div>
            <Label
              htmlFor="redactPreset"
              className="block text-sm font-medium mb-2"
            >
              Redaction Preset <span className="text-xs text-muted-foreground font-normal ml-1">(Rules-Based)</span>
              {presetOverrideReason && (
                <span className="ml-2 text-xs text-foreground/70 font-normal">
                  ({presetOverrideReason})
                </span>
              )}
            </Label>
            <Select
              value={settings.redactPreset}
              onValueChange={(value) => updateSetting("redactPreset", value as "secrets" | "pii" | "strict")}
              disabled={presetDisabled}
            >
              <SelectTrigger>
                <SelectValue placeholder="Select preset" />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value="secrets">Secrets (API keys, tokens, passwords)</SelectItem>
                <SelectItem value="pii">PII (emails, names, phones, SSN)</SelectItem>
                <SelectItem value="strict">Strict (all of the above + more)</SelectItem>
              </SelectContent>
            </Select>
            <SettingHelp
              meta={getMeta("redactPreset")}
              description={SETTING_DESCRIPTIONS.redactPreset}
            />
            {settings.detectorMode === "llm" && (
              <p className="text-xs text-muted-foreground mt-1">
                Disabled: This setting only applies in Rules, Hybrid, or Auto detector modes.
              </p>
            )}
          </div>
        );
      }
      case "redactPolicyFile":
        return (
          <div>
            <Label htmlFor="redactPolicyFile" className="block text-sm font-medium mb-2">
              Redaction Policy File <span className="text-xs text-muted-foreground font-normal ml-1">(Rules-Based)</span>
            </Label>
            <Input
              id="redactPolicyFile"
              value={settings.redactPolicyFile}
              onChange={(e) => updateSetting("redactPolicyFile", e.target.value)}
              placeholder="/path/to/policy.yaml"
              disabled={isSettingOverridden("redactPolicyFile") || settings.detectorMode === "llm"}
              className={
                (isSettingOverridden("redactPolicyFile") || settings.detectorMode === "llm")
                  ? "bg-muted cursor-not-allowed"
                  : ""
              }
            />
            <SettingHelp
              meta={getMeta("redactPolicyFile")}
              description={SETTING_DESCRIPTIONS.redactPolicyFile}
            />
            {settings.detectorMode === "llm" && (
              <p className="text-xs text-muted-foreground mt-1">
                Disabled: This setting only applies in Rules, Hybrid, or Auto detector modes.
              </p>
            )}
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
                  <div className="rounded-md border border-destructive/30 bg-destructive/10 p-3 text-sm text-destructive">
                    {policyFileLoadError}
                  </div>
                ) : (
                  <>
                     <textarea
                       value={editedPolicyContent}
                       onChange={(e) => setEditedPolicyContent(e.target.value)}
                       className="font-mono text-xs min-h-[600px] min-w-[600px] p-2 border border-border bg-background text-foreground rounded"
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
      case "redactPolicyEnabled":
        return (
          <div className="flex items-center gap-2">
            <input
              type="checkbox"
              id="redactPolicyEnabled"
              checked={settings.redactPolicyEnabled}
              onChange={(e) =>
                updateSetting("redactPolicyEnabled", e.target.checked)
              }
              className="w-4 h-4"
              disabled={isSettingOverridden("redactPolicyEnabled") || settings.detectorMode === "llm"}
            />
            <Label htmlFor="redactPolicyEnabled" className="text-sm">
              Use custom policy file <span className="text-xs text-muted-foreground font-normal">(Rules-Based)</span>
            </Label>
            <SettingHelp
              meta={getMeta("redactPolicyEnabled")}
              description={SETTING_DESCRIPTIONS.redactPolicyEnabled}
            />
            {settings.detectorMode === "llm" && (
              <p className="text-xs text-muted-foreground mt-1 ml-6">
                Disabled: This setting only applies in Rules, Hybrid, or Auto detector modes.
              </p>
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
              disabled={isSettingOverridden("redactReversible") || settings.detectorMode === "llm"}
            />
            <Label htmlFor="redactReversible" className="text-sm">
              Reversible redaction (restore originals in responses) <span className="text-xs text-muted-foreground font-normal">(Rules-Based)</span>
            </Label>
            <SettingHelp
              meta={getMeta("redactReversible")}
              description={SETTING_DESCRIPTIONS.redactReversible}
            />
            {settings.detectorMode === "llm" && (
              <p className="text-xs text-muted-foreground mt-1 ml-6">
                Disabled: This setting only applies in Rules, Hybrid, or Auto detector modes.
              </p>
            )}
          </div>
        );
      case "redactPathsOnly":
        return (
          <div>
            <Label htmlFor="redactPathsOnly" className="block text-sm font-medium mb-2">
              Redaction Paths (Only) <span className="text-xs text-muted-foreground font-normal ml-1">(Rules-Based)</span>
            </Label>
            <textarea
              id="redactPathsOnly"
              defaultValue={JSON.stringify(settings.redactPathsOnly, null, 2)}
              onBlur={(e) => {
                try {
                  updateSetting("redactPathsOnly", JSON.parse(e.target.value));
                } catch {
                  // Invalid JSON, reset to current value
                  e.target.value = JSON.stringify(settings.redactPathsOnly, null, 2);
                }
              }}
              placeholder='["messages[*].content"]'
              disabled={isSettingOverridden("redactPathsOnly") || settings.detectorMode === "llm"}
              className={`font-mono text-xs min-h-[80px] w-full p-2 border border-border bg-background text-foreground rounded ${
                (isSettingOverridden("redactPathsOnly") || settings.detectorMode === "llm") ? "bg-muted opacity-50 cursor-not-allowed" : ""
              }`}
              rows={4}
            />
            <SettingHelp
              meta={getMeta("redactPathsOnly")}
              description={SETTING_DESCRIPTIONS.redactPathsOnly}
            />
            <p className="text-xs text-muted-foreground mt-1">
              Enter a JSON array of path strings (e.g., ["messages[*].content","system"]). Use [*] for array wildcards.
            </p>
            {settings.detectorMode === "llm" && (
              <p className="text-xs text-muted-foreground mt-1">
                Disabled: This setting only applies in Rules, Hybrid, or Auto detector modes.
              </p>
            )}
          </div>
        );
      case "redactPathsSkip":
        return (
          <div>
            <Label htmlFor="redactPathsSkip" className="block text-sm font-medium mb-2">
              Redaction Paths (Skip) <span className="text-xs text-muted-foreground font-normal ml-1">(Rules-Based)</span>
            </Label>
            <textarea
              id="redactPathsSkip"
              defaultValue={JSON.stringify(settings.redactPathsSkip, null, 2)}
              onBlur={(e) => {
                try {
                  updateSetting("redactPathsSkip", JSON.parse(e.target.value));
                } catch {
                  // Invalid JSON, reset to current value
                  e.target.value = JSON.stringify(settings.redactPathsSkip, null, 2);
                }
              }}
              placeholder='["tools","tool_calls","messages[*].tool_calls[*].id",...]'
              disabled={isSettingOverridden("redactPathsSkip") || settings.detectorMode === "llm"}
              className={`font-mono text-xs min-h-[120px] w-full p-2 border border-border bg-background text-foreground rounded ${
                (isSettingOverridden("redactPathsSkip") || settings.detectorMode === "llm") ? "bg-muted opacity-50 cursor-not-allowed" : ""
              }`}
              rows={6}
            />
            <SettingHelp
              meta={getMeta("redactPathsSkip")}
              description={SETTING_DESCRIPTIONS.redactPathsSkip}
            />
            <p className="text-xs text-muted-foreground mt-1">
              Enter a JSON array of path strings to skip. Checked before "only" paths. Use [*] for array wildcards.
            </p>
            {settings.detectorMode === "llm" && (
              <p className="text-xs text-muted-foreground mt-1">
                Disabled: This setting only applies in Rules, Hybrid, or Auto detector modes.
              </p>
            )}
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
      case "oidcIssuer":
        return (
          <div>
            <Label htmlFor="oidcIssuer" className="block text-sm font-medium mb-2">
              OIDC Issuer URL
            </Label>
            <Input
              id="oidcIssuer"
              value={settings.oidcIssuer}
              onChange={(e) => updateSetting("oidcIssuer", e.target.value)}
              placeholder="https://accounts.google.com"
              disabled={isSettingOverridden("oidcIssuer")}
              className={
                isSettingOverridden("oidcIssuer") ? "bg-muted cursor-not-allowed" : ""
              }
            />
            <SettingHelp
              meta={getMeta("oidcIssuer")}
              description={SETTING_DESCRIPTIONS.oidcIssuer}
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
            <Select
              value={settings.detectorMode}
              onValueChange={(value) => updateSetting("detectorMode", value as "rules" | "llm" | "hybrid" | "auto")}
              disabled={isSettingOverridden("detectorMode")}
            >
              <SelectTrigger>
                <SelectValue placeholder="Select detector mode" />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value="rules">Rules only (fast, deterministic patterns)</SelectItem>
                <SelectItem value="llm">LLM only (semantic detection via LLM)</SelectItem>
                <SelectItem value="hybrid">Hybrid (rules + LLM, rules take priority)</SelectItem>
                <SelectItem value="auto">Auto (choose based on content)</SelectItem>
              </SelectContent>
            </Select>
            <SettingHelp
              meta={getMeta("detectorMode")}
              description={SETTING_DESCRIPTIONS.detectorMode}
            />
          </div>
        );
      case "detectorModelName":
        return (
          <div>
            <Label htmlFor="detectorModelName" className="block text-sm font-medium mb-2">
              Detector Model Name <span className="text-xs text-muted-foreground font-normal ml-1">(LLM-Based)</span>
            </Label>
            <Input
              id="detectorModelName"
              value={settings.detectorModelName}
              onChange={(e) => updateSetting("detectorModelName", e.target.value)}
              placeholder="Xenova/bert-base-NER"
              disabled={isSettingOverridden("detectorModelName") || settings.detectorMode === "rules"}
              className={
                (isSettingOverridden("detectorModelName") || settings.detectorMode === "rules")
                  ? "bg-muted cursor-not-allowed"
                  : ""
              }
            />
            <SettingHelp
              meta={getMeta("detectorModelName")}
              description={SETTING_DESCRIPTIONS.detectorModelName}
            />
            {settings.detectorMode === "rules" && (
              <p className="text-xs text-muted-foreground mt-1">
                Disabled: This setting only applies in LLM, Hybrid, or Auto detector modes.
              </p>
            )}
          </div>
        );
      case "detectorThreshold":
        return (
          <div>
            <Label htmlFor="detectorThreshold" className="block text-sm font-medium mb-2">
              LLM Detection Threshold (0-1) <span className="text-xs text-muted-foreground font-normal ml-1">(LLM-Based)</span>
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
              disabled={isSettingOverridden("detectorThreshold") || settings.detectorMode === "rules"}
              className={
                (isSettingOverridden("detectorThreshold") || settings.detectorMode === "rules")
                  ? "bg-muted cursor-not-allowed"
                  : ""
              }
            />
            <SettingHelp
              meta={getMeta("detectorThreshold")}
              description={SETTING_DESCRIPTIONS.detectorThreshold}
            />
            {settings.detectorMode === "rules" && (
              <p className="text-xs text-muted-foreground mt-1">
                Disabled: This setting only applies in LLM, Hybrid, or Auto detector modes.
              </p>
            )}
          </div>
        );
      case "detectorLabels":
        return (
          <div>
            <Label htmlFor="detectorLabels" className="block text-sm font-medium mb-2">
              Detector Entity Labels <span className="text-xs text-muted-foreground font-normal ml-1">(LLM-Based)</span>
            </Label>
            <div className="flex flex-wrap gap-2">
              {(
                [
                  "PERSON",
                  "ORGANIZATION",
                  "LOCATION",
                  "EMAIL_ADDRESS",
                  "PHONE_NUMBER",
                  "CREDIT_CARD",
                  "US_SSN",
                  "IP_ADDRESS",
                  "URL",
                  "DATE_TIME",
                ] as const
              ).map((label) => (
                <label key={label} className="flex items-center gap-1.5">
                  <input
                    type="checkbox"
                    checked={settings.detectorLabels.includes(label)}
                    onChange={(e) => {
                      const newLabels = e.target.checked
                        ? [...settings.detectorLabels, label]
                        : settings.detectorLabels.filter((l) => l !== label);
                      updateSetting("detectorLabels", newLabels);
                    }}
                    disabled={isSettingOverridden("detectorLabels") || settings.detectorMode === "rules"}
                    className="w-4 h-4 rounded border-input"
                  />
                  <span className="text-sm">{label}</span>
                </label>
              ))}
            </div>
            <SettingHelp
              meta={getMeta("detectorLabels")}
              description={SETTING_DESCRIPTIONS.detectorLabels}
            />
            {settings.detectorMode === "rules" && (
              <p className="text-xs text-muted-foreground mt-1">
                Disabled: This setting only applies in LLM, Hybrid, or Auto detector modes.
              </p>
            )}
          </div>
        );
      case "strictBoundaries":
        return (
          <div className="flex items-center gap-2">
            <input
              type="checkbox"
              id="strictBoundaries"
              checked={settings.strictBoundaries}
              onChange={(e) =>
                updateSetting("strictBoundaries", e.target.checked)
              }
              className="w-4 h-4"
              disabled={isSettingOverridden("strictBoundaries") || settings.detectorMode === "rules"}
            />
            <Label htmlFor="strictBoundaries" className="text-sm">
              Strict boundaries (prevent substring matches) <span className="text-xs text-muted-foreground font-normal">(LLM-Based)</span>
            </Label>
            <SettingHelp
              meta={getMeta("strictBoundaries")}
              description={SETTING_DESCRIPTIONS.strictBoundaries}
            />
            {settings.detectorMode === "rules" && (
              <p className="text-xs text-muted-foreground mt-1 ml-6">
                Disabled: This setting only applies in LLM, Hybrid, or Auto detector modes.
              </p>
            )}
          </div>
        );
      case "enableLogger":
        return (
          <div className="flex items-center gap-2">
            <input
              type="checkbox"
              id="enableLogger"
              checked={settings.enableLogger}
              onChange={(e) => updateSetting("enableLogger", e.target.checked)}
              className="w-4 h-4"
              disabled={isSettingOverridden("enableLogger")}
            />
            <Label htmlFor="enableLogger" className="text-sm">
              Enable Request/Response Logging
            </Label>
            <SettingHelp meta={getMeta("enableLogger")} description={SETTING_DESCRIPTIONS.enableLogger} />
          </div>
        );
      case "logTraffic":
        return (
          <div className="flex items-center gap-2">
            <input
              type="checkbox"
              id="logTraffic"
              checked={settings.logTraffic}
              onChange={(e) => updateSetting("logTraffic", e.target.checked)}
              className="w-4 h-4"
              disabled={isSettingOverridden("logTraffic")}
            />
            <Label htmlFor="logTraffic" className="text-sm">
              Enable Detailed Traffic Logging
            </Label>
            <SettingHelp meta={getMeta("logTraffic")} description={SETTING_DESCRIPTIONS.logTraffic} />
          </div>
        );
      case "enableRedact":
        return (
          <div className="flex items-center gap-2">
            <input
              type="checkbox"
              id="enableRedact"
              checked={settings.enableRedact}
              onChange={(e) => updateSetting("enableRedact", e.target.checked)}
              className="w-4 h-4"
              disabled={isSettingOverridden("enableRedact")}
            />
            <Label htmlFor="enableRedact" className="text-sm">
              Enable PII/Secrets Redaction
            </Label>
            <SettingHelp meta={getMeta("enableRedact")} description={SETTING_DESCRIPTIONS.enableRedact} />
          </div>
        );
      case "redactProviders": {
        const providers: Provider[] = [
          "anthropic",
          "openai",
          "chatgpt",
          "gemini",
          "vertex",
          "nvidia",
          "openrouter",
          "kilo",
        ];
        const redactDisabled = !settings.enableRedact;
        return (
          <div className="space-y-4">
            <h3 className="font-semibold mb-2">Per-Provider Redaction</h3>
            <p className="text-sm text-muted-foreground mb-4">
              Enable or disable PII/secrets redaction for each provider individually.
              When disabled, traffic for that provider passes through unredacted.
            </p>
            {redactDisabled && (
              <div className="rounded-lg border border-destructive/30 bg-destructive/10 p-3 text-sm text-destructive">
                Per-provider redaction is unavailable because global redaction is disabled.
                Enable <strong>PII/Secrets Redaction</strong> above to configure provider-level redaction.
              </div>
            )}
            <SettingHelp
              meta={getMeta("redactProviders")}
              description={SETTING_DESCRIPTIONS.redactProviders}
            />
            <div className="overflow-x-auto">
              <table className="w-full text-sm border rounded">
                <thead className="bg-muted">
                  <tr>
                    <th className="px-3 py-2 text-left font-medium">Provider</th>
                    <th className="px-3 py-2 text-left font-medium">Redact</th>
                  </tr>
                </thead>
                <tbody>
                  {providers.map((provider) => {
                    const providerLabel = provider.charAt(0).toUpperCase() + provider.slice(1);
                    const rowId = `redact-${provider}`;
                    const enabled = settings.redactProviders?.[provider] ?? true;
                    const checkboxDisabled = isSettingOverridden("redactProviders") || redactDisabled;
                    return (
                      <tr key={provider} className="border-t">
                        <td className="px-3 py-2 font-medium">{providerLabel}</td>
                        <td className="px-3 py-2">
                          <div className="flex items-center gap-2">
                            <input
                              id={rowId}
                              type="checkbox"
                              checked={enabled}
                              onChange={(e) => updateRedactProviders(provider, e.target.checked)}
                              disabled={checkboxDisabled}
                              className="w-4 h-4"
                            />
                            <Label htmlFor={rowId} className="text-sm">
                              {enabled ? "Enabled" : "Disabled"}
                            </Label>
                          </div>
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
      case "enableRateLimiter":
        return (
          <div className="flex items-center gap-2">
            <input
              type="checkbox"
              id="enableRateLimiter"
              checked={settings.enableRateLimiter}
              onChange={(e) => updateSetting("enableRateLimiter", e.target.checked)}
              className="w-4 h-4"
              disabled={isSettingOverridden("enableRateLimiter")}
            />
            <Label htmlFor="enableRateLimiter" className="text-sm">
              Enable Rate Limiting
            </Label>
            <SettingHelp meta={getMeta("enableRateLimiter")} description={SETTING_DESCRIPTIONS.enableRateLimiter} />
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
                className="h-4 w-4 rounded border-border"
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
      case "streamingRetry": {
        const providers: Provider[] = [
          "anthropic",
          "openai",
          "chatgpt",
          "gemini",
          "vertex",
          "nvidia",
          "openrouter",
          "kilo",
        ];
        return (
          <div className="space-y-4">
            <h3 className="font-semibold mb-2">Streaming Retry Configuration</h3>
            <p className="text-sm text-muted-foreground mb-4">
              Configure streaming retry behavior per provider. Controls whether retry is enabled, max retry attempts, and max buffer size for rate-limited streaming responses.
            </p>
            <SettingHelp
              meta={getMeta("streamingRetry")}
              description={SETTING_DESCRIPTIONS.streamingRetry}
            />
            <div className="overflow-x-auto">
              <table className="w-full text-sm border rounded">
                <thead className="bg-muted">
                  <tr>
                    <th className="px-3 py-2 text-left font-medium">Provider</th>
                    <th className="px-3 py-2 text-left font-medium">Enabled</th>
                    <th className="px-3 py-2 text-left font-medium">Max Retries</th>
                    <th className="px-3 py-2 text-left font-medium">Max Buffer (MB)</th>
                  </tr>
                </thead>
                <tbody>
                  {providers.map((provider) => {
                    const config = settings.streamingRetry?.[provider];
                    const providerLabel = provider.charAt(0).toUpperCase() + provider.slice(1);
                    const rowId = `streamingRetry-${provider}`;
                    return (
                      <tr key={provider} className="border-t">
                        <td className="px-3 py-2 font-medium">{providerLabel}</td>
                        <td className="px-3 py-2">
                          <div className="flex items-center gap-2">
                            <input
                              type="checkbox"
                              id={`${rowId}-enabled`}
                              checked={config?.enabled ?? true}
                              onChange={(e) =>
                                updateStreamingRetry(provider, "enabled", e.target.checked)
                              }
                              disabled={isSettingOverridden("streamingRetry")}
                              className="h-4 w-4 rounded border-border"
                            />
                            <Label htmlFor={`${rowId}-enabled`} className="text-sm">
                              Enable
                            </Label>
                          </div>
                        </td>
                        <td className="px-3 py-2">
                          <Label htmlFor={`${rowId}-maxRetries`} className="sr-only">
                            {providerLabel} max retries
                          </Label>
                          <Input
                            id={`${rowId}-maxRetries`}
                            type="number"
                            min="0"
                            max="10"
                            value={config?.maxRetries ?? 3}
                            onChange={(e) =>
                              updateStreamingRetry(provider, "maxRetries", parseInt(e.target.value) || 0)
                            }
                            disabled={isSettingOverridden("streamingRetry")}
                            className="w-20"
                          />
                        </td>
                        <td className="px-3 py-2">
                          <Label htmlFor={`${rowId}-buffer`} className="sr-only">
                            {providerLabel} max buffer MB
                          </Label>
                          <Input
                            id={`${rowId}-buffer`}
                            type="number"
                            min="1"
                            max="100"
                            value={config?.maxBufferSizeMB ?? 10}
                            onChange={(e) =>
                              updateStreamingRetry(provider, "maxBufferSizeMB", parseInt(e.target.value) || 1)
                            }
                            disabled={isSettingOverridden("streamingRetry")}
                            className="w-20"
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
      case "rateLimiterMaxEntries":
        return (
          <div>
            <Label htmlFor="rateLimiterMaxEntries" className="block text-sm font-medium mb-2">
              Max Entries
            </Label>
            <Input
              id="rateLimiterMaxEntries"
              type="number"
              value={settings.rateLimiterMaxEntries}
              onChange={(e) =>
                updateSetting("rateLimiterMaxEntries", Math.max(1, parseInt(e.target.value) || 1))
              }
              min="1"
              max="100000"
              placeholder="2000"
              disabled={isSettingOverridden("rateLimiterMaxEntries")}
              className={isSettingOverridden("rateLimiterMaxEntries") ? "bg-muted cursor-not-allowed" : ""}
            />
            <SettingHelp meta={getMeta("rateLimiterMaxEntries")} description="Maximum number of entries in the rate limiter cache" />
          </div>
        );
      case "rateLimiterCleanupIntervalMs":
        return (
          <div>
            <Label htmlFor="rateLimiterCleanupIntervalMs" className="block text-sm font-medium mb-2">
              Cleanup Interval (ms)
            </Label>
            <Input
              id="rateLimiterCleanupIntervalMs"
              type="number"
              value={settings.rateLimiterCleanupIntervalMs}
              onChange={(e) =>
                updateSetting("rateLimiterCleanupIntervalMs", Math.max(1000, parseInt(e.target.value) || 1000))
              }
              min="1000"
              max="3600000"
              placeholder="60000"
              disabled={isSettingOverridden("rateLimiterCleanupIntervalMs")}
              className={isSettingOverridden("rateLimiterCleanupIntervalMs") ? "bg-muted cursor-not-allowed" : ""}
            />
            <SettingHelp meta={getMeta("rateLimiterCleanupIntervalMs")} description="Interval between cache cleanup runs in milliseconds" />
          </div>
        );
      case "rateLimiterEntryTtlMs":
        return (
          <div>
            <Label htmlFor="rateLimiterEntryTtlMs" className="block text-sm font-medium mb-2">
              Entry TTL (ms)
            </Label>
            <Input
              id="rateLimiterEntryTtlMs"
              type="number"
              value={settings.rateLimiterEntryTtlMs}
              onChange={(e) =>
                updateSetting("rateLimiterEntryTtlMs", Math.max(1000, parseInt(e.target.value) || 1000))
              }
              min="1000"
              max="86400000"
              placeholder="300000"
              disabled={isSettingOverridden("rateLimiterEntryTtlMs")}
              className={isSettingOverridden("rateLimiterEntryTtlMs") ? "bg-muted cursor-not-allowed" : ""}
            />
            <SettingHelp meta={getMeta("rateLimiterEntryTtlMs")} description="Time-to-live for rate limiter cache entries in milliseconds" />
          </div>
        );
      case "retryMaxEntries":
        return (
          <div>
            <Label htmlFor="retryMaxEntries" className="block text-sm font-medium mb-2">
              Max Entries
            </Label>
            <Input
              id="retryMaxEntries"
              type="number"
              value={settings.retryMaxEntries}
              onChange={(e) => updateSetting("retryMaxEntries", Math.max(1, parseInt(e.target.value) || 1))}
              min="1"
              max="100000"
              placeholder="1000"
              disabled={isSettingOverridden("retryMaxEntries")}
              className={isSettingOverridden("retryMaxEntries") ? "bg-muted cursor-not-allowed" : ""}
            />
            <SettingHelp meta={getMeta("retryMaxEntries")} description="Maximum number of entries in the streaming retry cache" />
          </div>
        );
      case "retryEntryTtlMs":
        return (
          <div>
            <Label htmlFor="retryEntryTtlMs" className="block text-sm font-medium mb-2">
              Entry TTL (ms)
            </Label>
            <Input
              id="retryEntryTtlMs"
              type="number"
              value={settings.retryEntryTtlMs}
              onChange={(e) => updateSetting("retryEntryTtlMs", Math.max(1000, parseInt(e.target.value) || 1000))}
              min="1000"
              max="86400000"
              placeholder="300000"
              disabled={isSettingOverridden("retryEntryTtlMs")}
              className={isSettingOverridden("retryEntryTtlMs") ? "bg-muted cursor-not-allowed" : ""}
            />
            <SettingHelp meta={getMeta("retryEntryTtlMs")} description="Time-to-live for streaming retry cache entries in milliseconds" />
          </div>
        );
      case "retryCleanupIntervalMs":
        return (
          <div>
            <Label htmlFor="retryCleanupIntervalMs" className="block text-sm font-medium mb-2">
              Cleanup Interval (ms)
            </Label>
            <Input
              id="retryCleanupIntervalMs"
              type="number"
              value={settings.retryCleanupIntervalMs}
              onChange={(e) => updateSetting("retryCleanupIntervalMs", Math.max(1000, parseInt(e.target.value) || 1000))}
              min="1000"
              max="3600000"
              placeholder="30000"
              disabled={isSettingOverridden("retryCleanupIntervalMs")}
              className={isSettingOverridden("retryCleanupIntervalMs") ? "bg-muted cursor-not-allowed" : ""}
            />
            <SettingHelp meta={getMeta("retryCleanupIntervalMs")} description="Interval between streaming retry cache cleanup runs in milliseconds" />
          </div>
        );
      case "retryMaxBufferSize":
        return (
          <div>
            <Label htmlFor="retryMaxBufferSize" className="block text-sm font-medium mb-2">
              Max Buffer Size (bytes)
            </Label>
            <Input
              id="retryMaxBufferSize"
              type="number"
              value={settings.retryMaxBufferSize}
              onChange={(e) => updateSetting("retryMaxBufferSize", Math.max(1024, parseInt(e.target.value) || 1024))}
              min="1024"
              max="104857600"
              placeholder="5242880"
              disabled={isSettingOverridden("retryMaxBufferSize")}
              className={isSettingOverridden("retryMaxBufferSize") ? "bg-muted cursor-not-allowed" : ""}
            />
            <SettingHelp meta={getMeta("retryMaxBufferSize")} description="Maximum buffer size for streaming responses in the retry cache in bytes" />
          </div>
        );
      case "retryMaxStreamRetries":
        return (
          <div>
            <Label htmlFor="retryMaxStreamRetries" className="block text-sm font-medium mb-2">
              Max Stream Retries
            </Label>
            <Input
              id="retryMaxStreamRetries"
              type="number"
              value={settings.retryMaxStreamRetries}
              onChange={(e) => updateSetting("retryMaxStreamRetries", Math.max(0, parseInt(e.target.value) || 0))}
              min="0"
              max="10"
              placeholder="3"
              disabled={isSettingOverridden("retryMaxStreamRetries")}
              className={isSettingOverridden("retryMaxStreamRetries") ? "bg-muted cursor-not-allowed" : ""}
            />
            <SettingHelp meta={getMeta("retryMaxStreamRetries")} description="Maximum number of retries for failed streaming responses" />
          </div>
        );
      case "proxyBindHost":
        return (
          <div>
            <Label htmlFor="proxyBindHost" className="block text-sm font-medium mb-2">
              Bind Host
            </Label>
            <Input
              id="proxyBindHost"
              value={settings.proxyBindHost}
              onChange={(e) => updateSetting("proxyBindHost", e.target.value)}
              placeholder="0.0.0.0"
              disabled={isSettingOverridden("proxyBindHost")}
              className={isSettingOverridden("proxyBindHost") ? "bg-muted cursor-not-allowed" : ""}
            />
            <SettingHelp meta={getMeta("proxyBindHost")} description={SETTING_DESCRIPTIONS.proxyBindHost} />
          </div>
        );
      case "proxyPort":
        return (
          <div>
            <Label htmlFor="proxyPort" className="block text-sm font-medium mb-2">
              Proxy Port
            </Label>
            <Input
              id="proxyPort"
              type="number"
              value={settings.proxyPort}
              onChange={(e) => updateSetting("proxyPort", parseInt(e.target.value) || 4040)}
              min="1"
              max="65535"
              placeholder="4040"
              disabled={isSettingOverridden("proxyPort")}
              className={isSettingOverridden("proxyPort") ? "bg-muted cursor-not-allowed" : ""}
            />
            <SettingHelp meta={getMeta("proxyPort")} description={SETTING_DESCRIPTIONS.proxyPort} />
          </div>
        );
      case "proxyAllowTargetOverride":
        return (
          <div className="flex items-center gap-2">
            <input
              type="checkbox"
              id="proxyAllowTargetOverride"
              checked={settings.proxyAllowTargetOverride}
              onChange={(e) => updateSetting("proxyAllowTargetOverride", e.target.checked)}
              className="w-4 h-4"
              disabled={isSettingOverridden("proxyAllowTargetOverride")}
            />
            <Label htmlFor="proxyAllowTargetOverride" className="text-sm">
              Allow Target Override
            </Label>
            <SettingHelp meta={getMeta("proxyAllowTargetOverride")} description={SETTING_DESCRIPTIONS.proxyAllowTargetOverride} />
          </div>
        );
      case "strictUrlForwarding":
        return (
          <div className="flex items-center gap-2">
            <input
              type="checkbox"
              id="strictUrlForwarding"
              checked={settings.strictUrlForwarding}
              onChange={(e) => updateSetting("strictUrlForwarding", e.target.checked)}
              className="w-4 h-4"
              disabled={isSettingOverridden("strictUrlForwarding")}
            />
            <Label htmlFor="strictUrlForwarding" className="text-sm">
              Strict URL Forwarding
            </Label>
            <SettingHelp meta={getMeta("strictUrlForwarding")} description={SETTING_DESCRIPTIONS.strictUrlForwarding} />
          </div>
        );
      case "upstreamOpenAiUrl":
        return (
          <div>
            <Label htmlFor="upstreamOpenAiUrl" className="block text-sm font-medium mb-2">
              OpenAI Upstream URL
            </Label>
            <Input
              id="upstreamOpenAiUrl"
              value={settings.upstreamOpenAiUrl}
              onChange={(e) => updateSetting("upstreamOpenAiUrl", e.target.value)}
              placeholder="https://api.openai.com/v1"
              disabled={isSettingOverridden("upstreamOpenAiUrl")}
              className={isSettingOverridden("upstreamOpenAiUrl") ? "bg-muted cursor-not-allowed" : ""}
            />
            <SettingHelp meta={getMeta("upstreamOpenAiUrl")} description="Override the default OpenAI API base URL" />
          </div>
        );
      case "upstreamAnthropicUrl":
        return (
          <div>
            <Label htmlFor="upstreamAnthropicUrl" className="block text-sm font-medium mb-2">
              Anthropic Upstream URL
            </Label>
            <Input
              id="upstreamAnthropicUrl"
              value={settings.upstreamAnthropicUrl}
              onChange={(e) => updateSetting("upstreamAnthropicUrl", e.target.value)}
              placeholder="https://api.anthropic.com"
              disabled={isSettingOverridden("upstreamAnthropicUrl")}
              className={isSettingOverridden("upstreamAnthropicUrl") ? "bg-muted cursor-not-allowed" : ""}
            />
            <SettingHelp meta={getMeta("upstreamAnthropicUrl")} description="Override the default Anthropic API base URL" />
          </div>
        );
      case "upstreamChatGptUrl":
        return (
          <div>
            <Label htmlFor="upstreamChatGptUrl" className="block text-sm font-medium mb-2">
              ChatGPT Upstream URL
            </Label>
            <Input
              id="upstreamChatGptUrl"
              value={settings.upstreamChatGptUrl}
              onChange={(e) => updateSetting("upstreamChatGptUrl", e.target.value)}
              placeholder="https://chatgpt.com/backend-api"
              disabled={isSettingOverridden("upstreamChatGptUrl")}
              className={isSettingOverridden("upstreamChatGptUrl") ? "bg-muted cursor-not-allowed" : ""}
            />
            <SettingHelp meta={getMeta("upstreamChatGptUrl")} description="Override the default ChatGPT API base URL" />
          </div>
        );
      case "upstreamGeminiUrl":
        return (
          <div>
            <Label htmlFor="upstreamGeminiUrl" className="block text-sm font-medium mb-2">
              Gemini Upstream URL
            </Label>
            <Input
              id="upstreamGeminiUrl"
              value={settings.upstreamGeminiUrl}
              onChange={(e) => updateSetting("upstreamGeminiUrl", e.target.value)}
              placeholder="https://generativelanguage.googleapis.com"
              disabled={isSettingOverridden("upstreamGeminiUrl")}
              className={isSettingOverridden("upstreamGeminiUrl") ? "bg-muted cursor-not-allowed" : ""}
            />
            <SettingHelp meta={getMeta("upstreamGeminiUrl")} description="Override the default Gemini API base URL" />
          </div>
        );
      case "upstreamVertexUrl":
        return (
          <div>
            <Label htmlFor="upstreamVertexUrl" className="block text-sm font-medium mb-2">
              Vertex AI Upstream URL
            </Label>
            <Input
              id="upstreamVertexUrl"
              value={settings.upstreamVertexUrl}
              onChange={(e) => updateSetting("upstreamVertexUrl", e.target.value)}
              placeholder="https://aiplatform.googleapis.com/v1"
              disabled={isSettingOverridden("upstreamVertexUrl")}
              className={isSettingOverridden("upstreamVertexUrl") ? "bg-muted cursor-not-allowed" : ""}
            />
            <SettingHelp meta={getMeta("upstreamVertexUrl")} description="Override the default Vertex AI API base URL" />
          </div>
        );
      case "upstreamNvidiaUrl":
        return (
          <div>
            <Label htmlFor="upstreamNvidiaUrl" className="block text-sm font-medium mb-2">
              NVIDIA Upstream URL
            </Label>
            <Input
              id="upstreamNvidiaUrl"
              value={settings.upstreamNvidiaUrl}
              onChange={(e) => updateSetting("upstreamNvidiaUrl", e.target.value)}
              placeholder="https://integrate.api.nvidia.com/v1"
              disabled={isSettingOverridden("upstreamNvidiaUrl")}
              className={isSettingOverridden("upstreamNvidiaUrl") ? "bg-muted cursor-not-allowed" : ""}
            />
            <SettingHelp meta={getMeta("upstreamNvidiaUrl")} description="Override the default NVIDIA API base URL" />
          </div>
        );
      case "upstreamOpenRouterUrl":
        return (
          <div>
            <Label htmlFor="upstreamOpenRouterUrl" className="block text-sm font-medium mb-2">
              OpenRouter Upstream URL
            </Label>
            <Input
              id="upstreamOpenRouterUrl"
              value={settings.upstreamOpenRouterUrl}
              onChange={(e) => updateSetting("upstreamOpenRouterUrl", e.target.value)}
              placeholder="https://openrouter.ai/api/v1"
              disabled={isSettingOverridden("upstreamOpenRouterUrl")}
              className={isSettingOverridden("upstreamOpenRouterUrl") ? "bg-muted cursor-not-allowed" : ""}
            />
            <SettingHelp meta={getMeta("upstreamOpenRouterUrl")} description="Override the default OpenRouter API base URL" />
          </div>
        );
      case "upstreamKiloUrl":
        return (
          <div>
            <Label htmlFor="upstreamKiloUrl" className="block text-sm font-medium mb-2">
              Kilo Upstream URL
            </Label>
            <Input
              id="upstreamKiloUrl"
              value={settings.upstreamKiloUrl}
              onChange={(e) => updateSetting("upstreamKiloUrl", e.target.value)}
              placeholder="https://api.kilo.ai/v1"
              disabled={isSettingOverridden("upstreamKiloUrl")}
              className={isSettingOverridden("upstreamKiloUrl") ? "bg-muted cursor-not-allowed" : ""}
            />
            <SettingHelp meta={getMeta("upstreamKiloUrl")} description="Override the default Kilo API base URL" />
          </div>
        );
      case "upstreamGeminiCodeAssistUrl":
        return (
          <div>
            <Label htmlFor="upstreamGeminiCodeAssistUrl" className="block text-sm font-medium mb-2">
              Gemini Code Assist Upstream URL
            </Label>
            <Input
              id="upstreamGeminiCodeAssistUrl"
              value={settings.upstreamGeminiCodeAssistUrl}
              onChange={(e) => updateSetting("upstreamGeminiCodeAssistUrl", e.target.value)}
              placeholder="https://generativelanguage.googleapis.com"
              disabled={isSettingOverridden("upstreamGeminiCodeAssistUrl")}
              className={isSettingOverridden("upstreamGeminiCodeAssistUrl") ? "bg-muted cursor-not-allowed" : ""}
            />
            <SettingHelp meta={getMeta("upstreamGeminiCodeAssistUrl")} description="Override the default Gemini Code Assist API base URL" />
          </div>
        );
      case "feedbackStoreEnabled":
        return (
          <div className="flex items-center gap-2">
            <input
              type="checkbox"
              id="feedbackStoreEnabled"
              checked={settings.feedbackStoreEnabled}
              onChange={(e) => updateSetting("feedbackStoreEnabled", e.target.checked)}
              className="w-4 h-4"
              disabled={isSettingOverridden("feedbackStoreEnabled")}
            />
            <Label htmlFor="feedbackStoreEnabled" className="text-sm">
              Enable Feedback Store
            </Label>
            <SettingHelp
              meta={getMeta("feedbackStoreEnabled")}
              description={SETTING_DESCRIPTIONS.feedbackStoreEnabled}
            />
          </div>
        );
      case "feedbackStoreType":
        return (
          <div>
            <Label htmlFor="feedbackStoreType" className="block text-sm font-medium mb-2">
              Feedback Store Type
            </Label>
            <Select
              value={settings.feedbackStoreType}
              onValueChange={(value) => updateSetting("feedbackStoreType", value as "sqlite" | "memory")}
              disabled={isSettingOverridden("feedbackStoreType")}
            >
              <SelectTrigger>
                <SelectValue placeholder="Select feedback store type" />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value="sqlite">SQLite (persistent, file-based)</SelectItem>
                <SelectItem value="memory">Memory (in-memory, lost on restart)</SelectItem>
              </SelectContent>
            </Select>
            <SettingHelp
              meta={getMeta("feedbackStoreType")}
              description={SETTING_DESCRIPTIONS.feedbackStoreType}
            />
          </div>
        );
      case "feedbackStorePath":
        return (
          <div>
            <Label htmlFor="feedbackStorePath" className="block text-sm font-medium mb-2">
              Feedback Store Path
            </Label>
            <Input
              id="feedbackStorePath"
              value={settings.feedbackStorePath}
              onChange={(e) => updateSetting("feedbackStorePath", e.target.value)}
              placeholder="/app/data/false-positives.db"
              disabled={isSettingOverridden("feedbackStorePath")}
              className={isSettingOverridden("feedbackStorePath") ? "bg-muted cursor-not-allowed" : ""}
            />
            <SettingHelp
              meta={getMeta("feedbackStorePath")}
              description={SETTING_DESCRIPTIONS.feedbackStorePath}
            />
          </div>
        );
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
            <span className="ml-2 text-xs text-foreground/70 font-normal">
              (Set by environment variable)
            </span>
          )}
        </Label>
          <Select value={theme} onValueChange={(value) => setTheme(value as typeof theme)} disabled={themeDisabled}>
            <SelectTrigger>
              <SelectValue placeholder="Select theme" />
            </SelectTrigger>
            <SelectContent>
              {themeOptions.map(({ value, label }) => (
                <SelectItem key={value} value={value}>
                  {label}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
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
          className={`rounded-lg border p-4 flex items-center justify-between gap-4 ${
            cleanupMessage.type === "success"
              ? "border-primary/30 bg-primary/10 text-primary"
              : "border-destructive/30 bg-destructive/10 text-destructive"
          }`}
          >
            <span>{cleanupMessage.message}</span>
          </div>
        )}

        {/* Save Settings Dialog */}
        <Dialog open={saveDialogOpen} onOpenChange={setSaveDialogOpen}>
          <DialogContent className="max-w-md">
            <DialogHeader>
              <DialogTitle className="flex items-center gap-2">
                {saveMessage?.type === "success" ? (
                  <svg className="h-5 w-5 text-primary" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                    <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M5 13l4 4L19 7" />
                  </svg>
                ) : (
                  <svg className="h-5 w-5 text-destructive" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                    <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M6 18L18 6M6 6l12 12" />
                  </svg>
                )}
                {saveMessage?.type === "success" ? "Settings Saved" : "Save Failed"}
              </DialogTitle>
              <DialogDescription>{saveMessage?.message}</DialogDescription>
            </DialogHeader>
            <DialogFooter>
              <Button onClick={dismissSaveMessage} variant={saveMessage?.type === "success" ? "default" : "outline"}>
                {saveMessage?.type === "success" ? "OK" : "Dismiss"}
              </Button>
            </DialogFooter>
          </DialogContent>
        </Dialog>

        {/* Tab Navigation */}
        <div className="rounded-lg border">
          <nav aria-label="Settings sections" className="border-b">
            <ul role="tablist" aria-orientation="horizontal" className="flex flex-wrap gap-1 p-1 bg-muted/50">
              {tabs.map((tab, index) => (
                <li key={tab.id} role="presentation">
                  <button
                    ref={(el) => {
                      tabRefs.current[index] = el;
                    }}
                    role="tab"
                    id={`tab-${tab.id}`}
                    aria-selected={activeTab === tab.id}
                    aria-controls={`panel-${tab.id}`}
                    tabIndex={activeTab === tab.id ? 0 : -1}
                    onClick={() => setActiveTab(tab.id)}
                    onKeyDown={(e) => handleTabKeyDown(e, tab.id, index)}
                    className={`inline-flex items-center gap-2 px-3 py-2 text-sm font-medium rounded-md transition-colors focus:outline-none focus:ring-2 focus:ring-ring focus:ring-offset-2 ${
                      activeTab === tab.id
                        ? "bg-background text-foreground shadow-sm"
                        : "text-muted-foreground hover:text-foreground hover:bg-background"
                    }`}
                  >
                    <span aria-hidden="true">{tab.icon}</span>
                    {tab.label}
                  </button>
                </li>
              ))}
            </ul>
          </nav>
        </div>

        <form onSubmit={handleSubmit} className="space-y-6">
          {renderTabPanel()}
          <Button type="submit" className="w-full md:w-auto" disabled={loading}>
            {loading ? "Loading..." : "Save Settings"}
          </Button>
        </form>
      </div>

      {/* Add Provider Dialog */}
      <Dialog open={addProviderDialogOpen} onOpenChange={setAddProviderDialogOpen}>
        <DialogContent className="max-w-md max-h-[90vh] overflow-y-auto">
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
                    className="h-4 w-4 rounded border-border"
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
                <div className="rounded-md border border-destructive/30 bg-destructive/10 p-3 text-sm text-destructive">
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
        <DialogContent className="max-w-md max-h-[90vh] overflow-y-auto">
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
                    className="h-4 w-4 rounded border-border"
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
                <div className="rounded-md border border-destructive/30 bg-destructive/10 p-3 text-sm text-destructive">
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
        <DialogContent className="max-w-md max-h-[90vh] overflow-y-auto">
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
              <div className="rounded-md border border-destructive/30 bg-destructive/10 p-3 text-sm text-destructive mt-4">
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

// Database Maintenance Component
function DatabaseMaintenance() {
  const [operations, setOperations] = useState<MaintenanceOperation[]>([
    "vacuum",
    "analyze",
    "reindex",
    "integrity_check",
    "quick_check",
  ]);
  const [results, setResults] = useState<MaintenanceResult[] | null>(null);
  const [loading, setLoading] = useState(false);
  const [dbInfo, setDbInfo] = useState<{
    pageCount: number;
    pageSize: number;
    totalSizeBytes: number;
    freelistCount: number;
    freelistBytes: number;
    journalMode: string;
    synchronous: number;
  } | null>(null);
  const [error, setError] = useState<string | null>(null);

  const formatBytes = (bytes: number): string => {
    if (bytes < 1024) return `${bytes} B`;
    if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(2)} KB`;
    if (bytes < 1024 * 1024 * 1024) return `${(bytes / (1024 * 1024)).toFixed(2)} MB`;
    return `${(bytes / (1024 * 1024 * 1024)).toFixed(2)} GB`;
  };

  const fetchDbInfo = async () => {
    try {
      const response = await apiClient.getDatabaseMaintenanceInfo();
      setDbInfo(response.databaseInfo);
    } catch (err) {
      console.error("Failed to fetch database info:", err);
    }
  };

  const handleRunMaintenance = async () => {
    setLoading(true);
    setError(null);
    setResults(null);
    try {
      const response = await apiClient.runDatabaseMaintenance(operations);
      setResults(response.results);
    } catch (err) {
      setError(err instanceof Error ? err.message : "Failed to run maintenance");
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => {
    fetchDbInfo();
  }, []);

  const handleToggleOperation = (op: MaintenanceOperation) => {
    setOperations((prev) =>
      prev.includes(op) ? prev.filter((o) => o !== op) : [...prev, op]
    );
  };

  return (
    <div className="space-y-6">
      {/* Database Info */}
      {dbInfo && (
        <div className="rounded-lg border bg-muted/30 p-4">
          <h4 className="font-medium mb-3 flex items-center gap-2">
            <HardDrive className="h-4 w-4" />
            Database Information
          </h4>
          <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-4 text-sm">
            <div>
              <p className="text-muted-foreground">Total Size</p>
              <p className="font-mono font-medium">{formatBytes(dbInfo.totalSizeBytes)}</p>
            </div>
            <div>
              <p className="text-muted-foreground">Page Count</p>
              <p className="font-mono font-medium">{dbInfo.pageCount.toLocaleString()}</p>
            </div>
            <div>
              <p className="text-muted-foreground">Free Pages</p>
              <p className="font-mono font-medium">{dbInfo.freelistCount.toLocaleString()}</p>
            </div>
            <div>
              <p className="text-muted-foreground">Reclaimable Space</p>
              <p className="font-mono font-medium">{formatBytes(dbInfo.freelistBytes)}</p>
            </div>
            <div>
              <p className="text-muted-foreground">Journal Mode</p>
              <p className="font-mono font-medium">{dbInfo.journalMode}</p>
            </div>
            <div>
              <p className="text-muted-foreground">Synchronous</p>
              <p className="font-mono font-medium">{dbInfo.synchronous}</p>
            </div>
          </div>
        </div>
      )}

      {/* Operation Selection */}
      <div className="rounded-lg border p-4">
        <h4 className="font-medium mb-3">Select Operations</h4>
        <div className="grid gap-2 sm:grid-cols-2 lg:grid-cols-5">
          {[
            { id: "vacuum", label: "VACUUM", description: "Reclaim unused space & defragment", warning: "May take time on large DBs" },
            { id: "analyze", label: "ANALYZE", description: "Update query planner statistics", warning: "Fast, safe to run anytime" },
            { id: "reindex", label: "REINDEX", description: "Rebuild all indexes", warning: "Can be slow on large DBs" },
            { id: "integrity_check", label: "Integrity Check", description: "Full database integrity verification", warning: "Slow on large DBs" },
            { id: "quick_check", label: "Quick Check", description: "Fast integrity check (less thorough)", warning: "Fast, good for regular use" },
          ].map((op) => (
            <label
              key={op.id}
              className={`flex items-start gap-3 p-3 rounded-lg border transition-colors cursor-pointer ${
                operations.includes(op.id as MaintenanceOperation)
                  ? "border-primary bg-primary/5"
                  : "border-border bg-background hover:border-primary/50 dark:hover:border-primary"
              }`}
            >
              <input
                type="checkbox"
                checked={operations.includes(op.id as MaintenanceOperation)}
                onChange={() => handleToggleOperation(op.id as MaintenanceOperation)}
                className="w-4 h-4 mt-0.5 rounded border-border text-primary focus:ring-primary"
              />
              <div>
                <p className="font-medium text-sm">{op.label}</p>
                <p className="text-xs text-muted-foreground">{op.description}</p>
                <p className="text-xs text-foreground/70 mt-0.5">{op.warning}</p>
              </div>
            </label>
          ))}
        </div>
      </div>

      {/* Run Button */}
      <Button
        onClick={handleRunMaintenance}
        disabled={loading || operations.length === 0}
        className="w-full"
        size="lg"
      >
        {loading ? (
          <>
            <Loader2 className="h-4 w-4 animate-spin mr-2" />
            Running Maintenance...
          </>
        ) : (
          "Run Selected Operations"
        )}
      </Button>

      {error && (
        <div className="rounded-lg border border-destructive/30 bg-destructive/10 p-3 text-sm text-destructive">
          {error}
        </div>
      )}

      {/* Results */}
      {results && (
        <div className="rounded-lg border p-4">
          <h4 className="font-medium mb-3">Results</h4>
          <div className="space-y-2">
            {results.map((result, i) => (
              <div
                key={i}
                className={`rounded-lg p-3 border ${
                  result.success
                    ? "border-primary/30 bg-primary/10"
                    : "border-destructive/30 bg-destructive/10"
                }`}
              >
                <div className="flex items-center justify-between">
                  <span className="font-medium capitalize">{result.operation.replace("_", " ")}</span>
                  <span
                    className={`inline-flex items-center rounded-full px-2 py-0.5 text-xs font-medium ${
                      result.success
                        ? "bg-primary/10 text-primary"
                        : "bg-destructive/10 text-destructive"
                    }`}
                  >
                    {result.success ? "Success" : "Failed"}
                  </span>
                </div>
                <p className="text-sm mt-1">{result.message}</p>
                <p className="text-xs text-muted-foreground mt-1">
                  Duration: {result.durationMs}ms
                </p>
                {result.details && (
                  <pre className="mt-2 text-xs bg-muted p-2 rounded overflow-auto">
                    {JSON.stringify(result.details, null, 2)}
                  </pre>
                )}
              </div>
            ))}
            <div className="pt-2 border-t">
              <p className="font-medium">
                Overall:{" "}
                <span className={results.every((r) => r.success) ? "text-primary" : "text-destructive"}>
                  {results.every((r) => r.success) ? "All operations succeeded" : "Some operations failed"}
                </span>
              </p>
              <p className="text-sm text-muted-foreground">
                Total duration: {results.reduce((sum, r) => sum + r.durationMs, 0)}ms
              </p>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}