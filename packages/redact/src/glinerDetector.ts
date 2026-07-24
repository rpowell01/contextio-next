/**
 * GLiNER ONNX detector for named entity recognition.
 *
 * Runs a quantized GLiNER model via ONNX Runtime for local, fast PII detection.
 * Supports custom entity labels for flexible PII categories.
 *
 * Model requirements:
 * - ONNX model exported from GLiNER (generalist Named Entity Recognition)
 * - Tokenizer config (vocab.txt, tokenizer_config.json, special_tokens_map.json)
 *
 * Recommended models:
 * - gliner-small-v2.1 (ONNX): ~100MB, fast CPU inference
 * - gliner-multilingual-v2.1 (ONNX): ~400MB, multilingual support
 * - gliner-pii-v1 (ONNX): PII-specific fine-tuned variant
 */

import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { InferenceSession, Tensor } from "onnxruntime-node";

import type {
  Detector,
  DetectorConfig,
  DetectionResult,
  DetectedSpan,
} from "./detector.js";

const __dirname = dirname(fileURLToPath(import.meta.url));

// --- Tokenizer implementation ---

interface TokenizerConfig {
  vocab: Map<string, number>;
  unkTokenId: number;
  padTokenId: number;
  clsTokenId: number;
  sepTokenId: number;
  maxLength: number;
}

/**
 * Simple BERT-style WordPiece tokenizer.
 * In production, use @huggingface/tokenizers for full fidelity.
 */
class SimpleTokenizer {
  private vocab: Map<string, number>;
  private unkTokenId: number;
  private padTokenId: number;
  private clsTokenId: number;
  private sepTokenId: number;
  private maxLength: number;
  private invVocab: Map<number, string>;

  constructor(config: TokenizerConfig) {
    this.vocab = config.vocab;
    this.unkTokenId = config.unkTokenId;
    this.padTokenId = config.padTokenId;
    this.clsTokenId = config.clsTokenId;
    this.sepTokenId = config.sepTokenId;
    this.maxLength = config.maxLength;
    this.invVocab = new Map();
    for (const [token, id] of this.vocab) {
      this.invVocab.set(id, token);
    }
  }

  static async load(modelDir: string): Promise<SimpleTokenizer> {
    const fs = await import("node:fs/promises");
    const vocabPath = join(modelDir, "vocab.txt");
    const configPath = join(modelDir, "tokenizer_config.json");

    const vocabContent = await fs.readFile(vocabPath, "utf-8");
    const configContent = await fs.readFile(configPath, "utf-8");
    const config = JSON.parse(configContent);

    const vocab = new Map<string, number>();
    let idx = 0;
    for (const line of vocabContent.trim().split("\n")) {
      const token = line.trim();
      if (token) vocab.set(token, idx++);
    }

    return new SimpleTokenizer({
      vocab,
      unkTokenId: vocab.get(config.unk_token ?? "[UNK]") ?? 100,
      padTokenId: vocab.get(config.pad_token ?? "[PAD]") ?? 0,
      clsTokenId: vocab.get(config.cls_token ?? "[CLS]") ?? 101,
      sepTokenId: vocab.get(config.sep_token ?? "[SEP]") ?? 102,
      maxLength: config.model_max_length ?? 512,
    });
  }

  encode(text: string): { inputIds: number[]; attentionMask: number[] } {
    // Basic wordpiece tokenization (simplified)
    // For production, use a proper tokenizer
    const words = text.toLowerCase().split(/\s+/);
    const tokens: string[] = [];

    for (const word of words) {
      let matched = "";
      for (let i = word.length; i > 0; i--) {
        const prefix = word.slice(0, i);
        if (this.vocab.has(prefix)) {
          matched = prefix;
          break;
        }
      }
      if (matched) {
        tokens.push(matched);
        // Add remaining as ## continuations
        const remainder = word.slice(matched.length);
        if (remainder) {
          tokens.push("##" + remainder);
        }
      } else {
        tokens.push("[UNK]");
      }
    }

    // Add special tokens
    const inputIds = [
      this.clsTokenId,
      ...tokens.slice(0, this.maxLength - 2).map((t) => this.vocab.get(t) ?? this.unkTokenId),
      this.sepTokenId,
    ];

    // Pad to maxLength
    const attentionMask = inputIds.map(() => 1);
    while (inputIds.length < this.maxLength) {
      inputIds.push(this.padTokenId);
      attentionMask.push(0);
    }

    return { inputIds, attentionMask };
  }

  decode(inputIds: number[]): string {
    return inputIds
      .map((id) => this.invVocab.get(id) ?? "[UNK]")
      .join(" ")
      .replace(/ ##/g, "")
      .replace(/\[CLS\]|\[SEP\]|\[PAD\]/g, "")
      .trim();
  }

  getVocabSize(): number {
    return this.vocab.size;
  }
}

// --- GLiNER ONNX Detector ---

export interface GlinerOnnxConfig extends DetectorConfig {
  /** Directory containing the ONNX model and tokenizer files. */
  modelDir: string;
  /** ONNX Runtime execution providers. Default: ["cpu"] */
  providers?: string[];
  /** Entity labels to detect. If empty, uses model's default labels. */
  labels?: string[];
  /** Confidence threshold for detections. Default: 0.5 */
  threshold?: number;
  /** Maximum text length. Default: 512 */
  maxLength?: number;
  /** Whether to use flat NMS (non-maximum suppression) for overlapping spans. Default: true */
  flatNms?: boolean;
  /** NMS threshold. Default: 0.5 */
  nmsThreshold?: number;
}

interface GlinerOutput {
  logits: Float32Array;
  // Hidden states if needed
}

interface TokenSpan {
  start: number;
  end: number;
  label: string;
  score: number;
}

/**
 * GLiNER ONNX detector for PII/NER.
 *
 * Loads a quantized GLiNER model and runs inference via ONNX Runtime.
 * Provides high-performance
 * optimized for CPU inference with INT8 quantization.
 */
export class GlinerOnnxDetector implements Detector {
  readonly name = "gliner-onnx";
  readonly description = "GLiNER Named Entity Recognition via ONNX Runtime (local, fast, private)";

  private _labels: string[] = [
    "PERSON",
    "EMAIL",
    "PHONE",
    "ADDRESS",
    "SSN",
    "CREDIT_CARD",
    "IBAN",
    "IP_ADDRESS",
    "URL",
    "DATE",
    "ORGANIZATION",
    "LOCATION",
    "ID_NUMBER",
    "PASSPORT",
    "DRIVER_LICENSE",
    "MEDICAL_RECORD",
    "BANK_ACCOUNT",
  ];

  get labels(): readonly string[] {
    return this._labels;
  }

  private session: InferenceSession | null = null;
  private tokenizer: SimpleTokenizer | null = null;
  private config: GlinerOnnxConfig;
  private initialized = false;

  constructor(config: GlinerOnnxConfig) {
    this.config = {
      providers: ["cpu"],
      threshold: 0.5,
      maxLength: 512,
      flatNms: true,
      nmsThreshold: 0.5,
      ...config,
    };
  }

  async initialize(config?: DetectorConfig): Promise<void> {
    if (this.initialized) return;

    const { InferenceSession } = await import("onnxruntime-node");

    const finalConfig = { ...this.config, ...config } as GlinerOnnxConfig;

    // Load tokenizer
    this.tokenizer = await SimpleTokenizer.load(finalConfig.modelDir);

    // Create inference session
    const modelPath = join(finalConfig.modelDir, "model.onnx");
    this.session = await InferenceSession.create(modelPath, {
      executionProviders: finalConfig.providers ?? ["cpu"],
      graphOptimizationLevel: "all",
      enableCpuMemArena: true,
      enableMemPattern: true,
    });

    // If custom labels provided, we may need to adjust
    if (finalConfig.labels && finalConfig.labels.length > 0) {
      this._labels = [...finalConfig.labels];
    }

    this.config = finalConfig;
    this.initialized = true;
  }

  isReady(): boolean {
    return this.initialized && this.session !== null && this.tokenizer !== null;
  }

  async shutdown(): Promise<void> {
    if (this.session) {
      await this.session.release();
      this.session = null;
    }
    this.tokenizer = null;
    this.initialized = false;
  }

  async detect(text: string, config?: DetectorConfig): Promise<DetectionResult> {
    const startTime = Date.now();

    if (!this.isReady()) {
      throw new Error("GLiNER detector not initialized. Call initialize() first.");
    }

    const finalConfig = { ...this.config, ...config } as GlinerOnnxConfig;
    const threshold = config?.threshold ?? finalConfig.threshold ?? 0.5;

    // Tokenize input
    const { inputIds, attentionMask } = this.tokenizer!.encode(text);

    // Prepare inputs for ONNX
    // GLiNER expects: input_ids, attention_mask, (labels)
    const batchSize = 1;
    const seqLen = inputIds.length;

    // Create input tensors
    const inputIdsTensor = new Tensor("int64", BigInt64Array.from(inputIds.map((x) => BigInt(x))), [batchSize, seqLen]);
    const attentionMaskTensor = new Tensor("int64", BigInt64Array.from(attentionMask.map((x) => BigInt(x))), [batchSize, seqLen]);

    // Run inference
    const feeds = {
      input_ids: inputIdsTensor,
      attention_mask: attentionMaskTensor,
    };

    const results = await this.session!.run(feeds);

    // Parse outputs
    // GLiNER output shape: [batch, seq_len, num_labels, 2] (start/end logits)
    // or [batch, seq_len, num_labels] for token classification
    const logits = results.logits as Tensor;
    const logitsData = logits.data as Float32Array;
    const dims = logits.dims; // [batch, seq_len, num_labels] or [batch, seq_len, num_labels, 2]

    const spans = this.parseLogits(logitsData, dims, text, finalConfig.labels ?? this.labels, threshold, finalConfig);

    // Apply NMS if enabled
    const finalSpans = finalConfig.flatNms !== false ? this.applyNMS(spans, finalConfig.nmsThreshold ?? 0.5) : spans;

    return {
      spans: finalSpans,
      latencyMs: Date.now() - startTime,
    };
  }

  /**
   * Parse model logits into detected spans.
   */
  private parseLogits(
    logits: Float32Array,
    dims: readonly number[],
    originalText: string,
    labels: readonly string[],
    threshold: number,
    config: GlinerOnnxConfig,
  ): DetectedSpan[] {
    const spans: DetectedSpan[] = [];

    // Expected dims: [batch=1, seq_len, num_labels, 2] for span-based
    // or [batch=1, seq_len, num_labels] for token classification
    // GLiNER typically outputs span logits: start and end for each label

    if (dims.length === 4 && dims[3] === 2) {
      // Span-based output: [1, seq_len, num_labels, 2]
      const [, seqLen, numLabels] = dims;
      for (let labelIdx = 0; labelIdx < numLabels; labelIdx++) {
        const label = labels[labelIdx] ?? `LABEL_${labelIdx}`;
        for (let start = 0; start < seqLen; start++) {
          const startLogit = logits[start * numLabels * 2 + labelIdx * 2];
          if (startLogit < threshold) continue;

          for (let end = start; end < seqLen; end++) {
            const endLogit = logits[end * numLabels * 2 + labelIdx * 2 + 1];
            const score = Math.min(startLogit, endLogit); // Conservative
            if (score >= threshold) {
              // Map token positions to character positions (approximate)
              const charSpan = this.tokenPosToCharPos(originalText, start, end, config.maxLength ?? 512);
              if (charSpan) {
                spans.push({
                  text: originalText.slice(charSpan.start, charSpan.end),
                  start: charSpan.start,
                  end: charSpan.end,
                  label,
                  score,
                  detectorName: this.name,
                });
              }
            }
          }
        }
      }
    } else if (dims.length === 3) {
      // Token classification output: [1, seq_len, num_labels]
      // BIO tagging - convert to spans
      const [, seqLen, numLabels] = dims;
      const labelMap = new Map<number, string>();
      for (let i = 0; i < labels.length && i < numLabels; i++) {
        labelMap.set(i, labels[i]);
      }

      let currentSpan: { label: string; start: number; end: number; scores: number[] } | null = null;

      for (let pos = 0; pos < seqLen; pos++) {
        // Find best label at this position
        let bestLabel = -1;
        let bestScore = -Infinity;
        for (let l = 0; l < numLabels; l++) {
          const score = logits[pos * numLabels + l];
          if (score > bestScore) {
            bestScore = score;
            bestLabel = l;
          }
        }

        const sigmoidScore = 1 / (1 + Math.exp(-bestScore));
        const label = labelMap.get(bestLabel) ?? `LABEL_${bestLabel}`;

        if (sigmoidScore >= threshold && label !== "O") {
          if (currentSpan && currentSpan.label === label) {
            currentSpan.end = pos + 1;
            currentSpan.scores.push(sigmoidScore);
          } else {
            if (currentSpan) {
              const charSpan = this.tokenPosToCharPos(originalText, currentSpan.start, currentSpan.end, config.maxLength ?? 512);
              if (charSpan) {
                spans.push({
                  text: originalText.slice(charSpan.start, charSpan.end),
                  start: charSpan.start,
                  end: charSpan.end,
                  label: currentSpan.label,
                  score: Math.min(...currentSpan.scores),
                  detectorName: this.name,
                });
              }
            }
            currentSpan = { label, start: pos, end: pos + 1, scores: [sigmoidScore] };
          }
        } else {
          if (currentSpan) {
            const charSpan = this.tokenPosToCharPos(originalText, currentSpan.start, currentSpan.end, config.maxLength ?? 512);
            if (charSpan) {
              spans.push({
                text: originalText.slice(charSpan.start, charSpan.end),
                start: charSpan.start,
                end: charSpan.end,
                label: currentSpan.label,
                score: Math.min(...currentSpan.scores),
                detectorName: this.name,
              });
            }
            currentSpan = null;
          }
        }
      }

      // Flush last span
      if (currentSpan) {
        const charSpan = this.tokenPosToCharPos(originalText, currentSpan.start, currentSpan.end, config.maxLength ?? 512);
        if (charSpan) {
          spans.push({
            text: originalText.slice(charSpan.start, charSpan.end),
            start: charSpan.start,
            end: charSpan.end,
            label: currentSpan.label,
            score: Math.min(...currentSpan.scores),
            detectorName: this.name,
          });
        }
      }
    }

    return spans;
  }

  /**
   * Approximate token position to character position mapping.
   * This is a simplified version; production should use offset mappings from tokenizer.
   */
  private tokenPosToCharPos(
    text: string,
    tokenStart: number,
    tokenEnd: number,
    maxLength: number,
  ): { start: number; end: number } | null {
    // Skip special tokens (CLS at 0, SEP at end)
    const contentStart = 1;
    const contentEnd = Math.min(text.split(/\s+/).length + 1, maxLength - 1);

    if (tokenStart < contentStart || tokenEnd > contentEnd) return null;

    // Very rough approximation: assume average token = 4 chars + 1 space
    const avgTokenLen = 5;
    const start = Math.min((tokenStart - contentStart) * avgTokenLen, text.length);
    const end = Math.min(start + (tokenEnd - tokenStart) * avgTokenLen, text.length);

    // Refine by finding word boundaries
    let refinedStart = start;
    while (refinedStart > 0 && /\w/.test(text[refinedStart - 1])) refinedStart--;
    let refinedEnd = end;
    while (refinedEnd < text.length && /\w/.test(text[refinedEnd])) refinedEnd++;

    if (refinedStart >= refinedEnd) return null;
    return { start: refinedStart, end: refinedEnd };
  }

  /**
   * Apply Non-Maximum Suppression to remove overlapping spans.
   */
  private applyNMS(spans: DetectedSpan[], iouThreshold: number): DetectedSpan[] {
    if (spans.length <= 1) return spans;

    // Sort by score descending
    spans.sort((a, b) => b.score - a.score);

    const keep: DetectedSpan[] = [];
    const suppressed = new Set<number>();

    for (let i = 0; i < spans.length; i++) {
      if (suppressed.has(i)) continue;
      keep.push(spans[i]);

      for (let j = i + 1; j < spans.length; j++) {
        if (suppressed.has(j)) continue;
        const iou = this.computeIOU(spans[i], spans[j]);
        if (iou > iouThreshold) {
          suppressed.add(j);
        }
      }
    }

    // Sort back by position
    keep.sort((a, b) => a.start - b.start);
    return keep;
  }

  /**
   * Compute Intersection over Union for two spans.
   */
  private computeIOU(a: DetectedSpan, b: DetectedSpan): number {
    const intersectionStart = Math.max(a.start, b.start);
    const intersectionEnd = Math.min(a.end, b.end);
    const intersection = Math.max(0, intersectionEnd - intersectionStart);
    const union = (a.end - a.start) + (b.end - b.start) - intersection;
    return union > 0 ? intersection / union : 0;
  }
}

/**
 * Factory for creating GLiNER ONNX detector.
 */
export async function createGlinerOnnxDetector(config: GlinerOnnxConfig): Promise<GlinerOnnxDetector> {
  const detector = new GlinerOnnxDetector(config);
  await detector.initialize(config);
  return detector;
}

/**
 * Download and prepare GLiNER model for ONNX Runtime.
 * This is a helper for setup; actual download requires network access.
 */
export async function prepareGlinerModel(
  modelId: "gliner-small-v2.1" | "gliner-multilingual-v2.1" | "gliner-pii-v1",
  outputDir: string,
): Promise<void> {
  const fs = await import("node:fs/promises");
  const { execa } = await import("execa");

  await fs.mkdir(outputDir, { recursive: true });

  // This would typically use optimum-cli to export from Hugging Face
  // Example: optimum-cli export onnx --model urchade/gliner_small-v2.1 --task token-classification ./model_dir
  // For now, document the steps
  console.log(`To prepare ${modelId} ONNX model:`);
  console.log(`1. Install optimum: pip install optimum[onnx]`);
  console.log(`2. Run: optimum-cli export onnx --model urchade/${modelId} --task token-classification ${outputDir}`);
  console.log(`3. Quantize: optimum-cli quantize --onnx-model ${outputDir}/model.onnx --quantization dynamic ${outputDir}/model_int8.onnx`);
}