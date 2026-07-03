---
title: Proposed Session Statistics Metrics
bead: contextio-vbr3
date: 2026-07-03
created_by: beads-modify agent
status: proposed
---

# Proposed Additional Session Statistics Metrics

## Context

Current metrics shown on the session detail screen (`packages/web/app/sessions/[id]/page.tsx`):

| Metric | Source field | Derived? |
|---|---|---|
| Total Inbound Bytes | `metrics.totalInboundBytes` | No |
| Total Outbound Bytes | `metrics.totalOutboundBytes` | No |
| Inbound Throughput (bytes/sec) | `metrics.inboundThroughput` | Yes (total bytes / duration) |
| Outbound Throughput (bytes/sec) | `metrics.outboundThroughput` | Yes |
| Total Context Values | `metrics.totalContextValues` | No |
| Total Redactions | `metrics.redactionStats.totalRedactions` | No |

Additional raw data available from both API routes (`/api/sessions` and `/api/sessions/[id]`):
- `totalTimeMs` — total elapsed time across all captures
- `captureCount` / `session.captureCount` — number of captures
- `firstTimestamp`, `lastTimestamp` — time range of the session
- `tokenUsage` — `{ input, output, total }` tokens
- `responseStatus` — per-capture HTTP status codes
- `responseIsStreaming` — per-capture streaming flag

---

## Proposed Metrics (Prioritized)

### P1 — Session Duration (Quick Win)
- **Formula**: `totalTimeMs` (already computed)
- **Display**: `${(totalTimeMs / 1000).toFixed(2)} sec`
- **Rationale**: Fundamental operational metric; already aggregated but not surfaced on the detail screen.
- **Risk**: None. Requires only adding `totalTimeMs: number` to `SessionMetrics` interface and one JSX line.

### P2 — Average Latency Per Turn (Medium Effort)
- **Formula**: `totalTimeMs / captureCount`
- **Display**: `${avgLatency.toFixed(0)} ms`
- **Rationale**: Indicates responsiveness of the API; useful for diagnosing slow endpoints.
- **Risk**: Low. Guard against `captureCount === 0`.

### P3 — Error Rate (Low Effort)
- **Formula**: `(non-2xx capture count / captureCount) * 100`
- **Display**: `{errorRate.toFixed(1)}%`
- **Rationale**: Surfaces quality issues at a glance without inspecting individual captures.
- **Risk**: Low. Must handle HTTP 0xx/3xx; define scope as only 4xx+5xx are errors.

### P4 — Tokens/sec (Existing Bead — contextio-b538)
- **Formula**: `totalTokens / (totalTimeMs / 1000)` where `totalTokens = tokenUsage.input + tokenUsage.output`
- **Display**: `${tokensPerSec.toFixed(1)} tok/sec`
- **Rationale**: Key LLM performance indicator. Already has a dedicated bead.
- **Risk**: Low if totalTimeMs > 0; zero-division guard needed.

### P5 — Context Values Per Turn (Low Effort)
- **Formula**: `totalContextValues / captureCount`
- **Display**: `${avgContext.toFixed(1)} ctx/turn`
- **Rationale**: Gives relative density of context per request.
- **Risk**: Low.

### P6 — Cost Estimate (Medium Effort — Optional)
- **Formula**: `(tokenUsage.input * inputPricePer1K) + (tokenUsage.output * outputPricePer1K)`
- **Display**: `$X.XX (esti.)`
- **Rationale**: Directly translates usage to dollars for stakeholders.
- **Risk**: High. Requires model name lookup against pricing tables; model not currently stored in capture data. Defer until model metadata is captured.

### P7 — Redactions Per Turn (Low Effort)
- **Formula**: `redactionStats.totalRedactions / captureCount`
- **Display**: `${redactPerTurn.toFixed(1)} red/turn`
- **Rationale**: Correlates redaction density with request volume.
- **Risk**: None.

### P8 — Request Size Distribution Stats (Higher Effort)
- **Formula**: Mean/median request bytes across captures.
- **Rationale**: Useful for capacity planning but requires iterating captures in the `[id]` route.
- **Risk**: Medium; would need per-capture iteration or pre-aggregation.

### P9 — Latency Percentiles (Higher Effort)
- **Formula**: Per-capture timing percentiles (p50, p95, p99).
- **Rationale**: More robust than average for outlier-heavy distributions.
- **Risk**: Medium; needs full capture list in memory.

---

## Recommended Implementation Order

| Step | Metric | Corresponding Bead | Complexity |
|---|---|---|---|
| 1 | Session Duration | None (quick win) | Low |
| 2 | Avg Latency Per Turn | contextio-b538 (add to same PR) | Low |
| 3 | Error Rate | contextio-b538 (add to same PR) | Low |
| 4 | Redactions Per Turn | contextio-b538 (add to same PR) | Low |
| 5 | Context Values Per Turn | contextio-b538 (add to same PR) | Low |
| 6 | Tokens/sec | contextio-b538 | Low–Medium |
| 7 | Cost Estimate | New bead | Medium–High |

Steps 1–5 can be implemented together without scope creep: they are all sourced from already-aggregated fields (`totalTimeMs`, `captureCount`, `responseStatus`, `redactionStats.totalRedactions`, `totalContextValues`) and require only:
1. Adding optional fields to the `SessionMetrics` interface.
2. Computing them in `computeSessionMetrics` in `route.ts`.
3. Rendering them in the JSX metrics grid.

Tokens/sec (step 6) requires `tokenUsage`, which is not currently part of `SessionMetrics`; it exists only in the sessions list summary. It is scoped to `contextio-b538`.

Cost estimate (step 7) is independently scoped as a new bead due to the model-metadata dependency.

---

## Implementation Notes

- All new metric fields should be **optional** on `SessionMetrics` to preserve backward compatibility with any consumers of the API.
- Formatting helpers (e.g., unit suffixes like "tok/sec", "ms", "%") should live in a shared location if multiple metrics use them; otherwise inline in JSX.
- Zero-division guards are required for any formula dividing by `captureCount` or `totalTimeMs`.
