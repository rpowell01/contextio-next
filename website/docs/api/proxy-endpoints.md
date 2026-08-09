---
layout: doc
---

# Proxy Endpoints

Paths that forward to upstream LLM providers.

## Routing Overview

The proxy classifies requests by:
1. **URL path** — Primary classifier
2. **Headers** — Provider base URL overrides, auth patterns
3. **Source tags** — CLI-prepended `/source/` or `/source/sessionId/`

## Path Mappings

| Request Path | Provider | Upstream Path |
|--------------|----------|---------------|
| `/v1/messages` | Anthropic | `/v1/messages` |
| `/v1/complete` | Anthropic | `/v1/complete` |
| `/v1/chat/completions` | OpenAI | `/v1/chat/completions` |
| `/v1/responses` | OpenAI | `/v1/responses` |
| `/v1/models/:generateContent` | Gemini | `/v1/models/:generateContent` |
| `/v1/models/:streamGenerateContent` | Gemini | `/v1/models/:streamGenerateContent` |
| `/v1/.../publishers/google/models/` | Vertex AI | Same path |
| `/v1/chat/completions` + NVIDIA header | NVIDIA | `/v1/chat/completions` |
| `/v1/chat/completions` + OpenRouter header | OpenRouter | `/v1/chat/completions` |
| `/backend-api/...` | ChatGPT | `/backend-api/...` |
| `/api/...` | ChatGPT | `/api/...` |

## Source Tags (CLI)

The CLI prepends tool identifier:
```
/claude/v1/messages
/claude/ab12cd34/v1/messages
/gemini/v1/models/gemini-pro:generateContent
/codex/backend-api/conversation
```

Provider extracted from source tag when path ambiguous.

## Headers

### Required for Proxy
| Header | Purpose |
|--------|---------|
| `x-api-key` | Provider API key (if not in Settings) |

### Optional Overrides
| Header | Provider | Description |
|--------|----------|-------------|
| `x-anthropic-baseurl` | Anthropic | Override upstream |
| `x-openai-baseurl` | OpenAI | Override upstream |
| `x-google-baseurl` | Gemini | Override upstream |
| `x-gemini-code-assist-baseurl` | Gemini Code Assist | Override upstream |
| `x-nvidia-baseurl` | NVIDIA | Override upstream |
| `x-openrouter-baseurl` | OpenRouter | Override upstream |
| `x-kilo-baseurl` | Kilo | Override upstream |
| `x-chatgpt-baseurl` | ChatGPT | Override upstream |
| `x-vertex-baseurl` | Vertex AI | Override upstream |
| `x-target-url` | Any | Explicit target (requires `CONTEXT_PROXY_ALLOW_TARGET_OVERRIDE=1`) |

### Per-Request Control
| Header | Values | Effect |
|--------|--------|--------|
| `x-contextio-redact` | `true`, `false` | Override global redaction |
| `x-contextio-log` | `true`, `false` | Override global logging |

## Streaming Support

All endpoints support streaming:
- **SSE** (`text/event-stream`) — Anthropic, OpenAI, OpenRouter, NVIDIA
- **ndjson** — Gemini (some endpoints)
- **Chunked** — Custom providers

Proxy reassembles streams for:
- Capture logging
- Reversible redaction
- Metrics collection

## Error Handling

| Scenario | Response |
|----------|----------|
| Upstream 429 | Retry (if enabled) → 429 with `Retry-After` |
| Upstream 5xx | Retry (if enabled) → 502/503/504 |
| Upstream timeout | 504 Gateway Timeout |
| Provider not found | 400 Bad Request |
| Rate limited locally | 429 with `rateLimitInfo` |
| Redaction error | 500 (logged, request continues) |

## Response Headers Added

| Header | Description |
|--------|-------------|
| `x-contextio-session-id` | Session identifier |
| `x-contextio-provider` | Detected provider |
| `x-contextio-redacted` | `true` if redaction applied |
| `x-retry-attempt` | Retry attempt number (if retried) |

## Mittmproxy Chaining (Codex, Copilot, OpenCode)

Tools that ignore base URLs use mitmproxy:
```
Tool → HTTPS_PROXY → mitmproxy (TLS term) → ContextIO-Next (port 4040) → Upstream
```

Mitmproxy adds:
- `x-target-url` — Original destination
- `x-forwarded-for` — Client IP
- SNI passthrough for certificate validation