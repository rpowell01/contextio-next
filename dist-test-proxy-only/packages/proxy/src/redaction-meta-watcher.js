/**
 * Background filesystem watcher for capture redaction metadata.
 *
 * Monitors CAPTURE_DIR for new or modified capture files using fs.watch
 * (with debounce + random jitter). On each settled change, reads the
 * capture JSON, invokes the redaction-utils computation, and writes the
 * `{captureId}.redact-meta.json` metadata file atomically.
 *
 * Design guarantees:
 * - The watcher runs asynchronously and never blocks the proxy's request
 *   / response path.
 * - Rapid sequential writes are batched with a debounce window plus a
 *   small random jitter so that bursts of captures produce at most one
 *   filesystem scan per debounce window.
 * - Metadata writes are atomic: they land in a `.tmp` sibling and are
 *   renamed into place, preventing torn reads.
 * - Errors are contained to the watcher loop; a bad capture file is
 *   skipped and logged but never propagates to the proxy caller.
 */
import fs from "node:fs";
import { stat, readdir, readFile, writeFile, rename, unlink, mkdir } from "node:fs/promises";
import { join } from "node:path";
import { parseResponseUsage, estimateTokensFromText } from "@contextio/core";
import { encrypt, decrypt } from "@contextio/logger";
// ---------------------------------------------------------------------------
// Configuration
// ---------------------------------------------------------------------------
/** Freshness window in ms. All events inside this window are coalesced. */
export const REDACTION_META_DEBOUNCE_MS = 2_000;
/** Upper bound of random jitter appended to each debounce window (ms). */
export const REDACTION_META_JITTER_MS = 500;
/** Maximum time a .tmp file may exist before it is considered stale (ms). */
export const REDACTION_META_TMP_MAX_AGE_MS = 30_000;
// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------
/**
 * Attempt to decrypt capture data if it's encrypted.
 * Returns the decrypted data if successful, or the original data if not encrypted.
 * Returns null if decryption fails (wrong key, corrupt data, etc.).
 */
async function maybeDecryptCapture(rawBytes, encryption) {
    if (!encryption) {
        // No encryption config, assume plaintext
        try {
            return JSON.parse(rawBytes);
        }
        catch {
            return null;
        }
    }
    // Resolve key material the same way the logger plugin does
    let keyMaterial;
    switch (encryption.keyProvider) {
        case "static":
            keyMaterial = encryption.staticKey;
            break;
        case "env":
        default:
            keyMaterial = process.env[encryption.keyEnvVar ?? "CONTEXTIO_LOGGER_ENCRYPTION_KEY"];
            break;
        case "kms":
            throw new Error("[redaction-meta-watcher] KMS key provider not yet implemented");
    }
    if (!keyMaterial) {
        // No key material available, can't decrypt
        return null;
    }
    try {
        // Parse the raw bytes first to check if it's an encrypted envelope
        const parsed = JSON.parse(rawBytes);
        const isEncrypted = typeof parsed.ciphertext === "string" &&
            typeof parsed.salt === "string" &&
            typeof parsed.iv === "string";
        if (!isEncrypted) {
            // Not encrypted, return as-is
            return parsed;
        }
        // Decrypt the encrypted payload
        const decrypted = await decrypt(rawBytes, keyMaterial);
        return JSON.parse(decrypted);
    }
    catch {
        // Decryption failed (wrong key, corrupt data, etc.)
        return null;
    }
}
// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------
/**
 * Derive metadata file path: `<name>.redact-meta.json`.
 *
 * If the input filename ends in `.json`, the metadata filename replaces
 * that suffix. Otherwise `.redact-meta.json` is appended.
 */
function metaFilenameFor(captureFilename) {
    const base = captureFilename.endsWith(".json")
        ? captureFilename.slice(0, -".json".length)
        : captureFilename;
    return `${base}.redact-meta.json`;
}
/**
 * Write the metadata file atomically by staging to a `.tmp` sibling and
 * renaming. `rename` is atomic on POSIX systems when source and target
 * reside on the same filesystem.
 */
async function atomicWriteMetadata(targetPath, metadata, encryption) {
    const tmpPath = `${targetPath}.tmp-${Date.now()}-${Math.random()
        .toString(36)
        .slice(2, 8)}`;
    let content;
    if (encryption?.enabled) {
        // Resolve key material the same way the logger plugin does
        let keyMaterial;
        switch (encryption.keyProvider) {
            case "static":
                keyMaterial = encryption.staticKey;
                break;
            case "env":
            default:
                keyMaterial = process.env[encryption.keyEnvVar ?? "CONTEXTIO_LOGGER_ENCRYPTION_KEY"];
                break;
            case "kms":
                throw new Error("[redaction-meta-watcher] KMS key provider not yet implemented");
        }
        if (!keyMaterial) {
            throw new Error("[redaction-meta-watcher] Encryption enabled but no key material resolved");
        }
        const encrypted = await encrypt(JSON.stringify(metadata), keyMaterial);
        content = JSON.stringify(encrypted);
    }
    else {
        content = JSON.stringify(metadata, null, 2);
    }
    await writeFile(tmpPath, content, "utf8");
    // Retry rename once on EBUSY/EPERM/EEXIST (rare but possible under
    // concurrent writes on Windows or NFS mounts).
    const maxAttempts = 2;
    for (let attempt = 0;; attempt++) {
        try {
            await rename(tmpPath, targetPath);
            return;
        }
        catch (err) {
            const code = err?.code;
            if (attempt >= maxAttempts - 1 || !["EBUSY", "EPERM", "EEXIST"].includes(code ?? "")) {
                // Remove stale tmp if it still exists and re-throw.
                await unlink(tmpPath).catch(() => undefined);
                throw err;
            }
            await new Promise((r) => setTimeout(r, 100));
        }
    }
}
/**
 * Safely purge stale `.tmp-*` files older than `TMP_MAX_AGE_MS` that
 * may be left behind after a process crash.
 */
async function reapStaleTmpFiles(dir) {
    try {
        const entries = await readdir(dir);
        const threshold = Date.now() - REDACTION_META_TMP_MAX_AGE_MS;
        for (const entry of entries) {
            if (!entry.includes(".tmp-"))
                continue;
            const path = join(dir, entry);
            try {
                const s = await stat(path);
                if (s.mtimeMs < threshold) {
                    await unlink(path);
                }
            }
            catch {
                // ignore unreadable entries
            }
        }
    }
    catch {
        // ignore read errors (dir may not exist yet)
    }
}
// ---------------------------------------------------------------------------
// Local redaction counting. The proxy previously called require("@contextio/web")
// at runtime, but the proxy is built as an ES module (type: "module") where
// require is undefined, and @contextio/web has no consumable entry point.
// Counts are computed locally instead: prefer the capture's persisted
// redactionStats (written by the redact plugin) and otherwise scan the
// request body for [RULE_REDACTED] placeholders and SSNs. This keeps the
// proxy free of a build/runtime dependency on the web package.
// ---------------------------------------------------------------------------
const PLACEHOLDER_REGEX = /\[([A-Z][A-Z0-9_]*)_REDACTED\]/g;
const SSN_REGEX = /\b\d{3}-\d{2}-\d{4}\b/g;
/**
 * Validate that the matches array in a meta file has the expected format.
 * Accepts two legacy/concurrent shapes:
 *  - Watcher/backfill: { ruleId, original, placeholder, path }
 *  - Redact plugin:  { ruleId, preValue, postValue, path }
 * Returns true if valid, false if invalid or missing.
 */
function isValidMatchesFormat(matches) {
    if (!Array.isArray(matches))
        return false;
    for (const match of matches) {
        const rec = match;
        const hasRuleId = typeof rec.ruleId === "string";
        const hasOriginalPlaceholder = typeof rec.original === "string" && typeof rec.placeholder === "string";
        const hasPrePost = typeof rec.preValue === "string" && typeof rec.postValue === "string";
        const hasPath = typeof rec.path === "string";
        if (!hasRuleId || !hasPath || (!hasOriginalPlaceholder && !hasPrePost)) {
            return false;
        }
    }
    return true;
}
/** Recursively collect every string leaf value from an arbitrary value. */
function collectStrings(value, out) {
    if (typeof value === "string") {
        out.push(value);
    }
    else if (Array.isArray(value)) {
        for (const item of value)
            collectStrings(item, out);
    }
    else if (value !== null && typeof value === "object") {
        for (const item of Object.values(value))
            collectStrings(item, out);
    }
}
/**
 * Lightweight extractor for redaction matches, recording only rule and JSON path.
 * Used to populate the metadata file with minimal match information.
 */
function extractRedactionMatches(rawData) {
    const rawCapture = (rawData ?? null);
    const matches = [];
    // Helper to extract matches from a string value
    function extractFromString(text, path) {
        PLACEHOLDER_REGEX.lastIndex = 0;
        let m;
        while ((m = PLACEHOLDER_REGEX.exec(text)) !== null) {
            const ruleId = (m[1] ?? "unknown").toLowerCase();
            matches.push({
                ruleId,
                original: text,
                placeholder: m[0],
                path,
            });
        }
        SSN_REGEX.lastIndex = 0;
        while ((m = SSN_REGEX.exec(text)) !== null) {
            matches.push({
                ruleId: "ssn",
                original: text,
                placeholder: m[0],
                path,
            });
        }
    }
    // Collect all string values and their paths
    function collectStringsWithPath(value, path) {
        if (typeof value === "string") {
            extractFromString(value, path);
        }
        else if (Array.isArray(value)) {
            value.forEach((item, index) => collectStringsWithPath(item, `${path}[${index}]`));
        }
        else if (value !== null && typeof value === "object") {
            for (const [key, val] of Object.entries(value)) {
                collectStringsWithPath(val, `${path}.${key}`);
            }
        }
    }
    // Extract from request body and response body
    if (rawCapture?.requestBody) {
        collectStringsWithPath(rawCapture.requestBody, "requestBody");
    }
    if (typeof rawCapture?.responseBody === "string") {
        extractFromString(rawCapture.responseBody, "responseBody");
    }
    else if (rawCapture?.responseBody) {
        collectStringsWithPath(rawCapture.responseBody, "responseBody");
    }
    return matches;
}
/**
 * Derive redaction counts for a capture.
 *
 * Prefers the persisted redactionStats field when present (matching the web
 * API's source of truth), otherwise falls back to scanning the request body
 * for redacted placeholders and SSNs.
 */
function computeCaptureRedactionCounts(rawData) {
    const rawCapture = (rawData ?? null);
    const stats = rawCapture?.redactionStats;
    if (stats && typeof stats.byRule === "object" && stats.byRule !== null) {
        const statsObj = stats;
        const total = typeof stats.totalRedactions === "number"
            ? stats.totalRedactions
            : typeof statsObj.total === "number"
                ? statsObj.total
                : undefined;
        if (typeof total === "number") {
            const byRule = {};
            for (const [rule, count] of Object.entries(stats.byRule)) {
                const n = typeof count === "number" ? count : Number(count);
                if (Number.isFinite(n))
                    byRule[rule] = n;
            }
            return { totalRedactions: total, byRule };
        }
    }
    const strings = [];
    collectStrings(rawCapture?.requestBody ?? null, strings);
    collectStrings(rawCapture?.responseBody ?? null, strings);
    const byRule = {};
    let total = 0;
    for (const text of strings) {
        PLACEHOLDER_REGEX.lastIndex = 0;
        let m;
        while ((m = PLACEHOLDER_REGEX.exec(text)) !== null) {
            const rule = (m[1] ?? "unknown").toLowerCase();
            byRule[rule] = (byRule[rule] ?? 0) + 1;
            total++;
        }
        SSN_REGEX.lastIndex = 0;
        while ((m = SSN_REGEX.exec(text)) !== null) {
            byRule["ssn"] = (byRule["ssn"] ?? 0) + 1;
            total++;
        }
    }
    return { totalRedactions: total, byRule };
}
function computeCaptureMeta(captureId, rawData) {
    try {
        const counts = computeCaptureRedactionCounts(rawData);
        const rawCapture = (rawData ?? null);
        const rawTimings = rawCapture?.timings && typeof rawCapture.timings === "object"
            ? rawCapture.timings
            : {};
        // Compute token metrics from response body
        let totalInputTokens = 0;
        let totalOutputTokens = 0;
        let tokensPerSecond = 0;
        let model = null;
        let successCount = 0;
        let errorCount = 0;
        const responseBody = typeof rawCapture?.responseBody === "string" ? rawCapture.responseBody : undefined;
        const requestBody = rawCapture?.requestBody;
        const responseStatus = typeof rawCapture?.responseStatus === "number" ? rawCapture.responseStatus : 0;
        const totalMs = typeof rawTimings.total_ms === "number" ? rawTimings.total_ms : 0;
        // Determine success/error count based on response status
        const isSuccess = responseStatus >= 200 && responseStatus < 300;
        successCount = isSuccess ? 1 : 0;
        errorCount = isSuccess ? 0 : 1;
        // Parse response for token usage (mirrors web package computeTokenUsage logic)
        if (typeof responseBody === "string" && responseBody.length > 0) {
            const parsed = parseResponseUsage(responseBody);
            const fallback = estimateTokensFromText(responseBody);
            if (parsed.inputTokens === 0 && parsed.outputTokens === 0) {
                totalInputTokens = fallback;
                totalOutputTokens = fallback;
                model = parsed.model;
            }
            else {
                totalInputTokens = parsed.inputTokens || fallback;
                totalOutputTokens = parsed.outputTokens || fallback;
                model = parsed.model;
            }
        }
        else if (requestBody) {
            // No response body - estimate from request body
            const requestText = JSON.stringify(requestBody);
            totalInputTokens = estimateTokensFromText(requestText);
            totalOutputTokens = 0;
            model = null;
        }
        // Compute tokens per second (output tokens / total time in seconds)
        const timeSec = totalMs > 0 ? totalMs / 1000 : 0;
        tokensPerSecond = timeSec > 0 ? totalOutputTokens / timeSec : 0;
        return {
            captureId,
            totalRedactions: counts.totalRedactions,
            byRule: counts.byRule,
            generatedAt: new Date().toISOString(),
            // Omit matches - they will be preserved from redact plugin's meta file via mergeExistingMetadata
            // Watcher's extractRedactionMatches uses placeholder extraction which gives wrong ruleIds
            source: rawCapture?.source ?? undefined,
            provider: rawCapture?.provider ?? "unknown",
            targetUrl: rawCapture?.targetUrl ?? "",
            sessionId: rawCapture?.sessionId ?? undefined,
            timestamp: rawCapture?.timestamp ?? undefined,
            checksum: rawCapture?.checksum ?? undefined,
            schemaVersion: rawCapture?.schemaVersion ?? undefined,
            // Include byte counts and timings for sessions/metrics API performance
            requestBytes: typeof rawCapture?.requestBytes === "number" ? rawCapture.requestBytes : undefined,
            responseBytes: typeof rawCapture?.responseBytes === "number" ? rawCapture.responseBytes : undefined,
            timings: {
                send_ms: typeof rawTimings.send_ms === "number" ? rawTimings.send_ms : undefined,
                wait_ms: typeof rawTimings.wait_ms === "number" ? rawTimings.wait_ms : undefined,
                receive_ms: typeof rawTimings.receive_ms === "number" ? rawTimings.receive_ms : undefined,
                total_ms: typeof rawTimings.total_ms === "number" ? rawTimings.total_ms : undefined,
            },
            // Token metrics
            totalInputTokens,
            totalOutputTokens,
            tokensPerSecond: Number(tokensPerSecond.toFixed(2)),
            successCount,
            errorCount,
            model,
        };
    }
    catch (err) {
        console.error(`[redaction-meta-watcher] Failed to compute metadata for ${captureId}:`, err instanceof Error ? err.message : String(err));
        return null;
    }
}
// ---------------------------------------------------------------------------
// Main watcher factory
// ---------------------------------------------------------------------------
/**
 * Start a background watcher over `captureDir`.
 *
 * The watcher never blocks the caller. It is the caller's responsibility to
 * invoke `.stop()` before the process exits so that the fs.watch handle
 * is released cleanly.
 */
export function createRedactionMetaWatcher(opts) {
    const dir = opts.captureDir;
    const pending = new Map();
    let stopped = false;
    let watcher = null;
    const flushStaleTmp = async () => {
        await reapStaleTmpFiles(dir);
    };
    async function mergeExistingMetadata(metaPath, computed) {
        try {
            const raw = await readFile(metaPath, "utf8");
            const existing = JSON.parse(raw);
            if (typeof existing !== "object" || existing === null || Array.isArray(existing))
                return computed;
            const enriched = { ...computed };
            // Prefer existing byRule from redact plugin (correct preset rule names like "credential_generic")
            // over watcher-computed byRule (extracted from placeholders like "[SECRET_REDACTED]" -> "secret")
            if (existing.byRule && typeof existing.byRule === "object" && !Array.isArray(existing.byRule)) {
                enriched.byRule = existing.byRule;
            }
            // Prefer existing matches from redact plugin (they have correct ruleIds from presets)
            // over watcher-computed matches (which extract ruleIds from placeholders with different naming)
            // Always preserve existing matches if they exist - the API handles multiple formats
            if (Array.isArray(existing.matches) && existing.matches.length > 0) {
                enriched.matches = existing.matches;
            }
            if (!enriched.checksum && typeof existing.checksum === "string") {
                enriched.checksum = existing.checksum;
            }
            if (!enriched.provider && typeof existing.provider === "string") {
                enriched.provider = existing.provider;
            }
            if (!enriched.targetUrl && typeof existing.targetUrl === "string") {
                enriched.targetUrl = existing.targetUrl;
            }
            if (!enriched.schemaVersion && typeof existing.schemaVersion === "string") {
                enriched.schemaVersion = existing.schemaVersion;
            }
            if (!enriched.sessionId && typeof existing.sessionId === "string") {
                enriched.sessionId = existing.sessionId;
            }
            if (!enriched.timestamp && typeof existing.timestamp === "string") {
                enriched.timestamp = existing.timestamp;
            }
            // Preserve byte counts and timings from existing metadata if not in computed
            if (enriched.requestBytes === undefined && typeof existing.requestBytes === "number") {
                enriched.requestBytes = existing.requestBytes;
            }
            if (enriched.responseBytes === undefined && typeof existing.responseBytes === "number") {
                enriched.responseBytes = existing.responseBytes;
            }
            if (existing.timings && typeof existing.timings === "object" && !Array.isArray(existing.timings)) {
                enriched.timings = enriched.timings ?? {};
                for (const key of ["send_ms", "wait_ms", "receive_ms", "total_ms"]) {
                    if (enriched.timings[key] === undefined && typeof existing.timings[key] === "number") {
                        enriched.timings[key] = existing.timings[key];
                    }
                }
            }
            // Preserve token metrics from existing metadata if not in computed
            if (enriched.totalInputTokens === undefined && typeof existing.totalInputTokens === "number") {
                enriched.totalInputTokens = existing.totalInputTokens;
            }
            if (enriched.totalOutputTokens === undefined && typeof existing.totalOutputTokens === "number") {
                enriched.totalOutputTokens = existing.totalOutputTokens;
            }
            if (enriched.tokensPerSecond === undefined && typeof existing.tokensPerSecond === "number") {
                enriched.tokensPerSecond = existing.tokensPerSecond;
            }
            if (enriched.successCount === undefined && typeof existing.successCount === "number") {
                enriched.successCount = existing.successCount;
            }
            if (enriched.errorCount === undefined && typeof existing.errorCount === "number") {
                enriched.errorCount = existing.errorCount;
            }
            if (enriched.model === undefined && (typeof existing.model === "string" || existing.model === null)) {
                enriched.model = existing.model;
            }
            return enriched;
        }
        catch {
            return computed;
        }
    }
    const flush = async (captureFilename) => {
        const metaPath = join(dir, metaFilenameFor(captureFilename));
        const state = pending.get(captureFilename);
        if (!state)
            return;
        pending.delete(captureFilename);
        clearTimeout(state.timer);
        const metadataToMerge = state.metadata;
        try {
            const metadata = await mergeExistingMetadata(metaPath, metadataToMerge);
            await atomicWriteMetadata(metaPath, metadata, opts.encryption);
            // Also persist to SQLite if callback is provided
            if (opts.persistToSqlite) {
                try {
                    const sqliteMetadata = {
                        captureId: metadata.captureId,
                        sessionId: metadata.sessionId ?? null,
                        ruleCounts: metadata.byRule,
                        totalRedactions: metadata.totalRedactions,
                        encrypted: opts.encryption?.enabled ?? false,
                        createdAt: new Date(metadata.generatedAt).getTime(),
                        updatedAt: Date.now(),
                        source: metadata.source,
                        provider: metadata.provider,
                        targetUrl: metadata.targetUrl,
                        requestBytes: metadata.requestBytes,
                        responseBytes: metadata.responseBytes,
                        timings: metadata.timings,
                        totalInputTokens: metadata.totalInputTokens,
                        totalOutputTokens: metadata.totalOutputTokens,
                        tokensPerSecond: metadata.tokensPerSecond,
                        successCount: metadata.successCount,
                        errorCount: metadata.errorCount,
                        model: metadata.model,
                    };
                    opts.persistToSqlite(sqliteMetadata);
                }
                catch (sqliteErr) {
                    console.error(`[redaction-meta-watcher] Failed to persist to SQLite for ${captureFilename}:`, sqliteErr instanceof Error ? sqliteErr.message : String(sqliteErr));
                    // Don't re-schedule for SQLite errors - sidecar file was written successfully
                }
            }
            if (opts.onMetadataReady) {
                opts.onMetadataReady(metadata);
            }
        }
        catch (err) {
            console.error(`[redaction-meta-watcher] Failed to write metadata for ${captureFilename}:`, err instanceof Error ? err.message : String(err));
            // Re-schedule so transient errors (disk full, permission) do not
            // permanently suppress a valid capture.
            schedule(captureFilename, state.metadata);
        }
    };
    const schedule = (captureFilename, metadata) => {
        if (stopped)
            return;
        // Cancel any existing timer for the same file (batching).
        const existing = pending.get(captureFilename);
        if (existing) {
            clearTimeout(existing.timer);
            existing.metadata = metadata;
            pending.set(captureFilename, existing);
            return;
        }
        const jitterMs = Math.round(Math.random() * REDACTION_META_JITTER_MS);
        const timer = setTimeout(() => {
            void flush(captureFilename);
        }, REDACTION_META_DEBOUNCE_MS + jitterMs);
        pending.set(captureFilename, { metadata, timer });
    };
    const processCaptureFile = async (captureFilename) => {
        const path = join(dir, captureFilename);
        // Guard: only process regular files, skip metadata files and tmp files.
        if (!captureFilename.endsWith(".json") ||
            captureFilename.endsWith(".tmp") ||
            captureFilename.includes("redact-meta")) {
            return;
        }
        if (!isValidFilename(captureFilename))
            return;
        try {
            // Stat to avoid reading files that vanished between the fs.watch
            // event and our handler.
            let fileStats;
            try {
                fileStats = await stat(path);
            }
            catch {
                // File was deleted; drop any pending work for it.
                pending.delete(captureFilename);
                return;
            }
            const MAX_FILE_SIZE = 25 * 1024 * 1024;
            if (fileStats.size > MAX_FILE_SIZE)
                return;
            const rawBytes = await readFile(path, "utf8");
            let rawData = await maybeDecryptCapture(rawBytes, opts.encryption);
            if (!rawData) {
                // Could not decrypt or parse, skip
                return;
            }
            const captureId = captureFilename.replace(/\.json$/, "");
            const metadata = computeCaptureMeta(captureId, rawData);
            // Wait for redact plugin's meta file to appear (race condition: capture
            // file event may arrive before meta file is visible). Retry up to 5s.
            const metaPath = join(dir, metaFilenameFor(captureFilename));
            let existingMeta = null;
            for (let attempt = 0; attempt < 25; attempt++) {
                try {
                    const metaContent = await readFile(metaPath, "utf8");
                    existingMeta = JSON.parse(metaContent);
                    break;
                }
                catch {
                    if (attempt === 24)
                        break;
                    await new Promise((r) => setTimeout(r, 200));
                }
            }
            if (existingMeta) {
                const matches = existingMeta.matches;
                if (Array.isArray(matches) && matches.length > 0) {
                    // Merge capture data fields into existing meta instead of skipping entirely
                    // The redact plugin creates meta first but doesn't include requestBytes/responseBytes/timings
                    console.log(`[redaction-meta-watcher] Merging capture data into existing meta for ${captureFilename}`);
                    if (metadata) {
                        const enrichedMeta = await mergeExistingMetadata(metaPath, metadata);
                        schedule(captureFilename, enrichedMeta);
                    }
                    return;
                }
                console.log(`[redaction-meta-watcher] Meta exists but empty/invalid matches, re-processing: ${captureFilename}`);
            }
            else {
                console.log(`[redaction-meta-watcher] No meta file after 5s, will create: ${captureFilename}`);
            }
            if (metadata) {
                schedule(captureFilename, metadata);
            }
        }
        catch (err) {
            console.error(`[redaction-meta-watcher] Error processing ${captureFilename}:`, err instanceof Error ? err.message : String(err));
        }
    };
    async function scanExistingCaptures() {
        console.log("[redaction-meta-watcher] Scanning existing capture files...");
        try {
            const entries = await readdir(dir);
            const captureFiles = entries.filter((f) => f.endsWith(".json") &&
                !f.endsWith(".tmp") &&
                !f.includes("redact-meta") &&
                isValidFilename(f));
            let processed = 0;
            for (const filename of captureFiles) {
                const metaPath = join(dir, metaFilenameFor(filename));
                try {
                    await readFile(metaPath, "utf8");
                    // Meta file exists, skip
                    continue;
                }
                catch {
                    // Meta file doesn't exist, process this capture
                    await processCaptureFile(filename);
                    processed++;
                }
            }
            console.log(`[redaction-meta-watcher] Scanned ${captureFiles.length} existing captures, processed ${processed} new meta files`);
        }
        catch (err) {
            console.error("[redaction-meta-watcher] Error scanning existing captures:", err instanceof Error ? err.message : String(err));
        }
    }
    const handleChange = async (eventType, filename) => {
        if (!filename)
            return;
        await processCaptureFile(filename);
    };
    const startWatcher = () => {
        if (stopped)
            return;
        console.log("[redaction-meta-watcher] Starting watcher on:", dir);
        // Scan existing capture files on startup to process any that don't have meta files
        scanExistingCaptures().catch((err) => {
            console.error("[redaction-meta-watcher] Failed to scan existing captures:", err instanceof Error ? err.message : String(err));
        });
        watcher = fs.watch(dir, { persistent: false }, (eventType, filename) => {
            if (eventType === "rename" || eventType === "change") {
                const name = filename ?? "";
                void handleChange(eventType, name);
            }
        });
        watcher.on("error", (err) => {
            console.error("[redaction-meta-watcher] fs.watch error, attempting restart in 5s:", err.message);
            try {
                watcher?.close();
            }
            catch {
                // ignore close errors during restart
            }
            if (!stopped) {
                setTimeout(startWatcher, 5_000);
            }
        });
    };
    // Ensure the capture directory exists before starting.
    void mkdir(dir, { recursive: true })
        .then(startWatcher)
        .catch((err) => {
        console.error("[redaction-meta-watcher] Failed to create capture directory:", err instanceof Error ? err.message : String(err));
    });
    return {
        stop() {
            stopped = true;
            // Cancel pending timers.
            for (const [, state] of pending) {
                clearTimeout(state.timer);
            }
            pending.clear();
            try {
                watcher?.close();
            }
            catch {
                // ignore close errors during shutdown
            }
        },
    };
}
// ---------------------------------------------------------------------------
// Filename validation mirrors the web package's isValidFilename so the
// watcher's surface area stays consistent.
// ---------------------------------------------------------------------------
/**
 * Validate filename to prevent path traversal attacks.
 *
 * Same contract as `packages/web/lib/sessions/utils.ts::isValidFilename`.
 */
function isValidFilename(filename) {
    if (!filename || filename.length === 0)
        return false;
    if (filename.length > 255)
        return false;
    if (filename.startsWith("."))
        return false;
    if (filename.includes("..") ||
        filename.includes("/") ||
        filename.includes("\\")) {
        return false;
    }
    const validPattern = /^[a-zA-Z0-9_-]+\.json$/;
    return validPattern.test(filename);
}
//# sourceMappingURL=redaction-meta-watcher.js.map