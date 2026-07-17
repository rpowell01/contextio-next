# Decryption Benchmark

This benchmark measures the performance of the `decryptCapture` operation under realistic conditions. The `bench:decrypt` script runs 100 iterations of decryption and reports timing.

## Usage

```
pnpm run bench:decrypt <filepath> <key>
```

## Default Values

- Filepath: `scripts/test-fixture/capture.bin` (auto-generated if not provided)
- Key: auto-generated test key (or provide your own - must be at least 32 characters)

## Test Environment

- Node.js: 22.23.1
- @contextio/logger: 0.2.0
- Key derivation: PBKDF2-HMAC-SHA256, 100,000 iterations

## Methodology

1. Run `pnpm run build` first to compile the logger package
2. The benchmark auto-generates a real encrypted capture fixture at `scripts/test-fixture/capture.bin` using the repo's `encrypt()` function
3. Asserts `decryptCapture` returns non-null before entering the timing loop
4. Times 100 calls to `decryptCapture` and reports total and average time

## Latest Results (2026-07-16)

```
Benchmark: 100 iterations took 4ms (avg 0.04ms per iter)
```

Note: The logger package is pre-built and the in-process key cache prevents repeated PBKDF2 derivation on subsequent iterations. A fresh process will incur the PBKDF2 derivation cost (~10-50ms) on the first decryption call only.