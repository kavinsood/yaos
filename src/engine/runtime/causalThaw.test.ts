/**
 * A causal-hole freeze (DESIGN §d.6) lifts by itself once the hole is gone: the missing row arriving live (a resend),
 * in the reconnect's catch-up, or while the doc is cold. A hole that never fills stays frozen; the reconnect's
 * re-read does not lift it.
 */

import assert from "node:assert/strict";
import { test } from "node:test";
import * as Y from "yjs";
import type { ClientFrameId, DeviceId, StreamName, VaultId } from "../../core/types";
import type { RelaySession } from "../../ports/relay";
import { createNoopCrypto } from "../adapters/noopCrypto";
import { createWebHash } from "../adapters/webHash";
import { sealFrame } from "../ingest/envelope";
import { SimRelay } from "../../sim/relay";
import type { LogEngine } from "./engine";
import { sleep, startTestEngine, until, createDoc, docText } from "./testHarness";

const VAULT = "vault-test" as VaultId;
const noop = createNoopCrypto(createWebHash());

async function rawDevice(relay: SimRelay) {
	const r = await relay.connect({ vaultId: VAULT, deviceId: "dev-x" as DeviceId });
	assert.ok(r.ok);
	const s: RelaySession = r.session;
	let n = 0;
	return {
		async send(stream: StreamName, content: Uint8Array): Promise<void> {
			const cf = `rawframe${String(n++).padStart(14, "0")}` as ClientFrameId;
			const sealed = await sealFrame(noop, VAULT, { stream, deviceId: "dev-x" as DeviceId, clientFrameId: cf, kind: "bodyUpdate", authorNsSeq: 0, flags: 0, frameNo: 0, content });
			s.append({ stream, clientFrameId: cf, payload: sealed.sealed });
		},
		close: () => s.close(1000, "done"),
	};
}

/** Two updates, the second depending on the first's structs. */
function holePair(): [Uint8Array, Uint8Array] {
	const src = new Y.Doc();
	const u: Uint8Array[] = [];
	src.on("update", (x: Uint8Array) => u.push(x));
	src.getText("text").insert(0, "ab");
	src.getText("text").insert(2, "c");
	return [u[0]!, u[1]!];
}

async function frozenByHole(relay: SimRelay) {
	const { engine: a } = await startTestEngine({ relay, deviceId: "dev-a", tuning: { causalRetryMs: 40, causalRetries: 2, provisionalAdoptMs: 40 } });
	const x = await rawDevice(relay);
	await until(() => a.status().phase === "live", 3_000, "live");
	const id = await createDoc(a, "hole.md", "doc;");
	await until(() => a.isIdle(), 3_000, "idle");
	await docText(a, id); // resident: the check stage runs at apply time
	const stream = a.streamOf(id);
	const [first, second] = holePair();
	await x.send(stream, second);
	await until(() => a.c.repo.stream(stream)?.frozen === 1, 3_000, "frozen causal-hole");
	assert.equal(a.c.repo.stream(stream)!.frozenReason, "causal-hole");
	assert.ok(a.status().notices.some((n) => n.code === "frozen:causal-hole"));
	return { a, x, id, stream, first };
}

async function assertThawed(a: LogEngine, stream: StreamName, id: Parameters<typeof docText>[1]): Promise<void> {
	await until(() => a.c.repo.stream(stream)?.frozen === 0, 5_000, "thawed without a user release");
	assert.equal(a.c.repo.stream(stream)!.frozenReason, null);
	assert.ok(!a.status().notices.some((n) => n.code === "frozen:causal-hole"), "notice cleared");
	const text = await docText(a, id);
	assert.ok(text.includes("abc") && text.includes("doc;"), text);
	await sleep(200);
	assert.equal(a.c.repo.stream(stream)!.frozen, 0, "no re-freeze once the hole is filled");
}

test("causal-hole freeze lifts when the missing row arrives live (a late resend)", async () => {
	const relay = new SimRelay();
	const { a, x, id, stream, first } = await frozenByHole(relay);
	try {
		await x.send(stream, first);
		await assertThawed(a, stream, id);
	} finally {
		x.close();
		await a.stop();
	}
});

test("causal-hole freeze lifts when the missing row arrives while the doc is cold", async () => {
	const relay = new SimRelay();
	const { a, x, id, stream, first } = await frozenByHole(relay);
	try {
		a.c.handles.drop(stream);
		assert.ok(!a.c.handles.isResident(stream));
		await x.send(stream, first);
		await assertThawed(a, stream, id);
	} finally {
		x.close();
		await a.stop();
	}
});

test("causal-hole freeze lifts when the reconnect's catch-up brings the missing row", async () => {
	const relay = new SimRelay();
	const { a, x, id, stream, first } = await frozenByHole(relay);
	try {
		relay.setConnectFailure("unavailable");
		relay.dropSession("dev-a" as DeviceId);
		await until(() => a.c.session === null, 3_000, "offline");
		const before = relay.rows(stream).length;
		await x.send(stream, first);
		await until(() => relay.rows(stream).length > before, 3_000, "missing row committed while a is away");
		assert.equal(a.c.repo.stream(stream)!.frozen, 1);
		relay.setConnectFailure(null);
		await assertThawed(a, stream, id);
	} finally {
		x.close();
		await a.stop();
	}
});

test("a hole that never fills stays frozen across a reconnect (the reconnect re-reads it once)", async () => {
	const relay = new SimRelay();
	const { a, x, stream } = await frozenByHole(relay);
	try {
		const reads = a.c.docs.stats.causalReads;
		relay.dropSession("dev-a" as DeviceId);
		await until(() => a.c.session === null, 3_000, "offline");
		await until(() => a.status().phase === "live" && a.isIdle(), 5_000, "back live");
		await until(() => a.c.docs.stats.causalReads > reads, 3_000, "re-read on reconnect");
		await sleep(200);
		assert.equal(a.c.repo.stream(stream)!.frozen, 1);
		assert.equal(a.c.repo.stream(stream)!.frozenReason, "causal-hole");
	} finally {
		x.close();
		await a.stop();
	}
});
