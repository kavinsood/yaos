/**
 * SimBodyEngine: the worker side of the bound-body protocol (DESIGN §d.3) with a CodeMirror Text as the replica,
 * for unit tests of the main-thread binding (host/binding.ts) without the composed engine. It follows
 * engine/compose/boundBody.ts + boundDocs.ts: versions, author-tagged entries, chained pushes and rejects,
 * bind-time and reload merges (core merge, as the worker), durable marks on request. Both directions are FIFO
 * (postMessage), each message after a seeded delay, so a test controls how pushes and remote edits interleave.
 */

import { ChangeSet, Text } from "@codemirror/state";
import type { DocId, VaultPath } from "../core/types";
import { DEFAULT_MERGE_LIMITS, merge } from "../core/merge/merge";
import { minimalDiff } from "../core/merge/minimalDiff";
import { editsToChanges } from "../engine/body/textChanges";
import type { BindingLink, BindingManager } from "../host/binding";
import type { ClockPort } from "../ports/clock";
import type { BodyChanges, BodyEvent, EngineResultValue, MainToEngine } from "../protocol/messages";
import { decodeUtf16 } from "../protocol/utf16";
import { simText } from "./workspace";

interface Doc {
	readonly docId: DocId;
	text: Text;
	version: number;
	readonly views: Set<number>;
	readonly attached: Set<number>;
	lastAuthor: { readonly viewId: number; readonly seq: number } | null;
	diskText: string | null;
	/** Text per version since the last durable mark (restart: the replica falls back to the durable one). */
	durable: { version: number; text: Text };
}

export class SimBodyEngine {
	readonly docs = new Map<string, Doc>();
	readonly posts: MainToEngine[] = [];
	readonly events: { docId: DocId; event: BodyEvent }[] = [];
	notBindable = new Set<string>();
	frozen = new Set<string>();
	bm: BindingManager | null = null;
	/** Delay of the next message in either direction (ms); FIFO is kept per direction. */
	delay: () => number = () => 0;
	private readonly uploads = new Map<number, string[]>();
	private readonly done = new Map<number, string>();
	private toEngineAt = 0;
	private toMainAt = 0;
	/** Engine generation: messages to or from a dead engine are dropped. */
	private gen = 0;

	constructor(private readonly clock: ClockPort) {}

	readonly link: BindingLink = {
		post: (m) => {
			this.posts.push(m);
			this.later("engine", () => this.receive(m));
		},
		openDoc: (path, viewId) =>
			new Promise<EngineResultValue>((resolve) => {
				this.later("engine", () => {
					const d = this.docs.get(path);
					if (!d || this.notBindable.has(path)) return this.later("main", () => resolve({ t: "notBindable", reason: "untracked" }));
					d.views.add(viewId);
					this.later("main", () => resolve({ t: "bind", bind: { docId: d.docId, kind: "markdown", frozen: this.frozen.has(path) } }));
				});
			}),
	};

	add(path: string, text: string, docId = `d:${path}` as DocId): DocId {
		const t = simText(text);
		this.docs.set(path, { docId, text: t, version: 0, views: new Set(), attached: new Set(), lastAuthor: null, diskText: text, durable: { version: 0, text: t } });
		return docId;
	}

	text(path: string): string {
		return this.docs.get(path)?.text.toString() ?? "";
	}

	count(t: MainToEngine["t"]): number {
		return this.posts.filter((m) => m.t === t).length;
	}

	/** A remote change of the replica (another device), as an entry to every attached view. */
	remote(path: string, from: number, to: number, insert: string): void {
		const d = this.need(path);
		const len = d.text.length;
		const a = Math.max(0, Math.min(from, len));
		const b = Math.max(a, Math.min(to, len));
		this.apply(d, ChangeSet.of({ from: a, to: b, insert: simText(insert) }, len), "remote", null);
	}

	/** Every change so far is committed. */
	markDurable(path: string): void {
		const d = this.need(path);
		d.durable = { version: d.version, text: d.text };
		this.emit(d, { t: "durable", version: d.version });
	}

	/** The engine dies: replicas fall back to their durable text, views re-bind (HostRuntime onDown + start). */
	restart(): void {
		for (const d of this.docs.values()) {
			d.text = d.durable.text;
			d.views.clear();
			d.attached.clear();
			d.lastAuthor = null;
		}
		this.uploads.clear();
		this.done.clear();
		this.gen++;
		this.bm?.suspend();
		this.later("main", () => this.bm?.start());
	}

	private need(path: string): Doc {
		const d = this.docs.get(path);
		if (!d) throw new Error(`no doc at ${path}`);
		return d;
	}

	private byId(docId: DocId): Doc | undefined {
		for (const d of this.docs.values()) if (d.docId === docId) return d;
		return undefined;
	}

	private later(to: "engine" | "main", fn: () => void): void {
		const gen = this.gen;
		const now = this.clock.now();
		const at = Math.max(to === "engine" ? this.toEngineAt : this.toMainAt, now + Math.max(0, this.delay()));
		if (to === "engine") this.toEngineAt = at;
		else this.toMainAt = at;
		this.clock.setTimer(at - now, () => {
			if (gen === this.gen) fn();
		});
	}

	private emit(d: Doc, event: BodyEvent): void {
		if (d.attached.size === 0 && (event.t === "entry" || event.t === "durable")) return;
		this.events.push({ docId: d.docId, event });
		this.later("main", () => this.bm?.onBody(d.docId, event, 1));
	}

	private apply(d: Doc, c: ChangeSet, origin: "remote" | "merge" | "editor", author: Doc["lastAuthor"]): void {
		const from = d.version++;
		d.text = c.apply(d.text);
		d.lastAuthor = author;
		this.emit(d, { t: "entry", from, to: d.version, changes: c.toJSON() as BodyChanges, length: d.text.length, origin, author });
	}

	private take(id: number | null): string | null {
		if (id === null) return null;
		const t = this.done.get(id) ?? null;
		this.done.delete(id);
		return t;
	}

	private receive(m: MainToEngine): void {
		switch (m.t) {
			case "textChunk": {
				const parts = this.uploads.get(m.uploadId) ?? [];
				parts.push(decodeUtf16(m.bytes));
				this.uploads.set(m.uploadId, parts);
				if (m.last) {
					this.done.set(m.uploadId, parts.join(""));
					this.uploads.delete(m.uploadId);
				}
				return;
			}
			case "bodyAttach":
				return this.attach(m);
			case "bodyPush":
				return this.push(m);
			case "bodyReload":
				return this.reload(m);
			case "closeDoc": {
				const d = this.byId(m.docId);
				d?.views.delete(m.viewId);
				d?.attached.delete(m.viewId);
				return;
			}
			default:
				return;
		}
	}

	/** boundBody.attachNow: merge(base, disk = editor, crdt = replica); the result into the replica; `bound`. */
	private attach(m: Extract<MainToEngine, { t: "bodyAttach" }>): void {
		const editor = this.take(m.editor);
		const uploaded = this.take(m.base);
		const saved = this.take(m.saved);
		const d = this.byId(m.docId);
		if (!d || !d.views.has(m.viewId) || editor === null) return;
		const text = d.text.toString();
		let target = text;
		if (editor !== text) {
			const r = merge({ base: editor === d.diskText ? editor : uploaded ?? d.diskText, disk: editor, crdt: text, limits: DEFAULT_MERGE_LIMITS });
			if (r.kind !== "identical") target = r.text;
			if (target !== text) this.apply(d, ChangeSet.fromJSON(editsToChanges(minimalDiff(text, target), text.length)), "merge", null);
		}
		d.attached.add(m.viewId);
		const changes = editor === target ? (editor.length > 0 ? [editor.length] : []) : editsToChanges(minimalDiff(editor, target), editor.length);
		this.emit(d, { t: "bound", viewId: m.viewId, attach: m.editor, version: d.version, changes, length: target.length });
		if (d.diskText === null) d.diskText = saved ?? editor;
	}

	private push(m: Extract<MainToEngine, { t: "bodyPush" }>): void {
		const d = this.byId(m.docId);
		if (!d || !d.attached.has(m.viewId)) return;
		const fits = m.after === null ? m.base === d.version : d.lastAuthor?.viewId === m.viewId && d.lastAuthor.seq === m.after;
		if (!fits) return this.emit(d, { t: "reject", viewId: m.viewId, seq: m.seq, version: d.version });
		this.apply(d, ChangeSet.fromJSON(m.changes), "editor", { viewId: m.viewId, seq: m.seq });
	}

	/** boundDisk.reload: merge(diskText, incoming, replica) into the replica; `reloaded`. */
	private reload(m: Extract<MainToEngine, { t: "bodyReload" }>): void {
		const incoming = this.take(m.text);
		const d = this.byId(m.docId);
		if (!d || incoming === null) return;
		const text = d.text.toString();
		const r = merge({ base: d.diskText, disk: incoming, crdt: text, limits: DEFAULT_MERGE_LIMITS });
		const target = r.kind === "identical" ? text : r.text;
		if (target !== text) this.apply(d, ChangeSet.fromJSON(editsToChanges(minimalDiff(text, target), text.length)), "merge", null);
		d.diskText = incoming;
		this.emit(d, { t: "reloaded", viewId: m.viewId, reload: m.reload, save: target !== incoming });
	}
}
