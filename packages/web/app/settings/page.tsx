"use client";

import { MainLayout } from "@/components/main-layout";
import { apiClient } from "@/lib/api";
import type { Settings, SettingMeta, Provider, RateLimitConfig, StreamingRetryConfig } from "@/lib/settings";
import type { ProviderConfig, ProviderMetadata } from "@/types/api";
import type { PresetName } from "@contextio/redact";
import { useState, useEffect, useRef } from "react";
import { useTheme } from "@/components/theme-provider";

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
import { Loader2, Trash2, Edit2, Plus, Database, Shield, Gauge, Palette, Server, EyeOff } from "lucide-react";

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
  redactPathsOnly:
    "JSON paths where redaction should be applied (e.g., ['messages[*].content']). Only values at these paths will be checked for redaction. Changes apply dynamically per request.",
  redactPathsSkip:
    "JSON paths where redaction should be skipped (e.g., tool call IDs, function arguments). These are checked before 'only' paths. Default includes all tool call and structured data paths to prevent NER false positives. Changes apply dynamically per request.",
  redactDisabledRules:
    "List of redaction rule IDs to disable. Use this to selectively disable specific redaction types (e.g., URL, ORGANIZATION) while keeping others active. Changes apply dynamically per request.",
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
    "Detection mode: 'rules' (fast, deterministic patterns), 'llm' (semantic PII detection via LLM), 'hybrid' (rules + LLM with priority merge), or 'auto' (automatically choose). Changes apply dynamically per request.",
  detectorModelName:
    "Name of the Hugging Face model used for LLM-based PII detection (e.g., 'Xenova/bert-base-NER'). Used in llm/hybrid/auto modes. Changes apply dynamically.",
  detectorThreshold:
    "Minimum confidence threshold for LLM-based detections (0-1). Higher values reduce false positives but may miss some entities. Applied dynamically per request.",
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

// Detector Mode Warnings Component
// Shows which policy features are active/ignored based on the current detector mode
function DetectorModeWarnings({
  detectorMode,
  detectorModelName,
  detectorThreshold,
  hasCustomPolicy,
}: {
  detectorMode: "rules" | "llm" | "hybrid" | "auto";
  detectorModelName: string;
  detectorThreshold: number;
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
              ? "border-blue-200 bg-blue-50 text-blue-800"
              : w.type === "warning"
              ? "border-amber-200 bg-amber-50 text-amber-800"
              : "border-green-200 bg-green-50 text-green-800"
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
}: {
  disabledRules: string[];
  onChange: (rules: string[]) => void;
  disabled: boolean;
  preset: PresetName;
  hasCustomPolicy: boolean;
}) {
  const disabledSet = new Set(disabledRules);

  // Custom policy takes precedence - disabled rules are managed in the policy file
  const isCustomPolicyMode = hasCustomPolicy && Boolean(preset === "strict");

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
        <div className="rounded-lg border border-amber-200 bg-amber-50 p-3 text-sm text-amber-800">
          <strong>Custom policy file active:</strong> Disabled rules are managed in your custom policy file.
          Edit the policy file directly to enable/disable specific rules. The checkboxes below are disabled
          because they only apply to built-in presets.
        </div>
      )}
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
                        ? "border-gray-200 bg-gray-50 dark:border-gray-700 dark:bg-gray-900/50"
                        : "border-gray-200 bg-white dark:border-gray-700 dark:bg-gray-900 hover:border-primary/50"
                    } ${isCheckboxDisabled ? "opacity-50 cursor-not-allowed" : "cursor-pointer"}`}
                    title={description}
                  >
                    <input
                      type="checkbox"
                      checked={!isDisabled}
                      onChange={() => handleToggle(ruleName)}
                      disabled={isCheckboxDisabled}
                      className="w-4 h-4 rounded border-gray-300 text-primary focus:ring-primary"
                    />
                    <span className="text-sm font-mono text-primary/80">{ruleName}</span>
                    <span className="text-xs text-muted-foreground flex-1 min-w-0 truncate">{description}</span>
                  </label>
                );
              })}
            </div>
          </div>
        ))}
      {disabled && !isCustomPolicyMode && (
        <div className="rounded-lg border border-amber-200 bg-amber-50 p-3 text-sm text-amber-800">
          This setting is controlled by the <code>CONTEXTIO_REDACT_DISABLED_RULES</code> environment variable
          and cannot be changed here.
        </div>
      )}
    </div>
  );
}

// Tab configuration (module scope for stability)
type SettingsTab = "appearance" | "logging" | "providers" | "proxy" | "rateLimiter" | "redaction" | "security" | "streamingRetry";

const tabs: { id: SettingsTab; label: string; icon: React.ReactNode }[] = [
  { id: "appearance", label: "Appearance", icon: <Palette className="h-4 w-4" /> },
  { id: "logging", label: "Logging", icon: <Database className="h-4 w-4" /> },
  { id: "providers", label: "Providers", icon: <Server className="h-4 w-4" /> },
  { id: "proxy", label: "Proxy", icon: <Server className="h-4 w-4" /> },
  { id: "rateLimiter", label: "Rate Limiter", icon: <Gauge className="h-4 w-4" /> },
  { id: "redaction", label: "Redaction", icon: <EyeOff className="h-4 w-4" /> },
  { id: "security", label: "Security", icon: <Shield className="h-4 w-4" /> },
  { id: "streamingRetry", label: "Streaming Retry", icon: <Gauge className="h-4 w-4" /> },
];

export default function SettingsPage() {
  const [settings, setSettings] = useState<Omit<Settings, "theme">>({
    logDir: "./captures",
    maxSessions: 0,
    redactPreset: "pii",
    redactReversible: false,
    redactPolicyFile: "",
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
    showPageLoadTime: false,
    detectorMode: "rules",
    detectorModelName: "Xenova/bert-base-NER",
    detectorThreshold: 0.5,
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
  });
  const [metadata, setMetadata] = useState<Record<
    keyof Settings,
    SettingMeta
  > | null>(null);
  const [saveMessage, setSaveMessage] = useState<{
    type: "success" | "error";
    message: string;
  } | null>(null);
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

  // Persist active tab to localStorage
  useEffect(() => {
    localStorage.setItem("settings-active-tab", activeTab);
  }, [activeTab]);

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
  useEffect(() => {
    const activeIndex = tabs.findIndex((t) => t.id === activeTab);
    if (activeIndex >= 0 && tabRefs.current[activeIndex]) {
      tabRefs.current[activeIndex]?.focus();
    }
  }, [activeTab]);

  // Render tab panel content
  const renderTabPanel = () => {
    switch (activeTab) {
      case "logging":
        return (
          <div className="rounded-lg border p-6" role="tabpanel" id="panel-logging" aria-labelledby="tab-logging">
            <h3 className="font-semibold mb-4">Logging</h3>
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
        );
      case "redaction":
        return (
          <div className="rounded-lg border p-6" role="tabpanel" id="panel-redaction" aria-labelledby="tab-redaction">
            <h3 className="font-semibold mb-4">Redaction</h3>
            <div className="space-y-4">
              {renderSetting("enableRedact")}
              {renderSetting("redactPreset")}
              {renderSetting("redactReversible")}
              {renderSetting("redactPolicyFile")}

              {/* Path filtering settings */}
              <div className="pt-2 border-t">
                <h4 className="text-sm font-medium text-muted-foreground mb-3">Path Filtering</h4>
                <p className="text-xs text-muted-foreground mb-4">
                  Configure which JSON paths are redacted ("only") and which are skipped ("skip").
                  Skip paths are checked before only paths. Defaults cover all LLM tool call formats
                  (OpenAI tool_calls, Anthropic content blocks) to prevent NER false positives.
                </p>
                <div className="space-y-4">
                  {renderSetting("redactPathsOnly")}
                  {renderSetting("redactPathsSkip")}
                </div>
              </div>

              {/* Disabled Rules Settings */}
              <div className="pt-2 border-t">
                <h4 className="text-sm font-medium text-muted-foreground mb-3">Disabled Redaction Rules</h4>
                <p className="text-xs text-muted-foreground mb-4">
                  Selectively disable specific redaction rule types. Uncheck a rule to stop it from
                  redacting values. Changes apply dynamically per request.
                </p>
                <DisabledRulesList
                  disabledRules={settings.redactDisabledRules}
                  onChange={(rules) => updateSetting("redactDisabledRules", rules)}
                  disabled={isSettingOverridden("redactDisabledRules")}
                  preset={settings.redactPreset}
                  hasCustomPolicy={Boolean(settings.redactPolicyFile?.trim())}
                />
              </div>

              {/* Detector mode capabilities & warnings */}
              <DetectorModeWarnings
                detectorMode={settings.detectorMode}
                detectorModelName={settings.detectorModelName}
                detectorThreshold={settings.detectorThreshold}
                hasCustomPolicy={Boolean(settings.redactPolicyFile?.trim())}
              />

              <div className="pt-2 border-t">
                <h4 className="text-sm font-medium text-muted-foreground mb-3">Detector Settings</h4>
                <div className="space-y-4">
                  {renderSetting("detectorMode")}
                  {renderSetting("detectorModelName")}
                  {renderSetting("detectorThreshold")}
                </div>
              </div>
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
            <h3 className="font-semibold mb-4">Streaming Retry Configuration</h3>
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
        if (result.metadata) {
          setMetadata(result.metadata as Record<keyof Settings, SettingMeta>);
        }
      } else {
        setSaveMessage({
          type: "error",
          message: "Failed to save settings",
        });
      }
    } catch (error) {
      setSaveMessage({
        type: "error",
        message:
          error instanceof Error ? error.message : "Failed to save settings",
      });
    }
  };

  const dismissSaveMessage = () => setSaveMessage(null);

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
      case "redactPathsOnly":
        return (
          <div>
            <Label htmlFor="redactPathsOnly" className="block text-sm font-medium mb-2">
              Redaction Paths (Only)
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
              disabled={isSettingOverridden("redactPathsOnly")}
              className={`font-mono text-xs min-h-[80px] w-full p-2 border rounded ${
                isSettingOverridden("redactPathsOnly") ? "bg-muted cursor-not-allowed" : ""
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
          </div>
        );
      case "redactPathsSkip":
        return (
          <div>
            <Label htmlFor="redactPathsSkip" className="block text-sm font-medium mb-2">
              Redaction Paths (Skip)
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
              disabled={isSettingOverridden("redactPathsSkip")}
              className={`font-mono text-xs min-h-[120px] w-full p-2 border rounded ${
                isSettingOverridden("redactPathsSkip") ? "bg-muted cursor-not-allowed" : ""
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
              <option value="llm">LLM only (semantic detection via LLM)</option>
              <option value="hybrid">Hybrid (rules + LLM, rules take priority)</option>
              <option value="auto">Auto (choose based on content)</option>
            </select>
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
              Detector Model Name
            </Label>
            <Input
              id="detectorModelName"
              value={settings.detectorModelName}
              onChange={(e) => updateSetting("detectorModelName", e.target.value)}
              placeholder="Xenova/bert-base-NER"
              disabled={isSettingOverridden("detectorModelName")}
              className={
                isSettingOverridden("detectorModelName") ? "bg-muted cursor-not-allowed" : ""
              }
            />
            <SettingHelp
              meta={getMeta("detectorModelName")}
              description={SETTING_DESCRIPTIONS.detectorModelName}
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
                              className="h-4 w-4 rounded border-gray-300"
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

        {(cleanupMessage || saveMessage) && (
          <div
            className={`rounded-lg border p-4 flex items-center justify-between gap-4 ${
              (saveMessage ?? cleanupMessage)?.type === "success"
                ? "border-green-200 bg-green-50 text-green-800"
                : "border-red-200 bg-red-50 text-red-800"
            }`}
          >
            <span>{(saveMessage ?? cleanupMessage)?.message}</span>
            {saveMessage && (
              <button
                onClick={dismissSaveMessage}
                className="flex-shrink-0 text-sm font-medium hover:underline"
                aria-label="Dismiss"
              >
                Dismiss
              </button>
            )}
          </div>
        )}

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