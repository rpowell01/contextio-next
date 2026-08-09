---
layout: doc
---

# Built-in Retry

Exponential backoff with jitter for transient failures + streaming SSE error detection.

## Retry Policy

| Parameter | Default | Description |
|-----------|---------|-------------|
| Max attempts | 3 | Total tries (original + retries) |
| Base delay | 500ms | Initial delay |
| Max delay | 30s | Cap on delay |
| Jitter | 10% | Randomization factor |
| Status codes | 429,500,502,503,504 | Retryable HTTP codes |

## Backoff Formula

```
delay = min(baseDelay × 2^attempt + jitter, maxDelay)
jitter = ±jitterFactor × baseDelay × 2^attempt
```

| Attempt | Base | With Jitter (±10%) |
|---------|------|-------------------|
| 1 | 500ms | 450-550ms |
| 2 | 1000ms | 900-1100ms |
| 3 | 2000ms | 1800-2200ms |

## What Triggers Retry

### HTTP Status Codes
- **429** — Rate limited (respects `Retry-After` if present)
- **500** — Internal server error
- **502** — Bad gateway
- **503** — Service unavailable
- **504** — Gateway timeout

### Streaming SSE Errors
Detects rate limit errors **inside streaming responses**:

```json
// Anthropic-style error in stream
event: error
data: {"type": "error", "error": {"type": "rate_limit_error", "message": "..."}}

// Generic error event
event: error
data: {"error": {"code": 429, "message": "Rate limit exceeded"}}
```

The plugin parses streaming chunks, detects `rate_limit_error`, and triggers retry **before** the stream ends.

### Provider-Specific Detection
Fallback for non-standard error formats:
- Anthropic: `error.type === 'rate_limit_error'`
- OpenAI: `error.code === 429` or `error.type === 'rate_limit_exceeded'`
- Custom: heuristic pattern matching

## Configuration

### Environment Variables
```bash
CONTEXTIO_RETRY_ENABLED=true
CONTEXTIO_RETRY_MAX_ATTEMPTS=3
CONTEXTIO_RETRY_BASE_DELAY_MS=500
CONTEXTIO_RETRY_MAX_DELAY_MS=30000
CONTEXTIO_RETRY_JITTER_FACTOR=0.1
CONTEXTIO_RETRY_RETRYABLE_STATUS_CODES=429,500,502,503,504
```

### Per-Provider Overrides (JSON)
```bash
CONTEXTIO_RETRY_PROVIDER_OVERRIDES='{
  "anthropic": { "maxAttempts": 5, "baseDelayMs": 1000 },
  "openai": { "maxAttempts": 3, "baseDelayMs": 500 },
  "nvidia": { "workerRetry": { "enabled": true, "maxWorkerRetries": 2 } }
}'
```

## NVIDIA Worker Retry (Special Case)

See [NVIDIA Worker Retry](/features/nvidia-retry) for details on `ResourceExhausted` handling.

## Disabling

```bash
# Globally
CONTEXTIO_RETRY_ENABLED=false

# Per-provider (programmatic)
createRetryPlugin({
  providerOverrides: {
    openai: { enabled: false }
  }
})
```

## Retry Headers

Responses include retry context:
```http
X-Retry-Attempt: 2
X-Retry-Delay-Ms: 1023
```

## Idempotency

**Only idempotent requests are retried**:
- GET requests (always)
- POST with `kind: "messages"` (assumed idempotent)
- POST with `kind: "completions"` (assumed idempotent)

Non-idempotent requests (e.g., `kind: "embeddings"` with side effects) are **not retried**.

## Monitoring

Web UI → **Metrics → Traffic**:
- Retry rate (%)
- Average retry delay
- Retry success rate

Programmatic:
```typescript
createRetryPlugin({
  onRetry: (attempt, error, delay, request) => {
    metrics.increment('retry.attempt', { attempt, provider: request.provider });
    metrics.histogram('retry.delay', delay);
  },
  onRetryExhausted: (error, request) => {
    metrics.increment('retry.exhausted', { provider: request.provider });
    alerting.notify('Retry exhausted', { error, request });
  }
});
```

## Debugging

```bash
LOG_LEVEL=debug
```

Log output:
```
[RETRY] Attempt 1/3 after 523ms: HTTP 429 (anthropic)
[RETRY] Streaming SSE error detected: rate_limit_error (openai)
[RETRY] Attempt 2/3 after 1045ms: HTTP 503 (nvidia)
[RETRY] Success on attempt 2
```