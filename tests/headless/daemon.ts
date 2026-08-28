import { spawn, spawnSync, type ChildProcess } from "node:child_process";
import { existsSync } from "node:fs";
import { resolve } from "node:path";
import { repoRoot } from "../harness.ts";

export const CLI_ENTRY = "packages/cli/src/index.ts";
export const READY_TIMEOUT_MS = 90_000;
const EXIT_TIMEOUT_MS = 20_000;
const OUTPUT_CAP = 256 * 1024;
const DROP_HINT_ENV = "YAOS_TEST_ONLY_DROP_HINT";
const RECONCILE_INTERVAL_ENV = "YAOS_TEST_ONLY_RECONCILE_INTERVAL_MS";
const PERIODIC_BARRIER_ENV = "YAOS_TEST_ONLY_PERIODIC_RECONCILE_BARRIER";
const REPO = repoRoot();

export interface ExitStatus {
	readonly code: number | null;
	readonly signal: NodeJS.Signals | null;
}

export interface CliEnvironment {
	readonly xdgStateHome: string;
	readonly host?: string;
	readonly pairingCode?: string;
	readonly dropHintsMarker?: string;
	readonly reconcileIntervalMs?: number;
	readonly periodicBarrierFile?: string;
}

export interface DaemonOptions extends CliEnvironment {
	readonly vaultPath: string;
	readonly vaultId: string;
}

class OutputLog {
	private value = "";
	private dropped = 0;

	append(chunk: string): void {
		this.value += chunk;
		if (this.value.length <= OUTPUT_CAP) return;
		const excess = this.value.length - OUTPUT_CAP;
		this.value = this.value.slice(excess);
		this.dropped += excess;
	}

	text(): string {
		return `${this.dropped > 0 ? `[…${String(this.dropped)} earlier byte(s) dropped…]\n` : ""}${this.value}`;
	}
}

export interface CliProcess {
	readonly pid: number;
	readonly argv: readonly string[];
	readonly declaredEnv: Readonly<Record<string, string>>;
	stdout(): string;
	stderr(): string;
	dump(): string;
	exitStatus(): ExitStatus | null;
	waitForExit(timeoutMs?: number): Promise<ExitStatus>;
	stop(signal?: NodeJS.Signals): Promise<ExitStatus>;
}

export interface Daemon extends CliProcess {
	waitForReady(timeoutMs?: number): Promise<void>;
	readyLines(): readonly string[];
	authoritativeReconciles(): readonly string[];
	deleteCandidates(): readonly string[];
	withdrawnDeleteCandidates(): readonly string[];
	confirmedDeletes(): readonly string[];
	reconcileDeferrals(): readonly string[];
	preservedUnresolved(): readonly string[];
	preservedRetired(): readonly string[];
	shutdownDiagnostics(): readonly string[];
}

function cliInvocation(command: "enroll" | "daemon", vaultPath: string): { executable: string; args: string[] } {
	const override = process.env.YAOS_HEADLESS_CLI_ENTRY;
	if (override) return { executable: process.execPath, args: [resolve(override), command, vaultPath] };
	return {
		executable: process.execPath,
		args: ["--import", "jiti/register", resolve(REPO, CLI_ENTRY), command, vaultPath],
	};
}

function aliases(): Record<string, string> {
	const preferredShim = resolve(REPO, "packages/cli/src/obsidian-shim.ts");
	return {
		yjs: resolve(REPO, "node_modules/yjs/dist/yjs.mjs"),
		obsidian: existsSync(preferredShim) ? preferredShim : resolve(REPO, "tests/mocks/obsidian.ts"),
		partyserver: resolve(REPO, "tests/mocks/partyserver.ts"),
		"@shared": resolve(REPO, "server/src/shared"),
	};
}

function processEnvironment(options: CliEnvironment): { inherited: NodeJS.ProcessEnv; declared: Record<string, string> } {
	const inherited = { ...process.env };
	delete inherited.YAOS_HOST;
	delete inherited.YAOS_PAIRING_CODE;
	delete inherited.YAOS_TOKEN;
	delete inherited.SYNC_TOKEN;
	delete inherited[DROP_HINT_ENV];
	delete inherited[RECONCILE_INTERVAL_ENV];
	delete inherited[PERIODIC_BARRIER_ENV];
	const declared: Record<string, string> = {
		XDG_STATE_HOME: options.xdgStateHome,
		JITI_ALIAS: JSON.stringify(aliases()),
	};
	if (options.host !== undefined) declared.YAOS_HOST = options.host;
	if (options.pairingCode !== undefined) declared.YAOS_PAIRING_CODE = options.pairingCode;
	if (options.dropHintsMarker !== undefined) declared[DROP_HINT_ENV] = options.dropHintsMarker;
	if (options.reconcileIntervalMs !== undefined) declared[RECONCILE_INTERVAL_ENV] = String(options.reconcileIntervalMs);
	if (options.periodicBarrierFile !== undefined) declared[PERIODIC_BARRIER_ENV] = options.periodicBarrierFile;
	return { inherited, declared };
}

function spawnCli(command: "enroll" | "daemon", vaultPath: string, environment: CliEnvironment): CliProcess {
	const invocation = cliInvocation(command, vaultPath);
	const { inherited, declared } = processEnvironment(environment);
	const child = spawn(invocation.executable, invocation.args, {
		cwd: REPO,
		detached: true,
		stdio: ["ignore", "pipe", "pipe"],
		env: { ...inherited, ...declared },
	});
	const stdout = new OutputLog();
	const stderr = new OutputLog();
	child.stdout?.setEncoding("utf8");
	child.stderr?.setEncoding("utf8");
	child.stdout?.on("data", (chunk: string) => stdout.append(chunk));
	child.stderr?.on("data", (chunk: string) => stderr.append(chunk));
	let exit: ExitStatus | null = null;
	let spawnError: Error | null = null;
	const waiters = new Set<() => void>();
	child.once("error", (error: Error) => {
		spawnError = error;
		for (const wake of waiters) wake();
		waiters.clear();
	});
	child.once("exit", (code, signal) => {
		exit = { code, signal };
		for (const wake of waiters) wake();
		waiters.clear();
	});
	const argv = [invocation.executable, ...invocation.args];
	const dump = () => [
		"--- cli argv ---",
		argv.join(" "),
		"--- cli env (declared; pairing code redacted) ---",
		Object.entries(declared).map(([key, value]) => `${key}=${key === "YAOS_PAIRING_CODE" ? "<redacted>" : value}`).join("\n"),
		"--- cli stdout ---",
		stdout.text() || "<empty>",
		"--- cli stderr ---",
		stderr.text() || "<empty>",
		"--- end cli output ---",
	].join("\n");

	const waitForExit = async (timeoutMs = EXIT_TIMEOUT_MS): Promise<ExitStatus> => {
		const deadline = Date.now() + timeoutMs;
		while (exit === null) {
			if (spawnError !== null) throw new Error(`CLI failed to spawn: ${(spawnError as Error).message}\n${dump()}`);
			const remaining = deadline - Date.now();
			if (remaining <= 0) throw new Error(`CLI did not exit within ${String(timeoutMs)}ms\n${dump()}`);
			let wake = (): void => {};
			await new Promise<void>((resolvePromise) => {
				const timer = setTimeout(resolvePromise, Math.min(remaining, 100));
				wake = () => { clearTimeout(timer); resolvePromise(); };
				waiters.add(wake);
			});
			waiters.delete(wake);
		}
		return exit;
	};

	return {
		pid: child.pid ?? -1,
		argv,
		declaredEnv: declared,
		stdout: () => stdout.text(),
		stderr: () => stderr.text(),
		dump,
		exitStatus: () => exit,
		waitForExit,
		async stop(signal: NodeJS.Signals = "SIGTERM"): Promise<ExitStatus> {
			if (exit !== null) return exit;
			signalGroup(child, signal);
			try {
				return await waitForExit(EXIT_TIMEOUT_MS);
			} catch {
				signalGroup(child, "SIGKILL");
				return await waitForExit(5_000);
			}
		},
	};
}

export function startEnrollment(vaultPath: string, environment: Required<Pick<CliEnvironment, "xdgStateHome" | "host" | "pairingCode">>): CliProcess {
	return spawnCli("enroll", vaultPath, environment);
}

export async function enroll(vaultPath: string, environment: Required<Pick<CliEnvironment, "xdgStateHome" | "host" | "pairingCode">>): Promise<CliProcess> {
	const child = startEnrollment(vaultPath, environment);
	try {
		await child.waitForExit();
		return child;
	} catch (error) {
		await child.stop("SIGKILL").catch(() => undefined);
		throw error;
	}
}

export function startDaemon(options: DaemonOptions): Daemon {
	const process = spawnCli("daemon", options.vaultPath, options);
	const readyLines: string[] = [];
	const reconciles: string[] = [];
	const candidates: string[] = [];
	const withdrawn: string[] = [];
	const confirmed: string[] = [];
	const deferrals: string[] = [];
	const preserved: string[] = [];
	const retired: string[] = [];
	const shutdownDiagnostics: string[] = [];
	let stdoutCursor = 0;
	let stderrCursor = 0;
	let pendingOut = "";
	let pendingErr = "";
	const parse = () => {
		const out = process.stdout();
		pendingOut += out.slice(stdoutCursor);
		stdoutCursor = out.length;
		const outLines = pendingOut.split("\n");
		pendingOut = outLines.pop() ?? "";
		for (const line of outLines) if (line.startsWith("YAOS_DAEMON_READY")) readyLines.push(line.trimEnd());
		const err = process.stderr();
		pendingErr += err.slice(stderrCursor);
		stderrCursor = err.length;
		const errLines = pendingErr.split("\n");
		pendingErr = errLines.pop() ?? "";
		for (const line of errLines) {
			if (/reconcile-complete|Reconciliation \[authoritative\] complete:/.test(line)) reconciles.push(line.trim());
			if (/\bdelete-candidate\b|Delete candidate recorded:/.test(line)) candidates.push(line.trim());
			if (/\bdelete-withdrawn\b|Delete candidate withdrawn:/.test(line)) withdrawn.push(line.trim());
			if (/\bdelete-confirmed\b|Reconcile confirmed a dropped local delete:/.test(line)) confirmed.push(line.trim());
			if (/\breconcile-deferred\b|Reconcile deferred: \d+ path\(s\) under delete review/.test(line)) {
				deferrals.push(line.trim());
			}
			if (/\bpreserved-unresolved\b/.test(line)) preserved.push(line.trim());
			if (/\bpreserved-retired\b/.test(line)) retired.push(line.trim());
			if (/\bshutdown-|\bperiodic-reconcile-barrier-/.test(line)) shutdownDiagnostics.push(line.trim());
		}
	};
	const expected = `YAOS_DAEMON_READY ${options.vaultId}`;
	return {
		...process,
		async waitForReady(timeoutMs = READY_TIMEOUT_MS): Promise<void> {
			const deadline = Date.now() + timeoutMs;
			while (Date.now() < deadline) {
				parse();
				if (readyLines.includes(expected)) return;
				if (readyLines.length > 0) throw new Error(`daemon announced the wrong vault; expected ${expected}\n${process.dump()}`);
				const status = process.exitStatus();
				if (status !== null) throw new Error(`daemon exited before readiness (code=${String(status.code)} signal=${String(status.signal)})\n${process.dump()}`);
				await new Promise((resolvePromise) => setTimeout(resolvePromise, 100));
			}
			throw new Error(`daemon did not print ${expected} within ${String(timeoutMs)}ms\n${process.dump()}`);
		},
		readyLines: () => { parse(); return readyLines; },
		authoritativeReconciles: () => { parse(); return reconciles; },
		deleteCandidates: () => { parse(); return candidates; },
		withdrawnDeleteCandidates: () => { parse(); return withdrawn; },
		confirmedDeletes: () => { parse(); return confirmed; },
		reconcileDeferrals: () => { parse(); return deferrals; },
		preservedUnresolved: () => { parse(); return preserved; },
		preservedRetired: () => { parse(); return retired; },
		shutdownDiagnostics: () => { parse(); return shutdownDiagnostics; },
	};
}

function signalGroup(child: ChildProcess, signal: NodeJS.Signals): void {
	if (child.pid === undefined) return;
	try {
		process.kill(-child.pid, signal);
	} catch {
		try { child.kill(signal); } catch { /* already gone */ }
	}
}

export function orphanPids(needle: string): { readonly pids: number[]; readonly available: boolean } {
	const result = spawnSync("pgrep", ["-f", needle], { encoding: "utf8" });
	if (result.error !== undefined || (result.status !== 0 && result.status !== 1)) return { pids: [], available: false };
	const pids = (result.stdout ?? "").split("\n").map((line) => Number(line.trim()))
		.filter((pid) => Number.isInteger(pid) && pid > 0 && pid !== process.pid);
	return { pids, available: true };
}
