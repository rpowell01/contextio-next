# Decryption Benchmark

This benchmark measures the performance of the `decryptCapture` operation under realistic conditions. The `bench:decrypt` script runs 100 iterations of decryption and reports timing.

## Usage
```
pnpm run bench:decrypt <filepath> <key>
```

## Default Values
- Filepath: `./test-data/capture.bin`
- Key: (required) - must be at least 32 characters

## Test Environment
- Node.js: 22.23.1
- @contextio/logger: 0.2.0
- Key derivation: PBKDF2-HMAC-SHA256, 600,000 iterations

## Methodology
1. Run `pnpm run build` first to compile the logger package
2. Create test-data/capture.bin with an encrypted capture file
3. The benchmark times 100 calls to `decryptCapture` and reports total and average time

## Latest Results (2026-07-16)
```
Benchmark: 100 iterations took 93ms (avg 0.93ms per iter)
```

Note: The logger has already been built and the key cache prevents repeated PBKDF2 derivation on subsequent runs. First-run timing will be slower due to key derivation cost.