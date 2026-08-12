/**
 * Detector pipeline for combining multiple detectors.
 *
 * Supports parallel or sequential execution, configurable merge strategies,
 * and provides a unified detector interface for the redaction engine.
 */
import type { Detector, DetectorConfig, DetectionResult, DetectorPipelineConfig } from "./detector.js";
/**
 * Pipeline that runs multiple detectors and merges their results.
 */
export declare class DetectorPipeline implements Detector {
    readonly name = "pipeline";
    readonly description = "Composable detector pipeline with configurable merge strategy";
    private detectors;
    private pipelineConfig;
    private initialized;
    constructor(config: DetectorPipelineConfig);
    readonly labels: readonly string[];
    /** Get the detectors in this pipeline (for testing/inspection). */
    getDetectors(): readonly Detector[];
    initialize(config?: DetectorConfig): Promise<void>;
    isReady(): boolean;
    shutdown(): Promise<void>;
    detect(text: string, config?: DetectorConfig): Promise<DetectionResult>;
}
/**
 * Create a detector pipeline.
 */
export declare function createDetectorPipeline(config: DetectorPipelineConfig): Promise<DetectorPipeline>;
/**
 * Create a hybrid detector configuration (rules + LLM).
 *
 * In hybrid mode:
 * - Rules run first for high-confidence patterns (API keys, JWTs, private keys)
 * - LLM runs for ambiguous PII (names, addresses, context-dependent entities)
 * - Results merged with "priority" strategy (rules win on overlap)
 */
export declare function createHybridDetector(ruleDetector: Detector, llmDetector: Detector, options?: {
    mergeStrategy?: "union" | "intersection" | "priority";
    priorityOrder?: string[];
    ruleLabels?: string[];
    llmLabels?: string[];
}): DetectorPipelineConfig;
/**
 * Merge multiple detection results into a single result.
 *
 * Strategies:
 * - "union": Keep all unique detections, deduplicate exact overlaps
 * - "intersection": Only keep detections found by ALL detectors
 * - "priority": Apply detectors in priority order, skip overlapping lower-priority
 */
export declare function mergeDetectionResults(results: DetectionResult[], strategy: "union" | "intersection" | "priority", priorityOrder?: string[]): DetectionResult;
/**
 * Create a pre-configured hybrid detector using rules + Presidio TS.
 * This is a convenience factory that handles model loading.
 */
export declare function createDefaultHybridDetector(ruleConfig?: {
    rules?: import("./rules.js").RedactionRule[];
    allowlistStrings?: string[];
    allowlistPatterns?: string[];
    placeholderAllowlist?: string[];
}, presidioConfig?: {
    modelName?: string;
    threshold?: number;
    labels?: string[];
    useNER?: boolean;
    options?: Record<string, unknown>;
}): Promise<DetectorPipeline>;
//# sourceMappingURL=detectorPipeline.d.ts.map