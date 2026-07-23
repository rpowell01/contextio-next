export interface Settings {
  logDir: string;
  maxSessions: number;
  redactPreset: "secrets" | "pii" | "strict";
  redactReversible: boolean;
  redactPolicyFile: string;
  encryptionAtRest: boolean;
  captureCleanupEnabled: boolean;
  captureCleanupIntervalHours: number;
  captureCleanupMaxAgeDays: number;
  theme:
    | "light"
    | "dark"
    | "system"
    | "high-contrast"
    | "material-light"
    | "material-dark"
    | "solarized-light"
    | "solarized-dark"
    | "dracula"
    | "nord"
    | "github-light"
    | "github-dark"
    | "one-dark"
    | "monokai";
  // OIDC Authentication settings
  oidcEnabled: boolean;
  oidcPublicUrl: string;
}

export type SettingSource =
  "settings-file" | "environment-variable" | "default";

export interface SettingMeta {
  source: SettingSource;
  envVar: string | null;
  // true = changes take effect immediately without a restart
  dynamic: boolean;
}

// Maps each persisted setting to its environment-variable override (if any) and
// whether changing it is applied dynamically or requires a restart.
export const SETTING_ENV_MAP: Record<
  keyof Settings,
  { envVar: string; dynamic: boolean }
> = {
  logDir: { envVar: "LOGGER_CAPTURE_DIR", dynamic: false },
  maxSessions: { envVar: "LOGGER_MAX_SESSIONS", dynamic: false },
  redactPreset: { envVar: "REDACT_PRESET", dynamic: true },
  redactReversible: { envVar: "REDACT_REVERSIBLE", dynamic: true },
  redactPolicyFile: { envVar: "REDACT_POLICY_FILE", dynamic: true },
  encryptionAtRest: {
    envVar: "CONTEXTIO_LOGGER_ENCRYPTION_ENABLED",
    dynamic: false,
  },
  captureCleanupEnabled: {
    envVar: "LOGGER_CAPTURE_CLEANUP_ENABLED",
    dynamic: false,
  },
  captureCleanupIntervalHours: {
    envVar: "LOGGER_CAPTURE_CLEANUP_INTERVAL",
    dynamic: false,
  },
  captureCleanupMaxAgeDays: {
    envVar: "LOGGER_CAPTURE_MAX_AGE",
    dynamic: false,
  },
  theme: {
    envVar: "CONTEXTIO_THEME",
    dynamic: true,
  },
  oidcEnabled: {
    envVar: "CONTEXTIO_OIDC_ENABLED",
    dynamic: false,
  },
  oidcPublicUrl: {
    envVar: "CONTEXTIO_OIDC_PUBLIC_URL",
    dynamic: false,
  },
};

/**
 * Override settings values with corresponding environment variables where defined.
 * Returns a new Settings object with env var values applied, together with the set
 * of keys whose env values were successfully applied. Treats numeric env vars as
 * their raw unit (hours / days) to stay consistent with the proxy config; string
 * and boolean fields are passed through directly.
 */
function strictInteger(raw: string): boolean {
  return /^\d+$/.test(raw);
}

export function applyEnvOverrides(settings: Settings): {
  settings: Settings;
  appliedKeys: Set<keyof Settings>;
} {
  const override: Partial<Settings> = {};
  const appliedKeys = new Set<keyof Settings>();
  (
    Object.entries(SETTING_ENV_MAP) as [
      keyof Settings,
      { envVar: string; dynamic: boolean },
    ][]
  ).forEach(([key, { envVar }]) => {
    const raw = process.env[envVar];
    if (raw === undefined) return;
    let accepted = false;
    switch (key) {
      case "logDir":
        override.logDir = raw;
        accepted = true;
        break;
      case "maxSessions": {
        const n = strictInteger(raw) ? Number.parseInt(raw, 10) : NaN;
        if (Number.isFinite(n) && n >= 0 && n <= 10000) {
          override.maxSessions = n;
          accepted = true;
        }
        break;
      }
      case "redactPreset":
        if (["secrets", "pii", "strict"].includes(raw)) {
          override.redactPreset = raw as "secrets" | "pii" | "strict";
          accepted = true;
        }
        break;
  case "redactReversible":
    if (raw === "true" || raw === "false") {
      override.redactReversible = raw === "true";
      accepted = true;
    }
    break;
  case "redactPolicyFile":
    override.redactPolicyFile = raw;
    accepted = true;
    break;
  case "encryptionAtRest":
        if (raw === "true" || raw === "false") {
          override.encryptionAtRest = raw === "true";
          accepted = true;
        }
        break;
      case "captureCleanupEnabled":
        if (raw === "true" || raw === "false") {
          override.captureCleanupEnabled = raw === "true";
          accepted = true;
        }
        break;
      case "captureCleanupIntervalHours": {
        const n = strictInteger(raw) ? Number.parseInt(raw, 10) : NaN;
        if (Number.isFinite(n) && n >= 1 && n <= 168) {
          override.captureCleanupIntervalHours = n;
          accepted = true;
        }
        break;
      }
      case "captureCleanupMaxAgeDays": {
        const n = strictInteger(raw) ? Number.parseInt(raw, 10) : NaN;
        if (Number.isFinite(n) && n >= 1 && n <= 365) {
          override.captureCleanupMaxAgeDays = n;
          accepted = true;
        }
        break;
      }
      case "theme":
        if (
          [
            "light",
            "dark",
            "system",
            "high-contrast",
            "material-light",
            "material-dark",
            "solarized-light",
            "solarized-dark",
            "dracula",
            "nord",
            "github-light",
            "github-dark",
            "one-dark",
            "monokai",
          ].includes(raw)
        ) {
          override.theme = raw as
            | "light"
            | "dark"
            | "system"
            | "high-contrast"
            | "material-light"
            | "material-dark"
            | "solarized-light"
            | "solarized-dark"
            | "dracula"
            | "nord"
            | "github-light"
            | "github-dark"
            | "one-dark"
            | "monokai";
          accepted = true;
        }
        break;
      case "oidcEnabled":
        if (raw === "true" || raw === "false") {
          override.oidcEnabled = raw === "true";
          accepted = true;
        }
        break;
      case "oidcPublicUrl":
        override.oidcPublicUrl = raw;
        accepted = true;
        break;
      default:
        break;
    }
    if (accepted) appliedKeys.add(key);
  });
  return { settings: { ...settings, ...override }, appliedKeys };
}

// Computes per-setting metadata: where the active value comes from, which env
// var overrides it, and whether it is applied dynamically.
export function getSettingMetadata(
  settings: Settings,
  appliedEnvKeys: Set<keyof Settings>,
): Record<keyof Settings, SettingMeta> {
  const meta = {} as Record<keyof Settings, SettingMeta>;
  (Object.keys(SETTING_ENV_MAP) as (keyof Settings)[]).forEach((key) => {
    const { envVar, dynamic } = SETTING_ENV_MAP[key];
    const effective = appliedEnvKeys.has(key);
    let source: SettingSource;
    if (effective) {
      source = "environment-variable";
    } else if (
      JSON.stringify(settings[key]) !== JSON.stringify(DEFAULT_SETTINGS[key])
    ) {
      source = "settings-file";
    } else {
      source = "default";
    }
    meta[key] = { source, envVar: effective ? envVar : null, dynamic };
  });
  return meta;
}

export const DEFAULT_SETTINGS: Settings = {
  logDir: "",
  maxSessions: 0,
  redactPreset: "pii",
  redactReversible: false,
  redactPolicyFile: "",
  encryptionAtRest: false,
  captureCleanupEnabled: false,
  captureCleanupIntervalHours: 24,
  captureCleanupMaxAgeDays: 30,
  theme: "system",
  oidcEnabled: false,
  oidcPublicUrl: "",
};

export function validateSettings(input: unknown): Settings {
  if (typeof input !== "object" || input === null) {
    throw new Error("Settings must be an object");
  }
  const obj = input as Record<string, unknown>;

  const validateString = (key: string, minLength = 0) => {
    const v = obj[key];
    if (typeof v !== "string" || v.length < minLength) {
      throw new Error(`Invalid ${key}: must be a non-empty string`);
    }
    return v;
  };

  const validateNumber = (key: string, min: number, max: number) => {
    const v = obj[key];
    if (typeof v !== "number" || !Number.isInteger(v) || v < min || v > max) {
      throw new Error(
        `Invalid ${key}: must be an integer between ${min} and ${max}`,
      );
    }
    return v;
  };

  const validateEnum = (key: string, allowed: string[]) => {
    const v = obj[key];
    if (typeof v !== "string" || !allowed.includes(v)) {
      throw new Error(`Invalid ${key}: must be one of ${allowed.join(", ")}`);
    }
    return v as "secrets" | "pii" | "strict";
  };

  const validateBoolean = (key: string) => {
    const v = obj[key];
    if (typeof v !== "boolean") {
      throw new Error(`Invalid ${key}: must be a boolean`);
    }
    return v;
  };

  return {
    logDir: validateString("logDir", 0),
    maxSessions: validateNumber("maxSessions", 0, 10000),
    redactPreset: validateEnum("redactPreset", ["secrets", "pii", "strict"]) as "secrets" | "pii" | "strict",
    redactReversible: validateBoolean("redactReversible"),
    redactPolicyFile: validateString("redactPolicyFile", 0),
    encryptionAtRest: validateBoolean("encryptionAtRest"),
    captureCleanupEnabled: validateBoolean("captureCleanupEnabled"),
    captureCleanupIntervalHours: validateNumber(
      "captureCleanupIntervalHours",
      1,
      168,
    ),
    captureCleanupMaxAgeDays: validateNumber(
      "captureCleanupMaxAgeDays",
      1,
      365,
    ),
    theme: validateEnum("theme", [
      "light",
      "dark",
      "system",
      "high-contrast",
      "material-light",
      "material-dark",
      "solarized-light",
      "solarized-dark",
      "dracula",
      "nord",
      "github-light",
      "github-dark",
      "one-dark",
      "monokai",
    ]) as
      | "light"
      | "dark"
      | "system"
      | "high-contrast"
      | "material-light"
      | "material-dark"
      | "solarized-light"
      | "solarized-dark"
      | "dracula"
      | "nord"
      | "github-light"
      | "github-dark"
      | "one-dark"
      | "monokai",
    oidcEnabled: validateBoolean("oidcEnabled"),
    oidcPublicUrl: validateString("oidcPublicUrl", 0),
  };
}

export function mergeWithDefaults(partial: Partial<Settings>): Settings {
  return { ...DEFAULT_SETTINGS, ...partial };
}

export function validateSettingsLenient(input: unknown): Settings {
  if (typeof input !== "object" || input === null) {
    return DEFAULT_SETTINGS;
  }
  const obj = input as Record<string, unknown>;

  return {
    logDir:
      typeof obj.logDir === "string" && obj.logDir.length >= 1
        ? obj.logDir
        : DEFAULT_SETTINGS.logDir,
    maxSessions:
      typeof obj.maxSessions === "number" &&
      Number.isInteger(obj.maxSessions) &&
      obj.maxSessions >= 0 &&
      obj.maxSessions <= 10000
        ? obj.maxSessions
        : DEFAULT_SETTINGS.maxSessions,
    redactPreset:
      typeof obj.redactPreset === "string" &&
      ["secrets", "pii", "strict"].includes(obj.redactPreset)
        ? (obj.redactPreset as "secrets" | "pii" | "strict")
        : DEFAULT_SETTINGS.redactPreset,
  redactReversible:
    typeof obj.redactReversible === "boolean"
    ? obj.redactReversible
    : DEFAULT_SETTINGS.redactReversible,
  redactPolicyFile:
    typeof obj.redactPolicyFile === "string"
    ? obj.redactPolicyFile
    : DEFAULT_SETTINGS.redactPolicyFile,
  encryptionAtRest:
      typeof obj.encryptionAtRest === "boolean"
        ? obj.encryptionAtRest
        : DEFAULT_SETTINGS.encryptionAtRest,
    captureCleanupEnabled:
      typeof obj.captureCleanupEnabled === "boolean"
        ? obj.captureCleanupEnabled
        : DEFAULT_SETTINGS.captureCleanupEnabled,
    captureCleanupIntervalHours:
      typeof obj.captureCleanupIntervalHours === "number" &&
      Number.isInteger(obj.captureCleanupIntervalHours) &&
      obj.captureCleanupIntervalHours >= 1 &&
      obj.captureCleanupIntervalHours <= 168
        ? obj.captureCleanupIntervalHours
        : DEFAULT_SETTINGS.captureCleanupIntervalHours,
    captureCleanupMaxAgeDays:
      typeof obj.captureCleanupMaxAgeDays === "number" &&
      Number.isInteger(obj.captureCleanupMaxAgeDays) &&
      obj.captureCleanupMaxAgeDays >= 1 &&
      obj.captureCleanupMaxAgeDays <= 365
        ? obj.captureCleanupMaxAgeDays
        : DEFAULT_SETTINGS.captureCleanupMaxAgeDays,
    theme:
      typeof obj.theme === "string" &&
      [
        "light",
        "dark",
        "system",
        "high-contrast",
        "material-light",
        "material-dark",
        "solarized-light",
        "solarized-dark",
        "dracula",
        "nord",
        "github-light",
        "github-dark",
        "one-dark",
        "monokai",
      ].includes(obj.theme)
        ? (obj.theme as
            | "light"
            | "dark"
            | "system"
            | "high-contrast"
            | "material-light"
            | "material-dark"
            | "solarized-light"
            | "solarized-dark"
            | "dracula"
            | "nord"
            | "github-light"
            | "github-dark"
            | "one-dark"
            | "monokai")
        : DEFAULT_SETTINGS.theme,
    oidcEnabled:
      typeof obj.oidcEnabled === "boolean"
        ? obj.oidcEnabled
        : DEFAULT_SETTINGS.oidcEnabled,
    oidcPublicUrl:
      typeof obj.oidcPublicUrl === "string"
        ? obj.oidcPublicUrl
        : DEFAULT_SETTINGS.oidcPublicUrl,
  };
}
