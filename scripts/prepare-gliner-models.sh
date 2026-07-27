#!/usr/bin/env bash
#
# prepare-gliner-models.sh
#
# Download and prepare GLiNER ONNX models for ContextIO-Next hybrid redaction.
#
# Usage:
#   ./scripts/prepare-gliner-models.sh [model-name] [output-dir]
#
# Models:
#   gliner-small-v2.1      - Fast, general PII (recommended default)
#   gliner-multilingual-v2.1 - Multi-language support
#   gliner-small-pii       - Pre-trained PII labels
#   gliner-nvidia-pii      - High accuracy PII (NVIDIA license)
#   all                    - Download all models
#
# Example:
#   ./scripts/prepare-gliner-models.sh gliner-small-v2.1 ./models
#   ./scripts/prepare-gliner-models.sh all ./models

set -euo pipefail

# Colors for output
RED='\033[0;31m'
GREEN='\033[0;32m'
YELLOW='\033[1;33m'
BLUE='\033[0;34m'
NC='\033[0m' # No Color

log_info() { echo -e "${BLUE}[INFO]${NC} $*"; }
log_success() { echo -e "${GREEN}[SUCCESS]${NC} $*"; }
log_warn() { echo -e "${YELLOW}[WARN]${NC} $*"; }
log_error() { echo -e "${RED}[ERROR]${NC} $*"; }

# Default configuration
DEFAULT_OUTPUT_DIR="./models"
AVAILABLE_MODELS=(
    "gliner-small-v2.1:urchade/gliner_small-v2.1"
    "gliner-multilingual-v2.1:urchade/gliner_multilingual-v2.1"
    "gliner-small-pii:vicgalle/gliner-small-pii"
    "gliner-nvidia-pii:nvidia/gliner-PII"
)

# Parse arguments
MODEL_NAME="${1:-all}"
OUTPUT_DIR="${2:-$DEFAULT_OUTPUT_DIR}"

# Check dependencies
check_dependencies() {
    log_info "Checking dependencies..."

    if ! command -v python3 &> /dev/null; then
        log_error "python3 not found. Please install Python 3.10+"
        exit 1
    fi

    # Check if we can import optimum and onnxruntime
    if python3 -c "import optimum; import onnxruntime" 2>/dev/null; then
        log_success "Dependencies OK"
        OPTIMUM_CLI="optimum-cli"
        if ! command -v optimum-cli &> /dev/null; then
            OPTIMUM_CLI="python3 -m optimum.cli"
        fi
        return
    fi

    log_warn "Python packages 'optimum' and 'onnxruntime' not found."
    echo ""
    echo "Your system uses an externally-managed Python environment (PEP 668)."
    echo "Please install dependencies using one of these methods:"
    echo ""
    echo "  Option 1: pipx (recommended for CLI tools)"
    echo "    pipx install optimum[onnx]"
    echo ""
    echo "  Option 2: Virtual environment"
    echo "    python3 -m venv venv"
    echo "    source venv/bin/activate"
    echo "    pip install optimum[onnx] onnxruntime"
    echo ""
    echo "  Option 3: With --break-system-packages (not recommended)"
    echo "    pip install --break-system-packages optimum[onnx] onnxruntime"
    echo ""
    echo "Then re-run this script."
    exit 1
}

# Prepare a single model
prepare_model() {
    local model_key="$1"
    local hf_model_id="$2"
    local model_dir="$OUTPUT_DIR/$model_key"

    log_info "Preparing model: $model_key ($hf_model_id)"

    # Create output directory
    mkdir -p "$model_dir"

    # Export to ONNX
    log_info "Exporting to ONNX..."
    if ! $OPTIMUM_CLI export onnx \
        --model "$hf_model_id" \
        --task token-classification \
        "$model_dir" 2>&1; then
        log_error "Failed to export $model_key"
        return 1
    fi

    # Quantize to INT8
    log_info "Quantizing to INT8..."
    if ! $OPTIMUM_CLI quantize \
        --onnx-model "$model_dir/model.onnx" \
        --quantization dynamic \
        "$model_dir/model_int8.onnx" 2>&1; then
        log_warn "Quantization failed for $model_key (continuing with fp16)"
    else
        log_success "INT8 quantization complete"
    fi

    # Verify required files
    local required_files=("model.onnx" "vocab.txt" "tokenizer_config.json" "special_tokens_map.json")
    local missing=0
    for file in "${required_files[@]}"; do
        if [[ ! -f "$model_dir/$file" ]]; then
            log_warn "Missing required file: $model_dir/$file"
            missing=1
        fi
    done

    if [[ $missing -eq 1 ]]; then
        log_warn "Some tokenizer files may be missing. Check export output."
    fi

    # Show file sizes
    log_info "Model files:"
    ls -lh "$model_dir/"

    # Create config.yaml for reference
    cat > "$model_dir/config.yaml" <<EOF
# Auto-generated model configuration
model: "$model_key"
huggingface_id: "$hf_model_id"
exported: "$(date -Iseconds)"
onnx_model: "model.onnx"
int8_model: "model_int8.onnx"
tokenizer_vocab: "vocab.txt"
tokenizer_config: "tokenizer_config.json"
special_tokens: "special_tokens_map.json"
license: "$(get_license "$model_key")"
EOF

    log_success "Model $model_key ready at $model_dir"
}

get_license() {
    case "$1" in
        gliner-nvidia-pii) echo "NVIDIA Open Model License" ;;
        *) echo "MIT" ;;
    esac
}

# Main execution
main() {
    log_info "GLiNER Model Preparation Script"
    log_info "Output directory: $OUTPUT_DIR"

    check_dependencies

    # Determine which models to prepare
    local models_to_prepare=()
    if [[ "$MODEL_NAME" == "all" ]]; then
        for entry in "${AVAILABLE_MODELS[@]}"; do
            models_to_prepare+=("$entry")
        done
    else
        # Find matching model
        local found=0
        for entry in "${AVAILABLE_MODELS[@]}"; do
            local key="${entry%%:*}"
            if [[ "$key" == "$MODEL_NAME" ]]; then
                models_to_prepare+=("$entry")
                found=1
                break
            fi
        done
        if [[ $found -eq 0 ]]; then
            log_error "Unknown model: $MODEL_NAME"
            log_info "Available models: ${AVAILABLE_MODELS[*]}"
            exit 1
        fi
    fi

    # Prepare each model
    local failed=0
    for entry in "${models_to_prepare[@]}"; do
        local key="${entry%%:*}"
        local hf_id="${entry#*:}"
        if ! prepare_model "$key" "$hf_id"; then
            failed=1
        fi
    done

    if [[ $failed -eq 1 ]]; then
        log_error "Some models failed to prepare"
        exit 1
    fi

    log_success "All models prepared successfully in $OUTPUT_DIR"
    log_info "Next steps:"
    echo "  1. Set REDACT_DETECTOR_MODEL_DIR=$OUTPUT_DIR/gliner-small-v2.1"
    echo "  2. Run: ctxio proxy --redact --detector-mode hybrid"
}

main "$@"