/**
 * Frame-builder cost benchmark (DESIGN §d.3/§d.4, §k.3 WP-C #3).
 *
 * Always on: 5 MB doc bound through a host view, 1000 keystrokes (burst and
 * paced = one frame per keystroke) -> zero encodeStateAsUpdate calls on the
 * keystroke path (instrumented counter), every frame committed, a fresh peer
 * converges afterwards. Local compaction / checkpoints are maintenance jobs
 * (amortized, one re-encode per LOCAL_COMPACT_ROWS rows) and are disabled
 * for the counted window; their cost is reported separately.
 *
 * YAOS_BENCH=1 also times 50 KB vs 5 MB and prints ms/keystroke.
 */

import assert from "node:assert/strict";
import { test } from "node:test";
import * as Y from "yjs";
import type { DocId } from "../../core/types";
import { compactBody } from "../body/compaction";
import { resetYjsCounters, yjsCounters } from "../body/yjsCounters";
import { SimRelay } from "../sync/__standins__/simRelay";
import type { LogEngine } from "./engine";
import { converged, sleep, startTestEngine, until } from "./testHarness";

const QUIET = { compactRows: 1e9, compactBytes: 1e15, checkpoint: { rows: 1e9, bytes: 1e15, idleMs: 1e9, fallbackMs: 1e9, nsRows: 1e9, nsBytes: 1e15 } };
const BUDGETS = { maxResidentBytes: 512 * 1024 * 1024, maxResidentDocs: 64 };

function bigText(chars: number): string {
	const line = "The quick brown fox jumps over the lazy dog; 0123456789 abcdefghij.\n";
	return line.repeat(Math.ceil(chars / line.length)).slice(0, chars);
}

async function bound(e: LogEngine, id: DocId): Promise<Y.Doc> {
	const doc = new Y.Doc();
	const b = await e.bind(id);
	Y.applyUpdate(doc, b.state, "engine");
	doc.on("update", (u: Uint8Array, origin: unknown) => {
		if (origin !== "engine") e.applyLocalUpdate(id, u);
	});
	return doc;
}

interface Run {
	readonly syncMsPerKey: number;
	readonly totalMs: number;
	readonly frames: number;
	readonly encodes: number;
	readonly merges: number;
}

async function typeInto(e: LogEngine, doc: Y.Doc, keys: number, paced: boolean): Promise<Run> {
	const t = doc.getText("text");
	let seed = 7;
	const rnd = () => (seed = (seed * 1103515245 + 12345) % 2147483648) / 2147483648;
	const frames0 = e.c.docs.stats.framesClosed;
	resetYjsCounters();
	let syncMs = 0;
	const start = performance.now();
	for (let i = 0; i < keys; i++) {
		const at = Math.floor(rnd() * t.length);
		const k0 = performance.now();
		t.insert(at, String.fromCharCode(97 + (i % 26)));
		syncMs += performance.now() - k0;
		if (paced) await sleep(3);
	}
	await until(() => e.isIdle(), 30_000, "idle after typing");
	const totalMs = performance.now() - start;
	return { syncMsPerKey: syncMs / keys, totalMs, frames: e.c.docs.stats.framesClosed - frames0, encodes: yjsCounters.encodeStateAsUpdate, merges: yjsCounters.mergeUpdates };
}

async function setupDoc(relay: SimRelay, chars: number) {
	const { engine: a } = await startTestEngine({ relay, deviceId: "dev-a", tuning: QUIET, extra: { budgets: BUDGETS } });
	await until(() => a.status().phase === "live", 3_000, "live");
	const t0 = performance.now();
	const id = await a.createDoc("big.md", bigText(chars));
	await until(() => a.isIdle(), 30_000, "created");
	const createMs = performance.now() - t0;
	const doc = await bound(a, id);
	return { a, id, doc, createMs };
}

test("benchmark: 5 MB doc, 1000 keystrokes (burst + paced) -> zero encodeStateAsUpdate on the keystroke path", async () => {
	const relay = new SimRelay();
	const { a, id, doc, createMs } = await setupDoc(relay, 5 * 1024 * 1024);
	let b: LogEngine | null = null;
	try {
		assert.equal(await a.docText(id), doc.getText("text").toString());
		const burst = await typeInto(a, doc, 1000, false);
		assert.equal(burst.encodes, 0, "burst: no full-state encode");
		assert.ok(burst.frames >= 4 && burst.frames <= 40, `burst frames ${burst.frames} (FRAME_MAX_UPDATES caps)`);
		const paced = await typeInto(a, doc, 1000, true);
		assert.equal(paced.encodes, 0, "paced: no full-state encode");
		assert.ok(paced.frames >= 200, `paced frames ${paced.frames}`);
		assert.equal(a.c.outbox.size, 0);
		const want = doc.getText("text").toString();
		assert.equal(await a.docText(id), want);
		const stream = a.streamOf(id);
		const c0 = performance.now();
		resetYjsCounters();
		const comp = await compactBody(a.c.deps, stream);
		const compactMs = performance.now() - c0;
		assert.equal(comp.t, "ok");
		assert.equal(yjsCounters.encodeStateAsUpdate, 1, "compaction = exactly one scratch re-encode");
		console.log(`bench 5MB: create ${createMs.toFixed(0)}ms; burst ${burst.frames} frames, ${(burst.syncMsPerKey * 1000).toFixed(1)}us/key sync, ${burst.totalMs.toFixed(0)}ms total; ` +
			`paced ${paced.frames} frames, ${(paced.syncMsPerKey * 1000).toFixed(1)}us/key sync, ${paced.totalMs.toFixed(0)}ms total; encodes ${burst.encodes}/${paced.encodes}, merges ${burst.merges}/${paced.merges}; one compaction ${compactMs.toFixed(0)}ms`);
		b = (await startTestEngine({ relay, deviceId: "dev-b", tuning: QUIET, extra: { budgets: BUDGETS } })).engine;
		await converged([a, b], 30_000);
		assert.equal(await b.docText(id), want);
	} finally {
		await a.stop();
		await b?.stop();
	}
});

test("benchmark timing: 50 KB vs 5 MB per-keystroke cost (YAOS_BENCH=1)", { skip: process.env.YAOS_BENCH !== "1" }, async () => {
	const rows: string[] = [];
	const results: Record<string, Run> = {};
	for (const [name, chars] of [["50KB", 50 * 1024], ["5MB", 5 * 1024 * 1024]] as const) {
		const relay = new SimRelay();
		const { a, doc } = await setupDoc(relay, chars);
		try {
			await typeInto(a, doc, 200, false); // warm-up
			const burst = await typeInto(a, doc, 1000, false);
			const paced = await typeInto(a, doc, 1000, true);
			results[name] = paced;
			assert.equal(burst.encodes + paced.encodes, 0);
			rows.push(`${name}: burst ${(burst.syncMsPerKey * 1000).toFixed(1)}us/key sync (${burst.frames} frames, ${burst.totalMs.toFixed(0)}ms to idle); ` +
				`paced ${(paced.syncMsPerKey * 1000).toFixed(1)}us/key sync (${paced.frames} frames, ${((paced.totalMs - 3 * 1000) / paced.frames).toFixed(2)}ms/frame beyond pacing)`);
		} finally {
			await a.stop();
		}
	}
	console.log(`bench timing:\n  ${rows.join("\n  ")}`);
});
