/**
 * Echo suppression (DESIGN §f.4). Every completed engine write / rename /
 * trash records what the matching vault event will look like; the event is
 * dropped once (consumed) if it matches within ECHO_TTL_MS. Anything else is a
 * real change and marks the path dirty. Only hints are dropped: the periodic
 * full reconcile re-checks stats, so a wrong drop costs latency, never data.
 */

import type { PathKey, PathKeyFn } from "../../core/types";
import { ECHO_TTL_MS } from "../../core/limits";
import type { VaultEvent } from "../../ports/vault";

type Expect =
	| { readonly kind: "write"; readonly size: number; readonly mtimeMs: number; readonly expiresAt: number }
	| { readonly kind: "rename"; readonly fromKey: PathKey; readonly expiresAt: number }
	| { readonly kind: "trash"; readonly expiresAt: number };

export class EchoTable {
	/** pathKey (target for renames) -> pending expectations, oldest first. */
	private readonly table = new Map<PathKey, Expect[]>();

	constructor(private readonly pathKey: PathKeyFn, private readonly monotonic: () => number) {}

	private add(key: PathKey, e: Expect): void {
		const list = this.table.get(key);
		if (list) list.push(e);
		else this.table.set(key, [e]);
	}

	expectWrite(key: PathKey, size: number, mtimeMs: number): void {
		this.add(key, { kind: "write", size, mtimeMs, expiresAt: this.monotonic() + ECHO_TTL_MS });
	}

	expectRename(fromKey: PathKey, toKey: PathKey): void {
		this.add(toKey, { kind: "rename", fromKey, expiresAt: this.monotonic() + ECHO_TTL_MS });
	}

	expectTrash(key: PathKey): void {
		this.add(key, { kind: "trash", expiresAt: this.monotonic() + ECHO_TTL_MS });
	}

	private take(key: PathKey, pred: (e: Expect) => boolean): boolean {
		const list = this.table.get(key);
		if (!list) return false;
		const now = this.monotonic();
		const live = list.filter((e) => e.expiresAt > now);
		const i = live.findIndex(pred);
		if (i >= 0) live.splice(i, 1);
		if (live.length === 0) this.table.delete(key);
		else this.table.set(key, live);
		return i >= 0;
	}

	/** True = own echo, drop the event (the expectation is consumed). */
	match(event: VaultEvent): boolean {
		const key = (p: string) => this.pathKey(p.normalize("NFC"));
		switch (event.t) {
			case "create":
			case "modify": {
				const st = event.stat;
				if (!st) return false;
				return this.take(key(event.path), (e) => e.kind === "write" && e.size === st.size && e.mtimeMs === st.mtimeMs);
			}
			case "rename": {
				const from = key(event.from);
				return this.take(key(event.to), (e) => e.kind === "rename" && e.fromKey === from);
			}
			case "delete":
				return this.take(key(event.path), (e) => e.kind === "trash");
		}
	}

	/** Drop expired entries (called once per pass). */
	sweep(): void {
		const now = this.monotonic();
		for (const [k, list] of this.table) {
			const live = list.filter((e) => e.expiresAt > now);
			if (live.length === 0) this.table.delete(k);
			else this.table.set(k, live);
		}
	}

	get size(): number {
		let n = 0;
		for (const list of this.table.values()) n += list.length;
		return n;
	}
}
