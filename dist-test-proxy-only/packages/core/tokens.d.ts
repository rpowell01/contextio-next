/**
 * Token estimation utilities.
 *
 * Provides image-aware token counting that handles:
 * - Plain text: ceil(chars / 4)
 * - Image content blocks: fixed ~1600 tokens per image
 * - Structured objects: strips base64 before counting
 */
/**
 * Approximate token cost for a single image.
 *
 * Anthropic charges based on image dimensions (~1,600 tokens per 512x512 tile).
 * Since we don't decode image data, we use a conservative flat estimate of 1,600
 * tokens (one tile). Most screenshots cost 2,000-6,400 tokens, so this slightly
 * under-counts but is far better than stringifying megabytes of base64.
 */
export declare const IMAGE_TOKEN_ESTIMATE = 1600;
/**
 * Lightweight token estimator.
 *
 * Approximates tokens as `ceil(chars / 4)`. For image content blocks,
 * uses a fixed per-image estimate instead of stringifying base64 data.
 *
 * @param text - Value to estimate tokens for. Objects are stringified as JSON.
 * @returns Estimated token count (>= 0).
 */
export declare function estimateTokens(text: unknown): number;
/**
 * Count the number of image blocks in a value.
 *
 * @param val - Value to count images in.
 * @returns Number of image blocks found.
 */
export declare function countImageBlocks(val: unknown): number;
//# sourceMappingURL=tokens.d.ts.map