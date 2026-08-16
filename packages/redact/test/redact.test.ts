import { describe, it } from "node:test";
import assert from "node:assert/strict";

import { createStats, redactValue, redactWithPolicy } from "../dist/redact.js";
import { PRESETS } from "../dist/presets.js";
import { compilePolicy, fromPreset } from "../dist/policy.js";
import { ReplacementMap } from "../dist/mapping.js";
import { createStreamRehydrator } from "../dist/stream.js";
import type { RedactionRule } from "../dist/rules.js";

// --- Legacy API tests (redactValue) ---

describe("redactValue (legacy API)", () => {
  const rules = PRESETS.pii;
  const allowlist = new Set<string>();

  it("redacts email addresses", async () => {
    const stats = createStats();
    const result = await redactValue(
      "Contact me at john.doe@example.com please",
      rules,
      allowlist,
      stats,
    );
    assert.equal(result, "Contact me at [EMAIL_REDACTED] please");
    assert.equal(stats.totalReplacements, 1);
    assert.equal(stats.byRule["email"], 1);
  });

  it("redacts AWS access keys", async () => {
    const stats = createStats();
    const result = await redactValue(
      "key: AKIAIOSFODNN7EXAMPLE",
      rules,
      allowlist,
      stats,
    );
    assert.equal(result, "key: [AWS_KEY_REDACTED]");
  });

  it("redacts GitHub tokens", async () => {
    const stats = createStats();
    const result = await redactValue(
      "token: ghp_ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmn",
      rules,
      allowlist,
      stats,
    );
    assert.equal(result, "token: [GITHUB_TOKEN_REDACTED]");
  });

  it("redacts PEM private keys", async () => {
    const stats = createStats();
    const pem =
      "-----BEGIN RSA PRIVATE KEY-----\nMIIBogIBAAJBALRi...\n-----END RSA PRIVATE KEY-----";
    const result = await redactValue(
      `Here is a key: ${pem}`,
      rules,
      allowlist,
      stats,
    );
    assert.equal(result, "Here is a key: [PRIVATE_KEY_REDACTED]");
  });

  it("respects allowlist", async () => {
    const stats = createStats();
    const allowed = new Set(["keep@example.com"]);
    const result = await redactValue(
      "Contact keep@example.com or other@example.com",
      rules,
      allowed,
      stats,
    );
    assert.equal(result, "Contact keep@example.com or [EMAIL_REDACTED]");
    assert.equal(stats.totalReplacements, 1);
  });

  it("walks nested objects", async () => {
    const stats = createStats();
    const input = {
      model: "claude-3",
      messages: [{ role: "user", content: "Email me at user@test.com" }],
    };
    const result = await redactValue(input, rules, allowlist, stats) as any;
    assert.equal(result.messages[0].content, "Email me at [EMAIL_REDACTED]");
  });

  it("passes through non-string primitives", async () => {
    const stats = createStats();
    assert.equal(await redactValue(42, rules, allowlist, stats), 42);
    assert.equal(await redactValue(true, rules, allowlist, stats), true);
    assert.equal(await redactValue(null, rules, allowlist, stats), null);
  });

  it("does not mutate the original object", async () => {
    const stats = createStats();
    const input = { msg: "user@test.com" };
    const result = await redactValue(input, rules, allowlist, stats) as any;
    assert.equal(input.msg, "user@test.com");
    assert.equal(result.msg, "[EMAIL_REDACTED]");
  });
});

// --- Policy API tests ---

describe("presets", () => {
  it("secrets preset catches API keys but not emails", async () => {
    const policy = fromPreset("secrets");
    const stats = createStats();
    const result = await redactWithPolicy(
      "key: AKIAIOSFODNN7EXAMPLE and john@test.com",
      policy,
      stats,
    );
    assert.equal(result, "key: [AWS_KEY_REDACTED] and john@test.com");
    assert.equal(stats.totalReplacements, 1);
  });

  it("pii preset catches secrets and emails", async () => {
    const policy = fromPreset("pii");
    const stats = createStats();
    const result = await redactWithPolicy(
      "key: AKIAIOSFODNN7EXAMPLE and john@test.com",
      policy,
      stats,
    );
    assert.equal(result, "key: [AWS_KEY_REDACTED] and [EMAIL_REDACTED]");
    assert.equal(stats.totalReplacements, 2);
  });

  it("strict preset catches IPs", async () => {
    const policy = fromPreset("strict");
    const stats = createStats();
    const result = await redactWithPolicy("server at 192.168.1.100", policy, stats);
    assert.equal(result, "server at [IP_REDACTED]");
  });

  it("pii preset catches IBAN with context word", async () => {
    const policy = fromPreset("pii");
    const stats = createStats();
    const result = await redactWithPolicy(
      "My bank account IBAN is NL91 ABNA 0417 1643 00",
      policy,
      stats,
    );
    assert.ok((result as string).includes("[IBAN_REDACTED]"));
    assert.equal(stats.byRule["iban"], 1);
  });

  it("pii preset catches IBAN without spaces", async () => {
    const policy = fromPreset("pii");
    const stats = createStats();
    const result = await redactWithPolicy(
      "Transfer to IBAN: DE89370400440532013000 please",
      policy,
      stats,
    );
    assert.ok((result as string).includes("[IBAN_REDACTED]"));
  });

  it("pii preset does not redact IBAN without context", async () => {
    const policy = fromPreset("pii");
    const stats = createStats();
    const result = await redactWithPolicy(
      "The code NL91ABNA0417164300 is a reference",
      policy,
      stats,
    );
    assert.ok(!(result as string).includes("[IBAN_REDACTED]"));
    assert.equal(stats.byRule["iban"] ?? 0, 0);
  });

  it("pii preset catches EU phone numbers with context", async () => {
    const policy = fromPreset("pii");
    const stats = createStats();
    const result = await redactWithPolicy(
      "My mobile number is +31 6 12345678",
      policy,
      stats,
    );
    assert.ok((result as string).includes("[PHONE_REDACTED]"));
    assert.ok(stats.byRule["phone-eu"] >= 1);
  });

  it("pii preset catches UK phone number with context", async () => {
    const policy = fromPreset("pii");
    const stats = createStats();
    const result = await redactWithPolicy(
      "Call me at +44 20 7946 0958",
      policy,
    stats,
    );
    assert.ok((result as string).includes("[PHONE_REDACTED]"));
  });

  it("pii preset catches German phone number with context", async () => {
    const policy = fromPreset("pii");
    const stats = createStats();
    const result = await redactWithPolicy(
      "Phone: +49 170 1234567",
      policy,
      stats,
    );
    assert.ok((result as string).includes("[PHONE_REDACTED]"));
  });

  it("pii preset catches French phone number with context", async () => {
    const policy = fromPreset("pii");
    const stats = createStats();
    const result = await redactWithPolicy(
      "Call me at +33 6 12 34 56 78",
      policy,
      stats,
    );
    assert.ok((result as string).includes("[PHONE_REDACTED]"));
  });

  it("pii preset catches Italian phone number with context", async () => {
    const policy = fromPreset("pii");
    const stats = createStats();
    const result = await redactWithPolicy(
      "My mobile is +39 347 1234567",
      policy,
      stats,
    );
    assert.ok((result as string).includes("[PHONE_REDACTED]"));
  });

  it("pii preset does not redact EU phone without context", async () => {
    const policy = fromPreset("pii");
    const stats = createStats();
    const result = await redactWithPolicy(
      "The product code is +31-612-345-678",
      policy,
      stats,
    );
    assert.ok(!(result as string).includes("[PHONE_REDACTED]"));
  });

  it("strict preset catches Dutch BSN with context", async () => {
    const policy = fromPreset("strict");
    const stats = createStats();
    const result = await redactWithPolicy(
      "My BSN is 123456782",
      policy,
      stats,
    );
    assert.ok((result as string).includes("[BSN_REDACTED]"));
    assert.equal(stats.byRule["bsn-dutch"], 1);
  });

  it("strict preset catches BSN with 'burgerservicenummer' context", async () => {
    const policy = fromPreset("strict");
    const stats = createStats();
    const result = await redactWithPolicy(
      "Burgerservicenummer: 123456782",
      policy,
      stats,
    );
    assert.ok((result as string).includes("[BSN_REDACTED]"));
  });

  it("strict preset does not redact BSN without context", async () => {
    const policy = fromPreset("strict");
    const stats = createStats();
    const result = await redactWithPolicy(
      "Order reference: 123456782",
      policy,
      stats,
    );
    assert.ok(!(result as string).includes("[BSN_REDACTED]"));
    assert.equal(stats.byRule["bsn-dutch"] ?? 0, 0);
  });

  it("strict preset catches UK NI number with context", async () => {
    const policy = fromPreset("strict");
    const stats = createStats();
    const result = await redactWithPolicy(
      "My NI number is AB 12 34 56 C",
      policy,
      stats,
    );
    assert.ok((result as string).includes("[NI_NUMBER_REDACTED]"));
    assert.equal(stats.byRule["ni-number-uk"], 1);
  });

  it("strict preset catches UK NI number without spaces", async () => {
    const policy = fromPreset("strict");
    const stats = createStats();
    const result = await redactWithPolicy(
      "National Insurance: AB123456C",
      policy,
      stats,
    );
    assert.ok((result as string).includes("[NI_NUMBER_REDACTED]"));
  });

  it("strict preset does not redact NI number without context", async () => {
    const policy = fromPreset("strict");
    const stats = createStats();
    const result = await redactWithPolicy(
      "The code AB123456C is invalid",
      policy,
      stats,
    );
    assert.ok(!(result as string).includes("[NI_NUMBER_REDACTED]"));
    assert.equal(stats.byRule["ni-number-uk"] ?? 0, 0);
  });

  it("strict preset catches passport number with context", async () => {
    const policy = fromPreset("strict");
    const stats = createStats();
    const result = await redactWithPolicy(
      "My passport number is X12345678",
      policy,
      stats,
    );
    assert.ok((result as string).includes("[PASSPORT_REDACTED]"));
    assert.equal(stats.byRule["passport-number"], 1);
  });

  it("strict preset catches passport number with 'paspoort' context", async () => {
    const policy = fromPreset("strict");
    const stats = createStats();
    const result = await redactWithPolicy(
      "Paspoort: AB987654",
      policy,
      stats,
    );
    assert.ok((result as string).includes("[PASSPORT_REDACTED]"));
  });

  it("strict preset does not redact passport-like strings without context", async () => {
    const policy = fromPreset("strict");
    const stats = createStats();
    const result = await redactWithPolicy(
      "The product code X12345678 is discontinued",
      policy,
      stats,
    );
    assert.ok(!(result as string).includes("[PASSPORT_REDACTED]"));
    assert.equal(stats.byRule["passport-number"] ?? 0, 0);
  });
});

describe("context words", () => {
  it("SSN with context word is redacted in pii preset", async () => {
    const policy = fromPreset("pii");
    const stats = createStats();
    const result = await redactWithPolicy(
      "My social security number is 123-45-6789",
      policy,
      stats,
    );
    assert.equal(
      result,
      "My social security number is [SSN_REDACTED]",
    );
  });

  it("SSN-like pattern without context word is not redacted", async () => {
    const policy = fromPreset("pii");
    const stats = createStats();
    const result = await redactWithPolicy(
      "Order number 123-45-6789 shipped",
      policy,
      stats,
    );
    assert.equal(result, "Order number 123-45-6789 shipped");
    assert.equal(stats.totalReplacements, 0);
  });

  it("credit card with context word is redacted", async () => {
    const policy = fromPreset("pii");
    const stats = createStats();
    const result = await redactWithPolicy(
      "Please charge my credit card 4111-1111-1111-1111",
      policy,
      stats,
    );
    assert.ok((result as string).includes("[CC_REDACTED]"));
  });

  it("credit card without context word is not redacted", async () => {
    const policy = fromPreset("pii");
    const stats = createStats();
    const result = await redactWithPolicy(
      "Reference 4111-1111-1111-1111 for tracking",
      policy,
      stats,
    );
    assert.ok(!(result as string).includes("[CC_REDACTED]"));
  });
});

describe("custom policy", () => {
  it("compiles custom rules from JSON", async () => {
    const policy = compilePolicy({
      rules: [
        {
          id: "employee-id",
          pattern: "EMP-\\d{5}",
          replacement: "[EMPLOYEE_REDACTED]",
        },
      ],
    });
    const stats = createStats();
    const result = await redactWithPolicy("Employee EMP-12345 assigned", policy, stats);
    assert.equal(result, "Employee [EMPLOYEE_REDACTED] assigned");
  });

  it("extends a preset with custom rules", async () => {
    const policy = compilePolicy({
      extends: "secrets",
      rules: [
        {
          id: "project-name",
          pattern: "(?i)project[- ](?:atlas|phoenix)",
          replacement: "[PROJECT_REDACTED]",
        },
      ],
    });
    const stats = createStats();
    const result = await redactWithPolicy(
      "Working on Project Atlas with key AKIAIOSFODNN7EXAMPLE",
      policy,
      stats,
    );
    assert.ok((result as string).includes("[PROJECT_REDACTED]"));
    assert.ok((result as string).includes("[AWS_KEY_REDACTED]"));
  });

  it("allowlist strings prevent redaction", async () => {
    const policy = compilePolicy({
      extends: "pii",
      allowlist: { strings: ["admin@company.com"] },
    });
    const stats = createStats();
    const result = await redactWithPolicy(
      "Contact admin@company.com or user@test.com",
      policy,
      stats,
    );
    assert.equal(
      result,
      "Contact admin@company.com or [EMAIL_REDACTED]",
    );
  });

  it("allowlist patterns prevent redaction", async () => {
    const policy = compilePolicy({
      extends: "pii",
      allowlist: { patterns: ["test-\\d+@example\\.com"] },
    });
    const stats = createStats();
    const result = await redactWithPolicy(
      "Contact test-42@example.com or user@test.com",
      policy,
      stats,
    );
    assert.equal(
      result,
      "Contact test-42@example.com or [EMAIL_REDACTED]",
    );
  });
});

describe("path filtering", () => {
  it("skip paths are not redacted", async () => {
    const policy = compilePolicy({
      extends: "pii",
      paths: { skip: ["model", "messages[*].role"] },
    });
    const stats = createStats();
    const input = {
      model: "sk-secret-key-that-looks-like-api-key-12345678",
      messages: [
        { role: "user@test.com", content: "My email is real@test.com" },
      ],
    };
    const result = await redactWithPolicy(input, policy, stats) as any;
    // model and role should be untouched
    assert.equal(result.model, input.model);
    assert.equal(result.messages[0].role, "user@test.com");
    // content should be redacted
    assert.ok(result.messages[0].content.includes("[EMAIL_REDACTED]"));
  });

  it("only paths restricts redaction to those paths", async () => {
    const policy = compilePolicy({
      extends: "pii",
      paths: { only: ["messages[*].content"] },
    });
    const stats = createStats();
    const input = {
      metadata: { author: "user@test.com" },
      messages: [
        { role: "user", content: "Email me at real@test.com" },
      ],
    };
    const result = await redactWithPolicy(input, policy, stats) as any;
    // metadata.author should be untouched (not in "only" paths)
    assert.equal(result.metadata.author, "user@test.com");
    // content should be redacted
    assert.ok(result.messages[0].content.includes("[EMAIL_REDACTED]"));
  });
});

describe("error handling", () => {
  it("unknown preset throws", async () => {
    assert.throws(
      () => compilePolicy({ extends: "nonexistent" as any }),
      /Unknown preset/,
    );
  });
});

// --- ReplacementMap tests ---

describe("ReplacementMap", () => {
  it("generates numbered placeholders per rule", async () => {
    const map = new ReplacementMap();
    assert.equal(map.getOrCreate("john@test.com", "email"), "[EMAIL_1]");
    assert.equal(map.getOrCreate("jane@test.com", "email"), "[EMAIL_2]");
    assert.equal(map.getOrCreate("123-45-6789", "ssn"), "[SSN_1]");
  });

  it("returns the same placeholder for the same original", async () => {
    const map = new ReplacementMap();
    const first = map.getOrCreate("john@test.com", "email");
    const second = map.getOrCreate("john@test.com", "email");
    assert.equal(first, second);
    assert.equal(map.size, 1);
  });

  it("rehydrates all placeholders in a string", async () => {
    const map = new ReplacementMap();
    map.getOrCreate("john@test.com", "email");
    map.getOrCreate("123-45-6789", "ssn");

    const redacted = "Your email is [EMAIL_1] and your SSN is [SSN_1].";
    const restored = map.rehydrate(redacted);
    assert.equal(restored, "Your email is john@test.com and your SSN is 123-45-6789.");
  });

  it("rehydrates repeated placeholders", async () => {
    const map = new ReplacementMap();
    map.getOrCreate("john@test.com", "email");

    const redacted = "Sent to [EMAIL_1]. Confirmed: [EMAIL_1].";
    assert.equal(
      map.rehydrate(redacted),
      "Sent to john@test.com. Confirmed: john@test.com.",
    );
  });

  it("handles no matches gracefully", async () => {
    const map = new ReplacementMap();
    assert.equal(map.rehydrate("no placeholders here"), "no placeholders here");
  });
});

// --- Reversible redaction (end-to-end with policy) ---

describe("reversible redaction", () => {
  it("redacts with numbered placeholders when map is provided", async () => {
    const policy = fromPreset("pii");
    const stats = createStats();
    const map = new ReplacementMap();

    const result = await redactWithPolicy(
      "Email john@test.com and jane@test.com",
      policy,
      stats,
      [],
      map,
    );

    assert.equal(result, "Email [EMAIL_1] and [EMAIL_2]");
    assert.equal(map.size, 2);
  });

  it("same email in same request gets same placeholder", async () => {
    const policy = fromPreset("pii");
    const stats = createStats();
    const map = new ReplacementMap();

    const result = await redactWithPolicy(
      "From john@test.com to john@test.com",
      policy,
      stats,
      [],
      map,
    );

    assert.equal(result, "From [EMAIL_1] to [EMAIL_1]");
    assert.equal(map.size, 1);
  });

  it("map persists across multiple redaction calls", async () => {
    const policy = fromPreset("pii");
    const map = new ReplacementMap();

    // First request
    const stats1 = createStats();
    await redactWithPolicy("From john@test.com", policy, stats1, [], map);

    // Second request (same email should get same placeholder)
    const stats2 = createStats();
    const result = await redactWithPolicy(
      "Also cc john@test.com and new@test.com",
      policy,
      stats2,
      [],
      map,
    );

    assert.equal(result, "Also cc [EMAIL_1] and [EMAIL_2]");
    assert.equal(map.size, 2);
  });

  it("round-trips through redact then rehydrate", async () => {
    const policy = fromPreset("pii");
    const stats = createStats();
    const map = new ReplacementMap();

    const original = "Contact john@test.com. My SSN is 123-45-6789.";
    const redacted = await redactWithPolicy(original, policy, stats, [], map) as string;

    // Simulate LLM echoing the redacted content
    const llmResponse = `Got it, I'll email ${redacted.includes("[EMAIL_1]") ? "[EMAIL_1]" : "??"} about SSN ${redacted.includes("[SSN_1]") ? "[SSN_1]" : "??"}`;

    const restored = map.rehydrate(llmResponse);
    assert.equal(
      restored,
      "Got it, I'll email john@test.com about SSN 123-45-6789",
    );
  });

  it("works with nested objects", async () => {
    const policy = fromPreset("pii");
    const stats = createStats();
    const map = new ReplacementMap();

    const input = {
      messages: [
        { role: "user", content: "My email is john@test.com" },
      ],
    };

    const result = await redactWithPolicy(input, policy, stats, [], map) as any;
    assert.equal(result.messages[0].content, "My email is [EMAIL_1]");

    // Rehydrate simulated response
    const responseBody = '{"content": "Noted, [EMAIL_1] is your email."}';
    const restored = map.rehydrate(responseBody);
    assert.equal(restored, '{"content": "Noted, john@test.com is your email."}');
  });

  it("round-trips IBAN with reversible redaction", async () => {
    const policy = fromPreset("pii");
    const stats = createStats();
    const map = new ReplacementMap();

    const original = "My IBAN is NL91 ABNA 0417 1643 00 for transfers";
    const redacted = await redactWithPolicy(original, policy, stats, [], map) as string;

    assert.ok(redacted.includes("[IBAN_1]"));
    const restored = map.rehydrate(redacted);
    assert.equal(restored, original);
  });

  it("round-trips EU phone number with reversible redaction", async () => {
    const policy = fromPreset("pii");
    const stats = createStats();
    const map = new ReplacementMap();

    const original = "Call +31 6 12345678 for info";
    const redacted = await redactWithPolicy(original, policy, stats, [], map) as string;

    assert.ok(redacted.includes("[PHONE_EU_1]"));
    const restored = map.rehydrate(redacted);
    assert.equal(restored, original);
  });

  it("round-trips BSN with reversible redaction in strict preset", async () => {
    const policy = fromPreset("strict");
    const stats = createStats();
    const map = new ReplacementMap();

    const original = "BSN: 123456782";
    const redacted = await redactWithPolicy(original, policy, stats, [], map) as string;

    assert.ok(redacted.includes("[BSN_DUTCH_1]"));
    const restored = map.rehydrate(redacted);
    assert.equal(restored, original);
  });

  it("round-trips UK NI number with reversible redaction", async () => {
    const policy = fromPreset("strict");
    const stats = createStats();
    const map = new ReplacementMap();

    const original = "My NI number is AB123456C";
    const redacted = await redactWithPolicy(original, policy, stats, [], map) as string;

    assert.ok(redacted.includes("[NI_NUMBER_UK_1]"));
    const restored = map.rehydrate(redacted);
    assert.equal(restored, original);
  });

  it("round-trips passport number with reversible redaction", async () => {
    const policy = fromPreset("strict");
    const stats = createStats();
    const map = new ReplacementMap();

    const original = "Passport number: X12345678";
    const redacted = await redactWithPolicy(original, policy, stats, [], map) as string;

    assert.ok(redacted.includes("[PASSPORT_NUMBER_1]"));
    const restored = map.rehydrate(redacted);
    assert.equal(restored, original);
  });
});

// --- Stream rehydration ---

describe("stream rehydration", () => {
  function toBuffer(s: string): Buffer {
    return Buffer.from(s, "utf8");
  }
  function toString(b: Buffer | null): string {
    return b ? b.toString("utf8") : "";
  }

  /** Build an SSE text_delta line (with trailing \n). */
  function sseTextDelta(text: string, index = 0): string {
    const escaped = text.replace(/\\/g, "\\\\").replace(/"/g, '\\"');
    return `data: {"type":"content_block_delta","index":${index},"delta":{"type":"text_delta","text":"${escaped}"}}\n`;
  }

  /** Build an SSE thinking_delta line (with trailing \n). */
  function sseThinkingDelta(thinking: string, index = 0): string {
    const escaped = thinking.replace(/\\/g, "\\\\").replace(/"/g, '\\"');
    return `data: {"type":"content_block_delta","index":${index},"delta":{"type":"thinking_delta","thinking":"${escaped}"}}\n`;
  }

  /** Extract all text/thinking content from SSE output (all provider formats). */
  function extractContent(sse: string): string {
    let result = "";
    for (const line of sse.split("\n")) {
      if (!line.startsWith("data: ")) continue;
      try {
        const obj = JSON.parse(line.slice(6));
        // Anthropic: delta.text / delta.thinking
        if (obj.delta?.text) result += obj.delta.text;
        if (obj.delta?.thinking) result += obj.delta.thinking;
        // OpenAI: choices[].delta.content
        if (obj.choices?.[0]?.delta?.content) result += obj.choices[0].delta.content;
        // Gemini: candidates[].content.parts[].text
        if (obj.candidates?.[0]?.content?.parts) {
          for (const part of obj.candidates[0].content.parts) {
            if (typeof part.text === "string") result += part.text;
          }
        }
        // Gemini with response wrapper
        if (obj.response?.candidates?.[0]?.content?.parts) {
          for (const part of obj.response.candidates[0].content.parts) {
            if (typeof part.text === "string") result += part.text;
          }
        }
      } catch {
        // not JSON; ignore
      }
    }
    return result;
  }

  /** Stream all chunks through a rehydrator and return combined output. */
  function streamAll(
    map: ReplacementMap,
    chunks: string[],
  ): string {
    const stream = createStreamRehydrator(map);
    let out = "";
    for (const c of chunks) {
      out += toString(stream.onChunk(toBuffer(c)));
    }
    out += toString(stream.onEnd());
    return out;
  }

  it("rehydrates a complete placeholder in a single event", async () => {
    const map = new ReplacementMap();
    map.getOrCreate("john@test.com", "email");

    const sse = streamAll(map, [sseTextDelta("Hello [EMAIL_1]") + "\n"]);
    const text = extractContent(sse);
    assert.ok(text.includes("john@test.com"), `got: ${text}`);
    assert.ok(!text.includes("[EMAIL_1]"), `got: ${text}`);
  });

  it("rehydrates a placeholder split across two SSE events", async () => {
    const map = new ReplacementMap();
    map.getOrCreate("(555) 234-5678", "phone-us");

    // "[PHONE_US_1" in one event, "]" in the next (the actual bug scenario)
    const sse = streamAll(map, [
      sseTextDelta("call [PHONE_US_1") + "\n",
      sseTextDelta("] please") + "\n",
    ]);
    const text = extractContent(sse);
    assert.ok(text.includes("(555) 234-5678"), `got: ${text}`);
    assert.ok(!text.includes("[PHONE_US_1]"), `got: ${text}`);
  });

  it("rehydrates a placeholder split across three SSE events", async () => {
    const map = new ReplacementMap();
    map.getOrCreate("AKIAIOSFODNN7EXAMPLE", "aws-access-key");

    // "[AWS_ACCESS_" / "KEY_" / "1]"
    const sse = streamAll(map, [
      sseTextDelta("key: [AWS_ACCESS_") + "\n",
      sseTextDelta("KEY_") + "\n",
      sseTextDelta("1] done") + "\n",
    ]);
    const text = extractContent(sse);
    assert.ok(text.includes("AKIAIOSFODNN7EXAMPLE"), `got: ${text}`);
    assert.ok(!text.includes("[AWS_ACCESS_KEY_1]"), `got: ${text}`);
  });

  it("handles multiple split placeholders in sequence", async () => {
    const map = new ReplacementMap();
    map.getOrCreate("john@test.com", "email");
    map.getOrCreate("jane@test.com", "email");
    map.getOrCreate("123-45-6789", "ssn");

    const sse = streamAll(map, [
      sseTextDelta("[EMAIL_") + "\n",
      sseTextDelta("1] and [EMAIL_") + "\n",
      sseTextDelta("2] and [SS") + "\n",
      sseTextDelta("N_1]") + "\n",
    ]);
    const text = extractContent(sse);
    assert.ok(text.includes("john@test.com"), `got: ${text}`);
    assert.ok(text.includes("jane@test.com"), `got: ${text}`);
    assert.ok(text.includes("123-45-6789"), `got: ${text}`);
    assert.ok(!text.includes("[EMAIL_"), `got: ${text}`);
    assert.ok(!text.includes("[SSN_"), `got: ${text}`);
  });

  it("handles TCP-level splits within a single SSE line", async () => {
    const map = new ReplacementMap();
    map.getOrCreate("john@test.com", "email");

    // One SSE line split across two TCP chunks (mid-JSON)
    const fullLine = sseTextDelta("Hi [EMAIL_1] bye");
    const splitAt = fullLine.indexOf("[EMAIL");
    const sse = streamAll(map, [
      fullLine.slice(0, splitAt),
      fullLine.slice(splitAt) + "\n",
    ]);
    const text = extractContent(sse);
    assert.ok(text.includes("john@test.com"), `got: ${text}`);
  });

  it("passes through non-delta events unchanged", async () => {
    const map = new ReplacementMap();
    map.getOrCreate("john@test.com", "email");

    const event = 'data: {"type":"message_start","message":{"content":[]}}\n\n';
    const sse = streamAll(map, [event]);
    assert.ok(sse.includes("message_start"), `got: ${sse}`);
    assert.ok(sse.includes('"content":[]'), `JSON brackets preserved, got: ${sse}`);
  });

  it("handles empty map without modification", async () => {
    const map = new ReplacementMap();
    const input = sseTextDelta("[EMAIL_1]") + "\n";
    const stream = createStreamRehydrator(map);
    const out = toString(stream.onChunk(toBuffer(input)));
    assert.equal(out, input);
  });

  it("passes through text with no placeholders", async () => {
    const map = new ReplacementMap();
    map.getOrCreate("john@test.com", "email");

    const sse = streamAll(map, [sseTextDelta("Hello world") + "\n"]);
    const text = extractContent(sse);
    assert.equal(text, "Hello world");
  });

  it("handles text containing [ that is not a placeholder", async () => {
    const map = new ReplacementMap();
    map.getOrCreate("john@test.com", "email");

    const sse = streamAll(map, [
      sseTextDelta("[click here](http://example.com) and [EMAIL_1]") + "\n",
    ]);
    const text = extractContent(sse);
    assert.ok(text.includes("[click here](http://example.com)"), `got: ${text}`);
    assert.ok(text.includes("john@test.com"), `got: ${text}`);
  });

  it("flushes text buffer when non-delta event arrives", async () => {
    const map = new ReplacementMap();
    map.getOrCreate("john@test.com", "email");

    const sse = streamAll(map, [
      sseTextDelta("Hello [EMAIL_1]") + "\n",
      'data: {"type":"content_block_stop","index":1}\n',
      "\n",
    ]);
    const text = extractContent(sse);
    assert.ok(text.includes("john@test.com"), `got: ${text}`);
    assert.ok(sse.includes("content_block_stop"), `stop event preserved, got: ${sse}`);
  });

  it("rehydrates thinking_delta content", async () => {
    const map = new ReplacementMap();
    map.getOrCreate("john@test.com", "email");

    const sse = streamAll(map, [
      sseThinkingDelta("processing [EMAIL_1]") + "\n",
    ]);
    const text = extractContent(sse);
    assert.ok(text.includes("john@test.com"), `got: ${text}`);
  });

  it("rehydrates thinking_delta split across events", async () => {
    const map = new ReplacementMap();
    map.getOrCreate("123-45-6789", "ssn");

    const sse = streamAll(map, [
      sseThinkingDelta("SSN is [SS") + "\n",
      sseThinkingDelta("N_1] noted") + "\n",
    ]);
    const text = extractContent(sse);
    assert.ok(text.includes("123-45-6789"), `got: ${text}`);
    assert.ok(!text.includes("[SSN_1]"), `got: ${text}`);
  });

  it("flushes pending buffer on end", async () => {
    const map = new ReplacementMap();
    map.getOrCreate("john@test.com", "email");

    const stream = createStreamRehydrator(map);
    // Incomplete line, never terminated
    toString(stream.onChunk(toBuffer("data: incomplete")));
    const flushed = toString(stream.onEnd());
    assert.ok(flushed.includes("data: incomplete"), `got: ${flushed}`);
  });

  it("handles realistic Claude response with mixed event types", async () => {
    const map = new ReplacementMap();
    map.getOrCreate("john@test.com", "email");
    map.getOrCreate("jane@test.com", "email");
    map.getOrCreate("(555) 234-5678", "phone-us");
    map.getOrCreate("123-45-6789", "ssn");
    map.getOrCreate("AKIAIOSFODNN7EXAMPLE", "aws-access-key");

    const sse = streamAll(map, [
      'data: {"type":"message_start","message":{"id":"msg_01","type":"message","role":"assistant","content":[],"model":"claude-sonnet-4-20250514"}}\n\n',
      'event: content_block_start\n',
      'data: {"type":"content_block_start","index":0,"content_block":{"type":"thinking","thinking":""}}\n\n',
      sseThinkingDelta("The user has [EMAIL_") + "\n",
      sseThinkingDelta("1] and [SS") + "\n",
      sseThinkingDelta("N_1]") + "\n",
      'data: {"type":"content_block_stop","index":0}\n\n',
      'event: content_block_start\n',
      'data: {"type":"content_block_start","index":1,"content_block":{"type":"text","text":""}}\n\n',
      sseTextDelta("| [EMAIL_1] | [PHONE_US_", 1) + "\n",
      sseTextDelta("1] |", 1) + "\n",
      sseTextDelta("\\n| [EMAIL_2] | AWS [AWS_ACCESS_", 1) + "\n",
      sseTextDelta("KEY_1] |", 1) + "\n",
      'data: {"type":"content_block_stop","index":1}\n\n',
      'data: {"type":"message_delta","delta":{"stop_reason":"end_turn"}}\n\n',
      'data: {"type":"message_stop"}\n\n',
    ]);
    const text = extractContent(sse);

    // All values rehydrated
    assert.ok(text.includes("john@test.com"), `email 1, got: ${text}`);
    assert.ok(text.includes("jane@test.com"), `email 2, got: ${text}`);
    assert.ok(text.includes("(555) 234-5678"), `phone, got: ${text}`);
    assert.ok(text.includes("123-45-6789"), `ssn, got: ${text}`);
    assert.ok(text.includes("AKIAIOSFODNN7EXAMPLE"), `aws key, got: ${text}`);

    // No placeholders remain
    assert.ok(!text.includes("[EMAIL_"), `no email placeholder, got: ${text}`);
    assert.ok(!text.includes("[PHONE_"), `no phone placeholder, got: ${text}`);
    assert.ok(!text.includes("[SSN_"), `no ssn placeholder, got: ${text}`);
    assert.ok(!text.includes("[AWS_"), `no aws placeholder, got: ${text}`);

    // Structure preserved: non-delta events pass through
    assert.ok(sse.includes("message_start"), "message_start preserved");
    assert.ok(sse.includes("content_block_stop"), "content_block_stop preserved");
    assert.ok(sse.includes("message_stop"), "message_stop preserved");
  });

  it("rehydrates OpenAI streaming format", async () => {
    const map = new ReplacementMap();
    map.getOrCreate("john@test.com", "email");

    function openaiDelta(content: string): string {
      const escaped = content.replace(/\\/g, "\\\\").replace(/"/g, '\\"');
      return `data: {"choices":[{"index":0,"delta":{"content":"${escaped}"}}]}\n`;
    }

    const sse = streamAll(map, [
      openaiDelta("Email: [EMAIL_") + "\n",
      openaiDelta("1] ok") + "\n",
      "data: [DONE]\n\n",
    ]);
    const text = extractContent(sse);
    assert.ok(text.includes("john@test.com"), `got: ${text}`);
    assert.ok(!text.includes("[EMAIL_1]"), `got: ${text}`);
    assert.ok(sse.includes("[DONE]"), "DONE event preserved");
  });

  it("rehydrates Gemini streaming format", async () => {
    const map = new ReplacementMap();
    map.getOrCreate("john@test.com", "email");

    function geminiDelta(text: string): string {
      const escaped = text.replace(/\\/g, "\\\\").replace(/"/g, '\\"');
      return `data: {"candidates":[{"content":{"parts":[{"text":"${escaped}"}]}}]}\n`;
    }

    const sse = streamAll(map, [
      geminiDelta("Hello [EMAIL_") + "\n",
      geminiDelta("1] world") + "\n",
    ]);
    const text = extractContent(sse);
    assert.ok(text.includes("john@test.com"), `got: ${text}`);
    assert.ok(!text.includes("[EMAIL_1]"), `got: ${text}`);
  });
});

// ---------------------------------------------------------------------------
// New vendor-specific credential patterns in SECRETS_RULES
//
// Tests for gap 1 (8 new patterns missing from SECRETS_RULES) and
// gap 2 (toRule() drops allowlist, so FP suppression was silently lost).
//
// Pattern values and FP cases ported from gitleaks rules (MIT):
// https://github.com/gitleaks/gitleaks/tree/master/cmd/generate/config/rules
// ---------------------------------------------------------------------------

describe("secrets preset — new vendor patterns", () => {
  async function redact(text: string): Promise<string> {
    const policy = fromPreset("secrets");
    const stats = createStats();
    return await redactWithPolicy(text, policy, stats) as string;
  }

  async function notRedacted(text: string): Promise<boolean> {
    return await redact(text) === text;
  }

  // --- GCP API key ---
  describe("credential_gcp_api_key", () => {
    // AIza + exactly 35 word/hyphen chars
    const key = "AIzaSyC1234567890abcdefghijklmnopqrstuv";

    it("redacts GCP API key", async () => {
      assert.equal(await redact(`apiKey=${key}`), "apiKey=[GCP_API_KEY_REDACTED]");
    });

    it("redacts GCP key in JSON value", async () => {
      assert.equal(
        await redact(`{"key":"${key}"}`),
        '{"key":"[GCP_API_KEY_REDACTED]"}',
      );
    });

    it("does not redact all-same-char placeholder (AIzaaaa...)", async () => {
      // fps from gitleaks gcp.go — no entropy
      assert.ok(await notRedacted('apiKey: "AIzaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa"'));
    });
  });

  // --- GCP service account ---
  describe("credential_gcp_service_account", () => {
    it('redacts "type": "service_account" literal', async () => {
      const input = '{"type": "service_account", "project_id": "my-proj"}';
      assert.ok((await redact(input)).includes("[GCP_SERVICE_ACCOUNT_REDACTED]"));
    });

    it("does not redact other type fields", async () => {
      assert.ok(await notRedacted('{"type": "oauth2_client"}'));
    });
  });

  // --- GitLab PAT ---
  describe("credential_gitlab", () => {
    const token = "glpat-abcdefghij1234567890";

    it("redacts glpat- token", async () => {
      assert.equal(
        await redact(`GITLAB_TOKEN=${token}`),
        "GITLAB_TOKEN=[GITLAB_TOKEN_REDACTED]",
      );
    });

    it("does not redact truncated glpat- (too short)", async () => {
      assert.ok(await notRedacted("token=glpat-tooshort"));
    });
  });

  // --- JWT ---
  describe("credential_jwt", () => {
    // Real JWT from gitleaks test suite (gitleaks:allow)
    const jwt =
      "eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9" +
      ".eyJzdWIiOiJ1c2VybmFtZTpib2IifQ" +
      ".HcfCW67Uda-0gz54ZWTqmtgJnZeNem0Q757eTa9EZuw";

    it("redacts JWT", async () => {
      const out = await redact(`Authorization: Bearer ${jwt}`);
      assert.ok(out.includes("[JWT_REDACTED]"), `got: ${out}`);
      assert.ok(!out.includes("eyJ"), `should not expose JWT, got: ${out}`);
    });

    it("does not redact plain base64", async () => {
      assert.ok(await notRedacted("value: aGVsbG8gd29ybGQ="));
    });
  });

  // --- Stripe ---
  describe("credential_stripe", () => {
    const live = "sk_live_" + "51OuEMLAlTWGaDypq4P5cuDHbuKeG4tAGPYHJpEXQabcde";
    const rk = "rk_prod_" + "51OuEMLAlTWGaDypquDn9aZigaJOsa9NR1w1BxZXs9abc";

    it("redacts sk_live_ key", async () => {
      assert.equal(
        await redact(`STRIPE_KEY=${live}`),
        "STRIPE_KEY=[STRIPE_KEY_REDACTED]",
      );
    });

    it("redacts rk_prod_ key", async () => {
      assert.equal(
        await redact(`STRIPE_RK=${rk}`),
        "STRIPE_RK=[STRIPE_KEY_REDACTED]",
      );
    });

    it("does not redact task_test_ prefix via the stripe pattern", async () => {
      // fps from gitleaks stripe.go — task_test_ has no sk_/rk_ prefix so
      // credential_stripe does not fire. credential_generic may still catch it
      // via the 'token' keyword — that's expected behaviour, not a bug.
      const policy = fromPreset("secrets");
      const stats = createStats();
      const out = await redactWithPolicy('nonMatchingToken := "task_test_abcdefghij1234567890"', policy, stats) as string;
      assert.ok(!out.includes("[STRIPE_KEY_REDACTED]"), `stripe rule should not fire, got: ${out}`);
    });
  });

  // --- Slack ---
  describe("credential_slack", () => {
    it("redacts xoxb- bot token", async () => {
      const token = ["xoxb", "781236542736", "2364535789652", "GkwFDQoHqzXDVsC6GzqYUypD"].join("-");
      const out = await redact(`bot_token=${token}`);
      assert.ok(out.includes("[SLACK_TOKEN_REDACTED]"), `got: ${out}`);
      assert.ok(!out.includes("xoxb"), `got: ${out}`);
    });

    it("redacts xoxp- user token", async () => {
      const token = ["xoxp", "41684372915", "1320496754", "45609968301", "e708ba56e1517a99f6b5fb07349476ef"].join("-");
      assert.ok((await redact(token)).includes("[SLACK_TOKEN_REDACTED]"));
    });

    it("redacts Slack webhook URL", async () => {
      const url = "https://hooks.slack.com/services/" + "T0DCUJB1Q/B0DD08H5G/bJtrpFi1fO1JMCcwLx8uZyAg";
      assert.ok((await redact(url)).includes("[SLACK_TOKEN_REDACTED]"));
    });

    it("does not redact all-x placeholder", async () => {
      // fps from gitleaks slack.go
      assert.ok(await notRedacted("token=xoxb-xxxxxxxxx-xxxxxxxxxx-xxxxxxxxxxxx"));
    });

    it("does not redact malformed xoxp- (too few segments) via the slack pattern", async () => {
      // fps from gitleaks slack.go — too few numeric segments for the xox[pe] sub-pattern.
      // credential_generic may still catch it via the 'token' keyword; that's expected.
      const policy = fromPreset("secrets");
      const stats = createStats();
      const out = await redactWithPolicy('"token": "xoxp-1234567890"', policy, stats) as string;
      assert.ok(!out.includes("[SLACK_TOKEN_REDACTED]"), `slack rule should not fire, got: ${out}`);
    });
  });

  // --- HuggingFace ---
  describe("credential_huggingface", () => {
    it("redacts hf_ access token", async () => {
      const token = "hf_" + "jCBaQngSHiHDRYOcsMcifUcysGyaiybUWz";
      const out = await redact(`HF_TOKEN=${token}`);
      assert.ok(out.includes("[HUGGINGFACE_TOKEN_REDACTED]"), `got: ${out}`);
      assert.ok(!out.includes("hf_"), `got: ${out}`);
    });

    it("redacts api_org_ token", async () => {
      const token = "api_org_" + "PsvVHMtfecsbsdScIMRjhReQYUBOZqOJTs";
      assert.ok((await redact(token)).includes("[HUGGINGFACE_TOKEN_REDACTED]"));
    });

    it("does not redact all-x placeholder", async () => {
      // fps from gitleaks huggingface.go
      assert.ok(await notRedacted("HF_TOKEN=hf_xxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxx"));
    });

    it("does not redact hf_ in ObjC method name", async () => {
      assert.ok(await notRedacted("- (id)hf_requiredCharacteristicTypesForDisplayMetadata;"));
    });
  });

  // --- Databricks ---
  describe("credential_databricks", () => {
    it("redacts dapi token", async () => {
      const token = "dapi" + "f13ac4b49d1cb31f69f678e39602e381";
      const out = await redact(`token = ${token}-2`);
      assert.ok(out.includes("[DATABRICKS_TOKEN_REDACTED]"), `got: ${out}`);
      assert.ok(!out.includes("dapi"), `got: ${out}`);
    });

    it("does not redact malformed dapi token via the databricks pattern", async () => {
      // fps from gitleaks databricks.go — 'g' is not a hex char so [a-f0-9]{32} fails.
      // credential_generic may still catch it via the 'token' keyword; that's expected.
      const policy = fromPreset("secrets");
      const stats = createStats();
      const out = await redactWithPolicy("DATABRICKS_TOKEN=dapi123456789012345678a9bc01234defg5", policy, stats) as string;
      assert.ok(!out.includes("[DATABRICKS_TOKEN_REDACTED]"), `databricks rule should not fire, got: ${out}`);
    });
  });

  // --- allowlist propagation (gap 2) ---
  // Verifies toRule() carries allowlist through to the redaction engine,
  // so FP suppression rules in CredentialPattern are not silently dropped.
  describe("allowlist propagation from CredentialPattern", () => {
    it("does not redact GCP placeholder through the redact engine", async () => {
      // This would fire without allowlist propagation
      assert.ok(await notRedacted("apiKey: AIzaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa"));
    });

    it("does not redact all-x Slack placeholder through the redact engine", async () => {
      assert.ok(await notRedacted("xoxb-xxxxxxxxx-xxxxxxxxxx-xxxxxxxxxxxx"));
    });

    it("does not redact all-x HuggingFace placeholder through the redact engine", async () => {
      assert.ok(await notRedacted("HF_TOKEN=hf_xxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxx"));
    });
  });
});

// ---------------------------------------------------------------------------
// Gap 5: entropy gate — credential_generic must not fire on low-entropy values
// ---------------------------------------------------------------------------

describe("secrets preset — entropy gate on credential_generic", () => {
  async function credentialGenericFires(text: string): Promise<boolean> {
    const policy = fromPreset("secrets");
    const stats = createStats();
    const out = await redactWithPolicy(text, policy, stats) as string;
    return out !== text && stats.byRule["credential_generic"] > 0;
  }

  it("does not redact all-same-digit value (entropy = 0)", async () => {
    assert.ok(!await credentialGenericFires("api_token=11111111111111111111111"));
  });

  it("does not redact nearly-all-same value (entropy ≈ 0.25)", async () => {
    assert.ok(!await credentialGenericFires("api_token=aaaa1aaaaaaaaaaaaaaaaaaa"));
  });

  it("still redacts high-entropy generic secret", async () => {
    assert.ok(await credentialGenericFires("api_token=xK9mP2nR4qL7vB3c1wZ5yXa8bN"));
  });
});

// ---------------------------------------------------------------------------
// dynamic auth detection: bearer tokens, auth headers, prefixed API keys,
// credential_nvidia, credential_openrouter, credential_kilo
// ---------------------------------------------------------------------------

describe("secrets preset — dynamic auth detection", () => {
  async function redact(text: string): Promise<string> {
    const policy = fromPreset("secrets");
    const stats = createStats();
    return await redactWithPolicy(text, policy, stats) as string;
  }

  // --- bearer-token ---
  describe("bearer-token", () => {
    it("redacts Bearer token", async () => {
      assert.ok((await redact("Authorization: Bearer [BEARER_TOKEN_REDACTED]")).includes("[BEARER_TOKEN_REDACTED]"));
    });

    it("does not redact short bearer value (too short)", async () => {
      const text = "Authorization: Bearer short";
      assert.equal(await redact(text), text);
    });
  });

// --- authorization-header ---
describe("authorization-header (Bearer-only)", () => {
  it("redacts Bearer token in Authorization header", async () => {
    const token = "eyJhbGciOi" + "a".repeat(30);
    const text = `Authorization: Bearer ${token}`;
    console.log('input:', text);
    const out = await redact(text);
    console.log('output:', out);
    assert.ok(out.includes("[AUTH_HEADER_REDACTED]"), `got: ${out}`);
    assert.ok(!out.includes(token), `should not expose token, got: ${out}`);
  });

  it("does not redact api-key header (covered by api-key-prefixed)", async () => {
    const token = "sk-" + "a".repeat(40);
    const out = await redact(`api-key: ${token}`);
    assert.ok(!out.includes("[AUTH_HEADER_REDACTED]"), `got: ${out}`);
  });

  it("does not redact x-api-key header (covered by api-key-prefixed)", async () => {
    const token = "x-api-" + "a".repeat(40);
    const out = await redact(`x-api-key: ${token}`);
    assert.ok(!out.includes("[AUTH_HEADER_REDACTED]"), `got: ${out}`);
  });

  it("does not redact already-redacted placeholder brackets", async () => {
    const out = await redact("authorization: bearer [AUTH_HEADER_REDACTED]");
    // Must not throw / crash and should not double-match
    assert.ok(!out.includes("[AUTH_HEADER_REDACTED][AUTH_HEADER_REDACTED]"), `got: ${out}`);
  });
});

  // --- api-key-prefixed ---
  describe("api-key-prefixed", () => {
    it("redacts sk_-prefixed key", async () => {
      const out = await redact("key=[API_KEY_REDACTED]");
      assert.ok(out.includes("[API_KEY_REDACTED]"), `got: ${out}`);
    });

    it("redacts token_-prefixed value", async () => {
      const out = await redact("token=[API_KEY_REDACTED]");
      assert.ok(out.includes("[API_KEY_REDACTED]"), `got: ${out}`);
    });
  });

  // --- credential_nvidia ---
  describe("credential_nvidia", () => {
    it("redacts nvapi- key", async () => {
      const token = "nvapi-" + "a".repeat(40);
      const out = await redact(`NVIDIA_API_KEY=${token}`);
      assert.ok(out.includes("[NVIDIA_KEY_REDACTED]"), `got: ${out}`);
      assert.ok(!out.includes(token), `should not expose token, got: ${out}`);
    });

    it("does not redact short nvapi- (too short)", async () => {
      const text = "key=nvapi-tooshort";
      assert.equal(await redact(text), text);
    });
  });

  // --- credential_openrouter ---
  describe("credential_openrouter", () => {
    it("redacts sk-or- key", async () => {
      const token = "sk-or-" + "a".repeat(40);
      const out = await redact(`OPENROUTER_KEY=${token}`);
      assert.ok(out.includes("[OPENROUTER_KEY_REDACTED]"), `got: ${out}`);
      assert.ok(!out.includes(token), `should not expose token, got: ${out}`);
    });

    it("does not redact short sk-or- (too short)", async () => {
      const text = "key=sk-or-tooshort";
      assert.equal(await redact(text), text);
    });
  });

  // --- credential_kilo ---
  describe("credential_kilo", () => {
    it("redacts kilo- key", async () => {
      const token = "kilo-" + "a".repeat(40);
      const out = await redact(`KILO_API_KEY=${token}`);
      assert.ok(out.includes("[KILO_KEY_REDACTED]"), `got: ${out}`);
      assert.ok(!out.includes(token), `should not expose token, got: ${out}`);
    });

    it("does not redact short kilo- (too short)", async () => {
      const text = "key=kilo-tooshort";
      assert.equal(await redact(text), text);
    });
  });
});

// ---------------------------------------------------------------------------
// Gap 6 (continued): npm, PyPI, Vault, SendGrid patterns in secrets preset
// ---------------------------------------------------------------------------

describe("secrets preset — npm, PyPI, Vault, SendGrid", () => {
  async function redact(text: string): Promise<string> {
    const policy = fromPreset("secrets");
    const stats = createStats();
    return await redactWithPolicy(text, policy, stats) as string;
  }

  describe("npm (credential_npm)", () => {
    it("redacts npm_ token", async () => {
      const out = await redact("NPM_TOKEN=npm_abcdefghij1234567890ABCDEF1234567890");
      assert.ok(out.includes("[NPM_TOKEN_REDACTED]"), `got: ${out}`);
      assert.ok(!out.includes("npm_"), `should not expose token, got: ${out}`);
    });

    it("does not redact short npm_ token", async () => {
      const text = "npm_tooshort";
      assert.equal(await redact(text), text);
    });
  });

  describe("PyPI (credential_pypi)", () => {
    const token = "pypi-AgEIcHlwaS5vcmc" + "a1b2c3d4".repeat(8);

    it("redacts pypi- upload token", async () => {
      const out = await redact(`PYPI_TOKEN=${token}`);
      assert.ok(out.includes("[PYPI_TOKEN_REDACTED]"), `got: ${out}`);
      assert.ok(!out.includes("pypi-"), `should not expose token, got: ${out}`);
    });
  });

  describe("HashiCorp Vault (credential_vault)", () => {
    it("redacts hvs. service token", async () => {
      const token = "hvs." + "CAESIP2jTxc9S2K7Z6CtcFWQv7-044m_oSsxnPE1H3nF89l3GiYKHGh2cy5sQmlIZVNyTWJNcDRsYWJpQjlhYjVlb1cQh6PL8wE";
      const out = await redact(`VAULT_TOKEN=${token}`);
      assert.ok(out.includes("[VAULT_TOKEN_REDACTED]"), `got: ${out}`);
      assert.ok(!out.includes("hvs."), `should not expose token, got: ${out}`);
    });

    it("redacts hvb. batch token", async () => {
      const token =
        "hvb." +
        "AAAAAQJgxDgqsGNorpoOR7hPZ5SU-ynBvCl764jyRP_fnX7WvkdkDzGjbLNGdPdtlY33Als2P36yDZueqzfdGw9RsaTeaYXSH7E4RYSWuRoQ9YRKIw8o7mDDY2ZcT3KOB7RwtW1w1FN2eDqcy_sbCjXPaM1iBVH-mqMSYRmRd2nb5D1SJPeBzIYRqSglLc31wUGN7xEzyrKUczqOKsIcybQA";
      const out = await redact(token);
      assert.ok(out.includes("[VAULT_TOKEN_REDACTED]"), `got: ${out}`);
    });

    it("does not redact s. all-lowercase (low entropy)", async () => {
      const text = "s.thisstringisalllowercase";
      assert.equal(await redact(text), text);
    });

    it("does not redact hvs. all-x placeholder", async () => {
      const text = "hvs.xxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxx";
      assert.equal(await redact(text), text);
    });
  });

  describe("SendGrid (credential_sendgrid)", () => {
    const token = "SG." + "aBcDeFgH1234".repeat(5) + "aBcDeF";

    it("redacts SG. token", async () => {
      const out = await redact(`SENDGRID_API_KEY=${token}`);
      assert.ok(out.includes("[SENDGRID_TOKEN_REDACTED]"), `got: ${out}`);
      assert.ok(!out.includes("SG."), `should not expose token, got: ${out}`);
    });

    it("does not redact short SG. token", async () => {
      const text = "SG.tooshort";
      assert.equal(await redact(text), text);
    });
  });
});
