/**
 * PresidioTsDetector - PII detection using @siddicky/anonymizerts (Presidio for TypeScript).
 *
 * This detector wraps the PresidioAnalyzer from @siddicky/anonymizerts which combines:
 * - Pattern-based recognizers (regex) for structured PII (email, phone, SSN, credit card, IP, URL)
 * - NER-based recognition (transformers.js) for semantic entities (PERSON, LOCATION, ORGANIZATION, DATE_TIME)
 *
 * The first call to detect() will trigger warmup as transformers.js loads the WASM model.
 */
import { PresidioAnalyzer, EntityType, } from "@siddicky/anonymizerts";
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
export class PresidioTsDetector {
    name;
    description = "Microsoft Presidio PII detection via @siddicky/anonymizerts (pattern + NER, local, private)";
    analyzer;
    config;
    initialized = false;
    initializing = null;
    // Entity types supported by the current @siddicky/anonymizerts version
    static SUPPORTED_ENTITY_TYPES = [
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
    // Map Presidio EntityType to display labels
    static ENTITY_LABEL_MAP = {
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
    constructor(config) {
        this.name = config.name ?? "presidio-ts";
        this.config = {
            useNER: true,
            modelName: "Xenova/bert-base-NER",
            threshold: 0.5,
            ...config,
        };
        this.analyzer = new PresidioAnalyzer({
            useNER: this.config.useNER ?? true,
            modelName: this.config.modelName ?? "Xenova/bert-base-NER",
        });
    }
    get labels() {
        // If config specifies labels, return canonical versions that will actually appear in spans;
        // otherwise return all supported canonical labels.
        if (this.config.labels && this.config.labels.length > 0) {
            return this.config.labels
                .map((label) => this.labelToEntityType(label))
                .filter((et) => et !== null)
                .map((et) => PresidioTsDetector.ENTITY_LABEL_MAP[et])
                .filter((label) => label !== undefined);
        }
        return PresidioTsDetector.SUPPORTED_ENTITY_TYPES.map((et) => PresidioTsDetector.ENTITY_LABEL_MAP[et]);
    }
    /**
     * Initialize the analyzer (loads NER model if enabled).
     * This should be called before first use, but detect() will auto-initialize if needed.
     */
    async initialize(config) {
        // Merge runtime config
        if (config) {
            this.config = { ...this.config, ...config };
        }
        // Warn on unsupported labels
        if (this.config.labels && this.config.labels.length > 0) {
            const supportedLabels = new Set(PresidioTsDetector.SUPPORTED_ENTITY_TYPES.map((et) => PresidioTsDetector.ENTITY_LABEL_MAP[et]));
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
                    console.warn(`[presidio-ts] Unsupported label "${label}" - ignoring. Supported: ${Array.from(supportedLabels).join(", ")}`);
                }
            }
        }
        // Prevent duplicate initialization
        if (this.initialized)
            return;
        if (this.initializing) {
            await this.initializing;
            return;
        }
        this.initializing = (async () => {
            try {
                // Initialize the analyzer (loads transformers.js NER model on first call)
                await this.analyzer.initialize();
                this.initialized = true;
            }
            catch (error) {
                this.initializing = null;
                throw new Error(`Failed to initialize PresidioTsDetector: ${error instanceof Error ? error.message : String(error)}`);
            }
        })();
        await this.initializing;
        this.initializing = null;
    }
    /**
     * Check if detector is ready for detection.
     */
    isReady() {
        return this.initialized;
    }
    /**
     * Clean up resources. Note: transformers.js doesn't expose a cleanup method,
     * but we mark as uninitialized to allow re-initialization if needed.
     */
    async shutdown() {
        this.initialized = false;
        this.initializing = null;
        // The NER pipeline in transformers.js doesn't have an explicit shutdown,
        // but we can drop our reference to allow GC
    }
    /**
     * Detect PII/entities in text using Presidio analyzer.
     *
     * @param text - Input text to analyze
     * @param config - Optional runtime configuration override
     * @returns Detected spans with confidence scores
     */
    async detect(text, config) {
        const startTime = Date.now();
        // Auto-initialize if not already done (handles warmup on first call)
        if (!this.initialized) {
            await this.initialize(config);
        }
        if (!this.isReady()) {
            throw new Error("PresidioTsDetector not initialized. Call initialize() first.");
        }
        const finalConfig = { ...this.config, ...config };
        const threshold = finalConfig.threshold ?? 0.5;
        // Determine which entity types to detect
        let entityTypes;
        if (finalConfig.labels && finalConfig.labels.length > 0) {
            const mappedTypes = finalConfig.labels.map((label) => ({
                label,
                entityType: this.labelToEntityType(label),
            }));
            const unrecognizedLabels = mappedTypes
                .filter((m) => m.entityType === null)
                .map((m) => m.label);
            if (unrecognizedLabels.length > 0) {
                const supportedLabels = PresidioTsDetector.SUPPORTED_ENTITY_TYPES.map((et) => PresidioTsDetector.ENTITY_LABEL_MAP[et]);
                console.warn(`[presidio-ts] Unsupported labels: ${unrecognizedLabels.join(", ")} - ignoring. Supported: ${supportedLabels.join(", ")}`);
            }
            entityTypes = mappedTypes
                .filter((m) => m.entityType !== null)
                .map((m) => m.entityType);
        }
        // Run analysis
        const analyzerResults = await this.analyzer.analyze(text, entityTypes);
        // Convert to DetectionResult format
        const spans = analyzerResults
            .filter((result) => result.score >= threshold)
            .map((result) => this.convertToDetectedSpan(result));
        // Sort by start position
        spans.sort((a, b) => a.start - b.start);
        return {
            spans,
            latencyMs: Date.now() - startTime,
        };
    }
    /**
     * Convert a Presidio RecognizerResult to our DetectedSpan format.
     */
    convertToDetectedSpan(result) {
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
    labelToEntityType(label) {
        const upperLabel = label.toUpperCase();
        // Direct enum value match
        if (Object.values(EntityType).includes(upperLabel)) {
            return upperLabel;
        }
        // Common aliases
        const aliasMap = {
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
export async function createPresidioTsDetector(config) {
    const detector = new PresidioTsDetector(config);
    await detector.initialize(config);
    return detector;
}
//# sourceMappingURL=presidioTsDetector.js.map