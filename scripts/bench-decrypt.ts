import fs from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import { decryptCapture, encrypt } from "@contextio/logger";

const __dirname = dirname(fileURLToPath(import.meta.url));
const FIXTURE_DIR = join(__dirname, "test-fixture");
const FIXTURE_PATH = join(FIXTURE_DIR, "capture.bin");
const FIXTURE_KEY = "benchmark-fixture-key-please-use-32-char-or-more";

async function ensureFixture(): Promise<string> {
	const explicitPath = process.argv[2];
	if (explicitPath) {
		return explicitPath;
	}

	try {
		fs.mkdirSync(FIXTURE_DIR, { recursive: true });
	} catch {
		/* may already exist */
	}

	try {
		fs.accessSync(FIXTURE_PATH);
		return FIXTURE_PATH;
	} catch {
		// File does not exist — generate it below.
	}

	const sampleCapture = {
		captureId: "bench-capture-001",
		source: "benchmark",
		sessionId: "aabbccdd",
		timestamp: new Date().toISOString(),
		request: { method: "GET", url: "https://example.com/api" },
		response: { status: 200, body: "OK" },
	};

	const encrypted = await encrypt(JSON.stringify(sampleCapture), FIXTURE_KEY);
	fs.writeFileSync(FIXTURE_PATH, JSON.stringify(encrypted), "utf8");
	return FIXTURE_PATH;
}

async function benchmark(filepath: string, key: string): Promise<void> {
	try {
		const preFlight = await decryptCapture(filepath, key);
		if (preFlight === null) {
			console.error(
				`\nError: decryptCapture returned null for ${filepath}. ` +
					"Ensure the file exists and the key is correct.\n",
			);
			process.exit(1);
		}
	} catch (err) {
		console.error("Benchmark pre-check failed:", err);
		process.exit(1);
	}

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

	console.log(
		`\nBenchmark: 100 iterations took ${duration}ms (avg ${avg.toFixed(2)}ms per iter)\n`,
	);
}

try {
	const filepath = await ensureFixture();
	const key = process.argv[3] ?? FIXTURE_KEY;

	if (!key || key.length === 0) {
		console.error("\nError: A key is required for decryption benchmarks.");
		process.exit(1);
	}

	await benchmark(filepath, key);
} catch (err) {
	console.error("Benchmark failed:", err);
	process.exit(1);
}
