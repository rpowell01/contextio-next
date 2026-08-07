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
import type { ApiFormat, ExtractSourceResult, Provider, ResolveTargetResult, Upstreams, ProviderConfig } from "./types.js";
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
export declare function classifyRequest(pathname: string, headers: Record<string, string | undefined>, strictUrlForwarding?: boolean, upstreams?: Upstreams): {
    provider: Provider;
    apiFormat: ApiFormat;
};
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
export declare function extractSource(pathname: string): ExtractSourceResult;
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
export declare function resolveTargetUrl(pathname: string, search: string | null, headers: Record<string, string | undefined>, upstreams: Upstreams, strictUrlForwarding?: boolean, providerConfigs?: Record<string, ProviderConfig>): ResolveTargetResult;
//# sourceMappingURL=routing.d.ts.map