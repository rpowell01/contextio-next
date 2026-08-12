/**
 * Detector interface for PII/secret detection.
 *
 * This interface abstracts the detection mechanism, allowing pluggable
 * implementations (rule-based, LLM-based, hybrid, external API).
 *
 * Each detector receives a string and returns an array of detected spans
 * with metadata for redaction.
 */

import type { RedactionRule } from "./rules.js";

/**
 * A detected entity span in text.
 */
export interface DetectedSpan {
  /** The matched text. */
  text: string;
  /** Start index in the original text (inclusive). */
  start: number;
  /** End index in the original text (exclusive). */
  end: number;
  /** Entity type/label (e.g., "EMAIL", "PERSON", "SSN"). */
  label: string;
  /** Confidence score [0, 1]. */
  score: number;
  /** The rule or detector that made this detection. */
  detectorName: string;
}

/**
 * Configuration for a detector.
 */
export interface DetectorConfig {
  /** Unique name for this detector instance. */
  name: string;
  /** Minimum confidence threshold for detections. Default: 0.5. */
  threshold?: number;
  /** Entity labels this detector should look for. If empty, detects all. */
  labels?: string[];
  /** Additional detector-specific options. */
  options?: Record<string, unknown>;
}

/**
 * Result of a detection pass.
 */
export interface DetectionResult {
  /** All detected spans, sorted by start position. */
  spans: DetectedSpan[];
  /** Time taken in milliseconds. */
  latencyMs: number;
  /** Any warnings or info messages. */
  warnings?: string[];
}

/**
 * Base interface for all detectors.
 *
 * Detectors can be:
 * - Rule-based (regex patterns)
 * - LLM-based (Presidio TS, DistilBERT, Phi-3-mini via ONNX/llama.cpp)
 * - External API (cloud PII detection services)
 * - Hybrid (combination of above)
 */
export interface Detector {
  /** Unique detector identifier. */
  readonly name: string;

  /** Human-readable description. */
  readonly description: string;

  /** Supported entity labels. Empty means all. */
  readonly labels: readonly string[];

  /**
   * Initialize the detector (load model, connect to service, etc.).
   * Called once before first use.
   */
  initialize(config?: DetectorConfig): Promise<void>;

  /**
   * Detect PII/entities in text.
   *
   * @param text - Input text to analyze
   * @param config - Optional runtime configuration override
   * @returns Detected spans with confidence scores
   */
  detect(text: string, config?: DetectorConfig): Promise<DetectionResult>;

  /**
   * Check if detector is ready.
   */
  isReady(): boolean;

  /**
   * Clean up resources (unload model, close connections).
   */
  shutdown(): Promise<void>;
}

/**
 * Configuration for a pipeline of detectors.
 */
export interface DetectorPipelineConfig {
  /** Detectors to run in sequence. */
  detectors: Detector[];
  /** How to combine results from multiple detectors. */
  mergeStrategy: "union" | "intersection" | "priority";
  /** For "priority" strategy: priority order (first = highest). */
  priorityOrder?: string[];
  /** Per-detector threshold overrides. */
  thresholds?: Record<string, number>;
}

/**
 * Union type for detector mode configuration.
 */
export type DetectorMode = "rules" | "llm" | "hybrid" | "auto";

export interface RedactDetectorConfig {
  /** Detection mode. Default: "rules". */
  mode?: DetectorMode;
  /** LLM detector model to use. Default: "Xenova/bert-base-NER". */
  llmModel?: string;
  /** HuggingFace model ID for Presidio TS (e.g., "Xenova/bert-base-NER"). Default: "Xenova/bert-base-NER". */
  modelName?: string;
  /** Custom detector instances. */
  customDetectors?: Detector[];
  /** Runtime options for the detector. */
  options?: Record<string, unknown>;
  /** Minimum confidence for LLM detections. Default: 0.5. */
  llmThreshold?: number;
  /** Entity labels for LLM detector. If empty, uses model's defaults. */
  llmLabels?: string[];
}

/**
 * Factory function type for creating detectors.
 */
export type DetectorFactory = (config: DetectorConfig) => Promise<Detector>;

/**
 * Registry of built-in detector factories.
 */
export const detectorRegistry = new Map<string, DetectorFactory>();

/**
 * Register a detector factory.
 */
export function registerDetector(name: string, factory: DetectorFactory): void {
  detectorRegistry.set(name, factory);
}

/**
 * Create a detector by name.
 */
export async function createDetector(name: string, config: DetectorConfig): Promise<Detector> {
  const factory = detectorRegistry.get(name);
  if (!factory) {
    throw new Error(`Unknown detector: ${name}. Available: ${Array.from(detectorRegistry.keys()).join(", ")}`);
  }
  const detector = await factory(config);
  await detector.initialize(config);
  return detector;
}