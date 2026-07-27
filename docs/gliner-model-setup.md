# GLiNER ONNX Model Setup Guide

This guide documents how to download, export, quantize, and prepare GLiNER models for use with ContextIO-Next's LLM-based PII detection.

> **Key Finding**: The working export method is **GLiNER's built-in `model.export_to_onnx()`**. Optimum CLI (`optimum-cli export onnx`) fails to infer the library from GLiNER models.

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
export REDACT_DETECTOR_MODEL_DIR=./models/gliner-small-v2.1/onnx
ctxio proxy --redact --detector-mode hybrid
```

> **Note**: The model directory is the `onnx` subdirectory containing `model.onnx`, `spm.model`, `tokenizer_config.json`, and `gliner_config.json`.

---

## Model Overview

| Model | HuggingFace ID | Size (FP32) | Labels | License | Best For |
|-------|----------------|-------------|--------|---------|----------|
| gliner-small-v2.1 | `urchade/gliner_small-v2.1` | ~100MB | 50+ general | MIT | **Production default** |
| gliner-multilingual-v2.1 | `urchade/gliner_multi-v2.1` | ~400MB | 100+ langs | MIT | Multilingual PII |
| gliner-pii-v1 (NVIDIA) | `nvidia/gliner-pii-v1` | ~1.8GB | 55+ PII/PHI | NVIDIA Open | High-recall PII |
| gliner-small-pii (vicgalle) | `vicgalle/gliner-small-pii` | ~100MB | 20+ PII | MIT | Lightweight PII |

---

## Working Export Method: GLiNER's Built-in `export_to_onnx()`

**This is the only method that works reliably.** Optimum CLI cannot infer the model library from GLiNER models.

### Prerequisites

```bash
# Install GLiNER and dependencies
pip install gliner optimum[onnx] onnxruntime huggingface_hub

# On externally-managed Python (Debian/Ubuntu 23.04+, Fedora 38+):
# Use pipx, venv, or --break-system-packages
pipx install gliner optimum[onnx] onnxruntime huggingface_hub
# OR
python3 -m venv venv && source venv/bin/activate && pip install gliner optimum[onnx] onnxruntime huggingface_hub
```

### Export Process

```python
# export_model.py
from gliner import GLiNER
import os
import json

# 1. Load model from local files
model = GLiNER.from_pretrained('./gliner-small-v2.1')

# 2. Export to ONNX
os.makedirs('./gliner-small-v2.1/onnx', exist_ok=True)
model.export_to_onnx('./gliner-small-v2.1/onnx')

# 3. CRITICAL: Fix model_type in config (export leaves it as null)
with open('./gliner-small-v2.1/onnx/gliner_config.json', 'r') as f:
    config = json.load(f)
config['model_type'] = 'gliner'
with open('./gliner-small-v2.1/onnx/gliner_config.json', 'w') as f:
    json.dump(config, f, indent=2)

print('ONNX export complete with model_type fix')
```

Run:
```bash
python export_model.py
```

### Why This Works

1. **GLiNER's `export_to_onnx()`** handles the model's custom architecture correctly
2. **Optimum CLI fails** with "Could not automatically infer the library from the model"
3. **The `model_type` fix** is required - the exported config has `"model_type": null`

---

## Manual Step-by-Step (Alternative to Script)

### 1. Download Model Files from HuggingFace Hub

```python
# download_model.py
from huggingface_hub import snapshot_download

snapshot_download(
    repo_id='urchade/gliner_small-v2.1',
    local_dir='./gliner-small-v2.1',
    local_dir_use_symlinks=False,
    allow_patterns=['*.json', '*.txt', '*.model', 'config.json', 'vocab.txt', 'tokenizer*', 'special_tokens*', '*.bin', '*.safetensors']
)
print('Model files downloaded')
```

### 2. Export to ONNX (Using GLiNER's Method)

```python
# export_model.py (as shown above)
from gliner import GLiNER
import os
import json

model = GLiNER.from_pretrained('./gliner-small-v2.1')
os.makedirs('./gliner-small-v2.1/onnx', exist_ok=True)
model.export_to_onnx('./gliner-small-v2.1/onnx')

# Fix model_type
with open('./gliner-small-v2.1/onnx/gliner_config.json', 'r') as f:
    config = json.load(f)
config['model_type'] = 'gliner'
with open('./gliner-small-v2.1/onnx/gliner_config.json', 'w') as f:
    json.dump(config, f, indent=2)
```

### 3. Verify Exported Model

```bash
python -c "
import onnx
model = onnx.load('./gliner-small-v2.1/onnx/model.onnx')
print(f'IR version: {model.ir_version}')
print(f'Producer: {model.producer_name}')
print(f'Opset: {model.opset_import[0].version}')
print(f'Inputs: {[i.name for i in model.graph.input]}')
print(f'Outputs: {[o.name for o in model.graph.output]}')
"
```

### 4. (Optional) Quantize to INT8

```bash
# Dynamic quantization (recommended)
optimum-cli quantize --onnx-model ./gliner-small-v2.1/onnx/model.onnx \
  --quantization dynamic \
  ./gliner-small-v2.1/onnx/model_int8.onnx
```

---

## Directory Structure Convention

ContextIO-Next expects the following structure (note: `onnx` subdirectory):

```
models/
└── gliner-small-v2.1/           # Model root (downloaded from HF)
    ├── config.json              # Original HF model config
    ├── spm.model                # SentencePiece tokenizer model
    ├── tokenizer_config.json    # Tokenizer settings
    ├── special_tokens_map.json  # Special token mappings
    ├── *.safetensors            # Original model weights
    └── onnx/                    # <-- EXPORTED MODEL DIRECTORY (used at runtime)
        ├── model.onnx           # FP32 ONNX model
        ├── model_int8.onnx      # INT8 quantized (optional, preferred)
        ├── spm.model            # Copied from parent
        ├── tokenizer_config.json
        ├── special_tokens_map.json
        ├── gliner_config.json   # MUST have model_type: "gliner"
        └── config.yaml          # Auto-generated reference
```

> **Important**: The runtime `REDACT_DETECTOR_MODEL_DIR` points to the `onnx/` subdirectory, not the model root.

---

## Critical: Tokenizer Files (SentencePiece, NOT WordPiece)

**GLiNER uses SentencePiece (SPM), not WordPiece vocab.txt.**

### Required Files in `onnx/` Directory

| File | Description | Source |
|------|-------------|--------|
| `spm.model` | SentencePiece Unigram model | Downloaded from HF (`spm.model`) |
| `tokenizer_config.json` | Tokenizer settings | Downloaded from HF |
| `special_tokens_map.json` | Special token IDs | Downloaded from HF |
| `gliner_config.json` | Model config with `model_type: "gliner"` | Exported + patched |

### What the Detector Does (glinerDetector.ts)

The `GlinerOnnxDetector` **manually constructs** the tokenizer using `@huggingface/tokenizers` v0.1.3:

```typescript
// Manual construction (no from_pretrained available in v0.1.3)
const model = new Unigram(spmPath);  // Load SentencePiece model
const tokenizer = new Tokenizer(model);

tokenizer.normalizer = new BertNormalizer({ cleanText: true, handleChineseChars: true, stripAccents: false, lowercase: false });
tokenizer.preTokenizer = new WhitespaceSplitPreTokenizer();
tokenizer.decoder = new MetaspaceDecoder();
tokenizer.postProcessor = new TemplateProcessingPostProcessor({
  single: "[CLS] $A [SEP]",
  pair: "[CLS] $A [SEP] $B [SEP]",
  specialTokens: [["[CLS]", "[CLS]"], ["[SEP]", "[SEP]"], ["[PAD]", "[PAD]"], ["[UNK]", "[UNK]"], ["[MASK]", "[MASK]"], ["<<ENT>>", "<<ENT>>"], ["<<SEP>>", "<<SEP>>"]]
});

tokenizer.enableTruncation(512);
tokenizer.enablePadding({ length: 512, padId: padId, padToken: "[PAD]" });
```

### Obtaining Tokenizer Files

If missing from export, download from HF:

```python
from transformers import AutoTokenizer
tokenizer = AutoTokenizer.from_pretrained('urchade/gliner_small-v2.1')
tokenizer.save_pretrained('./gliner-small-v2.1')
# Then copy spm.model, tokenizer_config.json, special_tokens_map.json to onnx/
```

---

## Licensing

| Model | License | Commercial Use | Notes |
|-------|---------|----------------|-------|
| urchade/gliner_small-v2.1 | MIT | ✅ Yes | Full commercial use |
| urchade/gliner_multi-v2.1 | MIT | ✅ Yes | Full commercial use |
| vicgalle/gliner-small-pii | MIT | ✅ Yes | Full commercial use |
| nvidia/gliner-pii-v1 | NVIDIA Open Model License | ✅ Yes* | Include license text + attribution |

*NVIDIA Open Model License requires redistribution of license text and attribution.

---

## Configuration

### Proxy (Environment Variables)

```bash
export REDACT_DETECTOR_MODE=hybrid           # rules|llm|hybrid|auto
export REDACT_DETECTOR_MODEL_DIR=./models/gliner-small-v2.1/onnx
export REDACT_DETECTOR_THRESHOLD=0.5         # Confidence threshold (0-1)
```

### Web UI

Settings → Redaction → Detector Settings:
- **Detector Mode**: Hybrid (rules + LLM, rules take priority)
- **GLiNER Model Directory**: `/app/models/gliner-small-v2.1/onnx`
- **LLM Detection Threshold**: 0.5

### Policy File (JSONC)

```jsonc
{
  "extends": "pii",
  "detector": {
    "mode": "hybrid",
    "modelPath": "./models/gliner-small-v2.1/onnx",
    "llmThreshold": 0.5,
    "llmLabels": ["PERSON", "EMAIL", "PHONE", "ADDRESS", "SSN", "CREDIT_CARD"]
  }
}
```

---

## Performance Tuning

### Model Selection Guidelines

| Use Case | Model | Quantization | Expected Latency (p50) |
|----------|-------|--------------|------------------------|
| High-throughput, low-latency | gliner-small-v2.1 | INT8 | ~15ms |
| Maximum PII recall | nvidia/gliner-pii-v1 | INT8 | ~40ms |
| Non-English content | gliner-multilingual-v2.1 | INT8 | ~30ms |
| Resource constrained | gliner-small-v2.1 | INT8 | ~150MB RAM |

### Threshold Tuning

- **0.3-0.4**: Higher recall, more false positives
- **0.5** (default): Balanced
- **0.7-0.8**: Higher precision, fewer false positives

### Custom Labels

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

### Build with Models (Multi-stage - Recommended)

```dockerfile
# =============================================================================
# Build stage: Prepare GLiNER model using Python (Debian-based for onnxruntime)
# =============================================================================
FROM python:3.11-slim AS model-builder
WORKDIR /models

# Install GLiNER, Optimum CLI with ONNX support, and huggingface_hub
RUN pip install --no-cache-dir gliner optimum[onnx] onnxruntime huggingface_hub

# Download model files from HuggingFace Hub
RUN python -c "
from huggingface_hub import snapshot_download
snapshot_download(
    repo_id='urchade/gliner_small-v2.1',
    local_dir='./gliner-small-v2.1',
    local_dir_use_symlinks=False,
    allow_patterns=['*.json', '*.txt', '*.model', 'config.json', 'vocab.txt', 'tokenizer*', 'special_tokens*', '*.bin', '*.safetensors']
)
"

# Export to ONNX using GLiNER's built-in export_to_onnx method
RUN python -c "
from gliner import GLiNER
import os, json
model = GLiNER.from_pretrained('./gliner-small-v2.1')
os.makedirs('./gliner-small-v2.1/onnx', exist_ok=True)
model.export_to_onnx('./gliner-small-v2.1/onnx')

# Fix model_type in exported config (export leaves it as null)
with open('./gliner-small-v2.1/onnx/gliner_config.json', 'r') as f:
    config = json.load(f)
config['model_type'] = 'gliner'
with open('./gliner-small-v2.1/onnx/gliner_config.json', 'w') as f:
    json.dump(config, f, indent=2)
"

# =============================================================================
# Build stage: Build TypeScript packages
# =============================================================================
FROM node:22-slim AS build
WORKDIR /app
# ... your existing build steps ...

# =============================================================================
# Runtime stage
# =============================================================================
FROM node:22-slim AS runtime
WORKDIR /app

# Copy GLiNER model from model-builder (ONNX export in onnx/ subdirectory)
COPY --from=model-builder /models/gliner-small-v2.1/onnx /app/models/gliner-small-v2.1

# NO hardcoded ENV vars - users configure via:
# - Environment variables at runtime
# - Web UI settings file (/app/custom-policy/settings.json)
# - CLI flags
```

### Runtime Mount (Development)

```bash
docker run -v $(pwd)/models:/app/models \
  -e REDACT_DETECTOR_MODEL_DIR=/app/models/gliner-small-v2.1/onnx \
  contextio-next
```

---

## Troubleshooting

### Model Not Found
```
Error: Model directory not found: ./models/gliner-small-v2.1/onnx
```
**Fix**: Ensure `REDACT_DETECTOR_MODEL_DIR` points to the `onnx/` subdirectory containing `model.onnx`.

### Tokenizer Files Missing
```
Error: spm.model not found in model directory
```
**Fix**: Copy tokenizer files to `onnx/` subdirectory:
```bash
cp models/gliner-small-v2.1/spm.model models/gliner-small-v2.1/onnx/
cp models/gliner-small-v2.1/tokenizer_config.json models/gliner-small-v2.1/onnx/
cp models/gliner-small-v2.1/special_tokens_map.json models/gliner-small-v2.1/onnx/
```

### ONNX Runtime Errors
```
Error: [ONNXRuntimeError] Non-zero status code returned
```
**Fixes**:
1. Ensure `onnxruntime-node` is installed: `pnpm add onnxruntime-node`
2. Re-export with explicit opset: GLiNER uses opset 14-17
3. Check `gliner_config.json` has `"model_type": "gliner"`

### model_type is null
```
Error: Model config missing model_type
```
**Fix**: Always patch after export:
```python
config['model_type'] = 'gliner'
```

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

1. Checks Python + `optimum`/`onnxruntime` (handles PEP 668)
2. Downloads model from HF Hub via `snapshot_download`
3. Exports to ONNX using **GLiNER's `export_to_onnx()`**
4. Patches `model_type` in `gliner_config.json`
5. Quantizes to INT8 via Optimum CLI (optional)
6. Validates required files present
7. Generates `config.yaml` reference

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

      - name: Install Dependencies
        run: pip install gliner optimum[onnx] onnxruntime huggingface_hub

      - name: Prepare Models
        run: ./scripts/prepare-gliner-models.sh all

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
- [GLiNER ONNX Export](https://github.com/urchade/GLiNER/blob/main/docs/onnx_export.md)
- [NVIDIA GLiNER-PII](https://huggingface.co/nvidia/gliner-pii-v1)
- [ONNX Runtime Node.js](https://onnxruntime.ai/docs/get-started/with-javascript/node.html)
- [ContextIO-Next Redaction Policy](redaction-policy.md)
- [HuggingFace Optimum ONNX](https://huggingface.co/docs/optimum/exporters/onnx/usage_guides/export_a_model)