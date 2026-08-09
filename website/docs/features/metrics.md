---
layout: doc
---

# Metrics & Monitoring

The Web UI provides two metric tabs for observability.

## Rate Limiter Tab

Real-time view of rate limiting state at **Metrics → Rate Limiter**:

### Active Buckets
| Column | Description |
|--------|-------------|
| Session ID | 8-char session identifier |
| Provider | Upstream provider |
| Tokens Remaining | Current bucket tokens |
| Max Tokens | Configured `maxRequests` |
| Queue Depth | Waiting requests |
| Last Activity | Timestamp of last request |

### Aggregated Metrics
- **Total active buckets** — Current `(session, provider)` pairs
- **Upstream 429s** — 429 responses from providers
- **Local 429s** — 429 responses from rate limiter
- **NVIDIA worker retries** — Special retry count
- **Requests queued** — Currently queued requests
- **Requests processed** — Total requests through limiter

### Alerts
- 🟡 Warning: Bucket at < 10% tokens
- 🔴 Critical: Bucket empty, requests queued
- 🔴 Critical: Upstream 429 rate increasing

## Traffic Tab

Request/response analytics at **Metrics → Traffic**:

### Request Volume
- **Requests/min** — Rolling 1-minute rate
- **Requests/hour** — Rolling 1-hour rate
- **By provider** — Stacked area chart
- **By status** — 2xx, 4xx, 5xx breakdown

### Latency
- **p50** — Median latency
- **p95** — 95th percentile
- **p99** — 99th percentile
- **By provider** — Separate lines

### Throughput
- **Tokens/sec** — Input + output tokens
- **Bytes/sec** — Request + response bytes
- **By provider** — Stacked

### Error Rates
- **Error %** — 5xx / total requests
- **Rate limit %** — 429 / total requests
- **Timeout %** — Request timeouts

## Time Range Selector
- 5m, 15m, 1h, 6h, 24h, 7d, 30d
- Custom range picker
- Auto-refresh: 10s, 30s, 1m, 5m

## Data Retention

Metrics stored in memory with circular buffers:
- **High resolution (10s)**: 1 hour
- **Medium (1m)**: 24 hours
- **Low (1h)**: 30 days

## API Access

```bash
# Rate limiter metrics
curl http://localhost:4040/admin/metrics/rate-limiter

# Traffic metrics
curl http://localhost:4040/admin/metrics/traffic

# All metrics
curl http://localhost:4040/admin/metrics
```

### Response Format

```json
{
  "rateLimiter": {
    "activeBuckets": 42,
    "totalRequests": 15234,
    "upstream429s": 12,
    "local429s": 3,
    "nvidiaRetries": 5,
    "queuedRequests": 2,
    "buckets": [
      { "sessionId": "a1b2c3d4", "provider": "anthropic", "tokens": 45, "max": 60, "queue": 0 }
    ]
  },
  "traffic": {
    "requestsPerMinute": 45.2,
    "latencyP50": 234,
    "latencyP95": 1200,
    "latencyP99": 3500,
    "tokensPerSecond": 12000,
    "errorRate": 0.02,
    "byProvider": {
      "anthropic": { "rpm": 20, "p50": 300, "errors": 0.01 },
      "openai": { "rpm": 25, "p50": 180, "errors": 0.03 }
    }
  }
}
```

## Prometheus Export (Programmatic)

```typescript
import { createProxy, createMetricsPlugin } from '@contextio/proxy';

const metrics = createMetricsPlugin({
  buckets: 100,
  percentiles: [0.5, 0.95, 0.99],
  exportInterval: 10000,
});

const proxy = createProxy({
  port: 4040,
  plugins: [metrics],
});

// Prometheus format
app.get('/metrics', (req, res) => {
  res.set('Content-Type', 'text/plain');
  res.send(metrics.toPrometheus());
});
```

## Grafana Dashboards

Import community dashboards:
- **ContextIO-Next Overview** — Request volume, latency, errors
- **Rate Limiter Deep Dive** — Bucket states, 429s, queues
- **Provider Comparison** — Per-provider latency, throughput

## Alerting Rules (Example)

```yaml
groups:
- name: contextio
  rules:
  - alert: HighErrorRate
    expr: rate(contextio_errors_total[5m]) > 0.05
    for: 2m
    labels:
      severity: warning
    annotations:
      summary: "High error rate on ContextIO-Next"
      
  - alert: RateLimiterExhausted
    expr: contextio_rate_limiter_empty_buckets > 5
    for: 1m
    labels:
      severity: critical
    annotations:
      summary: "Multiple rate limiter buckets exhausted"
      
  - alert: HighLatency
    expr: histogram_quantile(0.99, contextio_latency_bucket) > 5000
    for: 5m
    labels:
      severity: warning
    annotations:
      summary: "P99 latency above 5s"
```