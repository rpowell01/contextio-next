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
  logDir: "./captures",
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
    logDir: validateString("logDir", 1),
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