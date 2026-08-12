# PII Detection Benchmark Report

**Date:** 2026-08-12
**Test Samples:** 58
**Detectors Compared:** rules-only, presidio-ts, hybrid

## Overall Metrics

| Detector | Precision | Recall | F1 | TP | FP | FN |
|----------|-----------|--------|-----|----|----|----|
| rules-only | 0.333 | 0.033 | 0.060 | 2 | 4 | 59 |
| presidio-ts | 0.200 | 0.082 | 0.116 | 5 | 20 | 56 |
| hybrid | 0.241 | 0.115 | 0.156 | 7 | 22 | 54 |

## Latency Statistics (ms)

| Detector | Mean | P50 | P95 | P99 | Min | Max |
|----------|------|-----|-----|-----|-----|-----|
| rules-only | 0.1 | 0 | 1 | 2 | 0 | 2 |
| presidio-ts | 27.7 | 27 | 37 | 40 | 17 | 40 |
| hybrid | 32.5 | 31 | 45 | 97 | 17 | 97 |

## Per-Entity Metrics

### ADDRESS

| Detector | Precision | Recall | F1 | TP | FP | FN |
|----------|-----------|--------|-----|----|----|----|
| rules-only | 0.000 | 0.000 | 0.000 | 0 | 0 | 2 |
| presidio-ts | 0.000 | 0.000 | 0.000 | 0 | 0 | 2 |
| hybrid | 0.000 | 0.000 | 0.000 | 0 | 0 | 2 |

### AWS_SECRET_KEY

| Detector | Precision | Recall | F1 | TP | FP | FN |
|----------|-----------|--------|-----|----|----|----|
| rules-only | 0.000 | 0.000 | 0.000 | 0 | 0 | 1 |
| presidio-ts | 0.000 | 0.000 | 0.000 | 0 | 0 | 1 |
| hybrid | 0.000 | 0.000 | 0.000 | 0 | 0 | 1 |

### BSN

| Detector | Precision | Recall | F1 | TP | FP | FN |
|----------|-----------|--------|-----|----|----|----|
| rules-only | 0.000 | 0.000 | 0.000 | 0 | 0 | 1 |
| presidio-ts | 0.000 | 0.000 | 0.000 | 0 | 0 | 1 |
| hybrid | 0.000 | 0.000 | 0.000 | 0 | 0 | 1 |

### BSN-DUTCH

| Detector | Precision | Recall | F1 | TP | FP | FN |
|----------|-----------|--------|-----|----|----|----|
| rules-only | 0.000 | 0.000 | 0.000 | 0 | 1 | 0 |
| presidio-ts | - | - | - | 0 | 0 | 0 |
| hybrid | 0.000 | 0.000 | 0.000 | 0 | 1 | 0 |

### CREDENTIAL_AWS_KEY

| Detector | Precision | Recall | F1 | TP | FP | FN |
|----------|-----------|--------|-----|----|----|----|
| rules-only | 0.000 | 0.000 | 0.000 | 0 | 0 | 1 |
| presidio-ts | 0.000 | 0.000 | 0.000 | 0 | 0 | 1 |
| hybrid | 0.000 | 0.000 | 0.000 | 0 | 0 | 1 |

### CREDENTIAL_GCP_API_KEY

| Detector | Precision | Recall | F1 | TP | FP | FN |
|----------|-----------|--------|-----|----|----|----|
| rules-only | 0.000 | 0.000 | 0.000 | 0 | 0 | 1 |
| presidio-ts | 0.000 | 0.000 | 0.000 | 0 | 0 | 1 |
| hybrid | 0.000 | 0.000 | 0.000 | 0 | 0 | 1 |

### CREDENTIAL_GITHUB_TOKEN

| Detector | Precision | Recall | F1 | TP | FP | FN |
|----------|-----------|--------|-----|----|----|----|
| rules-only | 0.000 | 0.000 | 0.000 | 0 | 0 | 2 |
| presidio-ts | 0.000 | 0.000 | 0.000 | 0 | 0 | 2 |
| hybrid | 0.000 | 0.000 | 0.000 | 0 | 0 | 2 |

### CREDENTIAL_KILO_KEY

| Detector | Precision | Recall | F1 | TP | FP | FN |
|----------|-----------|--------|-----|----|----|----|
| rules-only | 0.000 | 0.000 | 0.000 | 0 | 0 | 1 |
| presidio-ts | 0.000 | 0.000 | 0.000 | 0 | 0 | 1 |
| hybrid | 0.000 | 0.000 | 0.000 | 0 | 0 | 1 |

### CREDENTIAL_NPM_TOKEN

| Detector | Precision | Recall | F1 | TP | FP | FN |
|----------|-----------|--------|-----|----|----|----|
| rules-only | 0.000 | 0.000 | 0.000 | 0 | 0 | 1 |
| presidio-ts | 0.000 | 0.000 | 0.000 | 0 | 0 | 1 |
| hybrid | 0.000 | 0.000 | 0.000 | 0 | 0 | 1 |

### CREDENTIAL_NVIDIA_KEY

| Detector | Precision | Recall | F1 | TP | FP | FN |
|----------|-----------|--------|-----|----|----|----|
| rules-only | 0.000 | 0.000 | 0.000 | 0 | 0 | 1 |
| presidio-ts | 0.000 | 0.000 | 0.000 | 0 | 0 | 1 |
| hybrid | 0.000 | 0.000 | 0.000 | 0 | 0 | 1 |

### CREDENTIAL_OPENAI_KEY

| Detector | Precision | Recall | F1 | TP | FP | FN |
|----------|-----------|--------|-----|----|----|----|
| rules-only | 0.000 | 0.000 | 0.000 | 0 | 0 | 2 |
| presidio-ts | 0.000 | 0.000 | 0.000 | 0 | 0 | 2 |
| hybrid | 0.000 | 0.000 | 0.000 | 0 | 0 | 2 |

### CREDENTIAL_OPENROUTER_KEY

| Detector | Precision | Recall | F1 | TP | FP | FN |
|----------|-----------|--------|-----|----|----|----|
| rules-only | 0.000 | 0.000 | 0.000 | 0 | 0 | 1 |
| presidio-ts | 0.000 | 0.000 | 0.000 | 0 | 0 | 1 |
| hybrid | 0.000 | 0.000 | 0.000 | 0 | 0 | 1 |

### CREDENTIAL_PYPI_TOKEN

| Detector | Precision | Recall | F1 | TP | FP | FN |
|----------|-----------|--------|-----|----|----|----|
| rules-only | 0.000 | 0.000 | 0.000 | 0 | 0 | 1 |
| presidio-ts | 0.000 | 0.000 | 0.000 | 0 | 0 | 1 |
| hybrid | 0.000 | 0.000 | 0.000 | 0 | 0 | 1 |

### CREDENTIAL_SENDGRID_TOKEN

| Detector | Precision | Recall | F1 | TP | FP | FN |
|----------|-----------|--------|-----|----|----|----|
| rules-only | 0.000 | 0.000 | 0.000 | 0 | 0 | 1 |
| presidio-ts | 0.000 | 0.000 | 0.000 | 0 | 0 | 1 |
| hybrid | 0.000 | 0.000 | 0.000 | 0 | 0 | 1 |

### CREDENTIAL_SLACK_TOKEN

| Detector | Precision | Recall | F1 | TP | FP | FN |
|----------|-----------|--------|-----|----|----|----|
| rules-only | 0.000 | 0.000 | 0.000 | 0 | 0 | 1 |
| presidio-ts | 0.000 | 0.000 | 0.000 | 0 | 0 | 1 |
| hybrid | 0.000 | 0.000 | 0.000 | 0 | 0 | 1 |

### CREDENTIAL_STRIPE_KEY

| Detector | Precision | Recall | F1 | TP | FP | FN |
|----------|-----------|--------|-----|----|----|----|
| rules-only | 0.000 | 0.000 | 0.000 | 0 | 0 | 1 |
| presidio-ts | 0.000 | 0.000 | 0.000 | 0 | 0 | 1 |
| hybrid | 0.000 | 0.000 | 0.000 | 0 | 0 | 1 |

### CREDENTIAL_VAULT_TOKEN

| Detector | Precision | Recall | F1 | TP | FP | FN |
|----------|-----------|--------|-----|----|----|----|
| rules-only | 0.000 | 0.000 | 0.000 | 0 | 0 | 1 |
| presidio-ts | 0.000 | 0.000 | 0.000 | 0 | 0 | 1 |
| hybrid | 0.000 | 0.000 | 0.000 | 0 | 0 | 1 |

### CREDIT_CARD

| Detector | Precision | Recall | F1 | TP | FP | FN |
|----------|-----------|--------|-----|----|----|----|
| rules-only | 0.000 | 0.000 | 0.000 | 0 | 0 | 3 |
| presidio-ts | 0.000 | 0.000 | 0.000 | 0 | 0 | 3 |
| hybrid | 0.000 | 0.000 | 0.000 | 0 | 0 | 3 |

### DATE-OF-BIRTH

| Detector | Precision | Recall | F1 | TP | FP | FN |
|----------|-----------|--------|-----|----|----|----|
| rules-only | 0.000 | 0.000 | 0.000 | 0 | 1 | 0 |
| presidio-ts | - | - | - | 0 | 0 | 0 |
| hybrid | 0.000 | 0.000 | 0.000 | 0 | 1 | 0 |

### DATE_OF_BIRTH

| Detector | Precision | Recall | F1 | TP | FP | FN |
|----------|-----------|--------|-----|----|----|----|
| rules-only | 0.000 | 0.000 | 0.000 | 0 | 0 | 1 |
| presidio-ts | 0.000 | 0.000 | 0.000 | 0 | 0 | 1 |
| hybrid | 0.000 | 0.000 | 0.000 | 0 | 0 | 1 |

### EMAIL

| Detector | Precision | Recall | F1 | TP | FP | FN |
|----------|-----------|--------|-----|----|----|----|
| rules-only | 0.000 | 0.000 | 0.000 | 0 | 0 | 7 |
| presidio-ts | 0.000 | 0.000 | 0.000 | 0 | 0 | 7 |
| hybrid | 0.000 | 0.000 | 0.000 | 0 | 0 | 7 |

### IBAN

| Detector | Precision | Recall | F1 | TP | FP | FN |
|----------|-----------|--------|-----|----|----|----|
| rules-only | 0.000 | 0.000 | 0.000 | 0 | 0 | 1 |
| presidio-ts | 0.000 | 0.000 | 0.000 | 0 | 0 | 1 |
| hybrid | 0.000 | 0.000 | 0.000 | 0 | 0 | 1 |

### IPV4

| Detector | Precision | Recall | F1 | TP | FP | FN |
|----------|-----------|--------|-----|----|----|----|
| rules-only | 1.000 | 1.000 | 1.000 | 2 | 0 | 0 |
| presidio-ts | 0.000 | 0.000 | 0.000 | 0 | 0 | 2 |
| hybrid | 1.000 | 1.000 | 1.000 | 2 | 0 | 0 |

### IP_ADDRESS

| Detector | Precision | Recall | F1 | TP | FP | FN |
|----------|-----------|--------|-----|----|----|----|
| rules-only | - | - | - | 0 | 0 | 0 |
| presidio-ts | 0.000 | 0.000 | 0.000 | 0 | 2 | 0 |
| hybrid | - | - | - | 0 | 0 | 0 |

### JWT

| Detector | Precision | Recall | F1 | TP | FP | FN |
|----------|-----------|--------|-----|----|----|----|
| rules-only | 0.000 | 0.000 | 0.000 | 0 | 0 | 2 |
| presidio-ts | 0.000 | 0.000 | 0.000 | 0 | 0 | 2 |
| hybrid | 0.000 | 0.000 | 0.000 | 0 | 0 | 2 |

### LOCATION

| Detector | Precision | Recall | F1 | TP | FP | FN |
|----------|-----------|--------|-----|----|----|----|
| rules-only | 0.000 | 0.000 | 0.000 | 0 | 0 | 3 |
| presidio-ts | 0.167 | 0.333 | 0.222 | 1 | 5 | 2 |
| hybrid | 0.167 | 0.333 | 0.222 | 1 | 5 | 2 |

### NI-NUMBER-UK

| Detector | Precision | Recall | F1 | TP | FP | FN |
|----------|-----------|--------|-----|----|----|----|
| rules-only | 0.000 | 0.000 | 0.000 | 0 | 1 | 0 |
| presidio-ts | - | - | - | 0 | 0 | 0 |
| hybrid | 0.000 | 0.000 | 0.000 | 0 | 1 | 0 |

### NI_NUMBER

| Detector | Precision | Recall | F1 | TP | FP | FN |
|----------|-----------|--------|-----|----|----|----|
| rules-only | 0.000 | 0.000 | 0.000 | 0 | 0 | 1 |
| presidio-ts | 0.000 | 0.000 | 0.000 | 0 | 0 | 1 |
| hybrid | 0.000 | 0.000 | 0.000 | 0 | 0 | 1 |

### ORGANIZATION

| Detector | Precision | Recall | F1 | TP | FP | FN |
|----------|-----------|--------|-----|----|----|----|
| rules-only | 0.000 | 0.000 | 0.000 | 0 | 0 | 5 |
| presidio-ts | 0.111 | 0.200 | 0.143 | 1 | 8 | 4 |
| hybrid | 0.111 | 0.200 | 0.143 | 1 | 8 | 4 |

### PASSPORT

| Detector | Precision | Recall | F1 | TP | FP | FN |
|----------|-----------|--------|-----|----|----|----|
| rules-only | 0.000 | 0.000 | 0.000 | 0 | 0 | 1 |
| presidio-ts | 0.000 | 0.000 | 0.000 | 0 | 0 | 1 |
| hybrid | 0.000 | 0.000 | 0.000 | 0 | 0 | 1 |

### PASSPORT-NUMBER

| Detector | Precision | Recall | F1 | TP | FP | FN |
|----------|-----------|--------|-----|----|----|----|
| rules-only | 0.000 | 0.000 | 0.000 | 0 | 1 | 0 |
| presidio-ts | - | - | - | 0 | 0 | 0 |
| hybrid | 0.000 | 0.000 | 0.000 | 0 | 1 | 0 |

### PERSON

| Detector | Precision | Recall | F1 | TP | FP | FN |
|----------|-----------|--------|-----|----|----|----|
| rules-only | 0.000 | 0.000 | 0.000 | 0 | 0 | 6 |
| presidio-ts | 0.200 | 0.167 | 0.182 | 1 | 4 | 5 |
| hybrid | 0.200 | 0.167 | 0.182 | 1 | 4 | 5 |

### PHONE

| Detector | Precision | Recall | F1 | TP | FP | FN |
|----------|-----------|--------|-----|----|----|----|
| rules-only | 0.000 | 0.000 | 0.000 | 0 | 0 | 3 |
| presidio-ts | 0.000 | 0.000 | 0.000 | 0 | 0 | 3 |
| hybrid | 0.000 | 0.000 | 0.000 | 0 | 0 | 3 |

### PHONE_NUMBER

| Detector | Precision | Recall | F1 | TP | FP | FN |
|----------|-----------|--------|-----|----|----|----|
| rules-only | - | - | - | 0 | 0 | 0 |
| presidio-ts | 0.000 | 0.000 | 0.000 | 0 | 1 | 0 |
| hybrid | 0.000 | 0.000 | 0.000 | 0 | 1 | 0 |

### PRIVATE_KEY

| Detector | Precision | Recall | F1 | TP | FP | FN |
|----------|-----------|--------|-----|----|----|----|
| rules-only | 0.000 | 0.000 | 0.000 | 0 | 0 | 1 |
| presidio-ts | 0.000 | 0.000 | 0.000 | 0 | 0 | 1 |
| hybrid | 0.000 | 0.000 | 0.000 | 0 | 0 | 1 |

### SECRET

| Detector | Precision | Recall | F1 | TP | FP | FN |
|----------|-----------|--------|-----|----|----|----|
| rules-only | 0.000 | 0.000 | 0.000 | 0 | 0 | 1 |
| presidio-ts | 0.000 | 0.000 | 0.000 | 0 | 0 | 1 |
| hybrid | 0.000 | 0.000 | 0.000 | 0 | 0 | 1 |

### SSN

| Detector | Precision | Recall | F1 | TP | FP | FN |
|----------|-----------|--------|-----|----|----|----|
| rules-only | 0.000 | 0.000 | 0.000 | 0 | 0 | 3 |
| presidio-ts | 0.000 | 0.000 | 0.000 | 0 | 0 | 3 |
| hybrid | 0.000 | 0.000 | 0.000 | 0 | 0 | 3 |

### URL

| Detector | Precision | Recall | F1 | TP | FP | FN |
|----------|-----------|--------|-----|----|----|----|
| rules-only | 0.000 | 0.000 | 0.000 | 0 | 0 | 2 |
| presidio-ts | 1.000 | 1.000 | 1.000 | 2 | 0 | 0 |
| hybrid | 1.000 | 1.000 | 1.000 | 2 | 0 | 0 |

## Recommendations

- **Hybrid vs Rules-only:** F1 +0.096, Recall +0.082, Precision -0.092, Latency +32.4ms
- **Presidio TS** adds semantic entity detection (PERSON, ORG, LOCATION, DATE) that rules miss
- **Rules** excel at structured patterns (emails, API keys, JWTs, credit cards) with near-zero false positives
- **Threshold tuning:** Consider lowering Presidio threshold to 0.4 for higher recall, or raising to 0.6 for higher precision
- **Production note:** Presidio TS uses @siddicky/anonymizerts with ONNX Runtime Web
- **False positive analysis:** Rules are precision-optimized; Presidio TS may need allowlist for test/placeholder data

---
*Generated by benchmark script*