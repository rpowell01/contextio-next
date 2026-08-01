# Rate Limiting

ContextIO-Next includes a built-in **rate limiter** that protects upstream LLM APIs from excessive traffic. It uses a **token bucket algorithm** with optional burst buffering, applied **per session** and **per provider**.

## Overview

| Aspect | Description |
|--------|-------------|
| **Algorithm** | Token bucket with sliding window refill |
| **Scope** | Per `(sessionId, provider)` combination |
| **Burst handling** | Configurable buffer capacity |
| **Queueing** | Requests wait for tokens up to buffer limit |
| **Rejection** | HTTP 429 with `Retry-After` and `rateLimitInfo` |
| **Memory management** | LRU eviction + TTL cleanup (max 10k buckets by default) |

## How It Works

### Token Bucket Algorithm

Each unique `(sessionId, provider)` pair gets its own bucket:

```
Tokens available = min(maxRequests + bufferCapacity, currentTokens + elapsedTime * refillRate)
```

- **Refill rate**: `maxRequests / windowMs` tokens per millisecond
- **Max tokens**: `maxRequests + bufferCapacity` (allows bursting)
- **Consumption**: 1 token per request

### Request Flow

```
Request arrives
       │
       ▼
Generate key: `${sessionId}:${provider}`
       │
       ▼
Get/create bucket for key
       │
       ▼
Refill tokens based on elapsed time
       │
       ▼
Tokens ≥ 1?
  ├─ Yes ──▶ Consume token ──▶ Forward request
  │
  └─ No ──▶ Queue length < bufferCapacity?
            ├─ Yes ──▶ Queue request, schedule refill timer
            │
            └─ No ──▶ Return 429 with Retry-After header
```

### Queue Processing

- Queued requests are processed **FIFO** as tokens become available
- A timer fires when the next token will be available
- Multiple tokens can be consumed in one timer tick if refill > 1

## Configuration

### Environment Variables

All settings use the pattern `CONTEXTIO_RATE_LIMIT_<PROVIDER>_<SETTING>`.

| Variable | Type | Default | Range | Description |
|----------|------|---------|-------|-------------|
| `CONTEXTIO_RATE_LIMIT_<PROVIDER>_MAX_REQUESTS` | integer | `60` | 1–10000 | Max requests per window |
| `CONTEXTIO_RATE_LIMIT_<PROVIDER>_WINDOW_MS` | integer | `60000` | 100–86400000 | Window duration in ms |
| `CONTEXTIO_RATE_LIMIT_<PROVIDER>_BUFFER` | integer | `10` | 0–10000 | Burst buffer capacity |
| `RATE_LIMITER_ENABLED` | boolean | `true` | `true`/`false` | Master enable/disable switch for the entire rate limiter |

**Valid providers**: `openai`, `anthropic`, `chatgpt`, `gemini`, `vertex`, `nvidia`, `openrouter`, `kilo`, `unknown`

To completely disable the rate limiter, set:
```bash
RATE_LIMITER_ENABLED=false
```

### Web UI Settings

The Settings page writes to `/app/custom-policy/settings.json`. Environment variables **override** UI settings.

```json
{
  "rateLimiter": {
    "anthropic": { "maxRequests": 100, "windowMs": 60000, "bufferCapacity": 20 },
    "openai":    { "maxRequests": 60,  "windowMs": 60000, "bufferCapacity": 10 },
    "gemini":    { "maxRequests": 30,  "windowMs": 60000, "bufferCapacity": 5 }
  }
}
```

### Global Defaults (Code)

```typescript
const defaultRateLimit: RateLimitConfig = {
  maxRequests: 60,
  windowMs: 60_000,
  bufferCapacity: 10,
};
```

### Advanced Options (Programmatic Only)

These are only available when creating the plugin programmatically:

| Option | Type | Default | Description |
|--------|------|---------|-------------|
| `maxEntries` | number | `10000` | Max buckets tracked (LRU eviction) |
| `cleanupIntervalMs` | number | `300000` | Cleanup timer interval (5 min) |
| `entryTtlMs` | number | `600000` | Bucket TTL when inactive (10 min) |
| `enabled` | boolean | `true` | Master enable/disable switch |
| `keyGenerator` | `(ctx) => string` | `sessionId:provider` | Custom bucket key function |
| `onRateLimited` | `(ctx, retryAfterMs) => void` | noop | Callback on 429 response |

## 429 Response Details

When the queue is full, the proxy responds with:

### Headers
```
HTTP/1.1 429 Too Many Requests
Retry-After: 2
Content-Type: application/json
```

Note: `Retry-After` header value is in **seconds** (per HTTP spec), while the JSON body uses milliseconds.

### Body
```json
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

| Field | Type | Description |
|-------|------|-------------|
| `limit` | integer | Configured `maxRequests` |
| `remaining` | integer | Always `0` on 429 |
| `reset` | integer | Unix timestamp (seconds) when window resets |
| `retryAfter` | integer | Milliseconds until next token available |

### Client Handling

Clients should:
1. Read `Retry-After` header (**seconds**, per HTTP RFC 7231)
2. Read `rateLimitInfo.retryAfter` in JSON body (**milliseconds**) for finer precision
3. Wait that duration before retrying
4. Respect `rateLimitInfo.reset` for window alignment
5. Implement exponential backoff for repeated 429s

## Session & Provider Identification

The rate limiter key is derived from:

1. **Session ID** (priority order):
   - `x-kilo-session` header
   - `x-session-affinity` header
   - `x-claude-code-session-id` header
   - URL-embedded session (e.g., `/claude/<sessionId>/v1/messages`)
   - Falls back to `__default__`

2. **Provider**: Determined by routing logic from request path/headers:
   - `/claude/` → `anthropic`
   - `/openai/` or `/v1/` → `openai`
   - `/chatgpt/` → `chatgpt`
   - `/gemini/` → `gemini`
   - `/vertex/` → `vertex`
   - etc.

**Result**: Each AI tool session gets independent limits per provider.

## Example Configurations

### Strict Per-Minute (Production APIs)

```bash
# Anthropic: 50 req/min, 5 burst
CONTEXTIO_RATE_LIMIT_ANTHROPIC_MAX_REQUESTS=50
CONTEXTIO_RATE_LIMIT_ANTHROPIC_WINDOW_MS=60000
CONTEXTIO_RATE_LIMIT_ANTHROPIC_BUFFER=5

# OpenAI: 60 req/min, 10 burst
CONTEXTIO_RATE_LIMIT_OPENAI_MAX_REQUESTS=60
CONTEXTIO_RATE_LIMIT_OPENAI_WINDOW_MS=60000
CONTEXTIO_RATE_LIMIT_OPENAI_BUFFER=10
```

### Burst-Friendly (Interactive Coding)

```bash
# Allow short bursts for autocomplete/chat
CONTEXTIO_RATE_LIMIT_ANTHROPIC_MAX_REQUESTS=120
CONTEXTIO_RATE_LIMIT_ANTHROPIC_WINDOW_MS=60000
CONTEXTIO_RATE_LIMIT_ANTHROPIC_BUFFER=40

CONTEXTIO_RATE_LIMIT_OPENAI_MAX_REQUESTS=120
CONTEXTIO_RATE_LIMIT_OPENAI_WINDOW_MS=60000
CONTEXTIO_RATE_LIMIT_OPENAI_BUFFER=40
```

### Hourly Budget (Batch/Background)

```bash
# 1000 requests/hour, 100 burst
CONTEXTIO_RATE_LIMIT_OPENAI_MAX_REQUESTS=1000
CONTEXTIO_RATE_LIMIT_OPENAI_WINDOW_MS=3600000
CONTEXTIO_RATE_LIMIT_OPENAI_BUFFER=100
```

### Disable for a Provider

```bash
# Option 1: Use the programmatic API
createRateLimiterPlugin({ enabled: false });

# Option 2: Set very high limits (max allowed is 10000)
CONTEXTIO_RATE_LIMIT_OPENAI_MAX_REQUESTS=10000
CONTEXTIO_RATE_LIMIT_OPENAI_WINDOW_MS=100
CONTEXTIO_RATE_LIMIT_OPENAI_BUFFER=0
```

## Programmatic API

### Creating the Plugin

```typescript
import { createRateLimiterPlugin, RateLimiterConfig } from '@contextio/proxy';

const config: RateLimiterConfig = {
  defaults: {
    maxRequests: 100,
    windowMs: 60_000,
    bufferCapacity: 20,
  },
  maxEntries: 5000,
  cleanupIntervalMs: 60_000,
  entryTtlMs: 300_000,
  enabled: true,
  keyGenerator: (ctx) => `${ctx.sessionId}:${ctx.provider}`,
  onRateLimited: (ctx, retryAfterMs) => {
    console.warn(`Rate limited: ${ctx.sessionId}:${ctx.provider}, retry after ${retryAfterMs}ms`);
  },
};

const rateLimiter = createRateLimiterPlugin(config);
```

### Using with createProxy

```typescript
import { createProxy } from '@contextio/proxy';

const proxy = createProxy({
  port: 4040,
  plugins: [rateLimiter],
});

await proxy.start();
```

### Using with createProxyHandler (Low-Level)

```typescript
import { createProxyHandler, createRateLimiterPlugin } from '@contextio/proxy';
import http from 'node:http';

const handler = createProxyHandler({
  upstreams: { openai: 'https://api.openai.com', anthropic: 'https://api.anthropic.com' },
  allowTargetOverride: false,
  plugins: [createRateLimiterPlugin()],
  logTraffic: false,
});

const server = http.createServer(handler);
server.listen(4040);
```

### Accessing Internals (Testing/Monitoring)

```typescript
const plugin = createRateLimiterPlugin();
// @ts-expect-error - internal API
const internal = plugin._internal;

console.log('All buckets:', internal.getAllKeys());
console.log('Bucket state:', internal.getBucketState('session123:anthropic'));
internal.clear(); // Reset for tests
internal.shutdown(); // Stop cleanup timer
```

## Memory & Performance

### Memory Usage

- **Per bucket**: ~200 bytes (tokens, timestamps, queue, timers)
- **10,000 buckets** (default max): ~2 MB
- **Queue memory**: Proportional to `bufferCapacity` × queued requests

### Cleanup Behavior

- **Interval**: Every `cleanupIntervalMs` (default 5 min)
- **Eviction**: Removes buckets inactive > `entryTtlMs` (default 10 min)
- **LRU**: If `maxEntries` exceeded, oldest buckets evicted first
- **Shutdown**: Call `plugin._internal.shutdown()` to stop timer and clear all buckets

### Performance Characteristics

- **Hot path**: O(1) map lookup + token arithmetic
- **No locks**: Single-threaded event loop, no contention
- **Timer overhead**: One `setTimeout` per active bucket with queue
- **Zero allocations** on fast path (token available)

## Troubleshooting

### "Rate limit exceeded" but low traffic

**Cause**: Session ID not being propagated correctly.

**Fix**: Ensure your AI tool sends a session identifier:
- Header: `x-kilo-session`, `x-session-affinity`, or `x-claude-code-session-id`
- URL: `/claude/<sessionId>/v1/messages`

### Requests hanging instead of 429

**Cause**: `bufferCapacity` too large, requests queued indefinitely.

**Fix**: Reduce `bufferCapacity` or increase `maxRequests`/`windowMs`.

### Memory growth over time

**Cause**: `maxEntries` too high or `entryTtlMs` too long for your traffic pattern.

**Fix**: Lower `maxEntries` and/or `entryTtlMs`.

### Different limits per environment

Use environment-specific `.env` files or Docker Compose overrides:

```yaml
# docker-compose.prod.yml
services:
  proxy:
    environment:
      - CONTEXTIO_RATE_LIMIT_ANTHROPIC_MAX_REQUESTS=50
      - CONTEXTIO_RATE_LIMIT_ANTHROPIC_BUFFER=5
```

## Migration from Legacy Config

The rate limiter accepts both formats for backward compatibility:

### Legacy (flat, deprecated)
```typescript
createRateLimiterPlugin({
  maxRequests: 100,
  windowMs: 60_000,
  bufferCapacity: 20,
});
```

### Current (nested, recommended)
```typescript
createRateLimiterPlugin({
  defaults: {
    maxRequests: 100,
    windowMs: 60_000,
    bufferCapacity: 20,
  },
});
```

Both work; **flat (legacy) format takes precedence** over nested format when both are provided.

## Related Features

- **Retry Plugin**: Automatically retries 429 responses with exponential backoff. Works seamlessly with rate limiter.
- **Web UI Settings**: Visual configuration at `http://localhost:4040/settings`.
- **Capture Logs**: Rate-limited requests are logged with `responseStatus: 429`.

## See Also

- [Web UI Documentation](#web-ui) — Configure via browser
- [Environment Variables](#environment-variables) — Full env var reference
- [Architecture](#architecture) — Plugin pipeline overview