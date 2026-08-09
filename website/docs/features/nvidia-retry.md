---
layout: doc
---

# NVIDIA Worker Retry

Special retry handling for NVIDIA NIM `ResourceExhausted` errors.

## The Problem

NVIDIA NIM returns a specific error when worker resources are exhausted:

```json
{
  "error": {
    "type": "ResourceExhausted",
    "message": "Worker resources exhausted, please retry",
    "code": 503
  }
}
```

Unlike standard rate limits, this doesn't use HTTP 429 — it returns **200 OK** with an error in the response body.

## The Solution

When `workerRetry.enabled=true` for NVIDIA:

1. **Detects** `ResourceExhausted` in response body (streaming or non-streaming)
2. **Appends** a `"continue"` user message to the `messages` array
3. **Retries** the request (counts against `maxAttempts`)
4. **Preserves** context — model continues from where it stopped

## Example

**Original Request:**
```json
{
  "messages": [
    {"role": "user", "content": "Write a long story..."}
  ]
}
```

**NVIDIA Response (200 OK with error):**
```json
{
  "error": {"type": "ResourceExhausted", "message": "Worker exhausted"}
}
```

**Retry Request (auto-generated):**
```json
{
  "messages": [
    {"role": "user", "content": "Write a long story..."},
    {"role": "assistant", "content": "..."},
    {"role": "user", "content": "continue"}
  ]
}
```

## Configuration

### Environment Variable (JSON)
```bash
CONTEXTIO_RETRY_PROVIDER_OVERRIDES='{
  "nvidia": {
    "workerRetry": {
      "enabled": true,
      "maxWorkerRetries": 2,
      "continueMessage": "continue"
    }
  }
}'
```

### Programmatic
```typescript
createRetryPlugin({
  providerOverrides: {
    nvidia: {
      workerRetry: {
        enabled: true,
        maxWorkerRetries: 3,      // Additional worker retries
        continueMessage: "continue" // Custom continue prompt
      }
    }
  }
});
```

## Parameters

| Parameter | Default | Description |
|-----------|---------|-------------|
| `enabled` | `false` | Enable worker retry |
| `maxWorkerRetries` | `2` | Max worker-specific retries |
| `continueMessage` | `"continue"` | Message to append |

## Behavior Details

| Aspect | Behavior |
|--------|----------|
| **Counts toward** | `CONTEXTIO_RETRY_MAX_ATTEMPTS` total |
| **Delay** | Uses standard exponential backoff |
| **Streaming** | Works with both streaming and non-streaming |
| **Message format** | Appends `{"role": "user", "content": "continue"}` |
| **Model compatibility** | Works with NIM models supporting continue |

## Limitations

- Only for NVIDIA provider (`provider === 'nvidia'`)
- Requires model to support "continue" pattern
- Adds to message history (increases token count)
- Does not work with `REDACT_REVERSIBLE=true` (placeholder mismatch)

## Monitoring

Web UI → **Metrics → Rate Limiter**:
- **NVIDIA worker retries** — Count of worker retries triggered
- **Worker retry success rate** — % that succeed after retry

Programmatic:
```typescript
onWorkerRetry: (attempt, request) => {
  metrics.increment('nvidia.worker_retry', { attempt });
  logger.info('NVIDIA worker retry', { attempt, sessionId: request.sessionId });
}
```

## Why Not Standard Retry?

| Standard Retry | Worker Retry |
|----------------|--------------|
| HTTP 429/5xx | 200 OK with error body |
| Respects `Retry-After` | No header, immediate retry |
| Same request | Modified request (adds "continue") |
| Generic | NVIDIA-specific |

## Disable

```bash
CONTEXTIO_RETRY_PROVIDER_OVERRIDES='{"nvidia": {"workerRetry": {"enabled": false}}}'
```