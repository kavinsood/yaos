/**
 * WP-C engine e2e: headless LogEngines (production adapters, fake-indexeddb) syncing through a REAL streams
 * relay. See README.md. Scenarios: create/edit convergence, keystroke -> peer latency (provisional path),
 * concurrent edits, rename/delete, offline edits + reconnect catch-up, large update via x: chunks, checkpoint
 * duty, fresh-device catch-up (feed/read/checkpoint), restart from IndexedDB, IDB loss -> outbox mirror
 * recovery, relay process restart (local only; --relay-restart).
 *
 *   node --import jiti/register e2e/client/engines.ts [--host URL] [--label local] [--relay-restart]
 *        [--operator-context FILE]
 *
 * Writes LOG_DIR/client-e2e-wpc-engines-<label>-<stamp>.json (no secrets) and exits 1 on any failure.
 */
import { execFileSync } from "node:child_process";
import type { DocId, VaultPath } from "../../src/core/types";
import type { EngineTuning } from "../../src/engine/runtime/options";
import { Device, Report, converge, engineStats, sleep, until } from "./engineKit";
import { DEFAULT_LOG_DIR, onboardVault, type OnboardedVault } from "./onboard";

function arg(name: string, fallback: string): string {
	const i = process.argv.indexOf(`--${name}`);
	return i >= 0 && process.argv[i + 1] ? process.argv[i + 1]! : fallback;
}
const HOST = arg("host", process.env.YAOS_E2E_HOST ?? "http://127.0.0.1:8787").replace(/\/+$/, "");
const LABEL = arg("label", "local");
const OPERATOR_CONTEXT = arg("operator-context", "");
const RELAY_RESTART = process.argv.includes("--relay-restart");
/** start-local.sh / stop-local.sh keep state, pid and port files per port. */
const RELAY_PORT = new URL(HOST).port || "80";
const WT = new URL("../..", import.meta.url).pathname;
const R = new Report();
const P = (s: string) => s as VaultPath;

/** Small thresholds so compaction and relay checkpoints happen within the run; real frame timing. */
const TUNING: Partial<EngineTuning> = {
	compactRows: 40,
	checkpoint: { rows: 30, bytes: 1e9, idleMs: 300, fallbackMs: 2_000, nsRows: 30, nsBytes: 1e9 },
	maintenanceMs: 200,
	reconnectBaseMs: 250,
	mirrorDebounceMs: 50,
};

const devices: Device[] = [];
let vault: OnboardedVault | null = null;

async function main(): Promise<void> {
	R.step("onboard + start a, b");
	vault = await onboardVault(HOST, { devices: 3, label: `engines-${LABEL}`, ...(OPERATOR_CONTEXT ? { operatorContextFile: OPERATOR_CONTEXT } : {}) });
	const [a, b, c] = vault.devices.map((d, i) => new Device("abc"[i]!, d)) as [Device, Device, Device];
	devices.push(a, b, c);
	let t = R.now();
	await a.start(HOST, vault.vaultId, TUNING);
	R.record("engine_start_ms", R.now() - t);
	t = R.now();
	await b.start(HOST, vault.vaultId, TUNING);
	R.record("engine_start_ms", R.now() - t);
	await until(() => a.e.status().phase === "live" && b.e.status().phase === "live", 15_000, "a, b live");
	R.check("a and b live", true);

	R.step("create + edit -> converge");
	const ids: DocId[] = [];
	for (let i = 0; i < 5; i++) ids.push(await a.e.createDoc(P(`notes/a${i}.md`), `a${i} body;`));
	for (let i = 0; i < 2; i++) ids.push(await b.e.createDoc(P(`notes/b${i}.md`), `b${i} body;`));
	R.record("converge_ms", await converge([a, b]));
	await b.e.editDoc(ids[0]!, (x) => x.insert(x.length, "b-edit;"));
	R.record("converge_ms", await converge([a, b]));
	R.check("a0 text on a", (await a.e.docText(ids[0]!)) === "a0 body;b-edit;", await a.e.docText(ids[0]!));
	R.check("b1 created by b visible on a", (await a.e.docText(ids[6]!)) === "b1 body;");
	R.check("7 live docs on both", a.e.listDocs().filter((d) => d.state === "live").length === 7);

	R.step("edits + keystrokes -> peer bound view latency");
	const doc = ids[1]!;
	await b.bind(doc);
	for (let i = 0; i < 30; i++) {
		const mark = `<m${i}>`;
		const t0 = R.now();
		await a.e.editDoc(doc, (x) => x.insert(x.length, mark)); // merge edit: frame closed at once
		await b.hostText(doc, (s) => s.includes(mark), 10_000);
		R.record("merge_edit_to_peer_view_ms", R.now() - t0);
		await sleep(20);
	}
	await a.bind(doc);
	for (let i = 0; i < 20; i++) {
		const mark = `<s${i}>`;
		const t0 = R.now();
		a.type(doc, mark); // single keystroke, then wait: idle close (OPEN_FRAME_IDLE_MS) + relay round trip
		await b.hostText(doc, (s) => s.includes(mark), 10_000);
		R.record("single_keystroke_to_peer_view_ms", R.now() - t0);
		await sleep(150);
	}
	await converge([a, b]);
	const appends0 = a.e.c.sender.stats.appends;
	const KEYS = 150;
	const waits: Promise<void>[] = [];
	for (let i = 0; i < KEYS; i++) {
		const mark = `[${i}]`;
		const t0 = R.now();
		a.type(doc, mark); // ~33 keys/s burst typing
		waits.push(b.hostText(doc, (s) => s.includes(mark), 15_000).then(() => R.record("typing_key_to_peer_view_ms", R.now() - t0)));
		await sleep(30);
	}
	await Promise.all(waits);
	await converge([a, b]);
	const frames = a.e.c.sender.stats.appends - appends0;
	R.extra.typingFrames = { keys: KEYS, frames };
	R.check("burst typing is batched into frames (max age 300 ms)", frames <= KEYS / 4, { frames, keys: KEYS });
	R.check("bound views equal the replicas", a.hosts.get(doc) === (await a.e.docText(doc))
		&& b.hosts.get(doc) === (await b.e.docText(doc)));

	R.step("concurrent edits on one doc");
	const cdoc = ids[2]!;
	await Promise.all([a, b].map(async (d) => {
		for (let i = 0; i < 20; i++) {
			await d.e.editDoc(cdoc, (x) => x.insert(i % 2 ? 0 : x.length, `${d.name}${i};`));
			await sleep(15);
		}
	}));
	R.record("converge_ms", await converge([a, b]));
	const ctext = await a.e.docText(cdoc);
	R.check("all 40 concurrent inserts present", [a, b].every((d) => Array.from({ length: 20 }, (_, i) => `${d.name}${i};`).every((m) => ctext.includes(m))));

	R.step("rename + delete");
	await a.e.renameDoc(ids[3]!, P("moved/a3.md"));
	await b.e.deleteDoc(ids[4]!);
	R.record("converge_ms", await converge([a, b]));
	R.check("rename visible on b", b.e.listDocs().find((d) => d.docId === ids[3])?.path === "moved/a3.md");
	R.check("delete visible on a", a.e.listDocs().find((d) => d.docId === ids[4])?.state !== "live");

	R.step("offline edits on both sides + reconnect catch-up");
	b.e.disconnect();
	await until(() => b.e.status().phase !== "live", 5_000, "b offline");
	for (let i = 0; i < 10; i++) await a.e.editDoc(ids[5]!, (x) => x.insert(x.length, `on${i};`));
	const off1 = await a.e.createDoc(P("offline/new1.md"), "made while b offline;");
	await b.e.editDoc(ids[0]!, (x) => x.insert(0, "b-offline;"));
	const bOff = await b.e.createDoc(P("offline/fromb.md"), "b made offline;");
	await sleep(300);
	R.check("b holds its offline frames", b.e.c.outbox.size > 0, b.e.c.outbox.size);
	const reads0 = b.e.c.sess.stats.reads;
	t = R.now();
	await b.e.reconnect();
	await converge([a, b]);
	R.record("reconnect_converge_ms", R.now() - t);
	R.check("a's offline-period edits reached b", (await b.e.docText(ids[5]!)).endsWith("on9;") && (await b.e.docText(off1)) === "made while b offline;");
	R.check("b's offline edits reached a", (await a.e.docText(ids[0]!)).startsWith("b-offline;") && (await a.e.docText(bOff)) === "b made offline;");
	R.check("b outbox drained", b.e.c.outbox.size === 0);
	R.extra.reconnectReads = b.e.c.sess.stats.reads - reads0;

	R.step("large update via x: chunks");
	const big = "L".repeat(1_300_000);
	await a.e.editDoc(ids[6]!, (x) => x.insert(x.length, big));
	R.record("large_update_converge_ms", await converge([a, b], 60_000));
	R.check("b has the 1.3 MB update", (await b.e.docText(ids[6]!)).length === "b1 body;".length + big.length);

	R.step("checkpoint duty (relay CAS)");
	const kdoc = ids[3]!;
	for (let i = 0; i < 45; i++) {
		await a.e.editDoc(kdoc, (x) => x.insert(x.length, `k${i};`));
		await sleep(i % 5 === 4 ? 350 : 5);
	}
	await converge([a, b]);
	const kStream = a.e.streamOf(kdoc);
	const ck = (d: Device) => d.e.c.repo.stream(kStream)!.remoteCheckpointCoversSeq;
	t = R.now();
	await until(() => ck(a) > 0 || ck(b) > 0, 20_000, "a checkpoint of the edited doc").catch(() => undefined);
	R.record("checkpoint_after_idle_ms", R.now() - t);
	const ckA = ck(a);
	const ckB = ck(b);
	R.check("a body checkpoint is recorded", Math.max(ckA, ckB) > 0, { ckA, ckB, outcomes: [a.e.maint.stats.checkpointOutcomes, b.e.maint.stats.checkpointOutcomes] });
	R.extra.checkpointOutcomes = { a: a.e.maint.stats.checkpointOutcomes, b: b.e.maint.stats.checkpointOutcomes };

	await phase2(a, b, c, ids);
}

async function phase2(a: Device, b: Device, c: Device, ids: DocId[]): Promise<void> {
	const vaultId = vault!.vaultId;
	R.step("fresh device c catch-up");
	let t = R.now();
	await c.start(HOST, vaultId, TUNING);
	const ms = await converge([a, b, c], 60_000);
	R.record("fresh_catchup_ms", R.now() - t);
	R.check("c converged with a and b", true, { ms });
	const kStream = c.e.streamOf(ids[3]!);
	R.extra.freshCatchup = { feedPages: c.e.c.sess.stats.feedPages, reads: c.e.c.sess.stats.reads, snapshotCoversSeq: c.e.c.repo.stream(kStream)!.snapshotCoversSeq };
	R.check("c text of a checkpointed doc", (await c.e.docText(ids[3]!)).endsWith("k44;"));
	const ckMax = Math.max(...[a, b].map((d) => d.e.c.repo.stream(kStream)!.remoteCheckpointCoversSeq));
	R.check("c started that doc from the relay checkpoint", ckMax > 0 && c.e.c.repo.stream(kStream)!.snapshotCoversSeq >= ckMax,
		{ ckMax, snapshotCoversSeq: c.e.c.repo.stream(kStream)!.snapshotCoversSeq });

	R.step("restart a from IndexedDB");
	const cursor = a.e.c.repo.cursor.vaultSeq;
	await a.stop();
	for (let i = 0; i < 5; i++) await b.e.editDoc(ids[0]!, (x) => x.insert(x.length, `while-a-down${i};`));
	t = R.now();
	await a.start(HOST, vaultId, TUNING);
	R.check("a resumes from its cursor", a.e.c.repo.cursor.vaultSeq >= cursor, { before: cursor, after: a.e.c.repo.cursor.vaultSeq });
	await converge([a, b, c], 30_000);
	R.record("restart_converge_ms", R.now() - t);
	R.check("a got edits made while down", (await a.e.docText(ids[0]!)).endsWith("while-a-down4;"));
	R.extra.restartReads = a.e.c.sess.stats.reads;

	R.step("IndexedDB loss -> outbox mirror recovery");
	b.e.disconnect();
	await until(() => b.e.status().phase !== "live", 5_000, "b offline");
	await b.e.editDoc(ids[1]!, (x) => x.insert(0, "mirror-me;"));
	const mdoc = await b.e.createDoc(P("mirror/rec.md"), "recovered via mirror;");
	await b.e.flush();
	R.check("b has unreceipted frames", b.e.c.outbox.size > 0, b.e.c.outbox.size);
	await b.stop();
	b.loseDb();
	await b.start(HOST, vaultId, TUNING);
	R.check("recovered-from-mirror notice", b.e.status().notices.some((n) => n.code === "recovered-from-mirror"));
	await converge([a, b, c], 60_000);
	R.check("mirrored edits reached a", (await a.e.docText(ids[1]!)).startsWith("mirror-me;") && (await a.e.docText(mdoc)) === "recovered via mirror;");

	if (RELAY_RESTART) {
		R.step("relay process restart (state kept)");
		execFileSync("zsh", [`${WT}scripts/relay-dev/stop-local.sh`, "--port", RELAY_PORT], { stdio: "inherit" });
		await sleep(500);
		await a.e.editDoc(ids[2]!, (x) => x.insert(0, "during-relay-down;"));
		execFileSync("zsh", [`${WT}scripts/relay-dev/start-local.sh`, "--port", RELAY_PORT], { stdio: ["ignore", "ignore", "inherit"] });
		t = R.now();
		await until(() => [a, b, c].every((d) => d.e.status().phase === "live"), 60_000, "auto-reconnect");
		R.record("relay_restart_reconnect_ms", R.now() - t);
		await converge([a, b, c], 60_000);
		R.check("edit made while relay was down converged", (await c.e.docText(ids[2]!)).startsWith("during-relay-down;"));
	}

	R.step("final invariants");
	const head = Math.max(...[a, b, c].map((d) => d.e.c.repo.cursor.headSeqSeen));
	for (const d of [a, b, c]) {
		const s = d.e.status();
		R.check(`${d.name}: cursor at head, outbox empty, nothing frozen/quarantined`, d.e.c.repo.cursor.vaultSeq === head && d.e.c.outbox.size === 0
			&& s.counts.frozenDocs === 0 && s.counts.quarantinedRows === 0, engineStats(d));
		R.extra[`stats_${d.name}`] = engineStats(d);
	}
}

let fatal: string | null = null;
try {
	await main();
} catch (e) {
	fatal = e instanceof Error ? (e.stack ?? e.message) : String(e);
	R.check("run completed", false, fatal);
} finally {
	for (const d of devices) {
		try { await d.stop(); } catch { /* best effort */ }
	}
}
const [, failed] = R.write(DEFAULT_LOG_DIR, "client-e2e-wpc-engines", LABEL, HOST, vault, fatal);
process.exit(failed === 0 ? 0 : 1);
