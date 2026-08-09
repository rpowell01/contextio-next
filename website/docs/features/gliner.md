---
layout: doc
---

# GLiNER LLM Redaction Detector

Local ONNX model for context-aware PII detection. No external API calls, no GPU required.

## Overview

GLiNER (Generalist Lightweight Named Entity Recognizer) is a compact NER model that can detect arbitrary entity types. ContextIO-Next includes a pre-built quantized ONNX model (~50MB) copied from `ghcr.io/rpowell01/contextio-gliner-model:0.2.28`.

## Quick Start

```bash
# Enable GLiNER
REDACT_GLINER_ENABLED=true

# Optional: adjust threshold (0.1-1.0, default 0.5)
REDACT_GLINER_THRESHOLD=0.5

# Optional: custom labels (comma-separated)
REDACT_GLINER_LABELS=person,organization,email,api_key,credit_card
```

## Built-in Labels

The model includes these pre-trained labels:

| Category | Labels |
|----------|--------|
| **Identity** | `person`, `organization`, `location` |
| **Contact** | `email`, `phone_number` |
| **Financial** | `credit_card`, `bank_account`, `crypto_wallet` |
| **Government ID** | `ssn`, `passport_number`, `driver_license`, `national_id`, `vehicle_vin`, `license_plate` |
| **Health** | `medical_record_number`, `health_plan_beneficiary` |
| **Secrets** | `api_key`, `password`, `ip_address` |
| **Personal** | `date_of_birth`, `address` |

## Configuration

| Variable | Default | Description |
|----------|---------|-------------|
| `REDACT_GLINER_ENABLED` | `false` | Enable GLiNER detector |
| `REDACT_GLINER_THRESHOLD` | `0.5` | Confidence threshold (0-1) |
| `REDACT_GLINER_LABELS` | *(all built-in)* | Comma-separated custom labels |
| `REDACT_GLINER_MODEL_PATH` | `/app/models/gliner_model.onnx` | Model file path |

## How It Works

1. **Tokenizer**: Input text → token IDs with offset mapping
2. **ONNX Inference**: Runs quantized model via ONNX Runtime Web
3. **Span Extraction**: Model outputs entity spans with confidence scores
4. **NMS**: Non-maximum suppression removes overlapping spans
5. **Redaction**: Spans above threshold → replaced with placeholders

## Detector Modes

Combine with rule-based detector via `REDACT_DETECTOR_MODE`:

| Mode | Behavior |
|------|----------|
| `rules` | Rule-based only (default) |
| `llm` | GLiNER only |
| `hybrid` | Both, merge results (union) |
| `auto` | Rules first, GLiNER for fallback |

```bash
# Use GLiNER only
REDACT_DETECTOR_MODE=llm
REDACT_GLINER_ENABLED=true

# Hybrid (recommended)
REDACT_DETECTOR_MODE=hybrid
REDACT_GLINER_ENABLED=true
```

## Custom Labels

Define any entity types:

```bash
# Custom labels for your domain
REDACT_GLINER_LABELS=person,organization,project_name,ticket_id,internal_code
```

```jsonc
// In policy file
{
  "extends": "pii",
  "gliner": {
    "enabled": true,
    "labels": ["person", "organization", "project_name", "ticket_id"]
  }
}
```

## Performance

- **Model size**: ~50MB (quantized INT8)
- **Inference**: ~10-50ms per request (CPU)
- **Memory**: ~100MB peak
- **No GPU required**: Runs on CPU via ONNX Runtime Web

## Model Updates

The model is baked into the Docker image. To update:

1. Rebuild the GLiNER model image:
   ```bash
   docker build -f Dockerfile.gliner -t contextio-gliner-model .
   ```
2. Rebuild main image (copies model via `COPY --from`)

## Troubleshooting

| Issue | Solution |
|-------|----------|
| Model not found | Check `REDACT_GLINER_MODEL_PATH` — default is `/app/models/gliner_model.onnx` |
| Low accuracy | Lower `REDACT_GLINER_THRESHOLD` (try 0.3) |
| High false positives | Raise threshold (try 0.7) or use `hybrid` mode |
| Slow inference | Ensure ONNX Runtime Web is using optimized build |
| OOM errors | Model needs ~100MB RAM — check container limits |

## Architecture

```
Request Text
     │
     ▼
┌─────────────┐
│ Tokenizer   │ ──► offset mapping (char → token)
└─────────────┘
     │
     ▼
┌─────────────┐
│ ONNX Runtime│
│  (GLiNER)   │ ──► entity spans + confidence
└─────────────┘
     │
     ▼
┌─────────────┐
│ NMS +       │
│ Threshold   │ ──► filtered spans
└─────────────┘
     │
     ▼
┌─────────────┐
│ Redaction   │
│ Engine      │ ──► redacted text
└─────────────┘
```

## Combined with Rules

In `hybrid` mode, rule-based and GLiNER detections are merged. Overlaps are resolved by:
1. Longer span wins
2. Higher confidence wins
3. Rule-based takes precedence for exact matches

This catches both:
- **Structured patterns** (API keys, credit cards) → Rules
- **Context-dependent entities** (person names, org names) → GLiNER