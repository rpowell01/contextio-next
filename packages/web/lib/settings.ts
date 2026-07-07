export interface Settings {
  logDir: string;
  maxSessions: number;
  redactPreset: "secrets" | "pii" | "strict";
  redactReversible: boolean;
  captureCleanupEnabled: boolean;
  captureCleanupIntervalHours: number;
  captureCleanupMaxAgeDays: number;
}

export const DEFAULT_SETTINGS: Settings = {
  logDir: "",
  maxSessions: 0,
  redactPreset: "pii",
  redactReversible: false,
  captureCleanupEnabled: false,
  captureCleanupIntervalHours: 24,
  captureCleanupMaxAgeDays: 30,
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
      throw new Error(`Invalid ${key}: must be an integer between ${min} and ${max}`);
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
    redactPreset: validateEnum("redactPreset", ["secrets", "pii", "strict"]),
    redactReversible: validateBoolean("redactReversible"),
    captureCleanupEnabled: validateBoolean("captureCleanupEnabled"),
    captureCleanupIntervalHours: validateNumber("captureCleanupIntervalHours", 1, 168),
    captureCleanupMaxAgeDays: validateNumber("captureCleanupMaxAgeDays", 1, 365),
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
  };
}