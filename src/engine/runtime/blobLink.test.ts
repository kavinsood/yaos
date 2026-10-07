/**
 * The session loop ends blob store calls in flight when it declares the relay link dead (sessionLoop.ts
 * abortTransfers, blobs/transferLink.ts): an abnormal close (1006), a failed liveness check (4000), a pause
 * (disconnect) or a park. A close the relay sent cleanly (1001 drain) leaves them running.
 */

import assert from "node:assert/strict";
import { test } from "node:test";
import type { DiagnosticsEvent } from "../../protocol/status";
import type { BlobDeleteResult, BlobListPage, BlobPort } from "../../ports/blob";
import type { BlobAddress } from "../../ports/crypto";
import { SimRelay } from "../../sim/relay";
import { BlobLinkLostError, TransferLink } from "../blobs/transferLink";
import type { LogEngine } from "./engine";
import { startTestEngine, testPorts, testStorage, until } from "./testHarness";

const A = "dev-a-0123456789abcdef";

/** A call that answers only when its signal aborts (a stalled link). */
function hung<T>(signal: AbortSignal | undefined): Promise<T> {
	return new Promise((_resolve, reject) => {
		if (!signal) return; // never answers: the test would time out
		signal.addEventListener("abort", () => reject(signal.reason), { once: true });
	});
}

/** A store whose get and GC calls answer only when their signal aborts. */
class HungStore implements BlobPort {
	readonly maxBlobBytes = 1024 * 1024;
	async has(): Promise<ReadonlySet<BlobAddress>> { return new Set(); }
	async put(): Promise<void> {}
	get(_a: BlobAddress, signal?: AbortSignal): Promise<Uint8Array | null> { return hung(signal); }
	list(_c: BlobAddress | null, signal?: AbortSignal): Promise<BlobListPage> { return hung(signal); }
	deleteIfUploadedBefore(_a: readonly BlobAddress[], _cutoff: number, signal?: AbortSignal): Promise<readonly BlobDeleteResult[]> { return hung(signal); }
}

async function device(relay: SimRelay): Promise<{ engine: LogEngine; diags: DiagnosticsEvent[] }> {
	const storage = testStorage();
	const diags: DiagnosticsEvent[] = [];
	const { engine } = await startTestEngine({
		relay, deviceId: A, storage,
		extra: { ports: { ...testPorts(relay, storage), blob: new HungStore() }, onDiag: (e) => diags.push(e) },
	});
	await until(() => engine.status().phase === "live", 3_000, "live");
	return { engine, diags };
}

/** A get through the engine's linked blob port, settled or still pending. */
function pendingGet(engine: LogEngine): { readonly settled: () => unknown } {
	let out: unknown = "pending";
	engine.c.deps.blob!.get("addr-hung" as BlobAddress).then((v) => (out = v), (e: unknown) => (out = e));
	return { settled: () => out };
}

test("link lost: an abnormal close (1006) and a failed liveness check (4000) abort the blob calls in flight; a 1001 drain does not", async () => {
	const relay = new SimRelay();
	const { engine, diags } = await device(relay);
	try {
		for (const code of [1006, 4000]) {
			const get = pendingGet(engine);
			await until(() => engine.c.blobLink.inFlight === 1, 1_000, "get in flight");
			relay.dropSession(A as never, code);
			await until(() => get.settled() !== "pending", 2_000, `aborted by ${code}`);
			const err = get.settled();
			assert.ok(err instanceof BlobLinkLostError, `close ${code}: ${String(err)}`);
			assert.equal(err.why, `close ${code}`);
			assert.ok(diags.some((d) => d.code === "blob-transfers-aborted" && d.fields.why === `close ${code}` && d.fields.n === 1));
			await until(() => engine.status().phase === "live", 3_000, "reconnected");
		}
		const drained = pendingGet(engine);
		await until(() => engine.c.blobLink.inFlight === 1, 1_000, "get in flight");
		relay.drain();
		await until(() => diags.some((d) => d.code === "session-closed" && d.fields.code === 1001), 2_000, "drained");
		await until(() => engine.status().phase === "live", 3_000, "reconnected after the drain");
		assert.equal(drained.settled(), "pending", "a clean close by the relay leaves the transfer to its idle watchdog");
		assert.equal(engine.c.blobLink.inFlight, 1);
		// Pausing ends it (and the next get gets a fresh signal).
		engine.disconnect();
		await until(() => drained.settled() !== "pending", 2_000, "aborted by the pause");
		assert.ok(drained.settled() instanceof BlobLinkLostError);
		assert.equal(engine.c.blobLink.inFlight, 0);
		assert.ok(diags.some((d) => d.code === "blob-transfers-aborted" && typeof d.fields.why === "string" && /close|disconnect/.test(d.fields.why)));
	} finally {
		await engine.stop();
	}
});

test("link lost: the GC calls (list, deleteIfUploadedBefore) are aborted with the transfers; the caller's own signal still ends each", async () => {
	const link = new TransferLink();
	const store = link.wrap(new HungStore())!;
	const settle = (p: Promise<unknown>): (() => unknown) => {
		let out: unknown = "pending";
		p.then((v) => (out = v), (e: unknown) => (out = e));
		return () => out;
	};
	const list = settle(store.list(null));
	const del = settle(store.deleteIfUploadedBefore(["a" as BlobAddress], 0));
	assert.equal(link.inFlight, 2);
	assert.equal(link.abort("close 1006"), 2);
	await until(() => list() !== "pending" && del() !== "pending", 1_000, "GC calls aborted");
	for (const out of [list(), del()]) assert.ok(out instanceof BlobLinkLostError && out.why === "close 1006", String(out));
	assert.equal(link.inFlight, 0);

	const sweep = new AbortController();
	const next = settle(store.list(null, sweep.signal));
	sweep.abort(new Error("sweep stopped"));
	await until(() => next() !== "pending", 1_000, "caller abort");
	assert.equal((next() as Error).message, "sweep stopped");
	assert.equal(link.inFlight, 0);
});
