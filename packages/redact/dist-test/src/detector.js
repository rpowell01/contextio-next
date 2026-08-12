/**
 * Detector interface for PII/secret detection.
 *
 * This interface abstracts the detection mechanism, allowing pluggable
 * implementations (rule-based, LLM-based, hybrid, external API).
 *
 * Each detector receives a string and returns an array of detected spans
 * with metadata for redaction.
 */
/**
 * Registry of built-in detector factories.
 */
export const detectorRegistry = new Map();
/**
 * Register a detector factory.
 */
export function registerDetector(name, factory) {
    detectorRegistry.set(name, factory);
}
/**
 * Create a detector by name.
 */
export async function createDetector(name, config) {
    const factory = detectorRegistry.get(name);
    if (!factory) {
        throw new Error(`Unknown detector: ${name}. Available: ${Array.from(detectorRegistry.keys()).join(", ")}`);
    }
    const detector = await factory(config);
    await detector.initialize(config);
    return detector;
}
//# sourceMappingURL=detector.js.map