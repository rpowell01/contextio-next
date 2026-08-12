/**
 * Detector pipeline for combining multiple detectors.
 *
 * Supports parallel or sequential execution, configurable merge strategies,
 * and provides a unified detector interface for the redaction engine.
 */
/**
 * Pipeline that runs multiple detectors and merges their results.
 */
export class DetectorPipeline {
    name = "pipeline";
    description = "Composable detector pipeline with configurable merge strategy";
    detectors;
    pipelineConfig;
    initialized = false;
    constructor(config) {
        this.detectors = config.detectors;
        this.pipelineConfig = config;
        // Collect all unique labels
        const labelSet = new Set();
        for (const d of this.detectors) {
            for (const l of d.labels)
                labelSet.add(l);
        }
        this.labels = Array.from(labelSet);
    }
    labels;
    /** Get the detectors in this pipeline (for testing/inspection). */
    getDetectors() {
        return this.detectors;
    }
    async initialize(config) {
        if (this.initialized)
            return;
        // Initialize all detectors in parallel
        await Promise.all(this.detectors.map((d) => d.initialize(config)));
        this.initialized = true;
    }
    isReady() {
        return this.initialized && this.detectors.every((d) => d.isReady());
    }
    async shutdown() {
        await Promise.all(this.detectors.map((d) => d.shutdown()));
        this.initialized = false;
    }
    async detect(text, config) {
        const startTime = Date.now();
        if (!this.isReady()) {
            throw new Error("Detector pipeline not initialized. Call initialize() first.");
        }
        // Run all detectors in parallel
        const results = await Promise.all(this.detectors.map((d) => d.detect(text, config)));
        // Merge results
        const merged = mergeDetectionResults(results, this.pipelineConfig.mergeStrategy, this.pipelineConfig.priorityOrder);
        return {
            ...merged,
            latencyMs: Date.now() - startTime,
        };
    }
}
/**
 * Create a detector pipeline.
 */
export async function createDetectorPipeline(config) {
    const pipeline = new DetectorPipeline(config);
    await pipeline.initialize();
    return pipeline;
}
/**
 * Create a hybrid detector configuration (rules + LLM).
 *
 * In hybrid mode:
 * - Rules run first for high-confidence patterns (API keys, JWTs, private keys)
 * - LLM runs for ambiguous PII (names, addresses, context-dependent entities)
 * - Results merged with "priority" strategy (rules win on overlap)
 */
export function createHybridDetector(ruleDetector, llmDetector, options) {
    return {
        detectors: [ruleDetector, llmDetector],
        mergeStrategy: options?.mergeStrategy ?? "priority",
        priorityOrder: options?.priorityOrder ?? [ruleDetector.name, llmDetector.name],
        thresholds: options?.ruleLabels
            ? { [ruleDetector.name]: 0.95, [llmDetector.name]: 0.5 }
            : undefined,
    };
}
/**
 * Merge multiple detection results into a single result.
 *
 * Strategies:
 * - "union": Keep all unique detections, deduplicate exact overlaps
 * - "intersection": Only keep detections found by ALL detectors
 * - "priority": Apply detectors in priority order, skip overlapping lower-priority
 */
export function mergeDetectionResults(results, strategy, priorityOrder) {
    if (results.length === 0) {
        return { spans: [], latencyMs: 0 };
    }
    if (results.length === 1)
        return results[0];
    const allSpans = results.flatMap((r) => r.spans);
    let mergedSpans;
    switch (strategy) {
        case "union":
            mergedSpans = mergeUnion(allSpans);
            break;
        case "intersection":
            mergedSpans = mergeIntersection(allSpans, results.length);
            break;
        case "priority":
            mergedSpans = mergePriority(allSpans, priorityOrder ?? []);
            break;
        default:
            mergedSpans = mergeUnion(allSpans);
    }
    mergedSpans.sort((a, b) => a.start - b.start);
    const totalLatency = results.reduce((sum, r) => sum + r.latencyMs, 0);
    const warnings = results.flatMap((r) => r.warnings ?? []);
    return {
        spans: mergedSpans,
        latencyMs: totalLatency,
        warnings: warnings.length > 0 ? warnings : undefined,
    };
}
/**
 * Union merge: keep all unique detections.
 * Deduplicates spans with exact same position and label.
 */
function mergeUnion(spans) {
    const groups = new Map();
    for (const span of spans) {
        // Group by position + label for exact deduplication
        const key = `${span.start}:${span.end}:${span.label}`;
        if (!groups.has(key))
            groups.set(key, []);
        groups.get(key).push(span);
    }
    const result = [];
    for (const group of groups.values()) {
        // Keep highest confidence
        group.sort((a, b) => b.score - a.score);
        result.push(group[0]);
    }
    // Also handle near-overlaps (different labels, overlapping positions)
    return deduplicateOverlaps(result);
}
/**
 * Intersection merge: only keep detections found by all detectors.
 * Uses position overlapping with same/similar label.
 */
function mergeIntersection(spans, numDetectors) {
    // Group by approximate position
    const groups = new Map();
    for (const span of spans) {
        // Bucket by rough position (10-char granularity)
        const posKey = `${Math.floor(span.start / 10)}:${Math.floor(span.end / 10)}`;
        if (!groups.has(posKey))
            groups.set(posKey, []);
        groups.get(posKey).push(span);
    }
    const result = [];
    for (const group of groups.values()) {
        const detectorNames = new Set(group.map((s) => s.detectorName));
        if (detectorNames.size >= numDetectors) {
            // All detectors agree on this region - keep highest scoring
            group.sort((a, b) => b.score - a.score);
            result.push(group[0]);
        }
    }
    return deduplicateOverlaps(result);
}
/**
 * Priority merge: apply detectors in priority order.
 * Lower priority detections that overlap with higher priority are dropped.
 */
function mergePriority(spans, priorityOrder) {
    const priority = new Map();
    priorityOrder.forEach((name, idx) => priority.set(name, idx));
    // Sort by priority then score
    spans.sort((a, b) => {
        const pa = priority.get(a.detectorName) ?? 999;
        const pb = priority.get(b.detectorName) ?? 999;
        if (pa !== pb)
            return pa - pb;
        return b.score - a.score;
    });
    const result = [];
    for (const span of spans) {
        // Check overlap with accepted spans
        const overlaps = result.some((existing) => !(span.end <= existing.start || span.start >= existing.end));
        if (!overlaps) {
            result.push(span);
        }
    }
    result.sort((a, b) => a.start - b.start);
    return result;
}
/**
 * Remove overlapping spans, keeping highest scoring.
 */
function deduplicateOverlaps(spans) {
    if (spans.length <= 1)
        return spans;
    spans.sort((a, b) => a.start - b.start);
    const result = [spans[0]];
    for (let i = 1; i < spans.length; i++) {
        const current = spans[i];
        const last = result[result.length - 1];
        // Check for overlap
        if (current.start < last.end) {
            // Overlap - keep higher scoring
            if (current.score > last.score) {
                result[result.length - 1] = current;
            }
            // Else keep existing
        }
        else {
            result.push(current);
        }
    }
    return result;
}
/**
 * Create a pre-configured hybrid detector using rules + Presidio TS.
 * This is a convenience factory that handles model loading.
 */
export async function createDefaultHybridDetector(ruleConfig, presidioConfig) {
    const { RuleDetector, createRuleDetector } = await import("./ruleDetector.js");
    const { createPresidioTsDetector } = await import("./presidioTsDetector.js");
    // Create rule detector
    const ruleDetector = await createRuleDetector({
        name: "rules",
        rules: ruleConfig?.rules ?? [],
        allowlistStrings: ruleConfig?.allowlistStrings,
        allowlistPatterns: ruleConfig?.allowlistPatterns,
        placeholderAllowlist: ruleConfig?.placeholderAllowlist,
    });
    // Create Presidio detector
    let llmDetector = null;
    if (presidioConfig?.modelName) {
        llmDetector = await createPresidioTsDetector({
            name: "presidio-ts",
            modelName: presidioConfig.modelName,
            threshold: presidioConfig.threshold ?? 0.5,
            labels: presidioConfig.labels,
            useNER: presidioConfig.useNER ?? true,
            options: presidioConfig.options,
        });
    }
    const detectors = llmDetector ? [ruleDetector, llmDetector] : [ruleDetector];
    const pipeline = new DetectorPipeline({
        detectors,
        mergeStrategy: "priority",
        priorityOrder: ["presidio-ts", "rules"].filter((n) => detectors.some((d) => d.name === n)),
    });
    await pipeline.initialize();
    return pipeline;
}
//# sourceMappingURL=detectorPipeline.js.map