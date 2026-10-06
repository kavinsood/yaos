/**
 * Black-box conformance suite for the YAOS streams relay (docs/client-remake/relay-wire.md + the server-remake
 * decisions). Standalone: global fetch + WebSocket, no npm deps, no imports from src/, server/ or legacy-src/.
 *
 *   node e2e/conformance/run.ts --host <url> --label <label> [--operator-context <file>] [--only ID,ID] [--skip-slow]
 *                               [--log-dir <dir>]
 *
 * Every run creates fresh vaults through the operator console (claimed server; key read from the
 * --operator-context JSON field operatorRecoveryKey, never printed, never written). Results (no secrets) go to
 * <log dir>/conformance-<label>-<UTC stamp>.json; a summary table prints to stdout.
 * Exit code: 1 when a baseline test FAILs (decision/hardening FAILs are expected before the rewrite), else 0.
 */
import { execFileSync } from "node:child_process";
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type { Ctx } from "./lib/context.ts";
import { scrub } from "./lib/context.ts";
import { http } from "./lib/http.ts";
import { Recorder, table } from "./lib/results.ts";
import type { TestDef, TestResult } from "./lib/results.ts";
import { errorMessage, now, sleep } from "./lib/util.ts";
import { tests as happy } from "./tests/happy.ts";
import { tests as onboarding } from "./tests/onboarding.ts";
import { tests as socket } from "./tests/socket.ts";
import { tests as checkpoint } from "./tests/checkpoint.ts";
import { tests as misc } from "./tests/misc.ts";
import { tests as commit } from "./tests/commit.ts";
import { tests as operator } from "./tests/operator.ts";
import { tests as flags } from "./tests/flags.ts";
import { tests as revoke } from "./tests/revoke.ts";

function arg(name: string): string | undefined {
	const index = process.argv.indexOf(`--${name}`);
	return index > 0 ? process.argv[index + 1] : undefined;
}

const HOST = (arg("host") ?? "").replace(/\/+$/, "");
if (!/^https?:\/\//.test(HOST)) {
	console.error("usage: node e2e/conformance/run.ts --host <url> --label <label> [--operator-context <file>] [--only ID,ID] [--skip-slow]");
	process.exit(2);
}
const LABEL = arg("label") ?? "run";
const LOG_DIR = arg("log-dir") ?? process.env.YAOS_E2E_LOG_DIR ?? "/Users/kavin/personal/obsidiansync/experiments/logs";
const ONLY = arg("only")?.split(",").map((s) => s.trim()).filter(Boolean) ?? null;
const SKIP_SLOW = process.argv.includes("--skip-slow");
const STARTED = new Date();
const STAMP = STARTED.toISOString().replace(/[-:]/g, "").replace(/\.\d+Z$/, "Z");

// Order matters: shared fixtures first, destructive / revoking tests last.
const ALL: TestDef[] = [...happy, ...onboarding, ...socket, ...checkpoint, ...misc, ...commit, ...operator, ...flags, ...revoke];
const ORDER = ["T-HAPPY", "T-READY-SHAPE", "T-MININTERVAL-READY", "T-PAIR-FORMAT", "T-PAIR-MALFORMED", "T-PAIR-UNKNOWN-VAULT", "T-PAIR-USED",
	"T-TICKET-CROSS-VAULT", "T-TICKET-BAD", "T-CODEC-UTF8", "T-CODEC-SURROGATE", "T-CODEC-OVERLONG", "T-CODEC-NONMINIMAL", "T-CODEC-TRAILING",
	"T-CODEC-VALID", "T-OVERSIZE-1009", "T-TWO-SOCKETS", "T-DEDUPE-CONFLICT", "T-MININTERVAL-TIMING", "T-EPOCH-MISMATCH", "T-EPOCH-MATCH",
	"T-EPOCH-ABSENT", "T-CKPT-MULTICHUNK", "T-RETIRED-GC", "T-PARTIAL-GC", "T-BLOB-OPAQUE", "T-BLOB-UNAVAILABLE", "T-DAILY", "T-DEDUPE-LARGE",
	"T-DEDUPE-SMALL", "T-RATE-SOCKET", "T-RATE-DEVICE", "T-SOCKET-CAP-DEVICE", "T-DEVICES-LIST", "T-REVOKE-GATE", "T-REVOKE-SILENCE",
	"T-REVOKE-BUFFER", "T-REVOKE-4403", "T-REVOKE-401", "T-RESET",
	"T-ENROLL-200", "T-LEGACY-404",
	"T-CONSOLE-ROUTES", "T-ENROLL-REPLAY", "T-ENROLL-CONFLICT", "T-ENROLL-BODY", "T-UNKNOWN-VAULT-401", "T-BLOB-KEY-RESET", "T-PROVISION-404",
	"T-VAULT-DELETE-CONFIRM"];
const byId = new Map(ALL.map((t) => [t.id, t]));
if (byId.size !== ALL.length || ORDER.length !== ALL.length || ORDER.some((tid) => !byId.has(tid))) {
	throw new Error("test registry and ORDER disagree");
}
if (ONLY) for (const tid of ONLY) if (!byId.has(tid)) { console.error(`unknown test id ${tid}`); process.exit(2); }

const ctx: Ctx = {
	host: HOST,
	wsHost: HOST.replace(/^http/, "ws"),
	label: LABEL,
	stamp: STAMP,
	operatorContextPath: arg("operator-context"),
	skipSlow: SKIP_SLOW,
	secrets: new Set(),
	memo: new Map(),
	enrollLog: [],
	capabilities: null,
	openSockets: new Set(),
	vaultSummaries: [],
};

process.on("unhandledRejection", (error) => { console.error(`(unhandled rejection) ${scrub(ctx, errorMessage(error))}`); });

async function runOne(def: TestDef): Promise<TestResult> {
	const t = new Recorder();
	const t0 = now();
	if (def.slow && SKIP_SLOW) { t.skip("slow test skipped (--skip-slow)"); return t.finish(def.id, def, 0); }
	let timer: ReturnType<typeof setTimeout> | undefined;
	try {
		await Promise.race([
			def.run(ctx, t),
			new Promise((_, reject) => { timer = setTimeout(() => reject(new Error(`test timeout after ${def.timeoutMs ?? 120000} ms`)), def.timeoutMs ?? 120000); }),
		]);
	} catch (error) {
		t.fail(`error: ${errorMessage(error).slice(0, 300)}`);
	} finally {
		clearTimeout(timer);
		for (const socket of ctx.openSockets) socket.close();
		ctx.openSockets.clear();
	}
	return t.finish(def.id, def, now() - t0);
}

console.log(`conformance: ${HOST} (${LABEL}) ${STAMP}${ONLY ? ` only=${ONLY.join(",")}` : ""}${SKIP_SLOW ? " skip-slow" : ""}`);
const caps = await http(ctx, "GET", "/api/capabilities");
ctx.capabilities = caps.value && typeof caps.value === "object" ? caps.value : null;
const capsSummary = { status: caps.status, claimed: caps.value?.claimed, streams: caps.value?.streams, attachments: caps.value?.attachments,
	serverVersion: caps.value?.serverVersion, schemaVersion: caps.value?.schemaVersion, protocolVersion: caps.value?.protocolVersion };
console.log(`capabilities ${JSON.stringify(capsSummary)}`);

const results: TestResult[] = [];
for (const tid of ORDER) {
	if (ONLY && !ONLY.includes(tid)) continue;
	const def = byId.get(tid)!;
	process.stdout.write(`-- ${tid} ... `);
	const result = await runOne(def);
	results.push(result);
	console.log(scrub(ctx, `${result.status} (${result.durationMs} ms) ${result.reason}`));
	for (const info of result.info ?? []) console.log(scrub(ctx, `   INFO ${info.reason}`));
	await sleep(100);
}

let sha: string | null = null;
try { sha = execFileSync("git", ["-C", new URL("../..", import.meta.url).pathname, "rev-parse", "--short", "HEAD"]).toString().trim(); }
catch { /* not a checkout */ }
const count = (status: string, group?: string) => results.filter((r) => r.status === status && (!group || r.group === group)).length;
const summary = {
	PASS: count("PASS"), FAIL: count("FAIL"), SKIP: count("SKIP"), INFO: results.reduce((n, r) => n + (r.info?.length ?? 0), 0),
	baseline: { PASS: count("PASS", "baseline"), FAIL: count("FAIL", "baseline"), SKIP: count("SKIP", "baseline") },
	decision: { PASS: count("PASS", "decision"), FAIL: count("FAIL", "decision"), SKIP: count("SKIP", "decision") },
	differsFromExpectedBefore: results.filter((r) => r.status !== r.expectedBefore).map((r) => `${r.id}:${r.status}(expected ${r.expectedBefore})`),
};
const output = {
	suite: "yaos-relay-conformance",
	label: LABEL,
	host: HOST,
	startedAt: STARTED.toISOString(),
	finishedAt: new Date().toISOString(),
	durationMs: Math.round(now()),
	suiteSha: sha,
	only: ONLY,
	skipSlow: SKIP_SLOW,
	capabilities: capsSummary,
	vaults: ctx.vaultSummaries,
	summary,
	tests: results,
};
let text = JSON.stringify(output, null, 2) + "\n";
const scrubbed = scrub(ctx, text);
if (scrubbed !== text) console.log("WARNING: secrets were found in the result object and redacted");
text = scrubbed;
mkdirSync(LOG_DIR, { recursive: true });
const out = join(LOG_DIR, `conformance-${LABEL}-${STAMP}.json`);
writeFileSync(out, text);
console.log(`\n${scrub(ctx, table(results))}`);
console.log(`\nPASS ${summary.PASS}  FAIL ${summary.FAIL} (baseline ${summary.baseline.FAIL})  SKIP ${summary.SKIP}  INFO ${summary.INFO}`);
console.log(`results -> ${out}`);
setTimeout(() => process.exit(summary.baseline.FAIL > 0 ? 1 : 0), 50);
