/**
 * Main-thread side of a bound doc (DESIGN §d.3): no CRDT, only CodeMirror values. The worker replica is the
 * authority and every bound editor is a client of it in the @codemirror/collab model:
 *
 *  - DocMirror: the replica's text at the last body event main applied (an immutable CodeMirror Text, so each
 *    entry costs O(change · log N)), plus the texts of versions not yet durable, for the restart merge base.
 *  - ViewClient: one editor's unconfirmed local changes: pushes in flight (the first against a replica version,
 *    each later one chained "after" the one before it) plus a buffer not pushed yet. A foreign entry F (any
 *    change of the replica that is not this view's push) is rebased over them, in order:
 *      I' = I.map(F), F1 = F.map(I, true) (for each push in flight), B' = B.map(F1), F2 = F1.map(B, true);
 *    the editor applies F2. The replica's change goes first at equal positions on both sides (map(…, true)
 *    here; the worker applies I' after F), so all editors and the replica converge. The view's own entry
 *    confirms its oldest push; a reject of it (based on an older version, or chained behind a push that was
 *    rejected or overtaken) re-pushes everything unconfirmed, composed, at the newer version: the entries that
 *    preceded the reject have already rebased it. Rejects of the pushes chained behind it are then stale.
 *
 * Nothing here reads or copies a whole document: ChangeSet map/compose/apply are O(change) on CodeMirror's
 * rope (@codemirror/state 6.5.0 dist/index.js: ChangeSet.map/compose walk sections, Text.replace is a tree edit).
 */

import type { ChangeSet, Text } from "@codemirror/state";

/** Non-durable versions kept for the restart base (beyond it the base is an older durable text: safe, coarser). */
export const MIRROR_HISTORY = 512;

export class DocMirror {
	private readonly history: { version: number; text: Text }[] = [];
	/** Replica text at the last version reported durable (null until the first durable event). */
	durable: Text | null = null;

	constructor(
		public version: number,
		public text: Text,
	) {
		this.history.push({ version, text });
	}

	/** Entry `from` -> `to`. False when it does not fit (version gap or length mismatch): main is out of sync. */
	apply(from: number, to: number, changes: ChangeSet, length: number): boolean {
		if (from !== this.version || changes.length !== this.text.length) return false;
		const text = changes.apply(this.text);
		if (text.length !== length) return false;
		this.text = text;
		this.version = to;
		this.history.push({ version: to, text });
		if (this.history.length > MIRROR_HISTORY) this.history.shift();
		return true;
	}

	markDurable(version: number): void {
		while (this.history.length > 1 && (this.history[0]?.version ?? version) < version) this.history.shift();
		const h = this.history[0];
		if (h && h.version === version) this.durable = h.text;
	}
}

export interface ClientSink {
	/** Post bodyPush `seq`: against replica version `base`, or (`after` set) right after this view's push `after`. */
	push(seq: number, base: number, after: number | null, changes: ChangeSet): void;
	/** Apply a change of the replica to the editor (not this editor's own). */
	apply(changes: ChangeSet): void;
}

export class ViewClient {
	private inflight: { readonly seq: number; changes: ChangeSet }[] = [];
	private buffer: ChangeSet | null = null;
	/** Local changes since the uploaded text was taken, before `bound` (relative to that text). */
	private pre: ChangeSet | null = null;
	private attached = false;
	/** Pushes below this seq were folded into a re-push by a reject: their own rejects are stale. */
	private dropBelow = 0;

	constructor(
		private readonly sink: ClientSink,
		private readonly nextSeq: () => number,
	) {}

	get isAttached(): boolean {
		return this.attached;
	}

	/** Unconfirmed local changes exist (the engine may not have them yet). */
	get pending(): boolean {
		return this.inflight.length > 0 || this.buffer !== null || this.pre !== null;
	}

	/** The newest push in flight (what a save mark refers to), null when every push is confirmed. */
	get lastSeq(): number | null {
		return this.inflight[this.inflight.length - 1]?.seq ?? null;
	}

	local(changes: ChangeSet): void {
		if (changes.empty) return;
		if (!this.attached) this.pre = this.pre ? this.pre.compose(changes) : changes;
		else this.buffer = this.buffer ? this.buffer.compose(changes) : changes;
	}

	/** `bound`: `c` turns the uploaded text into the replica's. Local changes made meanwhile are rebased behind it. */
	bound(c: ChangeSet): void {
		const pre = this.pre;
		this.pre = null;
		this.attached = true;
		const apply = pre ? c.map(pre, true) : c;
		if (pre) this.buffer = pre.map(c);
		if (!apply.empty) this.sink.apply(apply);
	}

	foreign(f: ChangeSet): void {
		let f1 = f;
		for (const u of this.inflight) {
			const i = u.changes;
			u.changes = i.map(f1);
			f1 = f1.map(i, true);
		}
		if (this.buffer) {
			const b = this.buffer;
			this.buffer = b.map(f1);
			f1 = f1.map(b, true);
		}
		if (!f1.empty) this.sink.apply(f1);
	}

	/** This view's push `seq` is in the replica. False = not its oldest push in flight (protocol broken: resync). */
	confirm(seq: number): boolean {
		if (this.inflight[0]?.seq !== seq) return false;
		this.inflight.shift();
		return true;
	}

	/** Push `seq` was refused: everything unconfirmed goes again (flush). False = protocol broken (resync). */
	reject(seq: number): boolean {
		if (seq < this.dropBelow && !this.inflight.some((u) => u.seq === seq)) return true;
		const first = this.inflight[0];
		if (first?.seq !== seq) return false;
		let all = first.changes;
		for (let k = 1; k < this.inflight.length; k++) all = all.compose((this.inflight[k] as { changes: ChangeSet }).changes);
		if (this.buffer) all = all.compose(this.buffer);
		this.dropBelow = (this.lastSeq ?? seq) + 1;
		this.inflight = [];
		this.buffer = all;
		return true;
	}

	/** Push the buffer (against replica version `base`, or chained after the newest push in flight). */
	flush(base: number): boolean {
		if (!this.attached || !this.buffer) return false;
		const changes = this.buffer;
		const after = this.lastSeq;
		this.buffer = null;
		const seq = this.nextSeq();
		this.inflight.push({ seq, changes });
		this.sink.push(seq, base, after, changes);
		return true;
	}
}
