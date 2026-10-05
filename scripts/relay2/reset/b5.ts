/**
 * Relay v2 spike §7.3 B5 (client side), deployed:
 *
 *   A and B race `runCompaction` (compaction-lease → build → semantic-reset)
 *   on a history-bloated body while C holds offline edits on the old epoch.
 *   Exactly one reset may install; the loser is fenced (4409) and rebases; C
 *   rebases on reconnect; A, B, C and a fresh D converge; the HTTP GET state
 *   matches; no edit marker is lost or duplicated.
 *
 * Plus: deployed semantic-reset upload time for 100 KB / 1 MB / 5 MB bodies.
 *
 *   node tests/run-typescript.mjs --test-aliases scripts/relay2/reset/b5.ts --host https://yaos-relay2-….workers.dev \
 *     [--out results/relay2/B5-….json] [--upload-n 5] [--skip-race] [--skip-upload] [--edits 14000]
 *
 * Uses the harness context (scripts/relay2/context.ts; claims the worker if no
 * context exists). Never prints tokens.
 */
import { join } from "node:path";
import * as Y from "yjs";
import { canonicalizeMarkdown, canonicalMarkdownHash } from "@shared/markdownCodec";
import type { ReadySemanticEpochTransition, SemanticEpochTransitionResult } from "../../../legacy-src/sync/semanticEpochTransition";
import type { LiveIdentity } from "../../../tests/live/liveIdentity";
import { claim, createBodyFromUpdate, device, hasContext, loadContext, type Context } from "../lib/context";
import { EXP_ROOT, dist, flagNum, flagStr, log, parseArgs, sleep, startMeta, writeResult } from "../lib/common";
import { RawClient, relayAdapter, type ProtocolAdapter } from "../lib/rawClient";
import { bloatedDoc } from "./bloat";
import { buildFreshSnapshotFromContent } from "./builder";
import { loadFixture } from "./fixtures";
import { HttpResetTransport } from "./httpTransport";
import {
	rebaseOntoCurrent,
	runCompaction,
	type CompactionOutcome,
	type RebaseOutcome,
	type ResetBodyHandle,
} from "./leaseClient";
import { evaluateClientTrigger, measureClientBody } from "./policy";

const BODY = "body";
/** Deployed relay requires snapshot SV ⊇ head SV (snapshotCoversHead); `--no-cover` shows the 400. */
let COVER = true;

/**
 * A live device for one body: a RawClient socket (relay envelope adapter) plus
 * the bookkeeping bodyManager keeps (durable baseline, unacknowledged frames).
 * Epoch crossings go through leaseClient's rebase (the real client three-way
 * rebase). A 4409 close triggers the same rebase, like vaultSync.
 */
class LiveDevice implements ResetBodyHandle {
	client: RawClient;
	private baseline = "";
	private unacked = new Set<string>();
	private online = false;
	private compacting = false;
	private fenced = false;
	private rebasing: Promise<RebaseOutcome | null> | null = null;
	readonly transport: HttpResetTransport;
	readonly events: Array<{ at: number; event: string }> = [];
	readonly rebases: RebaseOutcome[] = [];
	readonly conflictCopies: string[] = [];
	fenceCloses = 0;

	constructor(readonly name: string, readonly identity: LiveIdentity, readonly bodyId: string, private currentEpoch: number,
		private readonly adapter: ProtocolAdapter = relayAdapter()) {
		this.transport = new HttpResetTransport(identity);
		this.client = this.makeClient(new Y.Doc({ guid: bodyId }), currentEpoch);
	}

	private note(event: string) { this.events.push({ at: Date.now(), event }); }

	private makeClient(doc: Y.Doc, epoch: number): RawClient {
		const client = new RawClient(this.identity, this.bodyId, doc, this.adapter, epoch);
		client.keepControls = false;
		client.controlListeners.push((value) => {
			if (client !== this.client || !client.adapter.isAck(value, client)) return;
			const frameId = client.adapter.ackFrameId(value);
			if (frameId) this.unacked.delete(frameId);
			this.settle();
		});
		client.controlListeners.push((value) => {
			if (client === this.client && (value.type === "BODY_UPDATE_REJECTED" || value.type === "error")) this.note(`reject ${JSON.stringify(value).slice(0, 200)}`);
		});
		client.updateListeners.push(() => { if (client === this.client) this.settle(); });
		client.closeListeners.push((code, reason) => {
			if (client !== this.client) return;
			this.online = false;
			this.note(`close ${code} ${reason}`);
			if (code === 4409) {
				this.fenceCloses++;
				this.fenced = true;
				if (!this.compacting) void this.rebase();
			}
		});
		return client;
	}

	private settle() {
		if (this.unacked.size === 0 && this.online) this.baseline = canonicalizeMarkdown(this.text());
	}

	async connect(): Promise<void> {
		const opened = await this.client.open();
		if (opened.status !== "ok") throw new Error(`${this.name} open failed: ${opened.message} (${opened.httpStatus ?? ""})`);
		this.online = true;
		this.note(`open epoch=${this.currentEpoch}`);
		// Step2 replies to the server's step1 are enveloped appends: wait for their acks.
		for (const sent of this.client.sent) if (sent.kind === "step2") this.unacked.add(sent.clientFrameId);
		if (!await this.waitAcked(10_000)) this.note(`connect: ${this.unacked.size} step2 frames unacked after 10 s`);
		this.settle();
	}

	async disconnect(): Promise<void> {
		this.online = false;
		const client = this.client;
		this.client = this.makeClient(client.doc, this.currentEpoch); // detached, not opened
		await client.close();
		this.note("offline");
	}

	/** Local edit; forwarded by the RawClient doc listener while the socket is open. */
	edit(fn: (text: Y.Text) => void): void {
		const before = this.client.sent.length;
		this.client.edit(fn);
		for (const sent of this.client.sent.slice(before)) this.unacked.add(sent.clientFrameId);
	}

	insertAt(index: number, value: string) { this.edit((text) => text.insert(Math.min(index, text.length), value)); }

	async waitAcked(timeoutMs: number): Promise<boolean> {
		const deadline = Date.now() + timeoutMs;
		while (this.unacked.size > 0 && Date.now() < deadline) await sleep(20);
		return this.unacked.size === 0;
	}

	text() { return this.client.doc.getText(BODY).toJSON(); }

	// ---- ResetBodyHandle
	epoch() { return this.currentEpoch; }
	doc() { return this.client.doc; }
	durableBaseline() { return this.baseline; }
	appliedSequence() { return -1; } // unknown on the live socket; B5 uses snapshotSource "server"
	hasPendingLocal() { return this.unacked.size > 0 || canonicalizeMarkdown(this.text()) !== this.baseline; }

	async installEpoch(transition: ReadySemanticEpochTransition): Promise<void> {
		const old = this.client;
		this.client = this.makeClient(transition.document, transition.bodyEpoch);
		old.closeListeners.length = 0;
		await old.close();
		old.doc.destroy();
		this.currentEpoch = transition.bodyEpoch;
		this.fenced = false;
		this.unacked.clear();
		this.baseline = transition.authoritativeContent;
		this.note(`install epoch=${transition.bodyEpoch} outcome=${transition.outcome} rebased=${transition.rebasedUpdate?.byteLength ?? 0}`);
		if (!this.wantOnline) return;
		await this.connect();
		// connect() already sent the rebased delta as the step2 reply; send it once more as a
		// tracked update (idempotent server-side: noop/dedupe) so its ack is observable.
		if (transition.rebasedUpdate) {
			this.unacked.add(this.client.sendUpdate(transition.rebasedUpdate));
			await this.waitAcked(10_000);
			this.settle();
		}
	}

	wantOnline = true;

	get preserveConflict(): ResetBodyHandle["preserveConflict"] {
		return async (result: Exclude<SemanticEpochTransitionResult, ReadySemanticEpochTransition>) => {
			// Production writes a conflict copy file; the spike keeps the pending markdown.
			this.conflictCopies.push(result.pendingMarkdown);
			this.note(`conflict copy (${result.kind}) ${result.pendingMarkdown.length} chars`);
		};
	}

	rebase(): Promise<RebaseOutcome | null> {
		if (this.rebasing) return this.rebasing;
		this.rebasing = (async () => {
			try {
				const outcome = await rebaseOntoCurrent(this, this.transport);
				this.rebases.push(outcome);
				this.note(`rebase ${outcome.status}${"outcome" in outcome ? ` ${outcome.outcome}` : ""}`);
				if (outcome.status === "already-current" && !this.online && this.wantOnline) await this.connect();
				return outcome;
			} finally { this.rebasing = null; }
		})();
		return this.rebasing;
	}

	async compact(options: Parameters<typeof runCompaction>[2] = {}): Promise<CompactionOutcome> {
		this.compacting = true;
		try { return await runCompaction(this, this.transport, { snapshotSource: "server", coverPreviousLineage: COVER, ...options }); }
		finally {
			this.compacting = false;
			// A 4409 that arrived while compacting (winner's own old socket, or a loser) is handled now.
			if (this.fenced) await this.rebase();
		}
	}

	async idle(): Promise<void> { while (this.rebasing) await this.rebasing; }

	async close(): Promise<void> {
		this.wantOnline = false;
		this.client.closeListeners.length = 0;
		await this.client.close();
	}
}

// ------------------------------------------------------------------ helpers

async function waitFor(pred: () => boolean | Promise<boolean>, timeoutMs: number, stepMs = 100): Promise<boolean> {
	const deadline = Date.now() + timeoutMs;
	while (Date.now() < deadline) { if (await pred()) return true; await sleep(stepMs); }
	return pred();
}

async function httpText(transport: HttpResetTransport, bodyId: string) {
	const state = await transport.fetchBody(bodyId);
	const doc = new Y.Doc({ guid: bodyId });
	Y.applyUpdate(doc, state.encodedState);
	const text = doc.getText(BODY).toJSON();
	doc.destroy();
	return { ...state, text, encodedBytes: state.encodedState.byteLength };
}

function markerCounts(text: string, markers: string[]) {
	return Object.fromEntries(markers.map((marker) => [marker, text.split(marker).length - 1]));
}

// ------------------------------------------------------------------ B5 race

async function raceScenario(context: Context, stamp: string, edits: number, bFirst = false) {
	const checks: Array<{ name: string; ok: boolean; detail?: unknown }> = [];
	const check = (name: string, ok: boolean, detail?: unknown) => { checks.push({ name, ok, ...(detail === undefined ? {} : { detail }) }); log(`${ok ? "PASS" : "FAIL"} ${name}${detail === undefined ? "" : ` ${JSON.stringify(detail)}`}`); };
	const [ia, ib, ic, id] = await Promise.all(["A", "B", "C", "D"].map((name) => device(context, name)));
	const bodyId = `r2-b5-${stamp}`;
	const seedDoc = bloatedDoc({ guid: bodyId, edits, seed: 55 });
	const seed = Y.encodeStateAsUpdate(seedDoc);
	const seedCensus = measureClientBody(seedDoc).census;
	seedDoc.destroy();
	await createBodyFromUpdate(ia!, bodyId, `relay2-reset/b5-${stamp}.md`, seed);
	log(`created ${bodyId}: ${seed.byteLength} B, ${seedCensus.totalStructs} structs (${seedCensus.deletedStructs} deleted)`);

	const A = new LiveDevice("A", ia!, bodyId, 1);
	const B = new LiveDevice("B", ib!, bodyId, 1);
	const C = new LiveDevice("C", ic!, bodyId, 1);
	const devices = [A, B, C];
	await Promise.all(devices.map((d) => d.connect()));
	const initial = await httpText(A.transport, bodyId);
	check("A/B/C synced to the seeded body", devices.every((d) => d.text() === initial.text), { epoch: initial.epoch, bytes: initial.encodedBytes });

	const markers: string[] = [];
	const mark = (d: LiveDevice, at: number, tag: string) => { const m = `[${tag}-${stamp.slice(-6)}]`; markers.push(m); d.insertAt(at, m); };
	mark(A, 40, "A0"); mark(B, 400, "B0"); mark(C, 800, "C0");
	check("online edits acked", (await Promise.all(devices.map((d) => d.waitAcked(10_000)))).every(Boolean));
	await waitFor(() => devices.every((d) => markers.every((m) => d.text().includes(m))), 10_000);

	await C.disconnect();
	C.wantOnline = false;
	mark(C, 1200, "C1"); mark(C, 2400, "C2"); C.edit((text) => { const m = `[C3-${stamp.slice(-6)}]`; markers.push(m); text.insert(text.length, m); });
	check("C holds offline edits", C.hasPendingLocal() && !C.client.isOpen);

	// Both race for the lease with the real client policy (no force): the body is bloated.
	const trigger = evaluateClientTrigger(A.doc(), { lastCompactedAt: null, postCompactionEncodedStateBytes: null }, Date.now());
	check("client policy requests a lease for the bloated body", trigger.requestLease, { urgency: trigger.decision.urgency, reasons: trigger.decision.reasons });
	const raceStarted = performance.now();
	// Both lease requests leave in the same tick; alternate which is issued first across races.
	const [ra, rb] = bFirst
		? await Promise.all([B.compact(), A.compact()]).then(([b, a]) => [a, b] as const)
		: await Promise.all([A.compact(), B.compact()]);
	const raceMs = performance.now() - raceStarted;
	const statuses = [ra.status, rb.status];
	const winner = ra.status === "installed" ? A : rb.status === "installed" ? B : null;
	const loser = winner === A ? B : A;
	const brief = (o: CompactionOutcome) => o.status === "lost" ? { status: o.status, reason: o.reason, rebase: o.rebase?.status ?? null } : o.status === "lease-denied" ? { status: o.status, reason: o.reason } : { status: o.status };
	check("exactly one reset installs", statuses.filter((s) => s === "installed").length === 1, { A: brief(ra), B: brief(rb),
	});
	if (!winner) {
		const http = Object.fromEntries(devices.map((d) => [d.name, d.transport.timings]));
		await Promise.all(devices.map((d) => d.close()));
		return { bodyId, outcomes: { A: ra, B: rb }, raceMs, http, events: Object.fromEntries(devices.map((d) => [d.name, d.events])), checks, pass: false };
	}
	await Promise.all(devices.map((d) => d.idle()));
	await waitFor(() => loser.epoch() === 2 && loser.client.isOpen, 15_000);
	check("loser fenced (4409) and rebased onto epoch 2", loser.epoch() === 2 && loser.rebases.some((r) => r.status === "rebased"),
		{ fenceCloses: loser.fenceCloses, rebases: loser.rebases.map((r) => r.status) });
	check("winner on epoch 2", winner?.epoch() === 2);

	// Edits on the new epoch from both online devices.
	mark(A, 60, "A2"); mark(B, 600, "B2");
	check("new-epoch edits acked", (await Promise.all([A.waitAcked(10_000), B.waitAcked(10_000)])).every(Boolean));

	// C reconnects: stale epoch → rebase (GET new epoch, three-way merge) → open on epoch 2 → send delta.
	C.wantOnline = true;
	const cRebase = await C.rebase();
	check("C rebased its offline edits onto the new epoch", cRebase?.status === "rebased" && C.epoch() === 2,
		{ status: cRebase?.status, outcome: cRebase && "outcome" in cRebase ? cRebase.outcome : null, conflictCopies: C.conflictCopies.length });
	await C.waitAcked(10_000);

	const D = new LiveDevice("D", id!, bodyId, 2);
	await D.connect();
	const all = [A, B, C, D];
	const converged = await waitFor(async () => {
		const server = await httpText(A.transport, bodyId);
		return all.every((d) => d.text() === server.text) && markers.every((m) => server.text.includes(m));
	}, 20_000, 500);
	const final = await httpText(A.transport, bodyId);
	const counts = markerCounts(final.text, markers);
	check("A, B, C, fresh D and HTTP GET converge", converged, { texts: all.map((d) => d.text() === final.text) });
	check("zero lost edits (every marker exactly once in the GET state)", Object.values(counts).every((n) => n === 1), counts);
	const conflictCopies = all.flatMap((d) => d.conflictCopies);
	const expectedHash = await canonicalMarkdownHash(final.text);
	check("GET x-yaos-content-hash matches the converged text", final.contentHash === expectedHash, { header: final.contentHash?.slice(0, 12) ?? null, text: expectedHash.slice(0, 12) });
	check("no conflict copies needed", conflictCopies.length === 0, conflictCopies.length);
	const finalDoc = new Y.Doc({ guid: bodyId });
	Y.applyUpdate(finalDoc, final.encodedState);
	const finalCensus = measureClientBody(finalDoc).census;
	finalDoc.destroy();
	check("server state is compact after the reset", final.epoch === 2 && finalCensus.encodedStateBytes < initial.encodedBytes / 2,
		{ epoch: final.epoch, bytesBefore: initial.encodedBytes, bytesAfter: finalCensus.encodedStateBytes, structsAfter: finalCensus.totalStructs });

	const result = {
		bodyId, issuedFirst: bFirst ? "B" : "A", seed: { bytes: seed.byteLength, ...seedCensus, edits },
		phase1: { requestLease: trigger.requestLease, decision: trigger.decision, census: trigger.measurement.census },
		outcomes: { A: ra, B: rb }, raceMs,
		winner: winner?.name ?? null,
		devices: Object.fromEntries(all.map((d) => [d.name, { epoch: d.epoch(), events: d.events, rebases: d.rebases, fenceCloses: d.fenceCloses,
			http: d.transport.timings }])),
		markers, markerCounts: counts,
		final: { epoch: final.epoch, encodedBytes: final.encodedBytes, contentHash: final.contentHash, generation: final.generation, census: finalCensus },
		checks, pass: checks.every((c) => c.ok),
	};
	await Promise.all(all.map((d) => d.close()));
	return result;
}

// ------------------------------------------------------------------ deployed upload time

/** Minimal socket-less handle: the doc is whatever the server has. */
class HeadlessHandle implements ResetBodyHandle {
	private current: Y.Doc;
	private text = "";
	constructor(readonly bodyId: string, private currentEpoch: number, state: Uint8Array) {
		this.current = new Y.Doc({ guid: bodyId });
		Y.applyUpdate(this.current, state);
		this.text = canonicalizeMarkdown(this.current.getText(BODY).toJSON());
	}
	epoch() { return this.currentEpoch; }
	doc() { return this.current; }
	durableBaseline() { return this.text; }
	appliedSequence() { return -1; }
	hasPendingLocal() { return false; }
	async installEpoch(transition: ReadySemanticEpochTransition) {
		this.current.destroy();
		this.current = transition.document;
		this.currentEpoch = transition.bodyEpoch;
		this.text = transition.authoritativeContent;
	}
}

/**
 * Create a body with `content` in ≤ 900 KB appends: the first chunk as the create
 * candidate (single-frame candidates are capped at 1.75 MB), the rest as relay
 * socket appends. Relay frames are capped at MAX_DURABLE_UPDATE_BYTES (1.75 MB),
 * but the per-socket token bucket (burst 1 MiB, refill 256 KiB/s by default)
 * rejects any frame > 1 MiB forever, and needs ~3.5 s of refill per 900 KB.
 */
async function createLargeBody(identity: LiveIdentity, bodyId: string, path: string, content: string) {
	const CHUNK = 900_000;
	const doc = new Y.Doc({ guid: bodyId });
	const text = doc.getText(BODY);
	const chunkUpdate = (from: number) => {
		const before = Y.encodeStateVector(doc);
		text.insert(text.length, content.slice(from, from + CHUNK));
		return Y.encodeStateAsUpdate(doc, before);
	};
	await createBodyFromUpdate(identity, bodyId, path, chunkUpdate(0));
	if (content.length <= CHUNK) { doc.destroy(); return; }
	const client = new RawClient(identity, bodyId, new Y.Doc({ guid: bodyId }), relayAdapter(), 1);
	client.forwardLocal = false;
	const opened = await client.open();
	if (opened.status !== "ok") throw new Error(`append socket: ${opened.message}`);
	for (let from = CHUNK; from < content.length; from += CHUNK) {
		const update = chunkUpdate(from);
		await sleep(Math.ceil((update.byteLength / (256 * 1024)) * 1000) + 300); // token-bucket refill
		const since = performance.now();
		const frameId = client.applyAndSend(update);
		if (!await client.waitAck(frameId, since, 30_000)) throw new Error(`append ack timeout at ${from} (rejects ${JSON.stringify(client.rejects.at(-1)?.value ?? null)})`);
	}
	await client.close();
	doc.destroy();
}

async function uploadScenario(context: Context, stamp: string, n: number) {
	const identity = await device(context, "A");
	const rows: Record<string, unknown> = {};
	for (const fixture of ["sized-100k", "sized-1m", "sized-5m"]) {
		const { state } = loadFixture(fixture);
		const source = new Y.Doc();
		Y.applyUpdate(source, state);
		const content = source.getText(BODY).toJSON();
		source.destroy();
		// History-free body with the fixture's text (the bloated 5 MB state is 8.7 MB, above every request limit).
		const bodyId = `r2-b5-up-${fixture}-${stamp}`;
		const seeded = await buildFreshSnapshotFromContent(bodyId, content);
		let created: string | null = null;
		try { await createLargeBody(identity, bodyId, `relay2-reset/upload-${fixture}-${stamp}.md`, seeded.content); }
		catch (error) { created = String(error).slice(0, 300); }
		if (created) { rows[fixture] = { error: `create failed: ${created}` }; log(`${fixture}: ${created}`); continue; }
		const transport = new HttpResetTransport(identity);
		const first = await transport.fetchBody(bodyId);
		const handle = new HeadlessHandle(bodyId, first.epoch, first.encodedState);
		const samples: Array<Record<string, unknown>> = [];
		for (let i = 0; i < n; i++) {
			const outcome = await runCompaction(handle, transport, { force: true, snapshotSource: "server", coverPreviousLineage: COVER });
			const reset = transport.timings.filter((t) => t.route.endsWith("/semantic-reset")).at(-1);
			const lease = transport.timings.filter((t) => t.route.endsWith("/compaction-lease")).at(-1);
			samples.push({ status: outcome.status, ...(outcome.status === "installed" ? { epoch: outcome.epoch, timings: outcome.timings, fresh: outcome.fresh } : { outcome }),
				resetHttp: reset, leaseHttp: lease });
			log(`${fixture} #${i}: ${outcome.status} upload ${reset?.requestBytes} B in ${reset?.ms.toFixed(0)} ms (HTTP ${reset?.status})`);
			if (outcome.status !== "installed") break;
		}
		const ok = samples.filter((s) => s.status === "installed");
		const after = await transport.fetchBody(bodyId);
		rows[fixture] = {
			bodyId, contentBytes: seeded.contentBytes, snapshotBytes: seeded.snapshot.byteLength, n: samples.length, installed: ok.length,
			uploadMs: dist(ok.map((s) => (s.resetHttp as { ms: number }).ms)),
			leaseMs: dist(ok.map((s) => (s.leaseHttp as { ms: number }).ms)),
			requestBytes: (ok[0]?.resetHttp as { requestBytes?: number } | undefined)?.requestBytes ?? null,
			finalEpoch: after.epoch, getMatches: after.contentHash === seeded.contentHash || after.contentHash === null,
			finalContentHash: after.contentHash, expectedContentHash: seeded.contentHash,
			samples,
		};
	}
	return rows;
}

// ------------------------------------------------------------------ main

const args = parseArgs();
COVER = !args.flags["no-cover"];
const host = flagStr(args, "host")?.replace(/\/+$/, "");
if (!host) { console.error("usage: b5.ts --host <url> [--out <json>] [--upload-n 5] [--skip-race] [--skip-upload]"); process.exit(2); }
const stamp = new Date().toISOString().replace(/[:.]/g, "-");
const out = flagStr(args, "out") ?? join(EXP_ROOT, "results/relay2", `B5-${stamp}.json`);
const context = hasContext(host) ? loadContext(host) : await claim(host, ["A", "B", "C", "D"]);
const meta = await startMeta("B5-reset-race", host, "relay");
const body: Record<string, unknown> = {};
let exit = 0;
try {
	if (!args.flags["skip-race"]) {
		const races: Array<Record<string, unknown>> = [];
		body.races = races;
		for (let i = 0; i < flagNum(args, "races", 1); i++) {
			const race = await raceScenario(context, `${stamp.slice(0, 19)}-r${i}`, flagNum(args, "edits", 14_000), i % 2 === 1);
			races.push(race);
			if (!race.pass) exit = 1;
		}
		body.raceSummary = { n: races.length, passed: races.filter((r) => r.pass).length,
			winners: races.map((r) => r.winner ?? null), raceMs: dist(races.map((r) => r.raceMs as number)) };
	}
	if (!args.flags["skip-upload"]) body.upload = await uploadScenario(context, stamp.slice(0, 19), flagNum(args, "upload-n", 5));
} catch (error) {
	body.error = String((error as Error).stack ?? error).slice(0, 2000);
	exit = 1;
	log(`error: ${body.error}`);
}
writeResult(out, meta, body);
process.exit(exit);
