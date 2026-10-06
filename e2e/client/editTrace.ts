/**
 * Edit-to-peer breakdown: writer A and reader C (both FullClients with a BootTrace recording socket frames) on a
 * fresh vault. For each edit (API write, external disk write, typing in a bound view on A; C never has the note
 * open, so its disk is written by the engine; typing goes to a second note so A's view never races the API and
 * disk writes) it times, from the edit:
 *   A's first APPEND out, C's first PROVISIONAL / COMMITTED in, C's COMMIT_NOTICE, A's STREAM_RECEIPTS, C's disk.
 *
 *   node --import jiti/register e2e/client/editTrace.ts --host URL --label L [--n 8] [--watcher-ms 100]
 *
 * Writes LOG_DIR/client-e2e-edit-<label>-<stamp>.json (no secrets, no payloads).
 */
import { Report, sleep } from "./engineKit";
import { BootTrace, type WsEvent } from "./bootTrace";
import { converge, waitFor } from "./fullCheck";
import { FullClient } from "./fullKit";
import { DEFAULT_LOG_DIR, onboardVault, type OnboardedVault } from "./onboard";

function arg(name: string, fallback: string): string {
	const i = process.argv.indexOf(`--${name}`);
	return i >= 0 && process.argv[i + 1] ? process.argv[i + 1]! : fallback;
}
const HOST = arg("host", "http://127.0.0.1:8791").replace(/\/+$/, "");
const LABEL = arg("label", "local");
const N = Number(arg("n", "8"));
const WATCHER_MS = Number(arg("watcher-ms", "100"));
const R = new Report();
const r1 = (v: number) => Math.round(v * 10) / 10;
const median = (v: number[]) => (v.length ? [...v].sort((a, b) => a - b)[Math.floor((v.length - 1) / 2)]! : NaN);

const KIND = { append: "bin:1", provisional: "bin:16", committed: "bin:17", notice: "bin:18" } as const;

function firstAfter(ev: readonly WsEvent[], t0: number, dir: "in" | "out", kind: string): number | null {
	const e = ev.find((x) => x.t >= t0 && x.dir === dir && x.kind === kind);
	return e ? r1(e.t - t0) : null;
}

type Row = Record<string, number | null>;
const rows: Record<string, Row[]> = { api: [], disk: [], typing: [] };

let vault: OnboardedVault | null = null;
const all: FullClient[] = [];
let fatal: string | null = null;
try {
	R.step("setup");
	vault = await onboardVault(HOST, { devices: 2, label: `edit-${LABEL}` });
	const ta = new BootTrace();
	const tc = new BootTrace();
	const a = new FullClient({ name: "a", host: HOST, vaultId: vault.vaultId, device: vault.devices[0]!, watcherDelayMs: WATCHER_MS, trace: ta });
	const c = new FullClient({ name: "c", host: HOST, vaultId: vault.vaultId, device: vault.devices[1]!, watcherDelayMs: WATCHER_MS, trace: tc });
	all.push(a, c);
	await a.start();
	await c.start();
	await converge([a, c], 60_000);
	const path = "notes/edit.md";
	const typed = "notes/typed.md";
	a.vault.userWrite(path, "start\n");
	a.vault.userWrite(typed, "start\n");
	await waitFor(() => (c.vault.textOf(path) ?? "").includes("start") && (c.vault.textOf(typed) ?? "").includes("start"), "seed notes on c", 30_000);
	await converge([a, c], 30_000);
	const view = a.workspace.openFile(typed)!;
	await waitFor(() => view.isBound(), "a's view bound", 15_000);
	tc.t0 = ta.t0;
	ta.frames = tc.frames = true;

	const one = async (kind: "api" | "disk" | "typing", i: number) => {
		const tok = `[${kind}${i}]`;
		await sleep(1_500);
		const t0 = ta.now();
		const p0 = performance.now();
		if (kind === "typing") view.edit(view.buffer.length, 0, ` ${tok}`);
		else if (kind === "api") a.vault.userWrite(path, `${a.vault.textOf(path) ?? ""}${tok}\n`);
		else a.vault.externalWrite(path, new TextEncoder().encode(`${a.vault.textOf(path) ?? ""}${tok}\n`));
		const at = kind === "typing" ? typed : path;
		const disk = await waitFor(() => (c.vault.textOf(at) ?? "").includes(tok), `${tok} on c`, 30_000, p0, 1);
		await waitFor(() => ta.wsFrames.some((e) => e.t >= t0 && e.dir === "in" && e.kind === "STREAM_RECEIPTS"), "receipt on a", 10_000, p0, 2).catch(() => 0);
		rows[kind]!.push({
			appendOut: firstAfter(ta.wsFrames, t0, "out", KIND.append),
			provisionalIn: firstAfter(tc.wsFrames, t0, "in", KIND.provisional),
			committedIn: firstAfter(tc.wsFrames, t0, "in", KIND.committed),
			noticeIn: firstAfter(tc.wsFrames, t0, "in", KIND.notice),
			receiptOnA: firstAfter(ta.wsFrames, t0, "in", "STREAM_RECEIPTS"),
			diskOnC: r1(disk),
		});
	};
	R.step("edits");
	for (let i = 0; i < N; i++) for (const k of ["api", "disk", "typing"] as const) await one(k, i);
	const out: Record<string, Record<string, number>> = {};
	for (const [k, rs] of Object.entries(rows)) {
		const cols = Object.keys(rs[0] ?? {});
		out[k] = Object.fromEntries(cols.map((col) => [col, r1(median(rs.map((r) => r[col]).filter((v): v is number => v !== null)))]));
		for (const r of rs) R.record(`${k}_edit_to_peer_disk_ms`, r.diskOnC!);
	}
	R.extra.medians = out;
	R.extra.rows = rows;
	R.extra.config = { watcherDelayMs: WATCHER_MS, n: N };
	console.log(JSON.stringify(out, null, 1));
	R.check("every edit reached c's disk", Object.values(rows).every((rs) => rs.length === N && rs.every((r) => r.diskOnC !== null)));
} catch (e) {
	fatal = e instanceof Error ? (e.stack ?? e.message) : String(e);
	R.check("run completed", false, fatal);
} finally {
	for (const cl of all) {
		try { await cl.stop(); } catch { /* best effort */ }
	}
}
const [, failed] = R.write(DEFAULT_LOG_DIR, "client-e2e-edit", LABEL, HOST, vault, fatal);
process.exit(failed === 0 ? 0 : 1);
