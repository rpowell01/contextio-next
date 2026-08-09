---
layout: doc
---

# Rate Limiter Configuration

The built-in rate limiter protects upstream LLM APIs from excessive traffic using a **token bucket algorithm** with optional burst buffering, applied **per session** and **per provider**.

## How It Works

- **Token bucket**: Each `(sessionId, provider)` pair gets its own bucket with `maxRequests` tokens refilling over `windowMs` milliseconds
- **Burst buffer**: `bufferCapacity` extra tokens allow short bursts above the steady-state rate
- **Queueing**: When tokens are exhausted, requests are queued (up to `bufferCapacity`) and processed as tokens refill
- **429 response**: When the queue is full, the proxy returns **HTTP 429** with a `Retry-After` header (seconds, per RFC 7231) and a `rateLimitInfo` JSON body
- **Memory bounds**: Tracks up to `maxEntries` buckets (default 10,000) with LRU eviction and TTL-based cleanup

## Environment Variables

| Variable | Default | Description |
|----------|---------|-------------|
| `CONTEXTIO_ENABLE_RATE_LIMITER` | `true` | Enable rate limiter |
| `CONTEXTIO_RATE_LIMIT_<PROVIDER>_MAX_REQUESTS` | `60` | Max requests per window |
| `CONTEXTIO_RATE_LIMIT_<PROVIDER>_WINDOW_MS` | `60000` | Time window in milliseconds |
| `CONTEXTIO_RATE_LIMIT_<PROVIDER>_BUFFER` | `10` | Burst buffer capacity |

**Valid providers**: `openai`, `anthropic`, `chatgpt`, `gemini`, `vertex`, `nvidia`, `openrouter`, `kilo`, `unknown`

## Configuration Examples

### Conservative (Strict per-minute limits)
```bash
CONTEXTIO_RATE_LIMIT_OPENAI_MAX_REQUESTS=30
CONTEXTIO_RATE_LIMIT_OPENAI_WINDOW_MS=60000
CONTEXTIO_RATE_LIMIT_OPENAI_BUFFER=5

CONTEXTIO_RATE_LIMIT_ANTHROPIC_MAX_REQUESTS=30
CONTEXTIO_RATE_LIMIT_ANTHROPIC_WINDOW_MS=60000
CONTEXTIO_RATE_LIMIT_ANTHROPIC_BUFFER=5
```

### Generous (Burst-friendly for interactive coding)
```bash
CONTEXTIO_RATE_LIMIT_OPENAI_MAX_REQUESTS=200
CONTEXTIO_RATE_LIMIT_OPENAI_WINDOW_MS=60000
CONTEXTIO_RATE_LIMIT_OPENAI_BUFFER=50

CONTEXTIO_RATE_LIMIT_ANTHROPIC_MAX_REQUESTS=200
CONTEXTIO_RATE_LIMIT_ANTHROPIC_WINDOW_MS=60000
CONTEXTIO_RATE_LIMIT_ANTHROPIC_BUFFER=50
```

### Per-hour Budget (Batch workloads)
```bash
CONTEXTIO_RATE_LIMIT_OPENAI_MAX_REQUESTS=1000
CONTEXTIO_RATE_LIMIT_OPENAI_WINDOW_MS=3600000
CONTEXTIO_RATE_LIMIT_OPENAI_BUFFER=100
```

### Disable for a Provider
```bash
# Option 1: Set very high limits (max allowed is 10000)
CONTEXTIO_RATE_LIMIT_OPENAI_MAX_REQUESTS=10000
CONTEXTIO_RATE_LIMIT_OPENAI_WINDOW_MS=100
CONTEXTIO_RATE_LIMIT_OPENAI_BUFFER=0

# Option 2: Disable globally
CONTEXTIO_ENABLE_RATE_LIMITER=false
```

## 429 Response Format

When rate limited, the proxy returns:

```http
HTTP/1.1 429 Too Many Requests
Retry-After: 60
Content-Type: application/json

{
  "error": "Rate limit exceeded",
  "rateLimitInfo": {
    "limit": 60,
    "remaining": 0,
    "reset": 1700000000,
    "retryAfter": 1234
  }
}
```

| Field | Meaning |
|-------|---------|
| `limit` | Configured `maxRequests` for the window |
| `remaining` | Tokens left (always `0` on 429) |
| `reset` | Unix timestamp (seconds) when the window resets |
| `retryAfter` | **Milliseconds** until a token is available (from JSON body) |

**Note**: The `Retry-After` header uses **seconds** (per HTTP RFC 7231). The `rateLimitInfo.retryAfter` in the JSON body uses milliseconds for finer precision.

## Web UI Configuration

The web UI (Settings → Rate Limiter tab) writes to `/app/custom-policy/settings.json`. Environment variables take precedence over UI settings.

**settings.json structure**:
```json
{
  "rateLimiter": {
    "anthropic": { "maxRequests": 100, "windowMs": 60000, "bufferCapacity": 20 },
    "openai":    { "maxRequests": 60,  "windowMs": 60000, "bufferCapacity": 10 }
  }
}
```

## Advanced Options (Programmatic)

```typescript
import { createRateLimiterPlugin } from '@contextio/proxy';

const rateLimiter = createRateLimiterPlugin({
  defaults: {
    maxRequests: 100,
    windowMs: 60_000,
    bufferCapacity: 20,
  },
  maxEntries: 10000,           // Max unique (session, provider) buckets
  cleanupIntervalMs: 300000,   // Stale bucket cleanup interval (5 min)
  entryTtlMs: 600000,          // Inactive bucket TTL (10 min)
  keyGenerator: (sessionId, provider) => `${sessionId}:${provider}`,
  onRateLimited: (info) => console.log('Rate limited:', info),
});
```

## Metrics

View live metrics in Web UI → **Metrics** → **Rate Limiter tab**:
- Active buckets
- Tokens remaining per bucket
- Upstream 429 responses
- Queue depths
- Request throughput