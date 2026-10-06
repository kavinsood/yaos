/**
 * Snapshot backup e2e (DESIGN §j.4): two full clients (fullKit.ts) on a REAL local relay WITH attachment storage
 * (`start-local.sh --r2`: wrangler dev emulates the R2 bucket under the state dir).
 *   1 device a (upload on) writes markdown, a canvas and ~9 MiB of images (2 parts), takes a manual snapshot
 *     (uploaded), then edits, replaces and deletes files
 *   2 a FRESH device b lists the uploaded snapshot, verifies it (snapshotFiles), restores it: every file equals a's
 *     bytes at snapshot time, differing files are conflict-copied, the download cache is gone, the result syncs to a
 *   3 corruption: a takes a second snapshot; one byte of its last part is flipped AT REST in the relay's R2 store
 *     (the miniflare blob file whose sha256 is the part's); b's restore fails `content_corrupt` naming the check,
 *     b gets the notice, b's vault and snapshot list are unchanged, no download parts are left
 *
 *   node --import jiti/register e2e/client/snapshots.ts --host http://127.0.0.1:8796 [--label local] [--state-dir DIR]
 *
 * --state-dir: the relay's --persist-to dir (default experiments/logs/client-e2e-local-<port>-state). Writes
 * LOG_DIR/client-e2e-snapshots-<label>-<stamp>.json (no secrets) and exits 1 on any failed check.
 */
import { createHash } from "node:crypto";
import { readdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { formatCanvasBytes, parseCanvasText } from "../../src/core/hash/canvasCanonical";
import { HostRequestError } from "../../src/host/engineHost";
import type { EngineResultValue, SnapshotSummary, UserCommand } from "../../src/protocol/messages";
import { Report } from "./engineKit";
import { bytesOf, conflictCopies, converge, randomBytes, sameBytes } from "./fullCheck";
import { FullClient } from "./fullKit";
import { DEFAULT_LOG_DIR, onboardVault, redact, type OnboardDevice, type OnboardedVault } from "./onboard";

function arg(name: string, fallback: string): string {
	const i = process.argv.indexOf(`--${name}`);
	return i >= 0 && process.argv[i + 1] ? process.argv[i + 1]! : fallback;
}
const HOST = arg("host", process.env.YAOS_E2E_HOST ?? "http://127.0.0.1:8796").replace(/\/+$/, "");
const LABEL = arg("label", "local");
const STATE_DIR = arg("state-dir", `${new URL("../../..", import.meta.url).pathname}logs/client-e2e-local-${new URL(HOST).port || "80"}-state`);
const R = new Report();
const SETTINGS = { snapshots: { enabled: true, keepDaily: 7, uploadToBlobStore: true } };
const clients: FullClient[] = [];
let vault: OnboardedVault | null = null;

function newClient(name: string, device: OnboardDevice): FullClient {
	const c = new FullClient({ name, host: HOST, vaultId: vault!.vaultId, device, watcherDelayMs: 100, settings: SETTINGS });
	clients.push(c);
	return c;
}

async function cmd<T extends EngineResultValue["t"]>(c: FullClient, command: UserCommand, t: T): Promise<Extract<EngineResultValue, { t: T }>> {
	const r = await c.runtime.command(command);
	if (r.t !== t) throw new Error(`${command.t} on ${c.name}: expected ${t}, got ${r.t}`);
	return r as Extract<EngineResultValue, { t: T }>;
}
const list = async (c: FullClient): Promise<readonly SnapshotSummary[]> => (await cmd(c, { t: "listSnapshots" }, "snapshots")).snapshots;

async function contents(c: FullClient): Promise<Map<string, Uint8Array>> {
	const out = new Map<string, Uint8Array>();
	for (const p of [...c.vault.snapshot().keys()].sort()) out.set(p, (await bytesOf(c, p))!);
	return out;
}
async function sameFiles(c: FullClient, want: ReadonlyMap<string, Uint8Array>): Promise<string[]> {
	const bad: string[] = [];
	for (const [p, b] of want) if (!sameBytes(await bytesOf(c, p), b)) bad.push(p);
	return bad;
}
const dlParts = (c: FullClient) => [...c.sideFiles.files.keys()].filter((n) => n.startsWith("snapshots/dl-"));

/** Files under `dir` (recursive) of `size` bytes whose sha256 is `sha`. */
function filesWithHash(dir: string, size: number, sha: string): string[] {
	const out: string[] = [];
	const walk = (d: string) => {
		for (const n of readdirSync(d)) {
			const p = join(d, n);
			const st = statSync(p);
			if (st.isDirectory()) walk(p);
			else if (st.size === size && createHash("sha256").update(readFileSync(p)).digest("hex") === sha) out.push(p);
		}
	};
	walk(dir);
	return out;
}

async function main(): Promise<void> {
	R.step("onboard; start a (snapshot upload on); write md, canvas, ~9 MiB of images");
	vault = await onboardVault(HOST, { devices: 2, label: `snapshots-${LABEL}` });
	const a = newClient("a", vault.devices[0]!);
	await a.start();
	await converge([a], 60_000);
	a.vault.userWrite("notes/plan.md", "# Plan\n\nship the backup path\n");
	a.vault.userWrite("notes/gone.md", "this file gets deleted after the snapshot\n");
	const canvas = parseCanvasText(JSON.stringify({ nodes: [{ id: "n1", type: "text", text: "hi", x: 0, y: 0, width: 200, height: 80 }], edges: [] }));
	if (canvas.kind !== "valid") throw new Error("test canvas does not parse");
	a.vault.externalWrite("board.canvas", formatCanvasBytes(canvas.data)); // disk formatting, as peers materialise it
	for (let i = 0; i < 10; i++) a.vault.externalWrite(`img/p${i}.png`, randomBytes(900 * 1024, 40 + i));
	await a.runtime.command({ t: "reconcileNow" });
	await converge([a], 120_000);

	R.step("a: manual snapshot (uploaded), then edits, a replaced image, a delete, a new file");
	const t0 = performance.now();
	await cmd(a, { t: "createSnapshot" }, "ok");
	R.record("create_and_upload_ms", performance.now() - t0);
	const s1 = (await list(a)).filter((s) => s.reason === "manual").at(-1);
	R.check("a lists the manual snapshot as uploaded (where both)", s1?.where === "both" && s1.files === 13, s1);
	const atSnap = await contents(a);
	const rec1 = [...a.vrt!.log.snapView().state.records.values()].find((e) => e.record.snapshotId === s1?.id)?.record;
	R.check("one index record, 2 parts of <= 8 MiB", rec1?.parts.length === 2 && rec1.parts.every((p) => p.size <= 8 * 1024 * 1024),
		rec1 && { parts: rec1.parts.map((p) => p.size), totalBytes: rec1.totalBytes, fileCount: rec1.fileCount });
	a.vault.userWrite("notes/plan.md", "# Plan\n\nedited after the snapshot\n");
	a.vault.userDelete("notes/gone.md");
	a.vault.externalWrite("img/p0.png", randomBytes(900 * 1024, 99));
	a.vault.userWrite("notes/new.md", "written after the snapshot\n");
	await a.runtime.command({ t: "reconcileNow" });
	await converge([a], 60_000);

	R.step("fresh b: list, verify, restore a's uploaded snapshot; files match; result syncs to a");
	const b = newClient("b", vault.devices[1]!);
	await b.start();
	await converge([a, b], 120_000);
	const row = (await list(b)).find((s) => s.reason === "manual" && s.where === "remote");
	R.check("b lists a's snapshot as remote, from device a", row?.device === "a" && row.id === `${s1?.id}@${vault.devices[0]!.deviceId}` && row.files === 13,
		row && { where: row.where, device: row.device, files: row.files, bytes: row.bytes });
	if (!row) throw new Error("no remote snapshot on b");
	const tv = performance.now();
	const listed = await cmd(b, { t: "snapshotFiles", snapshotId: row.id }, "snapshotFiles");
	R.record("b_download_verify_ms", performance.now() - tv);
	R.check("b verified the snapshot: the manifest lists every file", JSON.stringify(listed.files.map((f) => f.path).sort()) === JSON.stringify([...atSnap.keys()].sort()) && listed.skipped.length === 0,
		{ files: listed.files.length, skipped: listed.skipped });
	const tr = performance.now();
	const r = await cmd(b, { t: "restoreSnapshot", snapshotId: row.id, paths: null }, "restored");
	R.record("b_restore_ms", performance.now() - tr);
	R.check("restore: 3 written, 10 unchanged, 2 conflict copies, none failed", r.restored === 3 && r.unchanged === 10 && r.copies.length === 2 && r.failed.length === 0,
		{ restored: r.restored, unchanged: r.unchanged, copies: r.copies, failed: r.failed });
	R.check("b's files equal a's bytes at snapshot time", (await sameFiles(b, atSnap)).length === 0, await sameFiles(b, atSnap));
	R.check("b's download cache removed", dlParts(b).length === 0, dlParts(b));
	await b.runtime.command({ t: "reconcileNow" });
	await converge([a, b], 120_000);
	R.check("the restore synced to a (snapshot files + 2 copies + new.md)", (await sameFiles(a, atSnap)).length === 0 && conflictCopies(a).length === 2 && a.vault.hasFile("notes/new.md"),
		{ differ: await sameFiles(a, atSnap), copies: conflictCopies(a).length });

	R.step("corruption: a's second snapshot; flip one byte of its last part at rest in R2; b refuses it");
	a.vault.userWrite("notes/plan.md", "# Plan\n\nsecond snapshot\n");
	await a.runtime.command({ t: "reconcileNow" });
	await converge([a, b], 60_000);
	await cmd(a, { t: "createSnapshot" }, "ok");
	const s2 = (await list(a)).filter((s) => s.reason === "manual").at(-1)!;
	const rec2 = [...a.vrt!.log.snapView().state.records.values()].find((e) => e.record.snapshotId === s2.id)!.record;
	const last = rec2.parts.at(-1)!;
	const hits = filesWithHash(join(STATE_DIR, "v3", "r2"), last.size, last.sha256);
	R.check("found the part's object in the local R2 store (suite 0: stored bytes = part)", hits.length === 1, { hits: hits.length, size: last.size });
	if (hits.length !== 1) throw new Error("cannot tamper: part object not found under the R2 state dir");
	const obj = readFileSync(hits[0]!);
	obj[obj.length >> 1]! ^= 0x01;
	writeFileSync(hits[0]!, obj);
	R.extra.tamper = { method: "r2-at-rest (miniflare blob file edited on disk; no client-port injection)", part: rec2.parts.length - 1, offset: obj.length >> 1 };
	const id2 = `${s2.id}@${vault.devices[0]!.deviceId}`;
	await waitForRow(b, id2);
	const before = await contents(b);
	const restoresBefore = (await list(b)).filter((s) => s.reason === "restore").length;
	const noticesBefore = b.ui.notices.length;
	const err = await b.runtime.command({ t: "restoreSnapshot", snapshotId: id2, paths: null }).then(() => null, (e: unknown) => e);
	const code = err instanceof HostRequestError ? err.error.code : String(err);
	R.check("b's restore fails content_corrupt naming part-hash", code === "content_corrupt" && err instanceof HostRequestError && /part-hash/.test(err.error.message),
		err instanceof HostRequestError ? err.error : String(err));
	const notices = b.ui.notices.slice(noticesBefore);
	R.check("b got the content_corrupt notice", notices.some((n) => n.code === "content_corrupt"), notices);
	const after = await contents(b);
	R.check("fail closed: b's vault unchanged", after.size === before.size && [...before].every(([p, x]) => sameBytes(after.get(p) ?? null, x)), { before: before.size, after: after.size });
	R.check("no restore snapshot taken, no download parts left", (await list(b)).filter((s) => s.reason === "restore").length === restoresBefore && dlParts(b).length === 0, dlParts(b));
	R.check("diagnostic names the snapshot and check", b.logLines.some((l) => l.includes(`content_corrupt snapshot=${id2} check=part-hash`)), b.logLines.filter((l) => l.includes("content_corrupt")).slice(-3));
	await converge([a, b], 60_000);
}

async function waitForRow(c: FullClient, id: string): Promise<void> {
	for (let i = 0; i < 200; i++) {
		if ((await list(c)).some((s) => s.id === id)) return;
		await new Promise((res) => setTimeout(res, 50));
	}
	throw new Error(`snapshot ${id} never listed on ${c.name}`);
}

let fatal: string | null = null;
try {
	await main();
} catch (e) {
	fatal = e instanceof Error ? (e.stack ?? e.message) : String(e);
	R.check("run completed", false, fatal);
	for (const c of clients) R.extra[`logs ${c.name}`] = redact(c.logLines.slice(-60));
} finally {
	for (const c of clients) R.extra[`notices ${c.name}`] = c.ui.notices.map((n) => `${n.level}:${n.code}`);
	for (const c of clients) {
		try { await c.stop(); } catch { /* best effort */ }
	}
}
const [, failed] = R.write(DEFAULT_LOG_DIR, "client-e2e-snapshots", LABEL, HOST, vault, fatal);
process.exit(failed === 0 ? 0 : 1);
