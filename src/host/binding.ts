/**
 * Main-thread editor binding (DESIGN §d.2, §d.3). Main holds no CRDT: the worker replica is the only Y.Doc,
 * and each bound editor is a CodeMirror client of it (bodyClient.ts). Per keystroke main does O(change) work:
 * the transaction's ChangeSet is composed into the view's buffer and pushed (coalesced, MAIN_UPDATE_COALESCE_MS)
 * as ChangeSet JSON in pre-change coordinates with only the inserted text; the replica's changes come back as
 * entries applied as CodeMirror transactions outside the undo history.
 *
 * Whole texts cross only at a bind (first open, re-open after a resync: the editor text,
 * plus the merge base when there is one, plus the text Obsidian last saved when the editor is dirty) and when Obsidian pushes text into a bound view (an external reload,
 * a properties edit, an unbound view's quick preview): uploaded as transferred UTF-16 chunks of
 * TEXT_CHUNK_UNITS with a yield between chunks. The worker compares, merges and diffs; main never does.
 *
 * The engine dying stops the runtime (engineHost.ts): views unbind and their edits stay in the editors; the next
 * runtime (the user's restart) binds them as at a first open.
 */

import { ChangeSet, type Text } from "@codemirror/state";
import type { DocId, VaultPath } from "../core/types";
import { kindOfPath } from "../core/types";
import { MAIN_UPDATE_COALESCE_MS } from "../core/limits";
import type { ClockPort, TimerHandle } from "../ports/clock";
import type { Unsubscribe } from "../ports/common";
import type { EditorBinding, EditorViewRef, ViewEvent, WorkspacePort } from "../ports/workspace";
import type { BindInfo, BodyChanges, BodyEvent, EngineResultValue, MainToEngine } from "../protocol/messages";
import { encodeUtf16, TEXT_CHUNK_UNITS } from "../protocol/utf16";
import { DocMirror, ViewClient } from "./bodyClient";

export interface BindingLink {
	/** Post to the engine (the host handles [T] ownership). */
	post(message: MainToEngine): void;
	/** openDoc request; rejects when the engine errors or stops. */
	openDoc(path: VaultPath, viewId: number): Promise<EngineResultValue>;
}

export interface BindingDeps {
	readonly workspace: WorkspacePort;
	readonly vault: { readonly caseInsensitive: boolean };
	readonly clock: ClockPort;
	readonly link: BindingLink;
	readonly notice: (level: "info" | "warn" | "error", code: string, message: string) => void;
}

type SlotState = "idle" | "opening" | "attaching" | "bound" | "waiting";

interface BoundDoc {
	readonly docId: DocId;
	mirror: DocMirror | null;
	readonly slots: Set<ViewSlot>;
}

interface ViewSlot {
	readonly viewId: number;
	readonly view: EditorViewRef;
	/** Open generation: bumped by every (re)open and unbind; async steps of an older one stop. */
	seq: number;
	state: SlotState;
	doc: BoundDoc | null;
	binding: EditorBinding | null;
	client: ViewClient | null;
	unintercept: Unsubscribe | null;
	/** The editor text uploaded for the pending bodyAttach (the `bound` changes apply to it), and its upload id. */
	attachDoc: Text | null;
	attachId: number;
	attachPosted: boolean;
	timer: TimerHandle | null;
	/** Reload counter; the latest intercepted text not yet `reloaded` (sent again after a re-bind); post order. */
	reload: number;
	reloadText: string | null;
	reloadChain: Promise<void>;
}

export interface BindingStats {
	pushes: number;
	rejects: number;
	entries: number;
	bounds: number;
	resyncs: number;
	reloads: number;
	siblingCopies: number;
	saveMarks: number;
	uploads: number;
	uploadUnits: number;
	creditsSent: number;
}

/** A text to upload: a CodeMirror Text (sliceString) or a string, read one chunk at a time. */
interface TextSource {
	readonly length: number;
	slice(from: number, to: number): string;
}

const ofText = (t: Text): TextSource => ({ length: t.length, slice: (a, b) => t.sliceString(a, b) });
const ofString = (s: string): TextSource => ({ length: s.length, slice: (a, b) => s.slice(a, b) });

export class BindingManager {
	private readonly slots = new Map<number, ViewSlot>();
	private readonly docs = new Map<DocId, BoundDoc>();
	/** Merge base for the next binds of a doc after a resync (until every view of it is bound). */
	private readonly bases = new Map<DocId, Text>();
	private running = false;
	private offWorkspace: Unsubscribe | null = null;
	private nextUpload = 1;
	private nextPush = 1;
	private credit = 0;
	private creditQueued = false;
	readonly stats: BindingStats = { pushes: 0, rejects: 0, entries: 0, bounds: 0, resyncs: 0, reloads: 0, siblingCopies: 0, saveMarks: 0, uploads: 0, uploadUnits: 0, creditsSent: 0 };

	constructor(private readonly deps: BindingDeps) {}

	// --- lifecycle ------------------------------------------------------------

	/** Engine ready: bind every open markdown view. */
	start(): void {
		if (this.running) return;
		this.running = true;
		if (!this.offWorkspace) this.offWorkspace = this.deps.workspace.onViewEvent((e) => this.onViewEvent(e));
		for (const view of this.deps.workspace.listMarkdownViews()) {
			if (!this.slots.has(view.viewId)) this.slots.set(view.viewId, this.newSlot(view));
		}
		for (const slot of this.slots.values()) void this.open(slot);
	}

	/** Plugin unload or the engine stopped (fatal): flush and unbind everything. */
	stop(): void {
		this.flushAll();
		for (const slot of [...this.slots.values()]) this.unbindSlot(slot);
		this.slots.clear();
		this.bases.clear();
		this.offWorkspace?.();
		this.offWorkspace = null;
		this.running = false;
	}

	/** Push every buffer now (hidden/pagehide/freeze, unload). */
	flushAll(): void {
		for (const slot of this.slots.values()) this.flushSlot(slot);
	}

	// --- queries --------------------------------------------------------------

	isBoundPath(path: string): boolean {
		for (const slot of this.slots.values()) {
			if (slot.state !== "idle" && slot.state !== "waiting" && slot.view.path !== null && this.samePath(slot.view.path, path)) return true;
		}
		return false;
	}

	/**
	 * Push the buffers of every view bound at `path` now. True when that view had changes the engine had not
	 * confirmed: a delete planned without them must be replanned (§c.7).
	 */
	flushPath(path: string): boolean {
		let pending = false;
		for (const slot of this.slots.values()) {
			if (!slot.client || slot.view.path === null || !this.samePath(slot.view.path, path)) continue;
			if (slot.client.pending) pending = true;
			this.flushSlot(slot);
		}
		return pending;
	}

	boundDocs(): DocId[] {
		return [...this.docs.keys()];
	}

	/** The replica text main last applied for `docId` (an immutable Text; tests and the simulation). */
	mirrorText(docId: DocId): Text | null {
		return this.docs.get(docId)?.mirror?.text ?? null;
	}

	slotState(viewId: number): SlotState | null {
		return this.slots.get(viewId)?.state ?? null;
	}

	docOfView(viewId: number): DocId | null {
		return this.slots.get(viewId)?.doc?.docId ?? null;
	}

	// --- engine -> main -------------------------------------------------------

	/** A body event of `docId` (FIFO per doc). Its weight returns as docCredit once applied. */
	onBody(docId: DocId, event: BodyEvent, weight: number): void {
		this.addCredit(weight);
		const doc = this.docs.get(docId);
		if (!doc) return;
		try {
			this.applyBody(doc, event);
		} catch {
			// A change set that does not fit (RangeError from ChangeSet.fromJSON / map / apply): out of sync.
			this.resync(doc, doc.mirror?.durable ?? null);
		}
	}

	private applyBody(doc: BoundDoc, event: BodyEvent): void {
		switch (event.t) {
			case "entry": {
				const m = doc.mirror;
				if (!m) return;
				const f = ChangeSet.fromJSON(event.changes);
				if (!m.apply(event.from, event.to, f, event.length)) return this.resync(doc, m.durable);
				this.stats.entries++;
				for (const s of [...doc.slots]) {
					if (s.state !== "bound" || !s.client) continue;
					if (event.author?.viewId !== s.viewId) s.client.foreign(f);
					else if (!s.client.confirm(event.author.seq)) return this.resync(doc, m.durable);
				}
				return;
			}
			case "bound":
				return this.onBound(doc, event);
			case "reject": {
				const s = this.slots.get(event.viewId);
				if (!s || s.doc !== doc || s.state !== "bound" || !s.client) return;
				if (event.version !== doc.mirror?.version || !s.client.reject(event.seq)) return this.resync(doc, doc.mirror?.durable ?? null);
				this.stats.rejects++;
				this.flushSlot(s);
				return;
			}
			case "durable":
				doc.mirror?.markDurable(event.version);
				return;
			case "reloaded": {
				const s = this.slots.get(event.viewId);
				if (!s || s.doc !== doc || event.reload !== s.reload) return; // a newer reload is on its way
				s.reloadText = null;
				const skipped = s.view.holdSaves(false);
				if (event.save || skipped) void s.view.save().catch(() => undefined);
				return;
			}
		}
	}

	/** `bound`: the view's uploaded text plus `changes` is the replica at `version`; its local edits since go behind. */
	private onBound(doc: BoundDoc, event: Extract<BodyEvent, { t: "bound" }>): void {
		const s = this.slots.get(event.viewId);
		if (!s || s.doc !== doc || s.state !== "attaching" || s.attachId !== event.attach || !s.client || !s.attachDoc) return;
		const c = ChangeSet.fromJSON(event.changes);
		const target = c.apply(s.attachDoc);
		if (target.length !== event.length) return this.resync(doc, null);
		const m = doc.mirror;
		if (!m || m.version !== event.version || m.text.length !== event.length) {
			// The mirror missed entries (no view was attached): this view's result is the replica now.
			doc.mirror = new DocMirror(event.version, target);
			for (const o of [...doc.slots]) if (o !== s && o.state === "bound") this.rebind(o, null);
		}
		s.attachDoc = null;
		s.state = "bound";
		this.stats.bounds++;
		s.client.bound(c);
		if ([...doc.slots].every((o) => o.state === "bound")) this.bases.delete(doc.docId);
		this.flushSlot(s);
	}

	onDocRetarget(docId: DocId, change: { readonly t: "renamed"; readonly path: VaultPath } | { readonly t: "merged"; readonly into: DocId } | { readonly t: "deleted" } | { readonly t: "frozen"; readonly reason: string } | { readonly t: "resync" }): void {
		const doc = this.docs.get(docId);
		if (!doc) return;
		// resync: the worker dropped events (main fell behind its window); the mirror is behind but consistent.
		if (change.t === "resync") return this.resync(doc, doc.mirror?.text ?? null);
		for (const slot of [...doc.slots]) {
			this.unbindSlot(slot);
			if (change.t === "deleted") slot.state = "waiting";
			else void this.open(slot);
		}
	}

	onBindable(path: VaultPath): void {
		this.retryUnbound(path);
	}

	/** Engine request (viewSaved): save the views of `docIds` now; the engine checks the disk after its vault events. */
	async saveViews(docIds: readonly DocId[]): Promise<DocId[]> {
		const saved: DocId[] = [];
		for (const docId of docIds) {
			const doc = this.docs.get(docId);
			if (!doc) continue;
			for (const slot of [...doc.slots]) await slot.view.save().catch(() => undefined);
			saved.push(docId);
		}
		return saved;
	}

	/** Raw vault events (the host forwards every event here before batching). */
	onVaultEvent(event: { readonly t: string; readonly to?: string }): void {
		// A rename keeps the file's views (Obsidian moves view.file in place, no file-changed). A slot
		// waiting on the old path would wait forever: the engine's `bindable` is keyed by the path openDoc
		// asked for, and the new path may have been live all along. Ask again at the new path.
		if (event.t === "rename" && typeof event.to === "string") this.retryUnbound(event.to);
	}

	private addCredit(weight: number): void {
		this.credit += weight;
		if (this.creditQueued) return;
		this.creditQueued = true;
		queueMicrotask(() => {
			this.creditQueued = false;
			const bytes = this.credit;
			this.credit = 0;
			if (bytes <= 0) return;
			this.stats.creditsSent++;
			this.deps.link.post({ t: "docCredit", bytes });
		});
	}

	// --- internals: views -----------------------------------------------------

	private newSlot(view: EditorViewRef): ViewSlot {
		return {
			viewId: view.viewId, view, seq: 0, state: "idle", doc: null, binding: null, client: null, unintercept: null,
			attachDoc: null, attachId: 0, attachPosted: false, timer: null, reload: 0, reloadText: null, reloadChain: Promise.resolve(),
		};
	}

	/** Re-open every unbound (waiting/idle) slot whose view is at `path`. */
	private retryUnbound(path: string): void {
		if (!this.running) return;
		for (const slot of this.slots.values()) {
			if ((slot.state === "waiting" || slot.state === "idle") && slot.view.path !== null && this.samePath(slot.view.path, path)) void this.open(slot);
		}
	}

	private samePath(a: string, b: string): boolean {
		if (a === b) return true;
		if (!this.deps.vault.caseInsensitive) return a.normalize("NFC") === b.normalize("NFC");
		return a.normalize("NFC").toLowerCase() === b.normalize("NFC").toLowerCase();
	}

	private onViewEvent(e: ViewEvent): void {
		switch (e.t) {
			case "opened": {
				const existing = this.slots.get(e.view.viewId);
				if (existing) this.unbindSlot(existing);
				const slot = this.newSlot(e.view);
				this.slots.set(slot.viewId, slot);
				void this.open(slot);
				return;
			}
			case "file-changed": {
				let slot = this.slots.get(e.view.viewId);
				if (!slot) {
					slot = this.newSlot(e.view);
					this.slots.set(slot.viewId, slot);
				} else this.unbindSlot(slot);
				slot.reloadText = null; // another file now: its pending reload is moot
				void this.open(slot);
				return;
			}
			case "closed": {
				const slot = this.slots.get(e.viewId);
				if (!slot) return;
				this.unbindSlot(slot);
				this.slots.delete(e.viewId);
				return;
			}
		}
	}

	private async open(slot: ViewSlot): Promise<void> {
		const view = slot.view;
		const path = view.path;
		const seq = ++slot.seq;
		if (!this.running || path === null || kindOfPath(path) !== "markdown" || !view.hasEditor()) {
			slot.state = "idle";
			return;
		}
		slot.state = "opening";
		// Intercepting from here drops a bound sibling's quick preview while this view waits for openDoc (see
		// onExternalReload); everything else still reaches the editor as Obsidian applies it.
		this.intercept(slot);
		let res: EngineResultValue;
		try {
			res = await this.deps.link.openDoc(path, slot.viewId);
		} catch {
			if (seq === slot.seq) this.idle(slot, "idle");
			return;
		}
		const stale = seq !== slot.seq || this.slots.get(slot.viewId) !== slot || view.path === null || !this.samePath(view.path, path);
		if (stale) {
			if (res.t === "bind") this.deps.link.post({ t: "closeDoc", docId: res.bind.docId, viewId: slot.viewId });
			if (seq === slot.seq && this.slots.get(slot.viewId) === slot) void this.open(slot);
			return;
		}
		if (res.t !== "bind") {
			this.idle(slot, "waiting");
			return;
		}
		const info = res.bind;
		if (info.frozen) {
			// WorkspacePort has no read-only bind; a frozen doc stays unbound with a notice.
			this.deps.link.post({ t: "closeDoc", docId: info.docId, viewId: slot.viewId });
			this.idle(slot, "waiting");
			this.deps.notice("warn", "doc-frozen", "This note is frozen by sync; edits are kept locally until it is released.");
			return;
		}
		await this.attach(slot, info, seq);
	}

	/**
	 * Install the binding (local edits buffer from here on), upload the editor text (plus the merge base after a
	 * resync / restart, plus the text Obsidian last saved when the editor has unsaved edits), then bodyAttach.
	 */
	private async attach(slot: ViewSlot, info: BindInfo, seq: number): Promise<void> {
		const view = slot.view;
		let doc = this.docs.get(info.docId);
		if (!doc) this.docs.set(info.docId, (doc = { docId: info.docId, mirror: null, slots: new Set() }));
		const client = new ViewClient({
			push: (pushSeq, base, after, changes) => {
				this.stats.pushes++;
				this.deps.link.post({ t: "bodyPush", docId: info.docId, viewId: slot.viewId, seq: pushSeq, base, after, changes: changes.toJSON() as BodyChanges });
			},
			apply: (changes) => slot.binding?.applyRemote(changes),
		}, () => this.nextPush++);
		let binding: EditorBinding;
		try {
			binding = view.bind({ onLocal: (c) => this.onLocal(slot, c), onReset: () => this.onReset(slot), onSaveRead: () => this.onSaveRead(slot) });
		} catch {
			this.deps.link.post({ t: "closeDoc", docId: info.docId, viewId: slot.viewId });
			if (doc.slots.size === 0) this.docs.delete(info.docId);
			this.idle(slot, "idle");
			return;
		}
		Object.assign(slot, { binding, client, doc, state: "attaching", attachPosted: false });
		doc.slots.add(slot);
		this.intercept(slot);
		const editor = binding.doc();
		slot.attachDoc = editor;
		const base = this.bases.get(info.docId) ?? null;
		// Every bind of a dirty view says what is on disk: after an engine restart the engine has no disk text for
		// the doc, and taking this editor's unsaved text for it would turn a sibling view's (older) disk text into
		// an edit that reverts this one (sim seed 62).
		const saved = view.isDirty() ? view.lastSavedText() : null;
		const alive = () => slot.seq === seq && slot.client === client;
		const editorId = await this.upload(ofText(editor), alive);
		const baseId = base && editorId !== null ? await this.upload(ofText(base), alive) : null;
		const savedId = saved !== null && editorId !== null ? await this.upload(ofString(saved), alive) : null;
		if (!alive() || editorId === null || (base !== null && baseId === null) || (saved !== null && savedId === null)) return;
		slot.attachId = editorId;
		slot.attachPosted = true;
		this.deps.link.post({ t: "bodyAttach", docId: info.docId, viewId: slot.viewId, editor: editorId, base: baseId, saved: savedId });
		if (slot.reloadText !== null) this.sendReload(slot, slot.reloadText);
	}

	/** Upload a text as transferred UTF-16 chunks, yielding between chunks. Null when `alive` turned false. */
	private async upload(src: TextSource, alive: () => boolean): Promise<number | null> {
		const id = this.nextUpload++;
		this.stats.uploads++;
		for (let at = 0; ; ) {
			const end = Math.min(src.length, at + TEXT_CHUNK_UNITS);
			const last = end >= src.length;
			this.stats.uploadUnits += end - at;
			this.deps.link.post({ t: "textChunk", uploadId: id, bytes: encodeUtf16(src.slice(at, end)), last });
			if (last) return id;
			at = end;
			await new Promise<void>((resolve) => this.deps.clock.setTimer(0, resolve));
			if (!alive()) return null;
		}
	}

	// --- internals: editor events ---------------------------------------------

	/** A local transaction: O(change). Pushed after MAIN_UPDATE_COALESCE_MS (one timer per view). */
	private onLocal(slot: ViewSlot, changes: ChangeSet): void {
		const client = slot.client;
		if (!client) return;
		client.local(changes);
		if (slot.state === "bound" && slot.timer === null) {
			slot.timer = this.deps.clock.setTimer(MAIN_UPDATE_COALESCE_MS, () => {
				slot.timer = null;
				this.flushSlot(slot);
			});
		}
	}

	private flushSlot(slot: ViewSlot): void {
		if (slot.timer !== null) {
			this.deps.clock.clearTimer(slot.timer);
			slot.timer = null;
		}
		const m = slot.doc?.mirror;
		if (slot.state === "bound" && slot.client && m) slot.client.flush(m.version);
	}

	/**
	 * Obsidian is about to write this editor (save): push what is buffered, then tell the engine which replica
	 * text that is (its version, or its newest push), so a later read of that file text counts as absorbed.
	 */
	private onSaveRead(slot: ViewSlot): void {
		const m = slot.doc?.mirror;
		if (slot.state !== "bound" || !slot.client || !slot.doc || !m) return;
		this.flushSlot(slot);
		this.stats.saveMarks++;
		this.deps.link.post({ t: "bodySaveMark", docId: slot.doc.docId, viewId: slot.viewId, version: m.version, seq: slot.client.lastSeq });
	}

	/** EditorView.setState replaced the editor state: the binding is void; bind again (merge base: the mirror). */
	private onReset(slot: ViewSlot): void {
		if (!slot.doc) return;
		this.rebind(slot, slot.doc.mirror?.text ?? null);
	}

	/**
	 * Obsidian pushes text into a bound view without a transaction. A quick-preview copy from a sibling bound to
	 * the same doc is dropped: the replica already carries that view's edits to this one as entries. Anything
	 * else is uploaded and merged in the worker; the view holds its saves until `reloaded`, so its stale text
	 * cannot overwrite the incoming text meanwhile.
	 */
	private intercept(slot: ViewSlot): void {
		slot.unintercept ??= slot.view.interceptExternalReload((incoming, from) => this.onExternalReload(slot, incoming, from));
	}

	/** Not bound and not about to be: Obsidian applies whatever it loads into the view. */
	private idle(slot: ViewSlot, state: "idle" | "waiting"): void {
		slot.unintercept?.();
		slot.unintercept = null;
		slot.state = state;
	}

	/**
	 * Content Obsidian puts into the view without a transaction. A quick preview from a sibling view of the same
	 * file that is attaching or bound is dropped: that view's bind upload and pushes deliver its edits to the
	 * replica, which sends them here as entries. Applying the copy as well would add them twice (this editor's own
	 * upload or reload would carry them too, merged as new text). While this view is still opening, the sibling's
	 * doc is compared by path. Anything else, while attaching or bound, is merged in the worker (bodyReload).
	 */
	private onExternalReload(slot: ViewSlot, incoming: string, from: number | null): "handled" | "default" {
		if (from !== null) {
			const src = this.slots.get(from);
			const live = src !== undefined && src !== slot && (src.state === "attaching" || src.state === "bound");
			const same = live && (slot.state === "opening" ? src.view.path !== null && slot.view.path !== null && this.samePath(src.view.path, slot.view.path) : src.doc === slot.doc);
			if (same && slot.state !== "idle" && slot.state !== "waiting") {
				this.stats.siblingCopies++;
				return "handled";
			}
		}
		if (slot.state !== "attaching" && slot.state !== "bound") return "default";
		this.stats.reloads++;
		slot.view.holdSaves(true);
		slot.reloadText = incoming;
		if (slot.attachPosted) this.sendReload(slot, incoming);
		return "handled";
	}

	private sendReload(slot: ViewSlot, text: string): void {
		const doc = slot.doc;
		const client = slot.client;
		if (!doc || !client) return;
		const reload = ++slot.reload;
		const alive = () => slot.client === client;
		slot.reloadChain = slot.reloadChain.then(async () => {
			const id = await this.upload(ofString(text), alive);
			if (id !== null && alive()) this.deps.link.post({ t: "bodyReload", docId: doc.docId, viewId: slot.viewId, reload, text: id });
		});
	}

	// --- internals: unbind / resync -------------------------------------------

	private unbindSlot(slot: ViewSlot): void {
		const doc = slot.doc;
		if (doc) this.flushSlot(slot); // pushed before closeDoc: the engine applies it first
		if (slot.timer !== null) this.deps.clock.clearTimer(slot.timer);
		slot.timer = null;
		slot.seq++;
		slot.binding?.detach();
		slot.unintercept?.();
		Object.assign(slot, { binding: null, client: null, unintercept: null, doc: null, attachDoc: null, attachPosted: false, state: "idle" });
		if (!doc) return;
		doc.slots.delete(slot);
		if (this.running) this.deps.link.post({ t: "closeDoc", docId: doc.docId, viewId: slot.viewId });
		if (doc.slots.size === 0) this.docs.delete(doc.docId);
	}

	/** Re-open one view (its binding is void or out of sync); `base` = merge base for its bind. */
	private rebind(slot: ViewSlot, base: Text | null): void {
		const doc = slot.doc;
		if (!doc) return;
		this.stats.resyncs++;
		if (base && !this.bases.has(doc.docId)) this.bases.set(doc.docId, base);
		this.unbindSlot(slot);
		void this.open(slot);
	}

	/** Main is out of sync with the replica for `doc`: every view re-binds, merging against `base`. */
	private resync(doc: BoundDoc, base: Text | null): void {
		if (base) this.bases.set(doc.docId, base);
		for (const slot of [...doc.slots]) this.rebind(slot, null);
	}
}
