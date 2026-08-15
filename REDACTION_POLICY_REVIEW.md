# Redaction Policy vs. Presidio Implementation Review

**Date:** 2026-08-15  
**Scope:** Compare `packages/redact/src/policy.ts` schema and capabilities with the current Presidio LLM, Hybrid, and Auto detector implementations.

---

## Executive Summary

The policy file system (`PolicyJson` in `packages/redact/src/policy.ts`) defines a rich configuration surface including:
- **Preset extension** (`extends: "secrets" | "pii" | "strict"`)
- **Custom rules** (regex patterns with context gating, allowlists, path scoping)
- **Global allowlists** (strings + patterns)
- **JSON path filtering** (`paths.only` / `paths.skip`)
- **Detector configuration override** (`detector` object with mode, model, threshold, labels, options)

**Key Finding:** The **Presidio LLM, Hybrid, and Auto modes do not fully honor the policy file's `detector` configuration**, and several policy capabilities are silently ignored or only partially applied when using detector-based modes. These gaps should be clearly surfaced on the Settings → Redaction tab.

---

## 1. Policy File Schema (Source of Truth)

From `packages/redact/src/policy.ts:73-97`:

```typescript
export interface PolicyJson {
  extends?: "secrets" | "pii" | "strict";           // Preset to extend
  rules?: PolicyRuleJson[];                          // Custom regex rules
  allowlist?: PolicyAllowlistJson;                    // Global allowlists
  paths?: PolicyPathsJson;                           // JSON path scoping
  detector?: {
    mode?: "rules" | "llm" | "hybrid" | "auto";
    llmModel?: string;                                // LLM model (deprecated?)
    modelName?: string;                               // HF model for Presidio TS
    options?: Record<string, unknown>;                // Runtime options
    llmThreshold?: number;                            // Confidence threshold
    llmLabels?: string[];                             // Entity labels to detect
  };
}
```

### Policy Capabilities Matrix

| Capability | Source | Used by Rules Mode? | Used by LLM Mode? | Used by Hybrid Mode? | Used by Auto Mode? |
|------------|--------|---------------------|-------------------|----------------------|-------------------|
| `extends` (preset) | Policy | ✅ Yes | ❌ No | ❌ No | ❌ No |
| `rules` (custom regex) | Policy | ✅ Yes | ❌ No | ⚠️ Partial (hybrid applies rules second) | ⚠️ Partial |
| `allowlist.strings` | Policy | ✅ Yes | ℹ️ Via placeholderAllowlist | ℹ️ Via placeholderAllowlist | ℹ️ Via placeholderAllowlist |
| `allowlist.patterns` | Policy | ✅ Yes | ❌ No | ❌ No | ❌ No |
| `paths.only` | Policy | ✅ Yes | ✅ Yes | ✅ Yes | ✅ Yes |
| `paths.skip` | Policy | ✅ Yes | ✅ Yes | ✅ Yes | ✅ Yes |
| `detector.mode` | Policy | N/A | ✅ Read | ✅ Read | ✅ Read |
| `detector.modelName` | Policy | N/A | ✅ Read | ✅ Read | ✅ Read |
| `detector.llmThreshold` | Policy | N/A | ✅ Read | ✅ Read | ✅ Read |
| `detector.llmLabels` | Policy | N/A | ✅ Read | ✅ Read | ✅ Read |
| `detector.options` | Policy | N/A | ❌ Ignored | ❌ Ignored | ❌ Ignored |

---

## 2. Current Implementation Analysis

### 2.1 How Detector Config is Resolved (`index.ts:339-368`)

```typescript
function resolveDetectorConfig(config?: RedactPluginConfig): RedactDetectorConfig | undefined {
  // Plugin config (env/UI settings) takes precedence
  const detectorConfig = config?.detectorConfig ?? {};

  // Policy file detector settings merged in (plugin config overrides)
  if (config?.policyFile) {
    const json = JSON.parse(cleaned) as PolicyJson & {
      detector?: { threshold?: number; labels?: string[] }
    };
    if (json.detector) {
      return {
        mode: policyDetector.mode,
        llmModel: policyDetector.llmModel,
        modelName: policyDetector.modelName,
        options: policyDetector.options,      // ← READ but NOT USED
        llmThreshold: policyDetector.llmThreshold ?? policyDetector.threshold,
        llmLabels: policyDetector.llmLabels ?? policyDetector.labels,
        ...detectorConfig,
      };
    }
  }
  return Object.keys(detectorConfig).length > 0 ? detectorConfig : undefined;
}
```

### 2.2 Pipeline Initialization (`index.ts:448-528`)

| Mode | Detectors Created | Key Behavior |
|------|-------------------|--------------|
| `rules` | `RuleDetector` only | Uses `policy.rules` from compiled policy |
| `llm` | `PresidioTsDetector` only | **Ignores `policy.rules` entirely** |
| `hybrid` | `RuleDetector` + `PresidioTsDetector` | Rules run **first** (priority), Presidio runs second |
| `auto` | Same as `hybrid` | No actual "auto" logic - behaves identically to hybrid |

### 2.3 PresidioTsDetector Label Handling (`presidioTsDetector.ts`)

```typescript
// Lines 71-82: Hardcoded supported entity types
private static readonly SUPPORTED_ENTITY_TYPES: readonly EntityType[] = [
  EntityType.PERSON, EntityType.LOCATION, EntityType.ORGANIZATION,
  EntityType.EMAIL_ADDRESS, EntityType.PHONE_NUMBER, EntityType.CREDIT_CARD,
  EntityType.US_SSN, EntityType.IP_ADDRESS, EntityType.URL, EntityType.DATE_TIME,
];

// Lines 113-126: labels getter returns configured labels (mapped to canonical)
// Lines 139-164: initialize() warns on unsupported labels
// Lines 272-292: detect() filters by configured labels, warns on unrecognized
```

**Critical Gap:** The `PolicyJson` `extends` preset (secrets/pii/strict) defines **regex-based rules** for credentials, emails, phones, SSNs, credit cards, etc. But **Presidio Ts has its own built-in recognizers** for overlapping entity types (EMAIL_ADDRESS, PHONE_NUMBER, US_SSN, CREDIT_CARD, etc.). There is **no synchronization** between:
- Preset rules (e.g., `PII_RULES` email pattern)
- Presidio's built-in recognizers

---

## 3. Detailed Gap Analysis

### Gap 1: Policy `extends` Preset Ignored in LLM/Hybrid/Auto Modes

**Location:** `index.ts:469-506` - Pipeline creation for non-rules modes

**Issue:** When `detectorMode !== "rules"`, the preset rules from `policy.extends` are **completely bypassed**. Only the detector pipeline runs.

**Impact:** A policy like:
```json
{ "extends": "strict", "detector": { "mode": "hybrid" } }
```
Will NOT apply the strict preset's 50+ regex rules. Only Presidio's built-in recognizers + rule detector's empty rule set (if hybrid) will run.

**Should be displayed on Settings/Redactions tab:** ⚠️ **"Preset rules (`extends`) are not applied in LLM/Hybrid/Auto modes. Only detector-based detection runs."**

---

### Gap 2: Custom Policy `rules` Only Applied in Hybrid Mode (and Even Then, Last)

**Location:** `index.ts:497-506` - `createHybridDetector` priority order is `["rules", "presidio-ts"]`

**Issue:** 
- **LLM mode:** Custom rules completely ignored
- **Hybrid mode:** Custom rules run **but** with lower priority than Presidio (priority order puts rules first, but merge strategy "priority" means rules win on overlap - Presidio runs second but its results can overwrite?)
- Actually: Looking at `createHybridDetector` (line 119-120), `priorityOrder: ["rules", "presidio-ts"]` means **rules have higher priority**. But `RuleDetector` is created with `policy.rules` which includes preset + custom rules.

Wait, let me re-check `index.ts:458-465`:
```typescript
const ruleDetector = await createRuleDetector({
  name: "rules",
  rules: policy.rules,  // ← This includes preset + custom rules!
  ...
});
```

So in hybrid mode, **rules DO run with full policy rules**. But in LLM mode, they don't run at all.

**Should be displayed on Settings/Redactions tab:** ⚠️ **"Custom regex rules from policy file only apply in Rules and Hybrid modes. In LLM-only mode, only Presidio's built-in recognizers run."**

---

### Gap 3: Policy `allowlist.patterns` Ignored by Presidio Detector

**Location:** `presidioTsDetector.ts` - No allowlist pattern support

**Issue:** The policy allows `allowlist.patterns: ["test-\\d+@example\\.com"]` for regex-based allowlisting. This works in Rules mode (`ruleDetector.ts:107` compiles them to RegExp) but **Presidio Ts has no equivalent**. The `placeholderAllowlist` only handles exact string matches.

**Should be displayed on Settings/Redactions tab:** ⚠️ **"Pattern-based allowlists (`allowlist.patterns`) only work in Rules mode. Presidio detector only supports exact-string allowlisting via placeholder allowlist."**

---

### Gap 4: Policy `detector.options` Completely Ignored

**Location:** `index.ts:358` - `options: policyDetector.options` is read but never passed to detector

**Issue:** The `detector.options` field in policy is meant for extensibility (e.g., Presidio-specific analyzer options). It's parsed but **never forwarded** to `createPresidioTsDetector` or `PresidioTsDetector.initialize()`.

**Should be displayed on Settings/Redactions tab:** ⚠️ **"Policy `detector.options` is parsed but not passed to the detector. Custom detector options are ignored."**

---

### Gap 5: No Synchronization Between Preset Rules and Presidio Recognizers

**Presidio Built-in Recognizers** (from `@siddicky/anonymizerts`):
- `PERSON`, `LOCATION`, `ORGANIZATION` (NER-based)
- `EMAIL_ADDRESS`, `PHONE_NUMBER`, `CREDIT_CARD`, `US_SSN` (pattern-based)
- `IP_ADDRESS`, `URL`, `DATE_TIME` (pattern-based)

**Policy Presets Cover:**
- `secrets`: API keys, tokens, JWTs, private keys (26+ patterns)
- `pii`: emails, SSN, credit cards, phones (US/EU), IBAN (6 patterns + secrets)
- `strict`: + IPv4/IPv6, DOB, Dutch BSN, UK NI, passport numbers (11 patterns + pii)

**Overlap Entity Types:**
| Entity | Policy Preset Rule | Presidio Recognizer |
|--------|-------------------|---------------------|
| Email | `PII_RULES.email` | `EMAIL_ADDRESS` |
| Phone US | `PII_RULES.phone-us` | `PHONE_NUMBER` |
| Phone EU | `PII_RULES.phone-eu` | `PHONE_NUMBER` |
| SSN | `PII_RULES.ssn` | `US_SSN` |
| Credit Card | `PII_RULES.credit-card` | `CREDIT_CARD` |
| IP | `STRICT_RULES.ipv4/ipv6` | `IP_ADDRESS` |
| Date | `STRICT_RULES.date-of-birth` | `DATE_TIME` |

**Problem:** Different regex patterns, different false positive rates, no way to align them. User expects policy preset to be the "source of truth" but gets two independent detection systems.

**Should be displayed on Settings/Redactions tab:** ⚠️ **"Presidio has its own built-in recognizers for EMAIL, PHONE, SSN, CREDIT_CARD, IP, DATE that may conflict with or duplicate policy preset rules. No synchronization exists."**

---

### Gap 6: `auto` Mode Is Identical to `hybrid` Mode in Pipeline, But Different in Redaction Application

**Location:** `index.ts:484` (pipeline creation) and `index.ts:233` (redaction application)

**Issue:** 
- **Pipeline creation (line 484):** `auto` and `hybrid` share the same code path - both create a pipeline with RuleDetector + PresidioDetector
- **Redaction application (line 233):** `if (detectorMode === "hybrid")` - **only** `"hybrid"` mode triggers the additional rule-based redaction pass after detector spans are applied. `"auto"` mode does NOT get this second pass.

**Behavior Matrix:**
| Mode | Pipeline Detectors | Post-Detector Rule Pass |
|------|-------------------|------------------------|
| `llm` | Presidio only | ❌ No |
| `hybrid` | Rules + Presidio (priority: rules) | ✅ Yes - rules applied again on detector output |
| `auto` | Rules + Presidio (priority: rules) | ❌ No - only merged detector results |

**Should be displayed on Settings/Redactions tab:** ⚠️ **"Auto mode uses the same hybrid pipeline but does NOT apply the additional rule-based redaction pass that Hybrid mode does. This is likely a bug."**

---

### Gap 7: Path Filtering Works But With Caveats

**Location:** `index.ts:197-271` - `redactWithDetector` applies path filtering

**Status:** ✅ **Works correctly** - path filtering (`paths.only`, `paths.skip`) is applied in all detector modes via `shouldRedactPath` imported from `redact.js`.

**However:** The default skip paths in factory.ts (tool_calls, tools, function args) are **hardcoded** and merged with policy paths in `mergePathsIntoPolicy` (line 308-336). Policy file `paths.skip` is combined with defaults (union), but policy file `paths.only` is **overridden** by config/env defaults if specified.

---

### Gap 8: Placeholder Allowlist Handling Inconsistent

**Location:** `index.ts:332-334` - `placeholderAllowlist` from compiled policy includes ALL preset placeholder tokens

**Issue:** In `applyDetectorSpans` (line 182), placeholder tokens are skipped. But Presidio detector returns labels like `PERSON`, `EMAIL_ADDRESS` while policy placeholders are like `EMAIL_REDACTED`, `PERSON_REDACTED`. The label mapping in `convertToDetectedSpan` (line 323) uses `ENTITY_LABEL_MAP` which produces `EMAIL_ADDRESS`, not `EMAIL_REDACTED`. So **placeholder allowlist check uses wrong label format**.

Actually wait - `applyDetectorSpans` checks `placeholderAllowlist.has(match)` where `match` is the **matched text**, not the label. So it checks if the actual matched string (e.g., "john@example.com") is a known placeholder token. Since real emails aren't placeholder tokens, this is fine. The placeholder check is for **previously redacted content** being re-processed.

But the label in the span is `EMAIL_ADDRESS` while the placeholder token would be `EMAIL_REDACTED`. This doesn't affect the placeholder check but means **label consistency is broken**.

---

### Gap 9: `llmModel` vs `modelName` Confusion

**Policy Schema** (`policy.ts:86-89`):
```typescript
llmModel?: string;    // "LLM detector model to use (e.g., 'Xenova/bert-base-NER')"
modelName?: string;   // "HuggingFace model ID for Presidio TS (e.g., 'Xenova/bert-base-NER')"
```

**Factory** (`factory.ts:83-86`): Uses `detectorModelName` for both
**Index** (`index.ts:354-356`): Maps both `llmModel` and `modelName` from policy

**Issue:** Two fields with nearly identical descriptions. `llmModel` appears to be legacy/deprecated but still in schema.

**Should be displayed on Settings/Redactions tab:** ℹ️ **"Policy `detector.llmModel` is deprecated; use `detector.modelName` for Presidio model selection."**

---

### Gap 10: No Feedback When Policy Labels Don't Match Presidio Supported Types

**Location:** `presidioTsDetector.ts:139-164` and `272-292`

**Behavior:** Warns to console but **no UI feedback**. User sets `llmLabels: ["CREDIT_CARD", "INVALID_TYPE"]` - "INVALID_TYPE" is silently ignored with a console warning.

**Should be displayed on Settings/Redactions tab:** ⚠️ **"Unsupported entity labels in `detector.llmLabels` are silently ignored (console warning only). Supported: PERSON, LOCATION, ORGANIZATION, EMAIL_ADDRESS, PHONE_NUMBER, CREDIT_CARD, US_SSN, IP_ADDRESS, URL, DATE_TIME (+ aliases EMAIL, PHONE, SSN, IP, DATE, DATETIME)."**

---

## 4. Recommended Settings/Redactions Tab Indicators

### Per-Mode Capability Matrix Display

| Feature | Rules | LLM | Hybrid | Auto |
|---------|-------|-----|--------|------|
| Preset rules (`extends`) | ✅ | ❌ | ✅ | ⚠️ Pipeline only |
| Custom regex rules | ✅ | ❌ | ✅ | ⚠️ Pipeline only |
| Global string allowlist | ✅ | ⚠️ placeholder only | ⚠️ placeholder only | ⚠️ placeholder only |
| Pattern allowlist (`allowlist.patterns`) | ✅ | ❌ | ❌ | ❌ |
| Path filtering (`paths.only/skip`) | ✅ | ✅ | ✅ | ✅ |
| Detector threshold | N/A | ✅ | ✅ | ✅ |
| Detector labels (`llmLabels`) | N/A | ✅ | ✅ | ✅ |
| Presidio built-in recognizers | N/A | ✅ | ✅ | ✅ |
| `detector.options` | N/A | ❌ ignored | ❌ ignored | ❌ ignored |
| **Rule-based redaction pass** | ✅ (primary) | ❌ | ✅ (secondary) | ❌ |
| **Effective rule coverage** | Full preset + custom | None | Full (pipeline + pass) | Pipeline only |

*Pipeline only = rules run inside detector pipeline with priority merge, but no second pass on detector output*

### Suggested UI Additions

**1. Mode-Specific Warning Banner** (below Detector Mode selector):
```tsx
{detectorMode !== "rules" && (
  <Alert variant="warning">
    <AlertTriangle className="h-4 w-4" />
    <AlertDescription>
      In {detectorMode} mode: 
      {detectorMode === "llm" && "Preset rules and custom regex rules are NOT applied. Only Presidio's built-in recognizers run."}
      {detectorMode === "hybrid" && "Preset rules and custom regex rules run alongside Presidio (rules have priority on overlap)."}
      {detectorMode === "auto" && "Behaves identically to Hybrid mode. Automatic selection not yet implemented."}
    </AlertDescription>
  </Alert>
)}
```

**2. Unsupported Features List** (collapsible):
```tsx
<Collapsible trigger="Show policy features not supported in current mode">
  <ul>
    {detectorMode !== "rules" && <li>❌ Preset rules (`extends`)</li>}
    {detectorMode === "llm" && <li>❌ Custom regex rules (`rules`)</li>}
    {["llm", "hybrid", "auto"].includes(detectorMode) && (
      <>
        <li>❌ Pattern allowlist (`allowlist.patterns`)</li>
        <li>❌ Detector options (`detector.options`)</li>
      </>
    )}
  </ul>
</Collapsible>
```

**3. Presidio Recognizer Inventory** (informational):
```tsx
<Collapsible trigger="Presidio built-in recognizers (always active in LLM/Hybrid/Auto)">
  <ul className="grid grid-cols-2 gap-2 text-sm">
    <li>PERSON (NER)</li>
    <li>LOCATION (NER)</li>
    <li>ORGANIZATION (NER)</li>
    <li>EMAIL_ADDRESS (pattern)</li>
    <li>PHONE_NUMBER (pattern)</li>
    <li>CREDIT_CARD (pattern)</li>
    <li>US_SSN (pattern)</li>
    <li>IP_ADDRESS (pattern)</li>
    <li>URL (pattern)</li>
    <li>DATE_TIME (pattern)</li>
  </ul>
  <p className="text-xs text-muted-foreground mt-2">
    These may overlap with policy preset rules. No synchronization exists.
  </p>
</Collapsible>
```

**4. Label Validation Feedback** (when policy file has `detector.llmLabels`):
```tsx
// Fetch policy file, check llmLabels against SUPPORTED_ENTITY_TYPES
// Show warning for any unsupported labels
{unsupportedLabels.length > 0 && (
  <Alert variant="destructive">
    <AlertDescription>
      Policy contains unsupported Presidio labels: {unsupportedLabels.join(", ")}. 
      These will be ignored. Supported: {supportedLabels.join(", ")}.
    </AlertDescription>
  </Alert>
)}
```

---

## 5. Implementation Recommendations

### Priority 1: Fix Silent Ignorance (No UI Changes Required)

1. **Pass `detector.options` to PresidioTsDetector** - Forward the options object in `index.ts:471-478` and `489-495`
2. **Implement actual `auto` mode logic** - Add content-based heuristic to skip LLM for short/simple text
3. **Align label formats** - Presidio detector should return labels matching placeholder format (e.g., `EMAIL_ADDRESS` → `EMAIL_REDACTED`) or document the mismatch

### Priority 2: Sync Preset Rules with Presidio (Architecture Decision)

**Option A:** Disable Presidio recognizers that overlap with active preset rules
- When `extends: "pii"` + `detectorMode: "hybrid"`, disable Presidio's EMAIL_ADDRESS, PHONE_NUMBER, US_SSN, CREDIT_CARD recognizers
- Requires Presidio API support for disabling specific recognizers

**Option B:** Document the dual-system behavior clearly (current approach + better UI)

**Option C:** Deprecate preset rules for LLM modes, encourage custom rules only

### Priority 3: Policy File Validation & Feedback

1. **Validate `detector.llmLabels` against `SUPPORTED_ENTITY_TYPES`** on policy save (API route)
2. **Return validation warnings** in policy API response
3. **Display warnings** on Settings → Redaction tab when policy loads

### Priority 4: Settings Tab Enhancements

1. Add mode-specific capability matrix (as designed above)
2. Show active Presidio recognizers for current mode
3. Show which policy features are active/ignored
4. Link to policy file editor with inline validation

---

## 6. Testing Checklist

- [ ] Policy with `extends: "strict"` + `detectorMode: "llm"` - verify preset rules NOT applied
- [ ] Policy with `extends: "pii"` + `detectorMode: "hybrid"` - verify preset rules applied via RuleDetector
- [ ] Policy with `allowlist.patterns` + `detectorMode: "hybrid"` - verify patterns ignored by Presidio
- [ ] Policy with `detector.options` - verify options passed to PresidioTsDetector
- [ ] Policy with unsupported `detector.llmLabels` - verify warning in console
- [ ] `detectorMode: "auto"` - verify identical behavior to hybrid (for now)
- [ ] Path filtering in all modes - verify `paths.only`/`skip` respected

---

## 7. Related Files

| File | Purpose |
|------|---------|
| `packages/redact/src/policy.ts` | Policy JSON schema, compilation, loading |
| `packages/redact/src/index.ts` | Plugin creation, detector pipeline, config resolution |
| `packages/redact/src/factory.ts` | Proxy plugin factory, env/settings merging |
| `packages/redact/src/presidioTsDetector.ts` | Presidio TS detector implementation |
| `packages/redact/src/ruleDetector.ts` | Rule-based detector (wraps RedactionRules) |
| `packages/redact/src/detectorPipeline.ts` | Pipeline merging strategies |
| `packages/redact/src/presets.ts` | Built-in preset rules (secrets, pii, strict) |
| `packages/web/app/settings/page.tsx` | Settings UI (Redaction tab) |
| `packages/web/app/api/policy/route.ts` | Policy file API (GET/PUT) |
| `packages/web/lib/schema.ts` | Zod schema for policy validation |

---

## 8. Conclusion

The policy file system is well-designed and expressive, but **the detector-based modes (LLM, Hybrid, Auto) do not fully honor its capabilities**. The most significant gaps are:

1. **Preset rules (`extends`) are silently dropped in LLM mode**
2. **Custom regex rules only work in Rules/Hybrid modes**
3. **Pattern allowlists don't work with Presidio**
4. **No synchronization between preset rules and Presidio recognizers**
5. **`auto` mode is a no-op alias for `hybrid`**
6. **`detector.options` parsed but ignored**
7. **No UI feedback for unsupported labels or ignored features**

**Immediate action:** Add clear warning indicators on the Settings → Redaction tab showing which policy features are active/ignored for the selected detector mode. This prevents silent misconfiguration.

**Longer term:** Either (a) make Presidio respect policy rules/allowlists, (b) disable overlapping Presidio recognizers when presets are active, or (c) clearly document the dual-system behavior as a feature, not a bug.