/**
 * Diff utility module for computing line-based diffs using LCS algorithm.
 * Lightweight implementation with no external dependencies.
 */

/**
 * Diff chunk types
 * - 'equal': line exists in both old and new text
 * - 'delete': line exists only in old text (removed)
 * - 'insert': line exists only in new text (added)
 */
export type DiffType = "equal" | "delete" | "insert";

/**
 * Represents a single diff chunk in the diff result
 */
export interface DiffChunk {
  /** Type of diff chunk: 'equal', 'delete', or 'insert' */
  type: DiffType;
  /** The text content of this chunk (single line) */
  value: string;
  /** Line number in the old text (1-indexed), undefined for insertions */
  oldLineNum?: number;
  /** Line number in the new text (1-indexed), undefined for deletions */
  newLineNum?: number;
}

/**
 * Diff computation modes
 * - 'line': Compare line by line (default, good for code diffs)
 * - 'word': Compare word by word (better for prose/text diffs)
 */
export type DiffMode = "line" | "word";

/**
 * Options for diff computation
 */
export interface ComputeDiffOptions {
  /** Diff mode: 'line' (default) or 'word' */
  mode?: DiffMode;
  /** Whether to ignore whitespace differences */
  ignoreWhitespace?: boolean;
  /** Whether to ignore case differences */
  ignoreCase?: boolean;
}

/**
 * Computes the diff between two texts using the LCS (Longest Common Subsequence) algorithm.
 *
 * @param oldText - The original text
 * @param newText - The new text to compare against
 * @param options - Optional configuration for diff behavior
 * @returns Array of DiffChunk objects representing the diff
 *
 * @example
 * ```typescript
 * const diff = computeDiff('hello\nworld', 'hello\nthere\nworld');
 * // Returns: [
 * //   { type: 'equal', value: 'hello', oldLineNum: 1, newLineNum: 1 },
 * //   { type: 'insert', value: 'there', newLineNum: 2 },
 * //   { type: 'equal', value: 'world', oldLineNum: 2, newLineNum: 3 }
 * // ]
 * ```
 */
export function computeDiff(
  oldText: string,
  newText: string,
  options: ComputeDiffOptions = {},
): DiffChunk[] {
  const {
    mode = "line",
    ignoreWhitespace = false,
    ignoreCase = false,
  } = options;

  // Handle edge cases
  if (oldText === newText) {
    // Quick path for identical strings
    if (oldText === "") {
      return [];
    }
    const lines = oldText.split("\n");
    return lines.map((line, i) => ({
      type: "equal" as const,
      value: line,
      oldLineNum: mode === "line" ? i + 1 : undefined,
      newLineNum: mode === "line" ? i + 1 : undefined,
    }));
  }

  // Split text into tokens based on mode
  let oldTokens: string[];
  let newTokens: string[];

  if (mode === "word") {
    // Split by word boundaries, preserving whitespace as separate tokens
    const splitWords = (text: string): string[] => {
      // Split by word boundaries, keeping the delimiters
      return text.split(/(\s+)/).filter(Boolean);
    };
    oldTokens = splitWords(oldText);
    newTokens = splitWords(newText);
  } else {
    // Line mode - split by newlines
    // Filter out the trailing empty string from split("\n") on empty input
    oldTokens = oldText
      .split("\n")
      .filter((t, i, arr) => i < arr.length - 1 || t !== "");
    newTokens = newText
      .split("\n")
      .filter((t, i, arr) => i < arr.length - 1 || t !== "");
  }

  // Apply normalization if options specified
  const normalize = (token: string): string => {
    let result = token;
    if (ignoreWhitespace) {
      // Collapse all whitespace runs to single space and trim
      result = result.replace(/\s+/g, " ").trim();
    }
    if (ignoreCase) {
      result = result.toLowerCase();
    }
    return result;
  };

  const normalizedOld = oldTokens.map(normalize);
  const normalizedNew = newTokens.map(normalize);

  // Build LCS dynamic programming table
  const dp: number[][] = Array(normalizedOld.length + 1)
    .fill(null)
    .map(() => Array(normalizedNew.length + 1).fill(0));

  for (let i = normalizedOld.length - 1; i >= 0; i--) {
    for (let j = normalizedNew.length - 1; j >= 0; j--) {
      if (normalizedOld[i] === normalizedNew[j]) {
        dp[i][j] = dp[i + 1][j + 1] + 1;
      } else {
        dp[i][j] = Math.max(dp[i + 1][j], dp[i][j + 1]);
      }
    }
  }

  // Reconstruct diff from DP table
  const result: DiffChunk[] = [];
  let i = 0;
  let j = 0;
  let oldLineNum = 1;
  let newLineNum = 1;

  // In word mode, we don't track line numbers since tokens are words/whitespace
  const trackLineNumbers = mode === "line";

  while (i < normalizedOld.length || j < normalizedNew.length) {
    if (
      i < normalizedOld.length &&
      j < normalizedNew.length &&
      normalizedOld[i] === normalizedNew[j]
    ) {
      // Equal - token exists in both
      result.push({
        type: "equal",
        value: oldTokens[i],
        oldLineNum: trackLineNumbers ? oldLineNum : undefined,
        newLineNum: trackLineNumbers ? newLineNum : undefined,
      });
      i++;
      j++;
      if (trackLineNumbers) {
        oldLineNum++;
        newLineNum++;
      }
    } else if (
      j < normalizedNew.length &&
      (i >= normalizedOld.length || dp[i][j + 1] >= dp[i + 1][j])
    ) {
      // Insert - token only in new text
      result.push({
        type: "insert",
        value: newTokens[j],
        newLineNum: trackLineNumbers ? newLineNum : undefined,
      });
      j++;
      if (trackLineNumbers) {
        newLineNum++;
      }
    } else if (i < normalizedOld.length) {
      // Delete - token only in old text
      result.push({
        type: "delete",
        value: oldTokens[i],
        oldLineNum: trackLineNumbers ? oldLineNum : undefined,
      });
      i++;
      if (trackLineNumbers) {
        oldLineNum++;
      }
    }
  }

  return result;
}

/**
 * Convenience function to compute a line-based diff (default mode)
 * @param oldText - Original text
 * @param newText - New text
 * @returns Array of DiffChunk objects
 */
export function computeLineDiff(oldText: string, newText: string): DiffChunk[] {
  return computeDiff(oldText, newText, { mode: "line" });
}

/**
 * Convenience function to compute a word-based diff
 * @param oldText - Original text
 * @param newText - New text
 * @returns Array of DiffChunk objects
 */
export function computeWordDiff(oldText: string, newText: string): DiffChunk[] {
  return computeDiff(oldText, newText, { mode: "word" });
}

/**
 * Helper to format diff chunks for display
 * Groups consecutive chunks of the same type
 */
export function groupDiffChunks(chunks: DiffChunk[]): Array<{
  type: DiffType;
  chunks: DiffChunk[];
}> {
  if (chunks.length === 0) return [];

  const groups: Array<{ type: DiffType; chunks: DiffChunk[] }> = [];
  let currentGroup = { type: chunks[0].type, chunks: [chunks[0]] };

  for (let i = 1; i < chunks.length; i++) {
    if (chunks[i].type === currentGroup.type) {
      currentGroup.chunks.push(chunks[i]);
    } else {
      groups.push(currentGroup);
      currentGroup = { type: chunks[i].type, chunks: [chunks[i]] };
    }
  }
  groups.push(currentGroup);

  return groups;
}

/**
 * Statistics about a diff result
 */
export interface DiffStats {
  /** Number of lines/words that are equal */
  equal: number;
  /** Number of lines/words deleted (only in old) */
  deleted: number;
  /** Number of lines/words inserted (only in new) */
  inserted: number;
  /** Total chunks in diff */
  totalChunks: number;
}

/**
 * Calculate statistics from a diff result
 */
export function computeDiffStats(chunks: DiffChunk[]): DiffStats {
  let equal = 0;
  let deleted = 0;
  let inserted = 0;

  for (const chunk of chunks) {
    if (chunk.type === "equal") equal++;
    else if (chunk.type === "delete") deleted++;
    else if (chunk.type === "insert") inserted++;
  }

  return {
    equal,
    deleted,
    inserted,
    totalChunks: chunks.length,
  };
}
