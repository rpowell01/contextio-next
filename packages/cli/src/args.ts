/**
 * CLI argument parsing.
 *
 * Uses Commander to define subcommands (proxy, attach, monitor, inspect,
 * doctor) and parse argv into typed result objects.
 * The parser never calls process.exit; instead it returns ParseResult
 * which is either a typed args object or a ParseError.
 */

import fs from "node:fs";
import { fileURLToPath } from "node:url";

import { Command } from "commander";

const _pkgPath = new URL("../package.json", import.meta.url);
const _pkg = JSON.parse(fs.readFileSync(fileURLToPath(_pkgPath), "utf8")) as { version: string };
const CLI_VERSION: string = _pkg.version;

/** Parsed arguments for `ctxio proxy`. */
export interface ProxyArgs {
	command: "proxy";
	/** "start" for normal operation, "stop"/"status" for background control. */
	action: "start" | "stop" | "status";
	port: number;
	bind: string;
	/** Run in background (detached) mode. */
	detach: boolean;
	redact: boolean;
	redactPreset: string;
	redactPolicy: string | null;
	redactReversible: boolean;
	/** Detector mode: rules | llm | hybrid | auto. Default: rules */
	detectorMode: "rules" | "llm" | "hybrid" | "auto";
	/** Path to GLiNER ONNX model directory (required for llm/hybrid/auto modes). */
	detectorModelDir: string | null;
	/** Minimum confidence threshold for LLM detections (0-1). Default: 0.5 */
	detectorThreshold: number | null;
	log: boolean;
	noLog: boolean;
	logDir: string | null;
	logMaxSessions: number;
	verbose: boolean;
	/** Enable at-rest encryption for captured logs. */
	enableEncryption: boolean;
	/** Enable OpenID Connect authentication. */
	enableOidc: boolean;
	/** OIDC issuer URL (e.g., https://accounts.google.com). */
	oidcIssuer: string | null;
	/** OIDC client ID. */
	oidcClientId: string | null;
	/** OIDC client secret. */
	oidcClientSecret: string | null;
	/** OIDC session secret for signing cookies. */
	oidcSessionSecret: string | null;
	/** Public-facing URL for the proxy (e.g., https://contextio.example.com).
	   * Used for OIDC callback URLs when behind a reverse proxy. */
	publicUrl: string | null;
	/** Command and args after "--" to wrap, or null for standalone proxy. */
	wrap: string[] | null;

	// Rate limiter plugin options
	/** Enable the rate limiter plugin. */
	enableRateLimiter: boolean;
	/** Rate limiter: max requests per window (default: 60, NVIDIA: 20). */
	rateLimitMaxRequests: number | null;
	/** Rate limiter: window in milliseconds (default: 60000). */
	rateLimitWindowMs: number | null;
	/** Rate limiter: buffer capacity for bursts (default: 10, NVIDIA: 5). */
	rateLimitBuffer: number | null;
	/** Rate limiter: per-provider max requests, comma-separated "provider:value,provider:value". */
	rateLimitPerProvider: string | null;

	// Retry plugin options
	/** Enable the retry plugin for 429/5xx responses. */
	enableRetry: boolean;
	/** Retry: max retry attempts (default: 3). */
	retryMaxRetries: number | null;
	/** Retry: initial delay in ms (default: 500). */
	retryBaseDelayMs: number | null;
	/** Retry: max delay cap in ms (default: 30000). */
	retryMaxDelayMs: number | null;
	/** Retry: comma-separated retryable HTTP status codes (default: 429,500,502,503,504). */
	retryRetryableStatuses: string | null;
	/** Retry: jitter factor 0-1 (default: 0.1). */
	retryJitterFactor: number | null;
}

/** Parsed arguments for `ctxio attach <tool>`. */
export interface AttachArgs {
	command: "attach";
	port: number;
	/** Command and args to run through the proxy. */
	wrap: string[];
}

/** Parsed arguments for `ctxio monitor`. */
export interface MonitorArgs {
	command: "monitor";
	session: string | null;
	/** Duration filter like "1h", "30m". Show recent captures then watch. */
	last: string | null;
	source: string | null;
	/** Test hook: render existing captures and return without starting fs.watch. */
	once?: boolean;
}

/** Parsed arguments for `ctxio inspect`. */
export interface InspectArgs {
	command: "inspect";
	session: string | null;
	/** Inspect the most recent session. */
	last: boolean;
	source: string | null;
	/** Show full system prompt without truncation. */
	full: boolean;
}

/** Parsed arguments for `ctxio doctor`. */
export interface DoctorArgs {
	command: "doctor";
}

/** Parsed arguments for `ctxio migrate`. */
export interface MigrateArgs {
	command: "migrate";
	/** Subcommand: captures, providers, or all */
	subcommand: "captures" | "providers" | "all";
	/** Options for captures migration */
	captureDir?: string;
	providersFile?: string;
	dryRun?: boolean;
	force?: boolean;
	keyMaterial?: string;
	noBackup?: boolean;
	maxFiles?: number;
}

/** Union of all successfully parsed command types. */
export type ParsedArgs =
	| ProxyArgs
	| AttachArgs
	| MonitorArgs
	| InspectArgs
	| DoctorArgs
	| MigrateArgs;

/** Returned when argument parsing fails. */
export interface ParseError {
	error: string;
}

/** Either a successfully parsed command or a parse error. */
export type ParseResult = ParsedArgs | ParseError;

/** Type guard for ParseError. */
export function isError(result: ParseResult): result is ParseError {
	return "error" in result;
}

/** Build the Commander program with all subcommands. Results are emitted via callback. */
export function buildProgram(
	onResult: (result: ParseResult) => void,
): Command {
	const program = new Command()
		.name("ctxio")
		.description("LLM API proxy toolkit")
		.version(CLI_VERSION, "-v, --version")
		.enablePositionalOptions()
		.exitOverride()
		.configureOutput({ writeErr: () => {}, writeOut: () => {} });

	// --- proxy ---
	const proxy = program
		.command("proxy")
		.description("Start the LLM API proxy")
		.usage("[options] [-- <command> [args...]]")
		.option("-p, --port <number>", "port to listen on (default: 4040)")
		.option("--bind <host>", "bind address (default: 127.0.0.1)")
		.option("-d, --detach", "daemonize the proxy (run in background)")
		.option("-r, --redact", "enable PII/secret redaction (default preset: pii)")
		.option("-P, --redact-preset <name>", "preset: secrets, pii, strict")
		.option("-f, --redact-policy <path>", "path to a redaction policy JSON file")
		.option("-R, --redact-reversible", "restore redacted values in responses")
		.option("--detector-mode <mode>", "detector mode: rules, llm, hybrid, auto")
		.option("--detector-model-dir <path>", "path to GLiNER ONNX model directory")
		.option("--detector-threshold <number>", "LLM detection confidence threshold (0-1)")
		.option("--no-log", "disable capture logging (on by default)")
		.option("--log-dir <path>", "directory for capture files")
		.option("--log-max-sessions <n>", "keep only the last N sessions (default: 0)")
		.option(
			"--enable-encryption",
			"enable at-rest encryption for captured logs (key from CONTEXTIO_LOGGER_ENCRYPTION_KEY env var)",
		)
		.option("--verbose", "show per-request traffic logs")
		.option("--enable-oidc", "enable OpenID Connect authentication")
		.option("--oidc-issuer <url>", "OIDC issuer URL (e.g., https://accounts.google.com)")
		.option("--oidc-client-id <id>", "OIDC client ID")
		.option("--oidc-client-secret <secret>", "OIDC client secret")
		.option("--oidc-session-secret <secret>", "OIDC session secret for signing cookies")
		.option(
			"--oidc-public-url <url>",
			"public-facing URL for the proxy (e.g., https://contextio.example.com)",
		)
		.option("--enable-rate-limiter", "enable rate limiter plugin to prevent upstream 429s")
		.option("--rate-limit-max-requests <number>", "rate limiter: max requests per window (default: 60, NVIDIA: 20)")
		.option("--rate-limit-window-ms <number>", "rate limiter: window in milliseconds (default: 60000)")
		.option("--rate-limit-buffer <number>", "rate limiter: buffer capacity for bursts (default: 10, NVIDIA: 5)")
		.option("--rate-limit-per-provider <string>", 'rate limiter: per-provider max requests, e.g. "nvidia:20,openai:100"')
		.option("--enable-retry", "enable retry plugin for 429/5xx responses with exponential backoff")
		.option("--retry-max-retries <number>", "retry: max retry attempts (default: 3)")
		.option("--retry-base-delay-ms <number>", "retry: initial delay in ms (default: 500)")
		.option("--retry-max-delay-ms <number>", "retry: max delay cap in ms (default: 30000)")
		.option("--retry-retryable-statuses <string>", "retry: comma-separated retryable HTTP status codes (default: 429,500,502,503,504)")
		.option("--retry-jitter-factor <number>", "retry: jitter factor 0-1 (default: 0.1)")
		.allowUnknownOption(false)
		.passThroughOptions()
		.argument("[command-args...]")
		.exitOverride();

	proxy.action((commandArgs, opts) => {
		// "proxy stop" and "proxy status" are special actions
		if (
			commandArgs.length === 1 &&
			(commandArgs[0] === "stop" || commandArgs[0] === "status")
		) {
			onResult({
				command: "proxy",
				action: commandArgs[0],
				port: opts.port ? parseInt(opts.port, 10) : 0,
				bind: "",
				detach: false,
				redact: false,
				redactPreset: "pii",
				redactPolicy: null,
				redactReversible: false,
				detectorMode: "rules",
				detectorModelDir: null,
				detectorThreshold: null,
				log: true,
				noLog: false,
				logDir: null,
				logMaxSessions: 0,
				verbose: false,
				enableEncryption: opts.enableEncryption || false,
				enableOidc: false,
				oidcIssuer: null,
				oidcClientId: null,
				oidcClientSecret: null,
				oidcSessionSecret: null,
				publicUrl: null,
				wrap: null,
				enableRateLimiter: false,
				rateLimitMaxRequests: null,
				rateLimitWindowMs: null,
				rateLimitBuffer: null,
				rateLimitPerProvider: null,
				enableRetry: false,
				retryMaxRetries: null,
				retryBaseDelayMs: null,
				retryMaxDelayMs: null,
				retryRetryableStatuses: null,
				retryJitterFactor: null,
			});
			return;
		}

		// Validate required OIDC options when --enable-oidc is set
		if (opts.enableOidc) {
			const missing: string[] = [];
			if (!opts.oidcIssuer) missing.push("--oidc-issuer");
			if (!opts.oidcClientId) missing.push("--oidc-client-id");
			if (!opts.oidcClientSecret) missing.push("--oidc-client-secret");
			if (!opts.oidcSessionSecret) missing.push("--oidc-session-secret");
			if (missing.length > 0) {
				onResult({
					error: `OIDC enabled but missing required options: ${missing.join(", ")}`,
				});
				return;
			}
		}

		// Validate detector mode and required options
		const detectorMode = (opts.detectorMode || "rules") as "rules" | "llm" | "hybrid" | "auto";
		if (!["rules", "llm", "hybrid", "auto"].includes(detectorMode)) {
			onResult({
				error: `Invalid detector mode: ${detectorMode}. Must be one of: rules, llm, hybrid, auto`,
			});
			return;
		}

		// LLM/hybrid/auto modes require a model directory
		if (detectorMode !== "rules" && !opts.detectorModelDir) {
			onResult({
				error: `Detector mode "${detectorMode}" requires --detector-model-dir to be set`,
			});
			return;
		}

		// Validate detector threshold if provided
		if (opts.detectorThreshold !== undefined) {
			const threshold = parseFloat(opts.detectorThreshold);
			if (isNaN(threshold) || threshold < 0 || threshold > 1) {
				onResult({
					error: `Invalid --detector-threshold: must be a number between 0 and 1`,
				});
				return;
			}
		}

		// Validate rate limiter options
		if (opts.rateLimitMaxRequests !== undefined) {
			const val = parseInt(opts.rateLimitMaxRequests, 10);
			if (isNaN(val) || val < 1) {
				onResult({ error: `--rate-limit-max-requests must be a positive integer` });
				return;
			}
		}
		if (opts.rateLimitWindowMs !== undefined) {
			const val = parseInt(opts.rateLimitWindowMs, 10);
			if (isNaN(val) || val < 100) {
				onResult({ error: `--rate-limit-window-ms must be >= 100` });
				return;
			}
		}
		if (opts.rateLimitBuffer !== undefined) {
			const val = parseInt(opts.rateLimitBuffer, 10);
			if (isNaN(val) || val < 0) {
				onResult({ error: `--rate-limit-buffer must be a non-negative integer` });
				return;
			}
		}
		if (opts.rateLimitPerProvider !== undefined) {
			// Validate format: "provider:value,provider:value"
			const pairs = opts.rateLimitPerProvider.split(",").map((s: string) => s.trim()).filter(Boolean);
			for (const pair of pairs) {
				const [provider, value] = pair.split(":");
				if (!provider || !value || isNaN(parseInt(value, 10)) || parseInt(value, 10) < 1) {
					onResult({ error: `--rate-limit-per-provider must be in format "provider:value,provider:value" (e.g., "nvidia:20,openai:100")` });
					return;
				}
			}
		}

		// Validate retry options
		if (opts.retryMaxRetries !== undefined) {
			const val = parseInt(opts.retryMaxRetries, 10);
			if (isNaN(val) || val < 0) {
				onResult({ error: `--retry-max-retries must be a non-negative integer` });
				return;
			}
		}
		if (opts.retryBaseDelayMs !== undefined) {
			const val = parseInt(opts.retryBaseDelayMs, 10);
			if (isNaN(val) || val < 0) {
				onResult({ error: `--retry-base-delay-ms must be a non-negative integer` });
				return;
			}
		}
		if (opts.retryMaxDelayMs !== undefined) {
			const val = parseInt(opts.retryMaxDelayMs, 10);
			if (isNaN(val) || val < 0) {
				onResult({ error: `--retry-max-delay-ms must be a non-negative integer` });
				return;
			}
		}
		if (opts.retryJitterFactor !== undefined) {
			const val = parseFloat(opts.retryJitterFactor);
			if (isNaN(val) || val < 0 || val > 1) {
				onResult({ error: `--retry-jitter-factor must be a number between 0 and 1` });
				return;
			}
		}
		if (opts.retryRetryableStatuses !== undefined) {
			// Validate format: comma-separated HTTP status codes
			const codes = opts.retryRetryableStatuses.split(",").map((s: string) => s.trim()).filter(Boolean);
			for (const code of codes) {
				const val = parseInt(code, 10);
				if (isNaN(val) || val < 100 || val > 599) {
					onResult({ error: `--retry-retryable-statuses must be comma-separated HTTP status codes (100-599), e.g., "429,500,502,503,504"` });
					return;
				}
			}
		}

		const wrap = commandArgs.length > 0 ? commandArgs : null;

		const redact =
			opts.redact ||
			!!opts.redactPreset ||
			!!opts.redactPolicy ||
			opts.redactReversible ||
			false;

		const noLog = opts.log === false;
		const log = opts.logDir ? true : !noLog;

		onResult({
			command: "proxy",
			action: "start",
			port: opts.port ? parseInt(opts.port, 10) : 0,
			bind: opts.bind || "",
			detach: opts.detach || false,
			redact,
			redactPreset: opts.redactPreset || "pii",
			redactPolicy: opts.redactPolicy || null,
			redactReversible: opts.redactReversible || false,
			detectorMode,
			detectorModelDir: opts.detectorModelDir || null,
			detectorThreshold: opts.detectorThreshold ? parseFloat(opts.detectorThreshold) : null,
			log,
			noLog,
			logDir: opts.logDir || null,
			logMaxSessions: opts.logMaxSessions ? parseInt(opts.logMaxSessions, 10) : 0,
			verbose: opts.verbose || false,
			enableEncryption: opts.enableEncryption || false,
			enableOidc: opts.enableOidc || false,
			oidcIssuer: opts.oidcIssuer || null,
			oidcClientId: opts.oidcClientId || null,
			oidcClientSecret: opts.oidcClientSecret || null,
			oidcSessionSecret: opts.oidcSessionSecret || null,
			publicUrl: opts.oidcPublicUrl || null,
			wrap,
			enableRateLimiter: opts.enableRateLimiter || false,
			rateLimitMaxRequests: opts.rateLimitMaxRequests ? parseInt(opts.rateLimitMaxRequests, 10) : null,
			rateLimitWindowMs: opts.rateLimitWindowMs ? parseInt(opts.rateLimitWindowMs, 10) : null,
			rateLimitBuffer: opts.rateLimitBuffer ? parseInt(opts.rateLimitBuffer, 10) : null,
			rateLimitPerProvider: opts.rateLimitPerProvider || null,
			enableRetry: opts.enableRetry || false,
			retryMaxRetries: opts.retryMaxRetries ? parseInt(opts.retryMaxRetries, 10) : null,
			retryBaseDelayMs: opts.retryBaseDelayMs ? parseInt(opts.retryBaseDelayMs, 10) : null,
			retryMaxDelayMs: opts.retryMaxDelayMs ? parseInt(opts.retryMaxDelayMs, 10) : null,
			retryRetryableStatuses: opts.retryRetryableStatuses || null,
			retryJitterFactor: opts.retryJitterFactor ? parseFloat(opts.retryJitterFactor) : null,
		});
	});

	// --- attach ---
	program
		.command("attach")
		.description("Run a command through an already-running proxy")
		.usage("[options] <command> [args...]")
		.option("-p, --port <number>", "port the proxy is listening on")
		.passThroughOptions()
		.argument("<command-args...>")
		.exitOverride()
		.action((commandArgs, opts) => {
			onResult({
				command: "attach",
				port: opts.port ? parseInt(opts.port, 10) : 4040,
				wrap: commandArgs,
			});
		});

	// --- monitor ---
	program
		.command("monitor")
		.description("Watch for API traffic in real-time")
		.argument("[session]", "session ID to watch")
		.option("--last <duration>", "show recent captures, then watch (1h, 30m, 60s)")
		.option("--source <name>", "filter by source tool (claude, codex, copilot)")
		.exitOverride()
		.action((session, opts) => {
			onResult({
				command: "monitor",
				session: session || null,
				last: opts.last || null,
				source: opts.source || null,
			});
		});

	// --- inspect ---
	program
		.command("inspect")
		.description("List sessions or inspect prompts and tool definitions")
		.argument("[session]", "session ID to inspect")
		.option("--last", "inspect the most recent session")
		.option("--source <name>", "filter by tool (claude, codex, copilot)")
		.option("--full", "show full system prompt (don't truncate)")
		.exitOverride()
		.action((session, opts) => {
			onResult({
				command: "inspect",
				session: session || null,
				last: opts.last || false,
				source: opts.source || null,
				full: opts.full || false,
			});
		});

	// --- doctor ---
	program
		.command("doctor")
		.description("Run local diagnostics (ports, certs, capture dir)")
		.exitOverride()
		.action(() => {
			onResult({ command: "doctor" });
		});

	// --- migrate ---
	const migrate = program
		.command("migrate")
		.description("Database migration utilities")
		.addHelpText("after", `
Examples:
  $ contextio migrate captures                    # Index all capture files
  $ contextio migrate captures --dry-run          # Preview capture migration
  $ contextio migrate captures --force            # Re-index all captures
  $ contextio migrate captures --max-files 100    # Limit for testing
  $ contextio migrate providers                   # Import providers from JSON
  $ contextio migrate providers --dry-run         # Preview provider migration
  $ contextio migrate providers --no-backup       # Skip backup creation
  $ contextio migrate all                         # Run both migrations
  $ contextio migrate all --dry-run               # Preview all migrations
		`);

	// Capture migration subcommand
	migrate
		.command("captures")
		.description("Index existing capture files into SQLite")
		.option("--capture-dir <path>", "Custom capture directory (default: ~/.contextio/captures or LOGGER_CAPTURE_DIR)")
		.option("--dry-run", "Preview changes without writing to database")
		.option("--force", "Re-index already indexed captures")
		.option("--key-material <key>", "Encryption key for decrypting encrypted captures")
		.option("--max-files <number>", "Maximum files to process (for testing)")
		.action((opts) => {
			const maxFiles = opts.maxFiles ? parseInt(opts.maxFiles, 10) : undefined;
			if (maxFiles !== undefined && (isNaN(maxFiles) || maxFiles < 1)) {
				onResult({ error: `--max-files must be a positive integer` });
				return;
			}
			onResult({
				command: "migrate",
				subcommand: "captures",
				captureDir: opts.captureDir,
				dryRun: opts.dryRun,
				force: opts.force,
				keyMaterial: opts.keyMaterial,
				maxFiles,
			});
		});

	// Provider migration subcommand
	migrate
		.command("providers")
		.description("Import providers from providers.json into SQLite")
		.option("--providers-file <path>", "Path to providers.json (default: /app/custom-policy/providers.json or PROVIDERS_FILE env)")
		.option("--dry-run", "Preview changes without writing to database")
		.option("--force", "Re-import already imported providers")
		.option("--no-backup", "Skip creating backup of providers.json")
		.action((opts) => {
			onResult({
				command: "migrate",
				subcommand: "providers",
				providersFile: opts.providersFile,
				dryRun: opts.dryRun,
				force: opts.force,
				noBackup: opts.noBackup,
			});
		});

	// All migrations subcommand
	migrate
		.command("all")
		.description("Run both capture and provider migrations")
		.option("--capture-dir <path>", "Custom capture directory")
		.option("--providers-file <path>", "Path to providers.json")
		.option("--dry-run", "Preview changes without writing to database")
		.option("--force", "Re-index/re-import existing entries")
		.option("--key-material <key>", "Encryption key for decrypting encrypted captures")
		.option("--no-backup", "Skip creating backup of providers.json")
		.option("--max-files <number>", "Maximum capture files to process (for testing)")
		.action((opts) => {
			const maxFiles = opts.maxFiles ? parseInt(opts.maxFiles, 10) : undefined;
			if (maxFiles !== undefined && (isNaN(maxFiles) || maxFiles < 1)) {
				onResult({ error: `--max-files must be a positive integer` });
				return;
			}
			onResult({
				command: "migrate",
				subcommand: "all",
				captureDir: opts.captureDir,
				providersFile: opts.providersFile,
				dryRun: opts.dryRun,
				force: opts.force,
				keyMaterial: opts.keyMaterial,
				noBackup: opts.noBackup,
				maxFiles,
			});
		});

	return program;
}

/** Parse process.argv into a typed result. Never calls process.exit on parse errors. */
export function parseArgs(argv: string[]): ParseResult {
	let result: ParseResult | null = null;

	const program = buildProgram((r) => {
		result = r;
	});

	// Capture Commander output so we can print it ourselves on
	// help/version instead of letting it call process.exit.
	let helpOutput = "";
	program.configureOutput({
		writeOut: (s: string) => {
			helpOutput += s;
		},
		writeErr: (s: string) => {
			helpOutput += s;
		},
	});

	try {
		program.parse(argv);
	} catch (err: unknown) {
		if (result) return result;

		const code = (err as { code?: string }).code;
		if (
			code === "commander.helpDisplayed" ||
			code === "commander.help" ||
			code === "commander.version"
		) {
			process.stdout.write(helpOutput);
			process.exit(0);
		}

		const message = err instanceof Error ? err.message : String(err);
		return { error: message };
	}

	if (result) return result;

	return { error: "No command specified" };
}

/** Get help text for a specific command or the top-level program. */
export function getHelp(topic?: string | null): string {
	const program = buildProgram(() => {});
	if (topic) {
		const cmd = program.commands.find((c) => c.name() === topic);
		if (cmd) return cmd.helpInformation();
		return `Unknown command: ${topic}\n\n${program.helpInformation()}`;
	}
	return program.helpInformation();
}