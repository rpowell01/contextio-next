---
layout: doc
---

# API Reference Overview

ContextIO Next exposes several API endpoints for integration and automation.

## Base URL

```
http://localhost:4040   # Local
https://your-domain.com # Production
```

## Endpoint Categories

| Category | Prefix | Description |
|----------|--------|-------------|
| **Proxy** | `/v1/`, `/chat/`, `/claude/` | LLM API passthrough |
| **Admin** | `/admin/` | Proxy management, metrics, captures |
| **Auth** | `/api/auth/` | OIDC authentication |
| **Web UI** | `/` | Next.js application routes |

## Proxy Endpoints

These forward to upstream providers. Path-based routing:

| Path Pattern | Provider | Upstream |
|--------------|----------|----------|
| `/v1/messages` | Anthropic | `api.anthropic.com` |
| `/v1/chat/completions` | OpenAI | `api.openai.com` |
| `/v1/models/:generateContent` | Gemini | `generativelanguage.googleapis.com` |
| `/v1/.../publishers/google` | Vertex AI | `aiplatform.googleapis.com` |
| `/v1/chat/completions` + `x-nvidia-baseurl` | NVIDIA | `integrate.api.nvidia.com` |

See [Client Configuration](/quick-start/client-configuration) for tool setup.

## Admin API

Requires no authentication (same origin only). Use for monitoring/automation.

### Captures

| Method | Endpoint | Description |
|--------|----------|-------------|
| GET | `/admin/captures` | List captures (query: `sessionId`, `provider`, `limit`, `offset`) |
| GET | `/admin/captures/:id` | Get capture by filename |
| GET | `/admin/captures/session/:sessionId` | Get all captures for session |
| GET | `/admin/captures/search` | Search captures (query: `sessionId`, `model`, `status`, `startDate`, `endDate`) |
| GET | `/admin/captures/stats` | Capture statistics |
| DELETE | `/admin/captures/:id` | Delete capture |

### Sessions

| Method | Endpoint | Description |
|--------|----------|-------------|
| GET | `/admin/sessions` | List sessions |
| GET | `/admin/sessions/:sessionId` | Session details with captures |

### Redactions

| Method | Endpoint | Description |
|--------|----------|-------------|
| GET | `/admin/redactions/summary` | Redaction counts by type |
| GET | `/admin/redactions/session/:sessionId` | Redaction details for session |

### Metrics

| Method | Endpoint | Description |
|--------|----------|-------------|
| GET | `/admin/metrics/traffic` | Traffic metrics (volume, latency, errors) |
| GET | `/admin/metrics/rate-limiter` | Rate limiter state (buckets, 429s, queues) |

### Health

| Method | Endpoint | Description |
|--------|----------|-------------|
| GET | `/admin/health` | Health check (used by Docker) |

### Configuration

| Method | Endpoint | Description |
|--------|----------|-------------|
| GET | `/admin/config` | Current effective configuration |
| GET | `/admin/config/providers` | Provider configurations |

## Auth API (OIDC)

| Method | Endpoint | Description |
|--------|----------|-------------|
| GET | `/api/auth/signin` | Initiate OIDC flow |
| GET | `/api/auth/callback` | OIDC callback (provider redirects here) |
| GET | `/api/auth/signout` | Clear session |
| GET | `/api/auth/user` | Current user info (JSON) |

## Web UI Routes

| Route | Component |
|-------|-----------|
| `/` | Dashboard |
| `/sessions` | Session list & detail |
| `/redactions` | Redaction viewer |
| `/metrics` | Metrics dashboard |
| `/settings` | Configuration (6 tabs) |

## Request/Response Format

### Admin API Errors

```json
{
  "error": "Not Found",
  "message": "Capture not found",
  "statusCode": 404
}
```

### Pagination

```json
{
  "data": [...],
  "pagination": {
    "limit": 50,
    "offset": 0,
    "total": 1234,
    "hasMore": true
  }
}
```

## Rate Limiting

Admin API has **no rate limiting**. Proxy endpoints inherit provider rate limits.

## CORS

- Admin API: Same-origin only
- Proxy endpoints: Pass-through (upstream CORS applies)
- Auth API: Configured for OIDC redirect domains

## Example: List Recent Captures

```bash
curl http://localhost:4040/admin/captures?limit=10
```

Response:
```json
{
  "data": [
    {
      "filepath": "claude_a1b2c3d4_1739000000000-000001.json",
      "sessionId": "a1b2c3d4",
      "provider": "anthropic",
      "timestamp": "2026-02-15T20:50:00.815Z",
      "model": "claude-sonnet-4-20250514",
      "status": 200,
      "tokensPrompt": 150,
      "tokensCompletion": 500
    }
  ],
  "pagination": { "limit": 10, "offset": 0, "total": 42, "hasMore": true }
}
```

## Example: Get Rate Limiter State

```bash
curl http://localhost:4040/admin/metrics/rate-limiter
```

Response:
```json
{
  "activeBuckets": 23,
  "totalRequests": 4521,
  "upstream429s": 5,
  "local429s": 2,
  "nvidiaRetries": 1,
  "buckets": [
    { "sessionId": "a1b2c3d4", "provider": "anthropic", "tokensRemaining": 45, "maxTokens": 60, "queueDepth": 0 }
  ]
}
```