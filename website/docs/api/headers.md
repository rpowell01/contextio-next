---
layout: doc
---

# Headers Reference

Complete reference for headers used by ContextIO Next.

## Request Headers (Client → Proxy)

### Provider Override Headers

| Header | Provider | Example | Notes |
|--------|----------|---------|-------|
| `x-anthropic-baseurl` | Anthropic | `https://api.anthropic.com` | Overrides `UPSTREAM_ANTHROPIC_URL` |
| `x-openai-baseurl` | OpenAI | `https://api.openai.com` | Overrides `UPSTREAM_OPENAI_URL` |
| `x-google-baseurl` | Gemini | `https://generativelanguage.googleapis.com` | Overrides `UPSTREAM_GEMINI_URL` |
| `x-gemini-code-assist-baseurl` | Gemini Code Assist | `https://cloudcode-pa.googleapis.com` | Overrides `UPSTREAM_GEMINI_CODE_ASSIST_URL` |
| `x-nvidia-baseurl` | NVIDIA | `https://integrate.api.nvidia.com` | Overrides `UPSTREAM_NVIDIA_URL` |
| `x-openrouter-baseurl` | OpenRouter | `https://openrouter.ai/api` | Overrides `UPSTREAM_OPENROUTER_URL` |
| `x-kilo-baseurl` | Kilo | `https://api.kilo.ai/api/gateway` | Overrides `UPSTREAM_KILO_URL` |
| `x-chatgpt-baseurl` | ChatGPT | `https://chatgpt.com` | Overrides `UPSTREAM_CHATGPT_URL` |
| `x-vertex-baseurl` | Vertex AI | `https://us-central1-aiplatform.googleapis.com` | Overrides `UPSTREAM_VERTEX_URL` |

### Control Headers

| Header | Values | Default | Description |
|--------|--------|---------|-------------|
| `x-contextio-redact` | `true`, `false` | Global setting | Enable/disable redaction per-request |
| `x-contextio-log` | `true`, `false` | Global setting | Enable/disable capture logging per-request |
| `x-target-url` | URL | — | Explicit upstream (requires `CONTEXT_PROXY_ALLOW_TARGET_OVERRIDE=1`) |

### Authentication

| Header | Description |
|--------|-------------|
| `x-api-key` | Provider API key (if not configured in Settings) |
| `authorization` | `Bearer <token>` — Used for provider detection (sk- → OpenAI, nv- → NVIDIA) |

### Standard Headers (Passthrough)

These are forwarded to upstream:
- `content-type`
- `anthropic-version` (Anthropic)
- `anthropic-beta` (Anthropic)
- `openai-organization` (OpenAI)
- `x-goog-api-key` (Gemini)
- `x-request-id` / `x-correlation-id` — Tracing

## Response Headers (Proxy → Client)

### Added by Proxy

| Header | Description |
|--------|-------------|
| `x-contextio-session-id` | 8-char session ID |
| `x-contextio-provider` | Detected provider (`anthropic`, `openai`, `gemini`, etc.) |
| `x-contextio-redacted` | `true` if redaction was applied |
| `x-contextio-api-format` | API format (`anthropic-messages`, `chat-completions`, `gemini`, etc.) |
| `x-retry-attempt` | Retry attempt number (0 = first, only on retry) |
| `x-retry-delay-ms` | Delay before this retry (ms) |

### Rate Limiting (on 429)

| Header | Description |
|--------|-------------|
| `Retry-After` | Seconds until retry (RFC 7231) |
| `X-RateLimit-Limit` | Max requests in window |
| `X-RateLimit-Remaining` | Tokens remaining (0 on 429) |
| `X-RateLimit-Reset` | Unix timestamp (seconds) when window resets |

### Rate Limit Info (JSON Body on 429)

```json
{
  "error": "Rate limit exceeded",
  "rateLimitInfo": {
    "limit": 60,
    "remaining": 0,
    "reset": 1700000045,
    "retryAfter": 45000
  }
}
```

| Field | Unit | Description |
|-------|------|-------------|
| `limit` | requests | Configured `maxRequests` |
| `remaining` | requests | Always 0 on 429 |
| `reset` | unix seconds | Window reset time |
| `retryAfter` | milliseconds | Precise retry delay |

## Request Headers Stripped (Not Forwarded)

| Header | Reason |
|--------|--------|
| `authorization` | Replaced with provider API key |
| `x-api-key` | Replaced with configured key |
| `cookie` / `set-cookie` | Security |
| `x-forwarded-*` | Added by proxy |
| `host` | Set to upstream host |
| `connection` | Proxy manages |

## Headers for Specific Providers

### Anthropic
```http
POST /v1/messages HTTP/1.1
x-api-key: sk-ant-...
anthropic-version: 2023-06-01
anthropic-beta: prompt-caching-2024-07-31
content-type: application/json
```

### OpenAI
```http
POST /v1/chat/completions HTTP/1.1
authorization: Bearer sk-...
openai-organization: org-...
content-type: application/json
```

### Gemini
```http
POST /v1/models/gemini-pro:generateContent HTTP/1.1
x-goog-api-key: ...
content-type: application/json
```

### NVIDIA
```http
POST /v1/chat/completions HTTP/1.1
authorization: Bearer nv-...
content-type: application/json
```

## Debug Headers

Enable with `DEBUG_ROUTING=true`:

| Header | Value |
|--------|-------|
| `x-debug-classification` | Provider detection reasoning |
| `x-debug-upstream` | Resolved upstream URL |
| `x-debug-rate-limited` | Rate limiter decision |

## CORS Headers

Proxy does **not** add CORS headers. Upstream responses pass through.

For browser clients, ensure:
- Upstream allows your origin
- Or use proxy as same-origin (no CORS needed)