/**
 * Rule-based detector adapter.
 *
 * Wraps the existing RedactionRule system as a Detector implementation,
 * enabling the rule engine to participate in the detector pipeline.
 */

import { shannonEntropy } from "@contextio/core";

import type { RedactionRule } from "./rules.js";
import type {
  Detector,
  DetectorConfig,
  DetectionResult,
  DetectedSpan,
} from "./detector.js";
import type { FeedbackStore } from "./feedback.js";

// --- Context word matching (duplicated from redact.ts for isolation) ---

/**
 * Check if any context word appears within `window` characters of a match.
 */
function hasContextNearby(
  text: string,
  start: number,
  end: number,
  contextWords: string[],
  window: number,
): boolean {
  const windowStart = Math.max(0, start - window);
  const windowEnd = Math.min(text.length, end + window);
  const region = text.slice(windowStart, windowEnd).toLowerCase();
  for (const word of contextWords) {
    if (region.includes(word)) return true;
  }
  return false;
}

/**
 * Check if a matched value is in the allowlist.
 */
function isAllowlisted(
  match: string,
  allowlistStrings: Set<string>,
  allowlistPatterns: RegExp[],
): boolean {
  if (allowlistStrings.has(match)) return true;
  for (const pat of allowlistPatterns) {
    pat.lastIndex = 0;
    if (pat.test(match)) return true;
  }
  return false;
}

/**
 * Check the per-rule allowlist from a CredentialPattern.
 */
function isRuleAllowlisted(fullMatch: string, capturedGroup: string | undefined, ruleAllowlist: RegExp[]): boolean {
  for (const al of ruleAllowlist) {
    al.lastIndex = 0;
    const target = al.source.startsWith("^") ? (capturedGroup ?? fullMatch) : fullMatch;
    if (al.test(target)) return true;
  }
  return false;
}

/**
 * Configuration for the rule-based detector.
 */
export interface RuleDetectorConfig extends DetectorConfig {
  /** Rules to apply. */
  rules: RedactionRule[];
  /** Exact strings that should never be flagged. */
  allowlistStrings?: string[];
  /** Regex patterns that should never be flagged. */
  allowlistPatterns?: string[];
  /** Placeholder tokens to skip (prevent re-redaction). */
  placeholderAllowlist?: string[];
  /** Optional FeedbackStore to filter out known false positives. */
  feedbackStore?: FeedbackStore;
}

/**
 * Rule-based PII/secret detector.
 *
 * Implements the Detector interface by applying RedactionRules to text.
 * This is a lightweight, fast detector with zero external dependencies.
 */
export class RuleDetector implements Detector {
  readonly name: string;
  readonly description = "Rule-based PII and secret detection using regex patterns with context gating";
  readonly labels: readonly string[];

  private rules: RedactionRule[] = [];
  private allowlistStrings = new Set<string>();
  private allowlistPatterns: RegExp[] = [];
  private placeholderAllowlist = new Set<string>();
  private initialized = false;
  private feedbackStore?: FeedbackStore;

  constructor(config?: Partial<RuleDetectorConfig>) {
    this.name = config?.name ?? "rules";
    this.feedbackStore = config?.feedbackStore;
    if (config?.rules) {
      this.rules = config.rules;
    }
    if (config?.allowlistStrings) {
      this.allowlistStrings = new Set(config.allowlistStrings);
    }
    if (config?.allowlistPatterns) {
      this.allowlistPatterns = config.allowlistPatterns.map((p) => new RegExp(p));
    }
    if (config?.placeholderAllowlist) {
      this.placeholderAllowlist = new Set(config.placeholderAllowlist);
    }
    // Extract unique labels from rules
    const labelSet = new Set<string>();
    for (const rule of this.rules) {
      // Convert rule name to label (e.g., "credential_aws_key" -> "CREDENTIAL_AWS_KEY")
      labelSet.add(rule.name.toUpperCase());
    }
    this.labels = Array.from(labelSet);
  }

  async initialize(config?: DetectorConfig): Promise<void> {
    // Merge config if provided
    const ruleConfig = config as RuleDetectorConfig | undefined;
    if (ruleConfig?.rules) {
      this.rules = ruleConfig.rules;
    }
    if (ruleConfig?.allowlistStrings) {
      this.allowlistStrings = new Set(ruleConfig.allowlistStrings);
    }
    if (ruleConfig?.allowlistPatterns) {
      this.allowlistPatterns = ruleConfig.allowlistPatterns.map((p) => new RegExp(p));
    }
    if (ruleConfig?.placeholderAllowlist) {
      this.placeholderAllowlist = new Set(ruleConfig.placeholderAllowlist);
    }
    if (ruleConfig?.feedbackStore !== undefined) {
      this.feedbackStore = ruleConfig.feedbackStore;
    }
    // Apply threshold from config
    if (ruleConfig?.threshold !== undefined) {
      this.threshold = ruleConfig.threshold;
    }
    this.initialized = true;
  }

  private threshold = 0.5;

  isReady(): boolean {
    return this.initialized;
  }

  async shutdown(): Promise<void> {
    this.rules = [];
    this.allowlistStrings.clear();
    this.allowlistPatterns = [];
    this.placeholderAllowlist.clear();
    this.initialized = false;
  }

  async detect(text: string, config?: DetectorConfig): Promise<DetectionResult> {
    const startTime = Date.now();
    const ruleConfig = config as RuleDetectorConfig | undefined;

    // Use runtime config if provided
    const rules = ruleConfig?.rules ?? this.rules;
    const allowlistStrings = ruleConfig?.allowlistStrings
      ? new Set(ruleConfig.allowlistStrings)
      : this.allowlistStrings;
    const allowlistPatterns = ruleConfig?.allowlistPatterns
      ? ruleConfig.allowlistPatterns.map((p) => new RegExp(p))
      : this.allowlistPatterns;
    const placeholderAllowlist = ruleConfig?.placeholderAllowlist
      ? new Set(ruleConfig.placeholderAllowlist)
      : this.placeholderAllowlist;
    const threshold = config?.threshold ?? this.threshold;

    // Use feedbackStore from runtime config or instance
    const feedbackStore = ruleConfig?.feedbackStore ?? this.feedbackStore;

    const spans: DetectedSpan[] = [];

    for (const rule of rules) {
      rule.pattern.lastIndex = 0;

      if (rule.context && rule.context.length > 0) {
        // Context-gated: use exec loop to check context per match
        const window = rule.contextWindow ?? 100;
        const matches: { start: number; end: number; match: string; captured: string | undefined }[] = [];
        rule.pattern.lastIndex = 0;
        let m: RegExpExecArray | null;
        while ((m = rule.pattern.exec(text)) !== null) {
          matches.push({ start: m.index, end: m.index + m[0].length, match: m[0], captured: m[1] });
        }

        // Apply filtering in order (but we collect all first to maintain indices)
        for (const { start, end, match, captured } of matches) {
          // Skip if match is a known placeholder token
          if (placeholderAllowlist.has(match)) continue;
          if (isAllowlisted(match, allowlistStrings, allowlistPatterns)) continue;
          if (rule.allowlist && isRuleAllowlisted(match, captured, rule.allowlist)) continue;
          if (rule.minEntropy !== undefined && shannonEntropy(captured ?? match) < rule.minEntropy) continue;
          if (!hasContextNearby(text, start, end, rule.context, window)) continue;

          // Rule-based detections get high confidence (0.95)
          const score = 0.95;
          if (score >= threshold) {
            spans.push({
              text: match,
              start,
              end,
              label: rule.name.toUpperCase(),
              score,
              detectorName: this.name,
            });
          }
        }
      } else {
        // No context gating: simple replace with callback
        rule.pattern.lastIndex = 0;
        text.replace(rule.pattern, (matchArg, ...args) => {
          const captured = typeof args[0] === "string" ? args[0] : undefined;
          // We can't easily get position with replace callback, so use exec
          return matchArg;
        });

        // Use exec to get positions
        rule.pattern.lastIndex = 0;
        let m: RegExpExecArray | null;
        while ((m = rule.pattern.exec(text)) !== null) {
          const match = m[0];
          const captured = m[1];
          const start = m.index;
          const end = start + match.length;

          if (placeholderAllowlist.has(match)) continue;
          if (isAllowlisted(match, allowlistStrings, allowlistPatterns)) continue;
          if (rule.allowlist && isRuleAllowlisted(match, captured, rule.allowlist)) continue;
          if (rule.minEntropy !== undefined && shannonEntropy(captured ?? match) < rule.minEntropy) continue;

          const score = 0.95;
          if (score >= threshold) {
            spans.push({
              text: match,
              start,
              end,
              label: rule.name.toUpperCase(),
              score,
              detectorName: this.name,
            });
          }
        }
      }
    }

    // Filter out known false positives using feedbackStore
    if (feedbackStore && spans.length > 0) {
      // Precompute rule lookup map keyed by uppercase rule name for O(1) lookups
      const ruleMap = new Map<string, RedactionRule>();
      for (const rule of rules) {
        ruleMap.set(rule.name.toUpperCase(), rule);
      }

      // Check all spans in parallel for false positives
      const fpChecks = spans.map(async (span) => {
        try {
          const rule = ruleMap.get(span.label);
          const ruleId = rule?.name ?? span.label.toLowerCase();
          const isFp = await feedbackStore.isFalsePositive(span.text, ruleId);
          return isFp ? null : span;
        } catch (err) {
          // Log error but don't crash the pipeline - treat as non-false-positive
          console.error(`[RuleDetector] False positive check failed for "${span.text}":`, err);
          return span;
        }
      });

      const results = await Promise.all(fpChecks);
      const filteredSpans = results.filter((span): span is DetectedSpan => span !== null);
      spans.length = 0;
      spans.push(...filteredSpans);
    }

    // Sort by start position
    spans.sort((a, b) => a.start - b.start);

    return {
      spans,
      latencyMs: Date.now() - startTime,
    };
  }
}

/**
 * Factory for creating RuleDetector instances.
 */
export async function createRuleDetector(config?: RuleDetectorConfig): Promise<RuleDetector> {
  const detector = new RuleDetector(config);
  await detector.initialize(config);
  return detector;
}