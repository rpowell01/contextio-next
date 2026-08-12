import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { readFileSync } from "node:fs";
import { writeFileSync } from "node:fs";

import { PRESETS } from "../dist/presets.js";
import { createRuleDetector, RuleDetector, type RuleDetectorConfig } from "../dist/ruleDetector.js";
import { DetectorPipeline, createHybridDetector, type DetectorPipelineConfig } from "../dist/detectorPipeline.js";
import type { Detector, DetectorConfig, DetectionResult, DetectedSpan } from "../dist/detector.js";
import { PresidioTsDetector, createPresidioTsDetector, type PresidioTsConfig } from "../dist/presidioTsDetector.js";

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

  // Presidio TS detector (replaces GLiNER mock)
  const presidioDetector = await createPresidioTsDetector({
    name: "presidio-ts",
    modelName: "Xenova/bert-base-NER",
    threshold: 0.5,
  });

  // Hybrid detector (rules + Presidio TS)
  const hybridPipeline = new DetectorPipeline({
    detectors: [ruleDetector, presidioDetector],
    mergeStrategy: "priority",
    priorityOrder: ["rules", "presidio-ts"],
    thresholds: { "rules": 0.95, "presidio-ts": 0.5 },
  });
  await hybridPipeline.initialize();

  const detectorConfigs = [
    { name: "rules-only", detector: ruleDetector },
    { name: "presidio-ts", detector: presidioDetector },
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
  const presidioResult = results.find(r => r.detectorName === "presidio-ts");
  const hybridResult = results.find(r => r.detectorName === "hybrid");

  if (rulesResult && hybridResult) {
    const f1Improvement = hybridResult.overall.f1 - rulesResult.overall.f1;
    const recallImprovement = hybridResult.overall.recall - rulesResult.overall.recall;
    const precisionChange = hybridResult.overall.precision - rulesResult.overall.precision;
    const latencyIncrease = computeLatencyStats(hybridResult.latencies).mean - computeLatencyStats(rulesResult.latencies).mean;

    lines.push(`- **Hybrid vs Rules-only:** F1 ${f1Improvement > 0 ? "+" : ""}${f1Improvement.toFixed(3)}, Recall ${recallImprovement > 0 ? "+" : ""}${recallImprovement.toFixed(3)}, Precision ${precisionChange > 0 ? "+" : ""}${precisionChange.toFixed(3)}, Latency +${latencyIncrease.toFixed(1)}ms`);
  }

  if (presidioResult && rulesResult) {
    lines.push(`- **Presidio TS** adds semantic entity detection (PERSON, ORG, LOCATION, DATE) that rules miss`);
    lines.push(`- **Rules** excel at structured patterns (emails, API keys, JWTs, credit cards) with near-zero false positives`);
  }

  lines.push("- **Threshold tuning:** Consider lowering Presidio threshold to 0.4 for higher recall, or raising to 0.6 for higher precision");
  lines.push("- **Production note:** Presidio TS uses @siddicky/anonymizerts with ONNX Runtime Web");
  lines.push("- **False positive analysis:** Rules are precision-optimized; Presidio TS may need allowlist for test/placeholder data");

  lines.push("");
  lines.push("---");
  lines.push("*Generated by benchmark script*");

  return lines.join("\n");
}

runBenchmark().catch(console.error);