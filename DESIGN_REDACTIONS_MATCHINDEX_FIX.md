# Design: Redactions List↔Detail matchIndex Contract Fix

## Problem Statement

The redactions list route (`packages/web/app/api/redactions/route.ts`) and detail route (`packages/web/app/api/redactions/detail/[captureId]/[matchIndex]/route.ts`) must share a **stable, consistent ordering** for `matchIndex` so that clicking row N in the list opens detail for the same match N.

Currently both routes read `meta.matches` (written by the redact plugin at capture time). However, the watcher's fast-path may not always preserve `meta.matches`, and a future fallback to `extractRedactionMatches()` (regex scan of redacted body) would produce a **different ordering**:

| Source | Ordering |
|--------|----------|
| `meta.matches` (redact plugin) | Depth-first JSON tree walk: requestBody (all paths), then responseBody (all paths), in rule-application order |
| `extractRedactionMatches()` | Serialized JSON string scan: all `[RULE_REDACTED]` placeholders first (across request+response), then bare SSN matches |

This mismatch breaks the cross-route `matchIndex` contract.

---

## Design Options

### Option A: Detail route also uses `extractRedactionMatches()`
- **Pros**: Single source of truth; matches always derivable from capture file
- **Cons**: Loses redact plugin's original `ruleId` (preset names like `credential_generic` become lowercase placeholder tags like `secret`); loses JSON path precision for responseBody (string scan); `original` value becomes the whole leaf string not the matched substring

### Option B: List route stays on `meta.matches`; add fallback rows only when `meta.matches` exists but is empty
- **Pros**: Preserves redact plugin's authoritative data (ruleId, path, original value); no contract change
- **Cons**: When `meta.matches` is missing/empty, list shows 0 rows even if `totalRedactions > 0`

### Option C: Stable identifier key (not positional index)
- **Pros**: Decouples ordering from both sources; enables deep-linking to specific redactions
- **Cons**: Requires schema change (add `matchId` to `MatchEntry`); migration for existing captures; detail route must look up by `matchId` not `matchIndex`

---

## Recommended Design: **Option B + Targeted Fallback (Hybrid)**

**Core principle**: The redact plugin's `meta.matches` is the **authoritative source**. Both routes must use it. The list route should NOT fall back to `extractRedactionMatches()` for row generation.

### Changes Required

#### 1. List Route (`packages/web/app/api/redactions/route.ts`)
- **Keep** reading `meta.matches` for detail rows (current behavior).
- **Do NOT** add a fallback to `extractRedactionMatches()` when `meta.matches` is empty.
- If `meta.matches` is empty but `totalRedactions > 0`, surface this as a data-quality issue (meta file missing matches) rather than synthesizing rows that would break the detail link.
- **Acceptance**: List row N always corresponds to `meta.matches[N]`.

#### 2. Detail Route (`packages/web/app/api/redactions/detail/[captureId]/[matchIndex]/route.ts`)
- **Keep** reading `meta.matches[matchIndex]` (current behavior).
- **Add** a fallback: if `meta.matches` is empty/missing but `totalRedactions > 0`, return a structured error response indicating "metadata incomplete; detail unavailable" rather than synthesizing from regex scan.
- **Acceptance**: Detail for index N always corresponds to `meta.matches[N]`.

#### 3. Watcher / Redact Plugin (Data Quality)
- Ensure `meta.matches` is **always written** by the redact plugin (cap removed in commit 4068a5c).
- Watcher fast-path must **preserve** existing `meta.matches` (already implemented in `mergeExistingMetadata`).
- If watcher creates a new meta file (no redact plugin meta exists), it should **not** synthesize `matches` from regex scan (current behavior: omits `matches` field). This is correct — it avoids divergence risk and must not be added.

#### 4. Test Coverage (New)
Add an integration test that:
1. Creates a capture with mixed placeholder + SSN redactions across request/response bodies where `meta.matches` order ≠ regex-scan order.
2. Calls list API → gets rows with `matchIndex` 0..N.
3. For each row, calls detail API with that `matchIndex`.
4. Asserts detail response `redactionType`, `path`, `preRedactionValue` match the list row.

---

## Why Not Option A or C?

**Option A rejected**: `extractRedactionMatches()` loses critical fidelity:
- `ruleId`: becomes lowercase placeholder tag (`secret` vs `credential_generic`)
- `path`: responseBody becomes flat string path, not JSON path
- `original`: entire leaf string, not the matched substring
This degrades the detail view (diff dialog, context) unacceptably.

**Option C deferred**: Adding `matchId` (UUID or content-hash) is a valuable enhancement for deep-linking and deduplication, but it's a **schema migration** requiring:
- `MatchEntry.matchId` field
- Redact plugin writes it at capture time
- Detail route accepts `?matchId=` alongside `[matchIndex]`
- List route includes `matchId` in rows
- Back-compat for existing captures
This should be a separate epic, not a bug fix.

---

## Migration Path

No migration needed for existing captures. The fix is **behavioral alignment**:
- List route: authoritative `meta.matches` only
- Detail route: authoritative `meta.matches` only
- Watcher: never synthesize `matches` array

If a capture lacks `meta.matches` (legacy, or watcher created meta before redact plugin ran), both APIs correctly return 0 detail rows. The summary still shows `totalRedactions` from `byRule`. This is the correct "data not available" state.

---

## Acceptance Criteria

1. **Round-trip test passes**: List row N → Detail matchIndex N returns identical `redactionType`, `path`, `preRedactionValue`.
2. **No fallback synthesis**: List route produces 0 rows when `meta.matches` is empty (even if `totalRedactions > 0`).
3. **Detail route error**: Returns 404 with `{ error: "Redaction metadata incomplete; detail unavailable", totalRedactions: X }` when `meta.matches` empty but `totalRedactions > 0`.
4. **Watcher invariant**: `mergeExistingMetadata` never adds `matches` from regex scan; only preserves existing.
5. **Redact plugin invariant**: `recordMatch` has no cap; all matches written to `meta.matches`.

---

## Files to Modify (Design Only — No Code Changes Here)

| File | Change |
|------|--------|
| `packages/web/app/api/redactions/route.ts` | Ensure `getRedactionDetailsFromMeta` only uses `meta.matches`; remove any fallback to `extractRedactionMatches` if present |
| `packages/web/app/api/redactions/detail/[captureId]/[matchIndex]/route.ts` | Add explicit check: if `matches.length === 0 && meta.totalRedactions > 0` → return structured 404 |
| `packages/proxy/src/redaction-meta-watcher.ts` | Verify `mergeExistingMetadata` never injects `matches` from `extractRedactionMatches` |
| `packages/redact/src/redact.ts` | Verify `recordMatch` has no length cap on `stats.matches` |
| `packages/web/lib/sessions/redaction-utils.ts` | (Test helper only) `extractRedactionMatches` remains for other callers (e.g., session detail view) but NOT used by list/detail APIs |

---

## Open Questions

1. **Session Detail Page**: The session detail view (`packages/web/app/sessions/[id]/page.tsx` or similar) may call `extractRedactionMatches` for inline display. Confirm it doesn't need `matchIndex` alignment with list/detail APIs.

2. **Back-compat for captures without `meta.matches`**: Should the detail route attempt `extractRedactionMatches` as a last resort with a warning header? Current design says NO — return clear error so UI can show "detail unavailable".

3. **Future `matchId`**: Track as separate epic `contextio-5ecd.N` for stable deep-linking.