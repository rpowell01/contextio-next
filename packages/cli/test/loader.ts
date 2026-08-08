import { describe, it, before, after, beforeEach } from "node:test";
import assert from "node:assert/strict";

// Just import the test module to trigger any syntax/import errors
await import("./captures.test.ts");

console.log("Test module loaded successfully");
