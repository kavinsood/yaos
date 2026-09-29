/**
 * Diagnostics snapshots and the post-scenario convergence check (brief §6.1 / §8.2).
 */
import * as Y from "yjs";
import { vaultRoute } from "../../../tests/live/schema4Live";
import { deviceBearerHeaders, type LiveIdentity } from "../../../tests/live/liveIdentity";
import { json, log, now, r2, sleep } from "./common";
import { contentHashOf, RawClient, type ProtocolAdapter } from "./rawClient";

type Obj = Record<string, unknown>;

/** Compact view of /debug/recent (→ DO /diagnostics). Unknown (future relay) fields pass through under `relay`. */
export async function diagnostics(identity: LiveIdentity, full = false): Promise<Obj> {
	const t0 = now();
	const response = await fetch(vaultRoute(identity, "debug/recent"), { headers: deviceBearerHeaders(identity) });
	const value = await json(response);
	if (!value) return { status: response.status };
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
	const bytes = new Uint8Array(await response.arrayBuffer());
	const elapsedMs = r2(now() - t0);
	if (!response.ok) return { status: response.status, elapsedMs, text: null as string | null, bytes: bytes.byteLength };
	const doc = new Y.Doc();
	Y.applyUpdate(doc, bytes);
	const text = doc.getText("body").toString();
	doc.destroy();
	return { status: response.status, elapsedMs, text, bytes: bytes.byteLength,
		contentHash: response.headers.get("x-yaos-content-hash"), size: Number(response.headers.get("x-yaos-size")),
		generation: Number(response.headers.get("x-yaos-generation")) };
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
		pass: false,
	};
	result.pass = result.liveClientsAgree && result.liveClientsSvAgree && result.freshC.textEqual && result.freshC.svEqual
		&& result.httpGet.textEqual && result.httpGet.headerHashEqual && result.recordedHead.contentHashEqual;
	log(`convergence ${bodyId}: ${result.pass ? "PASS" : "FAIL"} ${JSON.stringify({ c: result.freshC, get: result.httpGet, head: result.recordedHead })}`);
	return result;
}
