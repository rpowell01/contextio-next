/**
 * Streaming rehydration for SSE responses.
 *
 * The challenge: placeholders like `[EMAIL_1]` can be split across
 * multiple SSE events (the LLM might stream "[EMA" in one chunk and
 * "IL_1]" in the next). This module handles that by:
 *
 * 1. Extracting text content from SSE `data:` lines (provider-agnostic)
 * 2. Buffering content when a partial placeholder is detected (trailing "[")
 * 3. Replacing complete placeholders with originals from the ReplacementMap
 * 4. Preserving the JSON structure of each SSE event
 *
 * When no placeholders are present in a chunk, it passes through unchanged
 * (zero allocation fast path).
 */
import type { ReplacementMap } from "./mapping.js";
/**
 * Create a stateful stream rehydrator for one session.
 *
 * Call `onChunk()` for each SSE chunk from the upstream. It buffers
 * partial lines and partial placeholders, replacing complete ones with
 * originals. Call `onEnd()` when the stream finishes to flush any
 * remaining buffered content.
 *
 * @param map - The session's replacement map (original <-> placeholder).
 * @returns Chunk and end handlers.
 */
export declare function createStreamRehydrator(map: ReplacementMap): {
    onChunk: (chunk: Buffer) => Buffer;
    onEnd: () => Buffer | null;
};
//# sourceMappingURL=stream.d.ts.map