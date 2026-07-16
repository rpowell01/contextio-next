import { decryptCapture } from '@contextio/logger';

async function benchmark(filepath: string, key: string | null): Promise<void> {
  const start = Date.now();
  let successCount = 0;
  
  for (let i = 0; i < 100; i++) {
    const result = await decryptCapture(filepath, key);
    if (result !== null) {
      successCount++;
    }
  }
  
  const duration = Date.now() - start;
  const avg = duration / 100;
  
  if (successCount !== 100) {
    console.error(`\nError: Only ${successCount}/100 iterations succeeded`);
    process.exit(1);
  }
  
  console.log(`\nBenchmark: 100 iterations took ${duration}ms (avg ${avg.toFixed(2)}ms per iter)\n`);
}

// Usage: pnpm run bench:decrypt <filepath> <key>
const filepath = process.argv[2] ?? './test-data/capture.bin';
const key = process.argv[3] ?? null;

benchmark(filepath, key).catch((err) => {
  console.error('Benchmark failed:', err);
  process.exit(1);
});