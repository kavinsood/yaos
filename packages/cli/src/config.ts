import { promises as fs } from "node:fs";
import os from "node:os";
import nodePath from "node:path";

export const EXIT = {
	ok: 0,
	failure: 1,
	fatalAuth: 2,
	locked: 17,
} as const;

export const USAGE = `Usage:
  YAOS_HOST=https://server YAOS_PAIRING_CODE=code yaos enroll <vaultPath>
  yaos daemon <vaultPath>

Commands:
  enroll  Enroll this vault path as a new, device-scoped headless client.
  daemon  Synchronize Markdown files after successful enrollment.

Environment:
  YAOS_HOST                              Required by enroll. Server origin.
  YAOS_PAIRING_CODE                      Required by enroll. One-time code.
  YAOS_STATE_DIR                         Optional explicit state leaf for this vault.
  XDG_STATE_HOME                         Optional state root when YAOS_STATE_DIR is unset.
  YAOS_TEST_ONLY_DROP_HINT               Test-only watcher loss injection.
  YAOS_TEST_ONLY_RECONCILE_INTERVAL_MS   Test-only authoritative scan period.

State:
  YAOS_STATE_DIR is used exactly when set; otherwise state defaults to:
  ~/.local/state/yaos/headless/<vault-name>-<path-hash>/
  Directories are mode 0700; enrollment.json and client.sqlite are mode 0600.
  Use the same YAOS_STATE_DIR for enroll and daemon. Credentials never belong
  in argv, and no state is written inside the vault.

Exit codes:
  0   enrollment succeeded or daemon shut down cleanly
  1   usage, configuration, enrollment, or runtime failure
  2   revoked membership, generation mismatch, or incompatible provisioning
  17  another live process holds the vault state lock
`;

export class ConfigError extends Error {
	constructor(message: string) {
		super(message);
		this.name = "ConfigError";
	}
}

export type CliCommand = "enroll" | "daemon";

export interface ParsedCommand {
	readonly command: CliCommand;
	readonly vaultPath: string;
}

export interface EnrollmentConfig extends ParsedCommand {
	readonly command: "enroll";
	readonly host: string;
	readonly pairingCode: string;
}

export interface DaemonConfig extends ParsedCommand {
	readonly command: "daemon";
	readonly reconcileIntervalMs: number;
	readonly debug: boolean;
}

export function parseArgs(argv: readonly string[]): ParsedCommand {
	const args = argv.slice(2);
	if (args.length === 0 || args[0] === "--help" || args[0] === "-h") throw new ConfigError(USAGE);
	const command = args[0];
	if (command !== "enroll" && command !== "daemon") {
		throw new ConfigError(`Unknown command: "${command}".\n\n${USAGE}`);
	}
	if (args.length !== 2 || !args[1]) {
		throw new ConfigError(`\`yaos ${command}\` requires exactly one <vaultPath>.\n\n${USAGE}`);
	}
	return { command, vaultPath: args[1] };
}

export async function resolveRealVaultPath(rawVaultPath: string): Promise<string> {
	const expanded = rawVaultPath === "~" || rawVaultPath.startsWith("~/")
		? nodePath.join(os.homedir(), rawVaultPath.slice(2))
		: rawVaultPath;
	const absolute = nodePath.resolve(expanded);
	let real: string;
	try {
		real = await fs.realpath(absolute);
	} catch (error) {
		throw new ConfigError(`Vault directory is not accessible: ${absolute} (${String(error)})`);
	}
	const stat = await fs.stat(real);
	if (!stat.isDirectory()) throw new ConfigError(`Vault path is not a directory: ${real}`);
	return real;
}

export function resolveStateDirectoryOverride(env: NodeJS.ProcessEnv): string | undefined {
	const raw = env.YAOS_STATE_DIR;
	if (raw === undefined) return undefined;
	const configured = raw.trim();
	if (!configured || configured.includes("\0")) {
		throw new ConfigError("YAOS_STATE_DIR must be a non-empty valid directory path");
	}
	return nodePath.resolve(configured);
}

export function normalizeHost(raw: string): string {
	let url: URL;
	try {
		url = new URL(raw.trim());
	} catch {
		throw new ConfigError("YAOS_HOST must be an absolute http(s) server origin");
	}
	if ((url.protocol !== "https:" && url.protocol !== "http:") || url.username || url.password
		|| (url.pathname !== "/" && url.pathname !== "") || url.search || url.hash) {
		throw new ConfigError("YAOS_HOST must be an http(s) origin without credentials, path, query, or fragment");
	}
	return url.origin;
}

export function resolveEnrollmentConfig(parsed: ParsedCommand, env: NodeJS.ProcessEnv): EnrollmentConfig {
	if (parsed.command !== "enroll") throw new ConfigError("Internal command mismatch");
	const missing: string[] = [];
	if (!(env.YAOS_HOST ?? "").trim()) missing.push("YAOS_HOST");
	if (!(env.YAOS_PAIRING_CODE ?? "").trim()) missing.push("YAOS_PAIRING_CODE");
	if (missing.length > 0) throw new ConfigError(`Missing required environment: ${missing.join(", ")}.\n\n${USAGE}`);
	const pairingCode = env.YAOS_PAIRING_CODE!.trim();
	if (pairingCode.length < 8 || pairingCode.length > 512) {
		throw new ConfigError("YAOS_PAIRING_CODE must contain between 8 and 512 characters");
	}
	return { ...parsed, command: "enroll", host: normalizeHost(env.YAOS_HOST!), pairingCode };
}

export function resolveDaemonConfig(parsed: ParsedCommand, env: NodeJS.ProcessEnv): DaemonConfig {
	if (parsed.command !== "daemon") throw new ConfigError("Internal command mismatch");
	const rawInterval = (env.YAOS_TEST_ONLY_RECONCILE_INTERVAL_MS ?? "").trim();
	let reconcileIntervalMs = 60_000;
	if (rawInterval) {
		const value = Number(rawInterval);
		if (!Number.isFinite(value) || value < 50) {
			throw new ConfigError("YAOS_TEST_ONLY_RECONCILE_INTERVAL_MS must be at least 50 milliseconds");
		}
		reconcileIntervalMs = Math.floor(value);
	}
	const debug = /^(?:1|true|yes)$/i.test((env.YAOS_DEBUG ?? "").trim());
	return { ...parsed, command: "daemon", reconcileIntervalMs, debug };
}
