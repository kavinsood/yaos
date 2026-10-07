/**
 * WP-C relay adapter smoke: drives the production RelayPort adapter (src/engine/adapters/wsRelay.ts +
 * relayHttp.ts) against a REAL streams relay with two enrolled devices.
 *
 *   node --import jiti/register e2e/client/smoke.ts [--host http://127.0.0.1:8787] [--label local]
 *
 * Scenarios: connect refusals (bad token, unknown vault); connect + VAULT_READY fields; ns append ->
 * receipt (+head), peer committed, no echo; b: append -> peer provisional then committed with the joined
 * payload; resend same id -> deduped receipt with the original seq; feed paging; read paging by maxBytes;
 * checkpoint ok / conflict / not-advancing / ahead-of-stream / stream-not-found, read with checkpoint=1;
 * ping -> head (short liveness override); close/reconnect -> new session whose headSeq covers the
 * earlier rows (also for a peer that missed a row while offline); cross-session dedupe; frame-id-conflict;
 * the blob store adapter (src/engine/adapters/httpBlob.ts, R2): probe, A puts 300 KiB, B has + gets it. Blobs
 * travel over HTTP only, never the sequence log.
 *
 * Writes LOG_DIR/client-e2e-wpc-smoke-<label>-<stamp>.json (no secrets) and exits 1 on any failure.
 */
import { execFileSync } from "node:child_process";
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { probeHttpBlob } from "../../src/engine/adapters/httpBlob";
import { createRelayHttp, RelayHttpError } from "../../src/engine/adapters/relayHttp";
import { createWebClock } from "../../src/engine/adapters/webClock";
import { createWebRandom } from "../../src/engine/adapters/webRandom";
import { createWsRelayPort, type WsRelayOptions } from "../../src/engine/adapters/wsRelay";
import { base64urlEncode } from "../../src/core/codec/ids";
import type { ClientFrameId, DeviceId, StreamName, VaultId } from "../../src/core/types";
import type { BlobAddress } from "../../src/ports/crypto";
import type { RelayConnectResult, RelayEvent, RelaySession } from "../../src/ports/relay";
import { nodeXhr } from "./nodeXhr";
import { DEFAULT_LOG_DIR, onboardVault, redact, type OnboardedVault, type OnboardDevice } from "./onboard";

function arg(name: string, fallback: string): string {
	const index = process.argv.indexOf(`--${name}`);
	return index >= 0 && process.argv[index + 1] ? process.argv[index + 1]! : fallback;
}

const HOST = arg("host", process.env.YAOS_E2E_HOST ?? "http://127.0.0.1:8787").replace(/\/+$/, "");
const LABEL = arg("label", "local");
const LOG_DIR = DEFAULT_LOG_DIR;
const STARTED = new Date();
const clock = createWebClock();
const random = createWebRandom();
const t0 = performance.now();
const now = () => performance.now() - t0;
const WAIT_MS = 10_000;

const asStream = (s: string) => s as StreamName;
const asCfid = (s: string) => s as ClientFrameId;

// ---- checks ---------------------------------------------------------------

interface Check { scenario: string; name: string; ok: boolean; detail: unknown }
const checks: Check[] = [];
const latencies: Record<string, number[]> = {};
let scenario = "setup";

function step(name: string): void {
	scenario = name;
	console.log(`\n== ${name}`);
}

function check(name: string, ok: boolean, detail: unknown = null): boolean {
	checks.push({ scenario, name, ok, detail: redact(detail) });
	console.log(`${ok ? "PASS" : "FAIL"} ${name}${ok ? "" : ` ${JSON.stringify(redact(detail))}`}`);
	return ok;
}

function record(name: string, ms: number): void {
	(latencies[name] ??= []).push(Math.round(ms * 10) / 10);
}

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

function bytesEqual(a: Uint8Array | null | undefined, b: Uint8Array | null | undefined): boolean {
	if (!a || !b || a.byteLength !== b.byteLength) return false;
	for (let i = 0; i < a.byteLength; i++) if (a[i] !== b[i]) return false;
	return true;
}

function payloadOf(label: string, size: number): Uint8Array {
	const out = random.bytes(size);
	out.set(new TextEncoder().encode(label).subarray(0, size));
	return out;
}

/** Event summary without payload bytes. */
function brief(event: RelayEvent): unknown {
	if (event.t === "committed") {
		const { payload, ...rest } = event.frame;
		return { t: "committed", ...rest, payloadBytes: payload?.byteLength ?? null };
	}
	if (event.t === "provisional") {
		const { payload, ...rest } = event;
		return { ...rest, payload: undefined, payloadBytes: payload.byteLength };
	}
	return event;
}

// ---- session wrapper --------------------------------------------------------

/** Records every event of one session and lets the smoke await them. */
class Peer {
	readonly events: RelayEvent[] = [];
	private waiters: (() => void)[] = [];
	readonly unsubscribe: () => void;

	constructor(readonly name: string, readonly session: RelaySession) {
		this.unsubscribe = session.onEvent((event) => {
			this.events.push(event);
			for (const wake of this.waiters.splice(0)) wake();
		});
	}

	mark(): number {
		return this.events.length;
	}

	since(from: number): RelayEvent[] {
		return this.events.slice(from);
	}

	/** First event at index >= from matching pred; throws after timeoutMs. */
	async waitFor(pred: (event: RelayEvent) => boolean, from: number, what: string, timeoutMs = WAIT_MS): Promise<{ event: RelayEvent; index: number }> {
		const deadline = performance.now() + timeoutMs;
		for (;;) {
			const index = this.events.findIndex((event, i) => i >= from && pred(event));
			if (index >= 0) return { event: this.events[index]!, index };
			const left = deadline - performance.now();
			if (left <= 0) throw new Error(`${this.name}: timed out waiting for ${what}`);
			await new Promise<void>((resolve) => {
				const timer = setTimeout(resolve, left);
				this.waiters.push(() => { clearTimeout(timer); resolve(); });
			});
		}
	}

	async receipt(stream: string, cfid: string, from: number): Promise<Extract<RelayEvent, { t: "receipt" }>> {
		const { event } = await this.waitFor((e) => (e.t === "receipt" && e.stream === stream && e.clientFrameId === cfid)
			|| (e.t === "refused" && e.stream === stream && e.clientFrameId === cfid) || e.t === "closed", from, `receipt ${stream}/${cfid}`);
		if (event.t !== "receipt") throw new Error(`${this.name}: expected receipt for ${stream}/${cfid}, got ${JSON.stringify(brief(event))}`);
		return event;
	}

	async committed(stream: string, cfid: string, from: number): Promise<{ frame: Extract<RelayEvent, { t: "committed" }>["frame"]; index: number }> {
		const { event, index } = await this.waitFor((e) => e.t === "committed" && e.frame.stream === stream && e.frame.clientFrameId === cfid,
			from, `committed ${stream}/${cfid}`);
		if (event.t !== "committed") throw new Error("unreachable");
		return { frame: event.frame, index };
	}

	append(stream: string, cfid: string, payload: Uint8Array): void {
		this.session.append({ stream: asStream(stream), clientFrameId: asCfid(cfid), payload });
	}
}

function portFor(device: { deviceToken: string }, extra: Partial<WsRelayOptions> = {}) {
	return createWsRelayPort({ baseUrl: HOST, credential: device.deviceToken, clock, random, ...extra });
}

const open: Peer[] = [];

async function connect(name: string, vault: OnboardedVault, device: OnboardDevice, extra: Partial<WsRelayOptions> = {}): Promise<Peer> {
	const started = now();
	const result = await portFor(device, extra).connect({ vaultId: vault.vaultId as VaultId, deviceId: device.deviceId as DeviceId });
	record("connect_ms", now() - started);
	if (!result.ok) throw new Error(`${name}: connect refused (${result.reason})`);
	const peer = new Peer(name, result.session);
	open.push(peer);
	return peer;
}

function describeConnect(result: RelayConnectResult): unknown {
	return result.ok ? { ok: true, headSeq: result.session.headSeq } : { ok: false, reason: result.reason, retryAfterMs: result.retryAfterMs };
}

// ---- scenarios -------------------------------------------------------------

async function main(): Promise<OnboardedVault> {
	step("onboard");
	const tOnboard = now();
	const vault = await onboardVault(HOST, { devices: 2, label: `wpc-smoke-${LABEL}` });
	record("onboard_ms", now() - tOnboard);
	const [devA, devB] = vault.devices;
	if (!devA || !devB) throw new Error("onboarding returned fewer than 2 devices");
	check("vault with 2 devices", vault.devices.length === 2 && devA.deviceId !== devB.deviceId,
		{ via: vault.via, vaultIdPrefix: vault.vaultId.slice(0, 8), generation: vault.vaultGeneration });
	const vaultId = vault.vaultId as VaultId;
	const httpB = createRelayHttp({ baseUrl: HOST, credential: devB.deviceToken, clock });

	step("blob store (R2) over HTTP");
	const blobA = await probeHttpBlob({ baseUrl: HOST, vaultId, credential: devA.deviceToken, clock, xhr: nodeXhr });
	const blobB = await probeHttpBlob({ baseUrl: HOST, vaultId, credential: devB.deviceToken, clock, xhr: nodeXhr });
	check("capabilities: attachments on (R2 bound), maxBlobBytes > 0", !!blobA && !!blobB && blobA.maxBlobBytes > 0, { maxBlobBytes: blobA?.maxBlobBytes ?? null });
	if (blobA && blobB) {
		const blob = payloadOf("smoke blob", 300 * 1024);
		const address = Buffer.from(random.bytes(32)).toString("hex") as BlobAddress;
		const tPut = now();
		await blobA.put(address, [blob.subarray(0, 1000), blob.subarray(1000)]);
		record("blob_put_300k_ms", now() - tPut);
		const present = await blobB.has([address]);
		check("B has() the address", present.has(address), [...present].length);
		const tGet = now();
		const got = await blobB.get(address);
		record("blob_get_300k_ms", now() - tGet);
		check("B get() returns the parts' concatenation", bytesEqual(got, blob), { bytes: got?.byteLength ?? null });
	}

	step("connect refusals");
	const bogus = await portFor({ deviceToken: `bogus-${random.bytes(4).join("")}` }).connect({ vaultId, deviceId: devA.deviceId as DeviceId });
	check("bad device token -> unauthorized", !bogus.ok && bogus.reason === "unauthorized", describeConnect(bogus));
	if (bogus.ok) bogus.session.close(1000, "unexpected");
	const unknownVault = await portFor(devA).connect({ vaultId: base64urlEncode(random.bytes(16)) as VaultId, deviceId: devA.deviceId as DeviceId });
	check("unknown vault -> refused (unauthorized|not-found)", !unknownVault.ok
		&& (unknownVault.reason === "unauthorized" || unknownVault.reason === "not-found"), describeConnect(unknownVault));
	if (unknownVault.ok) unknownVault.session.close(1000, "unexpected");

	step("connect + VAULT_READY");
	const a = await connect("A", vault, devA);
	const b = await connect("B", vault, devB);
	for (const peer of [a, b]) {
		const s = peer.session;
		check(`${peer.name}: vaultEpoch = vaultGeneration, head 0, canWrite`, s.vaultEpoch === vault.vaultGeneration && s.headSeq === 0 && s.canWrite,
			{ vaultEpoch: s.vaultEpoch, headSeq: s.headSeq, canWrite: s.canWrite });
		const l = s.limits;
		check(`${peer.name}: limits populated`, l.maxFrameBytes > 0 && l.maxCheckpointBytes > 0 && l.appendBytesPerSec > 0 && l.burstBytes > 0
			&& l.feedPageRows > 0 && l.readPageBytes > 0, l);
		check(`${peer.name}: bufferedBytes 0 when idle`, s.bufferedBytes() === 0, s.bufferedBytes());
	}

	step("ns append -> receipt, peer committed");
	const nsPayload = payloadOf("ns op 1", 300);
	let fromA = a.mark();
	let fromB = b.mark();
	let tAppend = now();
	a.append("ns", "a-ns-1", nsPayload);
	const nsReceipt = await a.receipt("ns", "a-ns-1", fromA);
	record("append_receipt_ms", now() - tAppend);
	check("A receipt seq 1, not deduped", nsReceipt.seq === 1 && !nsReceipt.deduped, nsReceipt);
	const headAfterReceipt = await a.waitFor((e) => e.t === "head", fromA, "head after receipt");
	check("A head event after receipt (STREAM_RECEIPTS.head)", headAfterReceipt.event.t === "head" && headAfterReceipt.event.headSeq >= 1,
		headAfterReceipt.event);
	const nsCommitted = await b.committed("ns", "a-ns-1", fromB);
	record("peer_commit_ms", now() - tAppend);
	check("B committed ns with A's payload", nsCommitted.frame.seq === 1 && nsCommitted.frame.deviceId === devA.deviceId
		&& bytesEqual(nsCommitted.frame.payload, nsPayload), brief({ t: "committed", frame: nsCommitted.frame }));
	check("ns is commit-only: B saw no provisional", !b.since(fromB).some((e) => e.t === "provisional"), b.since(fromB).map(brief));
	check("no echo: A got no committed for its own frame", !a.since(fromA).some((e) => e.t === "committed"), a.since(fromA).map(brief));

	step("b: append -> provisional, then committed (joined)");
	const doc = "b:wpc-smoke-doc";
	const bodyPayload = payloadOf("body update 1", 700);
	fromA = a.mark();
	fromB = b.mark();
	tAppend = now();
	a.append(doc, "a-b-1", bodyPayload);
	const provisional = await b.waitFor((e) => e.t === "provisional" && e.stream === doc && e.clientFrameId === "a-b-1", fromB, "provisional");
	record("peer_provisional_ms", now() - tAppend);
	check("B provisional with payload + deviceId", provisional.event.t === "provisional" && provisional.event.deviceId === devA.deviceId
		&& bytesEqual(provisional.event.payload, bodyPayload), brief(provisional.event));
	const bodyCommitted = await b.committed(doc, "a-b-1", fromB);
	record("peer_commit_ms", now() - tAppend);
	const bodyReceipt = await a.receipt(doc, "a-b-1", fromA);
	check("B committed after provisional, payload joined from PROVISIONAL", bodyCommitted.index > provisional.index
		&& bodyCommitted.frame.seq === 2 && bytesEqual(bodyCommitted.frame.payload, bodyPayload),
	brief({ t: "committed", frame: bodyCommitted.frame }));
	check("A receipt seq 2", bodyReceipt.seq === 2 && !bodyReceipt.deduped, bodyReceipt);

	step("resend same id -> deduped receipt");
	fromA = a.mark();
	fromB = b.mark();
	a.append("ns", "a-ns-1", nsPayload);
	const dedupe = await a.receipt("ns", "a-ns-1", fromA);
	check("deduped receipt carries the original seq", dedupe.deduped && dedupe.seq === nsReceipt.seq, dedupe);
	await sleep(800);
	check("store-deduped ns resend is not re-broadcast", !b.since(fromB).some((e) => e.t === "committed" && e.frame.clientFrameId === "a-ns-1"),
		b.since(fromB).map(brief));

	step("bulk writes (feed/read fixtures)");
	const sent = new Map<string, Uint8Array>([["a-b-1", bodyPayload]]);
	const lastSeqOf = new Map<string, number>([["ns", nsReceipt.seq], [doc, bodyReceipt.seq]]);
	const extraStreams = ["c:wpc-canvas", "b:wpc-doc-2", "b:wpc-doc-3", "cfg"];
	fromA = a.mark();
	const bulkIds: string[] = [];
	for (let i = 0; i < 8; i++) {
		const cfid = `a-bulk-${i}`;
		const payload = payloadOf(cfid, 400);
		sent.set(cfid, payload);
		bulkIds.push(cfid);
		a.append(doc, cfid, payload);
	}
	for (const stream of extraStreams) a.append(stream, `a-${stream}`, payloadOf(stream, 64));
	for (const cfid of bulkIds) lastSeqOf.set(doc, Math.max(lastSeqOf.get(doc) ?? 0, (await a.receipt(doc, cfid, fromA)).seq));
	for (const stream of extraStreams) lastSeqOf.set(stream, (await a.receipt(stream, `a-${stream}`, fromA)).seq);
	const head = Math.max(...lastSeqOf.values());
	check("bulk receipts contiguous to head", head === 2 + bulkIds.length + extraStreams.length, Object.fromEntries(lastSeqOf));
	await b.waitFor((e) => e.t === "committed" && e.frame.seq === head, 0, "B caught up to head");

	step("feed paging");
	const entries = new Map<string, number>();
	let after = 0;
	let pages = 0;
	let lastThrough = 0;
	let monotonic = true;
	for (;;) {
		const page = await httpB.feed(vaultId, after, 2);
		pages++;
		for (const entry of page.entries) entries.set(entry.stream, entry.lastSeq);
		if (page.entries.length > 2 || page.throughSeq <= lastThrough) monotonic = false;
		lastThrough = page.throughSeq;
		if (!page.more) {
			check("last page: throughSeq = headSeq = head", page.throughSeq === head && page.headSeq === head, page);
			break;
		}
		after = page.throughSeq;
		if (pages > 20) break;
	}
	check("feed limit=2 pages: >= 3 pages, <= 2 entries each, throughSeq increasing", pages >= 3 && monotonic, { pages });
	check("feed pages cover every stream with its lastSeq", entries.size === lastSeqOf.size
		&& [...lastSeqOf].every(([stream, seq]) => entries.get(stream) === seq), Object.fromEntries(entries));
	const whole = await b.session.feed(0);
	check("session.feed(0) default limit: one page, all streams", !whole.more && whole.entries.length === lastSeqOf.size && whole.headSeq === head,
		{ entries: whole.entries.length, more: whole.more, headSeq: whole.headSeq });
	const empty = await b.session.feed(head);
	check("feed(head) is empty", empty.entries.length === 0 && !empty.more && empty.throughSeq === head, empty);

	step("read paging by maxBytes");
	const rows: { seq: number; clientFrameId: string; deviceId: string; payload: Uint8Array }[] = [];
	let readAfter = 0;
	let readPages = 0;
	for (;;) {
		const page = await httpB.read(vaultId, doc, readAfter, false, 1000);
		readPages++;
		rows.push(...page.rows);
		if (!page.more) {
			check("last read page: lastSeq = stream lastSeq, no checkpoint", page.lastSeq === lastSeqOf.get(doc) && page.checkpoint === null
				&& page.checkpointSeq === 0, { lastSeq: page.lastSeq, checkpointSeq: page.checkpointSeq });
			break;
		}
		readAfter = page.nextAfterSeq;
		if (readPages > 30) break;
	}
	const expected = ["a-b-1", ...bulkIds];
	check("maxBytes=1000 over 9 rows of <=700 B pages >= 4", readPages >= 4, { readPages });
	check("read returns every row once, ascending, with payloads", rows.length === expected.length
		&& rows.every((row, i) => row.clientFrameId === expected[i] && row.deviceId === devA.deviceId
			&& bytesEqual(row.payload, sent.get(row.clientFrameId)) && (i === 0 || row.seq > rows[i - 1]!.seq)),
	{ rows: rows.map((r) => `${r.seq}:${r.clientFrameId}`) });
	const wholeRead = await b.session.read(asStream(doc), 0, false);
	check("session.read default page holds the whole stream", !wholeRead.more && wholeRead.rows.length === expected.length,
		{ rows: wholeRead.rows.length, more: wholeRead.more });
	const unknownRead = await b.session.read(asStream("b:never-written"), 0, false);
	check("read of an unknown stream: lastSeq 0, no rows", unknownRead.lastSeq === 0 && unknownRead.rows.length === 0 && !unknownRead.more,
		{ lastSeq: unknownRead.lastSeq, rows: unknownRead.rows.length });

	step("checkpoint CAS");
	const cover = rows[rows.length - 3]!.seq;
	const ckpt = payloadOf("checkpoint state", 2048);
	const tc = now();
	const put = await a.session.putCheckpoint(asStream(doc), cover, 0, ckpt);
	record("checkpoint_put_ms", now() - tc);
	check("putCheckpoint ok", put.t === "ok", put);
	const conflict = await b.session.putCheckpoint(asStream(doc), head, 0, ckpt);
	check("stale expected -> conflict with currentCoversSeq", conflict.t === "conflict" && conflict.currentCoversSeq === cover, conflict);
	const notAdvancing = await b.session.putCheckpoint(asStream(doc), cover, cover, ckpt);
	check("coversSeq <= current -> refused not-advancing", notAdvancing.t === "refused" && notAdvancing.reason === "not-advancing", notAdvancing);
	const ahead = await b.session.putCheckpoint(asStream(doc), head + 100, cover, ckpt);
	check("coversSeq > stream lastSeq -> refused ahead-of-stream", ahead.t === "refused" && ahead.reason === "ahead-of-stream", ahead);
	const missing = await b.session.putCheckpoint(asStream("b:never-written"), 1, 0, ckpt);
	check("unknown stream -> refused stream-not-found", missing.t === "refused" && missing.reason === "stream-not-found", missing);
	const withCkpt = await b.session.read(asStream(doc), 0, true);
	check("read checkpoint=1: checkpoint bytes + only rows after coversSeq", withCkpt.checkpoint !== null
		&& withCkpt.checkpoint.coversSeq === cover && bytesEqual(withCkpt.checkpoint.bytes, ckpt) && withCkpt.checkpointSeq === cover
		&& withCkpt.rows.length === 2 && withCkpt.rows.every((row) => row.seq > cover) && withCkpt.nextAfterSeq === lastSeqOf.get(doc),
	{ coversSeq: withCkpt.checkpoint?.coversSeq, rows: withCkpt.rows.map((r) => r.seq), checkpointSeq: withCkpt.checkpointSeq,
		nextAfterSeq: withCkpt.nextAfterSeq });
	const noPrefer = await httpB.read(vaultId, doc, 0, false, null);
	check("read without checkpoint=1 (rows not GC'd): rows from the start, checkpointSeq reported", noPrefer.checkpointSeq === cover
		&& (noPrefer.checkpoint === null ? noPrefer.rows.length === expected.length : noPrefer.rows.every((row) => row.seq > cover)),
	{ checkpoint: noPrefer.checkpoint?.coversSeq ?? null, rows: noPrefer.rows.length, checkpointSeq: noPrefer.checkpointSeq });
	const ckptAfter = await b.session.read(asStream(doc), cover, true);
	check("read after=coversSeq with checkpoint=1 skips the checkpoint", ckptAfter.checkpoint === null && ckptAfter.rows.length === 2,
		{ checkpoint: ckptAfter.checkpoint?.coversSeq ?? null, rows: ckptAfter.rows.length });
	const advance = await a.session.putCheckpoint(asStream(doc), lastSeqOf.get(doc)!, cover, payloadOf("checkpoint 2", 512));
	check("advancing CAS ok", advance.t === "ok", advance);
	try {
		await createRelayHttp({ baseUrl: HOST, credential: "bogus-token", clock }).feed(vaultId, 0, null);
		check("HTTP with a bad token throws RelayHttpError", false, "no throw");
	} catch (error) {
		check("HTTP with a bad token throws RelayHttpError (401, no secret in message)", error instanceof RelayHttpError && error.status === 401
			&& !error.message.includes("bogus-token"), error instanceof RelayHttpError ? { status: error.status, code: error.code, message: error.message } : String(error));
	}

	step("ping -> head");
	const pinger = await connect("A-ping", vault, devA, { liveness: { idleMs: 1200, timeoutMs: 5000 } });
	const fromPing = pinger.mark();
	const tPing = now();
	const pong = await pinger.waitFor((e) => e.t === "head" || e.t === "closed", fromPing, "pong head", 6000);
	record("ping_head_ms", now() - tPing);
	check("idle session pings; VAULT_PONG -> head = current head", pong.event.t === "head" && pong.event.headSeq === head, pong.event);
	await sleep(1500);
	check("session survives repeated pings", !pinger.since(fromPing).some((e) => e.t === "closed")
		&& pinger.since(fromPing).filter((e) => e.t === "head").length >= 2, pinger.since(fromPing).map(brief));
	pinger.session.close(1000, "done");

	step("close / reconnect");
	fromA = a.mark();
	a.session.close(1000, "smoke reconnect");
	const closedA = a.since(fromA).find((e) => e.t === "closed");
	check("close() emits closed synchronously, once", closedA !== undefined && closedA.t === "closed" && closedA.code === 1000
		&& a.since(fromA).filter((e) => e.t === "closed").length === 1, a.since(fromA).map(brief));
	a.append("ns", "a-after-close", payloadOf("dropped", 10));
	check("append after close is dropped silently", a.since(fromA).length === 1, a.since(fromA).map(brief));
	const a2 = await connect("A2", vault, devA);
	check("A2 headSeq covers every earlier row", a2.session.headSeq === head && a2.session.vaultEpoch === vault.vaultGeneration,
		{ headSeq: a2.session.headSeq, head });

	b.session.close(1000, "offline");
	const missed = payloadOf("missed while B offline", 200);
	let fromA2 = a2.mark();
	a2.append("ns", "a-ns-missed", missed);
	const missedSeq = (await a2.receipt("ns", "a-ns-missed", fromA2)).seq;
	check("A2 append while B offline: seq = head + 1", missedSeq === head + 1, { missedSeq });
	const b2 = await connect("B2", vault, devB);
	check("B2 headSeq covers the row it missed", b2.session.headSeq === missedSeq, { headSeq: b2.session.headSeq, missedSeq });
	const catchUp = await b2.session.feed(head);
	const nsRead = await b2.session.read(asStream("ns"), nsReceipt.seq, false);
	check("B2 catches up via feed + read", catchUp.entries.some((e) => e.stream === "ns" && e.lastSeq === missedSeq)
		&& nsRead.rows.length === 1 && nsRead.rows[0]?.clientFrameId === "a-ns-missed" && bytesEqual(nsRead.rows[0]?.payload, missed),
	{ feed: catchUp.entries, rows: nsRead.rows.map((r) => r.seq) });
	const fromB2 = b2.mark();
	fromA2 = a2.mark();
	tAppend = now();
	a2.append(doc, "a2-b-live", payloadOf("live after reconnect", 128));
	const live = await b2.committed(doc, "a2-b-live", fromB2);
	record("peer_commit_ms", now() - tAppend);
	check("live delivery on the new sessions", live.frame.seq === missedSeq + 1, brief({ t: "committed", frame: live.frame }));
	await a2.receipt(doc, "a2-b-live", fromA2);

	step("cross-session dedupe + frame-id-conflict");
	fromA2 = a2.mark();
	a2.append("ns", "a-ns-1", nsPayload);
	const crossDedupe = await a2.receipt("ns", "a-ns-1", fromA2);
	check("resend from a new session dedupes by (deviceId, clientFrameId)", crossDedupe.deduped && crossDedupe.seq === nsReceipt.seq, crossDedupe);
	fromA2 = a2.mark();
	const fromB2c = b2.mark();
	a2.append("ns", "a-ns-1", payloadOf("different bytes", 300));
	const refusal = await a2.waitFor((e) => (e.t === "refused" || e.t === "receipt") && e.clientFrameId === "a-ns-1", fromA2, "conflict refusal");
	check("same id, different bytes -> refused frame-id-conflict with conflictSeq", refusal.event.t === "refused"
		&& refusal.event.reason === "frame-id-conflict" && refusal.event.stream === "ns"
		&& (refusal.event.conflictSeq === null || refusal.event.conflictSeq === nsReceipt.seq), refusal.event);
	fromA2 = a2.mark();
	a2.append(doc, "a2-after-conflict", payloadOf("after conflict", 64));
	const afterConflict = await a2.receipt(doc, "a2-after-conflict", fromA2);
	check("a refusal does not fence later frames", afterConflict.seq === missedSeq + 2 && !afterConflict.deduped, afterConflict);
	await b2.committed(doc, "a2-after-conflict", fromB2c);
	check("peer never saw the conflicting frame", !b2.since(fromB2c).some((e) => (e.t === "committed" && e.frame.clientFrameId === "a-ns-1")
		|| (e.t === "provisional" && e.clientFrameId === "a-ns-1")), b2.since(fromB2c).map(brief));
	fromA2 = a2.mark();
	a2.append("b:wpc-conflict-doc", "a2-bc-1", payloadOf("first", 32));
	await a2.receipt("b:wpc-conflict-doc", "a2-bc-1", fromA2);
	const fromB2d = b2.mark();
	fromA2 = a2.mark();
	a2.append("b:wpc-conflict-doc", "a2-bc-1", payloadOf("second", 32));
	const bRefusal = await a2.waitFor((e) => (e.t === "refused" || e.t === "receipt") && e.clientFrameId === "a2-bc-1", fromA2, "b: conflict");
	check("b: conflict -> refused frame-id-conflict", bRefusal.event.t === "refused" && bRefusal.event.reason === "frame-id-conflict", bRefusal.event);
	await sleep(500);
	const peerSide = b2.since(fromB2d).filter((e) => (e.t === "provisional" || e.t === "provisionalDropped") && e.clientFrameId === "a2-bc-1");
	check("b: conflict on the peer: provisional followed by provisionalDropped", peerSide.length === 2 && peerSide[0]?.t === "provisional"
		&& peerSide[1]?.t === "provisionalDropped", peerSide.map(brief));

	step("teardown");
	for (const peer of [a2, b2]) peer.session.close(1000, "smoke done");
	const unexpected = [a2, b2].flatMap((peer) => peer.events.filter((e) => e.t === "closed" && e.code !== 1000).map((e) => ({ peer: peer.name, e })));
	check("no unexpected closes", unexpected.length === 0, unexpected);
	return vault;
}

// ---- run + report ------------------------------------------------------------

let vaultInfo: OnboardedVault | null = null;
let fatal: string | null = null;
try {
	vaultInfo = await main();
} catch (error) {
	fatal = error instanceof Error ? error.message : String(error);
	check("run completed", false, fatal);
} finally {
	for (const peer of open) {
		try { peer.session.close(1000, "smoke exit"); } catch { /* already closed */ }
	}
}

let sha: string | null = null;
try { sha = execFileSync("git", ["-C", new URL("../..", import.meta.url).pathname, "rev-parse", "--short", "HEAD"]).toString().trim(); }
catch { /* not a checkout */ }

function summary(values: number[]) {
	const sorted = [...values].sort((x, y) => x - y);
	const at = (q: number) => sorted[Math.min(sorted.length - 1, Math.floor(q * (sorted.length - 1) + 0.5))];
	return { n: sorted.length, min: sorted[0], p50: at(0.5), max: sorted.at(-1) };
}

const failed = checks.filter((c) => !c.ok);
const scenarios: Record<string, { passed: number; failed: number }> = {};
for (const c of checks) {
	const entry = (scenarios[c.scenario] ??= { passed: 0, failed: 0 });
	if (c.ok) entry.passed++;
	else entry.failed++;
}
const result = {
	label: LABEL,
	host: HOST,
	startedAt: STARTED.toISOString(),
	durationMs: Math.round(now()),
	sha,
	vault: vaultInfo ? { vaultIdPrefix: vaultInfo.vaultId.slice(0, 8), via: vaultInfo.via, devices: vaultInfo.devices.length } : null,
	passed: checks.length - failed.length,
	failed: failed.length,
	fatal,
	scenarios,
	latencyMs: Object.fromEntries(Object.entries(latencies).map(([name, values]) => [name, { ...summary(values), samples: values }])),
	checks,
};
let text = JSON.stringify(result, null, 2);
const secrets = vaultInfo ? vaultInfo.devices.map((d) => d.deviceToken) : [];
if (secrets.some((secret) => text.includes(secret))) {
	for (const secret of secrets) text = text.split(secret).join("<redacted>");
	console.log("FAIL results contained a device token (redacted before writing)");
	failed.push({ scenario: "report", name: "results contain no secrets", ok: false, detail: null });
}
mkdirSync(LOG_DIR, { recursive: true });
const stamp = STARTED.toISOString().replace(/[-:]/g, "").replace(/\.\d+Z$/, "Z");
const out = join(LOG_DIR, `client-e2e-wpc-smoke-${LABEL.replace(/[^a-z0-9.-]/gi, "_")}-${stamp}.json`);
writeFileSync(out, text);
console.log(`\n${Object.entries(scenarios).map(([name, s]) => `${s.failed ? "FAIL" : "ok  "} ${name} (${s.passed}/${s.passed + s.failed})`).join("\n")}`);
console.log(`\n${failed.length === 0 ? "PASS" : "FAIL"}: ${checks.length - failed.length}/${checks.length} checks${fatal ? ` (fatal: ${fatal})` : ""}`);
console.log(`results: ${out}`);
process.exit(failed.length === 0 ? 0 : 1);
