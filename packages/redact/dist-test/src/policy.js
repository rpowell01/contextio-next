/**
 * Policy system for @contextio/redact.
 *
 * A policy is a JSON document that describes what to redact and how.
 * Policies can extend built-in presets and add custom rules.
 *
 * Policy JSON format:
 * {
 *   "extends": "secrets",           // built-in preset: "secrets" | "pii" | "strict"
 *   "rules": [                      // additional rules (merged with preset)
 *     {
 *       "id": "employee-id",
 *       "pattern": "EMP-\\d{5}",
 *       "replacement": "[EMPLOYEE_ID]",
 *       "context": ["employee", "staff"]
 *     }
 *   ],
 *   "allowlist": {
 *     "strings": ["support@company.com"],
 *     "patterns": ["test-\\d+@example\\.com"]
 *   },
 *   "paths": {
 *     "only": ["messages[*].content", "system"],
 *     "skip": ["model", "metadata"]
 *   }
 * }
 */
import fs from "node:fs";
import { PRESETS, getAllPlaceholderTokens } from "./presets.js";
// --- Compilation ---
/**
 * Strip // comments and trailing commas from JSON-with-comments.
 *
 * Not a full JSONC parser. Only handles // comments on their own lines
 * and trailing commas before } or ]. Good enough for human-written
 * config files where comments don't appear inside string values.
 */
function stripJsonComments(text) {
    // Remove single-line comments (// ...) that aren't inside strings.
    // Simple heuristic: only strip // that appears after a newline or at start,
    // with optional whitespace before it. Won't handle // inside strings perfectly,
    // but works for config files where comments are on their own lines.
    let result = text.replace(/^\s*\/\/.*$/gm, "");
    // Remove trailing commas before } or ]
    result = result.replace(/,\s*([\]}])/g, "$1");
    return result;
}
/**
 * Parse a path string into segments.
 * "messages[*].content" -> ["messages", "*", "content"]
 */
function parsePath(path) {
    const segments = path
        .replace(/\[\*\]/g, ".*.")
        .split(".")
        .filter(Boolean);
    return { source: path, segments };
}
/**
 * Compile a policy JSON rule into an internal RedactionRule.
 *
 * Patterns are always compiled with the "g" flag. If the pattern string
 * starts with `(?i)`, the "i" flag is also added (JS doesn't support
 * inline flags natively).
 */
function compileRule(json) {
    let flags = "g";
    let source = json.pattern;
    // Convert (?i) prefix to the "i" flag
    if (source.startsWith("(?i)")) {
        flags += "i";
        source = source.slice(4);
    }
    const pattern = new RegExp(source, flags);
    const rule = {
        name: json.id,
        pattern,
        replacement: json.replacement,
    };
    if (json.context && json.context.length > 0) {
        rule.context = json.context.map((w) => w.toLowerCase());
        rule.contextWindow = json.contextWindow ?? 100;
    }
    return rule;
}
/**
 * Compile a PolicyJson into a CompiledPolicy.
 *
 * If the policy extends a preset, preset rules are included first (so
 * custom rules run after built-in ones). Allowlists and path matchers
 * are compiled into their runtime forms.
 *
 * @throws If `extends` references an unknown preset name.
 */
export function compilePolicy(json) {
    // Start with preset rules if extending
    let rules = [];
    if (json.extends) {
        const preset = PRESETS[json.extends];
        if (!preset) {
            throw new Error(`Unknown preset: "${json.extends}". Available: ${Object.keys(PRESETS).join(", ")}`);
        }
        rules = [...preset];
    }
    // Append custom rules
    if (json.rules) {
        for (const r of json.rules) {
            rules.push(compileRule(r));
        }
    }
    // Compile allowlist
    const allowlistStrings = new Set(json.allowlist?.strings ?? []);
    const allowlistPatterns = (json.allowlist?.patterns ?? []).map((p) => new RegExp(p));
    // Compile paths
    const pathsOnly = json.paths?.only
        ? json.paths.only.map(parsePath)
        : null;
    const pathsSkip = (json.paths?.skip ?? []).map(parsePath);
    // Get placeholder tokens from all presets (to prevent re-redaction)
    const placeholderTokens = getAllPlaceholderTokens();
    const placeholderAllowlist = new Set(placeholderTokens);
    return {
        rules,
        allowlist: { strings: allowlistStrings, patterns: allowlistPatterns },
        placeholderAllowlist,
        paths: { only: pathsOnly, skip: pathsSkip },
    };
}
/**
 * Load a policy from a JSON file path. Supports // comments and trailing commas.
 * Returns null if the file doesn't exist or can't be read.
 */
export function loadPolicyFile(filePath) {
    try {
        const raw = fs.readFileSync(filePath, "utf8");
        const cleaned = stripJsonComments(raw);
        const json = JSON.parse(cleaned);
        return compilePolicy(json);
    }
    catch (error) {
        if (error.code === "ENOENT") {
            console.warn(`[redact] Policy file not found at ${filePath}, using preset`);
            return null;
        }
        throw error;
    }
}
/**
 * Create a compiled policy from a preset name with no customizations.
 */
export function fromPreset(preset) {
    return compilePolicy({ extends: preset });
}
//# sourceMappingURL=policy.js.map