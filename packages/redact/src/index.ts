/**
 * @contextio/redact - Privacy and redaction layer for LLM API calls.
 *
 * Proxy plugin that strips PII, secrets, and API keys from request
 * bodies before they reach the LLM provider.
 *
 * Supports built-in presets (secrets, pii, strict), custom rules,
 * context-word gating, allowlists, and JSON path filtering.
 *
 * When `reversible` is enabled, the plugin tracks redacted values per
 * session and restores them in the LLM response, making redaction fully
 * transparent to the client.
 *
 * ```typescript
 * import { createRedactPlugin } from '@contextio/redact';
 *
 * // One-way: strip and forget
 * const redact = createRedactPlugin({ preset: "pii" });
 *
 * // Reversible: strip on request, restore on response
 * const redact = createRedactPlugin({ preset: "pii", reversible: true });
 * ```
 */

import type {
  ProxyPlugin,
  RequestContext,
  ResponseContext,
  Provider,
} from "@contextio/core";

import fs from "node:fs";
import { ReplacementMap } from "./mapping.js";
import type { CompiledPolicy, PolicyJson, PathMatcher } from "./policy.js";
import { compilePolicy, fromPreset, loadPolicyFile, parsePath } from "./policy.js";
import type { PresetName } from "./presets.js";
import type { RedactionRule } from "./rules.js";
import { buildRedactMetaPayload, buildFullRedactionMetadata, createStats, getLineAndCharIndex, recordMatch, redactWithPolicy, type MatchEntry, type RedactionMetadata, type RedactionStats } from "./redact.js";
import { createStreamRehydrator } from "./stream.js";
import type {
  Detector,
  DetectorConfig,
  DetectionResult,
  DetectedSpan,
  DetectorMode,
  RedactDetectorConfig,
  DetectorPipelineConfig,
} from "./detector.js";
import { detectorRegistry, registerDetector, createDetector } from "./detector.js";
import { createRuleDetector } from "./ruleDetector.js";
import { createDetectorPipeline, createHybridDetector, mergeDetectionResults } from "./detectorPipeline.js";
import { createPresidioTsDetector, type PresidioTsConfig } from "./presidioTsDetector.js";
import { createFeedbackStore, type FeedbackStore, type FalsePositiveEntry } from "./feedback.js";
import { EntityType } from "@siddicky/anonymizerts";

/** Default skip paths to prevent redaction of tool call IDs and structured data. */
export const DEFAULT_REDACT_SKIP_PATHS = [
  "tools",
  "tool_calls",
  "toolChoice",
  "tool_choice",
  "functions",
  "function_call",
  // Skip tool call IDs and function arguments to prevent NER false positives
  // Full paths from root (path matching is prefix-based)
  // OpenAI format: messages[*].tool_calls[*]
  "messages[*].tool_calls[*].id",
  "messages[*].tool_calls[*].function.name",
  "messages[*].tool_calls[*].function.arguments",
  "messages[*].tools[*].id",
  "messages[*].tools[*].function.name",
  "messages[*].tools[*].function.arguments",
  "messages[*].function_call.id",
  "messages[*].function_call.name",
  "messages[*].function_call.arguments",
  // Also handle top-level tool_calls (non-standard but possible)
  "tool_calls[*].id",
  "tool_calls[*].function.name",
  "tool_calls[*].function.arguments",
  "tools[*].id",
  "tools[*].function.name",
  "tools[*].function.arguments",
  "function_call.id",
  "function_call.name",
  "function_call.arguments",
  // Anthropic/Claude format: messages[*].content[*] with type="tool_use"
  "messages[*].content[*].id",
  "messages[*].content[*].name",
  "messages[*].content[*].input",
  // Anthropic/Claude tool_result blocks (response from tool calls)
  "messages[*].content[*].tool_use_id",
  "messages[*].content[*].content",
  // Anthropic/Claude thinking blocks
  "messages[*].content[*].thinking",
  "messages[*].content[*].signature",
  // Block type discriminator (present on all content blocks)
  "messages[*].content[*].type",
  // Also handle top-level content arrays
  "content[*].id",
  "content[*].name",
  "content[*].input",
  "content[*].tool_use_id",
  "content[*].content",
  "content[*].thinking",
  "content[*].signature",
  "content[*].type",
];

/** Default only paths - only redact user message content by default. */
export const DEFAULT_REDACT_ONLY_PATHS = ["messages[*].content"];

/** Configuration for {@link createRedactPlugin}. */
export interface RedactPluginConfig {
  /** Built-in preset to use. Default: "pii". */
  preset?: PresetName;
  /** Path to a policy JSON(C) file. Overrides `preset`. */
  policyFile?: string;
  /** Pre-compiled policy object. Overrides both `preset` and `policyFile`. */
  policy?: CompiledPolicy;
  /** Array of rule IDs to disable (e.g., ["url", "organization"]). Rules with these names will be excluded from redaction. */
  disabledRules?: string[];
  /**
   * Detection mode:
   * - "rules": rule-based only (default, fast, deterministic)
   * - "llm": LLM-based only (semantic understanding, slower)
   * - "hybrid": rules first for high-confidence patterns, LLM for ambiguous PII
   * - "auto": automatically choose based on content characteristics
   * Default: "rules"
   */
  detectorMode?: DetectorMode;
  /**
   * LLM detector configuration. Used when detectorMode is "llm", "hybrid", or "auto".
   */
  detectorConfig?: RedactDetectorConfig;
  /**
   * JSON path scoping to limit where redaction is applied.
   * By default, only redacts user message content (messages[*].content) and skips
   * tool calls and their structured data (IDs, function names, arguments).
   * Set to { only: null, skip: [] } to redact all string values.
   */
  paths?: {
    /** If set, only redact values at these JSON paths. Supports simple dot notation and [*] for array wildcard. Example: ["messages[*].content", "system"] */
    only?: string[];
    /** Skip redaction for values at these JSON paths. Checked before "only". Default skips tool calls and structured data. Example: ["model", "metadata", "tools", "tool_calls"] */
    skip?: string[];
  };
  /**
   * Enable reversible redaction. When true, the plugin tracks
   * original values per session and restores them in LLM responses.
   * The LLM sees `[EMAIL_1]`; the client sees the original.
   *
   * Requires session IDs in the URL path (set automatically by the CLI).
   * Default: false (one-way, strip and forget).
   */
  reversible?: boolean;
  /**
   * How long to keep a session's replacement map after its last request,
   * in milliseconds. Only used when `reversible` is true.
   * Default: 30 minutes.
   */
  sessionTtlMs?: number;
  /** Log redaction stats to stderr after each request. */
  verbose?: boolean;
  /**
   * Optional callback invoked after each redaction pass with the complete
   * metadata record. The plugin computes all fields and passes them here
   * instead of writing .redact-meta.json sidecar files.
   * The callback is responsible for persisting metadata (e.g., to SQLite).
   */
  onRedactionMetadata?: (metadata: RedactionMetadata) => void;
  /**
   * Optional feedback store for filtering known false positives.
   * Can be a FeedbackStore instance or "sqlite"/"memory" to auto-create.
   * Default: undefined (no false positive filtering).
   */
  feedbackStore?: FeedbackStore | "sqlite" | "memory";
  /**
   * List of provider IDs for which redaction should be skipped.
   * When set, requests from these providers pass through unredacted.
   * Default: undefined (redact all providers).
   */
  disabledProviders?: Provider[];
}

/** Extended plugin interface for the redact plugin with feedback store methods. */
interface RedactPlugin extends ProxyPlugin {
  /**
   * Report a false positive to the feedback store.
   * This allows users to mark incorrectly redacted values so they won't be redacted in the future.
   * @param params - Object containing the false positive details
   * @param params.value - The original value that was incorrectly redacted
   * @param params.ruleId - The rule ID that triggered the false positive
   * @param params.label - The label/category of the detection (e.g., "EMAIL", "PHONE", "CREDIT_CARD")
   * @param params.path - The JSON path where the value was found (e.g., "$.messages[0].content")
   * @param params.sessionId - Optional session ID for scoping
   * @param params.matchMode - How to match this entry: 'exact' or 'pattern' (default: 'exact')
   * @returns The created false positive entry
   */
  reportFalsePositive(params: {
    value: string;
    ruleId: string;
    label: string;
    path: string;
    sessionId?: string;
    matchMode?: "exact" | "pattern";
  }): Promise<FalsePositiveEntry>;

  /**
   * Get the feedback store instance for direct access.
   * @returns The FeedbackStore instance, or undefined if not configured
   */
  getFeedbackStore(): FeedbackStore | undefined;
}

/** Per-session state for reversible mode: mapping table + stream rehydrator. */
interface SessionState {
  map: ReplacementMap;
  rehydrator: ReturnType<typeof createStreamRehydrator>;
  lastSeen: number;
}

/** Detector pipeline state (lazy initialized). */
interface DetectorState {
  pipeline: Detector | null;
  initialized: boolean;
  initializing: Promise<void> | null;
}

/**
 * Built-in allowlist for common false positives from NER models.
 * These are words that are frequently misclassified as entities but shouldn't be redacted.
 */
const NER_FALSE_POSITIVE_ALLOWLIST: Record<string, string[]> = {
  ORGANIZATION: [
    "Updated", "updates", "Update", "update",
    "Created", "creates", "Create", "create",
    "Modified", "modifies", "Modify", "modify",
    "Deleted", "deletes", "Delete", "delete",
    "Added", "adds", "Add", "add",
    "Removed", "removes", "Remove", "remove",
    "Changed", "changes", "Change", "change",
    "Fixed", "fixes", "Fix", "fix",
    "Resolved", "resolves", "Resolve", "resolve",
    "Closed", "closes", "Close", "close",
    "Opened", "opens", "Open", "open",
    "Merged", "merges", "Merge", "merge",
    "Released", "releases", "Release", "release",
    "Deployed", "deploys", "Deploy", "deploy",
    "Started", "starts", "Start", "start",
    "Stopped", "stops", "Stop", "stop",
    "Running", "runs", "Run", "run",
    "Completed", "completes", "Complete", "complete",
    "Failed", "fails", "Fail", "fail",
    "Pending", "pending",
    "Active", "active",
    "Inactive", "inactive",
    "Enabled", "enables", "Enable", "enable",
    "Disabled", "disables", "Disable", "disable",
    "Valid", "valid",
    "Invalid", "invalid",
    "Success", "success",
    "Error", "error",
    "Warning", "warning",
    "Info", "info",
    "Debug", "debug",
    "Test", "test",
    "Pass", "pass",
    "Fail", "fail",
  ],
  PERSON: [
    "I", "We", "You", "He", "She", "They",
    "Me", "Us", "Him", "Her", "Them",
    "My", "Our", "Your", "His", "Her", "Their",
    "Mine", "Ours", "Yours", "His", "Hers", "Theirs",
  ],
};

/**
 * Apply detector spans to a string, returning the redacted string and
 * updating stats/map for reversible mode.
 */
async function applyDetectorSpans(
  input: string,
  spans: DetectedSpan[],
  stats: ReturnType<typeof createStats>,
  map: ReplacementMap | null,
  placeholderAllowlist: Set<string>,
  currentPath: string[] = [],
  feedbackStore: FeedbackStore | null = null,
): Promise<string> {
  if (spans.length === 0) return input;

// Map Presidio entity labels to rule names for consistent false positive filtering
  // and placeholder naming across detector types (RuleDetector, PresidioTsDetector)
  const labelToRuleId: Record<string, string> = {
    "EMAIL_ADDRESS": "email",
    "PHONE_NUMBER": "phone-us",
    "CREDIT_CARD": "credit-card",
    "US_SSN": "ssn",
    "IP_ADDRESS": "ipv4",
    "URL": "url",
    "DATE_TIME": "date-of-birth",
    "PERSON": "person",
    "LOCATION": "location",
    "ORGANIZATION": "organization",
  };

  // Sort spans by start position (ascending) for recording matches in natural order
  // This ensures early matches in the text are recorded first, making them more likely
  // to be included when MATCHES_LIMIT is applied in buildRedactMetaPayload
  const spansAscending = [...spans].sort((a, b) => a.start - b.start);

  // Track per-ruleId counters for non-reversible mode to generate consistent placeholders
  // e.g., [ORGANIZATION_REDACTED], [PERSON_REDACTED] instead of timestamps
  const nonReversibleCounters = new Map<string, number>();

  // Pre-compute replacements for all valid spans (in ascending order) so we can
  // record matches in the correct order before applying replacements in reverse
  interface SpanReplacement {
    span: DetectedSpan;
    match: string;
    ruleId: string;
    replacement: string;
  }
  const replacements: SpanReplacement[] = [];

  // Step 1: Collect candidates that pass synchronous checks
  const candidates: { span: DetectedSpan; match: string; ruleId: string }[] = [];
  for (const span of spansAscending) {
    const match = input.slice(span.start, span.end);
    // Skip if match is a known placeholder token (prevent re-redaction)
    if (placeholderAllowlist.has(match)) continue;

    // Normalize ruleId: use mapping for Presidio labels, fallback to lowercase label
    const ruleId = labelToRuleId[span.label] ?? span.label.toLowerCase();

    // Filter common NER false positives
    const falsePositives = NER_FALSE_POSITIVE_ALLOWLIST[ruleId.toUpperCase()];
    if (falsePositives && falsePositives.includes(match)) {
      continue;
    }

    candidates.push({ span, match, ruleId });
  }

  // Step 2: Parallel false positive checks using Promise.all
  const fpPromises = candidates.map(({ match, ruleId }) =>
    feedbackStore ? feedbackStore.isFalsePositive(match, ruleId) : Promise.resolve(false)
  );
  const fpResults = await Promise.all(fpPromises);

  // Step 3: Build replacements from candidates that aren't false positives
  for (let i = 0; i < candidates.length; i++) {
    const { span, match, ruleId } = candidates[i];
    if (fpResults[i]) continue; // skip false positives

    let replacement: string;
    if (map) {
      // Reversible mode: use ReplacementMap which generates [LABEL_N] format
      replacement = map.getOrCreate(match, ruleId);
    } else {
      // Non-reversible mode: use consistent [LABEL_REDACTED] format
      const count = (nonReversibleCounters.get(ruleId) ?? 0) + 1;
      nonReversibleCounters.set(ruleId, count);
      const label = ruleId.toUpperCase().replace(/[^A-Z0-9]/g, "_");
      replacement = `[${label}_REDACTED]`;
    }

    replacements.push({ span, match, ruleId, replacement });
  }

  // Record all matches in ascending order (early matches first)
  for (const r of replacements) {
    stats.totalReplacements++;
    stats.byRule[r.ruleId] = (stats.byRule[r.ruleId] || 0) + 1;
    // Calculate line number and character positions for detector spans
    const { lineNumber, charIndex: startCharIndex } = getLineAndCharIndex(input, r.span.start);
    const { charIndex: endCharIndex } = getLineAndCharIndex(input, r.span.end - 1);
    recordMatch(stats, r.ruleId, r.match, r.replacement, currentPath, lineNumber, startCharIndex, endCharIndex);
  }

  // Apply replacements in descending order to avoid index shifting
  let result = input;
  for (const r of replacements.reverse()) {
    result = result.slice(0, r.span.start) + r.replacement + result.slice(r.span.end);
  }

  return result;
}

/**
 * Walk a JSON value and apply detector-based redaction to string leaves.
 * Returns the redacted value and optionally runs rule-based redaction as well.
 */
async function redactWithDetector(
  value: unknown,
  policy: CompiledPolicy,
  detector: Detector,
  detectorMode: DetectorMode,
  stats: ReturnType<typeof createStats>,
  currentPath: string[] = [],
  map: ReplacementMap | null = null,
  feedbackStore: FeedbackStore | null = null,
): Promise<unknown> {
  // Temporary debug logging (enabled via REDACT_DEBUG=true)
  const DEBUG_REDACT = process.env.REDACT_DEBUG === "true";
  const pathStr = currentPath.join(".");

  // DEBUG: Log top-level keys on first call
  if (currentPath.length === 0 && DEBUG_REDACT) {
    if (value && typeof value === "object" && !Array.isArray(value)) {
      console.error(`[redact-debug] Top-level keys:`, Object.keys(value as Record<string, unknown>));
    }
  }
  
  // DEBUG: Log path being visited
  if (DEBUG_REDACT && currentPath.length > 0) {
    console.error(`[redact-debug] Visiting path: ${currentPath.join(".")}`);
  }

  // Check if this path should be skipped entirely (before any traversal)
  if (currentPath.length > 0 && (policy.paths.only !== null || policy.paths.skip.length > 0)) {
    const { shouldSkipPath } = await import("./redact.js");
    if (shouldSkipPath(currentPath, policy.paths.only, policy.paths.skip)) {
      if (DEBUG_REDACT) {
        console.error(`[redact-debug] SKIPPED TRAVERSAL: ${pathStr}`);
      }
      return value;
    }
  }

  if (typeof value === "string") {
    // Check path filtering
    if (policy.paths.only !== null || policy.paths.skip.length > 0) {
      const { shouldRedactPath } = await import("./redact.js");
      const shouldRedact = shouldRedactPath(currentPath, policy.paths.only, policy.paths.skip);
      if (DEBUG_REDACT) {
        console.error(`[redact-debug] path="${pathStr}" value="${value.substring(0, 100)}" only=${policy.paths.only?.map(p=>p.source).join(",")} skip_count=${policy.paths.skip.length} -> shouldRedact=${shouldRedact}`);
      }
      if (!shouldRedact) {
        if (DEBUG_REDACT) console.error(`[redact-debug] SKIPPED (path filtered): ${pathStr}`);
        return value;
      }
    }

    // Run detector on this string
    const detectionResult = await detector.detect(value);
    let redacted = value;

    // Apply detector spans
    if (detectionResult.spans.length > 0) {
      if (DEBUG_REDACT) {
        console.error(`[redact-debug] DETECTOR MATCHES at ${pathStr}:`, detectionResult.spans.map(s => `${s.label}:${s.text.substring(0, 30)}@${s.start}-${s.end} (${s.score.toFixed(3)})`));
      }
      redacted = await applyDetectorSpans(
        value,
        detectionResult.spans,
        stats,
        map,
        policy.placeholderAllowlist,
        currentPath,
        feedbackStore,
      );
    }

    // In hybrid and auto modes, also apply rule-based redaction
    if (detectorMode === "hybrid" || detectorMode === "auto") {
      const { redactString, shouldRedactPath } = await import("./redact.js");
      // Check path filtering
      if (policy.paths.only !== null || policy.paths.skip.length > 0) {
        const shouldRedact = shouldRedactPath(currentPath, policy.paths.only, policy.paths.skip);
        if (!shouldRedact) {
          if (DEBUG_REDACT) console.error(`[redact-debug] SKIPPED (hybrid path filtered): ${pathStr}`);
          return value;
        }
      }
      redacted = await redactString(
        redacted,
        policy.rules,
        policy.allowlist.strings,
        policy.allowlist.patterns,
        policy.placeholderAllowlist,
        stats,
        map,
        currentPath,
        feedbackStore,
      );
    }

    return redacted;
  }

  if (Array.isArray(value)) {
    return Promise.all(value.map((item) =>
      redactWithDetector(item, policy, detector, detectorMode, stats, [...currentPath, "*"], map, feedbackStore)
    ));
  }

  if (value !== null && typeof value === "object") {
    const result: Record<string, unknown> = {};
    for (const [key, val] of Object.entries(value as Record<string, unknown>)) {
      result[key] = await redactWithDetector(val, policy, detector, detectorMode, stats, [...currentPath, key], map, feedbackStore);
    }
    return result;
  }

  return value;
}

/** Resolve effective policy: explicit policy > policy file > preset (default: "pii"). */
function resolvePolicy(config?: RedactPluginConfig): CompiledPolicy {
  const disabledRules = new Set(config?.disabledRules ?? []);

  function filterDisabledRules(policy: CompiledPolicy): CompiledPolicy {
    if (disabledRules.size === 0) return policy;
    return {
      ...policy,
      rules: policy.rules.filter((rule) => !disabledRules.has(rule.name)),
    };
  }

  if (config?.policy) return filterDisabledRules(config.policy);
  if (config?.policyFile) {
    const loaded = loadPolicyFile(config.policyFile);
    if (loaded) {
      // Merge paths from config with policy file paths (config takes precedence)
      if (config.paths) {
        return filterDisabledRules(mergePathsIntoPolicy(loaded, config.paths));
      }
      // Apply default paths if not specified in config or policy file
      return filterDisabledRules(mergePathsIntoPolicy(loaded, {
        only: DEFAULT_REDACT_ONLY_PATHS,
        skip: DEFAULT_REDACT_SKIP_PATHS,
      }));
    }
    // Fall through to preset if policy file doesn't exist
  }
  const presetPolicy = fromPreset(config?.preset ?? "pii");
  // Apply paths from config to preset policy
  if (config?.paths) {
    return filterDisabledRules(mergePathsIntoPolicy(presetPolicy, config.paths));
  }
  // Apply default paths
  return filterDisabledRules(mergePathsIntoPolicy(presetPolicy, {
    only: DEFAULT_REDACT_ONLY_PATHS,
    skip: DEFAULT_REDACT_SKIP_PATHS,
  }));
}

/**
 * Merge paths configuration into a compiled policy.
 * Config paths take precedence over policy file paths.
* For skip paths, we combine both (union) to ensure defaults are always applied.
 */
function mergePathsIntoPolicy(policy: CompiledPolicy, paths: { only?: string[]; skip?: string[] }): CompiledPolicy {
  const pathsOnly = paths.only
    ? paths.only.map(parsePath)
    : policy.paths.only; // Keep existing if not specified in config
  
// For skip paths, combine policy file skip with config/default skip
  // This ensures defaults like tool_calls are always skipped
  const policySkip = policy.paths.skip ?? [];
  const configSkip = paths.skip
    ? paths.skip.map(parsePath)
    : [];
  
  // Combine and deduplicate by source string
  const allSkipPaths: PathMatcher[] = [...policySkip, ...configSkip];
  const seen = new Set<string>();
  const pathsSkip: PathMatcher[] = [];
  for (const p of allSkipPaths) {
    const key = p.source;
    if (!seen.has(key)) {
      seen.add(key);
      pathsSkip.push(p);
    }
  }
  
  return {
    ...policy,
    paths: { only: pathsOnly, skip: pathsSkip },
  };
}

/** Load detector config from policy file or plugin config. */
function resolveDetectorConfig(config?: RedactPluginConfig): RedactDetectorConfig | undefined {
  // Start with plugin config
  const detectorConfig = config?.detectorConfig ?? {};

  // If policy file has detector settings, merge them (plugin config takes precedence)
  if (config?.policyFile) {
    try {
      const raw = fs.readFileSync(config.policyFile, "utf8");
      const cleaned = raw.replace(/^\s*\/\/.*$/gm, "").replace(/,\s*([\]}])/g, "$1");
      const json = JSON.parse(cleaned) as PolicyJson & { detector?: RedactDetectorConfig & { threshold?: number; labels?: string[] } };
      if (json.detector) {
        const policyDetector = json.detector;
        // Merge: plugin config values override policy file values
        // Map policy file field names to RedactDetectorConfig field names
        return {
          mode: policyDetector.mode,
          llmModel: policyDetector.llmModel,
          modelName: policyDetector.modelName,
          options: policyDetector.options,
          llmThreshold: policyDetector.llmThreshold ?? policyDetector.threshold,
          llmLabels: policyDetector.llmLabels ?? policyDetector.labels,
          ...detectorConfig,
        } as RedactDetectorConfig;
      }
    } catch {
      // Ignore policy file read/parse errors
    }
  }
  return Object.keys(detectorConfig).length > 0 ? detectorConfig : undefined;
}

const DEFAULT_SESSION_TTL_MS = 30 * 60 * 1000; // 30 minutes

/**
 * Create a redact plugin.
 *
 * The plugin's onRequest hook walks the JSON request body and applies
 * the policy's redaction rules. The body sent to the upstream provider
 * will have sensitive data replaced with placeholder tokens.
 *
 * When `reversible` is true, the plugin also hooks onResponse and
 * onStreamChunk to replace placeholders back with the original values.
 * Each session (identified by the session ID in the URL path) gets its
 * own replacement map.
 */
export function createRedactPlugin(config?: RedactPluginConfig): RedactPlugin {
  const policy = resolvePolicy(config);
  const verbose = config?.verbose ?? false;
  const reversible = config?.reversible ?? false;
  const sessionTtlMs = config?.sessionTtlMs ?? DEFAULT_SESSION_TTL_MS;
  const disabledProviders = config?.disabledProviders;

  if (process.env.REDACT_DEBUG === "true") {
    console.error(`[redact] Plugin created with disabledProviders=${JSON.stringify(disabledProviders)}, preset=${config?.preset}, reversible=${reversible}`);
  }

  // Per-session state (only used in reversible mode)
  const sessions = new Map<string, SessionState>();
  let lastEviction = Date.now();

  /**
   * Get or create session state. Uses "__default__" for requests
   * without a session ID. Also evicts stale sessions periodically
   * (at most once per minute) to prevent unbounded memory growth.
   */
  function getSession(sessionId: string | null): SessionState {
    const key = sessionId ?? "__default__";
    let state = sessions.get(key);
    if (!state) {
      const map = new ReplacementMap();
      state = {
        map,
        rehydrator: createStreamRehydrator(map),
        lastSeen: Date.now(),
      };
      sessions.set(key, state);
    }
    state.lastSeen = Date.now();

    // Evict stale sessions periodically (at most once per minute)
    const now = Date.now();
    if (now - lastEviction > 60_000) {
      lastEviction = now;
      for (const [k, s] of sessions) {
        if (now - s.lastSeen > sessionTtlMs) {
          sessions.delete(k);
          if (verbose) {
            console.error(
              `[redact] Evicted idle session ${k} (${s.map.size} mapping(s))`,
            );
          }
        }
      }
    }

    return state;
  }

  // Detector pipeline state (lazy initialized)
  const detectorState: DetectorState = {
    pipeline: null,
    initialized: false,
    initializing: null,
  };

  // Create or use provided FeedbackStore for false positive filtering
  // String shorthand "sqlite"/"memory" auto-creates a store; null disables filtering; undefined uses default (no filtering)
  const feedbackStore: FeedbackStore | undefined =
    config?.feedbackStore !== undefined
      ? typeof config.feedbackStore === "string"
        ? createFeedbackStore(config.feedbackStore)
        : config.feedbackStore
      : undefined;

  // Resolve detector config: plugin config overrides policy file config
  const resolvedDetectorConfig = resolveDetectorConfig(config);
  const detectorMode = resolvedDetectorConfig?.mode ?? config?.detectorMode ?? "rules";
  const detectorConfig = resolvedDetectorConfig ?? {};

  /**
   * Map rule name to Presidio EntityType if the rule covers the same entity.
   * This is used to disable overlapping Presidio recognizers when policy rules
   * already cover the same entity types.
   */
  function getPresidioEntityTypesFromRules(rules: RedactionRule[]): Set<EntityType> {
    const ruleNameToEntityType: Record<string, EntityType> = {
      "email": EntityType.EMAIL_ADDRESS,
      "ssn": EntityType.US_SSN,
      "credit-card": EntityType.CREDIT_CARD,
      "phone-us": EntityType.PHONE_NUMBER,
      "phone-eu": EntityType.PHONE_NUMBER,
      "ipv4": EntityType.IP_ADDRESS,
      "ipv6": EntityType.IP_ADDRESS,
      "date-of-birth": EntityType.DATE_TIME,
    };
    const entityTypes = new Set<EntityType>();
    for (const rule of rules) {
      const entityType = ruleNameToEntityType[rule.name];
      if (entityType) {
        entityTypes.add(entityType);
      }
    }
    return entityTypes;
  }

  /**
   * Map disabled rule names to Presidio EntityType.
   * This covers LLM-only entity types that don't have corresponding policy rules
   * (e.g., "url", "organization", "person", "location").
   */
  function getPresidioEntityTypesFromDisabledRules(disabledRules: string[]): Set<EntityType> {
    const disabledRuleNameToEntityType: Record<string, EntityType> = {
      "url": EntityType.URL,
      "organization": EntityType.ORGANIZATION,
      "person": EntityType.PERSON,
      "location": EntityType.LOCATION,
      "email": EntityType.EMAIL_ADDRESS,
      "phone": EntityType.PHONE_NUMBER,
      "credit-card": EntityType.CREDIT_CARD,
      "ssn": EntityType.US_SSN,
      "ip": EntityType.IP_ADDRESS,
      "date": EntityType.DATE_TIME,
    };
    const entityTypes = new Set<EntityType>();
    for (const ruleName of disabledRules) {
      const entityType = disabledRuleNameToEntityType[ruleName.toLowerCase()];
      if (entityType) {
        entityTypes.add(entityType);
      }
    }
    return entityTypes;
  }

  /**
   * Initialize the detector pipeline based on detectorMode and detectorConfig.
   * Called lazily on first request that needs it.
   */
  async function ensureDetectorInitialized(): Promise<Detector | null> {
    if (detectorMode === "rules") return null;
    if (detectorState.initialized) return detectorState.pipeline;
    if (detectorState.initializing) {
      await detectorState.initializing;
      return detectorState.pipeline;
    }

    detectorState.initializing = (async () => {
      try {
        // Create rule detector
        const ruleDetector = await createRuleDetector({
          name: "rules",
          rules: policy.rules,
          allowlistStrings: Array.from(policy.allowlist.strings),
          allowlistPatterns: Array.from(policy.allowlist.patterns).map((r) => r.source),
          placeholderAllowlist: Array.from(policy.placeholderAllowlist),
          feedbackStore,
        });

        // Determine which Presidio entity types are already covered by policy rules.
        // We'll exclude these from the Presidio detector to avoid duplicate detection
        // and conflicting patterns (policy rules use context-gating; Presidio doesn't).
        const coveredEntityTypes = getPresidioEntityTypesFromRules(policy.rules);

        // Also get entity types from disabled rules (LLM-only types like "url", "organization")
        const disabledRules = config?.disabledRules ?? [];
        const disabledEntityTypes = getPresidioEntityTypesFromDisabledRules(disabledRules);

        // Compute effective labels for Presidio: explicit config labels minus covered types
        // If user explicitly specifies llmLabels, respect that but still filter covered types.
        // If no explicit labels, Presidio will use all supported types minus covered types.
        function computePresidioLabels(explicitLabels?: string[]): string[] | undefined {
          // Get all supported Presidio entity type labels
          const allSupportedLabels = [
            EntityType.PERSON,
            EntityType.LOCATION,
            EntityType.ORGANIZATION,
            EntityType.EMAIL_ADDRESS,
            EntityType.PHONE_NUMBER,
            EntityType.CREDIT_CARD,
            EntityType.US_SSN,
            EntityType.IP_ADDRESS,
            EntityType.URL,
            EntityType.DATE_TIME,
          ];

          // Start with explicit labels or all supported
          const labelsToUse = explicitLabels && explicitLabels.length > 0
            ? explicitLabels
            : allSupportedLabels;

          // Filter out covered entity types (but only if user didn't explicitly request them)
          // Map entity types to their string labels for comparison
          const entityTypeToLabel: Record<EntityType, string> = {
            [EntityType.PERSON]: "PERSON",
            [EntityType.LOCATION]: "LOCATION",
            [EntityType.ORGANIZATION]: "ORGANIZATION",
            [EntityType.EMAIL_ADDRESS]: "EMAIL_ADDRESS",
            [EntityType.PHONE_NUMBER]: "PHONE_NUMBER",
            [EntityType.CREDIT_CARD]: "CREDIT_CARD",
            [EntityType.US_SSN]: "US_SSN",
            [EntityType.IP_ADDRESS]: "IP_ADDRESS",
            [EntityType.URL]: "URL",
            [EntityType.DATE_TIME]: "DATE_TIME",
          };

          const coveredLabels = new Set<string>();
          for (const et of coveredEntityTypes) {
            coveredLabels.add(entityTypeToLabel[et]);
          }
          // Also add entity types from disabled rules
          for (const et of disabledEntityTypes) {
            coveredLabels.add(entityTypeToLabel[et]);
          }
          // Also add common aliases that Presidio might use
          const aliasMap: Record<string, string> = {
            "EMAIL": "EMAIL_ADDRESS",
            "PHONE": "PHONE_NUMBER",
            "SSN": "US_SSN",
            "IP": "IP_ADDRESS",
            "DATE": "DATE_TIME",
            "DATETIME": "DATE_TIME",
          };
          for (const [alias, canonical] of Object.entries(aliasMap)) {
            if (coveredLabels.has(canonical)) {
              coveredLabels.add(alias);
            }
          }

          const filtered = labelsToUse.filter((label) => !coveredLabels.has(label.toUpperCase()));
          if (verbose && filtered.length < labelsToUse.length) {
            const removed = labelsToUse.filter((label) => coveredLabels.has(label.toUpperCase()));
            console.error(`[redact] Disabled Presidio recognizers (covered by policy rules or disabled in settings): ${removed.join(", ")}`);
          }
          return filtered.length > 0 ? filtered : undefined;
        }

        let pipeline: Detector;

        if (detectorMode === "llm") {
          // LLM-only mode: use Presidio TS detector
          const presidioConfig = detectorConfig as RedactDetectorConfig;
          const modelName = presidioConfig.modelName ?? "Xenova/bert-base-NER";
          const presidioLabels = computePresidioLabels(presidioConfig.llmLabels);
          const llmDetector = await createPresidioTsDetector({
            name: "presidio-ts",
            modelName,
            threshold: presidioConfig.llmThreshold ?? 0.5,
            labels: presidioLabels,
            options: presidioConfig.options,
            allowlistPatterns: policy.allowlist.patterns,
            feedbackStore,
          });
          pipeline = await createDetectorPipeline({
            detectors: [llmDetector],
            mergeStrategy: "union",
          });
        } else if (detectorMode === "hybrid" || detectorMode === "auto") {
          // Hybrid mode: rules + Presidio TS with priority merge
          const presidioConfig = detectorConfig as RedactDetectorConfig;
          let llmDetector: Detector | null = null;
          const modelName = presidioConfig.modelName ?? "Xenova/bert-base-NER";
          const presidioLabels = computePresidioLabels(presidioConfig.llmLabels);
          llmDetector = await createPresidioTsDetector({
            name: "presidio-ts",
            modelName,
            threshold: presidioConfig.llmThreshold ?? 0.5,
            labels: presidioLabels,
            options: presidioConfig.options,
            allowlistPatterns: policy.allowlist.patterns,
            feedbackStore,
          });

          // In auto mode, we still use hybrid but could add logic to skip LLM for simple cases
          if (llmDetector) {
            const pipelineConfig = createHybridDetector(ruleDetector, llmDetector, {
              priorityOrder: ["rules", "presidio-ts"],
            });
            pipeline = await createDetectorPipeline(pipelineConfig);
          } else {
            // Fall back to rules-only
            pipeline = ruleDetector;
          }
        } else {
          // Default to rules only
          pipeline = ruleDetector;
        }

        detectorState.pipeline = pipeline;
        detectorState.initialized = true;
        if (verbose) {
          console.error(`[redact] Initialized detector pipeline (mode: ${detectorMode})`);
        }
      } catch (err) {
        console.error(`[redact] Failed to initialize detector pipeline:`, err);
        detectorState.pipeline = null;
        // Return null to allow fall-through to rule-based redaction
      } finally {
        detectorState.initializing = null;
      }
    })();

    await detectorState.initializing;
    return detectorState.pipeline;
  }

  return {
    name: "redact",

  async onRequest(ctx: RequestContext): Promise<RequestContext> {
    if (!ctx.body) return ctx;

    // Skip redaction if the provider is in the disabled list
    if (disabledProviders && ctx.provider && disabledProviders.includes(ctx.provider as Provider)) {
      if (verbose || process.env.REDACT_DEBUG === "true") {
        const sid = ctx.sessionId ? ` [${ctx.sessionId}]` : "";
        console.error(`[redact]${sid} Skipping redaction for disabled provider: ${ctx.provider}`);
      }
      return ctx;
    }

    if (process.env.REDACT_DEBUG === "true") {
      const sid = ctx.sessionId ? ` [${ctx.sessionId}]` : "";
      console.error(`[redact]${sid} Provider check: ctx.provider="${ctx.provider}", disabledProviders=${JSON.stringify(disabledProviders)}, match=${disabledProviders?.includes(ctx.provider as Provider)}`);
    }

    const map = reversible ? getSession(ctx.sessionId).map : null;
    const stats = createStats();

    // Helper to run post-redaction logic shared by both detector and rule paths
    async function finalizeRedaction(
      redacted: unknown,
      map: ReplacementMap | null,
      stats: ReturnType<typeof createStats>,
    ): Promise<RequestContext> {
      // Reset stream rehydrator for this session (new response coming)
      if (reversible) {
        const session = getSession(ctx.sessionId);
        session.rehydrator = createStreamRehydrator(session.map);
      }

      // Call onRedactionMetadata callback if configured
      if (config?.onRedactionMetadata && ctx.captureId) {
        const metadata = buildFullRedactionMetadata(ctx.captureId, {
          provider: ctx.provider,
          sessionId: ctx.sessionId,
          targetUrl: ctx.targetUrl,
          source: ctx.source,
        }, stats);
        config.onRedactionMetadata(metadata);
      }

      if (stats.totalReplacements > 0 && verbose) {
        const details = Object.entries(stats.byRule)
          .map(([name, count]) => `${name}=${count}`)
          .join(", ");
        const sid = ctx.sessionId ? ` [${ctx.sessionId}]` : "";
        console.error(
          `[redact]${sid} Redacted ${stats.totalReplacements} match(es): ${details}`,
        );
        if (map) {
          console.error(
            `[redact]${sid} Tracking ${map.size} unique value(s) for rehydration`,
          );
        }
      }

      return {
        ...ctx,
        redactionStats: buildRedactMetaPayload(stats),
        body: redacted as Record<string, any>,
      };
    }

    // Check if we should use detector-based redaction
    if (detectorMode !== "rules") {
      const detector = await ensureDetectorInitialized();
      if (detector) {
        const redacted = await redactWithDetector(ctx.body, policy, detector, detectorMode, stats, [], map, feedbackStore);
        return finalizeRedaction(redacted, map, stats);
      }
      // Fall through to rule-based if detector initialization failed
    }

    // Rule-based redaction (default)
    const redacted = await redactWithPolicy(ctx.body, policy, stats, [], map, feedbackStore);
    return finalizeRedaction(redacted, map, stats);
  },

    // Rehydrate placeholders in non-streaming responses.
    onResponse: reversible
      ? (ctx: ResponseContext): ResponseContext => {
          const session = getSession(ctx.sessionId);
          if (session.map.size === 0) return ctx;

          const rehydrated = session.map.rehydrate(ctx.body);
          if (rehydrated === ctx.body) return ctx;

          if (verbose) {
            const sid = ctx.sessionId ? ` [${ctx.sessionId}]` : "";
            console.error(
              `[redact]${sid} Rehydrated response (${session.map.size} mapping(s) active)`,
            );
          }

          return { ...ctx, body: rehydrated };
        }
      : undefined,

    // Rehydrate placeholders in streaming SSE chunks.
    onStreamChunk: reversible
      ? (chunk: Buffer, sessionId: string | null): Buffer => {
          const session = getSession(sessionId);
          if (session.map.size === 0) return chunk;
          return session.rehydrator.onChunk(chunk);
        }
      : undefined,

    // Flush any buffered partial placeholder at end of stream.
    onStreamEnd: reversible
      ? (sessionId: string | null): Buffer | null => {
          const session = getSession(sessionId);
          return session.rehydrator.onEnd();
        }
      : undefined,

    shutdown() {
      // Shut down detector pipeline if initialized
      if (detectorState.pipeline) {
        detectorState.pipeline.shutdown().catch((err) => {
          console.error("[redact] Detector pipeline shutdown error:", err);
        });
        detectorState.pipeline = null;
        detectorState.initialized = false;
      }
      // Clear all session state
      sessions.clear();
      if (verbose) {
        console.error("[redact] Plugin shutdown complete");
      }
    },

    /**
     * Report a false positive to the feedback store.
     * This allows users to mark incorrectly redacted values so they won't be redacted in the future.
     * @param params - Object containing the false positive details
     * @param params.value - The original value that was incorrectly redacted
     * @param params.ruleId - The rule ID that triggered the false positive
     * @param params.label - The label/category of the detection (e.g., "EMAIL", "PHONE", "CREDIT_CARD")
     * @param params.path - The JSON path where the value was found (e.g., "$.messages[0].content")
     * @param params.sessionId - Optional session ID for scoping
     * @param params.matchMode - How to match this entry: 'exact' or 'pattern' (default: 'exact')
     * @returns The created false positive entry
     */
    async reportFalsePositive(params: {
      value: string;
      ruleId: string;
      label: string;
      path: string;
      sessionId?: string;
      matchMode?: "exact" | "pattern";
    }): Promise<FalsePositiveEntry> {
      if (!feedbackStore) {
        throw new Error("Feedback store not configured. Set feedbackStore in RedactPluginConfig to enable false positive reporting.");
      }
      return feedbackStore.recordFalsePositive({
        value: params.value,
        ruleId: params.ruleId,
        label: params.label,
        path: params.path,
        timestamp: Date.now(),
        sessionId: params.sessionId,
        matchMode: params.matchMode ?? "exact",
      });
    },

    /**
     * Get the feedback store instance for direct access.
     * @returns The FeedbackStore instance, or undefined if not configured
     */
    getFeedbackStore(): FeedbackStore | undefined {
      return feedbackStore;
    },
  };
}

// Public API
export type { RedactionRule } from "./rules.js";
export type { PresetName } from "./presets.js";
export { PRESETS, getAllPlaceholderTokens, getPlaceholderPatterns } from "./presets.js";
export type { PolicyJson, PolicyRuleJson, CompiledPolicy } from "./policy.js";
export { compilePolicy, loadPolicyFile, fromPreset } from "./policy.js";
export type { RedactionStats, RedactionMetadata, MatchEntry } from "./redact.js";
export { redactWithPolicy, redactValue, createStats, redactString, buildFullRedactionMetadata } from "./redact.js";
export type { MappingEntry } from "./mapping.js";
export { ReplacementMap } from "./mapping.js";

// Feedback API
export type { RedactPlugin };
export type {
	FalsePositiveEntry,
	MatchMode,
	FeedbackStore,
} from "./feedback.js";
export {
	SqliteFeedbackStore,
	MemoryFeedbackStore,
	createFeedbackStore,
	generatePatternFromValue,
} from "./feedback.js";

// Detector API
export type {
  Detector,
  DetectorConfig,
  DetectionResult,
  DetectedSpan,
  DetectorMode,
  RedactDetectorConfig,
  DetectorPipelineConfig,
  DetectorFactory,
} from "./detector.js";
export { detectorRegistry, registerDetector, createDetector } from "./detector.js";
export type { RuleDetectorConfig } from "./ruleDetector.js";
export { RuleDetector, createRuleDetector } from "./ruleDetector.js";
export type { PresidioTsConfig } from "./presidioTsDetector.js";
export { PresidioTsDetector, createPresidioTsDetector } from "./presidioTsDetector.js";

export { DetectorPipeline, createDetectorPipeline, createHybridDetector, mergeDetectionResults } from "./detectorPipeline.js";
export { createRedactPluginFactory } from "./factory.js";
