// YAOS spike OR-2: how does Obsidian reload an OPEN MarkdownView when its file
// changes underneath, and can a per-instance setViewData wrapper intercept it?
//
// Creates yaos-spike-probe/probe-<ts>.md, opens it in a new tab, wraps
// view.setViewData and view.data on that one instance, then drives scenarios:
//   A  vault.modify            (pass-through)
//   B  adapter.write           (pass-through; external-writer simulation)
//   C  vault.modify            (handled: wrapper does NOT forward) + save()
//   C2 vault.modify            (handled: wrapper applies a merged text via editor.setValue) + save()
//   D  vault.modify            (handled: wrapper restores view.data if it was pre-set) + save()
//   E  dirty editor + vault.modify (pass-through) + save()
//   R  vault.modify in reading mode (pass-through)
// Everything is undone in finally: wrappers removed, leaf closed, probe file and
// (empty) folder moved to Obsidian's trash. Every await has a timeout.
import { apiVersion, MarkdownView, normalizePath, TFile, TFolder, type App, type WorkspaceLeaf } from "obsidian";
import {
	defaultNow,
	errInfo,
	r1,
	settle,
	sleep,
	stamp,
	TextNames,
	toStep,
	trimStack,
	waitFor,
	type DataSetRecord,
	type PhaseEvent,
	type PropKind,
	type ScenarioReport,
	type SetViewDataCall,
	type ViewProbeReport,
	type ViewStateSnap,
	type WrapperMode,
} from "./report";

export const PROBE_FOLDER = "yaos-spike-probe";

export interface ViewProbeOptions {
	onProgress?: (msg: string) => void;
	/** Skip the optional scenarios (E dirty editor, R reading mode). */
	coreOnly?: boolean;
}

function hasOwn(o: object, k: string): boolean {
	return Object.prototype.hasOwnProperty.call(o, k);
}

function findProtoOwner(o: object, k: string): object | null {
	let p: unknown = Object.getPrototypeOf(o);
	while (p && typeof p === "object") {
		if (hasOwn(p, k)) return p;
		p = Object.getPrototypeOf(p);
	}
	return null;
}

function propKind(o: object, k: string): PropKind {
	const own = Object.getOwnPropertyDescriptor(o, k);
	if (own) return "value" in own || "writable" in own ? "own-value" : "own-accessor";
	const owner = findProtoOwner(o, k);
	if (!owner) return "absent";
	const d = Object.getOwnPropertyDescriptor(owner, k);
	return d && ("value" in d || "writable" in d) ? "inherited-value" : "inherited-accessor";
}

interface Bucket {
	calls: SetViewDataCall[];
	dataSets: DataSetRecord[];
	modifyEvents: PhaseEvent[];
	protoCalls: PhaseEvent[];
}

export async function runViewProbe(app: App, opts: ViewProbeOptions = {}): Promise<ViewProbeReport> {
	const now = defaultNow;
	const t0 = now();
	const progress = (m: string): void => {
		try {
			opts.onProgress?.(m);
		} catch {
			/* ignore */
		}
	};
	const names = new TextNames();
	const nonce = Math.random().toString(36).slice(2, 8);
	const mk = (stage: string, middle: string, tail = ""): string =>
		`# YAOS spike probe\n\nstage: ${stage}\nnonce: ${nonce}\n\nline one\nline two ${middle}\nline three\n${tail}`;
	const text0 = names.add("text0", mk("initial", "(0)"));
	const textA = names.add("textA", mk("A vault.modify", "(A)"));
	const textB = names.add("textB", mk("B adapter.write", "(B)"));
	const textC = names.add("textC", mk("C handled", "(C)"));
	const textC2 = names.add("textC2", mk("C2 handled+merge incoming", "(C2)"));
	const merged = names.add("merged", mk("C2 handled+merge incoming", "(C2)", "local line kept by our merge\n"));
	const textD = names.add("textD", mk("D data restore", "(D)"));
	const textE = names.add("textE", mk("E dirty editor", "(E)"));
	const localLine = "local unsaved edit (E)\n";
	const textR = names.add("textR", mk("R reading mode", "(R)"));

	const folder = normalizePath(PROBE_FOLDER);
	const path = normalizePath(`${folder}/probe-${stamp()}-${nonce}.md`);
	const report: ViewProbeReport = {
		apiVersion,
		texts: {},
		setup: { folder, folderCreated: false, filePath: path },
		scenarios: [],
		outside: { calls: [], dataSets: [], modifyEvents: [], protoCalls: [] },
		restore: { attempted: false },
		cleanup: {},
		totalMs: 0,
	};

	// --- per-run mutable state shared with the wrappers -----------------------
	let view: MarkdownView | null = null;
	let leaf: WorkspaceLeaf | null = null;
	let file: TFile | null = null;
	let cur: ScenarioReport | null = null;
	let phase = "outside";
	let triggerT = t0;
	let expectedRaw: string | null = null;
	let baseline: unknown = undefined;
	let mode: WrapperMode = "pass-through";
	let hook: ((data: unknown, rec: SetViewDataCall) => void) | null = null;
	let inWrapper = 0;
	const offs: (() => void)[] = [];
	const restorer: { run: (() => void) | null } = { run: null };

	const bucket = (): Bucket => cur ?? report.outside;
	const rel = (): number => r1(now() - (cur ? triggerT : t0));
	const nm = (read: () => unknown): string => {
		try {
			return names.nameOf(read());
		} catch (e) {
			const i = errInfo(e);
			return `<threw ${i.name}: ${i.message}>`;
		}
	};
	const rawEditor = (): unknown => {
		try {
			return view?.editor.getValue();
		} catch {
			return undefined;
		}
	};
	const readText = async (read: () => Promise<string>): Promise<string> => {
		const r = await settle(read, 3000, now);
		return r.kind === "ok" ? names.nameOf(r.value) : r.kind === "hang" ? "<hang>" : `<error ${r.error.name}: ${r.error.message}>`;
	};
	const snap = async (withDisk: boolean): Promise<ViewStateSnap> => {
		const v = view;
		const s: ViewStateSnap = {
			atMs: rel(),
			editor: nm(() => v?.editor.getValue()),
			viewData: nm(() => v?.data),
			getViewData: nm(() => v?.getViewData()),
		};
		try {
			if (v) s.mode = v.getMode();
		} catch (e) {
			s.mode = `<threw ${errInfo(e).name}>`;
		}
		try {
			const dirty: unknown = v ? Reflect.get(v, "dirty") : undefined;
			if (typeof dirty === "boolean") s.internalDirty = dirty;
		} catch {
			/* internal field; ignore */
		}
		if (withDisk) {
			s.disk = await readText(() => app.vault.adapter.read(path));
			const f = file;
			if (f) s.vaultRead = await readText(() => app.vault.read(f));
		}
		return s;
	};

	const callsIn = (s: ScenarioReport): number => s.calls.filter((c) => c.phase === s.id).length;

	async function trigger(s: ScenarioReport, how: "vault.modify" | "adapter.write", text: string): Promise<void> {
		const f = file;
		triggerT = now();
		if (!f) throw new Error("probe file missing");
		s.trigger = toStep(
			await settle(() => (how === "vault.modify" ? app.vault.modify(f, text) : app.vault.adapter.write(path, text)), 5000, now),
			() => how,
		);
	}

	async function saveAndSnap(s: ScenarioReport): Promise<void> {
		const v = view;
		if (!v) return;
		phase = `${s.id}:save`;
		s.save = toStep(await settle(() => v.save(), 5000, now));
		await sleep(400);
		s.afterSave = await snap(true);
		phase = s.id;
	}

	async function scenario(id: string, title: string, m: WrapperMode, expected: string, body: (s: ScenarioReport) => Promise<void>): Promise<void> {
		const s: ScenarioReport = {
			id,
			title,
			mode: m,
			expected: names.nameOf(expected),
			calls: [],
			dataSets: [],
			modifyEvents: [],
			protoCalls: [],
			editorChanges: [],
			notes: [],
		};
		report.scenarios.push(s);
		progress(`OR-2 ${id}: ${title}`);
		const st = now();
		cur = s;
		phase = id;
		triggerT = st;
		expectedRaw = expected;
		baseline = rawEditor();
		hook = null;
		mode = m;
		try {
			s.before = await snap(true);
			await body(s);
		} catch (e) {
			s.error = errInfo(e, true);
		} finally {
			mode = "pass-through";
			hook = null;
			cur = null;
			phase = "outside";
			expectedRaw = null;
			s.durationMs = r1(now() - st);
		}
	}

	function install(v: MarkdownView): void {
		const setup = report.setup;
		// 1. per-instance setViewData wrapper
		const ownBefore = hasOwn(v, "setViewData");
		setup.setViewDataOwnBefore = ownBefore;
		const orig: unknown = v.setViewData;
		if (typeof orig !== "function") throw new Error(`view.setViewData is ${typeof orig}`);
		const wrapper = function (this: unknown, ...args: unknown[]): void {
			const data = args[0];
			inWrapper++;
			const rec: SetViewDataCall = {
				phase,
				atMs: rel(),
				argc: args.length,
				clear: args[1],
				thisIsView: this === v,
				mode,
				incoming: names.nameOf(data),
				incomingLen: typeof data === "string" ? data.length : -1,
				incomingIsExpected: expectedRaw !== null && data === expectedRaw,
				viewDataAtCall: "",
				viewDataIsIncoming: false,
				viewDataIsOld: false,
				getViewDataAtCall: "",
				editorAtCall: "",
				origCalled: false,
				hookActions: [],
				stack: trimStack(new Error("setViewData probe").stack, 10),
			};
			try {
				const vd: unknown = v.data;
				rec.viewDataAtCall = names.nameOf(vd);
				rec.viewDataIsIncoming = vd === data;
				rec.viewDataIsOld = baseline !== undefined && vd === baseline;
				rec.getViewDataAtCall = nm(() => v.getViewData());
				rec.editorAtCall = nm(() => v.editor.getValue());
				if (mode === "pass-through") {
					try {
						Reflect.apply(orig, this === undefined ? v : this, args);
						rec.origCalled = true;
					} catch (e) {
						rec.origError = errInfo(e, true);
					}
				} else if (hook) {
					try {
						hook(data, rec);
					} catch (e) {
						rec.hookError = errInfo(e, true);
					}
				}
				rec.editorAfter = nm(() => v.editor.getValue());
				rec.viewDataAfter = nm(() => v.data);
			} catch (e) {
				rec.wrapperError = errInfo(e, true);
			} finally {
				inWrapper--;
				bucket().calls.push(rec);
			}
		};
		v.setViewData = wrapper;
		setup.wrapperInstalled = v.setViewData === wrapper;

		// 2. prototype detector: logs calls that reach the prototype method with this === v (i.e. bypass the instance wrapper)
		const protoOwner = findProtoOwner(v, "setViewData");
		setup.setViewDataProtoOwner = protoOwner ? `${protoOwner === Object.getPrototypeOf(v) ? "direct prototype" : "ancestor prototype"}` : "none";
		let detector: ((this: unknown, ...args: unknown[]) => unknown) | null = null;
		const protoOrig: unknown = protoOwner ? Reflect.get(protoOwner, "setViewData") : undefined;
		if (protoOwner && typeof protoOrig === "function") {
			const d = function (this: unknown, ...args: unknown[]): unknown {
				if (this === v) {
					try {
						bucket().protoCalls.push({ phase, atMs: rel(), insideWrapper: inWrapper > 0 });
					} catch {
						/* never break the real call */
					}
				}
				return Reflect.apply(protoOrig, this, args);
			};
			try {
				setup.protoDetectorInstalled = Reflect.set(protoOwner, "setViewData", d) && Reflect.get(protoOwner, "setViewData") === d;
				if (setup.protoDetectorInstalled) detector = d;
			} catch {
				setup.protoDetectorInstalled = false;
			}
		}

		// 3. per-instance accessor tracking view.data
		const dataKind = propKind(v, "data");
		setup.dataKindBefore = dataKind;
		const ownDesc = Object.getOwnPropertyDescriptor(v, "data");
		const owner = ownDesc ? null : findProtoOwner(v, "data");
		const baseDesc = ownDesc ?? (owner ? Object.getOwnPropertyDescriptor(owner, "data") : undefined);
		const baseGet = baseDesc?.get;
		const baseSet = baseDesc?.set;
		let dataValue: unknown = v.data;
		let dataInstalled = false;
		try {
			Object.defineProperty(v, "data", {
				configurable: true,
				enumerable: true,
				get(): unknown {
					return baseGet ? Reflect.apply(baseGet, v, []) : dataValue;
				},
				set(x: unknown) {
					const prev: unknown = baseGet ? Reflect.apply(baseGet, v, []) : dataValue;
					if (baseSet) Reflect.apply(baseSet, v, [x]);
					else dataValue = x;
					try {
						bucket().dataSets.push({
							phase,
							atMs: rel(),
							prev: names.nameOf(prev),
							next: names.nameOf(x),
							nextIsExpected: expectedRaw !== null && x === expectedRaw,
							insideWrapper: inWrapper > 0,
							stack: trimStack(new Error("data set probe").stack, 8),
						});
					} catch {
						/* logging must never break the assignment */
					}
				},
			});
			dataInstalled = true;
		} catch (e) {
			setup.error = errInfo(e);
		}
		setup.dataAccessorInstalled = dataInstalled;

		restorer.run = () => {
			const r = report.restore;
			r.attempted = true;
			const problems: string[] = [];
			// prototype detector first, so the instance check below compares against the real method
			if (detector && protoOwner) {
				try {
					if (Reflect.get(protoOwner, "setViewData") === detector) Reflect.set(protoOwner, "setViewData", protoOrig);
					r.protoRestored = Reflect.get(protoOwner, "setViewData") === protoOrig;
				} catch {
					r.protoRestored = false;
				}
				if (!r.protoRestored) problems.push("proto");
			}
			try {
				if (ownBefore) v.setViewData = orig as MarkdownView["setViewData"];
				else Reflect.deleteProperty(v, "setViewData");
				r.setViewDataOwnAfter = hasOwn(v, "setViewData");
				const protoNow: unknown = Reflect.get(Object.getPrototypeOf(v) as object, "setViewData");
				r.setViewDataMatchesProto = v.setViewData === protoNow;
				if (r.setViewDataOwnAfter !== ownBefore || v.setViewData !== orig) problems.push("setViewData");
			} catch (e) {
				r.error = errInfo(e);
				problems.push("setViewData threw");
			}
			if (dataInstalled) {
				try {
					const current: unknown = v.data;
					Reflect.deleteProperty(v, "data");
					if (ownDesc) {
						if ("value" in ownDesc || "writable" in ownDesc) Object.defineProperty(v, "data", { ...ownDesc, value: current });
						else Object.defineProperty(v, "data", ownDesc);
					}
					r.dataKindAfter = propKind(v, "data");
					r.dataValueAfter = names.nameOf(v.data);
					if (r.dataKindAfter !== dataKind || v.data !== current) problems.push("data");
				} catch (e) {
					r.error = errInfo(e);
					problems.push("data threw");
				}
			}
			r.ok = problems.length === 0;
		};
	}

	try {
		// --- setup ---------------------------------------------------------------
		progress("OR-2: creating probe file");
		const existing = app.vault.getAbstractFileByPath(folder);
		if (!existing) {
			const mk = await settle(() => app.vault.createFolder(folder), 5000, now);
			if (mk.kind !== "ok") throw new Error(`createFolder failed: ${mk.kind === "error" ? mk.error.message : "hang"}`);
			report.setup.folderCreated = true;
		} else if (!(existing instanceof TFolder)) throw new Error(`${folder} exists and is not a folder`);
		const created = await settle(() => app.vault.create(path, text0), 5000, now);
		report.setup.create = toStep(created, (f) => f.path);
		if (created.kind !== "ok") throw new Error("could not create probe file");
		const f = created.value;
		file = f;

		const l = app.workspace.getLeaf("tab");
		leaf = l;
		report.setup.openFile = toStep(await settle(() => l.openFile(f, { active: true, state: { mode: "source" } }), 8000, now));
		const lid: unknown = Reflect.get(l, "loadIfDeferred");
		if (typeof lid === "function") report.setup.loadIfDeferred = toStep(await settle(() => Reflect.apply(lid, l, []) as unknown, 5000, now));
		const v0 = l.view;
		try {
			report.setup.viewType = v0.getViewType();
		} catch {
			report.setup.viewType = "<threw>";
		}
		report.setup.isMarkdownView = v0 instanceof MarkdownView;
		if (!(v0 instanceof MarkdownView)) throw new Error(`leaf.view is not a MarkdownView (${report.setup.viewType ?? "?"})`);
		const v = v0;
		view = v;
		report.setup.loaded = await waitFor(() => v.file?.path === path && v.editor.getValue() === text0, 5000);
		report.setup.modeAtOpen = v.getMode();
		try {
			const vs = l.getViewState();
			report.setup.viewState = { type: vs.type, state: vs.state, pinned: vs.pinned };
		} catch (e) {
			report.setup.viewState = { error: errInfo(e) };
		}
		report.setup.editorExists = Boolean(v.editor);
		report.setup.viewFilePath = v.file?.path ?? null;

		// --- observers + interceptors -------------------------------------------
		const mref = app.vault.on("modify", (af) => {
			if (af.path === path) bucket().modifyEvents.push({ phase, atMs: rel() });
		});
		offs.push(() => app.vault.offref(mref));
		const eref = app.workspace.on("editor-change", (_ed, info) => {
			if (info === v && cur) cur.editorChanges.push({ phase, atMs: rel(), insideWrapper: inWrapper > 0 });
		});
		offs.push(() => app.workspace.offref(eref));
		install(v);

		// --- scenarios ------------------------------------------------------------
		await scenario("A", "vault.modify, wrapper forwards (pass-through)", "pass-through", textA, async (s) => {
			await trigger(s, "vault.modify", textA);
			s.waited = await waitFor(() => rawEditor() === textA, 3000);
			await sleep(400);
			s.after = await snap(true);
			if (callsIn(s) === 0) s.notes.push(s.after.editor === "textA" ? "editor updated WITHOUT the instance wrapper being called" : "no setViewData call and editor not updated");
		});

		await scenario("B", "adapter.write (simulated external writer), pass-through", "pass-through", textB, async (s) => {
			await trigger(s, "adapter.write", textB);
			s.waited = await waitFor(() => callsIn(s) > 0 || rawEditor() === textB, 6000);
			await sleep(500);
			s.after = await snap(true);
			if (!s.waited.met) s.notes.push("no setViewData call and no editor update within 6 s of adapter.write");
		});

		await scenario("C", "vault.modify, wrapper HANDLES (does not forward), then save()", "handled", textC, async (s) => {
			await trigger(s, "vault.modify", textC);
			s.waited = await waitFor(() => callsIn(s) > 0, 3000);
			await sleep(2500); // let any debounced auto-save (2 s) happen on its own
			s.after = await snap(true);
			await saveAndSnap(s);
		});

		await scenario("C2", "vault.modify, wrapper handles and applies a merged text via editor.setValue, then save()", "handled", textC2, async (s) => {
			let applied = false;
			hook = (data, rec) => {
				if (applied || data !== textC2) {
					rec.hookActions.push("ignored");
					return;
				}
				applied = true;
				v.editor.setValue(merged);
				rec.hookActions.push("editor.setValue(merged)");
			};
			await trigger(s, "vault.modify", textC2);
			s.waited = await waitFor(() => callsIn(s) > 0, 3000);
			await sleep(2500);
			s.after = await snap(true);
			await saveAndSnap(s);
		});

		await scenario("D", "vault.modify, wrapper handles and restores view.data if Obsidian pre-set it, then save()", "handled", textD, async (s) => {
			const dataBefore: unknown = v.data;
			let applied = false;
			hook = (data, rec) => {
				if (applied || data !== textD) {
					rec.hookActions.push("ignored");
					return;
				}
				applied = true;
				if (v.data === data) {
					rec.hookActions.push("data-was-incoming");
					if (typeof dataBefore === "string") {
						v.data = dataBefore;
						rec.hookActions.push("restored-data", `restored-to:${names.nameOf(dataBefore)}`);
					}
				} else rec.hookActions.push(`data-was-not-incoming:${names.nameOf(v.data)}`);
			};
			await trigger(s, "vault.modify", textD);
			s.waited = await waitFor(() => callsIn(s) > 0, 3000);
			await sleep(2500);
			s.after = await snap(true);
			await saveAndSnap(s);
		});

		if (!opts.coreOnly) {
			await scenario("E", "dirty editor (unsaved local edit) + vault.modify, pass-through, then save()", "pass-through", textE, async (s) => {
				const ed = v.editor;
				const last = ed.lastLine();
				ed.replaceRange(localLine, { line: last, ch: ed.getLine(last).length });
				const dirty = ed.getValue();
				names.add("dirtyLocal", dirty);
				const base = typeof baseline === "string" ? baseline : "";
				if (base.endsWith("\n")) names.add("textE+local", textE + localLine);
				s.notes.push(`local edit appended at end; editor is now ${names.nameOf(dirty)}`);
				await trigger(s, "vault.modify", textE);
				s.waited = await waitFor(() => callsIn(s) > 0 || rawEditor() !== dirty, 3000);
				await sleep(2500);
				s.after = await snap(true);
				const diskAfter = await settle(() => app.vault.adapter.read(path), 3000, now);
				s.raw = { editorAfter: String(rawEditor()), diskAfter: diskAfter.kind === "ok" ? diskAfter.value : `<${diskAfter.kind}>` };
				await saveAndSnap(s);
				const diskSaved = await settle(() => app.vault.adapter.read(path), 3000, now);
				s.raw.diskAfterSave = diskSaved.kind === "ok" ? diskSaved.value : `<${diskSaved.kind}>`;
			});

			await scenario("R", "reading mode: vault.modify, pass-through", "pass-through", textR, async (s) => {
				const vs = l.getViewState();
				const sw = await settle(() => l.setViewState({ type: vs.type, state: { ...(vs.state ?? {}), mode: "preview" } }), 5000, now);
				s.notes.push(`setViewState(mode=preview): ${sw.kind}`);
				await sleep(300);
				const same = l.view === v;
				const modeNow = v.getMode();
				s.notes.push(`same view instance after switch: ${same}; mode now: ${modeNow}`);
				if (!same || modeNow !== "preview") {
					s.notes.push("skipped: could not switch this view to reading mode");
					return;
				}
				await trigger(s, "vault.modify", textR);
				s.waited = await waitFor(() => callsIn(s) > 0, 3000);
				await sleep(400);
				s.after = await snap(true);
			});
		}
	} catch (e) {
		report.error = errInfo(e, true);
	} finally {
		progress("OR-2: restoring and cleaning up");
		mode = "pass-through";
		hook = null;
		const restore = restorer.run;
		if (restore) {
			try {
				restore();
			} catch (e) {
				report.restore.error = errInfo(e);
				report.restore.ok = false;
			}
		}
		for (const off of offs) {
			try {
				off();
			} catch {
				/* ignore */
			}
		}
		const l = leaf;
		if (l) report.cleanup.leafDetached = toStep(await settle(() => l.detach(), 3000, now));
		const f = app.vault.getAbstractFileByPath(path);
		if (f instanceof TFile) report.cleanup.fileTrashed = toStep(await settle(() => app.vault.trash(f, false), 5000, now));
		const fo = app.vault.getAbstractFileByPath(folder);
		if (fo instanceof TFolder) {
			if (fo.children.length === 0) report.cleanup.folderTrashed = toStep(await settle(() => app.vault.trash(fo, false), 5000, now));
			else report.cleanup.folderKeptReason = `${fo.children.length} item(s) still inside`;
		}
		report.texts = names.all();
		report.totalMs = r1(now() - t0);
	}
	return report;
}
