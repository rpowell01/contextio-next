import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { encrypt, decrypt, deriveKey, validateKey } from "../dist/crypto.js";

const TEST_KEY = "a-very-secure-passphrase-that-is-at-least-32-chars-long";
const SHORT_KEY = "short-key";

describe("crypto module", () => {
  /* --------------------------------------------------------------------- */
  /* Round-trip                                                           */
  /* --------------------------------------------------------------------- */

  describe("round-trip", () => {
    it("encrypts and decrypts a short string", () => {
      const { ciphertext, salt, iv } = encrypt("hello world", TEST_KEY);
      const result = decrypt(JSON.stringify({ ciphertext, salt, iv }), TEST_KEY);
      assert.equal(result, "hello world");
    });

    it("encrypts and decrypts an empty string", () => {
      const { ciphertext, salt, iv } = encrypt("", TEST_KEY);
      const result = decrypt(JSON.stringify({ ciphertext, salt, iv }), TEST_KEY);
      assert.equal(result, "");
    });

    it("encrypts and decrypts a long string", () => {
      const plaintext = "x".repeat(1024 * 100); // 100 KB
      const { ciphertext, salt, iv } = encrypt(plaintext, TEST_KEY);
      const result = decrypt(JSON.stringify({ ciphertext, salt, iv }), TEST_KEY);
      assert.equal(result, plaintext);
    });

    it("encrypts and decrypts unicode content", () => {
      const plaintext = "日本語 🚀 emoji-and-unicode";
      const { ciphertext, salt, iv } = encrypt(plaintext, TEST_KEY);
      const result = decrypt(JSON.stringify({ ciphertext, salt, iv }), TEST_KEY);
      assert.equal(result, plaintext);
    });

    it("produces different output on each call (random IV and salt)", () => {
      const a = encrypt("same-plaintext", TEST_KEY);
      const b = encrypt("same-plaintext", TEST_KEY);
      assert.notEqual(a.ciphertext, b.ciphertext, "ciphertext should differ");
      assert.notEqual(a.iv, b.iv, "IV should differ");
      assert.notEqual(a.salt, b.salt, "salt should differ");

      // Both must still decrypt correctly
      const ra = decrypt(JSON.stringify(a), TEST_KEY);
      const rb = decrypt(JSON.stringify(b), TEST_KEY);
      assert.equal(ra, "same-plaintext");
      assert.equal(rb, "same-plaintext");
    });
  });

  /* --------------------------------------------------------------------- */
  /* deriveKey                                                             */
  /* --------------------------------------------------------------------- */

  describe("deriveKey", () => {
    it("returns a 32-byte key", () => {
      const { key } = deriveKey(TEST_KEY);
      assert.equal(key.length, 32);
    });

    it("produces the same key for identical salts", () => {
      const salt = new Uint8Array(16).fill(0xab);
      const a = deriveKey(TEST_KEY, salt);
      const b = deriveKey(TEST_KEY, salt);
      assert.deepEqual(a.key, b.key);
      assert.deepEqual(a.salt, salt);
    });
  });

  /* --------------------------------------------------------------------- */
  /* Wrong key / short key                                                */
  /* --------------------------------------------------------------------- */

  describe("wrong key", () => {
    it("throws when decrypting with a different key", () => {
      const { ciphertext, salt, iv } = encrypt("secret", TEST_KEY);
      assert.throws(
        () =>
          decrypt(
            JSON.stringify({ ciphertext, salt, iv }),
            "a-different-passphrase-that-is-also-at-least-32-chars!!",
          ),
        /authentication tag mismatch/i,
      );
    });

    it("throws when key is too short", () => {
      assert.throws(() => encrypt("test", SHORT_KEY), /at least 32 characters/i);
      assert.throws(() => decrypt("{}", SHORT_KEY), /at least 32 characters/i);
      assert.throws(() => validateKey(SHORT_KEY), /at least 32 characters/i);
    });

    it("accepts a key exactly 32 characters", () => {
      const exact32 = "x".repeat(32);
      assert.equal(validateKey(exact32), true);
      const { ciphertext, salt, iv } = encrypt("ok", exact32);
      const result = decrypt(JSON.stringify({ ciphertext, salt, iv }), exact32);
      assert.equal(result, "ok");
    });
  });

  /* --------------------------------------------------------------------- */
  /* Tamper detection                                                     */
  /* --------------------------------------------------------------------- */

  describe("tamper detection", () => {
    it("throws when ciphertext is modified", () => {
      const { ciphertext, salt, iv } = encrypt("secret payload", TEST_KEY);
      const last = ciphertext[ciphertext.length - 1];
      const alt = last === "A" ? "B" : "A";
      const tampered = ciphertext.slice(0, -1) + alt;
      assert.throws(
        () =>
          decrypt(
            JSON.stringify({ ciphertext: tampered, salt, iv }),
            TEST_KEY,
          ),
        /authentication tag mismatch/i,
      );
    });

    it("throws when IV is modified", () => {
      const { ciphertext, salt, iv } = encrypt("secret payload", TEST_KEY);
      const last = iv[iv.length - 1];
      const alt = last === "A" ? "B" : "A";
      const tamperedIv = iv.slice(0, -1) + alt;
      assert.throws(
        () =>
          decrypt(
            JSON.stringify({ ciphertext, salt, iv: tamperedIv }),
            TEST_KEY,
          ),
        /authentication tag mismatch/i,
      );
    });

    it("throws when salt is modified", () => {
      const { ciphertext, salt, iv } = encrypt("secret payload", TEST_KEY);
      const last = salt[salt.length - 1];
      const alt = last === "A" ? "B" : "A";
      const tamperedSalt = salt.slice(0, -1) + alt;
      assert.throws(
        () =>
          decrypt(
            JSON.stringify({ ciphertext, salt: tamperedSalt, iv }),
            TEST_KEY,
          ),
        /authentication tag mismatch/i,
      );
    });

    it("throws on malformed JSON input", () => {
      assert.throws(() => decrypt("not-json", TEST_KEY), /Invalid encrypted payload/i);
    });

    it("throws on missing fields", () => {
      assert.throws(() => decrypt("{}", TEST_KEY), /missing required fields/i);
    });
  });
});
