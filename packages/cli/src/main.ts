#!/usr/bin/env node

/**
 * Contextio CLI entry point.
 *
 * Wires together proxy, redact, and logger packages into a single binary.
 * Handles three execution modes:
 * - Standalone: `ctxio proxy` (runs proxy until SIGINT)
 * - Wrap: `ctxio proxy -- claude` (starts proxy, spawns tool, cleans up on exit)
 * - Attach: `ctxio attach claude` (connects tool to already-running proxy)
 *
 * The wrap mode uses a shared proxy with reference counting. Multiple
 * `ctxio proxy -- <tool>` invocations share a single proxy process; the proxy
 * shuts down when the last tool exits.
 */

import { randomBytes } from "node:crypto";
import { spawn, spawnSync } from "node:child_process";
import fs from "node:fs";
import net from "node:net";
import { homedir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

import type { ProxyPlugin } from "@contextio/core";
import { createLoggerPlugin } from "@contextio/logger";
import type { LoggerPlugin } from "@contextio/logger";
import { createProxy, resolveOidcConfig } from "@contextio/proxy";
import { createRedactPlugin } from "@contextio/redact";
import type { PresetName } from "@contextio/redact";
import { createRateLimiterPlugin } from "@contextio/proxy";
import { createRetryPlugin } from "@contextio/proxy";

import { isError, parseArgs } from "./args.js";
import type { AttachArgs, CapturesArgs, MigrateArgs, ProxyArgs } from "./args.js";
import { getToolEnv } from "./tools.js";
import { runMonitor } from "./monitor.js";
import { runInspect } from "./inspect.js";
import { dispatchCommand } from "./dispatch.js";
import { runMigrateCaptures, runMigrateProviders, runMigrateAll } from "./commands/migrate.js";
import { runCapturesList, runCapturesStats, runCapturesSearch, runCapturesReindex } from "./commands/captures.js";

const _pkgPath = new URL("../package.json", import.meta.url);
const _pkg = JSON.parse(fs.readFileSync(fileURLToPath(_pkgPath), "utf8")) as { version: string };
const VERSION: string = _pkg.version;
const CLI_ENTRY = fileURLToPath(import.meta.url);
const __dirname = fileURLToPath(new URL(".", import.meta.url));
const MITM_PORT = 8080;
const MITM_ADDON_PATH = join(__dirname, "..", "mitm_addon.py");
const MITM_START_TIMEOUT_MS = 8000;
const PROXY_START_TIMEOUT_MS = 8000;
/** Lockfile for coordinating shared proxy instances across wrap invocations. */
const PROXY_LOCKFILE = "/tmp/contextio.lock";

/**
 * Shared proxy lock state, written to PROXY_LOCKFILE.
 *
 * `count` tracks how many wrap processes are using this proxy.
 * When count reaches 0, the proxy is stopped.
 */
interface ProxyLockState {
	count: number;
	pid: number;
	port: number;
}

/** State persisted for background proxy (started with `proxy -d`). */
interface BackgroundState {
	pid: number;
	port: number;
	startedAt: string;
}

/** Search PATH for an executable. Returns the full path or null. */
function findBinaryOnPath(binary: string): string | null {
	const pathEnv = process.env.PATH;
	if (!pathEnv) return null;
	for (const dir of pathEnv.split(":")) {
		if (!dir) continue;
		const full = join(dir, binary);
		try {
			fs.accessSync(full, fs.constants.X_OK);
			return full;
		} catch {
			// continue
		}
	}
	return null;
}

function contextioStateDir(): string {
	return join(homedir(), ".contextio");
}

function backgroundStatePath(): string {
	return join(contextioStateDir(), "background.json");
}

function readProxyLock(): ProxyLockState | null {
	try {
		const raw = fs.readFileSync(PROXY_LOCKFILE, "utf8");
		const parsed = JSON.parse(raw);
		if (
			parsed &&
			typeof parsed === "object" &&
			typeof parsed.count === "number" &&
			typeof parsed.pid === "number" &&
			typeof parsed.port === "number"
		) {
			return parsed as ProxyLockState;
		}
	} catch {
		// ignore
	}
	return null;
}

function writeProxyLock(state: ProxyLockState): void {
	fs.writeFileSync(PROXY_LOCKFILE, `${JSON.stringify(state)}\n`);
}

function clearProxyLock(): void {
	try {
		fs.unlinkSync(PROXY_LOCKFILE);
	} catch {
		// ignore
	}
}

/** Check if a process is still running (signal 0 trick). */
function isPidAlive(pid: number): boolean {
	try {
		process.kill(pid, 0);
		return true;
	} catch {
		return false;
	}
}

function readBackgroundState(): BackgroundState | null {
	try {
		const raw = fs.readFileSync(backgroundStatePath(), "utf8");
		const parsed = JSON.parse(raw);
		if (
			parsed &&
			typeof parsed === "object" &&
			typeof parsed.pid === "number" &&
			typeof parsed.port === "number" &&
			typeof parsed.startedAt === "string"
		) {
			return parsed as BackgroundState;
		}
	} catch {
		// ignore
	}
	return null;
}

function writeBackgroundState(state: BackgroundState): void {
	fs.mkdirSync(contextioStateDir(), { recursive: true });
	fs.writeFileSync(backgroundStatePath(), `${JSON.stringify(state, null, 2)}\n`);
}

function clearBackgroundState(): void {
	try {
		fs.unlinkSync(backgroundStatePath());
	} catch {
		// ignore
	}
}

/** Create a directory (recursive) and verify it's writable. */
function ensureWritableDir(dir: string): { ok: boolean; details?: string } {
	try {
		fs.mkdirSync(dir, { recursive: true });
		fs.accessSync(dir, fs.constants.W_OK);
		return { ok: true };
	} catch (err: unknown) {
		return {
			ok: false,
			details: err instanceof Error ? err.message : String(err),
		};
	}
}

/** Check if something is listening on a TCP port (600ms timeout). */
function isPortListening(port: number, host = "127.0.0.1"): Promise<boolean> {
	return new Promise((resolve) => {
		const socket = net.connect({ port, host }, () => {
			socket.end();
			resolve(true);
		});
		socket.on("error", () => resolve(false));
		socket.setTimeout(600, () => {
			socket.destroy();
			resolve(false);
		});
	});
}

/** Bind port 0 to get an OS-assigned ephemeral port, then release it. */
function reserveEphemeralPort(): Promise<number> {
	return new Promise((resolve, reject) => {
		const server = net.createServer();
		server.listen(0, "127.0.0.1", () => {
			const addr = server.address();
			const port = addr && typeof addr === "object" ? addr.port : 0;
			server.close((err) => {
				if (err) reject(err);
				else resolve(port);
			});
		});
		server.on("error", reject);
	});
}

/** Use the preferred mitmproxy port, or pick an ephemeral one if it's taken. */
async function chooseMitmPort(preferredPort: number): Promise<number> {
	if (!(await isPortListening(preferredPort))) return preferredPort;
	return reserveEphemeralPort();
}

/** Reconstruct CLI argv for spawning a shared proxy subprocess. */
function buildProxyArgs(args: ProxyArgs, port: number): string[] {
	const out = ["proxy", "--port", String(port)];
	if (args.bind) out.push("--bind", args.bind);
	if (args.redact) {
		out.push("--redact");
		if (args.redactPolicy) {
			out.push("--redact-policy", args.redactPolicy);
		} else if (args.redactPreset) {
			out.push("--redact-preset", args.redactPreset);
		}
		if (args.redactReversible) {
			out.push("--redact-reversible");
		}
	}
	if (args.detectorMode && args.detectorMode !== "rules") {
		out.push("--detector-mode", args.detectorMode);
		if (args.detectorModelName) {
			out.push("--detector-model-name", args.detectorModelName);
		}
		if (args.detectorThreshold !== null) {
			out.push("--detector-threshold", String(args.detectorThreshold));
		}
	}
	if (args.noLog) out.push("--no-log");
	else if (args.logDir) out.push("--log-dir", args.logDir);
	if (args.logMaxSessions > 0) {
		out.push("--log-max-sessions", String(args.logMaxSessions));
	}
	if (args.enableEncryption) {
		out.push("--enable-encryption");
		// Encryption key is passed via env to child, not argv (security)
	}
	if (args.verbose) out.push("--verbose");
	if (args.publicUrl) out.push("--public-url", args.publicUrl);
	// OIDC config is passed via env vars to child, not argv (security)

	// Rate limiter options
	if (args.enableRateLimiter) {
		out.push("--enable-rate-limiter");
		if (args.rateLimitMaxRequests !== null) out.push("--rate-limit-max-requests", String(args.rateLimitMaxRequests));
		if (args.rateLimitWindowMs !== null) out.push("--rate-limit-window-ms", String(args.rateLimitWindowMs));
		if (args.rateLimitBuffer !== null) out.push("--rate-limit-buffer", String(args.rateLimitBuffer));
		if (args.rateLimitPerProvider) out.push("--rate-limit-per-provider", args.rateLimitPerProvider);
	}
	// Retry options
	if (args.enableRetry) {
		out.push("--enable-retry");
		if (args.retryMaxRetries !== null) out.push("--retry-max-retries", String(args.retryMaxRetries));
		if (args.retryBaseDelayMs !== null) out.push("--retry-base-delay-ms", String(args.retryBaseDelayMs));
		if (args.retryMaxDelayMs !== null) out.push("--retry-max-delay-ms", String(args.retryMaxDelayMs));
		if (args.retryRetryableStatuses) out.push("--retry-retryable-statuses", args.retryRetryableStatuses);
		if (args.retryJitterFactor !== null) out.push("--retry-jitter-factor", String(args.retryJitterFactor));
	}

	return out;
}

/** Poll until a port is listening, or timeout. Returns true if ready. */
async function waitForPort(
	port: number,
	timeoutMs: number,
	host = "127.0.0.1",
): Promise<boolean> {
	const started = Date.now();
	while (Date.now() - started < timeoutMs) {
		if (await isPortListening(port, host)) return true;
		await new Promise((r) => setTimeout(r, 200));
	}
	return false;
}

/** Run diagnostics: check mitmproxy, certs, capture dir, ports, lockfile, background state. */
async function runDoctor(): Promise<number> {
	console.log(`ctxio doctor v${VERSION}`);

	// mitmproxy is needed for tools that ignore base URL overrides
	// (Codex, Copilot, OpenCode). The addon rewrites requests to route
	// through the contextio proxy for full redaction and logging.
	const mitmdumpPath = findBinaryOnPath("mitmdump");
	console.log(
		`- mitmdump (Codex/Copilot/OpenCode): ${mitmdumpPath ?? "not found (install: pipx install mitmproxy)"}`,
	);

	const certPath = join(homedir(), ".mitmproxy", "mitmproxy-ca-cert.pem");
	console.log(
		`- mitm cert (Codex/Copilot/OpenCode): ${fs.existsSync(certPath) ? certPath : "not present (run 'mitmdump' once to generate)"}`,
	);

	console.log(
		`- mitm addon (Codex/Copilot/OpenCode): ${fs.existsSync(MITM_ADDON_PATH) ? MITM_ADDON_PATH : "not found"}`,
	);

	const captureDir = join(homedir(), ".contextio", "captures");
	const captureStatus = ensureWritableDir(captureDir);
	console.log(
		`- capture dir: ${captureStatus.ok ? "ok" : "error"} (${captureDir}${captureStatus.details ? `: ${captureStatus.details}` : ""})`,
	);

	const proxyBusy = await isPortListening(4040);
	console.log(`- port 4040: ${proxyBusy ? "in use" : "available"}`);

	const mitmBusy = await isPortListening(MITM_PORT);
	console.log(`- port ${MITM_PORT}: ${mitmBusy ? "in use" : "available"}`);

	const lock = readProxyLock();
	if (!lock) {
		console.log(`- lockfile: absent (${PROXY_LOCKFILE})`);
	} else {
		const alive = isPidAlive(lock.pid);
		console.log(
			`- lockfile: present count=${lock.count} pid=${lock.pid} port=${lock.port} (${alive ? "alive" : "stale"})`,
		);
	}

	const bg = readBackgroundState();
	if (!bg) {
		console.log("- background: not running");
	} else {
		console.log(
			`- background: ${isPidAlive(bg.pid) ? "running" : "stale"} pid=${bg.pid} port=${bg.port}`,
		);
	}

	return 0;
}

/** Manage the background (detached) proxy: start, stop, or check status. */
async function runBackground(
	action: "start" | "stop" | "status",
): Promise<number> {
	if (action === "status") {
		const bg = readBackgroundState();
		if (!bg) {
			console.log("Background proxy: not running");
			return 0;
		}
		if (!isPidAlive(bg.pid)) {
			console.log("Background proxy: stale state (process not alive)");
			clearBackgroundState();
			return 1;
		}
		console.log(
			`Background proxy: running (pid ${bg.pid}, port ${bg.port}, started ${bg.startedAt})`,
		);
		return 0;
	}

	if (action === "stop") {
		const bg = readBackgroundState();
		if (!bg) {
			console.log("Background proxy: not running");
			return 0;
		}
		if (isPidAlive(bg.pid)) {
			try {
				process.kill(bg.pid, "SIGTERM");
			} catch {
				// ignore
			}
		}
		clearBackgroundState();
		console.log("Background proxy stopped");
		return 0;
	}

	const existing = readBackgroundState();
	if (existing && isPidAlive(existing.pid)) {
		console.log(
			`Background proxy already running (pid ${existing.pid}, port ${existing.port})`,
		);
		return 0;
	}
	if (existing && !isPidAlive(existing.pid)) {
		clearBackgroundState();
	}

	const port = 4040;
	if (await isPortListening(port)) {
		console.error(
			`Cannot start background proxy: port ${port} is already in use.`,
		);
		return 1;
	}

	const bgLogFile = join(homedir(), ".contextio", "proxy.log");
	fs.mkdirSync(join(homedir(), ".contextio"), { recursive: true });
	const bgLogFd = fs.openSync(bgLogFile, "a");
	const child = spawn("node", [CLI_ENTRY, "proxy", "--port", String(port)], {
		detached: true,
		stdio: ["ignore", bgLogFd, bgLogFd],
		env: { ...process.env },
	});
	child.unref();
	fs.closeSync(bgLogFd);

	const ready = await waitForPort(port, PROXY_START_TIMEOUT_MS);
	if (!ready || !child.pid || !isPidAlive(child.pid)) {
		console.error("Failed to start background proxy.");
		return 1;
	}

	writeBackgroundState({ pid: child.pid, port, startedAt: new Date().toISOString() });
	console.log(`Background proxy started on http://127.0.0.1:${port}`);
	return 0;
}

/**
 * Ensure a shared proxy is running for wrap mode.
 *
 * If a proxy is already running (tracked via lockfile), increments the
 * reference count. Otherwise spawns a new detached proxy process.
 *
 * @returns The proxy port and whether this caller should manage the ref count.
 */
async function ensureSharedProxyForWrap(
	args: ProxyArgs,
): Promise<{ proxyPort: number; manageRef: boolean }> {
	const proxyPort = args.port || 4040;
	const proxyRunning = await isPortListening(proxyPort);
	const lock = readProxyLock();
	const lockAlive = !!(lock && isPidAlive(lock.pid));

	if (lock && !lockAlive) {
		clearProxyLock();
	}

	if (proxyRunning) {
		const freshLock = readProxyLock();
		if (freshLock && freshLock.port === proxyPort && isPidAlive(freshLock.pid)) {
			writeProxyLock({
				...freshLock,
				count: freshLock.count + 1,
			});
			return { proxyPort, manageRef: true };
		}
		return { proxyPort, manageRef: false };
	}

const proxyArgs = buildProxyArgs(args, proxyPort);
	const logFile = join(homedir(), ".contextio", "proxy.log");
	fs.mkdirSync(join(homedir(), ".contextio"), { recursive: true });
	const logFd = fs.openSync(logFile, "a");
	const childEnv = { ...process.env };
	if (args.enableEncryption) {
		childEnv.CONTEXTIO_LOGGER_ENCRYPTION_ENABLED = "true";
	}
	if (args.enableEncryption && process.env.CONTEXTIO_LOGGER_ENCRYPTION_KEY) {
		childEnv.CONTEXTIO_LOGGER_ENCRYPTION_KEY = process.env.CONTEXTIO_LOGGER_ENCRYPTION_KEY;
	}
	// Pass OIDC config via env vars to child (security: avoids argv exposure)
	if (args.enableOidc) {
		childEnv.CONTEXTIO_OIDC_ENABLED = "true";
		if (args.oidcIssuer) childEnv.CONTEXTIO_OIDC_ISSUER = args.oidcIssuer;
		if (args.oidcClientId) childEnv.CONTEXTIO_OIDC_CLIENT_ID = args.oidcClientId;
		if (args.oidcClientSecret) childEnv.CONTEXTIO_OIDC_CLIENT_SECRET = args.oidcClientSecret;
		if (args.oidcSessionSecret) childEnv.CONTEXTIO_OIDC_SESSION_SECRET = args.oidcSessionSecret;
	}
	// Pass public URL via env for callback URL construction behind reverse proxy
	if (args.publicUrl) {
		childEnv.CONTEXTIO_OIDC_PUBLIC_URL = args.publicUrl;
	}
	const child = spawn("node", [CLI_ENTRY, ...proxyArgs], {
		detached: true,
		stdio: ["ignore", logFd, logFd],
		env: childEnv,
	});
	child.unref();
	fs.closeSync(logFd);

	const ready = await waitForPort(proxyPort, PROXY_START_TIMEOUT_MS);
	if (!ready || !child.pid || !isPidAlive(child.pid)) {
		throw new Error("Timed out waiting for shared proxy to start");
	}

	writeProxyLock({ count: 1, pid: child.pid, port: proxyPort });

	return { proxyPort, manageRef: true };
}

/**
 * Decrement the shared proxy reference count. When it hits zero,
 * send SIGTERM to the proxy process and remove the lockfile.
 */
function releaseSharedProxyRef(manageRef: boolean): void {
	if (!manageRef) return;
	const lock = readProxyLock();
	if (!lock) return;
	const next = lock.count - 1;
	if (next <= 0) {
		if (isPidAlive(lock.pid)) {
			try {
				process.kill(lock.pid, "SIGTERM");
			} catch {
				// ignore
			}
		}
		clearProxyLock();
		return;
	}
	writeProxyLock({ ...lock, count: next });
}

/** Create the plugin array from CLI args (redact + logger + rate-limiter + retry based on flags). */
function buildPlugins(args: ProxyArgs): ProxyPlugin[] {
	const plugins: ProxyPlugin[] = [];

	if (args.redact) {
		const detectorConfig: Record<string, unknown> = {};
		if (args.detectorModelName) {
			detectorConfig.modelName = args.detectorModelName;
		}
		if (args.detectorThreshold !== null) {
			detectorConfig.llmThreshold = args.detectorThreshold;
		}

		plugins.push(
			createRedactPlugin({
				preset: args.redactPreset as PresetName,
				policyFile: args.redactPolicy ?? undefined,
				reversible: args.redactReversible,
				verbose: args.verbose,
				detectorMode: args.detectorMode,
				detectorConfig: Object.keys(detectorConfig).length > 0 ? detectorConfig : undefined,
			}),
		);
	}

	if (args.log) {
		const encryptionKey = process.env.CONTEXTIO_LOGGER_ENCRYPTION_KEY;
		plugins.push(
			createLoggerPlugin({
				captureDir: args.logDir ?? undefined,
				maxSessions: args.logMaxSessions ?? undefined,
				encryption: args.enableEncryption
					? {
							enabled: true,
							keyProvider: encryptionKey ? "static" : "env",
							staticKey: encryptionKey ?? undefined,
							keyEnvVar: "CONTEXTIO_LOGGER_ENCRYPTION_KEY",
							keyLength: 32,
						}
					: undefined,
			}),
		);
	}

	// Rate limiter plugin
	if (args.enableRateLimiter) {
		// Parse per-provider config
		const providers: Record<string, { maxRequests?: number; windowMs?: number; bufferCapacity?: number }> = {};
		if (args.rateLimitPerProvider) {
			const pairs = args.rateLimitPerProvider.split(",").map(s => s.trim()).filter(Boolean);
			for (const pair of pairs) {
				const [provider, value] = pair.split(":");
				const parsedValue = parseInt(value, 10);
				providers[provider] = { maxRequests: parsedValue };
			}
		}

		plugins.push(
			createRateLimiterPlugin({
				defaults: {
					maxRequests: args.rateLimitMaxRequests ?? undefined,
					windowMs: args.rateLimitWindowMs ?? undefined,
					bufferCapacity: args.rateLimitBuffer ?? undefined,
				},
				providers,
				enabled: true,
			}),
		);
	}

	// Retry plugin
	if (args.enableRetry) {
		plugins.push(
			createRetryPlugin({
				maxRetries: args.retryMaxRetries ?? undefined,
				baseDelayMs: args.retryBaseDelayMs ?? undefined,
				maxDelayMs: args.retryMaxDelayMs ?? undefined,
				retryableStatuses: args.retryRetryableStatuses
					? args.retryRetryableStatuses.split(",").map(s => parseInt(s.trim(), 10)).filter(n => !isNaN(n))
					: undefined,
				jitterFactor: args.retryJitterFactor ?? undefined,
				enabled: true,
			}),
		);
	}

	return plugins;
}

/** Print a summary of active plugins, redaction config, and log directory. */
function printStartupInfo(plugins: ProxyPlugin[], args: ProxyArgs, isWrap = false): void {
	const names = plugins.map((p) => p.name);
	if (names.length > 0) {
		console.log(`Plugins: ${names.join(", ")}`);
	} else {
		console.log("Plugins: none (bare proxy)");
	}

	if (args.redact) {
		const mode = args.redactReversible ? " (reversible)" : "";
		if (args.redactPolicy) {
			console.log(`Redact: policy ${args.redactPolicy}${mode}`);
		} else {
			console.log(`Redact: preset "${args.redactPreset}"${mode}`);
		}
		if (args.detectorMode && args.detectorMode !== "rules") {
			const detectorInfo = `Detector mode: ${args.detectorMode}`;
			const modelInfo = args.detectorModelName ? ` (model: ${args.detectorModelName})` : "";
			const thresholdInfo = args.detectorThreshold !== null ? `, threshold: ${args.detectorThreshold}` : "";
			console.log(detectorInfo + modelInfo + thresholdInfo);
		}
	}

	const loggerPlugin = plugins.find((p) => p.name === "logger") as LoggerPlugin | undefined;
	if (loggerPlugin) {
		console.log(`Logs: ${loggerPlugin.captureDir}`);
	}

	if (args.enableEncryption) {
		console.log("[startup] Logger encryption enabled");
	}

	if (args.verbose && isWrap) {
		console.log(`Proxy log: ${join(homedir(), ".contextio", "proxy.log")}`);
	}
}

/**
 * Start the proxy in standalone mode (no child process).
 * Runs until SIGINT/SIGTERM.
 */
async function runStandalone(args: ProxyArgs): Promise<void> {
	const plugins = buildPlugins(args);
	printStartupInfo(plugins, args);

	if (args.enableOidc) {
		console.log("[startup] OIDC authentication enabled");
	}

	const proxyConfig: Parameters<typeof createProxy>[0] = {
		port: args.port || undefined,
		bindHost: args.bind || undefined,
		plugins,
		logTraffic: args.verbose,
		publicUrl: args.publicUrl || undefined,
	};

	if (args.enableOidc) {
		// Build overrides from CLI args for resolveOidcConfig
		// Note: OIDC values from CLI take precedence over env vars
		// Use type assertion since we only provide the fields we have, and resolveOidcConfig reads individual fields
		const oidcConfig = resolveOidcConfig({
			oidc: {
				issuer: args.oidcIssuer!,
				clientId: args.oidcClientId!,
				clientSecret: args.oidcClientSecret!,
				sessionSecret: args.oidcSessionSecret!,
			} as Parameters<typeof resolveOidcConfig>[0] extends { oidc?: infer T } ? T : never,
		});
		if (oidcConfig) {
			proxyConfig.oidc = oidcConfig;
		}
	}

	const proxy = createProxy(proxyConfig);

	await proxy.start();

	let shuttingDown = false;
	const shutdown = (): void => {
		if (shuttingDown) return;
		shuttingDown = true;
		console.log("\nShutting down...");
		proxy.stop().then(() => process.exit(0));
	};
	process.on("SIGINT", shutdown);
	process.on("SIGTERM", shutdown);
	// Keep alive
	process.stdin.resume();
}

/**
 * Wrap mode: start a shared proxy, spawn the child tool routed through
 * it, and clean up everything when the child exits.
 *
 * For tools that need mitmproxy (Codex, Copilot, OpenCode), also starts
 * mitmproxy in upstream mode between the tool and the proxy.
 */
async function runWrap(args: ProxyArgs, wrap: string[]): Promise<void> {
	const plugins = buildPlugins(args);
	printStartupInfo(plugins, args, true);
	if (args.enableOidc) {
		console.log("[startup] OIDC authentication enabled");
	}
	const [command, ...commandArgs] = wrap;
	const sessionId = randomBytes(4).toString("hex"); // 8 hex chars

	const defaultCaptureDir = join(homedir(), ".contextio", "captures");
	const captureDir = args.log ? args.logDir || defaultCaptureDir : "";

	if (args.log) {
		const writable = ensureWritableDir(captureDir);
		if (!writable.ok) {
			console.error(`Capture directory not writable: ${captureDir}`);
			if (writable.details) console.error(writable.details);
			process.exit(1);
		}
	}

	const { proxyPort, manageRef } = await ensureSharedProxyForWrap(args);
	const proxyUrl = `http://127.0.0.1:${proxyPort}`;
	const toolEnv = getToolEnv(command, proxyUrl, sessionId);
	let mitmProcess: ReturnType<typeof spawn> | null = null;
	let child: ReturnType<typeof spawn> | null = null;
	let cleanupCalled = false;
	let mitmPort = MITM_PORT;

	console.log(`Session: ${sessionId}`);
	console.log(`Wrapping: ${wrap.join(" ")}`);

	const childEnv = {
		...process.env,
		...toolEnv.env,
	};

	if (toolEnv.needsMitm) {
		const certPath = join(homedir(), ".mitmproxy", "mitmproxy-ca-cert.pem");
		if (fs.existsSync(certPath)) {
			childEnv.SSL_CERT_FILE = certPath;
			childEnv.NODE_EXTRA_CA_CERTS = certPath;
		} else {
			console.error(
				`Warning: mitmproxy CA cert not found at ${certPath}. Run 'mitmdump' once to generate it.`,
			);
		}
	}

	const cleanupAndExit = (exitCode: number): void => {
		if (cleanupCalled) return;
		cleanupCalled = true;

		if (child && !child.killed) child.kill("SIGTERM");
		if (mitmProcess && !mitmProcess.killed) mitmProcess.kill();
		releaseSharedProxyRef(manageRef);
		process.exit(exitCode);
	};

	const startChild = (): void => {
		child = spawn(command, commandArgs, {
			stdio: "inherit",
			env: childEnv,
		});

		child.on("error", (err) => {
			if ((err as NodeJS.ErrnoException).code === "ENOENT") {
				console.error(`Command not found: ${command}`);
				cleanupAndExit(127);
				return;
			}
			console.error(`Failed to start ${command}: ${err.message}`);
			cleanupAndExit(1);
		});

		child.on("exit", (code, signal) => {
			const exitCode = signal ? 128 + (signal === "SIGINT" ? 2 : 15) : code || 0;
			cleanupAndExit(exitCode);
		});

		// Let SIGINT flow to the child naturally (it shares our process group).
		process.on("SIGINT", () => {});

		// SIGTERM: forward to child, then the exit handler cleans up.
		process.on("SIGTERM", () => {
			if (child && !child.killed) child.kill("SIGTERM");
		});
	};

	if (toolEnv.needsMitm) {
		if (!fs.existsSync(MITM_ADDON_PATH)) {
			console.error(`mitm addon not found: ${MITM_ADDON_PATH}`);
			cleanupAndExit(1);
			return;
		}
		if (!findBinaryOnPath("mitmdump")) {
			console.error("mitmdump not found on PATH.");
			console.error("Install it with: pipx install mitmproxy");
			cleanupAndExit(1);
			return;
		}
		const versionCheck = spawnSync("mitmdump", ["--version"], {
			stdio: "ignore",
		});
		if (versionCheck.status !== 0) {
			console.error("mitmdump is installed but not runnable.");
			cleanupAndExit(1);
			return;
		}

		mitmPort = await chooseMitmPort(MITM_PORT);
		const mitmProxyUrl = `http://127.0.0.1:${mitmPort}`;
		childEnv.https_proxy = mitmProxyUrl;
		childEnv.HTTPS_PROXY = mitmProxyUrl;
		childEnv.http_proxy = mitmProxyUrl;
		childEnv.HTTP_PROXY = mitmProxyUrl;
		if (mitmPort !== MITM_PORT) {
			console.log(
				`Port ${MITM_PORT} is in use; using mitmproxy port ${mitmPort}.`,
			);
		}

		// mitmproxy terminates TLS, the addon rewrites requests to route
		// through the contextio proxy for redaction and logging.
		console.log(
			`Starting mitmproxy (routing through proxy on :${proxyPort})...`,
		);
		mitmProcess = spawn(
			"mitmdump",
			[
				"-s",
				MITM_ADDON_PATH,
				"--quiet",
				"--listen-port",
				String(mitmPort),
			],
			{
				stdio: ["ignore", "pipe", "pipe"],
				env: {
					...process.env,
					CONTEXTIO_PROXY_URL: `http://127.0.0.1:${proxyPort}`,
					CONTEXTIO_SOURCE: command,
					CONTEXTIO_SESSION_ID: sessionId,
				},
			},
		);

		mitmProcess.on("error", (err) => {
			console.error(`Failed to start mitmproxy: ${err.message}`);
			console.error("Install it with: pipx install mitmproxy");
			cleanupAndExit(1);
		});

		mitmProcess.on("exit", (code) => {
			if (cleanupCalled) return;
			if (!code) return;
			console.error("mitmproxy exited unexpectedly");
			cleanupAndExit(code || 1);
		});

		let attempts = 0;
		const pollMitm = setInterval(() => {
			attempts += 1;
			const socket = net.connect(
				{ port: mitmPort, host: "127.0.0.1" },
				() => {
					socket.end();
					clearInterval(pollMitm);
					startChild();
				},
			);
			socket.on("error", () => {});
			socket.setTimeout(500, () => socket.destroy());
			if (attempts * 200 >= MITM_START_TIMEOUT_MS) {
				clearInterval(pollMitm);
				console.error("Timed out waiting for mitmproxy to become ready.");
				cleanupAndExit(1);
			}
		}, 200);
		return;
	}

	startChild();
}

/**
 * Attach a command to an already-running proxy.
 * Sets env vars, spawns the command, exits when it finishes.
 * Does not start or stop the proxy.
 *
 * For tools that need mitmproxy (Copilot, OpenCode), starts mitmproxy
 * in upstream mode, chaining HTTPS traffic through to the proxy.
 */
async function runAttach(args: AttachArgs): Promise<void> {
	const proxyPort = args.port || 4040;
	const sessionId = randomBytes(4).toString("hex");
	const [command, ...commandArgs] = args.wrap;
	const proxyUrl = `http://127.0.0.1:${proxyPort}`;
	const toolEnv = getToolEnv(command, proxyUrl, sessionId);

	// A running contextio proxy is always required (mitmproxy chains into it)
	if (!(await isPortListening(proxyPort))) {
		console.error(`No proxy running on port ${proxyPort}.`);
		console.error(`Start one first: contextio proxy [options]`);
		process.exit(1);
	}

	console.log(`Session: ${sessionId}`);
	if (toolEnv.needsMitm) {
		console.log(`Mode: mitmproxy (upstream to proxy)`);
	} else {
		console.log(`Proxy: port ${proxyPort}`);
	}
	console.log(`Running: ${args.wrap.join(" ")}`);

	const childEnv = { ...process.env, ...toolEnv.env };
	let mitmProcess: ReturnType<typeof spawn> | null = null;

	const cleanup = (): void => {
		if (mitmProcess && !mitmProcess.killed) mitmProcess.kill();
	};

	// Start mitmproxy if needed; addon rewrites requests to the proxy
	if (toolEnv.needsMitm) {
		if (!fs.existsSync(MITM_ADDON_PATH)) {
			console.error(`mitm addon not found: ${MITM_ADDON_PATH}`);
			process.exit(1);
		}
		if (!findBinaryOnPath("mitmdump")) {
			console.error("mitmdump not found on PATH.");
			console.error("Install it with: pipx install mitmproxy");
			process.exit(1);
		}

		// Resolve SSL cert for mitmproxy HTTPS interception.
		// Set both SSL_CERT_FILE (OpenSSL) and NODE_EXTRA_CA_CERTS (Node.js).
		const certPath = join(homedir(), ".mitmproxy", "mitmproxy-ca-cert.pem");
		if (fs.existsSync(certPath)) {
			childEnv.SSL_CERT_FILE = certPath;
			childEnv.NODE_EXTRA_CA_CERTS = certPath;
		} else {
			console.error(
				`Warning: mitmproxy CA cert not found at ${certPath}. Run 'mitmdump' once to generate it.`,
			);
		}

		const mitmPort = await chooseMitmPort(MITM_PORT);
		const mitmUrl = `http://127.0.0.1:${mitmPort}`;
		childEnv.https_proxy = mitmUrl;
		childEnv.HTTPS_PROXY = mitmUrl;
		childEnv.http_proxy = mitmUrl;
		childEnv.HTTP_PROXY = mitmUrl;

		console.log(`Proxy: port ${proxyPort} (via mitmproxy on :${mitmPort})`);

		mitmProcess = spawn(
			"mitmdump",
			[
				"-s",
				MITM_ADDON_PATH,
				"--quiet",
				"--listen-port",
				String(mitmPort),
			],
			{
				stdio: ["ignore", "ignore", "ignore"],
				env: {
					...process.env,
					CONTEXTIO_PROXY_URL: `http://127.0.0.1:${proxyPort}`,
					CONTEXTIO_SOURCE: command,
					CONTEXTIO_SESSION_ID: sessionId,
				},
			},
		);

		mitmProcess.on("error", (err) => {
			console.error(`Failed to start mitmproxy: ${err.message}`);
			process.exit(1);
		});

		// Wait for mitmproxy to be ready
		const ready = await waitForPort(mitmPort, MITM_START_TIMEOUT_MS);
		if (!ready) {
			console.error("Timed out waiting for mitmproxy to start.");
			cleanup();
			process.exit(1);
		}
	}

	const child = spawn(command, commandArgs, {
		stdio: "inherit",
		env: childEnv,
	});

	child.on("error", (err) => {
		cleanup();
		if ((err as NodeJS.ErrnoException).code === "ENOENT") {
			console.error(`Command not found: ${command}`);
			process.exit(127);
			return;
		}
		console.error(`Failed to start ${command}: ${err.message}`);
		process.exit(1);
	});

	child.on("exit", (code, signal) => {
		cleanup();
		const exitCode = signal ? 128 + (signal === "SIGINT" ? 2 : 15) : code || 0;
		process.exit(exitCode);
	});

	// Let SIGINT flow to child naturally
	process.on("SIGINT", () => {});
	process.on("SIGTERM", () => {
		if (!child.killed) child.kill("SIGTERM");
		cleanup();
	});
}

/** Handle migrate command. */
async function runMigrate(args: MigrateArgs): Promise<void> {
	switch (args.subcommand) {
		case "captures":
			await runMigrateCaptures({
				captureDir: args.captureDir,
				dryRun: args.dryRun,
				force: args.force,
				keyMaterial: args.keyMaterial,
				maxFiles: args.maxFiles,
			});
			break;
		case "providers":
			await runMigrateProviders({
				providersFile: args.providersFile,
				dryRun: args.dryRun,
				force: args.force,
				noBackup: args.noBackup,
			});
			break;
		case "all":
			await runMigrateAll(
				{
					captureDir: args.captureDir,
					dryRun: args.dryRun,
					force: args.force,
					keyMaterial: args.keyMaterial,
					maxFiles: args.maxFiles,
				},
				{
					providersFile: args.providersFile,
					dryRun: args.dryRun,
					force: args.force,
					noBackup: args.noBackup,
				}
			);
			break;
	}
}

/** Handle captures command. */
async function runCaptures(args: CapturesArgs): Promise<void> {
	switch (args.subcommand) {
		case "list":
			await runCapturesList({
				session: args.session,
				since: args.since,
				limit: args.limit,
				offset: args.offset,
				dir: args.captureDir,
			});
			break;
		case "stats":
			await runCapturesStats();
			break;
		case "search":
			await runCapturesSearch({
				session: args.session,
				model: args.model,
				status: args.status,
				since: args.since,
				until: args.until,
				limit: args.limit,
				offset: args.offset,
				dir: args.captureDir,
			});
			break;
		case "reindex":
			await runCapturesReindex({
				dir: args.captureDir,
				keyMaterial: args.keyMaterial,
				force: args.force,
				dryRun: args.dryRun,
			});
			break;
	}
}

async function main(): Promise<void> {
	const result = parseArgs(process.argv);

	if (isError(result)) {
		console.error(result.error);
		process.exit(1);
	}

	const exitCode = await dispatchCommand(result, {
		runDoctor,
		runAttach,
		runProxy: {
			runBackground,
			runStandalone,
			runWrap,
		},
		runMonitor,
		runInspect,
		runMigrate,
		runCaptures,
	});

	if (typeof exitCode === "number") {
		process.exit(exitCode);
	}
}

main().catch((err) => {
	console.error("Fatal:", err instanceof Error ? err.message : String(err));
	process.exit(1);
});
