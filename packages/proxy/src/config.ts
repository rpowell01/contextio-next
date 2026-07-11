/**
 * Proxy configuration resolution.
 *
 * Merges programmatic overrides with environment variables and applies
 * safe defaults. All upstream URLs, bind address, port, capture retention,
 * and feature flags are resolved here before the proxy starts.
 */

import fs from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

import type { ProxyConfig, Upstreams } from "@contextio/core";

/** Normalize an upstream URL by stripping a trailing `/v1` so callers do not
 *  double-prefix API paths. Empty values pass through intact. */
function normalizeUpstreamUrl(url: string): string {
  if (!url || typeof url !== "string") {
    return url;
  }
  return url.replace(/\/v1$/, "");
}

/** Web UI settings interface for capture cleanup settings. */
interface WebUICaptureCleanupSettings {
  captureCleanupEnabled?: boolean;
  captureCleanupIntervalHours?: number;
  captureCleanupMaxAgeDays?: number;
}

/** Read web UI settings from the JSON file. */
function readWebUISettings(): WebUICaptureCleanupSettings {
  const settingsPath = join(homedir(), ".contextio-next", "settings.json");
  try {
    const data = fs.readFileSync(settingsPath, "utf8");
    const parsed = JSON.parse(data);
    return {
      captureCleanupEnabled: parsed.captureCleanupEnabled,
      captureCleanupIntervalHours: parsed.captureCleanupIntervalHours,
      captureCleanupMaxAgeDays: parsed.captureCleanupMaxAgeDays,
    };
  } catch {
    return {};
  }
}

/** Fully resolved config with all defaults applied. */
export interface ResolvedProxyConfig {
  upstreams: Upstreams;
  bindHost: string;
  port: number;
  allowTargetOverride: boolean;
  strictUrlForwarding: boolean;
  loggerCaptureDir: string;
  loggerCaptureMaxAgeMs: number;
  loggerCaptureCleanupIntervalMs: number;
  loggerCaptureCleanupEnabled: boolean;
}

/**
 * Resolve final proxy config from environment variables and overrides.
 *
 * Capture retention:
 * - `LOGGER_CAPTURE_DIR` overrides the capture directory
 * - `LOGGER_CAPTURE_MAX_AGE` enable time-based retention when > 0
 * - `LOGGER_CAPTURE_CLEANUP_INTERVAL` controls cleanup interval (milliseconds,
 *   default: 3600000)
 * - `LOGGER_CAPTURE_CLEANUP_ENABLED` allows disabling cleanup while keeping
 *   the config values in place
 */
export function resolveConfig(
  overrides?: ProxyConfig,
): ResolvedProxyConfig {
  const defaultUpstreams: Upstreams = {
    openai: process.env.UPSTREAM_OPENAI_URL || "https://api.openai.com",
    anthropic:
      process.env.UPSTREAM_ANTHROPIC_URL || "https://api.anthropic.com",
    chatgpt: process.env.UPSTREAM_CHATGPT_URL || "https://chatgpt.com",
    gemini:
      process.env.UPSTREAM_GEMINI_URL ||
      "https://generativelanguage.googleapis.com",
    geminiCodeAssist:
      process.env.UPSTREAM_GEMINI_CODE_ASSIST_URL ||
      "https://cloudcode-pa.googleapis.com",
    vertex:
      process.env.UPSTREAM_VERTEX_URL ||
      "https://us-central1-aiplatform.googleapis.com",
    nvidia:
      process.env.UPSTREAM_NVIDIA_URL ||
      "https://integrate.api.nvidia.com",
    kilo:
      process.env.UPSTREAM_KILO_URL ||
      "https://api.kilo.ai/api/gateway",
    openrouter:
      process.env.UPSTREAM_OPENROUTER_URL || "https://openrouter.ai/api",
  };

  const bindHost =
    overrides?.bindHost ||
    process.env.CONTEXT_PROXY_BIND_HOST ||
    "127.0.0.1";

  const port =
    overrides?.port ?? parseInt(process.env.CONTEXT_PROXY_PORT || "4040", 10);

  const allowTargetOverride =
    overrides?.allowTargetOverride ??
    process.env.CONTEXT_PROXY_ALLOW_TARGET_OVERRIDE === "1";

  const strictUrlForwarding =
    overrides?.strictUrlForwarding ??
    process.env.STRICT_URL_FORWARDING === "true";

  const loggerCaptureDir =
    overrides?.loggerCaptureDir ||
    process.env.LOGGER_CAPTURE_DIR ||
    `${process.env.HOME || process.env.USERPROFILE || "~"}/.contextio/captures`;

const loggerCaptureMaxAgeMs = overrides?.loggerCaptureMaxAgeMs ?? (() => {
  // `captureCleanupMaxAgeDays` in settings.json → days pushed via `LOGGER_CAPTURE_MAX_AGE`
  const raw = process.env.LOGGER_CAPTURE_MAX_AGE;
  const parsed = raw ? Number.parseInt(raw, 10) : 0;
  return Number.isFinite(parsed) ? parsed * 24 * 60 * 60 * 1000 : 0;
})();

const loggerCaptureCleanupIntervalMs = overrides?.loggerCaptureCleanupIntervalMs ?? (() => {
  // `captureCleanupIntervalHours` in settings.json → hours pushed via `LOGGER_CAPTURE_CLEANUP_INTERVAL`
  const raw = process.env.LOGGER_CAPTURE_CLEANUP_INTERVAL || "24";
  const parsed = Number.parseInt(raw, 10);
  return Number.isFinite(parsed) && parsed > 0 ? parsed * 60 * 60 * 1000 : 24 * 60 * 60 * 1000;
})();


  const loggerCaptureCleanupEnabled =
    (overrides?.loggerCaptureCleanupEnabled ??
      process.env.LOGGER_CAPTURE_CLEANUP_ENABLED === "true") &&
    loggerCaptureMaxAgeMs > 0;

  const upstreams: Upstreams = {
    ...defaultUpstreams,
    ...overrides?.upstreams,
  };

  const normalizedUpstreams: Upstreams = {
    openai: normalizeUpstreamUrl(upstreams.openai),
    anthropic: normalizeUpstreamUrl(upstreams.anthropic),
    chatgpt: normalizeUpstreamUrl(upstreams.chatgpt),
    gemini: normalizeUpstreamUrl(upstreams.gemini),
    geminiCodeAssist: normalizeUpstreamUrl(upstreams.geminiCodeAssist),
    vertex: normalizeUpstreamUrl(upstreams.vertex),
    nvidia: normalizeUpstreamUrl(upstreams.nvidia),
    kilo: normalizeUpstreamUrl(upstreams.kilo),
    openrouter: normalizeUpstreamUrl(upstreams.openrouter),
  };

return {
  upstreams: normalizedUpstreams,
  bindHost,
  port,
  allowTargetOverride,
  strictUrlForwarding,
  loggerCaptureDir,
  loggerCaptureMaxAgeMs,
  loggerCaptureCleanupIntervalMs,
  loggerCaptureCleanupEnabled,
};
}
