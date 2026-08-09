---
layout: doc
---

# Rate Limiting (Feature Deep Dive)

Protects upstream LLM APIs using per-session, per-provider token buckets.

## Algorithm: Token Bucket

```
┌─────────────────────────────────────────────────────────┐
│  Bucket per (sessionId, provider)                       │
│                                                         │
│  ┌─────────────────────────────────────────────────┐   │
│  │ Capacity: maxRequests + bufferCapacity          │   │
│  │ Refill: maxRequests per windowMs                │   │
│  │                                                   │   │
│  │  [##########........]  60/70 tokens             │   │
│  │   │        │                                       │   │
│  │   ▼        ▼                                       │   │
│  │ steady    burst                                   │   │
│  └─────────────────────────────────────────────────┘   │
└─────────────────────────────────────────────────────────┘
```

## Request Flow

```
Request
  │
  ▼
┌─────────────┐
│ Bucket      │── Has tokens? ──Yes──► Process Request
│ Exists?     │
└─────────────┘
  │ No
  ▼
┌─────────────┐
│ Create      │── Under maxEntries? ──Yes──► New Bucket (full)
│ Bucket      │
└─────────────┘
  │ No (maxEntries reached)
  ▼
┌─────────────┐
│ LRU Evict   │── oldest idle bucket ──► Reuse Slot
└─────────────┘
```

## Configuration

### Per-Provider (Environment Variables)
```bash
CONTEXTIO_RATE_LIMIT_ANTHROPIC_MAX_REQUESTS=100
CONTEXTIO_RATE_LIMIT_ANTHROPIC_WINDOW_MS=60000
CONTEXTIO_RATE_LIMIT_ANTHROPIC_BUFFER=20
```

### Global
```bash
RATE_LIMITER_ENABLED=true        # Master switch
```

### Advanced (Programmatic)
```typescript
createRateLimiterPlugin({
  defaults: { maxRequests: 60, windowMs: 60000, bufferCapacity: 10 },
  maxEntries: 10000,           // Max buckets
  cleanupIntervalMs: 300000,   // 5 min
  entryTtlMs: 600000,          // 10 min TTL
  keyGenerator: (sid, p) => `${sid}:${p}`,
  onRateLimited: (info) => alert(info),
})
```

## 429 Response

```http
HTTP/1.1 429 Too Many Requests
Retry-After: 45
Content-Type: application/json

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

| Header/Field | Unit | Description |
|--------------|------|-------------|
| `Retry-After` | seconds | RFC 7231 standard |
| `rateLimitInfo.retryAfter` | milliseconds | For client precision |
| `rateLimitInfo.reset` | unix seconds | Window reset time |

## Client Handling

### Automatic Retry (Recommended)
```typescript
// Client should respect Retry-After
const response = await fetch(url);
if (response.status === 429) {
  const retryAfter = response.headers.get('Retry-After') || 
                     (await response.json()).rateLimitInfo?.retryAfter / 1000;
  await sleep(retryAfter * 1000);
  return fetch(url); // retry
}
```

### Queue Behavior
- Requests queued when bucket empty (up to `bufferCapacity`)
- Processed FIFO as tokens refill
- Queue full → immediate 429

## Monitoring

Web UI → **Metrics → Rate Limiter**:
- Active buckets table
- Tokens remaining per bucket
- Queue depths
- 429 counts (local + upstream)

## Memory Management

| Parameter | Default | Description |
|-----------|---------|-------------|
| `maxEntries` | 10,000 | Max concurrent buckets |
| `cleanupIntervalMs` | 300,000 | Stale bucket scan (5 min) |
| `entryTtlMs` | 600,000 | Idle bucket TTL (10 min) |

LRU eviction when `maxEntries` reached.

## Best Practices

| Scenario | Configuration |
|----------|---------------|
| **Interactive coding** | High burst (buffer=50), 1-min window |
| **Batch processing** | High maxRequests, 1-hour window |
| **Strict quota** | Low maxRequests, no buffer |
| **Shared cluster** | Per-session limits, monitor 429s |

## Disabling

```bash
# Per provider (very high limits)
CONTEXTIO_RATE_LIMIT_OPENAI_MAX_REQUESTS=10000
CONTEXTIO_RATE_LIMIT_OPENAI_WINDOW_MS=100

# Globally
RATE_LIMITER_ENABLED=false
```