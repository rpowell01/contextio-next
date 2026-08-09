---
layout: doc
---

# Retry Plugin Configuration

The built-in retry plugin provides **exponential backoff with jitter** for failed requests, plus **streaming SSE error detection** and **NVIDIA worker retry** special handling.

## Environment Variables

| Variable | Default | Description |
|----------|---------|-------------|
| `CONTEXTIO_ENABLE_RATE_LIMITER` | `true` | Enable rate limiter (retry enabled when this is `true`) |
| `CONTEXTIO_RETRY_MAX_ATTEMPTS` | `3` | Max retry attempts |
| `CONTEXTIO_RETRY_BASE_DELAY_MS` | `500` | Base delay for exponential backoff |
| `CONTEXTIO_RETRY_MAX_DELAY_MS` | `30000` | Cap on delay |
| `CONTEXTIO_RETRY_JITTER_FACTOR` | `0.1` | Jitter factor (0-1) |
| `CONTEXTIO_RETRY_RETRYABLE_STATUS_CODES` | `429,500,502,503,504` | HTTP status codes to retry |
| `CONTEXTIO_RETRY_PROVIDER_OVERRIDES` | *(JSON)* | Per-provider config overrides |

> **Note**: The retry plugin is automatically enabled when the rate limiter is enabled (`CONTEXTIO_ENABLE_RATE_LIMITER=true`). There is no separate `CONTEXTIO_RETRY_ENABLED` variable.

## Backoff Algorithm

```
delay = min(baseDelay * 2^attempt + jitter, maxDelay)
jitter = random(-jitterFactor, +jitterFactor) * baseDelay * 2^attempt
```

With defaults (base=500ms, max=30s, jitter=0.1):
- Attempt 1: ~450-550ms
- Attempt 2: ~900-1100ms
- Attempt 3: ~1800-2200ms

## What Gets Retried

### HTTP Status Codes
- `429` — Too Many Requests (rate limited)
- `500` — Internal Server Error
- `502` — Bad Gateway
- `503` — Service Unavailable
- `504` — Gateway Timeout

### Streaming SSE Errors
The plugin detects rate limit errors in streaming responses:
- `event: error` with `data: {"type": "error", "error": {"type": "rate_limit_error"}}`
- Anthropic-style SSE error format
- Provider-specific error detection fallback

## NVIDIA Worker Retry

Special handling for NVIDIA `ResourceExhausted` errors:

1. Detects `"error": {"type": "ResourceExhausted"}` in response body
2. Appends a `"continue"` user message to the `messages` array
3. Retries the request (counts against `maxAttempts`)

**Configuration** (via `CONTEXTIO_RETRY_PROVIDER_OVERRIDES`):
```json
{
  "nvidia": {
    "workerRetry": {
      "enabled": true,
      "maxWorkerRetries": 2,
      "continueMessage": "continue"
    }
  }
}
```

## Provider Overrides

Per-provider configuration via JSON in `CONTEXTIO_RETRY_PROVIDER_OVERRIDES`:

```bash
CONTEXTIO_RETRY_PROVIDER_OVERRIDES='{
  "anthropic": { "maxAttempts": 5, "baseDelayMs": 1000 },
  "openai": { "maxAttempts": 3, "baseDelayMs": 500 },
  "nvidia": { "workerRetry": { "enabled": true, "maxWorkerRetries": 3 } }
}'
```

## Disable Retry

```bash
# Disable rate limiter (also disables retry)
CONTEXTIO_ENABLE_RATE_LIMITER=false

# Or per-provider (programmatic only)
createRetryPlugin({
  providerOverrides: {
    openai: { enabled: false }
  }
})
```

## Web UI Configuration

Settings → **Retry** tab (if available) or via `settings.json`:

```json
{
  "retry": {
    "enabled": true,
    "maxAttempts": 3,
    "baseDelayMs": 500,
    "maxDelayMs": 30000,
    "jitterFactor": 0.1,
    "retryableStatusCodes": [429, 500, 502, 503, 504],
    "providerOverrides": {
      "nvidia": { "workerRetry": { "enabled": true } }
    }
  }
}
```

## Programmatic Usage

```typescript
import { createProxy, createRetryPlugin } from '@contextio/proxy';

const retry = createRetryPlugin({
  maxAttempts: 3,
  baseDelayMs: 500,
  maxDelayMs: 30000,
  jitterFactor: 0.1,
  retryableStatusCodes: [429, 500, 502, 503, 504],
  providerOverrides: {
    anthropic: { maxAttempts: 5 },
    nvidia: { workerRetry: { enabled: true, maxWorkerRetries: 2 } }
  },
  onRetry: (attempt, error, delay) => {
    console.log(`Retry attempt ${attempt} after ${delay}ms:`, error.message);
  }
});

const proxy = createProxy({
  port: 4040,
  plugins: [retry],
});
```

## Debugging

Enable debug logging:
```bash
LOG_LEVEL=debug
DEBUG_ROUTING=true
```

Look for log lines:
```
[RETRY] Attempt 1/3 after 523ms: HTTP 429
[RETRY] Streaming SSE error detected: rate_limit_error
[RETRY] NVIDIA worker retry: appending continue message
```