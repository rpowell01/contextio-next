/**
 * PresidioTsDetector - PII detection using @siddicky/anonymizerts (Presidio for TypeScript).
 *
 * This detector wraps the PresidioAnalyzer from @siddicky/anonymizerts which combines:
 * - Pattern-based recognizers (regex) for structured PII (email, phone, SSN, credit card, IP, URL)
 * - NER-based recognition (transformers.js) for semantic entities (PERSON, LOCATION, ORGANIZATION, DATE_TIME)
 *
 * The first call to detect() will trigger warmup as transformers.js loads the WASM model.
 */
import type { Detector, DetectorConfig, DetectionResult } from "./detector.js";
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
export declare class PresidioTsDetector implements Detector {
    readonly name: string;
    readonly description = "Microsoft Presidio PII detection via @siddicky/anonymizerts (pattern + NER, local, private)";
    private analyzer;
    private config;
    private initialized;
    private initializing;
    private static readonly SUPPORTED_ENTITY_TYPES;
    private static readonly ENTITY_LABEL_MAP;
    constructor(config: PresidioTsConfig);
    get labels(): readonly string[];
    /**
     * Initialize the analyzer (loads NER model if enabled).
     * This should be called before first use, but detect() will auto-initialize if needed.
     */
    initialize(config?: DetectorConfig): Promise<void>;
    /**
     * Check if detector is ready for detection.
     */
    isReady(): boolean;
    /**
     * Clean up resources. Note: transformers.js doesn't expose a cleanup method,
     * but we mark as uninitialized to allow re-initialization if needed.
     */
    shutdown(): Promise<void>;
    /**
     * Detect PII/entities in text using Presidio analyzer.
     *
     * @param text - Input text to analyze
     * @param config - Optional runtime configuration override
     * @returns Detected spans with confidence scores
     */
    detect(text: string, config?: DetectorConfig): Promise<DetectionResult>;
    /**
     * Convert a Presidio RecognizerResult to our DetectedSpan format.
     */
    private convertToDetectedSpan;
    /**
     * Map a label string to Presidio EntityType.
     * Returns null if the label is not recognized.
     */
    private labelToEntityType;
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
export declare function createPresidioTsDetector(config: PresidioTsConfig): Promise<PresidioTsDetector>;
//# sourceMappingURL=presidioTsDetector.d.ts.map