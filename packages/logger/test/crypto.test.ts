import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { encrypt, decrypt, deriveKey, validateKey } from "../dist/crypto.js";

function base64url(buf: Uint8Array): string {
  return Buffer.from(buf).toString("base64url");
}

const TEST_KEY = "a-very-long-test-[API_KEY_REDACTED]";
const SHORT_KEY = "short-key";

describe("crypto module", () => {
  /* --------------------------------------------------------------------- */
  /* Round-trip */
  /* --------------------------------------------------------------------- */

  describe("round-trip", () => {
    it("encrypts and decrypts a short string", async () => {
      const { ciphertext, salt, iv } = await encrypt("hello world", TEST_KEY);
      const result = await decrypt(JSON.stringify({ ciphertext, salt, iv }), TEST_KEY);
      assert.equal(result, "hello world");
    });

    it("encrypts and decrypts an empty string", async () => {
      const { ciphertext, salt, iv } = await encrypt("", TEST_KEY);
      const result = await decrypt(JSON.stringify({ ciphertext, salt, iv }), TEST_KEY);
      assert.equal(result, "");
    });

    it("encrypts and decrypts a long string", async () => {
      const plaintext = "x".repeat(1024 * 100); // 100 KB
      const { ciphertext, salt, iv } = await encrypt(plaintext, TEST_KEY);
      const result = await decrypt(JSON.stringify({ ciphertext, salt, iv }), TEST_KEY);
      assert.equal(result, plaintext);
    });

    it("encrypts and decrypts unicode content", async () => {
      const plaintext = "日本語 🚀 emoji-and-unicode";
      const { ciphertext, salt, iv } = await encrypt(plaintext, TEST_KEY);
      const result = await decrypt(JSON.stringify({ ciphertext, salt, iv }), TEST_KEY);
      assert.equal(result, plaintext);
    });

    it("produces different output on each call (random IV and salt)", async () => {
      const a = await encrypt("same-plaintext", TEST_KEY);
      const b = await encrypt("same-plaintext", TEST_KEY);
      assert.notEqual(a.ciphertext, b.ciphertext, "ciphertext should differ");
      assert.notEqual(a.iv, b.iv, "IV should differ");
      assert.notEqual(a.salt, b.salt, "salt should differ");

      // Both must still decrypt correctly
      const ra = await decrypt(JSON.stringify(a), TEST_KEY);
      const rb = await decrypt(JSON.stringify(b), TEST_KEY);
      assert.equal(ra, "same-plaintext");
      assert.equal(rb, "same-plaintext");
    });
  });

  /* --------------------------------------------------------------------- */
  /* deriveKey */
  /* --------------------------------------------------------------------- */

  describe("deriveKey", () => {
    it("returns a 32-byte key", async () => {
      const { key } = await deriveKey(TEST_KEY);
      assert.equal(key.length, 32);
    });

    it("produces the same key for identical salts", async () => {
      const salt = new Uint8Array(16).fill(0xab);
      const a = await deriveKey(TEST_KEY, salt);
      const b = await deriveKey(TEST_KEY, salt);
      assert.deepEqual(a.key, b.key);
      assert.deepEqual(a.salt, salt);
    });
  });

  /* --------------------------------------------------------------------- */
  /* Wrong key / short key */
  /* --------------------------------------------------------------------- */

  describe("wrong key", () => {
    it("throws when short key is used before derivation", () => {
      assert.throws(() => validateKey(SHORT_KEY), /at least 32 characters/i);
    });

    it("throws during encrypt when key is too short", async () => {
      await assert.rejects(() => encrypt("test", SHORT_KEY), /at least 32 characters/i);
    });

    it("throws during decrypt when key is too short", async () => {
      await assert.rejects(() => decrypt("{}", SHORT_KEY), /at least 32 characters/i);
    });

    it("rejects malformed payloads without deriving a key", async () => {
      await assert.rejects(() => decrypt("not-json", TEST_KEY), /Invalid encrypted payload/i);
    });

    it("rejects payloads with missing fields without deriving a key", async () => {
      await assert.rejects(() => decrypt("{}", TEST_KEY), /missing required fields/i);
    });

    it("accepts a key exactly 32 characters", async () => {
      const exact32 = "x".repeat(32);
      assert.equal(validateKey(exact32), true);
      const { ciphertext, salt, iv } = await encrypt("ok", exact32);
      const result = await decrypt(JSON.stringify({ ciphertext, salt, iv }), exact32);
      assert.equal(result, "ok");
    });

    it("throws when decrypting with a different key", async () => {
      const { ciphertext, salt, iv } = await encrypt("secret", TEST_KEY);
      const DIFFERENT_KEY = "a-different-passphrase-that-is-also-at-least-32-chars!!";
      await assert.rejects(
        async () =>
          await decrypt(
            JSON.stringify({ ciphertext, salt, iv }),
            DIFFERENT_KEY
          ),
        /authentication tag mismatch/i,
      );
    });
  });

  /* --------------------------------------------------------------------- */
  /* Tamper detection */
  /* --------------------------------------------------------------------- */

  describe("tamper detection", () => {
    it("throws when ciphertext is modified", async () => {
      const { ciphertext, salt, iv } = await encrypt("secret payload", TEST_KEY);
      const last = ciphertext[ciphertext.length - 1];
      const alt = last === "A" ? "B" : "A";
      const tampered = ciphertext.slice(0, -1) + alt;
      await assert.rejects(
        async () =>
          await decrypt(
            JSON.stringify({ ciphertext: tampered, salt, iv }),
            TEST_KEY
          ),
        /authentication tag mismatch/i,
      );
    });

    it("throws when IV is modified", async () => {
      const { ciphertext, salt, iv } = await encrypt("secret payload", TEST_KEY);
      const last = iv[iv.length - 1];
      const alt = last === "A" ? "B" : "A";
      const tamperedIv = iv.slice(0, -1) + alt;
      await assert.rejects(
        async () =>
          await decrypt(
            JSON.stringify({ ciphertext, salt, iv: tamperedIv }),
            TEST_KEY
          ),
        /authentication tag mismatch/i,
      );
    });

    it("throws when salt is modified", async () => {
      const { ciphertext, salt, iv } = await encrypt("secret payload", TEST_KEY);
      const last = salt[salt.length - 1];
      const alt = last === "A" ? "B" : "A";
      const tamperedSalt = salt.slice(0, -1) + alt;
      await assert.rejects(
        async () =>
          await decrypt(
            JSON.stringify({ ciphertext, salt: tamperedSalt, iv }),
            TEST_KEY
          ),
        /authentication tag mismatch/i,
      );
    });

    it("throws on malformed JSON input", async () => {
      await assert.rejects(
        async () => await decrypt("not-json", TEST_KEY),
        /Invalid encrypted payload/i,
      );
    });

    it("throws on missing fields", async () => {
      await assert.rejects(
        async () => await decrypt("{}", TEST_KEY),
        /missing required fields/i,
      );
    });

    it("throws on short ciphertext", async () => {
      await assert.rejects(
        async () =>
          await decrypt(
            JSON.stringify({
              ciphertext: "short", // too short to contain 16-byte auth tag
              salt: base64url(new Uint8Array(16)),
              iv: base64url(new Uint8Array(12)),
            }),
            TEST_KEY
          ),
        /ciphertext too short/i,
      );
    });

    it("throws when IV has wrong length (not 12 bytes)", async () => {
      // 8-byte IV: valid base64url but wrong length for GCM
      const badIv = base64url(new Uint8Array(8));
      await assert.rejects(
        async () =>
          await decrypt(
            JSON.stringify({
              ciphertext: "AQIDBAUGBwgJ", // valid base64url (dummy)
              salt: base64url(new Uint8Array(16)),
              iv: badIv,
            }),
            TEST_KEY
          ),
        /IV must be 12 bytes/i,
      );
    });

    it("throws when salt has wrong length (not 16 bytes)", async () => {
      // 8-byte salt: valid base64url but wrong length
      const badSalt = base64url(new Uint8Array(8));
      await assert.rejects(
        async () =>
          await decrypt(
            JSON.stringify({
              ciphertext: "AQIDBAUGBwgJ", // valid base64url (dummy)
              salt: badSalt,
              iv: base64url(new Uint8Array(12)),
            }),
            TEST_KEY
          ),
        /salt must be 16 bytes/i,
      );
    });
  });
});
