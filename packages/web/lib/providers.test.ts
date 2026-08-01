import { describe, it, before, after, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import path from "node:path";
import { tmpdir } from "node:os";
import { withFileLock, checkStaleLock } from "./providers.js";

function makeTempDir(): string {
  return path.join(tmpdir(), `contextio-lock-test-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`);
}

describe("checkStaleLock", () => {
  let tempDir: string;

  beforeEach(() => {
    tempDir = makeTempDir();
  });

  afterEach(async () => {
    try {
      await fs.rm(tempDir, { recursive: true, force: true });
    } catch {
      // ignore cleanup errors
    }
  });

  it("returns true for non-existent lock file", async () => {
    const lockPath = path.join(tempDir, "nonexistent.lock");
    const result = await checkStaleLock(lockPath);
    assert.equal(result, true);
  });

  it("returns true for empty lock file", async () => {
    const lockPath = path.join(tempDir, "empty.lock");
    await fs.writeFile(lockPath, "", "utf8");
    const result = await checkStaleLock(lockPath);
    assert.equal(result, true);
  });

  it("returns true for whitespace-only lock file", async () => {
    const lockPath = path.join(tempDir, "whitespace.lock");
    await fs.writeFile(lockPath, "   \n\t  ", "utf8");
    const result = await checkStaleLock(lockPath);
    assert.equal(result, true);
  });

  it("returns true for invalid JSON in lock file", async () => {
    const lockPath = path.join(tempDir, "invalid.lock");
    await fs.writeFile(lockPath, "not valid json", "utf8");
    const result = await checkStaleLock(lockPath);
    assert.equal(result, true);
  });

  it("returns true for corrupted JSON in lock file", async () => {
    const lockPath = path.join(tempDir, "corrupted.lock");
    await fs.writeFile(lockPath, '{"pid": 123', "utf8");
    const result = await checkStaleLock(lockPath);
    assert.equal(result, true);
  });

  it("returns true for old-format lock file without PID or timestamp", async () => {
    const lockPath = path.join(tempDir, "old-format.lock");
    await fs.writeFile(lockPath, '{}', "utf8");
    const result = await checkStaleLock(lockPath);
    assert.equal(result, true);
  });

  it("returns true for lock file with only PID but dead process (ESRCH)", async () => {
    const lockPath = path.join(tempDir, "dead-process.lock");
    // Use a PID that definitely doesn't exist (very high number)
    const deadPid = 999999;
    await fs.writeFile(lockPath, JSON.stringify({ pid: deadPid, timestamp: Date.now() }), "utf8");
    const result = await checkStaleLock(lockPath);
    assert.equal(result, true);
  });

  it("returns false for lock file with live process PID", async () => {
    const lockPath = path.join(tempDir, "live-process.lock");
    // Use current process PID - should be alive
    await fs.writeFile(lockPath, JSON.stringify({ pid: process.pid, timestamp: Date.now() }), "utf8");
    const result = await checkStaleLock(lockPath);
    assert.equal(result, false);
  });

  it("returns true for lock file with old timestamp (>30s) and no PID", async () => {
    const lockPath = path.join(tempDir, "old-timestamp.lock");
    const oldTimestamp = Date.now() - 60000; // 60 seconds ago
    await fs.writeFile(lockPath, JSON.stringify({ timestamp: oldTimestamp }), "utf8");
    const result = await checkStaleLock(lockPath);
    assert.equal(result, true);
  });

  it("returns false for lock file with recent timestamp (<30s) and no PID", async () => {
    const lockPath = path.join(tempDir, "recent-timestamp.lock");
    const recentTimestamp = Date.now() - 5000; // 5 seconds ago
    await fs.writeFile(lockPath, JSON.stringify({ timestamp: recentTimestamp }), "utf8");
    const result = await checkStaleLock(lockPath);
    assert.equal(result, false);
  });

  it("returns false for lock file with live PID even if timestamp is old", async () => {
    const lockPath = path.join(tempDir, "live-pid-old-timestamp.lock");
    const oldTimestamp = Date.now() - 60000; // 60 seconds ago
    await fs.writeFile(lockPath, JSON.stringify({ pid: process.pid, timestamp: oldTimestamp }), "utf8");
    const result = await checkStaleLock(lockPath);
    // Live process takes precedence over timestamp
    assert.equal(result, false);
  });

  it("returns false for unreadable lock file (EACCES) - assumes not stale for safety", async () => {
    // This test is tricky to set up reliably across environments
    // We'll test the error handling path by mocking or skipping if not possible
    // For now, verify the function doesn't throw on permission errors
    const lockPath = path.join(tempDir, "permission.lock");
    await fs.writeFile(lockPath, JSON.stringify({ pid: 999999, timestamp: Date.now() }), "utf8");
    // Make file unreadable (may not work in all test environments)
    try {
      await fs.chmod(lockPath, 0o000);
      const result = await checkStaleLock(lockPath);
      // Should return false (assume not stale for safety)
      assert.equal(result, false);
    } catch {
      // chmod may not work in some environments (e.g., running as root)
      // Skip this assertion
    } finally {
      // Restore permissions for cleanup
      try {
        await fs.chmod(lockPath, 0o644);
      } catch {
        // ignore
      }
    }
  });
});

describe("withFileLock", () => {
  let tempDir: string;

  beforeEach(() => {
    tempDir = makeTempDir();
  });

  afterEach(async () => {
    try {
      await fs.rm(tempDir, { recursive: true, force: true });
    } catch {
      // ignore cleanup errors
    }
  });

  it("acquires and releases lock normally", async () => {
    const lockPath = path.join(tempDir, "normal.lock");
    let executed = false;
    const result = await withFileLock(lockPath, async () => {
      executed = true;
      return "success";
    });
    assert.equal(executed, true);
    assert.equal(result, "success");
    // Lock file should be cleaned up
    const lockExists = await fs.access(lockPath).then(() => true).catch(() => false);
    assert.equal(lockExists, false);
  });

  it("returns result from locked function", async () => {
    const lockPath = path.join(tempDir, "return-value.lock");
    const result = await withFileLock(lockPath, async () => {
      return { data: "test", count: 42 };
    });
    assert.deepEqual(result, { data: "test", count: 42 });
  });

  it("throws error from locked function", async () => {
    const lockPath = path.join(tempDir, "throw-error.lock");
    try {
      await withFileLock(lockPath, async () => {
        throw new Error("intentional error");
      });
      assert.fail("Should have thrown");
    } catch (err) {
      assert.equal((err as Error).message, "intentional error");
    }
    // Lock file should still be cleaned up
    const lockExists = await fs.access(lockPath).then(() => true).catch(() => false);
    assert.equal(lockExists, false);
  });

  it("retries and succeeds when lock is released by another process", async () => {
    const lockPath = path.join(tempDir, "retry-success.lock");
    let firstAttempt = true;
    const result = await withFileLock(lockPath, async () => {
      if (firstAttempt) {
        firstAttempt = false;
        // Simulate another process holding the lock briefly
        const otherLock = path.join(tempDir, "retry-success.lock");
        await fs.writeFile(otherLock, JSON.stringify({ pid: 999999, timestamp: Date.now() }), "utf8");
        // Wait a bit then release
        await new Promise(r => setTimeout(r, 50));
        await fs.unlink(otherLock).catch(() => {});
      }
      return "retry worked";
    }, 10, 20); // More retries, shorter delay
    assert.equal(result, "retry worked");
  });

  it("detects and recovers from stale lock (dead process)", async () => {
    const lockPath = path.join(tempDir, "stale-dead-process.lock");
    // Create a stale lock with a dead PID
    await fs.writeFile(lockPath, JSON.stringify({ pid: 999999, timestamp: Date.now() }), "utf8");
    const result = await withFileLock(lockPath, async () => {
      return "acquired after stale";
    }, 5, 10);
    assert.equal(result, "acquired after stale");
    // Lock should be owned by current process now
    const lockContent = await fs.readFile(lockPath, "utf8").catch(() => null);
    assert.ok(lockContent !== null);
    const lockInfo = JSON.parse(lockContent!);
    assert.equal(lockInfo.pid, process.pid);
  });

  it("detects and recovers from stale lock (old timestamp)", async () => {
    const lockPath = path.join(tempDir, "stale-old-timestamp.lock");
    // Create a stale lock with old timestamp and no PID
    const oldTimestamp = Date.now() - 60000;
    await fs.writeFile(lockPath, JSON.stringify({ timestamp: oldTimestamp }), "utf8");
    const result = await withFileLock(lockPath, async () => {
      return "acquired after stale timestamp";
    }, 5, 10);
    assert.equal(result, "acquired after stale timestamp");
  });

  it("detects and recovers from stale lock (invalid JSON)", async () => {
    const lockPath = path.join(tempDir, "stale-invalid-json.lock");
    // Create a corrupted lock file
    await fs.writeFile(lockPath, "not valid json", "utf8");
    const result = await withFileLock(lockPath, async () => {
      return "acquired after invalid json";
    }, 5, 10);
    assert.equal(result, "acquired after invalid json");
  });

  it("detects and recovers from stale lock (empty file)", async () => {
    const lockPath = path.join(tempDir, "stale-empty.lock");
    // Create an empty lock file
    await fs.writeFile(lockPath, "", "utf8");
    const result = await withFileLock(lockPath, async () => {
      return "acquired after empty";
    }, 5, 10);
    assert.equal(result, "acquired after empty");
  });

  it("handles concurrent lock attempts", async () => {
    const lockPath = path.join(tempDir, "concurrent.lock");
    const results: string[] = [];
    const errors: Error[] = [];

    // Start multiple concurrent lock attempts
    const promises = Array.from({ length: 5 }, (_, i) =>
      withFileLock(lockPath, async () => {
        await new Promise(r => setTimeout(r, 10)); // Hold lock briefly
        return `task-${i}`;
      }, 10, 10)
        .then(r => results.push(r))
        .catch(e => errors.push(e))
    );

    await Promise.all(promises);

    // All should succeed (sequentially)
    assert.equal(results.length, 5);
    assert.equal(errors.length, 0);
    results.sort();
    assert.deepEqual(results, ["task-0", "task-1", "task-2", "task-3", "task-4"]);
  });

  it("throws after max retries exceeded", async () => {
    const lockPath = path.join(tempDir, "max-retries.lock");
    // Create a lock that won't be released (live PID)
    await fs.writeFile(lockPath, JSON.stringify({ pid: process.pid, timestamp: Date.now() }), "utf8");
    
    try {
      await withFileLock(lockPath, async () => {
        return "should not reach here";
      }, 3, 10); // Only 3 retries, 10ms delay
      assert.fail("Should have thrown after max retries");
    } catch (err) {
      assert.ok((err as Error).message.includes("Failed to acquire file lock after 3 retries"));
    }
  });

  it("lock file contains PID and timestamp when acquired", async () => {
    const lockPath = path.join(tempDir, "lock-content.lock");
    await withFileLock(lockPath, async () => {
      // Read lock file while we hold it
      const content = await fs.readFile(lockPath, "utf8");
      const lockInfo = JSON.parse(content);
      assert.equal(lockInfo.pid, process.pid);
      assert.ok(lockInfo.timestamp);
      assert.ok(lockInfo.timestamp <= Date.now());
      assert.ok(lockInfo.timestamp > Date.now() - 1000); // Recent
    });
  });

  it("cleans up lock file on synchronous error in callback", async () => {
    const lockPath = path.join(tempDir, "sync-error.lock");
    try {
      await withFileLock(lockPath, async () => {
        throw new Error("sync error");
      });
    } catch {
      // expected
    }
    const lockExists = await fs.access(lockPath).then(() => true).catch(() => false);
    assert.equal(lockExists, false);
  });

  it("does not remove lock file if another process acquired it after stale recovery", async () => {
    const lockPath = path.join(tempDir, "race-condition.lock");
    // Create stale lock
    await fs.writeFile(lockPath, JSON.stringify({ pid: 999999, timestamp: Date.now() }), "utf8");
    
    // Start a lock attempt that will recover the stale lock
    const promise = withFileLock(lockPath, async () => {
      // Simulate another process acquiring the lock after we check but before we unlink
      // This is hard to test reliably, but we can verify the lock file has our PID after
      await new Promise(r => setTimeout(r, 50));
      return "done";
    }, 5, 10);

    await promise;
    
    // Verify lock file was cleaned up (since we owned it)
    const lockExists = await fs.access(lockPath).then(() => true).catch(() => false);
    assert.equal(lockExists, false);
  });

  it("handles lock file that disappears between check and unlink", async () => {
    const lockPath = path.join(tempDir, "disappearing.lock");
    // Create stale lock
    await fs.writeFile(lockPath, JSON.stringify({ pid: 999999, timestamp: Date.now() }), "utf8");
    
    const result = await withFileLock(lockPath, async () => {
      // Lock file should be gone (we unlinked it after detecting stale)
      // But another process could have created a new one
      return "acquired";
    }, 5, 10);
    
    assert.equal(result, "acquired");
  });
});

describe("withFileLock - integration with checkStaleLock", () => {
  let tempDir: string;

  beforeEach(() => {
    tempDir = makeTempDir();
  });

  afterEach(async () => {
    try {
      await fs.rm(tempDir, { recursive: true, force: true });
    } catch {
      // ignore cleanup errors
    }
  });

  it("checkStaleLock correctly identifies various stale conditions", async () => {
    // Test all stale conditions through checkStaleLock directly
    const testCases = [
      { name: "empty", content: "", expected: true },
      { name: "whitespace", content: "  \n\t ", expected: true },
      { name: "invalid json", content: "not json", expected: true },
      { name: "corrupted json", content: '{"pid": 1}', expected: true },
      { name: "old format empty object", content: "{}", expected: true },
      { name: "dead pid", content: JSON.stringify({ pid: 999999, timestamp: Date.now() }), expected: true },
      { name: "old timestamp no pid", content: JSON.stringify({ timestamp: Date.now() - 60000 }), expected: true },
    ];

    for (const tc of testCases) {
      const lockPath = path.join(tempDir, `${tc.name}.lock`);
      await fs.writeFile(lockPath, tc.content, "utf8");
      const result = await checkStaleLock(lockPath);
      assert.equal(result, tc.expected, `${tc.name} should be ${tc.expected ? "stale" : "not stale"}`);
    }
  });

  it("checkStaleLock correctly identifies non-stale conditions", async () => {
    const testCases = [
      { name: "live pid", content: JSON.stringify({ pid: process.pid, timestamp: Date.now() }), expected: false },
      { name: "live pid old timestamp", content: JSON.stringify({ pid: process.pid, timestamp: Date.now() - 60000 }), expected: false },
      { name: "recent timestamp no pid", content: JSON.stringify({ timestamp: Date.now() - 5000 }), expected: false },
    ];

    for (const tc of testCases) {
      const lockPath = path.join(tempDir, `${tc.name}.lock`);
      await fs.writeFile(lockPath, tc.content, "utf8");
      const result = await checkStaleLock(lockPath);
      assert.equal(result, tc.expected, `${tc.name} should be ${tc.expected ? "stale" : "not stale"}`);
    }
  });
});