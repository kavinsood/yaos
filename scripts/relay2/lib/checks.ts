/**
 * Diagnostics snapshots and the post-scenario convergence check (brief §6.1 / §8.2).
 */
import * as Y from "yjs";
import { vaultRoute } from "../../../tests/live/schema4Live";
import { deviceBearerHeaders, type LiveIdentity } from "../../../tests/live/liveIdentity";
import { json, log, now, r2, sleep } from "./common";
import { ALL_CLIENTS, contentHashOf, RawClient, type ProtocolAdapter } from "./rawClient";

type Obj = Record<string, unknown>;

/** Compact view of /debug/recent (→ DO /diagnostics). Unknown (future relay) fields pass through under `relay`. */
export async function diagnostics(identity: LiveIdentity, full = false): Promise<Obj> {
	// A transient network error (e.g. UND_ERR_CONNECT_TIMEOUT) must not abort a long scenario.
	for (let attempt = 1; ; attempt++) {
		try { return await diagnosticsOnce(identity, full); }
		catch (error) {
			if (attempt >= 3) return { at: Date.now(), error: String(error).slice(0, 300) };
			log(`diagnostics attempt ${attempt} failed: ${String(error).slice(0, 120)}; retrying`);
			await sleep(1000 * attempt);
		}
	}
}

async function diagnosticsOnce(identity: LiveIdentity, full: boolean): Promise<Obj> {
	const t0 = now();
	const response = await fetch(vaultRoute(identity, "debug/recent"), { headers: deviceBearerHeaders(identity) });
	const value = await json(response);
	if (!value) return { status: response.status };
	// Relay deploys expose counters on GET /diagnostics (protocol doc §5.4); absent/404 on base.
	if (value.relay === undefined) {
		const r = await fetch(vaultRoute(identity, "diagnostics"), { headers: deviceBearerHeaders(identity) }).catch(() => null);
		const d = r?.ok ? await json(r) : null;
		if (d?.relay !== undefined) value.relay = d.relay;
	}
	if (full) return { at: Date.now(), elapsedMs: r2(now() - t0), ...value };
	const loaded = (value.loaded as Array<Obj> | undefined) ?? [];
	const durable = (value.semanticCompactionDurable as Array<Obj> | undefined) ?? [];
	const known = new Set(["loaded", "semanticCompactionDurable", "semanticCompaction", "persistence", "loadFailures",
		"pending", "semanticCanvas", "vaultId", "vaultGeneration", "provisionedAt", "schemaVersion", "storageFormatVersion",
		"protocolVersion", "snapshotFormatVersion", "settingsFormatVersion"]);
	const rest = Object.fromEntries(Object.entries(value).filter(([k]) => !known.has(k)));
	return {
		at: Date.now(), elapsedMs: r2(now() - t0),
		residentBodies: loaded.filter((d) => d.kind !== "root").length,
		residentRoot: loaded.some((d) => d.kind === "root"),
		residentEncodedStateBytes: loaded.reduce((s, d) => s + (Number(d.residentEncodedStateBytes) || 0), 0),
		pendingUpdates: Object.values((value.pending as Obj | undefined) ?? {}).reduce((s: number, v) => s + (Number(v) || 0), 0),
		journal: durable.map((d) => ({ documentId: d.documentId, journal: d.journal, tail: d.tail })).slice(0, 20),
		...rest,
	};
}

export async function bodyHead(identity: LiveIdentity, bodyId: string) {
	const response = await fetch(vaultRoute(identity, `head/${encodeURIComponent(bodyId)}`), { headers: deviceBearerHeaders(identity) });
	return { status: response.status, value: await json(response) };
}

export async function bodyGet(identity: LiveIdentity, bodyId: string) {
	const t0 = now();
	const response = await fetch(vaultRoute(identity, `body/${encodeURIComponent(bodyId)}`), { headers: deviceBearerHeaders(identity) });
	// Headers arrive once the server has produced the response (fetch resolves); the rest is transfer.
	const ttfbMs = r2(now() - t0);
	const bytes = new Uint8Array(await response.arrayBuffer());
	const elapsedMs = r2(now() - t0);
	const cfRay = response.headers.get("cf-ray");
	if (!response.ok) return { status: response.status, elapsedMs, ttfbMs, cfRay, text: null as string | null, bytes: bytes.byteLength };
	const doc = new Y.Doc();
	Y.applyUpdate(doc, bytes);
	const text = doc.getText("body").toString();
	doc.destroy();
	return { status: response.status, elapsedMs, ttfbMs, downloadMs: r2(elapsedMs - ttfbMs), cfRay, text, bytes: bytes.byteLength,
		contentHash: response.headers.get("x-yaos-content-hash"), size: Number(response.headers.get("x-yaos-size")),
		generation: Number(response.headers.get("x-yaos-generation")),
		// All X-YAOS-* headers (round-2 relay adds body sequence headers; see docs/relay2-protocol.md).
		yaosHeaders: Object.fromEntries([...response.headers.entries()].filter(([k]) => k.startsWith("x-yaos-"))),
		storedHash: contentHashOf(text).contentHash };
}

function svEqual(a: Uint8Array, b: Uint8Array) {
	const da = Y.decodeStateVector(a);
	const db = Y.decodeStateVector(b);
	const keys = new Set([...da.keys(), ...db.keys()]);
	for (const k of keys) if ((da.get(k) ?? 0) !== (db.get(k) ?? 0)) return false;
	return true;
}

/**
 * A, B (and any other live clients), a fresh C synced from scratch, the HTTP GET body and the recorded
 * head hash must all agree. Waits up to `settleMs` for the server's recorded hash to catch up
 * (base commits on a 250 ms debounce).
 */
export async function convergence(options: {
	bodyId: string; clients: RawClient[]; fresh: LiveIdentity; adapter: ProtocolAdapter; settleMs?: number; bodyEpoch?: number;
	expectedTextSha?: string;
}): Promise<Obj> {
	const { bodyId, clients, fresh, adapter } = options;
	const settleMs = options.settleMs ?? 15_000;
	const deadline = now() + settleMs;
	const reference = clients[0]!;
	// Resilient clients: let in-flight reconnects finish and unacked frames drain before comparing.
	await Promise.all(clients.map((c) => c.settled()));
	while (now() < deadline && clients.some((c) => c.unacked > 0 && c.adapter.requireEcho === true && c.isOpen)) await sleep(100);
	// Live clients converge with each other first.
	while (now() < deadline && !clients.every((c) => c.text() === reference.text() && svEqual(c.stateVector(), reference.stateVector()))) await sleep(50);
	const text = reference.text();
	const expected = contentHashOf(text);
	const c = new RawClient(fresh, bodyId, undefined, adapter, options.bodyEpoch ?? 1);
	const cOpen = await c.open(60_000);
	await sleep(200);
	const cText = cOpen.status === "ok" ? c.text() : null;
	const cSvEqual = cOpen.status === "ok" ? svEqual(c.stateVector(), reference.stateVector()) : false;
	const cBytes = c.bytesIn;
	await c.close();
	let get = await bodyGet(fresh, bodyId);
	let head = await bodyHead(fresh, bodyId);
	while (now() < deadline && (get.text !== text || head.value?.contentHash !== expected.contentHash)) {
		await sleep(250);
		get = await bodyGet(fresh, bodyId);
		head = await bodyHead(fresh, bodyId);
	}
	const result = {
		bodyId,
		clientTextLength: text.length,
		clientContentHash: expected.contentHash,
		liveClientsAgree: clients.every((x) => x.text() === text),
		liveClientsSvAgree: clients.every((x) => svEqual(x.stateVector(), reference.stateVector())),
		freshC: { status: cOpen.status, textEqual: cText === text, svEqual: cSvEqual, bytesIn: cBytes },
		httpGet: { status: get.status, textEqual: get.text === text, headerHashEqual: get.contentHash === expected.contentHash,
			sizeEqual: get.size === expected.size, generation: get.generation ?? null },
		recordedHead: { status: head.status, contentHashEqual: head.value?.contentHash === expected.contentHash,
			sizeEqual: head.value?.size === expected.size, generation: head.value?.generation ?? null },
		expectedTextSha: options.expectedTextSha ?? null,
		// Server-recorded hash vs client canonical hash; "unknown" = the server recorded no hash (envelope-less frames).
		hashStatus: head.value?.contentHash == null ? "unknown" : head.value.contentHash === expected.contentHash ? "match" : "mismatch",
		// D6 invariant #7: a recorded hash always describes the stored merged state (GET body), whether or not it equals the client.
		d6Invariant7: {
			headVsStored: head.value?.contentHash == null ? "unknown" : head.value.contentHash === get.storedHash ? "holds" : "VIOLATED",
			getHeaderVsStored: get.contentHash == null ? "unknown" : get.contentHash === get.storedHash ? "holds" : "VIOLATED",
		},
		getYaosHeaders: get.yaosHeaders ?? null,
		// Connection loss on any live client (server/platform close, dropped frames, unacked relay frames at check time).
		connectionLoss: clients.some((x) => x.lostConnection),
		connections: clients.map((x) => x.connectionReport()),
		failureCause: null as string | null,
		pass: false,
	};
	result.pass = result.liveClientsAgree && result.liveClientsSvAgree && result.freshC.textEqual && result.freshC.svEqual
		&& result.httpGet.textEqual && result.httpGet.headerHashEqual && result.recordedHead.contentHashEqual
		&& result.d6Invariant7.headVsStored !== "VIOLATED" && result.d6Invariant7.getHeaderVsStored !== "VIOLATED";
	if (!result.pass) {
		const unacked = clients.reduce((n, x) => n + (x.adapter.requireEcho === true ? x.unacked : 0), 0);
		const dropped = clients.reduce((n, x) => n + x.droppedWhileClosed, 0);
		const open = clients.every((x) => x.isOpen);
		result.failureCause = result.connectionLoss
			? `connection-loss (closes=${clients.map((x) => x.closeLog.filter((c) => !c.byClient).map((c) => `${c.code}:${c.reason || c.origin}`).join("|")).join(",")}; dropped=${dropped}; unacked=${unacked}; allOpen=${open})`
			: unacked > 0 ? `unacked-frames=${unacked} without connection loss` : "divergence without connection loss";
	}
	log(`convergence ${bodyId}: ${result.pass ? "PASS" : "FAIL"}${result.failureCause ? ` cause=${result.failureCause}` : ""} ${JSON.stringify({ c: result.freshC, get: result.httpGet, head: result.recordedHead })}`);
	return result;
}

/** The round-4 no-silent-drops outcome counters (docs/relay2-protocol.md §3.3/§4.3): each non-empty frame ends in exactly one. */
export const FRAME_OUTCOMES = ["appendFrames", "noopSkips", "dedupeHits", "dedupeConflicts", "batchDuplicateCandidates", "authorityCloses",
	"authorityDrops", "rateLimitCloses", "epochFences", "bodyInactiveCloses", "tooLargeCloses", "commitFailures", "frameErrors",
	// v3 (YAOS_RELAY_GROUP_COMMIT): a buffered frame dropped by the test-only relay-crash route (absent/0 on v2).
	"groupDropped",
	// v3: a frame after a refused frame of the same socket, dropped unacked (cumulative-ack safety).
	"failedSocketDrops"] as const;
const COUNTER_KEYS = ["updateFrames", ...FRAME_OUTCOMES, "emptySkips", "postCommitErrors", "appends", "rowsWritten", "checkpoints",
	"checkpointsFromCache", "leanCatalogEvents", "leanCoalesceRowsWritten", "envelopeMismatches",
	// v3 group commit (absent on v2 deployments).
	"groupCommits", "groupFrames", "groupFlushIdle", "groupFlushMax", "groupFlushBytes", "groupFlushForced", "groupFlushDedupes",
	"tailCheckpoints", "tailJournalFallbacks", "pendingReplayFrames", "wakeResyncs", "wakeResyncSockets",
	"groupFlushReads", "wakeHeldAcks", "wakeHeldAcksDropped"];

/** Snapshot of relay counters + every client's sent-frame totals (null counters on base / flag off). */
export async function frameCounters(identity: LiveIdentity) {
	const d = await diagnostics(identity, true);
	const relay = d.relay as Obj | undefined;
	const counters = (relay?.counters as Obj | undefined) ?? null;
	return {
		at: Date.now(), relayEnabled: relay?.enabled ?? null,
		counters: counters ? Object.fromEntries(COUNTER_KEYS.map((k) => [k, Number(counters[k] ?? 0)])) : null,
		lastFrameError: relay?.lastFrameError ?? null,
		clientNonEmptyFrames: ALL_CLIENTS.reduce((n, c) => n + c.nonEmptyFramesSent, 0),
		clientFrames: ALL_CLIENTS.reduce((n, c) => n + c.updateFramesSent, 0),
		clientResent: ALL_CLIENTS.reduce((n, c) => n + c.resentFrames, 0),
	};
}

/**
 * Delta between two snapshots, asserting (1) the outcome counters sum to updateFrames and (2) updateFrames equals the
 * non-empty frames our clients sent in the window. Counters are per DO runtime: a decrease means the DO was evicted in the
 * window, and then no assertion is possible (counterResetInWindow). Only valid when no other traffic hits the vault.
 */
export function frameAccounting(before: Awaited<ReturnType<typeof frameCounters>>, after: Awaited<ReturnType<typeof frameCounters>>) {
	const clientNonEmptyFrames = after.clientNonEmptyFrames - before.clientNonEmptyFrames;
	const clientResent = after.clientResent - before.clientResent;
	if (!before.counters || !after.counters) return { available: false, relayEnabled: after.relayEnabled, clientNonEmptyFrames, clientResent };
	const delta = Object.fromEntries(Object.keys(after.counters).map((k) => [k, after.counters![k]! - (before.counters![k] ?? 0)]));
	const counterResetInWindow = Object.values(delta).some((v) => v < 0);
	const outcomeSum = FRAME_OUTCOMES.reduce((n, k) => n + (delta[k] ?? 0), 0);
	const pass = counterResetInWindow ? null : outcomeSum === delta.updateFrames && delta.updateFrames === clientNonEmptyFrames;
	return { available: true, relayEnabled: after.relayEnabled, counterResetInWindow, delta, outcomeSum,
		updateFrames: delta.updateFrames, clientNonEmptyFrames, clientResent,
		sumEqualsUpdateFrames: counterResetInWindow ? null : outcomeSum === delta.updateFrames,
		updateFramesEqualsClientFrames: counterResetInWindow ? null : delta.updateFrames === clientNonEmptyFrames,
		pass, lastFrameError: after.lastFrameError };
}
