/**
 * Request routing for the proxy.
 *
 * Three responsibilities:
 * 1. Classify requests by provider and API format (path/header heuristics)
 * 2. Extract source tool tags and session IDs from URL path prefixes
 * 3. Resolve the upstream URL to forward the request to
 *
 * Zero external dependencies.
 */

import type {
  ApiFormat,
  ExtractSourceResult,
  Provider,
  ResolveTargetResult,
  Upstreams,
  ProviderConfig,
} from "./types.js";

/**
 * Normalize an upstream URL by stripping trailing /v1 if present.
 * The request path already contains API version segments, so having
 * /v1 in both the base URL and the path would cause double-prefixing.
 */
function normalizeUpstreamUrl(url: string): string {
  return url.replace(/\/v1$/, "");
}

/**
 * Resolve the base URL for a provider, checking per-provider override settings.
 */
function getBaseUrl(
  headerName: string,
  upstreamKey: keyof Upstreams,
  headers: Record<string, string | undefined>,
  upstreams: Upstreams,
  strictUrlForwarding: boolean,
  providerConfigs?: Record<string, ProviderConfig>,
  provider?: string,
): string {
  if (strictUrlForwarding) {
    const upstreamValue = upstreams[upstreamKey];
    const headerValue = headers[headerName];
    if (headerValue && headerValue !== upstreamValue) {
      console.warn(
        `[StrictURLForwarding] Ignoring ${headerName} "${headerValue}", using configured upstream "${upstreamValue}"`,
      );
    }
    return upstreamValue;
  }
  
  // Check if per-provider override is enabled
  if (providerConfigs && provider) {
    const providerConfig = providerConfigs[provider];
    if (providerConfig && providerConfig.allowBaseUrlOverride === false) {
      // Override disabled for this provider, use configured upstream
      return upstreams[upstreamKey];
    }
  }
  
  const headerValue = headers[headerName];
  if (headerValue) {
    const normalized = normalizeUpstreamUrl(headerValue);
    if (process.env.DEBUG_ROUTING === "true") {
      console.error(
        `[DEBUG_ROUTING] Using ${headerName} header: ${normalized}`,
      );
    }
    return normalized;
  }
  return upstreams[upstreamKey];
}

const API_PATH_SEGMENTS = new Set([
  "v1",
  "v1beta",
  "v1alpha",
  "v1internal",
  "responses",
  "chat",
  "models",
  "embeddings",
  "backend-api",
  "api",
  "codex",
  "gateway",
]);

/**
 * Classify an incoming request by provider and API format.
 *
 * Uses URL path patterns and header checks. All detection heuristics
 * live here so routing and format detection stay in sync.
 *
 * Detection order: ChatGPT → Anthropic → Gemini → Vertex → OpenAI (path) →
 *   NVIDIA (x-nvidia-baseurl) → OpenRouter (x-openrouter-baseurl) →
 *   Kilo (x-kilo-baseurl) → OpenAI (x-openai-baseurl) → OpenAI (catch-all).
 */
export function classifyRequest(
  pathname: string,
  headers: Record<string, string | undefined>,
  strictUrlForwarding = false,
  upstreams?: Upstreams,
): { provider: Provider; apiFormat: ApiFormat } {
  if (process.env.DEBUG_ROUTING === "true") {
    console.log(
      `[DEBUG_ROUTING] classifyRequest: pathname=${pathname}, strictUrlForwarding=${strictUrlForwarding}, upstreams=${upstreams ? 'provided' : 'undefined'}`,
    );
  }

  // ChatGPT backend (Codex subscription uses /api/ and /backend-api/ paths)
  // /codex/ is used by Pi's openai-codex provider (appends /codex/responses to baseUrl)
  if (pathname.match(/^\/(api|backend-api|codex)\//))
    return { provider: "chatgpt", apiFormat: "chatgpt-backend" };

  // Anthropic Messages API
  if (pathname.includes("/v1/messages"))
    return { provider: "anthropic", apiFormat: "anthropic-messages" };
  if (pathname.includes("/v1/complete"))
    return { provider: "anthropic", apiFormat: "unknown" };
  if (headers["anthropic-version"])
    return { provider: "anthropic", apiFormat: "unknown" };

  // Vertex AI: must come before Gemini (Vertex paths also contain :generateContent)
  const isVertexPath = pathname.match(
    /\/v1[^/]*\/projects\/[^/]+\/locations\/[^/]+\/publishers\/google\/models\//,
  );
  if (isVertexPath)
    return { provider: "vertex", apiFormat: "gemini" };

  // Gemini (checked before OpenAI because both use /models/ paths)
  const isGeminiPath =
    pathname.includes(":generateContent") ||
    pathname.includes(":streamGenerateContent") ||
    pathname.match(/\/v1(beta|alpha)\/models\//) ||
    pathname.includes("/v1internal:");
  if (isGeminiPath || headers["x-goog-api-key"])
    return { provider: "gemini", apiFormat: "gemini" };

  // NVIDIA: detect by x-nvidia-baseurl (header contains the actual URL)
  // or Bearer nv-* token prefix. Skip header check when strictUrlForwarding.
  // Note: Node.js lowercases all incoming headers, so we check lowercase.
  const nvidiaBaseUrl = headers["x-nvidia-baseurl"];
  if (process.env.DEBUG_ROUTING === "true") {
    console.error(
      `[DEBUG_ROUTING] NVIDIA check: strictUrlForwarding=${strictUrlForwarding}, x-nvidia-baseurl=${nvidiaBaseUrl || "NOT SET"}`,
    );
  }
  if (
    !strictUrlForwarding &&
    nvidiaBaseUrl
  )
    return { provider: "nvidia", apiFormat: "chat-completions" };
  if (
    pathname.includes("/v1/chat/completions") &&
    headers["authorization"]?.startsWith("Bearer nv-")
  )
    return { provider: "nvidia", apiFormat: "chat-completions" };

  // Fallback: detect provider via x-target-url header pointing to known upstream
  // This handles cases where the client sends requests to the proxy with an explicit
  // target URL (e.g., via mitmproxy or direct forwarding)
  const targetUrlHeader = headers["x-target-url"];
  if (targetUrlHeader && typeof targetUrlHeader === "string" && upstreams) {
    try {
      const targetUrlObj = new URL(targetUrlHeader);
      const hostname = targetUrlObj.hostname;
      for (const [upstreamProvider, upstreamUrl] of Object.entries(upstreams)) {
        if (upstreamUrl) {
          const upstreamUrlObj = new URL(upstreamUrl);
          if (hostname === upstreamUrlObj.hostname || hostname.endsWith(`.${upstreamUrlObj.hostname}`)) {
            // For NVIDIA, OpenRouter, Kilo - they use chat-completions format
            let apiFormat: ApiFormat = "chat-completions";
            if (upstreamProvider === "anthropic") apiFormat = "anthropic-messages";
            else if (upstreamProvider === "gemini" || upstreamProvider === "vertex") apiFormat = "gemini";
            else if (upstreamProvider === "chatgpt") apiFormat = "chatgpt-backend";
            else if (upstreamProvider === "openai") apiFormat = "chat-completions";

            if (process.env.DEBUG_ROUTING === "true") {
              console.error(
                `[DEBUG_ROUTING] Provider fallback detection via x-target-url: ${upstreamProvider} (${hostname})`,
              );
            }
            return { provider: upstreamProvider as Provider, apiFormat };
          }
        }
      }
    } catch {
      // Invalid URL, ignore
    }
  }

  // Kilo Code Gateway: detect by x-kilo-baseurl (header contains the actual URL)
  // Skip header check when strictUrlForwarding.
  if (!strictUrlForwarding && headers["x-kilo-baseurl"])
    return { provider: "kilo", apiFormat: "chat-completions" };

  // OpenRouter: detect by x-openrouter-baseurl (header contains the actual URL)
  // Skip header check when strictUrlForwarding.
  if (!strictUrlForwarding && headers["x-openrouter-baseurl"])
    return { provider: "openrouter", apiFormat: "chat-completions" };

  // OpenAI platform API: detect by x-openai-baseurl header (takes precedence)
  // Skip header check when strictUrlForwarding.
  if (!strictUrlForwarding && headers["x-openai-baseurl"])
    return { provider: "openai", apiFormat: "chat-completions" };

  // OpenAI platform API (catch-all for Bearer sk- tokens)
  if (pathname.includes("/responses"))
    return { provider: "openai", apiFormat: "responses" };
  if (pathname.includes("/chat/completions"))
    return { provider: "openai", apiFormat: "chat-completions" };
  if (pathname.match(/\/(models|embeddings)/))
    return { provider: "openai", apiFormat: "unknown" };
  if (headers.authorization?.startsWith("Bearer sk-"))
    return { provider: "openai", apiFormat: "unknown" };

  // Default to openai for unrecognized paths (many are OpenAI-compatible)
  return { provider: "openai", apiFormat: "unknown" };
}

/** Check if a string looks like a session ID (8 lowercase hex chars). */
function isSessionId(segment: string): boolean {
  return /^[a-f0-9]{8}$/.test(segment);
}

/**
 * Extract a source tool tag and optional session ID from a request path.
 *
 * The CLI prepends a source tag (and optionally a session ID) to the URL
 * path so the proxy can attribute traffic to specific tools:
 *
 *   `/claude/v1/messages`          -> source="claude", sessionId=null, cleanPath="/v1/messages"
 *   `/claude/ab12cd34/v1/messages` -> source="claude", sessionId="ab12cd34", cleanPath="/v1/messages"
 *   `/v1/messages`                 -> source=null (no tag; path starts with a known API segment)
 *
 * Path traversal attempts (encoded slashes, ".." segments) are rejected.
 */
export function extractSource(pathname: string): ExtractSourceResult {
  const match = pathname.match(/^\/([^/]+)(\/.*)?$/);
  if (match?.[2] && !API_PATH_SEGMENTS.has(match[1])) {
    let decoded = match[1];
    try {
      decoded = decodeURIComponent(match[1]);
    } catch {
      decoded = match[1];
    }
    if (
      decoded.includes("/") ||
      decoded.includes("\\") ||
      decoded.includes("..")
    ) {
      return { source: null, sessionId: null, cleanPath: pathname };
    }

    // Check for session ID as the next segment: /source/sessionId/rest...
    const rest = match[2] || "/";
    const sessionMatch = rest.match(/^\/([^/]+)(\/.*)?$/);
    if (sessionMatch?.[2] && isSessionId(sessionMatch[1])) {
      return {
        source: decoded,
        sessionId: sessionMatch[1],
        cleanPath: sessionMatch[2] || "/",
      };
    }

    return { source: decoded, sessionId: null, cleanPath: rest };
  }
  return { source: null, sessionId: null, cleanPath: pathname };
}

/**
 * Determine the upstream URL to forward a request to.
 *
 * Checks for an explicit `x-target-url` header first (used by
 * mitmproxy addon to specify the original destination). Falls back
 * to the configured upstream base URL for the detected provider.
 *
 * @param pathname - Cleaned request path (source tag already stripped).
 * @param search - Query string including "?", or null.
 * @param headers - Request headers (may contain x-target-url).
 * @param upstreams - Configured upstream base URLs per provider.
 * @param strictUrlForwarding - If true, ignore per-provider base URL override headers.
 * @param providerConfigs - Optional provider configurations for per-provider override settings.
 */
export function resolveTargetUrl(
  pathname: string,
  search: string | null,
  headers: Record<string, string | undefined>,
  upstreams: Upstreams,
  strictUrlForwarding = false,
  providerConfigs?: Record<string, ProviderConfig>,
): ResolveTargetResult {
  const { provider, apiFormat } = classifyRequest(
    pathname,
    headers,
    strictUrlForwarding,
    upstreams,
  );
const qs = search || "";
  let targetUrl: string | undefined = headers["x-target-url"];
  // Track whether targetUrl came from an explicit header (vs. configured upstream)
  let targetUrlFromHeader = !!headers["x-target-url"];

  if (process.env.DEBUG_ROUTING === "true") {
    console.error(
      `[DEBUG_ROUTING] pathname=${pathname}, provider=${provider}, apiFormat=${apiFormat}`,
    );
    console.error(
      `[DEBUG_ROUTING] x-target-url=${headers["x-target-url"] || "none"}`,
    );
  }

  if (!targetUrl) {
    if (provider === "chatgpt") {
      // Paths from Pi's openai-codex provider arrive as /codex/responses
      // (without the /backend-api prefix). Prepend it if missing.
      const chatgptPath = pathname.match(/^\/(api|backend-api)\//)
        ? pathname
        : `/backend-api${pathname}`;
      targetUrl = getBaseUrl("x-chatgpt-baseurl", "chatgpt", headers, upstreams, strictUrlForwarding, providerConfigs, provider) + chatgptPath + qs;
    } else if (provider === "anthropic") {
      targetUrl = getBaseUrl("x-anthropic-baseurl", "anthropic", headers, upstreams, strictUrlForwarding, providerConfigs, provider) + pathname + qs;
    } else if (provider === "gemini") {
      const isCodeAssist = pathname.includes("/v1internal");
      targetUrl =
        getBaseUrl(
          isCodeAssist ? "x-gemini-code-assist-baseurl" : "x-gemini-baseurl",
          isCodeAssist ? "geminiCodeAssist" : "gemini",
          headers,
          upstreams,
          strictUrlForwarding,
          providerConfigs,
          provider,
        ) + pathname + qs;
    } else if (provider === "vertex") {
      const locMatch = pathname.match(/\/locations\/([^/]+)\//);
      const location = locMatch?.[1];
      if (location && location !== "global") {
        targetUrl = `https://${location}-aiplatform.googleapis.com${pathname}${qs}`;
      } else {
        targetUrl = getBaseUrl("x-vertex-baseurl", "vertex", headers, upstreams, strictUrlForwarding, providerConfigs, provider) + pathname + qs;
      }
    } else if (provider === "nvidia") {
      // NVIDIA uses OpenAI-compatible API format
      // Normalize path: ensure /v1/ prefix for chat/completions endpoints
      const nvidiaPath = pathname.startsWith("/v1/")
        ? pathname
        : `/v1${pathname}`;
      targetUrl = getBaseUrl("x-nvidia-baseurl", "nvidia", headers, upstreams, strictUrlForwarding, providerConfigs, provider) + nvidiaPath + qs;
    } else if (provider === "kilo") {
      // Kilo Code Gateway is OpenAI-compatible, normalize path: ensure /v1/ prefix
      const kiloPath = pathname.startsWith("/v1/")
        ? pathname
        : `/v1${pathname}`;
      targetUrl = getBaseUrl("x-kilo-baseurl", "kilo", headers, upstreams, strictUrlForwarding, providerConfigs, provider) + kiloPath + qs;
    } else if (provider === "openrouter") {
      // OpenRouter is OpenAI-compatible, ensure path starts with /v1/
      // OpenRouter API expects /v1/chat/completions prefix
      let openrouterPath: string;
      if (pathname.startsWith("/v1/")) {
        // Path already has /v1/ prefix, use as-is
        openrouterPath = pathname;
      } else {
        // Path needs /v1/ prefix added
        openrouterPath = `/v1${pathname}`;
      }
      targetUrl = getBaseUrl("x-openrouter-baseurl", "openrouter", headers, upstreams, strictUrlForwarding, providerConfigs, provider) + openrouterPath + qs;
    } else if (provider === "openai") {
      // Codex Enterprise sets OPENAI_BASE_URL without a /v1 suffix and
      // appends paths like /responses directly. Normalize /responses to
      // /v1/responses so it reaches the correct endpoint on api.openai.com.
      const openaiPath =
        pathname === "/responses" ? "/v1/responses" : pathname;
      targetUrl = getBaseUrl("x-openai-baseurl", "openai", headers, upstreams, strictUrlForwarding, providerConfigs, provider) + openaiPath + qs;
    }

    if (process.env.DEBUG_ROUTING === "true" && targetUrl) {
      console.error(`[DEBUG_ROUTING] Final targetUrl: ${targetUrl}`);
    }
  } else if (targetUrl && !targetUrl.startsWith("http")) {
    targetUrl = targetUrl + pathname + qs;
    if (process.env.DEBUG_ROUTING === "true") {
      console.error(`[DEBUG_ROUTING] Relative URL resolved to: ${targetUrl}`);
    }
  }

  // Second-pass: if the resolved target URL matches a known upstream,
  // override the provider to ensure correct rate limiting and retry behavior.
  // This handles cases where:
  // 1. The client uses an OpenAI-compatible upstream (NVIDIA, OpenRouter, Kilo, etc.)
  //    via x-openai-baseurl or x-target-url headers
  // 2. The classified provider's upstream differs from the actual target upstream
  //    (e.g., gemini paths with /v1internal: routed to geminiCodeAssist upstream)
  // Only override when:
  // 1. The targetUrl came from an explicit header (x-target-url or provider-specific base URL), OR
  // 2. The provider was not confidently identified (unknown), OR
  // 3. The targetUrl doesn't match the classified provider's upstream (different upstream used)
  let finalProvider = provider;
  let finalApiFormat = apiFormat;
  if (targetUrl) {
    try {
      const targetUrlObj = new URL(targetUrl);
      // Check if targetUrl hostname matches the classified provider's upstream
      const classifiedUpstreamUrl = upstreams[provider as keyof Upstreams];
      const matchesClassifiedUpstream = classifiedUpstreamUrl
        ? targetUrlObj.hostname === new URL(classifiedUpstreamUrl).hostname
        : false;

      for (const [upstreamProvider, upstreamUrl] of Object.entries(upstreams)) {
        if (upstreamUrl) {
          const upstreamUrlObj = new URL(upstreamUrl);
          if (targetUrlObj.hostname === upstreamUrlObj.hostname) {
            // Only override if:
            // - targetUrl came from an explicit header, OR
            // - provider was unknown, OR
            // - targetUrl doesn't match the classified provider's upstream (different upstream used)
            const shouldOverride =
              targetUrlFromHeader ||
              provider === "unknown" ||
              !matchesClassifiedUpstream;

            if (shouldOverride) {
              finalProvider = upstreamProvider as Provider;
              // Most OpenAI-compatible providers use chat-completions format
              // Override apiFormat for known providers
              if (upstreamProvider === "nvidia" || upstreamProvider === "openrouter" || upstreamProvider === "kilo") {
                finalApiFormat = "chat-completions";
              }
              if (process.env.DEBUG_ROUTING === "true") {
                console.error(
                  `[DEBUG_ROUTING] Second-pass: Overriding provider to ${upstreamProvider} based on target URL hostname: ${targetUrlObj.hostname}`,
                );
              }
            }
            break;
          }
        }
      }
    } catch {
      // Invalid URL, keep original provider
    }
  }

  // targetUrl may be undefined for unknown providers
  if (process.env.DEBUG_ROUTING === "true") {
    console.error(
      `[DEBUG_ROUTING] Result: targetUrl=${targetUrl}, provider=${finalProvider}`,
    );
  }
  return { targetUrl, provider: finalProvider, apiFormat: finalApiFormat };
}
