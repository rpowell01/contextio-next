/**
 * Model pricing and context limits for Anthropic, OpenAI, Google, and MiniMax.
 *
 * Both lookup tables use substring matching, so key order matters:
 * "gpt-4o-mini" must come before "gpt-4o" or the shorter key would
 * match first. Keep entries most-specific-first within each provider.
 *
 * Prices sourced from OpenRouter and litellm model_prices_and_context_window.json.
 * Keys are matched as substrings of the incoming model string, so they work
 * for both direct-API model IDs and OpenRouter-prefixed IDs.
 */
/**
 * Known model context limits (tokens).
 *
 * Keys are ordered most-specific-first because `getContextLimit()` does substring matching.
 */
export declare const CONTEXT_LIMITS: Record<string, number>;
/**
 * Resolve an approximate context window size for a model.
 *
 * Uses substring matching against {@link CONTEXT_LIMITS}. Returns
 * 128k as a fallback for unknown models (a reasonable default for
 * most modern LLMs).
 *
 * @param model - Model identifier (may include version/date suffixes).
 * @returns Context limit in tokens.
 */
export declare function getContextLimit(model: string): number;
/**
 * Model pricing: `[inputPerMTok, outputPerMTok]` in USD.
 *
 * Keys ordered most-specific-first to avoid substring false matches
 * (e.g. `gpt-4o-mini` before `gpt-4o`, `o3-mini` before `o3`).
 */
export declare const MODEL_PRICING: Record<string, [number, number]>;
/**
 * Estimate cost in USD for a request/response token pair using `MODEL_PRICING`.
 *
 * Cache pricing varies by provider:
 * - Anthropic: cache reads at 10% of base input, writes at 125% (1.25x)
 * - Gemini: cached content at 25% of base input, no write cost
 *
 * @param model - Model identifier (substring matched against known keys).
 * @param inputTokens - Input/prompt tokens (non-cached).
 * @param outputTokens - Output/completion tokens.
 * @param cacheReadTokens - Cache read tokens.
 * @param cacheWriteTokens - Cache write tokens.
 * @returns Cost in USD, rounded to 6 decimals; `null` if the model is unknown.
 */
export declare function estimateCost(model: string, inputTokens: number, outputTokens: number, cacheReadTokens?: number, cacheWriteTokens?: number): number | null;
/**
 * Get list of known model names.
 *
 * @returns Sorted array of model identifiers.
 */
export declare function getKnownModels(): string[];
//# sourceMappingURL=models.d.ts.map