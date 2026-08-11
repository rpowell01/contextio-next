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

import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { InferenceSession, Tensor } from "onnxruntime-node";

import type {
  Detector,
  DetectorConfig,
  DetectionResult,
  DetectedSpan,
} from "./detector.js";

const __dirname = join(fileURLToPath(import.meta.url), "..");

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
  /** Maximum text length (tokens). Default: 512 */
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
 * Uses Hugging Face tokenizers for accurate token-to-character position mapping.
 * Provides high-performance local inference optimized for CPU with INT8 quantization.
 */
export class GlinerOnnxDetector implements Detector {
  readonly name = "gliner-onnx";
  readonly description =
    "GLiNER Named Entity Recognition via ONNX Runtime (local, fast, private)";

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
  private tokenizer: any = null;
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

    // Validate model directory exists and has required files
    const { join } = await import("node:path");
    const fs = await import("node:fs/promises");

    const modelDir = this.config.modelDir;
    if (!modelDir) {
      throw new Error("GLiNER detector requires modelDir to be configured");
    }

    const tokenizerJsonPath = join(modelDir, "tokenizer.json");
    const tokenizerConfigPath = join(modelDir, "tokenizer_config.json");
    const spmPath = join(modelDir, "spm.model");
    const modelPath = join(modelDir, "model.onnx");

    for (const [filePath, fileName] of [
      [tokenizerJsonPath, "tokenizer.json"],
      [tokenizerConfigPath, "tokenizer_config.json"],
      [spmPath, "spm.model"],
      [modelPath, "model.onnx"],
    ] as const) {
      try {
        await fs.access(filePath);
      } catch {
        throw new Error(
          `GLiNER model file not found: ${fileName} in ${modelDir}. ` +
            `Ensure the model directory contains tokenizer.json, tokenizer_config.json, spm.model, and model.onnx.`
        );
      }
    }

    // Load tokenizer from model directory using Hugging Face tokenizers
    // This provides accurate offset mappings for token-to-character conversion
    // For tokenizers v0.1.x, we reconstruct Unigram from tokenizer.json vocab
    console.error("[gliner] Importing @huggingface/tokenizers");
    const tokenizers = await import("@huggingface/tokenizers");
    console.error("[gliner] tokenizers exports:", Object.keys(tokenizers).filter(k => !k.startsWith("_")));

    // Read tokenizer.json to get Unigram vocab
    console.error("[gliner] Reading tokenizer.json");
    const tokenizerJson = JSON.parse(await fs.readFile(tokenizerJsonPath, "utf8"));
    console.error("[gliner] tokenizer.json model type:", tokenizerJson.model?.type);

    // Read tokenizer config to get special tokens
    console.error("[gliner] Reading tokenizer_config.json");
    const tokenizerConfig = JSON.parse(await fs.readFile(tokenizerConfigPath, "utf8"));
    console.error("[gliner] tokenizer_config:", JSON.stringify(tokenizerConfig).slice(0, 200));

    // Reconstruct Unigram model from tokenizer.json vocab
    // tokenizers v0.1.x Unigram constructor expects vocab object {token: score}
    if (tokenizerJson.model && tokenizerJson.model.type === "Unigram") {
      const vocab = tokenizerJson.model.vocab;
      console.error(`[gliner] Unigram vocab length: ${vocab?.length ?? "undefined"}`);
      if (!vocab || vocab.length === 0) {
        throw new Error("Unigram vocab is empty in tokenizer.json");
      }

      // Convert vocab array [token, score] to object {token => score}
      const vocabObj: Record<string, number> = {};
      let validCount = 0;
      vocab.forEach((entry: unknown) => {
        if (Array.isArray(entry) && entry.length >= 2 && typeof entry[0] === "string" && typeof entry[1] === "number") {
          vocabObj[entry[0]] = entry[1];
          validCount++;
        }
      });
      console.error(`[gliner] Valid Unigram vocab entries: ${validCount}/${vocab.length}`);
      if (validCount === 0) {
        throw new Error("No valid vocab entries found in tokenizer.json");
      }

      console.error("[gliner] Creating Unigram from vocab object");
      const Unigram = (tokenizers as any).Unigram;
      console.error("[gliner] Unigram constructor:", typeof Unigram);
      const model = new Unigram(vocabObj);
      console.error("[gliner] Unigram model created:", !!model);
      this.tokenizer = new tokenizers.Tokenizer(model);
      console.error("[gliner] Tokenizer created:", !!this.tokenizer);
    } else {
      throw new Error(`Unsupported tokenizer type: ${tokenizerJson.model?.type}. Expected Unigram for GLiNER model.`);
    }

    // Add normalizer (BERT-style)
    const BertNormalizer = (tokenizers as any).BertNormalizer;
    this.tokenizer.normalizer = new BertNormalizer({
      cleanText: true,
      handleChineseChars: true,
      stripAccents: false,
      lowercase: false,
    });

    // Add pre-tokenizer (WhitespaceSplit for SentencePiece)
    const WhitespaceSplitPreTokenizer = (tokenizers as any).WhitespaceSplitPreTokenizer;
    this.tokenizer.preTokenizer = new WhitespaceSplitPreTokenizer();

    // Add decoder (Unigram uses Metaspace)
    const MetaspaceDecoder = (tokenizers as any).MetaspaceDecoder;
    this.tokenizer.decoder = new MetaspaceDecoder();

    // Add post-processor for special tokens (bert-style)
    const specialTokens = [
      ["[CLS]", tokenizerConfig.cls_token ?? "[CLS]"],
      ["[SEP]", tokenizerConfig.sep_token ?? "[SEP]"],
      ["[PAD]", tokenizerConfig.pad_token ?? "[PAD]"],
      ["[UNK]", tokenizerConfig.unk_token ?? "[UNK]"],
      ["[MASK]", tokenizerConfig.mask_token ?? "[MASK]"],
      ["<<ENT>>", "<<ENT>>"],
      ["<<SEP>>", "<<SEP>>"],
    ];
    const TemplateProcessingPostProcessor = (tokenizers as any).TemplateProcessingPostProcessor;
    // specialTokens format: array of [token, id] pairs for tokenizers v0.1.x
    const specialTokensForProcessor = specialTokens.map(([id, token]) => [token, id]);
    this.tokenizer.postProcessor = new TemplateProcessingPostProcessor({
      single: "[CLS] $A [SEP]",
      pair: "[CLS] $A [SEP] $B [SEP]",
      specialTokens: specialTokensForProcessor,
    });

    // Configure tokenizer for GLiNER
    this.tokenizer.enableTruncation(this.config.maxLength ?? 512);
    this.tokenizer.enablePadding({
      length: this.config.maxLength ?? 512,
      padId: this.tokenizer.getVocabulary().get("[PAD]") ?? 0,
      padToken: "[PAD]",
    });

    // Create inference session
    const InferenceSession = (await import("onnxruntime-node")).InferenceSession;
    this.session = await InferenceSession.create(modelPath, {
      executionProviders: this.config.providers ?? ["cpu"],
      graphOptimizationLevel: "all",
      enableCpuMemArena: true,
      enableMemPattern: true,
    });

    // If custom labels provided, use them
    if (this.config.labels && this.config.labels.length > 0) {
      this._labels = [...this.config.labels];
    }

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

    // Tokenize input with offset mappings for accurate position tracking
    const encoding = this.tokenizer!.encode(text);
    const inputIds = encoding.ids;
    const attentionMask = encoding.attention_mask;
    const offsets = encoding.offsets; // Array of [start, end] character positions for each token

    // Prepare inputs for ONNX
    // GLiNER expects: input_ids, attention_mask
    const batchSize = 1;
    const seqLen = inputIds.length;

    // Create input tensors
    const inputIdsTensor = new Tensor(
      "int64",
      BigInt64Array.from(inputIds.map((x: number) => BigInt(x))),
      [batchSize, seqLen],
    );
    const attentionMaskTensor = new Tensor(
      "int64",
      BigInt64Array.from(attentionMask.map((x: number) => BigInt(x))),
      [batchSize, seqLen],
    );

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

    const spans = this.parseLogits(
      logitsData,
      dims,
      text,
      offsets,
      finalConfig.labels ?? this.labels,
      threshold,
      finalConfig,
    );

    // Apply NMS if enabled
    const finalSpans =
      finalConfig.flatNms !== false
        ? this.applyNMS(spans, finalConfig.nmsThreshold ?? 0.5)
        : spans;

    return {
      spans: finalSpans,
      latencyMs: Date.now() - startTime,
    };
  }

  /**
   * Parse model logits into detected spans using precise offset mappings from tokenizer.
   */
  private parseLogits(
    logits: Float32Array,
    dims: readonly number[],
    originalText: string,
    offsets: Array<[number, number]>,
    labels: readonly string[],
    threshold: number,
    config: GlinerOnnxConfig,
  ): DetectedSpan[] {
    const spans: DetectedSpan[] = [];

    // Expected dims: [batch=1, seq_len, num_labels] for token classification
    // or [batch=1, seq_len, num_labels, 2] for span-based
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
              // Map token positions to character positions using offset mappings
              const charSpan = this.tokenPosToCharPos(offsets, start, end + 1);
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
              const charSpan = this.tokenPosToCharPos(offsets, currentSpan.start, currentSpan.end);
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
            const charSpan = this.tokenPosToCharPos(offsets, currentSpan.start, currentSpan.end);
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
        const charSpan = this.tokenPosToCharPos(offsets, currentSpan.start, currentSpan.end);
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
   * Convert token positions to character positions using tokenizer offset mappings.
   * Returns the character span [start, end) for the given token range.
   */
  private tokenPosToCharPos(
    offsets: Array<[number, number]>,
    tokenStart: number,
    tokenEnd: number, // exclusive
  ): { start: number; end: number } | null {
    // Validate token range
    if (tokenStart >= offsets.length || tokenEnd > offsets.length || tokenStart >= tokenEnd) {
      return null;
    }

    const startOffset = offsets[tokenStart]?.[0];
    const endOffset = offsets[tokenEnd - 1]?.[1];

    if (startOffset === undefined || endOffset === undefined || startOffset >= endOffset) {
      return null;
    }

    return { start: startOffset, end: endOffset };
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
  console.log(`4. Ensure tokenizer files (vocab.txt, tokenizer_config.json, special_tokens_map.json) are in ${outputDir}`);
}