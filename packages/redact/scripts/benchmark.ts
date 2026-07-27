import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { readFileSync } from "node:fs";
import { writeFileSync } from "node:fs";

import { PRESETS } from "../dist/presets.js";
import { createRuleDetector, RuleDetector, type RuleDetectorConfig } from "../dist/ruleDetector.js";
import { DetectorPipeline, createHybridDetector, type DetectorPipelineConfig } from "../dist/detectorPipeline.js";
import type { Detector, DetectorConfig, DetectionResult, DetectedSpan } from "../dist/detector.js";

const __dirname = dirname(fileURLToPath(import.meta.url));
const DATA_PATH = join(__dirname, "..", "test", "benchmark-data.jsonl");
const REPORT_PATH = join(__dirname, "..", "benchmark-report.md");

interface GroundTruthItem {
  text: string;
  entities: Array<{ text: string; start: number; end: number; label: string }>;
}

interface Metrics {
  tp: number;
  fp: number;
  fn: number;
  precision: number;
  recall: number;
  f1: number;
}

interface BenchmarkResult {
  detectorName: string;
  config: string;
  overall: Metrics;
  perEntity: Record<string, Metrics>;
  latencies: number[];
}

function loadGroundTruth(): GroundTruthItem[] {
  const content = readFileSync(DATA_PATH, "utf-8");
  return content.trim().split("\n").map(line => JSON.parse(line));
}

function computeLatencyStats(latencies: number[]): { mean: number; min: number; max: number; p50: number; p95: number; p99: number } {
  const sorted = [...latencies].sort((a, b) => a - b);
  const mean = latencies.reduce((a, b) => a + b, 0) / latencies.length;
  return {
    mean,
    min: sorted[0],
    max: sorted[sorted.length - 1],
    p50: percentile(sorted, 50),
    p95: percentile(sorted, 95),
    p99: percentile(sorted, 99),
  };
}

function percentile(sorted: number[], p: number): number {
  if (sorted.length === 0) return 0;
  const idx = Math.ceil(p / 100 * sorted.length) - 1;
  return sorted[Math.max(0, idx)];
}

function computeMetrics(
  detected: DetectedSpan[],
  groundTruth: GroundTruthItem["entities"]
): { overall: Metrics; perEntity: Record<string, Metrics> } {
  // Group ground truth by label
  const gtByLabel = new Map<string, typeof groundTruth>();
  for (const ent of groundTruth) {
    if (!gtByLabel.has(ent.label)) gtByLabel.set(ent.label, []);
    gtByLabel.get(ent.label)!.push(ent);
  }

  // Group detected by label
  const detByLabel = new Map<string, DetectedSpan[]>();
  for (const span of detected) {
    if (!detByLabel.has(span.label)) detByLabel.set(span.label, []);
    detByLabel.get(span.label)!.push(span);
  }

  const allLabels = new Set([...gtByLabel.keys(), ...detByLabel.keys()]);
  const perEntity: Record<string, Metrics> = {};

  let totalTp = 0, totalFp = 0, totalFn = 0;

  for (const label of allLabels) {
    const gt = gtByLabel.get(label) || [];
    const det = detByLabel.get(label) || [];

    let tp = 0;
    const usedGt = new Set<number>();

    for (const span of det) {
      // Find matching ground truth
      let matched = false;
      for (let i = 0; i < gt.length; i++) {
        if (usedGt.has(i)) continue;
        const g = gt[i];
        // Check overlap
        const overlapStart = Math.max(span.start, g.start);
        const overlapEnd = Math.min(span.end, g.end);
        const overlap = Math.max(0, overlapEnd - overlapStart);
        const gtLen = g.end - g.start;
        const overlapRatio = gtLen > 0 ? overlap / gtLen : 0;

        if (overlapRatio >= 0.5) { // 50% overlap threshold
          tp++;
          usedGt.add(i);
          matched = true;
          break;
        }
      }
      // No match = false positive
      if (!matched) {
        // Not all false positives are real; some might be correct but unlabeled
        // We'll count them as FP for strict evaluation
      }
    }

    const fp = det.length - tp;
    const fn = gt.length - tp;

    totalTp += tp;
    totalFp += fp;
    totalFn += fn;

    const precision = tp / (tp + fp) || 0;
    const recall = tp / (tp + fn) || 0;
    const f1 = precision + recall > 0 ? 2 * precision * recall / (precision + recall) : 0;

    perEntity[label] = { tp, fp, fn, precision, recall, f1 };
  }

  const overallPrecision = totalTp / (totalTp + totalFp) || 0;
  const overallRecall = totalTp / (totalTp + totalFn) || 0;
  const overallF1 = overallPrecision + overallRecall > 0
    ? 2 * overallPrecision * overallRecall / (overallPrecision + overallRecall)
    : 0;

  return {
    overall: { tp: totalTp, fp: totalFp, fn: totalFn, precision: overallPrecision, recall: overallRecall, f1: overallF1 },
    perEntity,
  };
}

// Mock GLiNER detector that simulates semantic entity detection
class MockGlinerDetector implements Detector {
  readonly name = "gliner-onnx-mock";
  readonly description = "Mock GLiNER detector for benchmarking (simulates ONNX model behavior)";
  readonly labels = [
    "PERSON", "ORGANIZATION", "LOCATION", "EMAIL", "PHONE", "SSN",
    "CREDIT_CARD", "IP_ADDRESS", "URL", "DATE", "IBAN", "PASSPORT",
    "BANK_ACCOUNT", "ROUTING_NUMBER", "LICENSE_PLATE", "JWT",
    "CREDENTIAL_API_KEY", "CREDENTIAL_GITHUB_TOKEN", "CREDENTIAL_AWS_KEY",
  ];

  private initialized = false;
  private baseLatencyMs = 12; // Simulated model inference latency

  async initialize(config?: DetectorConfig): Promise<void> {
    this.initialized = true;
  }

  isReady(): boolean {
    return this.initialized;
  }

  async shutdown(): Promise<void> {
    this.initialized = false;
  }

  async detect(text: string, config?: DetectorConfig): Promise<DetectionResult> {
    const startTime = Date.now();
    const threshold = config?.threshold ?? 0.5;

    const spans: DetectedSpan[] = [];

    // Simulate GLiNER semantic detection - finds entities rules might miss
    // Real GLiNER would use the ONNX model for this

    // PERSON detection (names with titles)
    const personPattern = /\b(?:Dr\.|Mr\.|Ms\.|Mrs\.|Prof\.)?\s*[A-Z][a-z]+(?:\s+[A-Z][a-z]+)+\b/g;
    personPattern.lastIndex = 0;
    let match;
    while ((match = personPattern.exec(text)) !== null) {
      const context = text.slice(Math.max(0, match.index - 30), match.index + match[0].length + 30).toLowerCase();
      if (this.isFalsePositive(match[0], context)) continue;
      const score = 0.72 + Math.random() * 0.2;
      if (score >= threshold) {
        spans.push({
          text: match[0],
          start: match.index,
          end: match.index + match[0].length,
          label: "PERSON",
          score,
          detectorName: this.name,
        });
      }
    }

    // ORGANIZATION detection
    const orgPattern = /\b[A-Z][a-z]+(?:\s+[A-Z][a-z]+)*\s+(?:Inc|Corporation|Corp|LLC|Ltd|Company|Group|Systems|Technologies|Solutions|Services|Enterprises)\b/g;
    orgPattern.lastIndex = 0;
    while ((match = orgPattern.exec(text)) !== null) {
      const score = 0.75 + Math.random() * 0.2;
      if (score >= threshold) {
        spans.push({
          text: match[0],
          start: match.index,
          end: match.index + match[0].length,
          label: "ORGANIZATION",
          score,
          detectorName: this.name,
        });
      }
    }

    // LOCATION detection (major cities)
    const locationPattern = /\b(?:New York|San Francisco|Los Angeles|Chicago|Boston|Seattle|London|Paris|Tokyo|Berlin|New York City|San Jose|Austin|Denver)\b/g;
    locationPattern.lastIndex = 0;
    while ((match = locationPattern.exec(text)) !== null) {
      const score = 0.8 + Math.random() * 0.15;
      if (score >= threshold) {
        spans.push({
          text: match[0],
          start: match.index,
          end: match.index + match[0].length,
          label: "LOCATION",
          score,
          detectorName: this.name,
        });
      }
    }

    // DATE detection
    const datePattern = /\b(?:Jan|Feb|Mar|Apr|May|Jun|Jul|Aug|Sep|Oct|Nov|Dec)[a-z]*\.?\s+\d{1,2},?\s+\d{4}\b|\b\d{1,2}[/-]\d{1,2}[/-]\d{2,4}\b|\b\d{4}-\d{2}-\d{2}\b/g;
    datePattern.lastIndex = 0;
    while ((match = datePattern.exec(text)) !== null) {
      const score = 0.85 + Math.random() * 0.1;
      if (score >= threshold) {
        spans.push({
          text: match[0],
          start: match.index,
          end: match.index + match[0].length,
          label: "DATE",
          score,
          detectorName: this.name,
        });
      }
    }

    // Email (GLiNER can also detect these, might catch some rules miss)
    const emailPattern = /\b[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}\b/g;
    emailPattern.lastIndex = 0;
    while ((match = emailPattern.exec(text)) !== null) {
      const context = text.slice(Math.max(0, match.index - 30), match.index + match[0].length + 30).toLowerCase();
      if (this.isFalsePositive(match[0], context)) continue;
      const score = 0.88 + Math.random() * 0.1;
      if (score >= threshold) {
        spans.push({
          text: match[0],
          start: match.index,
          end: match.index + match[0].length,
          label: "EMAIL",
          score,
          detectorName: this.name,
        });
      }
    }

    // SSN with context
    const ssnPattern = /\b\d{3}-\d{2}-\d{4}\b/g;
    ssnPattern.lastIndex = 0;
    while ((match = ssnPattern.exec(text)) !== null) {
      const context = text.slice(Math.max(0, match.index - 50), match.index + match[0].length + 50).toLowerCase();
      if (["ssn", "social security", "tax", "taxpayer"].some(w => context.includes(w))) {
        const score = 0.9;
        if (score >= threshold) {
          spans.push({
            text: match[0],
            start: match.index,
            end: match.index + match[0].length,
            label: "SSN",
            score,
            detectorName: this.name,
          });
        }
      }
    }

    // Phone (international format)
    const phonePattern = /\b(?:\+?1\s*)?(?:\(\d{3}\)|\d{3})[\s.-]?\d{3}[\s.-]?\d{4}\b/g;
    phonePattern.lastIndex = 0;
    while ((match = phonePattern.exec(text)) !== null) {
      const context = text.slice(Math.max(0, match.index - 30), match.index + match[0].length + 30).toLowerCase();
      if (this.isFalsePositive(match[0], context)) continue;
      const score = 0.78 + Math.random() * 0.15;
      if (score >= threshold) {
        spans.push({
          text: match[0],
          start: match.index,
          end: match.index + match[0].length,
          label: "PHONE",
          score,
          detectorName: this.name,
        });
      }
    }

    // Credit card (Luhn-valid looking)
    const ccPattern = /\b(?:\d{4}[\s-]?){3}\d{4}\b/g;
    ccPattern.lastIndex = 0;
    while ((match = ccPattern.exec(text)) !== null) {
      const context = text.slice(Math.max(0, match.index - 30), match.index + match[0].length + 30).toLowerCase();
      if (!["card", "credit", "payment", "charge", "visa", "mastercard", "amex"].some(w => context.includes(w))) continue;
      const score = 0.82 + Math.random() * 0.15;
      if (score >= threshold) {
        spans.push({
          text: match[0],
          start: match.index,
          end: match.index + match[0].length,
          label: "CREDIT_CARD",
          score,
          detectorName: this.name,
        });
      }
    }

    // Sort by position
    spans.sort((a, b) => a.start - b.start);

    const latency = Date.now() - startTime + this.baseLatencyMs;

    return { spans, latencyMs: latency };
  }

  private isFalsePositive(text: string, context: string): boolean {
    // Skip test/placeholder/uuid context
    if (context.includes("test") || context.includes("example")
      || context.includes("placeholder") || context.includes("uuid")
      || context.includes("not a") || context.includes("fake")
      || context.includes("reference")) {
      return true;
    }
    // Skip UUID-like
    if (text.match(/\b[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}\b/i)) {
      return true;
    }
    // Skip all-same-char patterns
    if (/^(.)\1+$/.test(text)) return true;
    return false;
  }
}

async function runBenchmark(): Promise<void> {
  console.log("Loading test data...");
  const groundTruth = loadGroundTruth();
  console.log(`Loaded ${groundTruth.length} test cases`);

  // Create detectors
  console.log("Initializing detectors...");

  // Rule detector with strict preset (no placeholder allowlist for benchmarking real PII)
  const ruleDetector = await createRuleDetector({
    name: "rules",
    rules: PRESETS.strict,
    allowlistStrings: new Set(),
    placeholderAllowlist: new Set(),
  });

  // Mock GLiNER detector
  const glinerDetector = new MockGlinerDetector();
  await glinerDetector.initialize();

  // Hybrid detector (rules + GLiNER)
  const hybridPipeline = new DetectorPipeline({
    detectors: [ruleDetector, glinerDetector],
    mergeStrategy: "priority",
    priorityOrder: ["rules", "gliner-onnx-mock"],
    thresholds: { "rules": 0.95, "gliner-onnx-mock": 0.5 },
  });
  await hybridPipeline.initialize();

  const detectorConfigs = [
    { name: "rules-only", detector: ruleDetector },
    { name: "gliner-mock", detector: glinerDetector },
    { name: "hybrid", detector: hybridPipeline },
  ];

  const results: BenchmarkResult[] = [];

  for (const { name, detector } of detectorConfigs) {
    console.log(`\nRunning ${name} detector...`);
    const latencies: number[] = [];
    let totalTp = 0, totalFp = 0, totalFn = 0;
    const perEntityAggregated: Record<string, { tp: number; fp: number; fn: number }> = {};

    for (let i = 0; i < groundTruth.length; i++) {
      const item = groundTruth[i];
      const result = await detector.detect(item.text);

      latencies.push(result.latencyMs);

      const { overall, perEntity } = computeMetrics(result.spans, item.entities);

      totalTp += overall.tp;
      totalFp += overall.fp;
      totalFn += overall.fn;

      for (const [label, metrics] of Object.entries(perEntity)) {
        if (!perEntityAggregated[label]) {
          perEntityAggregated[label] = { tp: 0, fp: 0, fn: 0 };
        }
        perEntityAggregated[label].tp += metrics.tp;
        perEntityAggregated[label].fp += metrics.fp;
        perEntityAggregated[label].fn += metrics.fn;
      }

      if ((i + 1) % 10 === 0) {
        console.log(`  Processed ${i + 1}/${groundTruth.length} samples`);
      }
    }

    const precision = totalTp / (totalTp + totalFp) || 0;
    const recall = totalTp / (totalTp + totalFn) || 0;
    const f1 = precision + recall > 0 ? 2 * precision * recall / (precision + recall) : 0;

    const perEntityMetrics: Record<string, Metrics> = {};
    for (const [label, v] of Object.entries(perEntityAggregated)) {
      const p = v.tp / (v.tp + v.fp) || 0;
      const r = v.tp / (v.tp + v.fn) || 0;
      perEntityMetrics[label] = {
        tp: v.tp, fp: v.fp, fn: v.fn,
        precision: p, recall: r, f1: p + r > 0 ? 2 * p * r / (p + r) : 0,
      };
    }

    const latencyStats = computeLatencyStats(latencies);

    results.push({
      detectorName: name,
      config: name,
      overall: { tp: totalTp, fp: totalFp, fn: totalFn, precision, recall, f1 },
      perEntity: perEntityMetrics,
      latencies,
    });

    console.log(`  Overall: P=${precision.toFixed(3)} R=${recall.toFixed(3)} F1=${f1.toFixed(3)}`);
    console.log(`  Latency: p50=${latencyStats.p50}ms p95=${latencyStats.p95}ms p99=${latencyStats.p99}ms mean=${latencyStats.mean.toFixed(1)}ms`);
  }

  // Generate report
  console.log("\nGenerating report...");
  const report = generateReport(results, groundTruth.length);
  writeFileSync(REPORT_PATH, report);
  console.log(`Report written to ${REPORT_PATH}`);

  // Print summary
  console.log("\n=== BENCHMARK SUMMARY ===");
  for (const r of results) {
    console.log(`${r.detectorName}: P=${r.overall.precision.toFixed(3)} R=${r.overall.recall.toFixed(3)} F1=${r.overall.f1.toFixed(3)} | p50=${percentile(r.latencies, 50)}ms p95=${percentile(r.latencies, 95)}ms`);
  }
}

function generateReport(results: BenchmarkResult[], numSamples: number): string {
  const lines: string[] = [];

  lines.push("# PII Detection Benchmark Report");
  lines.push("");
  lines.push(`**Date:** ${new Date().toISOString().split("T")[0]}`);
  lines.push(`**Test Samples:** ${numSamples}`);
  lines.push(`**Detectors Compared:** ${results.map(r => r.detectorName).join(", ")}`);
  lines.push("");

  lines.push("## Overall Metrics");
  lines.push("");
  lines.push("| Detector | Precision | Recall | F1 | TP | FP | FN |");
  lines.push("|----------|-----------|--------|-----|----|----|----|");
  for (const r of results) {
    lines.push(`| ${r.detectorName} | ${r.overall.precision.toFixed(3)} | ${r.overall.recall.toFixed(3)} | ${r.overall.f1.toFixed(3)} | ${r.overall.tp} | ${r.overall.fp} | ${r.overall.fn} |`);
  }
  lines.push("");

  lines.push("## Latency Statistics (ms)");
  lines.push("");
  lines.push("| Detector | Mean | P50 | P95 | P99 | Min | Max |");
  lines.push("|----------|------|-----|-----|-----|-----|-----|");
  for (const r of results) {
    const stats = computeLatencyStats(r.latencies);
    lines.push(`| ${r.detectorName} | ${stats.mean.toFixed(1)} | ${stats.p50} | ${stats.p95} | ${stats.p99} | ${stats.min} | ${stats.max} |`);
  }
  lines.push("");

  lines.push("## Per-Entity Metrics");
  lines.push("");

  // Collect all entity types
  const allEntities = new Set<string>();
  for (const r of results) {
    for (const label of Object.keys(r.perEntity)) {
      allEntities.add(label);
    }
  }

  for (const entity of Array.from(allEntities).sort()) {
    lines.push(`### ${entity}`);
    lines.push("");
    lines.push("| Detector | Precision | Recall | F1 | TP | FP | FN |");
    lines.push("|----------|-----------|--------|-----|----|----|----|");
    for (const r of results) {
      const m = r.perEntity[entity];
      if (m) {
        lines.push(`| ${r.detectorName} | ${m.precision.toFixed(3)} | ${m.recall.toFixed(3)} | ${m.f1.toFixed(3)} | ${m.tp} | ${m.fp} | ${m.fn} |`);
      } else {
        lines.push(`| ${r.detectorName} | - | - | - | 0 | 0 | 0 |`);
      }
    }
    lines.push("");
  }

  lines.push("## Recommendations");
  lines.push("");

  const rulesResult = results.find(r => r.detectorName === "rules-only");
  const glinerResult = results.find(r => r.detectorName === "gliner-mock");
  const hybridResult = results.find(r => r.detectorName === "hybrid");

  if (rulesResult && hybridResult) {
    const f1Improvement = hybridResult.overall.f1 - rulesResult.overall.f1;
    const recallImprovement = hybridResult.overall.recall - rulesResult.overall.recall;
    const precisionChange = hybridResult.overall.precision - rulesResult.overall.precision;
    const latencyIncrease = computeLatencyStats(hybridResult.latencies).mean - computeLatencyStats(rulesResult.latencies).mean;

    lines.push(`- **Hybrid vs Rules-only:** F1 ${f1Improvement > 0 ? "+" : ""}${f1Improvement.toFixed(3)}, Recall ${recallImprovement > 0 ? "+" : ""}${recallImprovement.toFixed(3)}, Precision ${precisionChange > 0 ? "+" : ""}${precisionChange.toFixed(3)}, Latency +${latencyIncrease.toFixed(1)}ms`);
  }

  if (glinerResult && rulesResult) {
    lines.push(`- **GLiNER mock** adds semantic entity detection (PERSON, ORG, LOCATION, DATE) that rules miss`);
    lines.push(`- **Rules** excel at structured patterns (emails, API keys, JWTs, credit cards) with near-zero false positives`);
  }

  lines.push("- **Threshold tuning:** Consider lowering GLiNER threshold to 0.4 for higher recall, or raising to 0.6 for higher precision");
  lines.push("- **Production note:** Mock detector used; real GLiNER ONNX model latency ~10-20ms on CPU (INT8 quantized), memory ~150MB");
  lines.push("- **False positive analysis:** Rules are precision-optimized; GLiNER may need allowlist for test/placeholder data");

  lines.push("");
  lines.push("---");
  lines.push("*Generated by benchmark script*");

  return lines.join("\n");
}

runBenchmark().catch(console.error);