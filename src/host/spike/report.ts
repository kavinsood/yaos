// YAOS day-1 spike: pure report types and helpers (no obsidian runtime imports,
// so node:test can load this file). Throwaway code: answers OR-1 (Blob-URL
// worker + IndexedDB inside it, else inline fallback) and OR-2 (how an open
// MarkdownView is reloaded when its file changes underneath, and whether a
// per-instance setViewData wrapper can intercept it).

export interface ErrInfo {
	name: string;
	message: string;
	stack?: string[];
}

export function errInfo(e: unknown, withStack = false): ErrInfo {
	if (e && typeof e === "object") {
		const o = e as { name?: unknown; message?: unknown; stack?: unknown; constructor?: { name?: unknown } };
		const name = typeof o.name === "string" ? o.name : typeof o.constructor?.name === "string" ? o.constructor.name : "Object";
		const message = typeof o.message === "string" ? o.message : safeString(e);
		const out: ErrInfo = { name, message };
		if (withStack) out.stack = trimStack(o.stack, 8);
		return out;
	}
	return { name: typeof e, message: safeString(e) };
}

function safeString(v: unknown): string {
	try {
		return String(v);
	} catch {
		return "<unprintable>";
	}
}

export const defaultNow = (): number => (typeof performance !== "undefined" && typeof performance.now === "function" ? performance.now() : Date.now());

export const r1 = (n: number): number => Math.round(n * 10) / 10;

export type Settled<T> =
	| { kind: "ok"; value: T; ms: number }
	| { kind: "error"; error: ErrInfo; ms: number }
	| { kind: "hang"; ms: number };

/** Run `run`, never throw, and report a hang if it does not settle within `timeoutMs`. */
export function settle<T>(run: () => Promise<T> | T, timeoutMs: number, now: () => number = defaultNow): Promise<Settled<T>> {
	const t0 = now();
	return new Promise((resolve) => {
		let done = false;
		const finish = (s: Settled<T>): void => {
			if (done) return;
			done = true;
			clearTimeout(timer);
			resolve(s);
		};
		const timer: ReturnType<typeof setTimeout> = setTimeout(() => finish({ kind: "hang", ms: r1(now() - t0) }), timeoutMs);
		try {
			Promise.resolve(run()).then(
				(value) => finish({ kind: "ok", value, ms: r1(now() - t0) }),
				(e: unknown) => finish({ kind: "error", error: errInfo(e), ms: r1(now() - t0) }),
			);
		} catch (e) {
			finish({ kind: "error", error: errInfo(e), ms: r1(now() - t0) });
		}
	});
}

export interface StepResult {
	ok: boolean;
	ms: number;
	hang?: boolean;
	skipped?: boolean;
	error?: ErrInfo;
	value?: unknown;
}

export function toStep<T>(s: Settled<T>, value?: (v: T) => unknown): StepResult {
	if (s.kind === "ok") {
		const out: StepResult = { ok: true, ms: s.ms };
		if (value) {
			try {
				out.value = value(s.value);
			} catch (e) {
				out.value = `<value error: ${errInfo(e).message}>`;
			}
		}
		return out;
	}
	if (s.kind === "error") return { ok: false, ms: s.ms, error: s.error };
	return { ok: false, ms: s.ms, hang: true };
}

export const skipped = (why?: string): StepResult => (why ? { ok: false, ms: 0, skipped: true, value: why } : { ok: false, ms: 0, skipped: true });

export function sleep(ms: number): Promise<void> {
	return new Promise((resolve) => setTimeout(resolve, ms));
}

/** Poll `cond` (exceptions count as false) until true or `timeoutMs`. */
export async function waitFor(cond: () => boolean, timeoutMs: number, intervalMs = 50, now: () => number = defaultNow): Promise<{ met: boolean; ms: number }> {
	const t0 = now();
	const check = (): boolean => {
		try {
			return cond();
		} catch {
			return false;
		}
	};
	while (now() - t0 < timeoutMs) {
		if (check()) return { met: true, ms: r1(now() - t0) };
		await sleep(intervalMs);
	}
	const met = check();
	return { met, ms: r1(now() - t0) };
}

/** First `lines` frames of a stack, dropping the V8 "Error" header line. */
export function trimStack(stack: unknown, lines = 8): string[] {
	if (typeof stack !== "string") return [];
	const all = stack
		.split("\n")
		.map((s) => s.trim())
		.filter((s) => s.length > 0);
	if (all.length > 0 && /^(Error|[A-Za-z]*Error)(:|$)/.test(all[0] ?? "")) all.shift();
	return all.slice(0, lines).map((s) => (s.length > 200 ? `${s.slice(0, 200)}...` : s));
}

/** Maps known probe texts to short names so the report reads "textA" instead of a blob of text. */
export class TextNames {
	private readonly byText = new Map<string, string>();
	private readonly byName = new Map<string, string>();

	add(name: string, text: string): string {
		this.byText.set(text, name);
		this.byName.set(name, text);
		return text;
	}

	nameOf(v: unknown): string {
		if (typeof v !== "string") return `<${v === null ? "null" : typeof v}>`;
		const n = this.byText.get(v);
		if (n !== undefined) return n;
		return `other(len=${v.length}) ${JSON.stringify(v.length > 80 ? `${v.slice(0, 80)}...` : v)}`;
	}

	textOf(name: string): string | undefined {
		return this.byName.get(name);
	}

	all(): Record<string, string> {
		const out: Record<string, string> = {};
		for (const [name, text] of this.byName) out[name] = text;
		return out;
	}
}

export function platformLabel(flags: Record<string, unknown>): string {
	const f = (k: string): boolean => flags[k] === true;
	const os = f("isIosApp") ? "ios" : f("isAndroidApp") ? "android" : f("isMacOS") ? "macos" : f("isWin") ? "windows" : f("isLinux") ? "linux" : "unknown";
	const form = f("isPhone") ? "phone" : f("isTablet") ? "tablet" : f("isDesktopApp") ? "desktop" : f("isMobileApp") ? "mobile" : "?";
	return `${os}/${form}`;
}

/** Compact local timestamp for file names: 2026-10-05-1432. */
export function stamp(d = new Date()): string {
	const p = (n: number): string => String(n).padStart(2, "0");
	return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}-${p(d.getHours())}${p(d.getMinutes())}${p(d.getSeconds())}`;
}

// ---------------------------------------------------------------------------
// OR-1 report types
// ---------------------------------------------------------------------------

export interface IdbProbeReport {
	where: "main" | "worker";
	typeofIndexedDB: string;
	accessError?: ErrInfo;
	hasDatabasesFn?: boolean;
	dbName: string;
	open: StepResult & { upgradeFired?: boolean; upgradeError?: ErrInfo; blocked?: boolean };
	put: StepResult;
	get: StepResult;
	/** Read-back record deep-equals the written one (text, number, Uint8Array bytes, nested). */
	equal: boolean | null;
	close: StepResult;
	deleteDatabase: StepResult & { blocked?: boolean };
	/** open + put + get + equal all succeeded. deleteDatabase is reported separately. */
	ok: boolean;
	totalMs: number;
}

export interface WorkerSelfReport {
	location?: string;
	userAgent?: string;
	hardwareConcurrency?: number;
	typeofIndexedDB: string;
	idb: IdbProbeReport;
	cryptoSubtle: { typeofSubtle: string; digest: StepResult };
	typeofWebSocket: string;
	typeofStructuredClone: string;
	typeofFetch: string;
	storagePersisted: { present: boolean; result?: StepResult };
}

export interface WorkerEventRecord {
	type: string;
	atMs: number;
	message?: string;
	filename?: string;
	lineno?: number;
	colno?: number;
	detail?: unknown;
}

export interface TransferProbe {
	attempted: boolean;
	sentBytes: number;
	/** sender's ArrayBuffer.byteLength right after postMessage(msg, [buf]); 0 means it was transferred (detached). */
	senderByteLengthAfterPost?: number;
	detachedOnSend?: boolean;
	echoed: boolean;
	echoMs?: number;
	workerReceivedBytes?: number;
	workerPatternOk?: boolean;
	/** worker-side byteLength after posting the echo back with a transfer list. */
	workerByteLengthAfterPost?: number | null;
	echoBytes?: number;
	intact?: boolean;
	error?: ErrInfo;
	hang?: boolean;
}

export interface WorkerProbeReport {
	sourceBytes: number;
	blobUrl: StepResult;
	construct: StepResult;
	boot: { received: boolean; ms?: number };
	firstPong: { received: boolean; ms?: number; rttMs?: number };
	pingRttsMs: number[];
	probe: { received: boolean; ms?: number; hang?: boolean; report?: WorkerSelfReport; error?: ErrInfo };
	transfer: TransferProbe;
	events: WorkerEventRecord[];
	terminate: StepResult;
	revoke: StepResult;
	/** worker constructed and answered the first ping. */
	ok: boolean;
	totalMs: number;
}

export interface Or1Report {
	worker: WorkerProbeReport | null;
	workerCrash?: ErrInfo;
	cspViolations: unknown[];
	inlineIdb: IdbProbeReport | null;
	inlineCrash?: ErrInfo;
}

// ---------------------------------------------------------------------------
// OR-2 report types
// ---------------------------------------------------------------------------

export type WrapperMode = "pass-through" | "handled";

/** View state; every text is a TextNames name ("textA", "other(len=..) ..."). */
export interface ViewStateSnap {
	atMs: number;
	editor: string;
	viewData: string;
	getViewData: string;
	disk?: string;
	vaultRead?: string;
	mode?: string;
	internalDirty?: unknown;
}

export interface SetViewDataCall {
	phase: string;
	atMs: number;
	argc: number;
	clear: unknown;
	thisIsView: boolean;
	mode: WrapperMode;
	incoming: string;
	incomingLen: number;
	incomingIsExpected: boolean;
	viewDataAtCall: string;
	viewDataIsIncoming: boolean;
	/** view.data === the text the view showed when the scenario started. */
	viewDataIsOld: boolean;
	getViewDataAtCall: string;
	editorAtCall: string;
	origCalled: boolean;
	origError?: ErrInfo;
	hookActions: string[];
	hookError?: ErrInfo;
	wrapperError?: ErrInfo;
	editorAfter?: string;
	viewDataAfter?: string;
	stack: string[];
}

export interface DataSetRecord {
	phase: string;
	atMs: number;
	prev: string;
	next: string;
	nextIsExpected: boolean;
	insideWrapper: boolean;
	stack: string[];
}

export interface PhaseEvent {
	phase: string;
	atMs: number;
	insideWrapper?: boolean;
}

export interface ScenarioReport {
	id: string;
	title: string;
	mode: WrapperMode;
	expected: string;
	before?: ViewStateSnap;
	trigger?: StepResult;
	waited?: { met: boolean; ms: number };
	calls: SetViewDataCall[];
	dataSets: DataSetRecord[];
	modifyEvents: PhaseEvent[];
	/** Calls that reached the PROTOTYPE setViewData with this === view, i.e. bypassed the instance wrapper. */
	protoCalls: PhaseEvent[];
	editorChanges: PhaseEvent[];
	after?: ViewStateSnap;
	save?: StepResult;
	afterSave?: ViewStateSnap;
	notes: string[];
	raw?: Record<string, string>;
	error?: ErrInfo;
	durationMs?: number;
}

export type PropKind = "own-value" | "own-accessor" | "inherited-value" | "inherited-accessor" | "absent";

export interface ViewProbeReport {
	apiVersion: string;
	texts: Record<string, string>;
	setup: {
		folder: string;
		folderCreated: boolean;
		filePath: string;
		create?: StepResult;
		openFile?: StepResult;
		loadIfDeferred?: StepResult;
		viewType?: string;
		isMarkdownView?: boolean;
		loaded?: { met: boolean; ms: number };
		modeAtOpen?: string;
		viewState?: unknown;
		editorExists?: boolean;
		viewFilePath?: string | null;
		setViewDataOwnBefore?: boolean;
		setViewDataProtoOwner?: string;
		dataKindBefore?: PropKind;
		wrapperInstalled?: boolean;
		dataAccessorInstalled?: boolean;
		protoDetectorInstalled?: boolean;
		error?: ErrInfo;
	};
	scenarios: ScenarioReport[];
	/** setViewData calls / data sets / modify events that happened outside any scenario window. */
	outside: { calls: SetViewDataCall[]; dataSets: DataSetRecord[]; modifyEvents: PhaseEvent[]; protoCalls: PhaseEvent[] };
	restore: {
		attempted: boolean;
		setViewDataOwnAfter?: boolean;
		setViewDataMatchesProto?: boolean;
		dataKindAfter?: PropKind;
		dataValueAfter?: string;
		protoRestored?: boolean;
		ok?: boolean;
		error?: ErrInfo;
	};
	cleanup: { leafDetached?: StepResult; fileTrashed?: StepResult; folderTrashed?: StepResult; folderKeptReason?: string };
	error?: ErrInfo;
	totalMs: number;
}

export interface SpikeReport {
	spike: { id: string; version: string; build: string; startedAt: string; finishedAt?: string; durationMs?: number; ran: string[] };
	env: Record<string, unknown>;
	or1?: Or1Report;
	or1Crash?: ErrInfo;
	or2?: ViewProbeReport;
	or2Crash?: ErrInfo;
	verdicts?: Verdicts;
}

// ---------------------------------------------------------------------------
// Verdicts
// ---------------------------------------------------------------------------

export interface Or1Verdict {
	workerOk: boolean;
	workerIdbOk: boolean;
	inlineIdbOk: boolean;
	verdict: "worker+IDB OK" | "worker OK, IDB in worker FAILED -> inline fallback" | "worker FAILED -> inline fallback";
	line: string;
}

export function computeOr1Verdict(or1: Pick<Or1Report, "worker" | "inlineIdb"> | undefined): Or1Verdict {
	const w = or1?.worker ?? null;
	const workerOk = Boolean(w && w.construct.ok && w.firstPong.received);
	const workerIdbOk = Boolean(workerOk && w?.probe.received && w.probe.report?.idb.ok);
	const inlineIdbOk = Boolean(or1?.inlineIdb?.ok);
	const verdict: Or1Verdict["verdict"] = workerIdbOk ? "worker+IDB OK" : workerOk ? "worker OK, IDB in worker FAILED -> inline fallback" : "worker FAILED -> inline fallback";
	return { workerOk, workerIdbOk, inlineIdbOk, verdict, line: `${verdict}; inline IDB ${inlineIdbOk ? "OK" : "FAILED"}` };
}

type Tri = boolean | null;

export interface Or2Summary {
	ran: boolean;
	/** A: vault.modify reached the per-instance wrapper. */
	instanceWrapperIntercepts: Tri;
	/** A: editor showed textA although the instance wrapper was never called (wrapper cannot intercept). */
	editorChangedWithoutInstanceCall: Tri;
	protoCallsBypassingInstance: number | null;
	externalModifyClearFlags: unknown[];
	viewDataAlreadyIncomingAtCall: Tri;
	adapterWrite: { setViewDataFired: Tri; modifyEventFired: Tri; firstCallMs: number | null; editorUpdated: Tri };
	handled: { intercepted: Tri; editorUnchanged: Tri; viewDataAfter: string | null; diskIsIncoming: Tri; diskBeforeSave: string | null; diskAfterSave: string | null; saveOverwroteDisk: Tri };
	merged: { editorIsMerged: Tri; diskBeforeSave: string | null; diskAfterSave: string | null; diskIsMergedAfterSave: Tri };
	dataRestore: { applicable: Tri; sticks: Tri; diskAfterSave: string | null; diskKeptIncomingAfterSave: Tri };
	dirtyEditor: { calls: number | null; clearFlags: unknown[]; editorAfter: string | null; diskAfter: string | null; diskAfterSave: string | null };
	readingMode: { calls: number | null; clearFlags: unknown[]; viewDataAfter: string | null };
	restoreOk: Tri;
	cleanupOk: Tri;
	errors: string[];
}

function scen(r: ViewProbeReport | undefined, id: string): ScenarioReport | undefined {
	return r?.scenarios.find((s) => s.id === id);
}

const mainCalls = (s: ScenarioReport | undefined): SetViewDataCall[] => (s ? s.calls.filter((c) => !c.phase.includes(":")) : []);

export function summarizeOr2(r: ViewProbeReport | undefined): Or2Summary {
	const A = scen(r, "A");
	const B = scen(r, "B");
	const C = scen(r, "C");
	const C2 = scen(r, "C2");
	const D = scen(r, "D");
	const E = scen(r, "E");
	const R = scen(r, "R");
	const aCalls = mainCalls(A);
	const errors: string[] = [];
	if (r?.error) errors.push(`probe: ${r.error.name}: ${r.error.message}`);
	if (r?.setup.error) errors.push(`setup: ${r.setup.error.name}: ${r.setup.error.message}`);
	for (const s of r?.scenarios ?? []) if (s.error) errors.push(`${s.id}: ${s.error.name}: ${s.error.message}`);
	if (r?.restore.error) errors.push(`restore: ${r.restore.error.name}: ${r.restore.error.message}`);

	const handledCalls = mainCalls(C);
	const cDiskBefore = C?.after?.disk ?? null;
	const cDiskAfter = C?.afterSave?.disk ?? null;
	const dCalls = mainCalls(D);
	const bCalls = mainCalls(B);
	const cleanupSteps = r ? [r.cleanup.leafDetached, r.cleanup.fileTrashed] : [];

	return {
		ran: Boolean(r),
		instanceWrapperIntercepts: A ? aCalls.length > 0 : null,
		editorChangedWithoutInstanceCall: A?.after ? aCalls.length === 0 && A.after.editor === A.expected : null,
		protoCallsBypassingInstance: r ? r.scenarios.reduce((n, s) => n + s.protoCalls.length, 0) : null,
		externalModifyClearFlags: aCalls.map((c) => c.clear),
		viewDataAlreadyIncomingAtCall: aCalls[0] ? aCalls[0].viewDataIsIncoming : null,
		adapterWrite: {
			setViewDataFired: B ? bCalls.length > 0 : null,
			modifyEventFired: B ? B.modifyEvents.length > 0 : null,
			firstCallMs: bCalls[0] ? bCalls[0].atMs : null,
			editorUpdated: B?.after ? B.after.editor === B.expected : null,
		},
		handled: {
			intercepted: C ? handledCalls.length > 0 : null,
			editorUnchanged: C?.before && C.after ? C.after.editor === C.before.editor : null,
			viewDataAfter: C?.after?.viewData ?? null,
			diskIsIncoming: C?.after ? C.after.disk === C.expected : null,
			diskBeforeSave: cDiskBefore,
			diskAfterSave: cDiskAfter,
			saveOverwroteDisk: C?.afterSave && C.after ? cDiskAfter !== C.expected && cDiskAfter === C.after.editor : null,
		},
		merged: {
			editorIsMerged: C2?.after ? C2.after.editor === "merged" : null,
			diskBeforeSave: C2?.after?.disk ?? null,
			diskAfterSave: C2?.afterSave?.disk ?? null,
			diskIsMergedAfterSave: C2?.afterSave ? C2.afterSave.disk === "merged" : null,
		},
		dataRestore: {
			applicable: D ? dCalls.some((c) => c.hookActions.includes("restored-data")) : null,
			sticks: D?.before && D.after && dCalls.some((c) => c.hookActions.includes("restored-data")) ? D.after.viewData === D.before.viewData : null,
			diskAfterSave: D?.afterSave?.disk ?? null,
			diskKeptIncomingAfterSave: D?.afterSave ? D.afterSave.disk === D.expected : null,
		},
		dirtyEditor: {
			calls: E ? mainCalls(E).length : null,
			clearFlags: mainCalls(E).map((c) => c.clear),
			editorAfter: E?.after?.editor ?? null,
			diskAfter: E?.after?.disk ?? null,
			diskAfterSave: E?.afterSave?.disk ?? null,
		},
		readingMode: { calls: R ? mainCalls(R).length : null, clearFlags: mainCalls(R).map((c) => c.clear), viewDataAfter: R?.after?.viewData ?? null },
		restoreOk: r?.restore.attempted ? r.restore.ok ?? false : null,
		cleanupOk: r ? cleanupSteps.every((s) => s?.ok === true) : null,
		errors,
	};
}

export interface Verdicts {
	platform: string;
	or1?: Or1Verdict;
	or2?: Or2Summary;
	lines: string[];
}

const yn = (v: Tri | undefined): string => (v === true ? "yes" : v === false ? "no" : "n/a");

export function computeVerdicts(report: SpikeReport): Verdicts {
	const flags = report.env.platform && typeof report.env.platform === "object" ? (report.env.platform as Record<string, unknown>) : {};
	const platform = platformLabel(flags);
	const lines: string[] = [];
	lines.push(`Platform: ${platform} | apiVersion ${safeString(report.env.apiVersion)} | spike build ${report.spike.build}`);
	const out: Verdicts = { platform, lines };
	if (report.or1 || report.or1Crash) {
		const v = computeOr1Verdict(report.or1);
		out.or1 = v;
		lines.push(`OR-1: ${v.line}`);
		const w = report.or1?.worker;
		if (w) {
			const t = w.transfer;
			lines.push(
				`OR-1 detail: construct ${w.construct.ok ? "ok" : "FAILED"}, first pong ${w.firstPong.received ? `${w.firstPong.ms ?? "?"} ms` : "NONE"}, ` +
					`ping rtt ${w.pingRttsMs.length ? `${Math.min(...w.pingRttsMs)}-${Math.max(...w.pingRttsMs)} ms` : "n/a"}, ` +
					`transfer detached ${yn(t.detachedOnSend ?? null)}, echo intact ${yn(t.intact ?? null)}, worker events ${w.events.length}`,
			);
			const idb = w.probe.report?.idb;
			if (idb && !idb.ok) lines.push(`OR-1 worker IDB failure: ${describeIdbFailure(idb)}`);
			if (!v.workerOk) {
				const why = w.construct.error ? `${w.construct.error.name}: ${w.construct.error.message}` : w.events[0]?.message ?? "no pong within timeout";
				lines.push(`OR-1 worker failure: ${why}`);
			}
		}
		if (report.or1?.inlineIdb && !report.or1.inlineIdb.ok) lines.push(`OR-1 inline IDB failure: ${describeIdbFailure(report.or1.inlineIdb)}`);
		if (report.or1Crash) lines.push(`OR-1 probe crashed: ${report.or1Crash.name}: ${report.or1Crash.message}`);
	}
	if (report.or2 || report.or2Crash) {
		const s = summarizeOr2(report.or2);
		out.or2 = s;
		lines.push(
			`OR-2 A vault.modify: instance wrapper called ${yn(s.instanceWrapperIntercepts)} (clear=${JSON.stringify(s.externalModifyClearFlags)}); ` +
				`view.data already incoming at call ${yn(s.viewDataAlreadyIncomingAtCall)}; editor changed WITHOUT wrapper ${yn(s.editorChangedWithoutInstanceCall)}; proto bypass calls ${s.protoCallsBypassingInstance ?? "n/a"}`,
		);
		lines.push(
			`OR-2 B adapter.write: setViewData ${yn(s.adapterWrite.setViewDataFired)}${s.adapterWrite.firstCallMs !== null ? ` after ${s.adapterWrite.firstCallMs} ms` : ""}; vault modify event ${yn(s.adapterWrite.modifyEventFired)}; editor updated ${yn(s.adapterWrite.editorUpdated)}`,
		);
		lines.push(
			`OR-2 C handled: intercepted ${yn(s.handled.intercepted)}; editor unchanged ${yn(s.handled.editorUnchanged)}; view.data after ${s.handled.viewDataAfter ?? "n/a"}; ` +
				`disk before save ${s.handled.diskBeforeSave ?? "n/a"}; save() overwrote disk with editor ${yn(s.handled.saveOverwroteDisk)} (disk after save ${s.handled.diskAfterSave ?? "n/a"})`,
		);
		lines.push(`OR-2 C2 merge-in-wrapper: editor=merged ${yn(s.merged.editorIsMerged)}; disk before save ${s.merged.diskBeforeSave ?? "n/a"}; disk after save=merged ${yn(s.merged.diskIsMergedAfterSave)}`);
		lines.push(`OR-2 D data-restore: applicable ${yn(s.dataRestore.applicable)}; sticks ${yn(s.dataRestore.sticks)}; disk kept incoming after save ${yn(s.dataRestore.diskKeptIncomingAfterSave)} (${s.dataRestore.diskAfterSave ?? "n/a"})`);
		lines.push(
			`OR-2 E dirty editor + vault.modify: calls ${s.dirtyEditor.calls ?? "n/a"} (clear=${JSON.stringify(s.dirtyEditor.clearFlags)}); editor after ${s.dirtyEditor.editorAfter ?? "n/a"}; disk after ${s.dirtyEditor.diskAfter ?? "n/a"}; disk after save ${s.dirtyEditor.diskAfterSave ?? "n/a"}`,
		);
		lines.push(`OR-2 R reading mode vault.modify: calls ${s.readingMode.calls ?? "n/a"} (clear=${JSON.stringify(s.readingMode.clearFlags)})`);
		lines.push(`OR-2 restore OK ${yn(s.restoreOk)}; cleanup OK ${yn(s.cleanupOk)}`);
		for (const e of s.errors) lines.push(`OR-2 error: ${e}`);
		if (report.or2Crash) lines.push(`OR-2 probe crashed: ${report.or2Crash.name}: ${report.or2Crash.message}`);
	}
	return out;
}

function describeIdbFailure(r: IdbProbeReport): string {
	if (r.accessError) return `indexedDB access threw ${r.accessError.name}: ${r.accessError.message}`;
	if (r.typeofIndexedDB === "undefined") return "indexedDB is undefined";
	for (const [name, s] of [["open", r.open], ["put", r.put], ["get", r.get]] as const) {
		if (s.hang) return `${name} HANG after ${s.ms} ms${name === "open" && r.open.blocked ? " (blocked)" : ""}`;
		if (s.error) return `${name} ${s.error.name}: ${s.error.message}`;
		if (s.skipped) return `${name} skipped`;
	}
	if (r.equal === false) return "read-back record differs";
	return "unknown";
}

// ---------------------------------------------------------------------------
// JSON formatting
// ---------------------------------------------------------------------------

/** Pretty JSON that never throws: Errors, bigints, functions, binary and cycles are rendered as data. */
export function formatReport(value: unknown): string {
	const ancestors: unknown[] = [];
	function replacer(this: unknown, _key: string, v: unknown): unknown {
		if (typeof v === "bigint") return `${v.toString()}n`;
		if (typeof v === "function") return "[function]";
		if (typeof v === "symbol") return v.toString();
		if (v === undefined) return undefined;
		if (typeof v !== "object" || v === null) return v;
		// `this` is the object holding `v`; unwind the ancestor stack to it (MDN cycle-detection pattern).
		while (ancestors.length > 0 && ancestors[ancestors.length - 1] !== this) ancestors.pop();
		if (ancestors.includes(v)) return "[circular]";
		let out: unknown = v;
		if (v instanceof Error) out = errInfo(v, true);
		else if (v instanceof ArrayBuffer) out = { ArrayBuffer: true, byteLength: v.byteLength };
		else if (ArrayBuffer.isView(v)) out = { view: v.constructor.name, byteLength: v.byteLength };
		// Push what JSON.stringify will descend into (the replacement), so its children find their parent.
		ancestors.push(out);
		return out;
	}
	try {
		return JSON.stringify(value, replacer, 2) ?? "null";
	} catch (e) {
		return JSON.stringify({ formatError: errInfo(e), fallback: safeString(value) }, null, 2);
	}
}
