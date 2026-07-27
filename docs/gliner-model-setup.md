# GLiNER ONNX Model Setup Guide

This guide documents how to download, export, quantize, and prepare GLiNER models for use with ContextIO-Next's LLM-based PII detection.

## Quick Start

For most users, run the automated script:

```bash
# Prepare gliner-small-v2.1 (recommended for production)
./scripts/prepare-gliner-models.sh gliner-small-v2.1

# Or prepare all available models
./scripts/prepare-gliner-models.sh all
```

Then configure the proxy:

```bash
export REDACT_DETECTOR_MODEL_DIR=./models/gliner-small-v2.1
ctxio proxy --redact --detector-mode hybrid
```

---

## Model Overview

| Model | HuggingFace ID | Size (FP32) | Size (INT8) | Labels | License | Best For |
|-------|----------------|-------------|-------------|--------|---------|----------|
| gliner-small-v2.1 | `urchade/gliner_small-v2.1` | ~100MB | ~25MB | 50+ general | MIT | **Production default** |
| gliner-multilingual-v2.1 | `urchade/gliner_multi-v2.1` | ~400MB | ~100MB | 100+ langs | MIT | Multilingual PII |
| gliner-pii-v1 (NVIDIA) | `nvidia/gliner-pii-v1` | ~1.8GB | ~450MB | 55+ PII/PHI | NVIDIA Open | High-recall PII |
| gliner-small-pii (vicgalle) | `vicgalle/gliner-small-pii` | ~100MB | ~25MB | 20+ PII | MIT | Lightweight PII |

---

## Manual Export Process

### Prerequisites

```bash
# Install Optimum CLI with ONNX support
pip install optimum[onnx] onnxruntime

# Verify installation
optimum-cli export onnx --help
```

### Export to ONNX (FP32)

```bash
# Export gliner-small-v2.1
optimum-cli export onnx --model urchade/gliner_small-v2.1 \
  --task token-classification \
  ./models/gliner-small-v2.1

# Export gliner-multilingual-v2.1
optimum-cli export onnx --model urchade/gliner_multi-v2.1 \
  --task token-classification \
  ./models/gliner-multilingual-v2.1

# Export NVIDIA GLiNER-PII (requires accepting license)
optimum-cli export onnx --model nvidia/gliner-pii-v1 \
  --task token-classification \
  ./models/gliner-pii-v1
```

### Quantize to INT8 (Recommended for Production)

```bash
# Dynamic quantization (recommended - balances speed/accuracy)
optimum-cli quantize --onnx-model ./models/gliner-small-v2.1/model.onnx \
  --quantization dynamic \
  ./models/gliner-small-v2.1/model_int8.onnx

# Or quantize during export (single step)
optimum-cli export onnx --model urchade/gliner_small-v2.1 \
  --task token-classification \
  --quantization dynamic \
  ./models/gliner-small-v2.1
```

### Verify Exported Model

```bash
# Check model structure
python -c "
import onnx
model = onnx.load('./models/gliner-small-v2.1/model_int8.onnx')
print(f'IR version: {model.ir_version}')
print(f'Producer: {model.producer_name}')
print(f'Opset: {model.opset_import[0].version}')
print(f'Inputs: {[i.name for i in model.graph.input]}')
print(f'Outputs: {[o.name for o in model.graph.output]}')
"
```

---

## Directory Structure Convention

ContextIO-Next expects the following structure:

```
models/
└── gliner-small-v2.1/           # Model directory (name = model id)
    ├── model.onnx               # FP32 model (optional if INT8 exists)
    ├── model_int8.onnx          # INT8 quantized model (preferred)
    ├── vocab.txt                # WordPiece vocabulary
    ├── tokenizer_config.json    # Tokenizer configuration
    ├── special_tokens_map.json  # Special token mappings
    └── config.json              # Model configuration (optional)
```

### Required Tokenizer Files

**vocab.txt** - WordPiece vocabulary (must be present)

```
[PAD]
[UNK]
[CLS]
[SEP]
[MASK]
the
...
```

**tokenizer_config.json** - Tokenizer settings

```json
{
  "do_lower_case": true,
  "unk_token": "[UNK]",
  "sep_token": "[SEP]",
  "pad_token": "[PAD]",
  "cls_token": "[CLS]",
  "mask_token": "[MASK]",
  "model_max_length": 512,
  "padding_side": "right",
  "tokenizer_class": "BertTokenizerFast"
}
```

**special_tokens_map.json** - Special token mappings

```json
{
  "unk_token": "[UNK]",
  "sep_token": "[SEP]",
  "pad_token": "[PAD]",
  "cls_token": "[CLS]",
  "mask_token": "[MASK]"
}
```

### Obtaining Tokenizer Files

If exporting from HuggingFace, tokenizer files are included automatically. If missing:

```bash
# Download tokenizer files separately
python -c "
from transformers import AutoTokenizer
tokenizer = AutoTokenizer.from_pretrained('urchade/gliner_small-v2.1')
tokenizer.save_pretrained('./models/gliner-small-v2.1')
"
```

---

## Licensing

| Model | License | Commercial Use | Notes |
|-------|---------|----------------|-------|
| urchade/gliner_small-v2.1 | MIT | ✅ Yes | Full commercial use |
| urchade/gliner_multi-v2.1 | MIT | ✅ Yes | Full commercial use |
| vicgalle/gliner-small-pii | MIT | ✅ Yes | Full commercial use |
| nvidia/gliner-pii-v1 | NVIDIA Open Model License | ✅ Yes* | See [license](https://huggingface.co/nvidia/gliner-pii-v1/blob/main/LICENSE) |

*NVIDIA Open Model License requires redistribution of license text and attribution. Suitable for commercial products.

### License Compliance Checklist

- [ ] Include MIT license text for GLiNER models in your distribution
- [ ] Include NVIDIA Open Model License for nvidia/gliner-pii-v1
- [ ] Provide attribution in documentation/about page
- [ ] Do not use model for illegal/harmful purposes (per license terms)

---

## Configuration

### Proxy Configuration

```bash
# Environment variables
export REDACT_DETECTOR_MODE=hybrid           # rules|llm|hybrid|auto
export REDACT_DETECTOR_MODEL_DIR=./models/gliner-small-v2.1
export REDACT_DETECTOR_THRESHOLD=0.5         # Confidence threshold (0-1)
```

### Web UI Configuration

Settings → Redaction → Detector Settings:
- **Detector Mode**: Hybrid (rules + LLM, rules take priority)
- **GLiNER Model Directory**: `/app/models/gliner-small-v2.1`
- **LLM Detection Threshold**: 0.5

### Policy File Configuration

```jsonc
{
  "extends": "pii",
  "detector": {
    "mode": "hybrid",
    "modelPath": "./models/gliner-small-v2.1",
    "llmThreshold": 0.5,
    "llmLabels": ["PERSON", "EMAIL", "PHONE", "ADDRESS", "SSN", "CREDIT_CARD"]
  }
}
```

---

## Performance Tuning

### Model Selection Guidelines

| Use Case | Model | Quantization | Expected Latency |
|----------|-------|--------------|------------------|
| High-throughput, low-latency | gliner-small-v2.1 | INT8 | ~15ms p50 |
| Maximum PII recall | nvidia/gliner-pii-v1 | INT8 | ~40ms p50 |
| Non-English content | gliner-multilingual-v2.1 | INT8 | ~30ms p50 |
| Resource constrained | gliner-small-v2.1 | INT8 | ~150MB RAM |

### Threshold Tuning

- **0.3-0.4**: Higher recall, more false positives
- **0.5** (default): Balanced
- **0.7-0.8**: Higher precision, fewer false positives

### Custom Labels

By default, GLiNER uses its built-in label set. Override with custom labels:

```bash
export REDACT_LLM_LABELS="PERSON,EMAIL,PHONE_NUMBER,ADDRESS,SSN,CREDIT_CARD,PASSPORT,DRIVER_LICENSE"
```

Or in policy:

```jsonc
{
  "detector": {
    "llmLabels": ["PERSON", "EMAIL", "PHONE", "SSN"]
  }
}
```

---

## Docker Integration

### Build with Models

```dockerfile
# Build stage with model preparation
FROM python:3.11-slim AS model-builder
RUN pip install optimum[onnx] onnxruntime
RUN optimum-cli export onnx --model urchade/gliner_small-v2.1 \
      --task token-classification --quantization dynamic \
      /models/gliner-small-v2.1

# Runtime stage
FROM node:20-slim
COPY --from=model-builder /models /app/models
ENV REDACT_DETECTOR_MODEL_DIR=/app/models/gliner-small-v2.1
```

### Runtime Mount (Development)

```bash
docker run -v $(pwd)/models:/app/models \
  -e REDACT_DETECTOR_MODEL_DIR=/app/models/gliner-small-v2.1 \
  contextio-next
```

---

## Troubleshooting

### Model Not Found

```
Error: Model directory not found: ./models/gliner-small-v2.1
```

**Fix**: Ensure `REDACT_DETECTOR_MODEL_DIR` points to the directory containing `model_int8.onnx` and tokenizer files.

### Tokenizer Files Missing

```
Error: vocab.txt not found in model directory
```

**Fix**: Run tokenizer download:
```bash
python -c "
from transformers import AutoTokenizer
tokenizer = AutoTokenizer.from_pretrained('urchade/gliner_small-v2.1')
tokenizer.save_pretrained('./models/gliner-small-v2.1')
"
```

### ONNX Runtime Errors

```
Error: [ONNXRuntimeError] Non-zero status code returned
```

**Fixes**:
1. Ensure `onnxruntime-node` is installed: `pnpm add onnxruntime-node`
2. Check model compatibility: `model_int8.onnx` must match opset version
3. Re-export with explicit opset: `--opset 14`

### Poor Detection Quality

1. Lower threshold: `REDACT_DETECTOR_THRESHOLD=0.3`
2. Add custom labels for domain-specific entities
3. Use hybrid mode (rules + LLM) for best coverage
4. Try larger model: `gliner-multilingual-v2.1` or `nvidia/gliner-pii-v1`

### High Memory Usage

1. Use INT8 quantization (reduces memory 3-4x)
2. Switch to `gliner-small-v2.1` from larger models
3. Reduce concurrent requests / batch size

---

## Automated Script Reference

### `scripts/prepare-gliner-models.sh`

```bash
# Prepare single model
./scripts/prepare-gliner-models.sh gliner-small-v2.1

# Prepare all models
./scripts/prepare-gliner-models.sh all

# Custom output directory
OUTPUT_DIR=/opt/models ./scripts/prepare-gliner-models.sh gliner-small-v2.1

# Skip quantization (keep FP32)
QUANTIZE=false ./scripts/prepare-gliner-models.sh gliner-small-v2.1
```

### Script Actions

1. Creates output directory
2. Exports model to ONNX via Optimum CLI
3. Quantizes to INT8 (optional)
4. Downloads tokenizer files via Transformers
5. Validates model structure
6. Prints configuration summary

---

## CI/CD Integration

### GitHub Actions Example

```yaml
name: Prepare GLiNER Models
on:
  workflow_dispatch:
  schedule:
    - cron: '0 0 * * 0'  # Weekly

jobs:
  prepare-models:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v4

      - name: Setup Python
        uses: actions/setup-python@v5
        with:
          python-version: '3.11'

      - name: Install Optimum
        run: pip install optimum[onnx] onnxruntime

      - name: Prepare Models
        run: |
          ./scripts/prepare-gliner-models.sh all

      - name: Upload Models Artifact
        uses: actions/upload-artifact@v4
        with:
          name: gliner-models
          path: models/
          retention-days: 30
```

---

## References

- [GLiNER GitHub](https://github.com/urchade/GLiNER)
- [Optimum ONNX Export](https://huggingface.co/docs/optimum/exporters/onnx/usage_guides/export_a_model)
- [NVIDIA GLiNER-PII](https://huggingface.co/nvidia/gliner-pii-v1)
- [ONNX Runtime Node.js](https://onnxruntime.ai/docs/get-started/with-javascript/node.html)
- [ContextIO-Next Redaction Policy](redaction-policy.md)