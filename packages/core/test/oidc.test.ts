import { describe, it, before, after, mock } from "node:test";
import assert from "node:assert/strict";

import {
  fetchProviderMetadata,
  validateIdToken,
} from "../dist/oidc.js";

// Sample OIDC provider metadata response
const mockProviderMetadata = {
  authorization_endpoint: "https://accounts.google.com/o/oauth2/v2/auth",
  token_endpoint: "https://oauth2.googleapis.com/token",
  jwks_uri: "https://www.googleapis.com/oauth2/v3/certs",
  userinfo_endpoint: "https://openidconnect.googleapis.com/v1/userinfo",
  issuer: "https://accounts.google.com",
};

// Sample JWKS response with a valid test key
const mockJwks = {
  keys: [
    {
      kty: "RSA",
      use: "sig",
      kid: "test-key-1",
      n: "0vx7agoebGcQSuuPiLJXZptN9nndrQmbXEps2aiAFbWhM78LhWx4cbbfAAtVT86zwu1RK7aPFFxuhDR1L6tSoc_BJECPebWKRXjBZCiFV4n3oknjhMstn64tZ_2W-5JsGY4Hc5n9yBXArwl93lqt7_RN5w6Cf0h4QyQ5v-65YGjQR0_FDW2QvzqY368QQMicAtaSqzs8KJZgnYb9c7d0zgdAZHzu6qMQvRL5hajrn1n91CbOpbISD08qNLyrdkt-bFTWhAI4vMQFh6WeZu0fM4lFd2NcRwr3XPksINHaQ-G_xBniIqbw0Ls1jF44-csFCur-kEgU8awapJzKnqDKgw",
      e: "AQAB",
      alg: "RS256",
    },
  ],
};

describe("oidc.ts", () => {
  let originalFetch: typeof fetch;

  before(() => {
    originalFetch = globalThis.fetch;
  });

  after(() => {
    globalThis.fetch = originalFetch;
  });

  describe("fetchProviderMetadata", () => {
    it("successfully fetches and parses provider metadata", async () => {
      globalThis.fetch = mock.fn(async (url: string) => {
        assert.equal(url, "https://accounts.google.com/.well-known/openid-configuration");
        return new Response(JSON.stringify(mockProviderMetadata), {
          status: 200,
          headers: { "Content-Type": "application/json" },
        });
      });

      const metadata = await fetchProviderMetadata("https://accounts.google.com");

      assert.equal(metadata.authorization_endpoint, mockProviderMetadata.authorization_endpoint);
      assert.equal(metadata.token_endpoint, mockProviderMetadata.token_endpoint);
      assert.equal(metadata.jwks_uri, mockProviderMetadata.jwks_uri);
      assert.equal(metadata.userinfo_endpoint, mockProviderMetadata.userinfo_endpoint);
      assert.equal(metadata.issuer, mockProviderMetadata.issuer);
    });

    it("normalizes issuer URL by removing trailing slash", async () => {
      globalThis.fetch = mock.fn(async (url: string) => {
        assert.equal(url, "https://accounts.google.com/.well-known/openid-configuration");
        return new Response(JSON.stringify(mockProviderMetadata), {
          status: 200,
          headers: { "Content-Type": "application/json" },
        });
      });

      await fetchProviderMetadata("https://accounts.google.com/");
    });

    it("throws on HTTP error", async () => {
      globalThis.fetch = mock.fn(async () =>
        new Response("Not Found", { status: 404 }),
      );

      await assert.rejects(
        fetchProviderMetadata("https://invalid.example.com"),
        /OIDC discovery failed: 404/,
      );
    });

    it("throws when required fields are missing", async () => {
      globalThis.fetch = mock.fn(async () =>
        new Response(JSON.stringify({ authorization_endpoint: "https://example.com/auth" }), {
          status: 200,
          headers: { "Content-Type": "application/json" },
        }),
      );

      await assert.rejects(
        fetchProviderMetadata("https://example.com"),
        /OIDC discovery response missing required field: token_endpoint/,
      );
    });

    it("throws on invalid JSON response", async () => {
      globalThis.fetch = mock.fn(async () =>
        new Response("not json", { status: 200 }),
      );

      await assert.rejects(
        fetchProviderMetadata("https://example.com"),
        /OIDC discovery response is not valid JSON/,
      );
    });
  });

  describe("validateIdToken", () => {
    // Create a test JWT helper with proper base64url encoding
    function createTestJwt(
      header: Record<string, unknown>,
      payload: Record<string, unknown>,
      signature = "signature",
    ): string {
      const encode = (obj: Record<string, unknown>) =>
        Buffer.from(JSON.stringify(obj))
          .toString("base64")
          .replace(/\+/g, "-")
          .replace(/\//g, "_")
          .replace(/=/g, "");

      return `${encode(header)}.${encode(payload)}.${signature}`;
    }

    it("throws on malformed JWT (wrong number of parts)", async () => {
      // Only 2 parts (should be 3)
      await assert.rejects(
        validateIdToken("part1.part2", "https://example.com/jwks", "client", "https://issuer"),
        /Invalid JWT format: expected 3 parts/,
      );
    });

    it("throws on invalid header encoding (fails JSON parsing)", async () => {
      // 3 parts but header is not valid base64url
      await assert.rejects(
        validateIdToken("invalid_base64!.payload.signature", "https://example.com/jwks", "client", "https://issuer"),
        /Invalid JWT JSON/,
      );
    });

    it("throws on invalid payload encoding", async () => {
      const header = { alg: "RS256", typ: "JWT" };
      const token = `${Buffer.from(JSON.stringify(header)).toString("base64url")}.invalid_base64!.signature`;
      await assert.rejects(
        validateIdToken(token, "https://example.com/jwks", "client", "https://issuer"),
        /Invalid JWT JSON/,
      );
    });

    it("throws on unsupported algorithm", async () => {
      const header = { alg: "HS256", typ: "JWT" };
      const payload = { iss: "https://issuer", aud: "client", exp: Math.floor(Date.now() / 1000) + 3600, iat: Math.floor(Date.now() / 1000) };
      const token = createTestJwt(header, payload);

      await assert.rejects(
        validateIdToken(token, "https://example.com/jwks", "client", "https://issuer"),
        /Unsupported algorithm: HS256/,
      );
    });

    it("throws on invalid audience", async () => {
      const header = { alg: "RS256", typ: "JWT" };
      const payload = { iss: "https://issuer", aud: "wrong-client", exp: Math.floor(Date.now() / 1000) + 3600, iat: Math.floor(Date.now() / 1000) };
      const token = createTestJwt(header, payload);

      await assert.rejects(
        validateIdToken(token, "https://example.com/jwks", "expected-client", "https://issuer"),
        /Invalid audience: expected "expected-client", got "wrong-client"/,
      );
    });

    it("throws on invalid issuer", async () => {
      const header = { alg: "RS256", typ: "JWT" };
      const payload = { iss: "https://wrong-issuer", aud: "client", exp: Math.floor(Date.now() / 1000) + 3600, iat: Math.floor(Date.now() / 1000) };
      const token = createTestJwt(header, payload);

      await assert.rejects(
        validateIdToken(token, "https://example.com/jwks", "client", "https://expected-issuer"),
        /Invalid issuer: expected "https:\/\/expected-issuer", got "https:\/\/wrong-issuer"/,
      );
    });

    it("throws on expired token", async () => {
      const header = { alg: "RS256", typ: "JWT" };
      const payload = { iss: "https://issuer", aud: "client", exp: Math.floor(Date.now() / 1000) - 100, iat: Math.floor(Date.now() / 1000) - 500 };
      const token = createTestJwt(header, payload);

      await assert.rejects(
        validateIdToken(token, "https://example.com/jwks", "client", "https://issuer"),
        /Token expired/,
      );
    });

    it("throws on token issued in the future", async () => {
      const header = { alg: "RS256", typ: "JWT" };
      const payload = { iss: "https://issuer", aud: "client", exp: Math.floor(Date.now() / 1000) + 3600, iat: Math.floor(Date.now() / 1000) + 120 };
      const token = createTestJwt(header, payload);

      await assert.rejects(
        validateIdToken(token, "https://example.com/jwks", "client", "https://issuer"),
        /Token issued in the future/,
      );
    });

    // Integration tests with mocked JWKS
    describe("with mocked JWKS", () => {
      const validHeader = { alg: "RS256", typ: "JWT", kid: "test-key-1" };
      const validPayload = {
        iss: "https://accounts.google.com",
        aud: "test-client-id",
        exp: Math.floor(Date.now() / 1000) + 3600,
        iat: Math.floor(Date.now() / 1000),
        sub: "user123",
      };
      const validToken = createTestJwt(validHeader, validPayload);

      before(() => {
        globalThis.fetch = mock.fn(async (url: string) => {
          if (url.includes("jwks")) {
            return new Response(JSON.stringify(mockJwks), {
              status: 200,
              headers: { "Content-Type": "application/json" },
            });
          }
          return new Response(JSON.stringify(mockProviderMetadata), {
            status: 200,
            headers: { "Content-Type": "application/json" },
          });
        });
      });

      after(() => {
        globalThis.fetch = originalFetch;
      });

      it("throws on signature verification failure (expected with dummy signature)", async () => {
        await assert.rejects(
          validateIdToken(validToken, "https://example.com/jwks", "test-client-id", "https://accounts.google.com"),
          /JWT signature verification failed/,
        );
      });

      it("throws when no matching key in JWKS", async () => {
        const header = { alg: "RS256", typ: "JWT", kid: "nonexistent-key" };
        const payload = { iss: "https://accounts.google.com", aud: "test-client-id", exp: Math.floor(Date.now() / 1000) + 3600, iat: Math.floor(Date.now() / 1000) };
        const token = createTestJwt(header, payload);

        await assert.rejects(
          validateIdToken(token, "https://example.com/jwks", "test-client-id", "https://accounts.google.com"),
          /No matching JWK found for kid: nonexistent-key/,
        );
      });

      it("throws on JWKS fetch failure", async () => {
        globalThis.fetch = mock.fn(async (url: string) => {
          if (url.includes("jwks")) {
            return new Response("Not Found", { status: 404 });
          }
          return new Response(JSON.stringify(mockProviderMetadata), {
            status: 200,
            headers: { "Content-Type": "application/json" },
          });
        });

        await assert.rejects(
          validateIdToken(validToken, "https://example.com/jwks", "test-client-id", "https://accounts.google.com"),
          /Failed to fetch JWKS: 404/,
        );

        // Restore mock for remaining tests
        globalThis.fetch = mock.fn(async (url: string) => {
          if (url.includes("jwks")) {
            return new Response(JSON.stringify(mockJwks), {
              status: 200,
              headers: { "Content-Type": "application/json" },
            });
          }
          return new Response(JSON.stringify(mockProviderMetadata), {
            status: 200,
            headers: { "Content-Type": "application/json" },
          });
        });
      });

      it("accepts audience as array containing expected client ID (structure check)", async () => {
        // This tests the audience validation logic - we create a token with array audience
        const header = { alg: "RS256", typ: "JWT", kid: "test-key-1" };
        const payload = {
          iss: "https://accounts.google.com",
          aud: ["test-client-id", "other-client-id"],
          exp: Math.floor(Date.now() / 1000) + 3600,
          iat: Math.floor(Date.now() / 1000),
        };
        const token = createTestJwt(header, payload);

        // With dummy signature this will fail verification, but we verify it gets past audience check
        await assert.rejects(
          validateIdToken(token, "https://example.com/jwks", "test-client-id", "https://accounts.google.com"),
          /JWT signature verification failed/,
        );
      });
    });
  });
});