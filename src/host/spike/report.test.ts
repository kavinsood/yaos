import { test } from "node:test";
import assert from "node:assert/strict";
import {
	computeOr1Verdict,
	computeVerdicts,
	errInfo,
	formatReport,
	platformLabel,
	settle,
	summarizeOr2,
	TextNames,
	toStep,
	trimStack,
	waitFor,
	type IdbProbeReport,
	type ScenarioReport,
	type SetViewDataCall,
	type SpikeReport,
	type ViewProbeReport,
	type ViewStateSnap,
	type WorkerProbeReport,
} from "./report";

test("errInfo: Error, DOMException-like, primitives", () => {
	assert.deepEqual(errInfo(new TypeError("boom")), { name: "TypeError", message: "boom" });
	assert.deepEqual(errInfo({ name: "QuotaExceededError", message: "full" }), { name: "QuotaExceededError", message: "full" });
	assert.deepEqual(errInfo("nope"), { name: "string", message: "nope" });
	assert.deepEqual(errInfo(null), { name: "object", message: "null" });
	const withStack = errInfo(new Error("x"), true);
	assert.ok(Array.isArray(withStack.stack) && withStack.stack.length > 0);
});

test("settle: ok / async error / sync throw / hang", async () => {
	const ok = await settle(() => Promise.resolve(7), 1000);
	assert.equal(ok.kind, "ok");
	assert.equal(ok.kind === "ok" && ok.value, 7);
	const rej = await settle(() => Promise.reject(new RangeError("r")), 1000);
	assert.equal(rej.kind === "error" && rej.error.name, "RangeError");
	const thrown = await settle(() => {
		throw new Error("sync");
	}, 1000);
	assert.equal(thrown.kind === "error" && thrown.error.message, "sync");
	const hang = await settle(() => new Promise<void>(() => undefined), 30);
	assert.equal(hang.kind, "hang");
	assert.deepEqual(toStep(hang), { ok: false, ms: hang.ms, hang: true });
	assert.deepEqual(toStep(ok, (v) => v * 2), { ok: true, ms: ok.ms, value: 14 });
});

test("waitFor: met, unmet, throwing condition counts as false", async () => {
	let n = 0;
	const met = await waitFor(() => ++n >= 3, 1000, 5);
	assert.equal(met.met, true);
	const unmet = await waitFor(() => false, 40, 5);
	assert.equal(unmet.met, false);
	const throws = await waitFor(() => {
		throw new Error("x");
	}, 30, 5);
	assert.equal(throws.met, false);
});

test("trimStack: drops the V8 header, keeps JSC frames", () => {
	assert.deepEqual(trimStack("Error: probe\n    at a (x.js:1:1)\n    at b (y.js:2:2)", 8), ["at a (x.js:1:1)", "at b (y.js:2:2)"]);
	assert.deepEqual(trimStack("setViewData@app.js:1:2\nonModify@app.js:3:4", 1), ["setViewData@app.js:1:2"]);
	assert.deepEqual(trimStack(undefined), []);
});

test("TextNames maps known texts and summarizes unknown ones", () => {
	const n = new TextNames();
	n.add("textA", "hello\n");
	assert.equal(n.nameOf("hello\n"), "textA");
	assert.equal(n.nameOf("zzz"), 'other(len=3) "zzz"');
	assert.equal(n.nameOf(undefined), "<undefined>");
	assert.equal(n.nameOf(null), "<null>");
	assert.match(n.nameOf("x".repeat(200)), /^other\(len=200\) "x{80}\.\.\."$/);
	assert.deepEqual(n.all(), { textA: "hello\n" });
});

test("platformLabel", () => {
	assert.equal(platformLabel({ isIosApp: true, isPhone: true, isMobileApp: true }), "ios/phone");
	assert.equal(platformLabel({ isAndroidApp: true, isTablet: true }), "android/tablet");
	assert.equal(platformLabel({ isMacOS: true, isDesktopApp: true }), "macos/desktop");
	assert.equal(platformLabel({}), "unknown/?");
});

test("formatReport: never throws; cycles, shared refs, binary, errors, bigint", () => {
	const shared = { s: 1 };
	const o: Record<string, unknown> = { a: shared, b: shared, big: 10n, fn: () => 1, err: new Error("e"), buf: new ArrayBuffer(4), u8: new Uint8Array(3), undef: undefined };
	o.self = o;
	const parsed = JSON.parse(formatReport(o)) as Record<string, unknown>;
	assert.deepEqual(parsed.a, { s: 1 });
	assert.deepEqual(parsed.b, { s: 1 }, "a repeated (non-circular) reference is not a cycle");
	assert.equal(parsed.self, "[circular]");
	assert.equal(parsed.big, "10n");
	assert.equal(parsed.fn, "[function]");
	assert.equal((parsed.err as { name: string }).name, "Error");
	assert.deepEqual(parsed.buf, { ArrayBuffer: true, byteLength: 4 });
	assert.deepEqual(parsed.u8, { view: "Uint8Array", byteLength: 3 });
	assert.ok(!("undef" in parsed));
});

// ---------------------------------------------------------------------------
// OR-1 verdicts
// ---------------------------------------------------------------------------

function idb(ok: boolean, where: "main" | "worker" = "worker"): IdbProbeReport {
	const step = { ok, ms: 1 };
	return { where, typeofIndexedDB: "object", dbName: "x", open: { ok: true, ms: 1 }, put: step, get: step, equal: ok, close: step, deleteDatabase: step, ok, totalMs: 3 };
}

function worker(over: Partial<WorkerProbeReport>): WorkerProbeReport {
	return {
		sourceBytes: 100,
		blobUrl: { ok: true, ms: 0 },
		construct: { ok: true, ms: 1 },
		boot: { received: true, ms: 5 },
		firstPong: { received: true, ms: 6, rttMs: 1 },
		pingRttsMs: [0.5, 0.7],
		probe: { received: true, ms: 10 },
		transfer: { attempted: true, sentBytes: 8, echoed: true, detachedOnSend: true, intact: true },
		events: [],
		terminate: { ok: true, ms: 0 },
		revoke: { ok: true, ms: 0 },
		ok: true,
		totalMs: 20,
		...over,
	};
}

const selfReport = (idbOk: boolean) => ({
	typeofIndexedDB: "object",
	idb: idb(idbOk),
	cryptoSubtle: { typeofSubtle: "object", digest: { ok: true, ms: 1 } },
	typeofWebSocket: "function",
	typeofStructuredClone: "function",
	typeofFetch: "function",
	storagePersisted: { present: false },
});

test("computeOr1Verdict: the three verdicts and the inline suffix", () => {
	const ok = computeOr1Verdict({ worker: worker({ probe: { received: true, report: selfReport(true) } }), inlineIdb: idb(true, "main") });
	assert.equal(ok.line, "worker+IDB OK; inline IDB OK");
	const noIdb = computeOr1Verdict({ worker: worker({ probe: { received: true, report: selfReport(false) } }), inlineIdb: idb(true, "main") });
	assert.equal(noIdb.line, "worker OK, IDB in worker FAILED -> inline fallback; inline IDB OK");
	const probeHang = computeOr1Verdict({ worker: worker({ probe: { received: false, hang: true } }), inlineIdb: idb(false, "main") });
	assert.equal(probeHang.line, "worker OK, IDB in worker FAILED -> inline fallback; inline IDB FAILED");
	const noPong = computeOr1Verdict({ worker: worker({ firstPong: { received: false } }), inlineIdb: idb(true, "main") });
	assert.equal(noPong.verdict, "worker FAILED -> inline fallback");
	const ctorFail = computeOr1Verdict({ worker: worker({ construct: { ok: false, ms: 0, error: { name: "SecurityError", message: "x" } } }), inlineIdb: null });
	assert.equal(ctorFail.line, "worker FAILED -> inline fallback; inline IDB FAILED");
	assert.equal(computeOr1Verdict(undefined).verdict, "worker FAILED -> inline fallback");
});

// ---------------------------------------------------------------------------
// OR-2 summary
// ---------------------------------------------------------------------------

const st = (editor: string, viewData: string, disk?: string): ViewStateSnap => ({ atMs: 0, editor, viewData, getViewData: editor, ...(disk ? { disk } : {}) });

function call(phase: string, over: Partial<SetViewDataCall> = {}): SetViewDataCall {
	return {
		phase,
		atMs: 12,
		argc: 2,
		clear: false,
		thisIsView: true,
		mode: "pass-through",
		incoming: "x",
		incomingLen: 1,
		incomingIsExpected: true,
		viewDataAtCall: "x",
		viewDataIsIncoming: true,
		viewDataIsOld: false,
		getViewDataAtCall: "old",
		editorAtCall: "old",
		origCalled: true,
		hookActions: [],
		stack: [],
		...over,
	};
}

function sc(id: string, expected: string, over: Partial<ScenarioReport>): ScenarioReport {
	return { id, title: id, mode: "pass-through", expected, calls: [], dataSets: [], modifyEvents: [], protoCalls: [], editorChanges: [], notes: [], ...over };
}

function viewReport(scenarios: ScenarioReport[]): ViewProbeReport {
	return {
		apiVersion: "1.9.0",
		texts: {},
		setup: { folder: "yaos-spike-probe", folderCreated: true, filePath: "yaos-spike-probe/p.md" },
		scenarios,
		outside: { calls: [], dataSets: [], modifyEvents: [], protoCalls: [] },
		restore: { attempted: true, ok: true },
		cleanup: { leafDetached: { ok: true, ms: 1 }, fileTrashed: { ok: true, ms: 1 }, folderTrashed: { ok: true, ms: 1 } },
		totalMs: 1000,
	};
}

test("summarizeOr2: reads the scenario facts", () => {
	const r = viewReport([
		sc("A", "textA", { calls: [call("A")], before: st("text0", "text0"), after: st("textA", "textA", "textA") }),
		sc("B", "textB", { calls: [], modifyEvents: [], before: st("textA", "textA"), after: st("textA", "textA", "textB") }),
		sc("C", "textC", {
			mode: "handled",
			calls: [call("C", { mode: "handled", origCalled: false }), call("C:save")],
			before: st("textA", "textA"),
			after: st("textA", "textC", "textC"),
			afterSave: st("textA", "textA", "textA"),
		}),
		sc("C2", "textC2", { mode: "handled", calls: [call("C2")], after: st("merged", "textC2", "merged"), afterSave: st("merged", "merged", "merged") }),
		sc("D", "textD", {
			mode: "handled",
			calls: [call("D", { hookActions: ["data-was-incoming", "restored-data"] })],
			before: st("merged", "merged"),
			after: st("merged", "merged", "textD"),
			afterSave: st("merged", "merged", "textD"),
		}),
		sc("R", "textR", { calls: [call("R")], after: st("textR", "textR") }),
	]);
	const s = summarizeOr2(r);
	assert.equal(s.instanceWrapperIntercepts, true);
	assert.equal(s.editorChangedWithoutInstanceCall, false);
	assert.deepEqual(s.externalModifyClearFlags, [false]);
	assert.equal(s.viewDataAlreadyIncomingAtCall, true);
	assert.deepEqual(s.adapterWrite, { setViewDataFired: false, modifyEventFired: false, firstCallMs: null, editorUpdated: false });
	assert.equal(s.handled.intercepted, true);
	assert.equal(s.handled.editorUnchanged, true);
	assert.equal(s.handled.diskIsIncoming, true);
	assert.equal(s.handled.saveOverwroteDisk, true);
	assert.equal(s.merged.editorIsMerged, true);
	assert.equal(s.merged.diskIsMergedAfterSave, true);
	assert.deepEqual(s.dataRestore, { applicable: true, sticks: true, diskAfterSave: "textD", diskKeptIncomingAfterSave: true });
	assert.equal(s.dirtyEditor.calls, null, "E not run");
	assert.equal(s.readingMode.calls, 1);
	assert.equal(s.restoreOk, true);
	assert.equal(s.cleanupOk, true);
	assert.deepEqual(s.errors, []);
});

test("summarizeOr2: wrapper bypassed, nothing ran", () => {
	const bypass = summarizeOr2(viewReport([sc("A", "textA", { calls: [], protoCalls: [{ phase: "A", atMs: 3 }], after: st("textA", "textA", "textA") })]));
	assert.equal(bypass.instanceWrapperIntercepts, false);
	assert.equal(bypass.editorChangedWithoutInstanceCall, true);
	assert.equal(bypass.protoCallsBypassingInstance, 1);
	assert.equal(bypass.viewDataAlreadyIncomingAtCall, null);
	const none = summarizeOr2(undefined);
	assert.equal(none.ran, false);
	assert.equal(none.instanceWrapperIntercepts, null);
	assert.equal(none.restoreOk, null);
});

test("computeVerdicts: summary lines for a full report", () => {
	const report: SpikeReport = {
		spike: { id: "yaos-spike", version: "0.0.1", build: "b1", startedAt: "t", ran: ["or1", "or2"] },
		env: { apiVersion: "1.9.0", platform: { isIosApp: true, isPhone: true } },
		or1: { worker: worker({ probe: { received: true, report: selfReport(true) } }), cspViolations: [], inlineIdb: idb(true, "main") },
		or2: viewReport([sc("A", "textA", { calls: [call("A")], after: st("textA", "textA", "textA") })]),
	};
	const v = computeVerdicts(report);
	assert.equal(v.platform, "ios/phone");
	assert.equal(v.or1?.verdict, "worker+IDB OK");
	assert.ok(v.lines[0]?.startsWith("Platform: ios/phone | apiVersion 1.9.0"));
	assert.ok(v.lines.includes("OR-1: worker+IDB OK; inline IDB OK"));
	assert.ok(v.lines.some((l) => l.startsWith("OR-2 A vault.modify: instance wrapper called yes (clear=[false]); view.data already incoming at call yes")));
	const failing = computeVerdicts({ ...report, or1: { worker: worker({ construct: { ok: false, ms: 1, error: { name: "SecurityError", message: "blocked" } }, firstPong: { received: false } }), cspViolations: [], inlineIdb: idb(true, "main") } });
	assert.ok(failing.lines.includes("OR-1 worker failure: SecurityError: blocked"));
});
