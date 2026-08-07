/**
 * Response parsing: extract token usage, model info, and finish reasons
 * from LLM API responses.
 *
 * Handles both streaming SSE and non-streaming JSON responses from:
 * - Anthropic Messages API
 * - OpenAI Chat Completions and Responses API
 * - Google Gemini, including Code Assist wrapper responses
 */
/** Parsed token usage from an API response. */
export interface ParsedResponseUsage {
    /** Input or prompt tokens, excluding cache reads where providers report them separately. */
    inputTokens: number;
    /** Output or completion tokens, excluding thinking tokens where providers report them separately. */
    outputTokens: number;
    /** Cache read tokens. */
    cacheReadTokens: number;
    /** Cache write tokens. */
    cacheWriteTokens: number;
    /** Reasoning or thinking tokens. */
    thinkingTokens: number;
    /** Model identifier. */
    model: string | null;
    /** Finish reasons, such as stop, length, or end_turn. */
    finishReasons: string[];
    /** Whether this was parsed as a streaming response. */
    stream: boolean;
}
/**
 * Approximate token counts by counting characters in the provided text.
 *
 * Divide by 4 as a rough heuristic:
 * - One token is roughly 4 characters for English text.
 * - Produced by:
    *   Claude 3.5 Sonnet / Haiku (Anthropic)
    *   GPT-4.1 / GPT-5 series (OpenAI)
    *   Gemini models (Google)
 *
 * This is intentionally loose; it is a upper bound when exact token counts
 * are unavailable.
 *
 * Always uses Math.max(..., 1) so we never return 0-token estimates. That
 * way the capture breakdown table always shows a non-zero value and the
 * Tokens/sec column stays sensible.
 */
export declare const ESTIMATED_TOKENS_PER_CHARACTER = 0.25;
export declare function estimateTokensFromText(text: string): number;
/**
 * Extract the response ID from a response object.
 *
 * Works for both non-streaming JSON and Context Lens streaming wrapper
 * responses. For streaming, scans for response.created or response.completed
 * SSE events that carry the response object with its ID.
 */
export declare function extractResponseId(responseData: unknown): string | null;
/**
 * Parse token usage from an API response.
 *
 * Accepts direct JSON objects, raw JSON response body strings, raw SSE strings,
 * and Context Lens streaming wrapper objects of the form { streaming: true, chunks }.
 */
export declare function parseResponseUsage(responseData: unknown): ParsedResponseUsage;
/**
 * Provider-specific streaming token parser.
 *
 * Unlike parseResponseUsage, this function takes an explicit provider hint
 * and only checks for that provider's SSE format.
 */
export declare function parseStreamingTokens(body: string, provider: string): ParsedResponseUsage | null;
//# sourceMappingURL=response.d.ts.map