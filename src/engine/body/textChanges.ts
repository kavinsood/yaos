/**
 * Bound-body text changes in CodeMirror ChangeSet JSON (DESIGN §d.3), worker side.
 *
 * The editor binding on main speaks @codemirror/state ChangeSets; the worker cannot load CodeMirror (it is
 * external to the bundle and main.js is also the worker script), so the conversions live here, on the JSON
 * form: a number keeps that many UTF-16 units, [n] deletes n, [n, ...lines] replaces n units with the lines
 * joined by "\n" (ChangeSet.toJSON / fromJSON, @codemirror/state 6.5.0 dist/index.js:926-1025). Every
 * function is O(change), except where it walks a Yjs delta (O(items), worker only).
 */

import type { TextEdit } from "../../core/merge/minimalDiff";

export type TextChanges = (number | [number, ...string[]])[];

/** The two Y.Text methods a push needs (structural: no Yjs import here). */
export interface ChangeSink {
	insert(index: number, text: string): void;
	delete(index: number, length: number): void;
}

/** One op of a Y.YTextEvent delta (attributes ignored: body text carries none). */
export interface DeltaOp {
	readonly insert?: unknown;
	readonly delete?: number;
	readonly retain?: number;
}

class Out {
	readonly parts: TextChanges = [];
	private del = 0;
	private ins: string | null = null;

	keep(n: number): void {
		if (n <= 0) return;
		this.flush();
		const last = this.parts[this.parts.length - 1];
		if (typeof last === "number") this.parts[this.parts.length - 1] = last + n;
		else this.parts.push(n);
	}
	remove(n: number): void {
		if (n > 0) this.del += n;
	}
	add(text: string): void {
		if (text.length > 0) this.ins = (this.ins ?? "") + text;
	}
	flush(): void {
		if (this.del === 0 && this.ins === null) return;
		this.parts.push(this.ins === null ? [this.del] : [this.del, ...this.ins.split("\n")]);
		this.del = 0;
		this.ins = null;
	}
	done(): TextChanges {
		this.flush();
		return this.parts;
	}
}

/** A YTextEvent delta as changes over the old text; `newLength` = ytext.length after (adds the kept tail). */
export function deltaToChanges(delta: readonly DeltaOp[], newLength: number): TextChanges {
	const out = new Out();
	let kept = 0;
	let inserted = 0;
	for (const d of delta) {
		if (typeof d.retain === "number") {
			out.keep(d.retain);
			kept += d.retain;
		} else if (typeof d.delete === "number") out.remove(d.delete);
		else if (typeof d.insert === "string") {
			out.add(d.insert);
			inserted += d.insert.length;
		}
	}
	out.keep(newLength - inserted - kept);
	return out.done();
}

/** minimalDiff edits over a text of length `length` as changes. */
export function editsToChanges(edits: readonly TextEdit[], length: number): TextChanges {
	const out = new Out();
	let pos = 0;
	for (const e of edits) {
		out.keep(e.start - pos);
		out.remove(e.end - e.start);
		out.add(e.text);
		pos = e.end;
	}
	out.keep(length - pos);
	return out.done();
}

/** Length of the text the changes apply to (null = malformed). */
export function changesBaseLength(changes: readonly unknown[]): number | null {
	let n = 0;
	for (const p of changes) {
		if (typeof p === "number" && Number.isInteger(p) && p >= 0) n += p;
		else if (Array.isArray(p) && typeof p[0] === "number" && Number.isInteger(p[0]) && p[0] >= 0 && p.every((x, i) => i === 0 || typeof x === "string")) n += p[0];
		else return null;
	}
	return n;
}

/** Inserted UTF-16 units (a weight estimate for flow control). */
export function changesInsertedLength(changes: readonly (number | readonly [number, ...string[]])[]): number {
	let n = 0;
	for (const p of changes) {
		if (typeof p === "number") continue;
		for (let i = 1; i < p.length; i++) n += (p[i] as string).length + (i > 1 ? 1 : 0);
	}
	return n;
}

/**
 * Apply changes over the sink's current text, start to end (call inside one transaction). Delete before insert,
 * as the y-codemirror binding did for editor transactions (y-codemirror.next 0.3.5 src/y-sync.js:143-152).
 */
export function applyChanges(sink: ChangeSink, changes: readonly (number | readonly [number, ...string[]])[]): void {
	let at = 0;
	for (const p of changes) {
		if (typeof p === "number") {
			at += p;
			continue;
		}
		if (p[0] > 0) sink.delete(at, p[0]);
		if (p.length > 1) {
			const text = p.length === 2 ? (p[1] as string) : p.slice(1).join("\n");
			if (text.length > 0) sink.insert(at, text);
			at += text.length;
		}
	}
}
