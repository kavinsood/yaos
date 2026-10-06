/**
 * Bound views, worker side (DESIGN §d.3): text uploads, the bind-time merge (bodyAttach -> `bound`), editor pushes
 * (bodyPush -> entry or reject) and save marks. The replica is the authority; views are CodeMirror clients of it
 * (the @codemirror/collab model): a push applies only on the version it was made against (or right after the
 * view's previous push), otherwise main rebases it over the entries it missed and pushes again. Everything after the uploads are taken runs synchronously, so
 * no other change of the replica can slip between reading its text and queueing the answer.
 */

import { DEFAULT_MERGE_LIMITS, merge } from "../../core/merge/merge";
import { applyEditsTo, minimalDiff } from "../../core/merge/minimalDiff";
import type { DocId } from "../../core/types";
import type { BodyChanges, MainToEngine } from "../../protocol/messages";
import { decodeUtf16 } from "../../protocol/utf16";
import { editsToChanges, type TextChanges } from "../body/textChanges";
import { SAVE_CANDIDATES, type BoundDocs } from "./boundDocs";
import type { BoundDisk } from "./boundDisk";
import type { VaultRuntime } from "./vaultRuntime";

/** Uploads kept while waiting for their bodyAttach (older ones are dropped: their view went away). */
const MAX_UPLOADS = 32;

type Msg<T extends MainToEngine["t"]> = Extract<MainToEngine, { t: T }>;

export interface BoundBodyDeps {
	readonly bound: BoundDocs;
	readonly disk: BoundDisk;
	runtime(): VaultRuntime | null;
	diag(message: string): void;
}

export class BoundBody {
	private readonly uploads = new Map<number, { parts: string[]; text: string | null }>();
	readonly stats = { attaches: 0, attachMerges: 0, pushes: 0, saveMarks: 0, candidates: 0 };

	constructor(private readonly deps: BoundBodyDeps) {}

	textChunk(m: Msg<"textChunk">): void {
		let u = this.uploads.get(m.uploadId);
		if (!u) {
			if (this.uploads.size >= MAX_UPLOADS) this.uploads.delete(this.uploads.keys().next().value as number);
			this.uploads.set(m.uploadId, (u = { parts: [], text: null }));
		}
		if (u.text !== null) return;
		u.parts.push(decodeUtf16(m.bytes));
		if (m.last) {
			u.text = u.parts.join("");
			u.parts = [];
		}
	}

	private take(id: number | null): string | null {
		if (id === null) return null;
		const u = this.uploads.get(id);
		this.uploads.delete(id);
		return u?.text ?? null;
	}

	/** Uploads dropped (engine runtime switch: every view re-binds). */
	clear(): void {
		this.uploads.clear();
	}

	/**
	 * Bind-time merge of view `viewId`: merge(base, disk = editor, crdt = replica) as at any disk merge (§f.3), the
	 * result into the replica (its entry reaches the doc's other views) and `bound` with the changes that turn the
	 * editor text into it. A conflict keeps the editor side as a conflict copy.
	 */
	attach(m: Msg<"bodyAttach">): Promise<void> {
		const editor = this.take(m.editor);
		const uploaded = this.take(m.base);
		const saved = this.take(m.saved);
		return this.serial(m.docId, () => this.attachNow(m, editor, uploaded, saved));
	}

	/** bodyReload: the uploaded text is merged after any attach of the doc still running. */
	reload(m: Msg<"bodyReload">): Promise<void> {
		const text = this.take(m.text);
		return this.serial(m.docId, () => this.deps.disk.reload(m.docId, m.viewId, m.reload, text));
	}

	private serial(docId: DocId, op: () => Promise<void>): Promise<void> {
		const b = this.deps.bound.get(docId);
		if (!b) return Promise.resolve();
		const run = b.ops.then(op, op);
		b.ops = run.catch((e: unknown) => this.deps.diag(`body op ${docId}: ${String(e)}`));
		return b.ops;
	}

	private async attachNow(m: Msg<"bodyAttach">, editor: string | null, uploaded: string | null, saved: string | null): Promise<void> {
		const rt = this.deps.runtime();
		const b = this.deps.bound.get(m.docId);
		if (!rt || !b || !b.views.has(m.viewId) || editor === null) return; // the view went away or re-opens
		let base = uploaded ?? b.diskText;
		if (base === null && rt.rec.ctx.synced(m.docId)?.hasBase) {
			base = await rt.rec.ctx.store.loadBase(m.docId).catch(() => null);
			if (this.deps.runtime() !== rt || this.deps.bound.get(m.docId) !== b || !b.views.has(m.viewId)) return;
			if (b.lastReported === null) b.lastReported = base;
		}
		if (rt.log.boundFrozen(m.docId)) {
			rt.onFrozen(m.docId, "frozen");
			return;
		}
		this.stats.attaches++;
		const text = rt.log.boundText(m.docId);
		let target = text;
		let copy: string | null = null;
		if (editor !== text) {
			// Disk text the replica already holds (a second view loading a save of the first): not an edit.
			const absorbed = editor === b.diskText || b.candidates.includes(editor);
			const r = merge({ base: absorbed ? editor : base, disk: editor, crdt: text, limits: DEFAULT_MERGE_LIMITS });
			if (r.kind !== "identical") target = r.text;
			if (r.kind === "conflict") copy = r.conflictCopy;
			if (target !== text) {
				this.stats.attachMerges++;
				void rt.log.editBound(m.docId, (y) => applyEditsTo(y, text, minimalDiff(text, target))).catch((e) => this.deps.diag(`attach merge: ${String(e)}`));
			}
		}
		b.attached.add(m.viewId);
		const changes = editor === target ? (editor.length > 0 ? [editor.length] : []) : editsToChanges(minimalDiff(editor, target), editor.length);
		this.deps.bound.queue(b, { t: "bound", viewId: m.viewId, attach: m.editor, version: b.version, changes, length: target.length });
		if (b.diskText === null) b.diskText = saved ?? editor;
		// The view's restart merge base starts here when nothing is pending.
		if (rt.log.bodyDurable(m.docId) && !b.frameFailed) {
			b.durable = b.version;
			this.deps.bound.queue(b, { t: "durable", version: b.version });
		}
		if (copy !== null) void this.deps.disk.writeConflictCopy(b.path, m.docId, copy);
	}

	/** Editor changes (against version `base`, or chained after the view's push `after`): one MAIN transaction (an entry tagged with the push), or rejected. */
	push(m: Msg<"bodyPush">): void {
		const rt = this.deps.runtime();
		const b = this.deps.bound.get(m.docId);
		if (!rt || !b || !b.attached.has(m.viewId)) return; // pushed before a resync / re-open: the view re-binds
		const fits = m.after === null ? m.base === b.version : b.lastAuthor?.viewId === m.viewId && b.lastAuthor.seq === m.after;
		if (!fits) {
			this.deps.bound.queue(b, { t: "reject", viewId: m.viewId, seq: m.seq, version: b.version });
			return;
		}
		this.stats.pushes++;
		const before = b.version;
		b.author = { viewId: m.viewId, seq: m.seq };
		try {
			if (!rt.log.applyEditorChanges(m.docId, m.changes as TextChanges)) {
				this.deps.diag(`push ${m.docId}: changes do not fit the replica; resync`);
				this.deps.bound.resync(b);
				return;
			}
			// A push the replica already matched (no Yjs change): still confirmed, with an empty entry.
			if (b.version === before) {
				const n = rt.log.boundLength(m.docId);
				this.deps.bound.onText(m.docId, (n > 0 ? [n] : []) as BodyChanges, n, "editor");
			}
		} catch (e) {
			this.deps.diag(`push ${m.docId}: ${String(e)}`);
			if (rt.log.boundFrozen(m.docId)) rt.onFrozen(m.docId, "frozen");
			else this.deps.bound.resync(b);
		} finally {
			b.author = null;
		}
	}

	/**
	 * A save of view `viewId` read its editor while it held the replica at `version` (plus its push `seq`, if
	 * any): when that is still the replica's text, keep it as a text the disk may hold (checkSaved, reload).
	 */
	saveMark(m: Msg<"bodySaveMark">): void {
		const rt = this.deps.runtime();
		const b = this.deps.bound.get(m.docId);
		if (!rt || !b || !b.attached.has(m.viewId)) return;
		this.stats.saveMarks++;
		const current = m.seq === null ? m.version === b.version : b.lastAuthor?.viewId === m.viewId && b.lastAuthor.seq === m.seq;
		if (!current) return;
		const text = rt.log.boundText(m.docId);
		if (b.candidates.includes(text)) return;
		this.stats.candidates++;
		b.candidates.push(text);
		if (b.candidates.length > SAVE_CANDIDATES) b.candidates.shift();
	}
}
