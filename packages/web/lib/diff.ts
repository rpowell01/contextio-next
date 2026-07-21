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
  /** Maximum number of lines/tokens before using greedy O(n+m) algorithm (default: 5000) */
  maxTokens?: number;
  /** Whether to automatically use greedy algorithm for large inputs (default: true) */
  autoFallback?: boolean;
}

/**
 * Greedy diff algorithm for large inputs - O(n+m) time, O(min(n,m)) space.
 * Trades optimal LCS for performance on very large inputs.
 */
function computeDiffGreedy(
  oldTokens: string[],
  newTokens: string[],
  mode: DiffMode,
  options: Pick<ComputeDiffOptions, "ignoreWhitespace" | "ignoreCase"> = {},
): DiffChunk[] {
  const { ignoreWhitespace = false, ignoreCase = false } = options;

  // Apply normalization to tokens for comparison
  const normalize = (token: string): string => {
    let result = token;
    if (ignoreWhitespace) {
      result = result.replace(/\s+/g, " ").trim();
    }
    if (ignoreCase) {
      result = result.toLowerCase();
    }
    return result;
  };

  const normalizedOld = oldTokens.map(normalize);
  const normalizedNew = newTokens.map(normalize);

  const result: DiffChunk[] = [];
  let i = 0;
  let j = 0;
  let oldLineNum = 1;
  let newLineNum = 1;
  const trackLineNumbers = mode === "line";

  // Use a Map to find matching tokens in newTokens for each oldTokens position
  // This is a simplified approach - for very large inputs we just do a linear scan
  // and match equal tokens greedily
  const newTokenIndices = new Map<string, number[]>();
  normalizedNew.forEach((token, idx) => {
    const arr = newTokenIndices.get(token) || [];
    arr.push(idx);
    newTokenIndices.set(token, arr);
  });

  // Track which new tokens have been matched
  const matchedNew = new Set<number>();

  while (i < normalizedOld.length || j < normalizedNew.length) {
    // Try to find a match for the current old token in newTokens
    if (i < normalizedOld.length) {
      const oldToken = normalizedOld[i];
      const candidates = newTokenIndices.get(oldToken) || [];
      const nextMatch = candidates.find((idx) => idx >= j && !matchedNew.has(idx));

      if (nextMatch !== undefined) {
        // Found a match - output insertions for skipped new tokens
        while (j < nextMatch) {
          if (!matchedNew.has(j)) {
            result.push({
              type: "insert",
              value: newTokens[j], // Use original value for display
              newLineNum: trackLineNumbers ? newLineNum : undefined,
            });
            if (trackLineNumbers) newLineNum++;
          }
          j++;
        }
        // Output the match
        result.push({
          type: "equal",
          value: oldTokens[i], // Use original value for display
          oldLineNum: trackLineNumbers ? oldLineNum : undefined,
          newLineNum: trackLineNumbers ? newLineNum : undefined,
        });
        matchedNew.add(nextMatch);
        i++;
        j = nextMatch + 1;
        if (trackLineNumbers) {
          oldLineNum++;
          newLineNum++;
        }
        continue;
      }
    }

    // No match found for old token, or no more old tokens
    if (i < normalizedOld.length) {
      // Delete old token
      result.push({
        type: "delete",
        value: oldTokens[i], // Use original value for display
        oldLineNum: trackLineNumbers ? oldLineNum : undefined,
      });
      i++;
      if (trackLineNumbers) oldLineNum++;
    } else if (j < normalizedNew.length) {
      // Insert remaining new tokens
      if (!matchedNew.has(j)) {
        result.push({
          type: "insert",
          value: newTokens[j], // Use original value for display
          newLineNum: trackLineNumbers ? newLineNum : undefined,
        });
        if (trackLineNumbers) newLineNum++;
      }
      j++;
    }
  }

  return result;
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
    maxTokens = 5000,
    autoFallback = true,
  } = options;

  // Handle edge cases
  if (oldText === newText) {
    // Quick path for identical strings
    if (oldText === "") {
      return [];
    }

    // Split based on mode to match general path behavior
    let tokens: string[];
    if (mode === "word") {
      // Word mode: split by word boundaries, preserving whitespace
      tokens = oldText.split(/(\s+)/).filter(Boolean);
    } else {
      // Line mode: split by newlines, filter trailing empty string
      tokens = oldText
        .split("\n")
        .filter((t, i, arr) => i < arr.length - 1 || t !== "");
    }

    return tokens.map((token, i) => ({
      type: "equal" as const,
      value: token,
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

  // Performance guard: if token count exceeds threshold, use a simpler algorithm
  // This prevents O(n*m) memory/time blowup for very large inputs
  if (
    autoFallback &&
    (oldTokens.length > maxTokens || newTokens.length > maxTokens)
  ) {
    // For very large inputs, use a simplified greedy diff that runs in O(n+m) time
    // and O(min(n,m)) space. This trades optimal LCS for performance.
    return computeDiffGreedy(oldTokens, newTokens, mode, {
      ignoreWhitespace,
      ignoreCase,
    });
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

/**
 * Filter diff to show only changes with surrounding context lines.
 * This collapses long runs of equal lines, keeping only `contextLines` 
 * around each change.
 */
export interface FilteredDiffResult {
  chunks: DiffChunk[];
  hasHiddenLines: boolean;
  hiddenRanges: Array<{ start: number; end: number; count: number }>;
}

export function filterDiffWithContext(
  chunks: DiffChunk[],
  contextLines = 3
): FilteredDiffResult {
  if (chunks.length === 0) {
    return { chunks: [], hasHiddenLines: false, hiddenRanges: [] };
  }

  // Find indices of all non-equal chunks
  const changeIndices: number[] = [];
  for (let i = 0; i < chunks.length; i++) {
    if (chunks[i].type !== "equal") {
      changeIndices.push(i);
    }
  }

  // If no changes, return first few lines as context
  if (changeIndices.length === 0) {
    const showCount = Math.min(contextLines * 2, chunks.length);
    return {
      chunks: chunks.slice(0, showCount),
      hasHiddenLines: chunks.length > showCount,
      hiddenRanges: chunks.length > showCount ? [{ start: showCount, end: chunks.length - 1, count: chunks.length - showCount }] : [],
    };
  }

  // Build a set of indices to keep (changes + context around them)
  const keepIndices = new Set<number>();
  for (const changeIdx of changeIndices) {
    const start = Math.max(0, changeIdx - contextLines);
    const end = Math.min(chunks.length - 1, changeIdx + contextLines);
    for (let i = start; i <= end; i++) {
      keepIndices.add(i);
    }
  }

  // Build filtered chunks, inserting hidden range markers
  const filteredChunks: DiffChunk[] = [];
  const hiddenRanges: Array<{ start: number; end: number; count: number }> = [];
  let hiddenStart = -1;

  for (let i = 0; i < chunks.length; i++) {
    if (keepIndices.has(i)) {
      if (hiddenStart !== -1) {
        hiddenRanges.push({
          start: hiddenStart,
          end: i - 1,
          count: i - hiddenStart,
        });
        hiddenStart = -1;
      }
      filteredChunks.push(chunks[i]);
    } else if (hiddenStart === -1) {
      hiddenStart = i;
    }
  }

  if (hiddenStart !== -1) {
    hiddenRanges.push({
      start: hiddenStart,
      end: chunks.length - 1,
      count: chunks.length - hiddenStart,
    });
  }

  return {
    chunks: filteredChunks,
    hasHiddenLines: hiddenRanges.length > 0,
    hiddenRanges,
  };
}
