/**
 * Bidirectional replacement mapping for reversible redaction.
 *
 * Tracks original value -> placeholder mappings (e.g. "john@test.com" ->
 * "[EMAIL_1]") so the proxy can restore originals in LLM responses.
 *
 * Mappings persist for the lifetime of the session. The same value always
 * maps to the same placeholder, even across multiple requests in the
 * same session.
 */
/**
 * A single mapping entry.
 */
export interface MappingEntry {
    /** The original sensitive value. */
    original: string;
    /** The placeholder token sent to the LLM, such as "[EMAIL_1]". */
    placeholder: string;
    /** The rule that triggered this mapping, such as "email". */
    ruleId: string;
}
/**
 * Bidirectional mapping between original values and placeholders.
 *
 * Thread-safe for single-threaded Node: no concurrent mutation concerns,
 * but multiple requests in flight can read/write safely because JS is
 * single-threaded within the event loop.
 */
export declare class ReplacementMap {
    /** original -> canonical placeholder */
    private forward;
    /** canonical placeholder -> original */
    private reverse;
    /** ruleId -> next counter (for generating [EMAIL_1], [EMAIL_2], etc.) */
    private counters;
    /** All entries in insertion order. */
    private entries;
    /** When true, also remember user-specified replacements as canonical values. */
    readonly emitCustom = false;
    /**
     * Get or create a placeholder for the given original value.
     *
     * If the same original was seen before (even from a different rule),
     * returns the existing placeholder. Otherwise generates a new one.
     *
     * The ruleId is used to generate the placeholder label:
     *   "email" -> [EMAIL_1], [EMAIL_2], ...
     *   "ssn"   -> [SSN_1], [SSN_2], ...
     */
    getOrCreate(original: string, ruleId: string): string;
    /**
     * Look up the original value for a placeholder.
     * Returns undefined if the placeholder is unknown.
     */
    getOriginal(placeholder: string): string | undefined;
    /**
     * Replace all known placeholders in a string with their originals.
     *
     * Iterates all known placeholders and does a global string replace.
     * Longest placeholders are tried first to avoid partial matches
     * (e.g. [EMAIL_10] before [EMAIL_1]).
     */
    rehydrate(text: string): string;
    /**
     * Number of unique mappings stored.
     */
    get size(): number;
    /**
     * All mapping entries in insertion order.
     */
    allEntries(): readonly MappingEntry[];
    /**
     * All placeholders as an array (useful for building streaming matchers).
     */
    allPlaceholders(): string[];
}
//# sourceMappingURL=mapping.d.ts.map