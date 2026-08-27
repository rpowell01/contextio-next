/**
 * PresidioTsDetector - PII detection using @siddicky/anonymizerts (Presidio for TypeScript).
 *
 * This detector wraps the PresidioAnalyzer from @siddicky/anonymizerts which combines:
 * - Pattern-based recognizers (regex) for structured PII (email, phone, SSN, credit card, IP, URL)
 * - NER-based recognition (transformers.js) for semantic entities (PERSON, LOCATION, ORGANIZATION, DATE_TIME)
 *
 * The first call to detect() will trigger warmup as transformers.js loads the WASM model.
 */

import type {
  Detector,
  DetectorConfig,
  DetectionResult,
  DetectedSpan,
} from "./detector.js";
import type { FeedbackStore } from "./feedback.js";
import {
  PresidioAnalyzer,
  type RecognizerResult,
  EntityType,
} from "@siddicky/anonymizerts";
import { env } from "@huggingface/transformers";

// Ensure transformers.js uses a writable cache directory.
// The default cache location is inside node_modules, which may not be writable
// in containerized/restricted environments.
const CACHE_DIR = process.env.REDACT_CACHE_DIR || "/tmp/.cache";
env.cacheDir = CACHE_DIR;

/**
 * Configuration for PresidioTsDetector extending base DetectorConfig.
 */
export interface PresidioTsConfig extends DetectorConfig {
  /** Enable NER-based recognition (transformers.js). Default: true. */
  useNER?: boolean;
  /** NER model to use. Default: "Xenova/bert-base-NER". */
  modelName?: string;
  /** Minimum confidence threshold for detections. Default: 0.5. */
  threshold?: number;
  /** Entity types to detect. If empty, detects all supported types. */
  labels?: string[];
  /** Additional options passed to the analyzer for future extensibility. */
  options?: Record<string, unknown>;
  /** Regex patterns for strings that should never be flagged (allowlist). */
  allowlistPatterns?: RegExp[];
  /** Optional feedback store to filter out known false positives. */
  feedbackStore?: FeedbackStore;
}

/**
 * PresidioTsDetector implements the Detector interface using @siddicky/anonymizerts.
 *
 * Supported entity types (from Presidio EntityType enum):
 * - PERSON, LOCATION, ORGANIZATION (NER-based)
 * - EMAIL_ADDRESS, PHONE_NUMBER, CREDIT_CARD, US_SSN (pattern-based)
 * - IP_ADDRESS, URL, DATE_TIME (pattern-based)
 *
 * Note: The @siddicky/anonymizerts package currently supports the above types.
 * Additional Presidio entity types (IBAN_CODE, NRP, MEDICAL_LICENSE, US_DRIVER_LICENSE,
 * US_PASSPORT, US_BANK_NUMBER, US_ITIN, CRYPTO, AWS_KEY, GITHUB_TOKEN) may be added
 * in future versions of the package.
 */
export class PresidioTsDetector implements Detector {
  readonly name: string;
  readonly description =
    "Microsoft Presidio PII detection via @siddicky/anonymizerts (pattern + NER, local, private)";

  private analyzer: PresidioAnalyzer | null = null;
  private config: PresidioTsConfig;
  private feedbackStore: FeedbackStore | undefined;
  private initialized = false;
  private initializing: Promise<void> | null = null;
  private shuttingDown = false;

  // Entity types supported by the current @siddicky/anonymizerts version
  private static readonly SUPPORTED_ENTITY_TYPES: readonly EntityType[] = [
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
  ] as const;

  // Map Presidio EntityType to display labels
  private static readonly ENTITY_LABEL_MAP: Record<EntityType, string> = {
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

  constructor(config: PresidioTsConfig) {
    this.name = config.name ?? "presidio-ts";
    this.config = {
      useNER: true,
      modelName: "Xenova/bert-base-NER",
      threshold: 0.5,
      ...config,
    };
    this.feedbackStore = config.feedbackStore;

    this.analyzer = new PresidioAnalyzer({
      useNER: this.config.useNER ?? true,
      modelName: this.config.modelName ?? "Xenova/bert-base-NER",
    });
  }

  /**
   * Check if a matched value is in the allowlist patterns.
   */
  private isAllowlisted(match: string, allowlistPatterns: RegExp[]): boolean {
    for (const pat of allowlistPatterns) {
      pat.lastIndex = 0;
      if (pat.test(match)) return true;
    }
    return false;
  }

  get labels(): readonly string[] {
    // If config specifies labels, return canonical versions that will actually appear in spans;
    // otherwise return all supported canonical labels.
    if (this.config.labels && this.config.labels.length > 0) {
      return this.config.labels
        .map((label) => this.labelToEntityType(label))
        .filter((et): et is EntityType => et !== null)
        .map((et) => PresidioTsDetector.ENTITY_LABEL_MAP[et])
        .filter((label): label is string => label !== undefined);
    }
    return PresidioTsDetector.SUPPORTED_ENTITY_TYPES.map(
      (et) => PresidioTsDetector.ENTITY_LABEL_MAP[et]
    );
  }

  /**
   * Initialize the analyzer (loads NER model if enabled).
   * This should be called before first use, but detect() will auto-initialize if needed.
   */
  async initialize(config?: DetectorConfig): Promise<void> {
    // Merge runtime config
    if (config) {
      this.config = { ...this.config, ...config } as PresidioTsConfig;
      // Update feedbackStore if provided in runtime config
      const presidioConfig = config as PresidioTsConfig;
      if (presidioConfig.feedbackStore !== undefined) {
        this.feedbackStore = presidioConfig.feedbackStore;
      }
    }

    // Warn on unsupported labels
    if (this.config.labels && this.config.labels.length > 0) {
      const supportedLabels = new Set(
        PresidioTsDetector.SUPPORTED_ENTITY_TYPES.map(
          (et) => PresidioTsDetector.ENTITY_LABEL_MAP[et]
        )
      );
      // Also add common aliases
      const aliasLabels = new Set([
        "EMAIL",
        "PHONE",
        "SSN",
        "IP",
        "DATE",
        "DATETIME",
      ]);
      const allSupportedLabels = new Set([...supportedLabels, ...aliasLabels]);

      for (const label of this.config.labels) {
        const upperLabel = label.toUpperCase();
        if (!allSupportedLabels.has(upperLabel)) {
          console.warn(
            `[presidio-ts] Unsupported label "${label}" - ignoring. Supported: ${Array.from(supportedLabels).join(", ")}`
          );
        }
      }
    }

    // If shutdown is in progress, don't clear the flag or start new initialization
    if (this.shuttingDown) {
      // Wait for any ongoing initialization to complete, then return
      if (this.initializing) {
        await this.initializing;
      }
      return;
    }

    // Prevent duplicate initialization
    if (this.initialized) return;
    if (this.initializing) {
      // There's an ongoing initialization - await it and return.
      // Do NOT clear shuttingDown here, as it would race with shutdown()
      // which may be waiting for this initialization to complete.
      await this.initializing;
      return;
    }

    this.initializing = (async () => {
      try {
        // If analyzer was released by shutdown(), recreate it
        if (!this.analyzer) {
          this.analyzer = new PresidioAnalyzer({
            useNER: this.config.useNER ?? true,
            modelName: this.config.modelName ?? "Xenova/bert-base-NER",
          });
        }
        // Initialize the analyzer (loads transformers.js NER model on first call)
        await this.analyzer.initialize();
        // If shutdown was called while we were initializing, don't mark as initialized
        if (!this.shuttingDown) {
          this.initialized = true;
        }
      } catch (error) {
        this.initializing = null;
        throw new Error(
          `Failed to initialize PresidioTsDetector: ${error instanceof Error ? error.message : String(error)}`
        );
      }
    })();

    await this.initializing;
    this.initializing = null;
  }

  /**
   * Check if detector is ready for detection.
   */
  isReady(): boolean {
    return this.initialized;
  }

  /**
   * Clean up resources. Releases the transformers.js model to allow GC.
   */
  async shutdown(): Promise<void> {
    // Set shuttingDown flag FIRST to prevent new initializations from proceeding
    this.shuttingDown = true;
    this.initialized = false;
    // If initialization is in progress, wait for it to complete before releasing analyzer
    // to avoid the initialize() coroutine crashing when it resumes.
    if (this.initializing) {
      try {
        await this.initializing;
      } catch {
        // Ignore initialization errors during shutdown
      }
    }
    this.initializing = null;
    this.shuttingDown = false;
    // Drop reference to the analyzer to allow the transformers.js model (BERT) to be garbage collected
    // The analyzer holds the NER pipeline which can be ~500MB
    this.analyzer = null;
  }

  /**
   * Detect PII/entities in text using Presidio analyzer.
   *
   * @param text - Input text to analyze
   * @param config - Optional runtime configuration override
   * @returns Detected spans with confidence scores
   */
  async detect(text: string, config?: DetectorConfig): Promise<DetectionResult> {
    const startTime = Date.now();

    // Prevent detection during shutdown
    if (this.shuttingDown) {
      throw new Error("PresidioTsDetector is shutting down");
    }

    // Auto-initialize if not already done (handles warmup on first call)
    if (!this.initialized) {
      await this.initialize(config);
    }

    if (!this.isReady()) {
      throw new Error(
        "PresidioTsDetector not initialized. Call initialize() first."
      );
    }

    const finalConfig = { ...this.config, ...config } as PresidioTsConfig;
    const threshold = finalConfig.threshold ?? 0.5;
    const allowlistPatterns = finalConfig.allowlistPatterns ?? [];
    const feedbackStore = finalConfig.feedbackStore ?? this.feedbackStore;

    // Determine which entity types to detect
    let entityTypes: EntityType[] | undefined;
    if (finalConfig.labels && finalConfig.labels.length > 0) {
      const mappedTypes = finalConfig.labels.map((label) => ({
        label,
        entityType: this.labelToEntityType(label),
      }));
      const unrecognizedLabels = mappedTypes
        .filter((m) => m.entityType === null)
        .map((m) => m.label);
      if (unrecognizedLabels.length > 0) {
        const supportedLabels = PresidioTsDetector.SUPPORTED_ENTITY_TYPES.map(
          (et) => PresidioTsDetector.ENTITY_LABEL_MAP[et]
        );
        console.warn(
          `[presidio-ts] Unsupported labels: ${unrecognizedLabels.join(", ")} - ignoring. Supported: ${supportedLabels.join(", ")}`
        );
      }
      entityTypes = mappedTypes
        .filter((m): m is { label: string; entityType: EntityType } => m.entityType !== null)
        .map((m) => m.entityType);
      
      // DEBUG: Log mapped entity types
      if (process.env.REDACT_DEBUG === "true") {
        console.error(`[presidio-ts-debug] Config labels:`, finalConfig.labels);
        console.error(`[presidio-ts-debug] Mapped entityTypes:`, entityTypes?.map(e => PresidioTsDetector.ENTITY_LABEL_MAP[e]).join(",") || "none");
      }
    }

    // Run analysis
    // analyzer is guaranteed non-null after successful initialize()
    if (!this.analyzer) {
      throw new Error("PresidioTsDetector analyzer is not initialized");
    }
    
    // DEBUG: Log what we're detecting
    if (process.env.REDACT_DEBUG === "true") {
      console.error(`[presidio-ts-debug] Analyzing text (len=${text.length}), entityTypes=${entityTypes?.map(e => PresidioTsDetector.ENTITY_LABEL_MAP[e]).join(",") || "all"}, threshold=${threshold}`);
    }
    
    const analyzerResults = await this.analyzer.analyze(text, entityTypes);
    
    // DEBUG: Log raw analyzer results
    if (process.env.REDACT_DEBUG === "true") {
      console.error(`[presidio-ts-debug] Raw results:`, analyzerResults.map(r => `${r.entityType}:${r.text}@${r.start}-${r.end} (${r.score.toFixed(3)})`));
    }

    // Convert to DetectionResult format
    let filteredResults = analyzerResults
      .filter((result: RecognizerResult) => result.score >= threshold)
      .filter((result: RecognizerResult) => !this.isAllowlisted(result.text, allowlistPatterns));

    // Apply feedback store filtering if available
    if (feedbackStore) {
      // Check all results in parallel for better performance
      const isFalsePositiveResults = await Promise.all(
        filteredResults.map(async (result) => {
          try {
            return await feedbackStore.isFalsePositive(result.text, this.name);
          } catch (err) {
            // Log error but don't crash the pipeline - treat as non-false-positive
            console.error(`[presidio-ts] False positive check failed for "${result.text}":`, err);
            return false;
          }
        })
      );
      filteredResults = filteredResults.filter(
        (_, index) => !isFalsePositiveResults[index]
      );
    }

    const spans = filteredResults.map((result: RecognizerResult) => this.convertToDetectedSpan(result));

    // Sort by start position
    spans.sort((a: DetectedSpan, b: DetectedSpan) => a.start - b.start);

    return {
      spans,
      latencyMs: Date.now() - startTime,
    };
  }

  /**
   * Convert a Presidio RecognizerResult to our DetectedSpan format.
   */
  private convertToDetectedSpan(result: RecognizerResult): DetectedSpan {
    return {
      text: result.text,
      start: result.start,
      end: result.end,
      label: PresidioTsDetector.ENTITY_LABEL_MAP[result.entityType] ?? result.entityType,
      score: result.score,
      detectorName: this.name,
    };
  }

  /**
   * Map a label string to Presidio EntityType.
   * Returns null if the label is not recognized.
   */
  private labelToEntityType(label: string): EntityType | null {
    const upperLabel = label.toUpperCase();

    // Direct enum value match
    if (Object.values(EntityType).includes(upperLabel as EntityType)) {
      return upperLabel as EntityType;
    }

    // Common aliases
    const aliasMap: Record<string, EntityType> = {
      PERSON: EntityType.PERSON,
      LOCATION: EntityType.LOCATION,
      ORGANIZATION: EntityType.ORGANIZATION,
      EMAIL: EntityType.EMAIL_ADDRESS,
      EMAIL_ADDRESS: EntityType.EMAIL_ADDRESS,
      PHONE: EntityType.PHONE_NUMBER,
      PHONE_NUMBER: EntityType.PHONE_NUMBER,
      CREDIT_CARD: EntityType.CREDIT_CARD,
      SSN: EntityType.US_SSN,
      US_SSN: EntityType.US_SSN,
      IP: EntityType.IP_ADDRESS,
      IP_ADDRESS: EntityType.IP_ADDRESS,
      URL: EntityType.URL,
      DATE: EntityType.DATE_TIME,
      DATE_TIME: EntityType.DATE_TIME,
      DATETIME: EntityType.DATE_TIME,
    };

    return aliasMap[upperLabel] ?? null;
  }
}

/**
 * Factory function to create and initialize a PresidioTsDetector.
 *
 * @param config - Detector configuration
 * @returns Initialized PresidioTsDetector instance
 *
 * @example
 * ```typescript
 * const detector = await createPresidioTsDetector({
 *   name: "pii-detector",
 *   threshold: 0.6,
 *   useNER: true,
 *   labels: ["PERSON", "EMAIL_ADDRESS", "PHONE_NUMBER"]
 * });
 * const result = await detector.detect("John Doe <john@example.com>");
 * ```
 */
export async function createPresidioTsDetector(
  config: PresidioTsConfig
): Promise<PresidioTsDetector> {
  const detector = new PresidioTsDetector(config);
  await detector.initialize(config);
  return detector;
}
