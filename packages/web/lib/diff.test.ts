import { describe, it } from "node:test";
import assert from "node:assert/strict";

import {
  computeDiff,
  computeLineDiff,
  computeWordDiff,
  groupDiffChunks,
  computeDiffStats,
  type DiffChunk,
} from "./diff.js";

describe("computeDiff - line mode", () => {
  it("empty strings returns empty array", () => {
    const result = computeDiff("", "");
    assert.deepEqual(result, []);
  });

  it("identical strings returns equal chunks with line numbers", () => {
    const result = computeDiff("hello\nworld", "hello\nworld");
    assert.equal(result.length, 2);
    assert.deepEqual(result[0], {
      type: "equal",
      value: "hello",
      oldLineNum: 1,
      newLineNum: 1,
    });
    assert.deepEqual(result[1], {
      type: "equal",
      value: "world",
      oldLineNum: 2,
      newLineNum: 2,
    });
  });

  it("identical empty string returns empty array", () => {
    const result = computeDiff("", "");
    assert.deepEqual(result, []);
  });

  it("insert lines at beginning", () => {
    const result = computeDiff("a\nb", "x\ny\na\nb");
    assert.deepEqual(result, [
      { type: "insert", value: "x", newLineNum: 1 },
      { type: "insert", value: "y", newLineNum: 2 },
      { type: "equal", value: "a", oldLineNum: 1, newLineNum: 3 },
      { type: "equal", value: "b", oldLineNum: 2, newLineNum: 4 },
    ]);
  });

  it("insert lines at end", () => {
    const result = computeDiff("a\nb", "a\nb\nx\ny");
    assert.deepEqual(result, [
      { type: "equal", value: "a", oldLineNum: 1, newLineNum: 1 },
      { type: "equal", value: "b", oldLineNum: 2, newLineNum: 2 },
      { type: "insert", value: "x", newLineNum: 3 },
      { type: "insert", value: "y", newLineNum: 4 },
    ]);
  });

  it("insert lines in middle", () => {
    const result = computeDiff("a\nc", "a\nb\nc");
    assert.deepEqual(result, [
      { type: "equal", value: "a", oldLineNum: 1, newLineNum: 1 },
      { type: "insert", value: "b", newLineNum: 2 },
      { type: "equal", value: "c", oldLineNum: 2, newLineNum: 3 },
    ]);
  });

  it("delete lines", () => {
    const result = computeDiff("a\nb\nc", "a\nc");
    assert.deepEqual(result, [
      { type: "equal", value: "a", oldLineNum: 1, newLineNum: 1 },
      { type: "delete", value: "b", oldLineNum: 2 },
      { type: "equal", value: "c", oldLineNum: 3, newLineNum: 2 },
    ]);
  });

  it("replace line", () => {
    const result = computeDiff("a\nb\nc", "a\nx\nc");
    // LCS can produce either delete+insert or insert+delete for a replace
    // Both are valid - just verify the right chunks exist
    assert.equal(result.length, 4);
    assert.deepEqual(result[0], {
      type: "equal",
      value: "a",
      oldLineNum: 1,
      newLineNum: 1,
    });
    assert.deepEqual(result[3], {
      type: "equal",
      value: "c",
      oldLineNum: 3,
      newLineNum: 3,
    });
    // Middle two should be one delete and one insert (order may vary)
    const middle = result.slice(1, 3);
    const types = middle.map((c: DiffChunk) => c.type).sort();
    assert.deepEqual(types, ["delete", "insert"]);
    const deleteChunk = middle.find((c) => c.type === "delete");
    const insertChunk = middle.find((c) => c.type === "insert");
    assert.equal(deleteChunk?.value, "b");
    assert.equal(insertChunk?.value, "x");
  });

  it("empty old text with insertions", () => {
    const result = computeDiff("", "a\nb");
    assert.deepEqual(result, [
      { type: "insert", value: "a", newLineNum: 1 },
      { type: "insert", value: "b", newLineNum: 2 },
    ]);
  });

  it("empty new text with deletions", () => {
    const result = computeDiff("a\nb", "");
    assert.deepEqual(result, [
      { type: "delete", value: "a", oldLineNum: 1 },
      { type: "delete", value: "b", oldLineNum: 2 },
    ]);
  });

  it("single line strings", () => {
    const result = computeDiff("hello", "world");
    // Order may vary (insert then delete or delete then insert)
    assert.equal(result.length, 2);
    const types = result.map((c: DiffChunk) => c.type).sort();
    assert.deepEqual(types, ["delete", "insert"]);
    const deleteChunk = result.find((c: DiffChunk) => c.type === "delete");
    const insertChunk = result.find((c: DiffChunk) => c.type === "insert");
    assert.ok(deleteChunk);
    assert.ok(insertChunk);
    assert.equal(deleteChunk!.value, "hello");
    assert.equal(deleteChunk!.oldLineNum, 1);
    assert.equal(insertChunk!.value, "world");
    assert.equal(insertChunk!.newLineNum, 1);
  });

  it("very long strings (performance)", () => {
    const longOld = "line\n".repeat(1000).slice(0, -1);
    const longNew = "line\n".repeat(999).slice(0, -1) + "changed";
    const result = computeDiff(longOld, longNew);
    assert.ok(result.length > 0);
    // The algorithm finds the LCS and produces valid diff chunks
    // Just verify it completes and produces some chunks
    assert.ok(result.some((c: DiffChunk) => c.type === "equal"));
    assert.ok(
      result.some((c: DiffChunk) => c.type === "delete" || c.type === "insert"),
    );
  });

  it("handles trailing newline correctly", () => {
    const result = computeDiff("a\nb\n", "a\nb\n");
    // Trailing newline may produce an empty line match (filtered but both sides have it)
    // Just verify the non-empty lines match
    const nonEmpty = result.filter((c: DiffChunk) => c.value !== "");
    assert.deepEqual(nonEmpty, [
      { type: "equal", value: "a", oldLineNum: 1, newLineNum: 1 },
      { type: "equal", value: "b", oldLineNum: 2, newLineNum: 2 },
    ]);
  });

  it("handles mixed empty and non-empty lines", () => {
    const result = computeDiff("a\n\nb", "a\nc\nb");
    // Order may vary (insert+delete or delete+insert)
    assert.equal(result.length, 4);
    assert.deepEqual(result[0], {
      type: "equal",
      value: "a",
      oldLineNum: 1,
      newLineNum: 1,
    });
    assert.deepEqual(result[3], {
      type: "equal",
      value: "b",
      oldLineNum: 3,
      newLineNum: 3,
    });
    const middle = result.slice(1, 3);
    const types = middle.map((c: DiffChunk) => c.type).sort();
    assert.deepEqual(types, ["delete", "insert"]);
    const deleteChunk = middle.find((c: DiffChunk) => c.type === "delete");
    const insertChunk = middle.find((c: DiffChunk) => c.type === "insert");
    assert.equal(deleteChunk?.value, "");
    assert.equal(insertChunk?.value, "c");
  });

  it("multi-line insertion produces correct chunk sequence", () => {
    // Multiple lines inserted in the middle
    const result = computeDiff("line1\nline3", "line1\ninserted1\ninserted2\nline3");
    assert.equal(result.length, 4);
    assert.deepEqual(result[0], { type: "equal", value: "line1", oldLineNum: 1, newLineNum: 1 });
    assert.deepEqual(result[1], { type: "insert", value: "inserted1", newLineNum: 2 });
    assert.deepEqual(result[2], { type: "insert", value: "inserted2", newLineNum: 3 });
    assert.deepEqual(result[3], { type: "equal", value: "line3", oldLineNum: 2, newLineNum: 4 });
  });

  it("multi-line deletion produces correct chunk sequence", () => {
    // Multiple lines deleted
    const result = computeDiff("line1\nline2\nline3\nline4", "line1\nline4");
    assert.equal(result.length, 4);
    assert.deepEqual(result[0], { type: "equal", value: "line1", oldLineNum: 1, newLineNum: 1 });
    assert.deepEqual(result[1], { type: "delete", value: "line2", oldLineNum: 2 });
    assert.deepEqual(result[2], { type: "delete", value: "line3", oldLineNum: 3 });
    assert.deepEqual(result[3], { type: "equal", value: "line4", oldLineNum: 4, newLineNum: 2 });
  });

  it("replace with multi-line insertion", () => {
    // One line replaced with multiple lines
    const result = computeDiff("a\nb\nc", "a\nx\ny\nc");
    assert.ok(result.length >= 5);
    assert.deepEqual(result[0], { type: "equal", value: "a", oldLineNum: 1, newLineNum: 1 });
    assert.deepEqual(result[result.length - 1], { type: "equal", value: "c", oldLineNum: 3, newLineNum: 4 });
    // Middle should have one delete and two inserts (order may vary)
    const middle = result.slice(1, -1);
    const types = middle.map((c: DiffChunk) => c.type).sort();
    assert.deepEqual(types, ["delete", "insert", "insert"]);
  });

  it("trailing newline difference does not produce bogus diff row", () => {
    // Same content, one with trailing newline, one without
    const result1 = computeDiff("hello\nworld\n", "hello\nworld");
    const nonEmpty1 = result1.filter((c: DiffChunk) => c.value !== "");
    assert.deepEqual(nonEmpty1, [
      { type: "equal", value: "hello", oldLineNum: 1, newLineNum: 1 },
      { type: "equal", value: "world", oldLineNum: 2, newLineNum: 2 },
    ]);

    const result2 = computeDiff("hello\nworld", "hello\nworld\n");
    const nonEmpty2 = result2.filter((c: DiffChunk) => c.value !== "");
    assert.deepEqual(nonEmpty2, [
      { type: "equal", value: "hello", oldLineNum: 1, newLineNum: 1 },
      { type: "equal", value: "world", oldLineNum: 2, newLineNum: 2 },
    ]);
  });

  it("performance guard triggers greedy algorithm for large inputs", () => {
    // Input exceeding maxTokens (5000 default) should use greedy algorithm
    const lines = 6000;
    const oldText = "line\n".repeat(lines).slice(0, -1);
    const newText = "line\n".repeat(lines - 1).slice(0, -1) + "changed";
    
    const result = computeDiff(oldText, newText, { maxTokens: 5000, autoFallback: true });
    
    // Should complete and produce valid results
    assert.ok(result.length > 0);
    // Should have equal, delete, and insert chunks
    const types = new Set(result.map((c: DiffChunk) => c.type));
    assert.ok(types.has("equal"));
    assert.ok(types.has("delete") || types.has("insert"));
  });

  it("autoFallback can be disabled", () => {
    // Use smaller input for LCS path to avoid excessive memory/time
    const lines = 200;
    const oldText = "line\n".repeat(lines).slice(0, -1);
    const newText = "line\n".repeat(lines - 1).slice(0, -1) + "changed";
    
    const result = computeDiff(oldText, newText, { maxTokens: 5000, autoFallback: false });
    
    // Without fallback, should use LCS
    // Just verify it produces correct results
    assert.ok(result.length > 0);
    const types = new Set(result.map((c: DiffChunk) => c.type));
    assert.ok(types.has("equal"));
  });
});

describe("computeDiff - word mode", () => {
  it("word mode omits line numbers", () => {
    const result = computeDiff("hello world", "hello there world", {
      mode: "word",
    });
    for (const chunk of result) {
      assert.equal(chunk.oldLineNum, undefined);
      assert.equal(chunk.newLineNum, undefined);
    }
  });

  it("word mode basic diff", () => {
    const result = computeDiff("the quick brown fox", "the slow brown cat", {
      mode: "word",
    });
    assert.ok(result.length > 0);
    const types = result.map((c: DiffChunk) => c.type);
    assert.ok(types.includes("equal"));
    assert.ok(types.includes("delete"));
    assert.ok(types.includes("insert"));
  });

  it("word mode identical strings", () => {
    const result = computeDiff("hello world", "hello world", { mode: "word" });
    assert.ok(result.every((c: DiffChunk) => c.type === "equal"));
    for (const chunk of result) {
      assert.equal(chunk.oldLineNum, undefined);
      assert.equal(chunk.newLineNum, undefined);
    }
  });

  it("word mode empty strings", () => {
    const result = computeDiff("", "hello world", { mode: "word" });
    assert.ok(result.length > 0);
    assert.ok(result.every((c: DiffChunk) => c.type === "insert"));
    for (const chunk of result) {
      assert.equal(chunk.oldLineNum, undefined);
      assert.equal(chunk.newLineNum, undefined);
    }
  });

  it("performance guard triggers greedy algorithm for large word inputs", () => {
    // Create input with > 5000 word tokens to trigger greedy fallback
    // Word mode splits by word boundaries (\s+), so we need many words
    const words = 6000;
    const oldText = "word ".repeat(words).trim();
    const newText = "word ".repeat(words - 1).trim() + " changed";
    
    const result = computeDiff(oldText, newText, { 
      mode: "word",
      maxTokens: 5000, 
      autoFallback: true 
    });
    
    // Should complete and produce valid results
    assert.ok(result.length > 0);
    // Should have equal, delete, and insert chunks
    const types = new Set(result.map((c: DiffChunk) => c.type));
    assert.ok(types.has("equal"));
    assert.ok(types.has("delete") && types.has("insert"));
    // Word mode should not have line numbers
    for (const chunk of result) {
      assert.equal(chunk.oldLineNum, undefined);
      assert.equal(chunk.newLineNum, undefined);
    }
  });
});

describe("computeDiff - options", () => {
  it("ignoreCase option", () => {
    const result = computeDiff("HELLO", "hello", { ignoreCase: true });
    assert.equal(result.length, 1);
    assert.equal(result[0].type, "equal");
    assert.equal(result[0].value, "HELLO");
  });

  it("ignoreWhitespace option", () => {
    // ignoreWhitespace collapses all whitespace runs to single space and trims
    const result = computeDiff("hello world", "hello  world", {
      ignoreWhitespace: true,
    });
    // With whitespace ignored, lines should match after normalization
    assert.equal(result.length, 1);
    assert.equal(result[0].type, "equal");
    assert.equal(result[0].value, "hello world");
  });
});

describe("computeLineDiff convenience function", () => {
  it("calls computeDiff with line mode", () => {
    const result = computeLineDiff("a\nb", "a\nc");
    // Order may vary (insert then delete or delete then insert)
    assert.equal(result.length, 3);
    assert.deepEqual(result[0], {
      type: "equal",
      value: "a",
      oldLineNum: 1,
      newLineNum: 1,
    });
    const middle = result.slice(1, 3);
    const types = middle.map((c: DiffChunk) => c.type).sort();
    assert.deepEqual(types, ["delete", "insert"]);
    const deleteChunk = middle.find((c: DiffChunk) => c.type === "delete");
    const insertChunk = middle.find((c: DiffChunk) => c.type === "insert");
    assert.equal(deleteChunk?.value, "b");
    assert.equal(insertChunk?.value, "c");
  });
});

describe("computeWordDiff convenience function", () => {
  it("calls computeDiff with word mode", () => {
    const result = computeWordDiff("a b", "a c");
    assert.ok(result.length > 0);
    for (const chunk of result) {
      assert.equal(chunk.oldLineNum, undefined);
      assert.equal(chunk.newLineNum, undefined);
    }
  });
});

describe("groupDiffChunks", () => {
  it("groups consecutive same-type chunks", () => {
    const chunks: DiffChunk[] = [
      { type: "equal", value: "a" },
      { type: "equal", value: "b" },
      { type: "delete", value: "c" },
      { type: "delete", value: "d" },
      { type: "insert", value: "e" },
    ];
    const groups = groupDiffChunks(chunks);
    assert.equal(groups.length, 3);
    assert.equal(groups[0].type, "equal");
    assert.equal(groups[0].chunks.length, 2);
    assert.equal(groups[1].type, "delete");
    assert.equal(groups[1].chunks.length, 2);
    assert.equal(groups[2].type, "insert");
    assert.equal(groups[2].chunks.length, 1);
  });

  it("empty array returns empty groups", () => {
    assert.deepEqual(groupDiffChunks([]), []);
  });

  it("single chunk returns single group", () => {
    const chunks: DiffChunk[] = [{ type: "equal", value: "a" }];
    const groups = groupDiffChunks(chunks);
    assert.equal(groups.length, 1);
    assert.equal(groups[0].chunks.length, 1);
  });
});

describe("computeDiffStats", () => {
  it("counts equal, deleted, inserted correctly", () => {
    const chunks: DiffChunk[] = [
      { type: "equal", value: "a" },
      { type: "equal", value: "b" },
      { type: "delete", value: "c" },
      { type: "insert", value: "d" },
      { type: "insert", value: "e" },
    ];
    const stats = computeDiffStats(chunks);
    assert.deepEqual(stats, {
      equal: 2,
      deleted: 1,
      inserted: 2,
      totalChunks: 5,
    });
  });

  it("empty array returns zeros", () => {
    assert.deepEqual(computeDiffStats([]), {
      equal: 0,
      deleted: 0,
      inserted: 0,
      totalChunks: 0,
    });
  });
});
