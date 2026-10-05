/**
 * Simulation user actors (DESIGN §l.1): seeded, state-tolerant user actions.
 *
 * An action is generated from the RNG alone (never from world state) and
 * carries "picks" in [0,1) that are resolved against the device's state when
 * it runs; an inapplicable action is a recorded skip. So a plan is a pure
 * function of the seed, and the minimizer can drop steps and replay.
 *
 * Every inserted text carries a unique token `[<device>.<step>]` (paste:
 * `[<device>.<step>.<line>]`). The TokenLedger records each token and whether
 * a later user action deleted it; invariants require every live token to
 * survive in the converged vault (conflict copies included).
 */

import type { SeededRandom } from "./__standins__/random";
import type { SimDevice } from "./device";
import type { SimEditorView } from "./workspace";

export const TOKEN_RE = /\[[A-Z]\.\d+(?:\.\d+)?\]/g;

export interface TokenSpan {
	readonly token: string;
	readonly start: number;
	readonly end: number;
}

export function tokenSpans(text: string): TokenSpan[] {
	const out: TokenSpan[] = [];
	for (const m of text.matchAll(TOKEN_RE)) out.push({ token: m[0], start: m.index ?? 0, end: (m.index ?? 0) + m[0].length });
	return out;
}

export function tokensIn(text: string): string[] {
	return tokenSpans(text).map((s) => s.token);
}

const TOKEN_ID_RE = /[A-Z]\.\d+(?:\.\d+)?/g;
const WHOLE_TOKEN_RE = /\[[A-Z]\.\d+(?:\.\d+)?\]\s?/g;

/**
 * Tokens by identity ("A.15" -> "[A.15]"), ignoring their brackets. Survival checks use this:
 * a disk write reaches the CRDT as a minimal diff (DESIGN §f: prefix/suffix trim), which may
 * reuse a neighbour's "[" or "]" for a new token ("[Z.1]" -> "[A.15] " diffs as "Z.1]" ->
 * "A.15] " after the shared "["); a concurrent delete of that neighbour then takes the
 * bracket with it although every character the user wrote for the new token survives.
 * The same trim may reuse more ("[A.6]" -> "[A.53] " when the engine sees a token delete
 * and an external insert as one change keeps "[A."), and a concurrent remote insert at that
 * spot lands inside the identity: "[A.[B.23] 53]". So whole tokens are peeled off and the
 * remainder is matched again, until nothing changes; every character of both tokens is there.
 * Greedy matching keeps "A.1" distinct from "A.15" and "A.12.3".
 */
export function tokenIdsIn(text: string): string[] {
	const ids = new Set<string>();
	let cur = text;
	for (;;) {
		for (const m of cur.matchAll(TOKEN_ID_RE)) ids.add(`[${m[0]}]`);
		const next = cur.replace(WHOLE_TOKEN_RE, "");
		if (next === cur) return [...ids];
		cur = next;
	}
}

/**
 * A position not strictly inside any token, chosen by `pick` in [0,1).
 * With `first` (disk writes): also not right before that character. A disk
 * write reaches the CRDT as a prefix/suffix-trimmed diff; when the inserted
 * text starts with the character that follows it, the diff shifts the hunk
 * right ("[B.1] [A.2]" diffs as "B.1] [" after the first "["), and a
 * concurrent delete of the neighbour then splits the token although no typed
 * character is lost. Editor typing goes to the CRDT directly and needs no rule.
 */
export function safePosition(text: string, pick: number, first?: string): number {
	const spans = tokenSpans(text);
	const ok: number[] = [];
	let si = 0;
	for (let p = 0; p <= text.length; p++) {
		while (si < spans.length && (spans[si]?.end ?? 0) <= p) si++;
		const s = spans[si];
		if (s && s.start < p && p < s.end) continue;
		if (first !== undefined && text[p] === first) continue;
		ok.push(p);
	}
	return ok[Math.min(ok.length - 1, Math.floor(pick * ok.length))] ?? 0;
}

export type TokenState = "live" | "deleted" | "unacked";

export interface TokenEntry {
	readonly token: string;
	readonly dev: string;
	readonly step: number;
	readonly via: string;
	state: TokenState;
}

export class TokenLedger {
	readonly entries = new Map<string, TokenEntry>();
	add(token: string, dev: string, step: number, via: string): void {
		this.entries.set(token, { token, dev, step, via, state: "live" });
	}
	/** A user action removed it (exempt from survival). */
	deleted(token: string): void {
		const e = this.entries.get(token);
		if (e) e.state = "deleted";
	}
	/** Lost with a crash before it was acknowledged (exempt from survival). */
	unacked(token: string): void {
		const e = this.entries.get(token);
		if (e && e.state === "live") e.state = "unacked";
	}
	live(): TokenEntry[] {
		return [...this.entries.values()].filter((e) => e.state === "live");
	}
}

export type Writer = "user" | "external";

export type UserAction =
	| { readonly t: "type"; readonly dev: number; readonly view: number; readonly pos: number; readonly nl: boolean }
	| { readonly t: "paste"; readonly dev: number; readonly view: number; readonly pos: number; readonly lines: number }
	| { readonly t: "deleteToken"; readonly dev: number; readonly view: number; readonly pick: number }
	| { readonly t: "open"; readonly dev: number; readonly file: number }
	| { readonly t: "close"; readonly dev: number; readonly view: number }
	| { readonly t: "switch"; readonly dev: number; readonly view: number; readonly file: number }
	| { readonly t: "mode"; readonly dev: number; readonly view: number }
	| { readonly t: "create"; readonly dev: number; readonly name: number }
	| { readonly t: "diskInsert"; readonly dev: number; readonly file: number; readonly pos: number; readonly by: Writer }
	| { readonly t: "diskDeleteToken"; readonly dev: number; readonly file: number; readonly pick: number; readonly by: Writer }
	| { readonly t: "rename"; readonly dev: number; readonly file: number; readonly name: number }
	| { readonly t: "delete"; readonly dev: number; readonly file: number };

export type OpWeights = Readonly<Record<UserAction["t"], number>>;

/** What the stand-in engine supports (no deletes/renames: see wp-d-notes). */
export const STANDIN_OPS: OpWeights = { type: 30, paste: 2, deleteToken: 6, open: 8, close: 4, switch: 3, mode: 2, create: 6, diskInsert: 8, diskDeleteToken: 3, rename: 0, delete: 0 };
/** INTEGRATION: the full mix once WP-B/WP-C handle renames and deletes. */
export const FULL_OPS: OpWeights = { ...STANDIN_OPS, rename: 3, delete: 2 };

const NAME_POOL = 8;
const MAX_VIEWS = 3;

function weighted<K extends string>(rng: SeededRandom, w: Readonly<Record<K, number>>): K {
	const keys = (Object.keys(w) as K[]).filter((k) => w[k] > 0);
	const total = keys.reduce((s, k) => s + w[k], 0);
	let x = rng.float() * total;
	for (const k of keys) {
		x -= w[k];
		if (x < 0) return k;
	}
	return keys[keys.length - 1] as K;
}

export function generateUserAction(rng: SeededRandom, devices: number, weights: OpWeights): UserAction {
	const dev = rng.int(devices);
	const f = () => rng.float();
	const by: Writer = rng.chance(0.5) ? "user" : "external";
	switch (weighted(rng, weights)) {
		case "type": return { t: "type", dev, view: f(), pos: f(), nl: rng.chance(0.2) };
		case "paste": return { t: "paste", dev, view: f(), pos: f(), lines: rng.range(20, 200) };
		case "deleteToken": return { t: "deleteToken", dev, view: f(), pick: f() };
		case "open": return { t: "open", dev, file: f() };
		case "close": return { t: "close", dev, view: f() };
		case "switch": return { t: "switch", dev, view: f(), file: f() };
		case "mode": return { t: "mode", dev, view: f() };
		case "create": return { t: "create", dev, name: rng.int(NAME_POOL) };
		case "diskInsert": return { t: "diskInsert", dev, file: f(), pos: f(), by };
		case "diskDeleteToken": return { t: "diskDeleteToken", dev, file: f(), pick: f(), by };
		case "rename": return { t: "rename", dev, file: f(), name: rng.int(NAME_POOL) };
		case "delete": return { t: "delete", dev, file: f() };
	}
}

export interface ActorWorld {
	readonly devs: readonly SimDevice[];
	readonly ledger: TokenLedger;
	isDown(dev: number): boolean;
}

function pickOf<T>(items: readonly T[], pick: number): T | undefined {
	return items.length === 0 ? undefined : items[Math.min(items.length - 1, Math.floor(pick * items.length))];
}

export function markdownFiles(d: SimDevice): string[] {
	return [...d.vault.snapshot().keys()].filter((p) => p.endsWith(".md")).sort();
}

function boundViews(d: SimDevice): SimEditorView[] {
	return d.workspace.views_().filter((v) => v.hasEditor() && v.isBound());
}

/** Apply one user action; returns a trace line ("skip ..." when inapplicable). */
export async function runUserAction(w: ActorWorld, a: UserAction, step: number): Promise<string> {
	const d = w.devs[a.dev];
	if (!d) return `skip ${a.t}: no device ${a.dev}`;
	const tag = `${d.name} ${a.t}`;
	if (w.isDown(a.dev)) return `skip ${tag}: app down`;
	const token = `[${d.name}.${step}]`;
	const ws = d.workspace;
	switch (a.t) {
		case "type":
		case "paste": {
			const v = pickOf(boundViews(d), a.view);
			if (!v) return `skip ${tag}: no bound view`;
			const pos = safePosition(v.buffer, a.pos);
			let text: string;
			if (a.t === "type") {
				text = `${token}${a.nl ? "\n" : " "}`;
				w.ledger.add(token, d.name, step, "typed");
			} else {
				const lines: string[] = [];
				for (let i = 0; i < a.lines; i++) {
					const t = `[${d.name}.${step}.${i}]`;
					lines.push(`line ${i} ${t}`);
					w.ledger.add(t, d.name, step, "paste");
				}
				text = `${lines.join("\n")}\n`;
			}
			v.edit(pos, 0, text);
			return `${tag} ${v.path}@${pos} ${a.t === "type" ? token : `${a.lines} lines`}`;
		}
		case "deleteToken": {
			const v = pickOf(boundViews(d), a.view);
			const s = v ? pickOf(tokenSpans(v.buffer), a.pick) : undefined;
			if (!v || !s) return `skip ${tag}: nothing to delete`;
			v.edit(s.start, s.end - s.start, "");
			w.ledger.deleted(s.token);
			return `${tag} ${v.path} ${s.token}`;
		}
		case "open": {
			const path = pickOf(markdownFiles(d), a.file);
			if (!path || ws.views_().length >= MAX_VIEWS) return `skip ${tag}`;
			const v = ws.openFile(path);
			return v ? `${tag} ${path} -> view ${v.viewId}` : `skip ${tag}: ${path} vanished`;
		}
		case "close": {
			const v = pickOf(ws.views_(), a.view);
			if (!v) return `skip ${tag}: no view`;
			await ws.closeView(v.viewId);
			return `${tag} view ${v.viewId}`;
		}
		case "switch": {
			const v = pickOf(ws.views_(), a.view);
			const path = pickOf(markdownFiles(d), a.file);
			if (!v || !path) return `skip ${tag}`;
			const ok = await ws.switchFile(v.viewId, path);
			return ok ? `${tag} view ${v.viewId} -> ${path}` : `skip ${tag}: failed`;
		}
		case "mode": {
			const v = pickOf(ws.views_(), a.view);
			if (!v) return `skip ${tag}: no view`;
			const mode = v.mode === "source" ? "reading" : "source";
			ws.setMode(v.viewId, mode);
			return `${tag} view ${v.viewId} -> ${mode}`;
		}
		case "create": {
			const path = `notes/n${a.name}.md`;
			const cur = d.vault.textOf(path);
			w.ledger.add(token, d.name, step, "create");
			d.vault.userWrite(path, cur === null ? `${token}\n` : `${cur}${token}\n`);
			return `${tag} ${path} ${cur === null ? "new" : "append"} ${token}`;
		}
		case "diskInsert": {
			const path = pickOf(markdownFiles(d), a.file);
			const cur = path ? d.vault.textOf(path) : null;
			if (!path || cur === null) return `skip ${tag}: no file`;
			const pos = safePosition(cur, a.pos, "[");
			w.ledger.add(token, d.name, step, `disk-${a.by}`);
			const next = `${cur.slice(0, pos)}${token} ${cur.slice(pos)}`;
			if (a.by === "user") d.vault.userWrite(path, next);
			else d.vault.externalWrite(path, next);
			return `${tag}(${a.by}) ${path}@${pos} ${token}`;
		}
		case "diskDeleteToken": {
			const path = pickOf(markdownFiles(d), a.file);
			const cur = path ? d.vault.textOf(path) : null;
			// Same diff-shift rule as safePosition: a token followed by its own first character would be deleted shifted.
			const s = cur !== null ? pickOf(tokenSpans(cur).filter((t) => cur[t.end] !== cur[t.start]), a.pick) : undefined;
			if (!path || cur === null || !s) return `skip ${tag}: nothing to delete`;
			const next = cur.slice(0, s.start) + cur.slice(s.end);
			w.ledger.deleted(s.token);
			if (a.by === "user") d.vault.userWrite(path, next);
			else d.vault.externalWrite(path, next);
			return `${tag}(${a.by}) ${path} ${s.token}`;
		}
		case "rename": {
			const path = pickOf(markdownFiles(d), a.file);
			const to = `notes/r${a.name}.md`;
			if (!path || !d.vault.userRename(path, to)) return `skip ${tag}`;
			return `${tag} ${path} -> ${to}`;
		}
		case "delete": {
			const path = pickOf(markdownFiles(d), a.file);
			const cur = path ? d.vault.textOf(path) : null;
			if (!path || cur === null) return `skip ${tag}: no file`;
			for (const t of tokensIn(cur)) w.ledger.deleted(t);
			d.vault.userDelete(path);
			return `${tag} ${path}`;
		}
	}
}
