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

    try {
      // Load tokenizer from model directory using Hugging Face tokenizers
      // This provides accurate offset mappings for token-to-character conversion
      const tokenizers = await import("@huggingface/tokenizers");
      const { join } = await import("node:path");
      const fs = await import("node:fs/promises");

      const modelDir = this.config.modelDir;

      console.error(`[gliner] Initializing GLiNER detector with modelDir: ${modelDir}`);

      // Validate model directory exists and has required files
      if (!modelDir) {
        throw new Error("GLiNER detector requires modelDir to be configured");
      }

      const tokenizerConfigPath = join(modelDir, "tokenizer_config.json");
      const tokenizerJsonPath = join(modelDir, "tokenizer.json");
      const onnxPath = join(modelDir, "model.onnx");

      // Check for tokenizer.json (modern format with complete tokenizer state)
      let hasTokenizerJson = false;
      try {
        await fs.access(tokenizerJsonPath);
        hasTokenizerJson = true;
      } catch {}

      // Validate required files exist
      for (const [filePath, fileName] of [
        [tokenizerConfigPath, "tokenizer_config.json"],
        [onnxPath, "model.onnx"],
      ] as const) {
        try {
          await fs.access(filePath);
          console.error(`[gliner] Found model file: ${fileName}`);
        } catch {
          throw new Error(
            `GLiNER model file not found: ${fileName} in ${modelDir}. ` +
              `Download a GLiNER ONNX model (e.g., gliner-base) and set detectorConfig.modelPath to its directory.`
          );
        }
      }

      // Read tokenizer config to determine tokenizer class
      const tokenizerConfig = JSON.parse(await fs.readFile(tokenizerConfigPath, "utf8"));
      console.error(`[gliner] tokenizer_class: ${tokenizerConfig.tokenizer_class}`);

      // Try tokenizer.json first (complete tokenizer state)
      if (hasTokenizerJson) {
        console.error("[gliner] Found tokenizer.json, reconstructing tokenizer...");
        try {
          const tokenizerJson = JSON.parse(await fs.readFile(tokenizerJsonPath, "utf8"));
          console.error("[gliner] tokenizer.json keys:", Object.keys(tokenizerJson));
          console.error("[gliner] tokenizer.json model:", JSON.stringify(tokenizerJson.model ?? null).slice(0, 200));

          if (tokenizerJson.model) {
            console.error("[gliner] model type:", tokenizerJson.model.type);

            if (tokenizerJson.model.type === "Unigram") {
              // Reconstruct Unigram model from vocab data
              console.error("[gliner] Unigram vocab size:", tokenizerJson.model.vocab?.length ?? "none");

              // Create Unigram model from vocab
              // vocab is array of [token, score] pairs
              const vocab = tokenizerJson.model.vocab;
              if (!vocab || vocab.length === 0) {
                throw new Error("Unigram vocab is empty");
              }

              // Convert to the format expected by Unigram: record<string, number> or Map
              const vocabMap = new Map<string, number>();
              for (const [token, score] of vocab) {
                vocabMap.set(token, score);
              }

              const Unigram = (tokenizers as any).Unigram;
              if (!Unigram) throw new Error("[gliner] Unigram export not found");

              // Create Unigram model directly from vocab
              const model = new Unigram(vocabMap, tokenizerJson.model.unk_id ?? 3);
              this.tokenizer = new tokenizers.Tokenizer(model);
              console.error("[gliner] Unigram tokenizer created from tokenizer.json vocab");
            } else if (tokenizerJson.model.type === "BPE") {
              // BPE model - needs vocab and merges
              console.error("[gliner] BPE vocab size:", tokenizerJson.model.vocab?.length ?? "none");
              throw new Error("BPE reconstruction not yet implemented");
            } else {
              throw new Error(`Unsupported model type in tokenizer.json: ${tokenizerJson.model.type}`);
            }

            // Note: In tokenizers v0.1.x, normalizer/preTokenizer/decoder/postProcessor
            // are typically already baked into the tokenizer when loaded from tokenizer.json
            // via the model. The manual application requires specific class constructors
            // which may not match the JSON structure. Since we can't easily reconstruct
            // them from JSON, we'll rely on the basic tokenizer which should work for GLiNER.
            console.error("[gliner] Tokenizer created from tokenizer.json (basic - advanced components not applied)");

            hasTokenizerJson = true;
          } else {
            throw new Error("tokenizer.json missing model field");
          }
        } catch (e) {
          console.error("[gliner] Failed to load from tokenizer.json:", e instanceof Error ? e.message : String(e));
          console.error("[gliner] Falling back to manual construction...");
          hasTokenizerJson = false;
        }
      }

      // Fallback: manual construction from tokenizer_config.json
      if (!hasTokenizerJson) {
        // Build tokenizer based on tokenizer_class
        if (tokenizerConfig.tokenizer_class === "DebertaV2Tokenizer" ||
            tokenizerConfig.tokenizer_class === "BertTokenizer" ||
            tokenizerConfig.tokenizer_class === "BertTokenizerFast") {
          // BERT-style WordPiece tokenizer - try vocab.txt first, fall back to spm.model
          const vocabPath = join(modelDir, "vocab.txt");
          const spmPath = join(modelDir, "spm.model");
          let vocabExists = false;
          let spmExists = false;
          try { await fs.access(vocabPath); vocabExists = true; } catch {}
          try { await fs.access(spmPath); spmExists = true; } catch {}

          if (vocabExists) {
            const BertWordPieceTokenizer = (tokenizers as any).BertWordPieceTokenizer;
            if (!BertWordPieceTokenizer) {
              throw new Error("[gliner] BertWordPieceTokenizer export not found");
            }
            this.tokenizer = new BertWordPieceTokenizer(vocabPath, {
              lowercase: tokenizerConfig.do_lower_case ?? false,
            });
            console.error("[gliner] BertWordPieceTokenizer created from vocab.txt");
          } else if (spmExists) {
            // DeBERTa v2 with SentencePiece
            const Unigram = (tokenizers as any).Unigram;
            if (!Unigram) {
              throw new Error("[gliner] Unigram export not found");
            }
            const model = new Unigram(spmPath);
            this.tokenizer = new tokenizers.Tokenizer(model);
            console.error("[gliner] Unigram tokenizer created from spm.model (DeBERTa v2 SentencePiece)");
          } else {
            throw new Error(`Neither vocab.txt nor spm.model found for BERT-style tokenizer in ${modelDir}`);
          }
        } else if (tokenizerConfig.tokenizer_class === "UnigramTokenizer" ||
                   tokenizerConfig.tokenizer_class === "XLMRobertaTokenizer") {
          // SentencePiece-based tokenizer
          const spmPath = join(modelDir, "spm.model");
          try {
            await fs.access(spmPath);
            const Unigram = (tokenizers as any).Unigram;
            if (!Unigram) {
              throw new Error("[gliner] Unigram export not found");
            }
            const model = new Unigram(spmPath);
            this.tokenizer = new tokenizers.Tokenizer(model);
            console.error("[gliner] Unigram tokenizer created");
          } catch {
            throw new Error(`spm.model not found for SentencePiece tokenizer in ${modelDir}`);
          }
        } else {
          throw new Error(`Unsupported tokenizer_class: ${tokenizerConfig.tokenizer_class}`);
        }
      }

      // Configure tokenizer for GLiNER
      console.error("[gliner] Configuring truncation/padding...");
      this.tokenizer.enableTruncation(this.config.maxLength ?? 512);
      this.tokenizer.enablePadding({
        length: this.config.maxLength ?? 512,
        padId: this.tokenizer.getVocabulary().get("[PAD]") ?? 0,
        padToken: "[PAD]",
      });
      console.error("[gliner] Truncation/padding configured");

    // Create inference session
    console.error("[gliner] Creating ONNX inference session...");
    const InferenceSession = (await import("onnxruntime-node")).InferenceSession;
    const onnxModelPath = join(this.config.modelDir, "model.onnx");
    console.error("[gliner] ONNX model path:", onnxModelPath);
    this.session = await InferenceSession.create(onnxModelPath, {
      executionProviders: this.config.providers ?? ["cpu"],
      graphOptimizationLevel: "all",
      enableCpuMemArena: true,
      enableMemPattern: true,
    });
    console.error("[gliner] ONNX session created successfully");

    // If custom labels provided, use them
    if (this.config.labels && this.config.labels.length > 0) {
      this._labels = [...this.config.labels];
    }

    this.initialized = true;
  } catch (err) {
    console.error("[gliner] INITIALIZATION FAILED:", err);
    if (err instanceof Error) {
      console.error("[gliner] Stack:", err.stack);
    }
    throw err;
  }
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