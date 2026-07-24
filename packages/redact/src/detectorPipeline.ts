/**
 * Detector pipeline for combining multiple detectors.
 *
 * Supports parallel or sequential execution, configurable merge strategies,
 * and provides a unified detector interface for the redaction engine.
 */

import type {
  Detector,
  DetectorConfig,
  DetectionResult,
  DetectedSpan,
  DetectorPipelineConfig,
} from "./detector.js";

/**
 * Pipeline that runs multiple detectors and merges their results.
 */
export class DetectorPipeline implements Detector {
  readonly name = "pipeline";
  readonly description = "Composable detector pipeline with configurable merge strategy";

  private detectors: Detector[];
  private pipelineConfig: DetectorPipelineConfig;
  private initialized = false;

  constructor(config: DetectorPipelineConfig) {
    this.detectors = config.detectors;
    this.pipelineConfig = config;
    // Collect all unique labels
    const labelSet = new Set<string>();
    for (const d of this.detectors) {
      for (const l of d.labels) labelSet.add(l);
    }
    this.labels = Array.from(labelSet);
  }

  readonly labels: readonly string[];

  async initialize(config?: DetectorConfig): Promise<void> {
    if (this.initialized) return;

    // Initialize all detectors in parallel
    await Promise.all(
      this.detectors.map((d) => d.initialize(config)),
    );
    this.initialized = true;
  }

  isReady(): boolean {
    return this.initialized && this.detectors.every((d) => d.isReady());
  }

  async shutdown(): Promise<void> {
    await Promise.all(this.detectors.map((d) => d.shutdown()));
    this.initialized = false;
  }

  async detect(text: string, config?: DetectorConfig): Promise<DetectionResult> {
    const startTime = Date.now();

    if (!this.isReady()) {
      throw new Error("Detector pipeline not initialized. Call initialize() first.");
    }

    // Run all detectors in parallel
    const results = await Promise.all(
      this.detectors.map((d) => d.detect(text, config)),
    );

    // Merge results
    const merged = mergeDetectionResults(
      results,
      this.pipelineConfig.mergeStrategy,
      this.pipelineConfig.priorityOrder,
    );

    return {
      ...merged,
      latencyMs: Date.now() - startTime,
    };
  }
}

/**
 * Create a detector pipeline.
 */
export async function createDetectorPipeline(config: DetectorPipelineConfig): Promise<DetectorPipeline> {
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
export function createHybridDetector(
  ruleDetector: Detector,
  llmDetector: Detector,
  options?: {
    mergeStrategy?: "union" | "intersection" | "priority";
    priorityOrder?: string[];
    ruleLabels?: string[];
    llmLabels?: string[];
  },
): DetectorPipelineConfig {
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
export function mergeDetectionResults(
  results: DetectionResult[],
  strategy: "union" | "intersection" | "priority",
  priorityOrder?: string[],
): DetectionResult {
  if (results.length === 0) {
    return { spans: [], latencyMs: 0 };
  }
  if (results.length === 1) return results[0];

  const allSpans = results.flatMap((r) => r.spans);
  let mergedSpans: DetectedSpan[];

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
function mergeUnion(spans: DetectedSpan[]): DetectedSpan[] {
  const groups = new Map<string, DetectedSpan[]>();

  for (const span of spans) {
    // Group by position + label for exact deduplication
    const key = `${span.start}:${span.end}:${span.label}`;
    if (!groups.has(key)) groups.set(key, []);
    groups.get(key)!.push(span);
  }

  const result: DetectedSpan[] = [];
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
function mergeIntersection(spans: DetectedSpan[], numDetectors: number): DetectedSpan[] {
  // Group by approximate position
  const groups = new Map<string, DetectedSpan[]>();

  for (const span of spans) {
    // Bucket by rough position (10-char granularity)
    const posKey = `${Math.floor(span.start / 10)}:${Math.floor(span.end / 10)}`;
    if (!groups.has(posKey)) groups.set(posKey, []);
    groups.get(posKey)!.push(span);
  }

  const result: DetectedSpan[] = [];
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
function mergePriority(spans: DetectedSpan[], priorityOrder: string[]): DetectedSpan[] {
  const priority = new Map<string, number>();
  priorityOrder.forEach((name, idx) => priority.set(name, idx));

  // Sort by priority then score
  spans.sort((a, b) => {
    const pa = priority.get(a.detectorName) ?? 999;
    const pb = priority.get(b.detectorName) ?? 999;
    if (pa !== pb) return pa - pb;
    return b.score - a.score;
  });

  const result: DetectedSpan[] = [];
  for (const span of spans) {
    // Check overlap with accepted spans
    const overlaps = result.some(
      (existing) => !(span.end <= existing.start || span.start >= existing.end),
    );
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
function deduplicateOverlaps(spans: DetectedSpan[]): DetectedSpan[] {
  if (spans.length <= 1) return spans;

  spans.sort((a, b) => a.start - b.start);

  const result: DetectedSpan[] = [spans[0]];

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
    } else {
      result.push(current);
    }
  }

  return result;
}

/**
 * Create a pre-configured hybrid detector using rules + GLiNER ONNX.
 * This is a convenience factory that handles model loading.
 */
export async function createDefaultHybridDetector(
  ruleConfig?: {
    rules?: import("./rules.js").RedactionRule[];
    allowlistStrings?: string[];
    allowlistPatterns?: string[];
    placeholderAllowlist?: string[];
  },
  glinerConfig?: {
    modelDir: string;
    providers?: string[];
    threshold?: number;
    labels?: string[];
  },
): Promise<DetectorPipeline> {
  const { RuleDetector, createRuleDetector } = await import("./ruleDetector.js");
  const { GlinerOnnxDetector, createGlinerOnnxDetector } = await import("./glinerDetector.js");

  // Create rule detector
  const ruleDetector = await createRuleDetector({
    name: "rules",
    rules: ruleConfig?.rules ?? [],
    allowlistStrings: ruleConfig?.allowlistStrings,
    allowlistPatterns: ruleConfig?.allowlistPatterns,
    placeholderAllowlist: ruleConfig?.placeholderAllowlist,
  });

  // Create LLM detector
  let llmDetector: Detector | null = null;
  if (glinerConfig?.modelDir) {
    llmDetector = await createGlinerOnnxDetector({
      name: "gliner-onnx",
      modelDir: glinerConfig.modelDir,
      providers: glinerConfig.providers,
      threshold: glinerConfig.threshold ?? 0.5,
      labels: glinerConfig.labels,
    });
  }

  const detectors = llmDetector ? [ruleDetector, llmDetector] : [ruleDetector];

  const pipeline = new DetectorPipeline({
    detectors,
    mergeStrategy: "priority",
    priorityOrder: ["rules", "gliner-onnx"].filter((n) => detectors.some((d) => d.name === n)),
  });

  await pipeline.initialize();
  return pipeline;
}