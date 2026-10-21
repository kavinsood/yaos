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

import type { SeededRandom } from "./random";
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

/**
 * A position not strictly inside any token, chosen by `pick` in [0,1). Disk
 * writes may also land right before a token's "[" or delete a token followed
 * by its own first character: core minimalDiff slides such edits to whole
 * tokens (an earlier trim-based diff needed the harness to avoid them).
 */
export function safePosition(text: string, pick: number): number {
	const spans = tokenSpans(text);
	const ok: number[] = [];
	let si = 0;
	for (let p = 0; p <= text.length; p++) {
		while (si < spans.length && (spans[si]?.end ?? 0) <= p) si++;
		const s = spans[si];
		if (s && s.start < p && p < s.end) continue;
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
	| { readonly t: "delete"; readonly dev: number; readonly file: number }
	// Attachments (blob docs; bytes through the blob store) and settings (config dir).
	| { readonly t: "attach"; readonly dev: number; readonly name: number; readonly size: number }
	| { readonly t: "attachRename"; readonly dev: number; readonly file: number; readonly name: number }
	| { readonly t: "attachDelete"; readonly dev: number; readonly file: number }
	| { readonly t: "setting"; readonly dev: number; readonly file: number; readonly key: number; readonly del: boolean }
	// The user's "Create snapshot" command (DESIGN §j.4): uploaded at once when the device uploads snapshots (snap rows).
	| { readonly t: "snapshot"; readonly dev: number }
	// Storms (STORM_OPS, drawn from their own stream): bulk changes past the safety brake's thresholds (DESIGN §f.5).
	/** An external tool (file sync, unzip, Importer plugin) writes `count` notes into import/b<batch>/; `big` of them >= 6 KiB. */
	| { readonly t: "importStorm"; readonly dev: number; readonly batch: number; readonly count: number; readonly big: number }
	/** The user selects many notes and deletes them: each md file with sel(path) < frac. */
	| { readonly t: "massDelete"; readonly dev: number; readonly frac: number; readonly salt: number }
	/** The user renames a top-level folder (one rename event per contained file). */
	| { readonly t: "folderMove"; readonly dev: number; readonly folder: number; readonly name: number }
	/** The user renames many notes one by one (a "rename with prefix" plugin): each md file with sel(path) < frac. */
	| { readonly t: "massRename"; readonly dev: number; readonly frac: number; readonly salt: number }
	/** An external tool rewrites many notes (formatter, find/replace, a bad sync): each md file with sel(path) < frac, shrunk. */
	| { readonly t: "massOverwrite"; readonly dev: number; readonly frac: number; readonly salt: number }
	// Delete / restore races (RACE_OPS): the user undoes deletes and starts notes over while other devices act on them.
	/** The user restores a note from the trash (Obsidian's .trash, the OS trash "Put back"): it reappears at its path, if free. */
	| { readonly t: "restoreTrash"; readonly dev: number; readonly pick: number }
	/** The user deletes a note and at once creates a new one under the same name (new text). */
	| { readonly t: "recreate"; readonly dev: number; readonly file: number };

export type OpWeights = Readonly<Record<UserAction["t"], number>>;

const NO_EXTRAS = { attach: 0, attachRename: 0, attachDelete: 0, setting: 0, snapshot: 0 } as const;
const NO_STORMS = { importStorm: 0, massDelete: 0, folderMove: 0, massRename: 0, massOverwrite: 0 } as const;
const NO_RACES = { restoreTrash: 0, recreate: 0 } as const;
/** Edits only (no deletes/renames). */
export const EDIT_OPS: OpWeights = { type: 30, paste: 2, deleteToken: 6, open: 8, close: 4, switch: 3, mode: 2, create: 6, diskInsert: 8, diskDeleteToken: 3, rename: 0, delete: 0, ...NO_EXTRAS, ...NO_STORMS, ...NO_RACES };
/** The full mix (the default). */
export const FULL_OPS: OpWeights = { ...EDIT_OPS, rename: 3, delete: 2 };
/**
 * Delete / restore races: the full mix with deletes, renames, restores from the trash and delete-then-recreate of the
 * same name several times as frequent, over the default eight note names, so devices often act on a note another one
 * just deleted, restored or renamed (edit beats delete, restores against a delete since superseded, re-created paths
 * an older restore lands on).
 */
export const RACE_OPS: OpWeights = { ...FULL_OPS, rename: 5, delete: 6, restoreTrash: 6, recreate: 4, diskInsert: 10 };
/**
 * Attachment and settings actions. The runner draws them from their own RNG
 * stream between main steps, so the main plan of a seed does not depend on them.
 */
export const EXTRA_OPS: OpWeights = {
	type: 0, paste: 0, deleteToken: 0, open: 0, close: 0, switch: 0, mode: 0, create: 0, diskInsert: 0, diskDeleteToken: 0, rename: 0, delete: 0,
	attach: 6, attachRename: 1, attachDelete: 1, setting: 4, snapshot: 0, ...NO_STORMS, ...NO_RACES,
};

/**
 * Storms (run.ts draws them from their own stream when SimConfig.storms > 0, so the main plan of a seed does not
 * depend on them). Imports come first and most often: the deletes / overwrites need a vault large enough to cross the
 * brake's MIN 50 and 20 % (core/limits BRAKE_*).
 */
export const STORM_OPS: OpWeights = { ...EXTRA_OPS, attach: 0, attachRename: 0, attachDelete: 0, setting: 0, importStorm: 4, massDelete: 3, folderMove: 2, massRename: 1, massOverwrite: 2 };

/** Manual snapshots only (run.ts draws them from their own stream, in the seeds that upload snapshots). */
export const SNAPSHOT_OPS: OpWeights = { ...EXTRA_OPS, attach: 0, attachRename: 0, attachDelete: 0, setting: 0, snapshot: 1 };

/** Synced config files the setting actor edits (DESIGN §j.3 allowlist). */
export const SETTING_FILES = ["app.json", "appearance.json", "snippets/s0.css", "snippets/s1.css"] as const;

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
		case "attach": return { t: "attach", dev, name: rng.int(4), size: rng.chance(0.1) ? rng.range(800_000, 1_700_000) : rng.range(16, 4_000) };
		case "attachRename": return { t: "attachRename", dev, file: f(), name: rng.int(4) };
		case "attachDelete": return { t: "attachDelete", dev, file: f() };
		case "setting": return { t: "setting", dev, file: rng.int(SETTING_FILES.length), key: rng.int(4), del: rng.chance(0.2) };
		case "snapshot": return { t: "snapshot", dev };
		// A batch pool of 3: two devices may import the same folder (offline, different versions: conflicts).
		case "importStorm": { const count = rng.range(40, 120); return { t: "importStorm", dev, batch: rng.int(3), count, big: Math.floor(count * rng.float()) }; }
		// 0.25 .. 0.95: below half mostly mass-delete-local, above half listing-shrank first (brake.ts priority).
		case "massDelete": return { t: "massDelete", dev, frac: 0.25 + 0.7 * rng.float(), salt: rng.int(0x7fffffff) };
		case "folderMove": return { t: "folderMove", dev, folder: f(), name: rng.int(NAME_POOL) };
		case "massRename": return { t: "massRename", dev, frac: 0.2 + 0.6 * rng.float(), salt: rng.int(0x7fffffff) };
		case "massOverwrite": return { t: "massOverwrite", dev, frac: 0.3 + 0.7 * rng.float(), salt: rng.int(0x7fffffff) };
		case "restoreTrash": return { t: "restoreTrash", dev, pick: f() };
		case "recreate": return { t: "recreate", dev, file: f() };
	}
}

/** Storm selection: a stable per-(path, salt) draw in [0,1) (the same files whatever else the vault holds). */
export function stormSelects(path: string, salt: number, frac: number): boolean {
	let h = (salt ^ 0x9e3779b9) >>> 0;
	for (let i = 0; i < path.length; i++) h = Math.imul(h ^ path.charCodeAt(i), 0x01000193) >>> 0;
	h = Math.imul(h ^ (h >>> 16), 0x85ebca6b) >>> 0;
	return (h ^ (h >>> 13)) / 2 ** 32 < frac;
}

/** Filler lines for big imported notes (no tokens): enough to make a later shrink count as an overwrite (>= 4 KiB). */
function filler(bytes: number, seed: number): string {
	const words = ["alpha", "bravo", "charlie", "delta", "echo", "foxtrot", "golf", "hotel", "india", "juliet"];
	const out: string[] = [];
	let n = 0;
	let x = seed >>> 0 || 1;
	while (n < bytes) {
		x = Math.imul(x ^ (x >>> 15), 0x2c1b3c6d) >>> 0;
		const line = `${words[x % 10]} ${words[(x >>> 4) % 10]} ${words[(x >>> 8) % 10]} ${x % 997}.`;
		out.push(line);
		n += line.length + 1;
	}
	return `${out.join("\n")}\n`;
}

/** Attachment bytes: the token in ASCII, then filler that is not valid UTF-8. */
export function attachmentBytes(token: string, size: number, seed: number): Uint8Array {
	const head = new TextEncoder().encode(`PNG ${token}\n`);
	const out = new Uint8Array(Math.max(size, head.length));
	out.set(head);
	let x = seed >>> 0 || 1;
	for (let i = head.length; i < out.length; i++) {
		x = Math.imul(x ^ (x >>> 15), 0x2c1b3c6d) >>> 0;
		out[i] = 0x80 | (x & 0x7f);
	}
	return out;
}

export interface ActorWorld {
	readonly devs: readonly SimDevice[];
	readonly ledger: TokenLedger;
	isDown(dev: number): boolean;
	/** Hidden, pagehide or freeze (faults.ts "background"): the user cannot reach the app. */
	isBackground(dev: number): boolean;
	/** The user renamed a file through Obsidian (its link updater rewrites canvases pointing at it, canvas.ts). */
	onUserRename?(dev: number, from: string, to: string, step: number): void;
}

function pickOf<T>(items: readonly T[], pick: number): T | undefined {
	return items.length === 0 ? undefined : items[Math.min(items.length - 1, Math.floor(pick * items.length))];
}

export function markdownFiles(d: SimDevice): string[] {
	return [...d.vault.snapshot().keys()].filter((p) => p.endsWith(".md")).sort();
}

export function attachmentFiles(d: SimDevice): string[] {
	return [...d.vault.snapshot().keys()].filter((p) => p.endsWith(".png")).sort();
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
	// Nobody types into, or acts through, a hidden or frozen app; other programs still write its files.
	// The engine pauses passes then (DESIGN §i.4), so those writes reach it as one change on resume.
	const external = ((a.t === "diskInsert" || a.t === "diskDeleteToken") && a.by === "external") || a.t === "importStorm" || a.t === "massOverwrite";
	if (!external && w.isBackground(a.dev)) return `skip ${tag}: app in background`;
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
			const pos = safePosition(cur, a.pos);
			w.ledger.add(token, d.name, step, `disk-${a.by}`);
			const next = `${cur.slice(0, pos)}${token} ${cur.slice(pos)}`;
			if (a.by === "user") d.vault.userWrite(path, next);
			else d.vault.externalWrite(path, next);
			return `${tag}(${a.by}) ${path}@${pos} ${token}`;
		}
		case "diskDeleteToken": {
			const path = pickOf(markdownFiles(d), a.file);
			const cur = path ? d.vault.textOf(path) : null;
			const s = cur !== null ? pickOf(tokenSpans(cur), a.pick) : undefined;
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
			w.onUserRename?.(a.dev, path, to, step);
			return `${tag} ${path} -> ${to}`;
		}
		case "delete": {
			const path = pickOf(markdownFiles(d), a.file);
			const cur = path ? d.vault.textOf(path) : null;
			if (!path || cur === null) return `skip ${tag}: no file`;
			// The user deletes what they see: the file, open editors on it, and
			// everything the device's engine had integrated (the nsDelete's
			// baseBodySeq covers those rows, DESIGN §c.7).
			const seen = [cur, d.engineText(path) ?? "", ...d.workspace.views_().filter((v) => v.path === path).map((v) => v.buffer ?? "")];
			for (const text of seen) for (const t of tokensIn(text)) w.ledger.deleted(t);
			d.vault.userDelete(path);
			return `${tag} ${path}`;
		}
		case "attach": {
			const path = `att/a${a.name}.png`;
			const cur = d.vault.textOf(path);
			// The user replaces the attachment they see.
			if (cur !== null) for (const t of tokensIn(cur)) w.ledger.deleted(t);
			w.ledger.add(token, d.name, step, "attach");
			d.vault.externalWrite(path, attachmentBytes(token, a.size, step * 31 + a.dev));
			return `${tag} ${path} ${cur === null ? "new" : "replace"} ${a.size}B ${token}`;
		}
		case "attachRename": {
			const path = pickOf(attachmentFiles(d), a.file);
			const to = `att/b${a.name}.png`;
			if (!path || !d.vault.userRename(path, to)) return `skip ${tag}`;
			w.onUserRename?.(a.dev, path, to, step);
			return `${tag} ${path} -> ${to}`;
		}
		case "attachDelete": {
			const path = pickOf(attachmentFiles(d), a.file);
			const cur = path ? d.vault.textOf(path) : null;
			if (!path || cur === null) return `skip ${tag}: no file`;
			for (const t of tokensIn(cur)) w.ledger.deleted(t);
			d.vault.userDelete(path);
			return `${tag} ${path}`;
		}
		case "importStorm": {
			let made = 0;
			for (let k = 0; k < a.count; k++) {
				const path = `import/b${a.batch}/f${k}.md`;
				const t = `[${d.name}.${step}.${k}]`;
				const cur = d.vault.textOf(path);
				// A re-import replaces what was there: the user (through the tool) dropped the old version.
				if (cur !== null) for (const old of tokensIn(cur)) w.ledger.deleted(old);
				w.ledger.add(t, d.name, step, "import");
				d.vault.externalWrite(path, `imported ${k} ${t}\n${k < a.big ? filler(6_000 + ((k * 977) % 4_000), step * 1009 + k) : ""}`);
				made++;
			}
			return `${tag} import/b${a.batch} ${made} files (${Math.min(a.big, a.count)} big)`;
		}
		case "massDelete": {
			const paths = markdownFiles(d).filter((p) => stormSelects(p, a.salt, a.frac));
			if (paths.length === 0) return `skip ${tag}: nothing selected`;
			for (const path of paths) {
				const cur = d.vault.textOf(path);
				if (cur === null) continue;
				const seen = [cur, d.engineText(path) ?? "", ...d.workspace.views_().filter((v) => v.path === path).map((v) => v.buffer ?? "")];
				for (const text of seen) for (const t of tokensIn(text)) w.ledger.deleted(t);
				d.vault.userDelete(path);
			}
			return `${tag} ${paths.length} of ${markdownFiles(d).length + paths.length} notes`;
		}
		case "folderMove": {
			const tops = [...new Set(markdownFiles(d).map((p) => p.split("/")[0]!).filter((x) => !x.endsWith(".md")))].sort();
			const from = pickOf(tops, a.folder);
			if (!from) return `skip ${tag}: no folder`;
			const to = `moved${a.name}`;
			const n = markdownFiles(d).filter((p) => p.startsWith(`${from}/`)).length;
			const moved = [...d.vault.snapshot().keys()].filter((p) => p.startsWith(`${from}/`));
			if (!d.vault.userRenameFolder(from, to)) return `skip ${tag}: ${from} -> ${to} refused`;
			// Obsidian updates canvas links to every file the move renamed, as for a single rename.
			for (const p of moved) w.onUserRename?.(a.dev, p, `${to}${p.slice(from.length)}`, step);
			return `${tag} ${from} -> ${to} (${n} notes)`;
		}
		case "massRename": {
			const paths = markdownFiles(d).filter((p) => stormSelects(p, a.salt, a.frac) && !p.split("/").pop()!.startsWith("x-"));
			let n = 0;
			for (const path of paths) {
				const i = path.lastIndexOf("/");
				const to = `${path.slice(0, i + 1)}x-${path.slice(i + 1)}`;
				if (!d.vault.userRename(path, to)) continue;
				w.onUserRename?.(a.dev, path, to, step);
				n++;
			}
			return n === 0 ? `skip ${tag}: nothing renamed` : `${tag} ${n} notes`;
		}
		case "massOverwrite": {
			const paths = markdownFiles(d).filter((p) => stormSelects(p, a.salt, a.frac));
			let n = 0;
			for (const [k, path] of paths.entries()) {
				const cur = d.vault.textOf(path);
				if (cur === null) continue;
				// The tool keeps the first line and drops the rest: what it dropped is deleted by it, i.e. by the user.
				const nl = cur.indexOf("\n");
				const head = nl < 0 ? cur : cur.slice(0, nl);
				const kept = new Set(tokensIn(head));
				for (const t of tokensIn(cur)) if (!kept.has(t)) w.ledger.deleted(t);
				const t = `[${d.name}.${step}.${k}]`;
				w.ledger.add(t, d.name, step, "overwrite");
				d.vault.externalWrite(path, `${head} ${t}\n`);
				n++;
			}
			return n === 0 ? `skip ${tag}: nothing selected` : `${tag} ${n} notes`;
		}
		case "restoreTrash": {
			// The newest trashed notes first (what the user just lost); only to a free path, as a fresh file.
			const recs = d.vault.trashed.filter((r) => r.path.endsWith(".md")).slice(-6).reverse();
			const rec = pickOf(recs, a.pick);
			if (!rec) return `skip ${tag}: trash empty`;
			if (d.vault.textOf(rec.path) !== null) return `skip ${tag}: ${rec.path} taken`;
			// Its tokens stay deleted in the ledger: the restored text is old content, not a new write. A concurrent edit
			// that removed one of them, or a concurrent delete no new content beats, legitimately wins over it (the merge
			// takes the edit, the delete covers the doc); what the restore brings back is checked by convergence and by
			// "destroyed" (it is on a disk or in a trash).
			d.vault.userWrite(rec.path, rec.text);
			return `${tag} ${rec.path} (trashed ${rec.mode} at ${rec.atMs})`;
		}
		case "recreate": {
			const path = pickOf(markdownFiles(d), a.file);
			const cur = path ? d.vault.textOf(path) : null;
			if (!path || cur === null) return `skip ${tag}: no file`;
			const seen = [cur, d.engineText(path) ?? "", ...d.workspace.views_().filter((v) => v.path === path).map((v) => v.buffer ?? "")];
			for (const text of seen) for (const t of tokensIn(text)) w.ledger.deleted(t);
			d.vault.userDelete(path);
			w.ledger.add(token, d.name, step, "recreate");
			d.vault.userWrite(path, `${token}\n`);
			return `${tag} ${path} ${token}`;
		}
		case "snapshot":
			// A user command: its export and upload run on the engine's own time (the step does not wait).
			void d.runtime.command({ t: "createSnapshot" }).catch(() => undefined);
			return tag;
		case "setting": {
			// Settings are last-writer-wins per key: no token ledger, convergence only (invariants checkSettings).
			const file = SETTING_FILES[a.file] ?? "app.json";
			const cur = await d.configDir.readBytes(file);
			let next: string;
			if (file.endsWith(".json")) {
				let obj: Record<string, unknown> = {};
				try {
					obj = cur ? (JSON.parse(new TextDecoder().decode(cur)) as Record<string, unknown>) : {};
				} catch {
					obj = {};
				}
				if (a.del) delete obj[`k${a.key}`];
				else obj[`k${a.key}`] = token;
				next = JSON.stringify(obj, null, 2);
			} else {
				if (a.del) {
					await d.configDir.remove(file);
					return `${tag} ${file} removed`;
				}
				next = `.k${a.key} { --t: "${token}"; }\n`;
			}
			await d.configDir.writeBytes(file, new TextEncoder().encode(next));
			return `${tag} ${file} ${a.del ? `-k${a.key}` : `k${a.key}=${token}`}`;
		}
	}
}
