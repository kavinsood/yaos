/**
 * Shared helpers for the relay v2 harness: stats, args, run metadata, output.
 */
import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";

export const EXP_ROOT = "/Users/kavin/personal/obsidiansync/experiments";
export const LOG_DIR = join(EXP_ROOT, "logs/relay2");
export const WORKTREE = join(EXP_ROOT, "yaos-relay2");
export const BASE_SHA = "5dd32f31d3c380605db44558d089d37adaa293d5";
export const WARMUP_DISCARD = 10;

export const now = () => performance.now();
export const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));
export const r2 = (v: number) => Math.round(v * 100) / 100;

export interface Summary { n: number; min: number; p50: number; p90: number; p99: number; max: number; mean: number }

export function dist(values: readonly (number | null | undefined)[]): Summary | null {
	const clean = values.filter((v): v is number => typeof v === "number" && Number.isFinite(v));
	if (clean.length === 0) return null;
	const s = [...clean].sort((a, b) => a - b);
	const p = (f: number) => s[Math.min(s.length - 1, Math.max(0, Math.ceil(s.length * f) - 1))]!;
	return { n: s.length, min: r2(s[0]!), p50: r2(p(0.5)), p90: r2(p(0.9)), p99: r2(p(0.99)), max: r2(s.at(-1)!),
		mean: r2(s.reduce((a, b) => a + b, 0) / s.length) };
}

/** Summary after discarding the first WARMUP_DISCARD samples (brief §6.1). Raw samples stay in the JSON. */
export function series(values: readonly (number | null | undefined)[], discard = WARMUP_DISCARD) {
	const kept = values.length > discard ? values.slice(discard) : values;
	return { discarded: values.length > discard ? discard : 0, lost: kept.filter((v) => v === null || v === undefined).length,
		summary: dist(kept) };
}

export interface Args { positional: string[]; flags: Record<string, string | true> }
export function parseArgs(argv = process.argv.slice(2)): Args {
	const positional: string[] = [];
	const flags: Record<string, string | true> = {};
	for (let i = 0; i < argv.length; i++) {
		const a = argv[i]!;
		if (a.startsWith("--")) {
			const eq = a.indexOf("=");
			if (eq > 0) flags[a.slice(2, eq)] = a.slice(eq + 1);
			else if (i + 1 < argv.length && !argv[i + 1]!.startsWith("--")) flags[a.slice(2)] = argv[++i]!;
			else flags[a.slice(2)] = true;
		} else positional.push(a);
	}
	return { positional, flags };
}
export function flagNum(args: Args, name: string, fallback: number): number {
	const v = args.flags[name];
	return typeof v === "string" ? Number(v) : fallback;
}
export function flagStr(args: Args, name: string, fallback?: string): string | undefined {
	const v = args.flags[name];
	return typeof v === "string" ? v : fallback;
}

export async function json(response: Response): Promise<Record<string, unknown> | null> {
	return await response.clone().json().catch(() => null) as Record<string, unknown> | null;
}

export function workerName(host: string): string {
	return new URL(host).hostname.split(".")[0]!;
}

function sh(cmd: string, args: string[]): string {
	try { return execFileSync(cmd, args, { encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] }).trim(); }
	catch { return ""; }
}

/** Deploy record written by deploy.sh (version id, vars, bundle size). */
export function deployRecord(host: string): Record<string, unknown> | null {
	const path = join(LOG_DIR, `deploy-${workerName(host)}.json`);
	return existsSync(path) ? JSON.parse(readFileSync(path, "utf8")) as Record<string, unknown> : null;
}

export async function edgeColo(host: string): Promise<{ cfRay: string | null; colo: string | null }> {
	try {
		const response = await fetch(`${host}/api/capabilities`);
		await response.arrayBuffer();
		const ray = response.headers.get("cf-ray");
		return { cfRay: ray, colo: ray?.split("-").at(-1) ?? null };
	} catch { return { cfRay: null, colo: null }; }
}

/** Processes that could perturb latency (other harness runs, tails). */
export function competingProcesses(): string[] {
	return sh("pgrep", ["-fl", "run-typescript|wrangler tail|measure-"]).split("\n")
		.filter((line) => /^\d+ /.test(line) && !line.startsWith(`${process.pid} `) && !line.startsWith(`${process.ppid} `))
		.map((line) => line.slice(0, 200));
}

export interface RunMeta {
	scenario: string; host: string; workerName: string; deploymentVersionId: string | null;
	baseSha: string; spikeSha: string; spikeDirty: boolean; vars: unknown; relay: boolean | null;
	startedAt: string; endedAt?: string; edge: { cfRay: string | null; colo: string | null };
	competingProcesses: string[]; argv: string[]; protocolAdapter: string;
}

export async function startMeta(scenario: string, host: string, adapter: string): Promise<RunMeta> {
	const deploy = deployRecord(host);
	return {
		scenario, host, workerName: workerName(host),
		deploymentVersionId: (deploy?.deploymentVersionId as string | undefined) ?? null,
		baseSha: BASE_SHA,
		spikeSha: sh("git", ["-C", WORKTREE, "rev-parse", "HEAD"]),
		spikeDirty: sh("git", ["-C", WORKTREE, "status", "--porcelain", "--", "server/src", "src", "scripts/relay2"]).length > 0,
		deployedSpikeSha: deploy?.spikeSha ?? null,
		vars: deploy?.vars ?? null,
		relay: typeof deploy?.relay === "boolean" ? deploy.relay : null,
		startedAt: new Date().toISOString(),
		edge: await edgeColo(host),
		competingProcesses: competingProcesses(),
		argv: process.argv.slice(2),
		protocolAdapter: adapter,
	} as RunMeta;
}

export function writeResult(out: string, meta: RunMeta, body: Record<string, unknown>) {
	mkdirSync(dirname(out), { recursive: true });
	const value = { ...meta, endedAt: new Date().toISOString(), ...body };
	writeFileSync(out, JSON.stringify(value, null, 2) + "\n");
	console.log(`[relay2] wrote ${out}`);
}

export function log(...parts: unknown[]) {
	console.log(`[relay2 ${new Date().toISOString().slice(11, 23)}]`, ...parts);
}
