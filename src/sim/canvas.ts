/**
 * Canvas in the simulation (DESIGN §j.2, §l.1): what Obsidian's canvas view and other programs do to `.canvas`
 * files, and the oracle of what the users meant.
 *
 * The model. Obsidian's canvas view is never bound (§j.2): it holds the canvas in memory and saves the WHOLE file
 * through vault.modify, with its own key order (`obsidianText`: id, type, the type's fields, x, y, width, height,
 * color, then the fields it does not know, which it keeps; edges id, fromNode, fromSide, toNode, toSide, ...;
 * `nodes`, `edges` first at the top level) and tab indentation. Every user action here reads the file, changes
 * the model and writes the whole file back as a "user" write: a canvas view that reloaded the file before the edit
 * (Obsidian reloads open views on modify). Other programs (`external`) write whole files with shuffled keys, other
 * indentation, CRLF, a trailing newline or a BOM. Broken writes model a crash mid-save or a non-atomic writer: a
 * truncated file, garbage, a dangling edge, a duplicate id, an unknown node type or a string coordinate, completed
 * (fixed) by a later whole-file write `fixMs` later, or at the heal. A new canvas is created empty (0 bytes, as
 * Obsidian's "New canvas" does) or with nodes. Renaming a note through Obsidian rewrites the canvases on that device
 * whose file nodes point at it (Obsidian's link updater; the engine's own renames go through vault.rename, which
 * does not update links).
 *
 * The oracle (CanvasOracle). Every value an action writes into a tracked field (x, y, width, height, color, label,
 * url, subpath, background, unknown fields at the top level, on nodes and on edges) is unique in the run, and each
 * write records the value it replaced (`saw`, read from the file it edited). So every final value names the write
 * that made it, and the saw-chains are the causal order of the writes to that field: a write that saw value V and
 * replaced it must never be undone back to V (invariants.ts checkCanvasIntents). Text-node text goes through the
 * token ledger (actors.ts): tokens typed into a node's text must survive like tokens in a note. Records: every node
 * and edge created and not deleted by a user must exist at the end; a record a user deleted must stay deleted unless
 * a concurrent edit or a conflict copy explains it (DESIGN §j.2 "Merge semantics").
 *
 * Actions are generated from the RNG alone and carry picks resolved against the device's files when they run (as
 * actors.ts), so a plan is a pure function of the seed and ddmin can drop steps.
 */

import { canonicalJson, type JsonValue } from "../core/hash/canvasCanonical";
import { projectCanvasBytes } from "../engine/reconcile/canvasDoc";
import type { DocId } from "../core/types";
import { pathKey } from "../core/paths/pathKey";
import { safePosition, tokenSpans, tokensIn, type TokenLedger, type Writer } from "./actors";
import type { VirtualClock } from "./clock";
import type { SimDevice } from "./device";
import { SeededRandom } from "./random";

type Obj = { [key: string]: JsonValue };

/**
 * A canvas field as text: String() of a scalar. A valid canvas's id/type/text/endpoints/color are strings and x a
 * number, so the object branch (JSON, not "[object Object]") is only for a field the sim did not expect.
 */
export function fieldText(v: JsonValue | undefined): string {
	return typeof v === "object" && v !== null ? JSON.stringify(v) : String(v);
}

export interface CanvasModel {
	root: Obj;
	nodes: Obj[];
	edges: Obj[];
}

export const NODE_TYPES = ["text", "file", "link", "group"] as const;
export type NodeType = (typeof NODE_TYPES)[number];
const SIDES = ["top", "right", "bottom", "left"] as const;

function isObj(v: unknown): v is Obj {
	return v !== null && typeof v === "object" && !Array.isArray(v);
}

function noBom(text: string): string {
	return text.startsWith("\uFEFF") ? text.slice(1) : text;
}

function stripText(text: string): string {
	return (text.startsWith("\uFEFF") ? text.slice(1) : text).trim();
}

/**
 * JSON Canvas validity as the spec and Obsidian see it (independent of the engine's parser): an object whose
 * `nodes` / `edges` are arrays (or missing), nodes with unique non-empty string ids, a known type, finite x / y and
 * non-negative finite width / height, the type's required string fields, optional string colors; edges with unique
 * ids whose endpoints are nodes. The empty file is the empty canvas. null = valid, else what is wrong.
 */
export function canvasProblem(text: string): string | null {
	const t = stripText(text);
	if (t === "") return null;
	let raw: unknown;
	try {
		raw = JSON.parse(t);
	} catch {
		return "not JSON";
	}
	if (!isObj(raw)) return "root is not an object";
	const nodes = raw.nodes ?? [];
	const edges = raw.edges ?? [];
	if (!Array.isArray(nodes) || !Array.isArray(edges)) return "nodes / edges not arrays";
	const ids = new Set<string>();
	const num = (v: unknown) => typeof v === "number" && Number.isFinite(v);
	const optStr = (o: Obj, k: string) => o[k] === undefined || typeof o[k] === "string";
	for (const n of nodes) {
		if (!isObj(n) || typeof n.id !== "string" || n.id === "") return "node without an id";
		if (ids.has(n.id)) return `duplicate node ${n.id}`;
		ids.add(n.id);
		if (!(NODE_TYPES as readonly unknown[]).includes(n.type)) return `node ${n.id}: type ${JSON.stringify(n.type)}`;
		if (!num(n.x) || !num(n.y) || !num(n.width) || !num(n.height) || (n.width as number) < 0 || (n.height as number) < 0) return `node ${n.id}: geometry`;
		if (n.type === "text" && typeof n.text !== "string") return `node ${n.id}: text`;
		if (n.type === "file" && typeof n.file !== "string") return `node ${n.id}: file`;
		if (n.type === "link" && typeof n.url !== "string") return `node ${n.id}: url`;
		if (!optStr(n, "color")) return `node ${n.id}: color`;
	}
	const edgeIds = new Set<string>();
	for (const e of edges) {
		if (!isObj(e) || typeof e.id !== "string" || e.id === "") return "edge without an id";
		if (edgeIds.has(e.id)) return `duplicate edge ${e.id}`;
		edgeIds.add(e.id);
		if (typeof e.fromNode !== "string" || typeof e.toNode !== "string") return `edge ${e.id}: endpoints`;
		if (!ids.has(e.fromNode) || !ids.has(e.toNode)) return `edge ${e.id}: dangling`;
		for (const k of ["fromSide", "toSide", "fromEnd", "toEnd", "color", "label"]) if (!optStr(e, k)) return `edge ${e.id}: ${k}`;
	}
	return null;
}

/** What Obsidian loads: a valid canvas as a mutable model (unknown fields kept), else null. */
export function readModel(text: string): CanvasModel | null {
	if (canvasProblem(text) !== null) return null;
	const t = stripText(text);
	const raw = (t === "" ? {} : JSON.parse(t)) as Obj;
	const root: Obj = {};
	for (const k of Object.keys(raw)) if (k !== "nodes" && k !== "edges") root[k] = raw[k]!;
	return { root, nodes: ((raw.nodes ?? []) as Obj[]).map((n) => ({ ...n })), edges: ((raw.edges ?? []) as Obj[]).map((e) => ({ ...e })) };
}

/**
 * The canonical (logical) form of a valid canvas file as the spec defines its content: sorted keys at every level,
 * node and edge arrays in file order (array order is z-order), the empty file = `{"edges":[],"nodes":[]}`. The
 * convergence invariant compares canvas files in this form (DESIGN §j.2: formatting-only differences are never
 * rewritten). null when invalid.
 */
export function canvasCanonical(text: string): string | null {
	const m = readModel(text);
	if (!m) return null;
	return canonicalJson({ ...m.root, nodes: m.nodes, edges: m.edges });
}

const NODE_KEY_ORDER: Readonly<Record<string, readonly string[]>> = {
	text: ["id", "type", "text", "x", "y", "width", "height", "color"],
	file: ["id", "type", "file", "subpath", "x", "y", "width", "height", "color"],
	link: ["id", "type", "url", "x", "y", "width", "height", "color"],
	group: ["id", "type", "x", "y", "width", "height", "color", "label", "background", "backgroundStyle"],
};
const EDGE_KEY_ORDER = ["id", "fromNode", "fromSide", "toNode", "toSide", "fromEnd", "toEnd", "color", "label"];

function ordered(o: Obj, order: readonly string[]): Obj {
	const out: Obj = {};
	for (const k of order) if (o[k] !== undefined) out[k] = o[k]!;
	for (const k of Object.keys(o)) if (!(k in out)) out[k] = o[k]!;
	return out;
}

/** Obsidian's save: its key order, unknown fields kept after its own, tab indentation, no trailing newline. */
export function obsidianText(m: CanvasModel): string {
	const nodes = m.nodes.map((n) => ordered(n, NODE_KEY_ORDER[fieldText(n.type)] ?? NODE_KEY_ORDER.text!));
	const edges = m.edges.map((e) => ordered(e, EDGE_KEY_ORDER));
	return JSON.stringify({ nodes, edges, ...m.root }, null, "\t");
}

function shuffled(v: JsonValue, r: SeededRandom): JsonValue {
	if (Array.isArray(v)) return v.map((x) => shuffled(x, r));
	if (!isObj(v)) return v;
	const out: Obj = {};
	for (const k of r.shuffle(Object.keys(v))) out[k] = shuffled(v[k]!, r);
	return out;
}

/** Another program's whole-file write: every object's keys shuffled, other indentation, maybe CRLF / newline / BOM. */
export function externalText(m: CanvasModel, r: SeededRandom): string {
	const doc = shuffled({ ...m.root, nodes: m.nodes, edges: m.edges }, r);
	const indent = r.pick(["  ", "    ", "\t", ""]);
	let s = indent === "" ? JSON.stringify(doc) : JSON.stringify(doc, null, indent);
	const crlf = r.chance(0.3);
	if (crlf) s = s.replace(/\n/g, "\r\n");
	if (r.chance(0.5)) s += crlf ? "\r\n" : "\n";
	if (r.chance(0.1)) s = `\uFEFF${s}`;
	return s;
}

// ---------------------------------------------------------------------------
// Actions
// ---------------------------------------------------------------------------

export type BrokenKind = "truncate" | "garbage" | "dangling" | "dupId" | "badType" | "badNumber" | "notObject";

export type CanvasAction =
	| { readonly t: "cCreate"; readonly dev: number; readonly name: number; readonly nodes: number; readonly seed: number }
	| { readonly t: "cAddNode"; readonly dev: number; readonly file: number; readonly kind: NodeType; readonly seed: number }
	| { readonly t: "cMove"; readonly dev: number; readonly file: number; readonly node: number }
	| { readonly t: "cResize"; readonly dev: number; readonly file: number; readonly node: number }
	| { readonly t: "cColor"; readonly dev: number; readonly file: number; readonly node: number; readonly clear: boolean }
	| { readonly t: "cText"; readonly dev: number; readonly file: number; readonly node: number; readonly pos: number; readonly del: boolean }
	| { readonly t: "cProps"; readonly dev: number; readonly file: number; readonly node: number }
	| { readonly t: "cDeleteNode"; readonly dev: number; readonly file: number; readonly node: number }
	| { readonly t: "cAddEdge"; readonly dev: number; readonly file: number; readonly from: number; readonly to: number; readonly seed: number }
	| { readonly t: "cDeleteEdge"; readonly dev: number; readonly file: number; readonly edge: number }
	| { readonly t: "cEdge"; readonly dev: number; readonly file: number; readonly edge: number; readonly what: "rewire" | "sides" | "label" | "color"; readonly pick: number }
	| { readonly t: "cReorder"; readonly dev: number; readonly file: number; readonly node: number; readonly front: boolean }
	| { readonly t: "cExtra"; readonly dev: number; readonly file: number; readonly target: "root" | "node" | "edge"; readonly pick: number; readonly key: number; readonly del: boolean }
	| { readonly t: "cFileRef"; readonly dev: number; readonly file: number; readonly node: number; readonly pick: number }
	| { readonly t: "cRename"; readonly dev: number; readonly file: number; readonly name: number; readonly folder: boolean }
	| { readonly t: "cDelete"; readonly dev: number; readonly file: number }
	| { readonly t: "cRewrite"; readonly dev: number; readonly file: number; readonly seed: number; readonly move: boolean; readonly sort: boolean; readonly by: Writer }
	| { readonly t: "cBroken"; readonly dev: number; readonly file: number; readonly kind: BrokenKind; readonly seed: number; readonly fixMs: number; readonly by: Writer }
	| { readonly t: "cBig"; readonly dev: number; readonly name: number; readonly count: number; readonly seed: number };

export type CanvasWeights = Readonly<Record<CanvasAction["t"], number>>;

/** The default mix: edits of every node type and of edges, structure, files, formatting and broken saves. */
export const CANVAS_OPS: CanvasWeights = {
	cCreate: 3, cAddNode: 10, cMove: 9, cResize: 4, cColor: 4, cText: 10, cProps: 3, cDeleteNode: 4, cAddEdge: 6, cDeleteEdge: 2,
	cEdge: 4, cReorder: 4, cExtra: 4, cFileRef: 2, cRename: 1.5, cDelete: 1, cRewrite: 3, cBroken: 2, cBig: 0.25,
};

/** "Two devices edit the same canvas offline": edits of existing records, few structural changes. */
export const CANVAS_HOT_OPS: CanvasWeights = {
	...CANVAS_OPS, cCreate: 0.6, cAddNode: 7, cMove: 12, cResize: 6, cColor: 6, cText: 12, cProps: 4, cDeleteNode: 3, cAddEdge: 4,
	cEdge: 6, cReorder: 5, cExtra: 5, cRename: 0.4, cDelete: 0.3, cRewrite: 3, cBroken: 1.5, cBig: 0,
};

export const CANVAS_NAME_POOL = 4;

function weighted<K extends string>(rng: SeededRandom, w: Readonly<Record<K, number>>): K {
	const keys = (Object.keys(w) as K[]).filter((k) => w[k] > 0);
	let x = rng.float() * keys.reduce((s, k) => s + w[k], 0);
	for (const k of keys) {
		x -= w[k];
		if (x < 0) return k;
	}
	return keys[keys.length - 1] as K;
}

export function generateCanvasAction(rng: SeededRandom, devices: number, weights: CanvasWeights, pool = CANVAS_NAME_POOL): CanvasAction {
	const dev = rng.int(devices);
	const f = () => rng.float();
	const by: Writer = rng.chance(0.5) ? "user" : "external";
	switch (weighted(rng, weights)) {
		case "cCreate": return { t: "cCreate", dev, name: rng.int(pool), nodes: rng.chance(0.3) ? 0 : rng.range(1, 8), seed: rng.int(0x7fffffff) };
		case "cAddNode": return { t: "cAddNode", dev, file: f(), kind: rng.weighted([["text", 5], ["file", 2], ["link", 1], ["group", 1]] as const), seed: rng.int(0x7fffffff) };
		case "cMove": return { t: "cMove", dev, file: f(), node: f() };
		case "cResize": return { t: "cResize", dev, file: f(), node: f() };
		case "cColor": return { t: "cColor", dev, file: f(), node: f(), clear: rng.chance(0.2) };
		case "cText": return { t: "cText", dev, file: f(), node: f(), pos: f(), del: rng.chance(0.25) };
		case "cProps": return { t: "cProps", dev, file: f(), node: f() };
		case "cDeleteNode": return { t: "cDeleteNode", dev, file: f(), node: f() };
		case "cAddEdge": return { t: "cAddEdge", dev, file: f(), from: f(), to: f(), seed: rng.int(0x7fffffff) };
		case "cDeleteEdge": return { t: "cDeleteEdge", dev, file: f(), edge: f() };
		case "cEdge": return { t: "cEdge", dev, file: f(), edge: f(), what: rng.pick(["rewire", "sides", "label", "color"] as const), pick: f() };
		case "cReorder": return { t: "cReorder", dev, file: f(), node: f(), front: rng.chance(0.6) };
		case "cExtra": return { t: "cExtra", dev, file: f(), target: rng.pick(["root", "node", "node", "edge"] as const), pick: f(), key: rng.int(4), del: rng.chance(0.15) };
		case "cFileRef": return { t: "cFileRef", dev, file: f(), node: f(), pick: f() };
		case "cRename": return { t: "cRename", dev, file: f(), name: rng.int(pool + 2), folder: rng.chance(0.3) };
		case "cDelete": return { t: "cDelete", dev, file: f() };
		case "cRewrite": return { t: "cRewrite", dev, file: f(), seed: rng.int(0x7fffffff), move: rng.chance(0.4), sort: rng.chance(0.1), by };
		case "cBroken": return {
			t: "cBroken", dev, file: f(), seed: rng.int(0x7fffffff), by,
			kind: rng.weighted([["truncate", 5], ["garbage", 1], ["dangling", 2], ["dupId", 1], ["badType", 1], ["badNumber", 1], ["notObject", 1]] as const),
			fixMs: rng.chance(0.2) ? 0 : rng.range(50, 25_000),
		};
		case "cBig": return { t: "cBig", dev, name: rng.int(2), count: rng.range(150, 1_200), seed: rng.int(0x7fffffff) };
	}
}

// ---------------------------------------------------------------------------
// Oracle
// ---------------------------------------------------------------------------

/** The value of a field that is not there. */
export const ABSENT = "\u0000absent";

/** Fields whose written values are unique in the run (the saw-chain oracle). */
const TRACKED_NODE = new Set(["x", "y", "width", "height", "color", "label", "url", "subpath", "background"]);
const TRACKED_EDGE = new Set(["color", "label"]);
/** Unknown-field keys the actions write (at the top level, on nodes and on edges). */
export const EXTRA_KEYS = ["styleAttributes", "simMeta", "x-plugin", "tags"] as const;
export const ROOT_KEYS = ["metadata", "simRoot", "x-version", "viewport"] as const;
/**
 * A root key every canvas the sim creates carries, never edited: the canvas's lineage. A root has no id, so this is
 * what tells one canvas's root from another's; conflict copies and wiped-and-re-onboarded files keep it, a canvas
 * re-created at the same path gets a new one. Unknown to Obsidian and YAOS like any other root key.
 */
export const LINEAGE_KEY = "simCanvas";

export function isTracked(rec: string, field: string): boolean {
	if (rec === "root") return true;
	if ((EXTRA_KEYS as readonly string[]).includes(field)) return true;
	return rec.startsWith("n:") ? TRACKED_NODE.has(field) : TRACKED_EDGE.has(field);
}

export interface FieldWrite {
	readonly rec: string;
	readonly field: string;
	/** canonicalJson of the value, or ABSENT for a removal. */
	readonly value: string;
	/** What the file held before (ABSENT: no such field; null: the record was new). */
	readonly saw: string | null;
	readonly dev: string;
	readonly step: number;
	readonly path: string;
	readonly atMs: number;
	/** Root fields: the canvas's lineage (LINEAGE_KEY) when written, null when it has none (an empty canvas's). */
	readonly lineage?: string | null;
	/**
	 * Root fields: the doc the file was synced as when written (docIdOf; null: not synced yet). Another device's
	 * rewrite of the whole canvas merged into the same doc replaces its lineage, and the write is still in that doc.
	 */
	readonly doc?: string | null;
}

export interface RecordDelete {
	readonly dev: string;
	readonly step: number;
	readonly atMs: number;
	/** "record": the user deleted the node / edge; "file": with its canvas file; "lost-file": the file was deleted when it held no other copy. */
	readonly how: "record" | "file";
	/** Field values on the file the delete was made on (tracked and untracked), and the text. */
	readonly saw: ReadonlyMap<string, string>;
	/** The doc the file was synced as on the deleting device (null: not synced yet). */
	readonly doc: string | null;
}

export interface RecordInfo {
	readonly key: string;
	readonly created: { readonly dev: string; readonly step: number; readonly path: string };
	deleted: RecordDelete | null;
	/** Edges: every node id it ever pointed at. */
	readonly endpoints: Set<string>;
	/** Every write of every field (also untracked ones and text edits), for the delete rule. */
	readonly touches: { readonly dev: string; readonly field: string; readonly value: string; readonly step: number; readonly atMs: number }[];
	/** Tokens ever typed into a text node's text. */
	readonly tokens: Set<string>;
}

export interface ReorderIntent {
	readonly dev: string;
	readonly step: number;
	readonly atMs: number;
	readonly node: string;
	readonly front: boolean;
	/** Node ids on the canvas when it was made. */
	readonly siblings: readonly string[];
	/** The doc the file was synced as on that device (null: not synced yet). */
	readonly doc: string | null;
}

export interface CanvasStats {
	actions: number;
	skipped: number;
	byType: Record<string, number>;
	creates: number;
	broken: number;
	fixes: number;
	/** Broken saves whose file the user deleted before they completed. */
	abandoned: number;
	rewrites: number;
	linkUpdates: number;
	bigNodes: number;
}

function key(v: JsonValue): string {
	return canonicalJson(v);
}

export class CanvasOracle {
	private counter = 0;
	/** rec|field|value -> write (tracked fields; values are unique, removals excluded). */
	readonly writes = new Map<string, FieldWrite>();
	/** rec|field -> removals. */
	readonly removals = new Map<string, FieldWrite[]>();
	readonly records = new Map<string, RecordInfo>();
	readonly reorders: ReorderIntent[] = [];
	/** Field values the user threw away with a conflict copy they deleted (rec|field|value). */
	readonly discarded = new Set<string>();
	/**
	 * Removals the user threw away with a conflict copy they deleted: the copy's maker's removals of a field the copy's
	 * record lacks, made before the copy. By write, not rec|field|value: another device's removal of the field is not
	 * the copy's.
	 */
	readonly discardedRemovals = new Set<FieldWrite>();
	/** Nodes / edges some external program sorted (no order intent holds for them afterwards). */
	readonly sorted = new Set<string>();
	/** IDB wipes that dropped the mirrors (device, time): the device's unsent ops are gone, deletes included. */
	readonly wipes: { readonly dev: string; readonly atMs: number }[] = [];
	/**
	 * Records the user's copy of another device's vault over this one destroyed (clone fault): only the overwritten
	 * device held them, on disk and in its store, and its store goes with the copy (identity-per-store §4 "Clone").
	 */
	readonly copiedAway = new Set<string>();
	readonly stats: CanvasStats = { actions: 0, skipped: 0, byType: {}, creates: 0, broken: 0, fixes: 0, abandoned: 0, rewrites: 0, linkUpdates: 0, bigNodes: 0 };

	uniq(): number {
		return ++this.counter;
	}

	record(rec: string): RecordInfo | undefined {
		return this.records.get(rec);
	}

	created(rec: string, dev: string, step: number, path: string): RecordInfo {
		let r = this.records.get(rec);
		if (!r) {
			r = { key: rec, created: { dev, step, path }, deleted: null, endpoints: new Set(), touches: [], tokens: new Set() };
			this.records.set(rec, r);
		}
		return r;
	}

	write(w: FieldWrite): void {
		const r = this.records.get(w.rec);
		r?.touches.push({ dev: w.dev, field: w.field, value: w.value, step: w.step, atMs: w.atMs });
		if (!isTracked(w.rec, w.field)) return;
		if (w.value === ABSENT) {
			const k = `${w.rec}|${w.field}`;
			this.removals.set(k, [...(this.removals.get(k) ?? []), w]);
		} else this.writes.set(`${w.rec}|${w.field}|${w.value}`, w);
	}

	wiped(dev: string, atMs: number): void {
		this.wipes.push({ dev, atMs });
	}

	deleted(rec: string, d: RecordDelete): void {
		const r = this.records.get(rec);
		if (r && !r.deleted) r.deleted = d;
	}

	/** The values a write's saw-chain passes through (not its own): every write it causally follows on that field. */
	ancestors(w: FieldWrite): Set<string> {
		const out = new Set<string>();
		let saw = w.saw;
		while (saw !== null && !out.has(saw)) {
			out.add(saw);
			if (saw === ABSENT) break;
			saw = this.writes.get(`${w.rec}|${w.field}|${saw}`)?.saw ?? null;
		}
		return out;
	}
}

// ---------------------------------------------------------------------------
// The world: runs actions, keeps pending fixes
// ---------------------------------------------------------------------------

export interface CanvasActorWorld {
	readonly devs: readonly SimDevice[];
	readonly ledger: TokenLedger;
	isDown(dev: number): boolean;
	isBackground(dev: number): boolean;
}

interface PendingFix {
	readonly id: number;
	readonly dev: number;
	readonly path: string;
	readonly broken: string;
	readonly full: string;
	/** The file before the broken write (what the app still shows while it cannot load the file). */
	readonly before: string;
	readonly by: Writer;
	/** Records the intents of the completed save in the oracle. */
	readonly commit: () => void;
	timer: ReturnType<VirtualClock["setTimer"]> | null;
}

export function lineageOf(root: Readonly<Record<string, unknown>>): string | null {
	const v = root[LINEAGE_KEY];
	return typeof v === "string" ? v : null;
}

/**
 * Suffixed duplicates on `d`: "X (n).canvas" holding the lineage of "X.canvas" (conflict copies aside). The loser
 * rename of a device's own re-create leaves one; after an epoch migration the re-create merges instead (§c.12).
 */
export function suffixedDuplicates(d: SimDevice): string[] {
	const out: string[] = [];
	for (const path of canvasFiles(d)) {
		const m = / \(\d+\)\.canvas$/.exec(path);
		if (!m || isConflictCopy(path)) continue;
		const orig = path.slice(0, m.index) + ".canvas";
		const a = readModel(d.vault.textOf(path) ?? "");
		const b = readModel(d.vault.textOf(orig) ?? "");
		const lin = a ? lineageOf(a.root) : null;
		if (lin !== null && b && lineageOf(b.root) === lin) out.push(`${path} (lineage of ${orig})`);
	}
	return out;
}

export function isConflictCopy(path: string): boolean {
	return path.includes(" (conflict");
}

export function canvasFiles(d: SimDevice): string[] {
	return d.vault.visiblePaths().filter((p) => p.endsWith(".canvas")).sort();
}

/** Canvases the user edits: not conflict copies (their records share ids with the canvas they copy). */
function editableCanvases(d: SimDevice): string[] {
	return canvasFiles(d).filter((p) => !isConflictCopy(p));
}

function pickOf<T>(items: readonly T[], pick: number): T | undefined {
	return items.length === 0 ? undefined : items[Math.min(items.length - 1, Math.floor(pick * items.length))];
}

/**
 * The doc a file is synced as on a device, null if none: its synced record at the path, else the engine's remote view
 * of the path. The synced record first: a re-create that lost the path race after an epoch reset is still the file's
 * doc while its loser rename waits, though the view maps the path to the winner (3 devices seed 48: A's offline
 * reorder went into its loser, which other devices had edited and so kept as "c0 (2).canvas").
 */
export function docIdOf(d: SimDevice, path: string): string | null {
	const key = pathKey(path);
	for (const s of d.vrt?.rec?.ctx.store.synced.values() ?? []) if (s.pathKey === key && !s.fileGone) return s.docId;
	return d.vrt?.port.view().remoteByPathKey.get(key) ?? null;
}

/** Text of the engine's resident canvas replica at `path` as it would project (null: not resident / invalid). */
export function engineCanvasText(d: SimDevice, path: string): string | null {
	const rt = d.vrt;
	if (!rt) return null;
	const id = rt.port.view().remoteByPathKey.get(pathKey(path));
	if (!id) return null;
	const h = rt.log.c.handles.peek(rt.log.streamOf(id));
	if (!h) return null;
	const p = projectCanvasBytes(h.doc);
	return p.ok ? p.text : null;
}

export interface CanvasOptions {
	/** Bias record picks to the first few records (concurrent edits of the same nodes). */
	readonly hot?: boolean;
	/** Trace lines for what happens between steps (broken saves completing or abandoned). */
	readonly trace?: (line: string) => void;
}

export class CanvasWorld {
	readonly oracle = new CanvasOracle();
	private readonly fixes = new Map<number, PendingFix>();
	private fixIds = 0;

	constructor(private readonly w: CanvasActorWorld, private readonly clock: VirtualClock, private readonly opts: CanvasOptions = {}) {}

	private recPick(pick: number): number {
		return this.opts.hot ? pick ** 3 : pick;
	}

	/** Apply one canvas action; returns a trace line ("skip ..." when inapplicable). */
	async run(a: CanvasAction, step: number): Promise<string> {
		const d = this.w.devs[a.dev];
		if (!d) return `skip ${a.t}: no device ${a.dev}`;
		const tag = `${d.name} ${a.t}`;
		const external = (a.t === "cRewrite" || a.t === "cBroken") && a.by === "external";
		const s = this.oracle.stats;
		if (this.w.isDown(a.dev)) return this.skip(`skip ${tag}: app down`);
		if (!external && this.w.isBackground(a.dev)) return this.skip(`skip ${tag}: app in background`);
		const line = this.apply(d, a, step, tag);
		if (line.startsWith("skip")) s.skipped++;
		else {
			s.actions++;
			s.byType[a.t] = (s.byType[a.t] ?? 0) + 1;
		}
		return line;
	}

	private skip(line: string): string {
		this.oracle.stats.skipped++;
		return line;
	}

	private apply(d: SimDevice, a: CanvasAction, step: number, tag: string): string {
		switch (a.t) {
			case "cCreate": return this.create(d, a, step, tag);
			case "cBig": return this.big(d, a, step, tag);
			case "cRename": {
				const path = pickOf(editableCanvases(d), a.file);
				const to = `${a.folder ? "boards" : "canvas"}/c${a.name}.canvas`;
				if (!path || !d.vault.userRename(path, to)) return `skip ${tag}`;
				return `${tag} ${path} -> ${to}`;
			}
			case "cDelete": return this.deleteFile(d, a, step, tag);
			case "cBroken": return this.broken(d, a, step, tag);
			default: return this.edit(d, a, step, tag);
		}
	}

	// --- helpers -------------------------------------------------------------

	private nodeIdOf(d: SimDevice, step: number, i: number): string {
		return `${d.name.toLowerCase()}${step.toString(16)}n${i}`;
	}

	private edgeIdOf(d: SimDevice, step: number, i: number): string {
		return `${d.name.toLowerCase()}${step.toString(16)}e${i}`;
	}

	/** A fresh node of `kind` with unique tracked values (and a token in a text node's text). */
	private newNode(d: SimDevice, step: number, i: number, kind: NodeType, r: SeededRandom, files: readonly string[], token: boolean): Obj {
		const u = () => this.oracle.uniq();
		const id = this.nodeIdOf(d, step, i);
		const n: Obj = { id, type: kind, x: u(), y: -u(), width: 100 + u(), height: 40 + u() };
		if (r.chance(0.3)) n.color = `#${u().toString(16).padStart(6, "0")}`;
		switch (kind) {
			case "text": {
				const t = token ? `[${d.name}.${step}${i > 0 ? `.${i}` : ""}]` : `note ${id}`;
				n.text = r.chance(0.3) ? `# ${t}\n\nline two` : t;
				break;
			}
			case "file":
				n.file = files.length > 0 ? r.pick(files) : "notes/missing.md";
				if (r.chance(0.3)) n.subpath = `#h${u()}`;
				break;
			case "link":
				n.url = `https://example.com/${u()}`;
				break;
			case "group":
				if (r.chance(0.7)) n.label = `G${u()}`;
				if (r.chance(0.2)) {
					n.background = `att/bg${u()}.png`;
					n.backgroundStyle = r.pick(["cover", "ratio", "repeat"]);
				}
				break;
		}
		if (r.chance(0.15)) n[r.pick(EXTRA_KEYS)] = { v: `u${u()}`, list: [u(), "x"] };
		return n;
	}

	private registerNew(rec: string, o: Obj, d: SimDevice, step: number, path: string): void {
		const info = this.oracle.created(rec, d.name, step, path);
		for (const f of Object.keys(o)) {
			if (f === "id") continue;
			if (f === "text") {
				for (const t of tokensIn(fieldText(o.text))) {
					info.tokens.add(t);
					this.w.ledger.add(t, d.name, step, "canvas-text");
				}
				continue;
			}
			this.oracle.write({ rec, field: f, value: key(o[f]!), saw: null, dev: d.name, step, path, atMs: this.clock.now() });
		}
		if (rec.startsWith("e:")) {
			info.endpoints.add(fieldText(o.fromNode));
			info.endpoints.add(fieldText(o.toNode));
		}
	}

	private notes(d: SimDevice): string[] {
		return d.vault.visiblePaths().filter((p) => p.endsWith(".md") || p.endsWith(".png")).sort();
	}

	private write(d: SimDevice, path: string, text: string, by: Writer): void {
		if (by === "user") d.vault.userWrite(path, text);
		else d.vault.externalWrite(path, text);
	}

	// --- create --------------------------------------------------------------

	private create(d: SimDevice, a: Extract<CanvasAction, { t: "cCreate" }>, step: number, tag: string): string {
		const path = `canvas/c${a.name}.canvas`;
		if (d.vault.hasFile(path)) return `skip ${tag}: ${path} exists`;
		this.oracle.stats.creates++;
		if (a.nodes === 0) {
			// Obsidian's "New canvas": an empty file, filled by the first save.
			d.vault.userWrite(path, "");
			return `${tag} ${path} empty`;
		}
		const r = new SeededRandom(a.seed);
		const files = this.notes(d);
		const m: CanvasModel = { root: {}, nodes: [], edges: [] };
		for (let i = 0; i < a.nodes; i++) m.nodes.push(this.newNode(d, step, i, r.weighted([["text", 5], ["file", 2], ["link", 1], ["group", 1]] as const), r, files, true));
		const edges = a.nodes > 1 ? r.int(a.nodes) : 0;
		for (let i = 0; i < edges; i++) {
			const from = r.pick(m.nodes).id as string;
			const to = r.pick(m.nodes).id as string;
			m.edges.push({ id: this.edgeIdOf(d, step, i), fromNode: from, fromSide: r.pick(SIDES), toNode: to, toSide: r.pick(SIDES) });
		}
		if (r.chance(0.3)) m.root[r.pick(ROOT_KEYS)] = { v: `r${this.oracle.uniq()}` };
		const lineage = `L${this.oracle.uniq()}`;
		m.root[LINEAGE_KEY] = lineage;
		for (const n of m.nodes) this.registerNew(`n:${n.id as string}`, n, d, step, path);
		for (const e of m.edges) this.registerNew(`e:${e.id as string}`, e, d, step, path);
		for (const k of Object.keys(m.root)) {
			if (k !== LINEAGE_KEY) this.oracle.write({ rec: "root", field: k, value: key(m.root[k]!), saw: ABSENT, dev: d.name, step, path, atMs: this.clock.now(), lineage });
		}
		d.vault.userWrite(path, obsidianText(m));
		return `${tag} ${path} ${m.nodes.length} nodes ${m.edges.length} edges`;
	}

	private big(d: SimDevice, a: Extract<CanvasAction, { t: "cBig" }>, step: number, tag: string): string {
		const path = `canvas/big${a.name}.canvas`;
		const cur = d.vault.textOf(path);
		const m: CanvasModel | null = cur === null ? { root: { [LINEAGE_KEY]: `L${this.oracle.uniq()}` }, nodes: [], edges: [] } : readModel(cur);
		if (!m) return `skip ${tag}: ${path} unreadable`;
		if (m.nodes.length > 1_500) return `skip ${tag}: ${path} already big`;
		const r = new SeededRandom(a.seed);
		const files = this.notes(d);
		const fresh: Obj[] = [];
		for (let i = 0; i < a.count; i++) fresh.push(this.newNode(d, step, i, r.weighted([["text", 6], ["file", 2], ["link", 1], ["group", 1]] as const), r, files, i % 50 === 0));
		const all = [...m.nodes, ...fresh];
		const edges: Obj[] = [];
		for (let i = 0; i < Math.floor(a.count / 2); i++) {
			edges.push({ id: this.edgeIdOf(d, step, i), fromNode: r.pick(all).id as string, fromSide: r.pick(SIDES), toNode: r.pick(all).id as string, toSide: r.pick(SIDES) });
		}
		m.nodes.push(...fresh);
		m.edges.push(...edges);
		for (const n of fresh) this.registerNew(`n:${n.id as string}`, n, d, step, path);
		for (const e of edges) this.registerNew(`e:${e.id as string}`, e, d, step, path);
		this.oracle.stats.bigNodes += fresh.length;
		if (cur === null) this.oracle.stats.creates++;
		d.vault.userWrite(path, obsidianText(m));
		return `${tag} ${path} +${fresh.length} nodes +${edges.length} edges (${m.nodes.length} total)`;
	}

	// --- delete --------------------------------------------------------------

	private fieldsOf(o: Obj): Map<string, string> {
		const out = new Map<string, string>();
		for (const k of Object.keys(o)) if (k !== "id") out.set(k, k === "text" ? fieldText(o.text) : key(o[k]!));
		return out;
	}

	/** The device a conflict copy was first written on (its maker) and when, from the vaults' histories. */
	private copyBorn(path: string): { readonly dev: string; readonly atMs: number } | null {
		let born: { dev: string; atMs: number } | null = null;
		for (const dv of this.w.devs) {
			const v = dv.vault.history.find((x) => x.path === path);
			if (v && (!born || v.atMs < born.atMs)) born = { dev: dv.name, atMs: v.atMs };
		}
		return born;
	}

	private deleteFile(d: SimDevice, a: Extract<CanvasAction, { t: "cDelete" }>, step: number, tag: string): string {
		const path = pickOf(canvasFiles(d), a.file);
		const cur = path ? d.vault.textOf(path) : null;
		if (!path || cur === null) return `skip ${tag}: no canvas`;
		// The user deletes what they see: the file, what the engine had integrated (nsDelete's baseBodySeq) and, while
		// a save is half-written, the canvas their app still shows: the one before the broken write, or their own save
		// (fault-heavy seed 122, hot seed 163: a broken file deleted before its save completed; its records were
		// never marked deleted). The save follows the broken bytes (complete()): a rename since moves it with them
		// (suite-1 seed 1542948623: broken, renamed, deleted; the records were counted as lost).
		const showing = [...this.fixes.values()].filter((f) => f.dev === a.dev && (f.path === path || noBom(f.broken) === cur)).flatMap((f) => [f.before, f.full]);
		const seen = [cur, engineCanvasText(d, path) ?? "", ...showing];
		for (const text of seen) for (const t of tokensIn(text)) this.w.ledger.deleted(t);
		const atMs = this.clock.now();
		if (isConflictCopy(path)) {
			// Throwing a conflict copy away discards its values; records only in it go with it.
			const others = new Set<string>();
			const held = new Set<string>();
			for (const p of canvasFiles(d)) {
				if (p === path) continue;
				const m = readModel(d.vault.textOf(p) ?? "");
				for (const [kind, list] of [["n", m?.nodes ?? []], ["e", m?.edges ?? []]] as const) {
					for (const o of list) {
						const rec = `${kind}:${o.id as string}`;
						others.add(rec);
						for (const [f, v] of this.fieldsOf(o)) held.add(`${rec}|${f}|${v}`);
					}
				}
			}
			// With a copy's value go the values its writer's own earlier writes of the field had in the same file,
			// which that value replaced there, unless another canvas still holds them (hot canvas seed 570: a no-base
			// merge put A's two successive colours into a conflict copy, the user deleted it, the first colour was
			// counted as lost).
			// A removal in that chain goes too, and the chain goes on through what it removed (hot canvas seed 211:
			// offline B set a colour, cleared it, set another; the copy held the last, the user deleted it, and the
			// clear and the first colour were counted as lost).
			const discard = (rec: string, f: string, v: string): void => {
				this.oracle.discarded.add(`${rec}|${f}|${v}`);
				const w = this.oracle.writes.get(`${rec}|${f}|${v}`);
				for (let cur = w; cur && cur.saw !== null; ) {
					if (cur.saw === ABSENT) {
						const at = cur.atMs;
						const rms = (this.oracle.removals.get(`${rec}|${f}`) ?? []).filter((r) => r.dev === w!.dev && r.path === w!.path && r.atMs <= at && r !== cur);
						const rm = rms[rms.length - 1];
						if (!rm || this.oracle.discardedRemovals.has(rm)) break;
						this.oracle.discardedRemovals.add(rm);
						cur = rm;
						continue;
					}
					const prev = this.oracle.writes.get(`${rec}|${f}|${cur.saw}`);
					const k = `${rec}|${f}|${cur.saw}`;
					if (!prev || prev.dev !== w!.dev || prev.path !== w!.path || held.has(k) || this.oracle.discarded.has(k)) break;
					this.oracle.discarded.add(k);
					cur = prev;
				}
			};
			// The copy holds its maker's disk bytes when it was made: a tracked field its record lacks is the maker's
			// removal, thrown away with it (suite-1 seed 15, 4 devices: D cleared a colour on a canvas it had not read
			// yet, the record moved meanwhile, the merge conflicted and kept the colour, B deleted the copy).
			const born = this.copyBorn(path);
			const discardRemovals = (rec: string, o: Obj): void => {
				if (!born) return;
				for (const [k, list] of this.oracle.removals) {
					if (!k.startsWith(`${rec}|`) || o[k.slice(rec.length + 1)] !== undefined) continue;
					for (const r of list) if (r.dev === born.dev && r.atMs <= born.atMs) this.oracle.discardedRemovals.add(r);
				}
			};
			for (const text of seen) {
				const m = readModel(text);
				if (!m) continue;
				for (const [kind, list] of [["n", m.nodes], ["e", m.edges]] as const) {
					for (const o of list) {
						const rec = `${kind}:${o.id as string}`;
						for (const [f, v] of this.fieldsOf(o)) discard(rec, f, v);
						discardRemovals(rec, o);
						if (!others.has(rec)) this.oracle.deleted(rec, { dev: d.name, step, atMs, how: "file", saw: this.fieldsOf(o), doc: docIdOf(d, path) });
					}
				}
				for (const k of Object.keys(m.root)) this.oracle.discarded.add(`root|${k}|${key(m.root[k]!)}`);
			}
		} else {
			// A record this device deleted on disk while it was behind on the canvas's stream (skipped rows not read
			// yet) is not in its CRDT: the merge waits for the read (DESIGN I4, §f.3). Deleting the file before the read
			// deletes what the engine holds; an unseen edit then restores that, the record with it (3 devices seed 21:
			// A deleted an edge, then the canvas, while its reads failed). The record delete goes with the file.
			const doc = docIdOf(d, path);
			const body = doc === null ? null : d.vrt?.port.view().remote.get(doc as DocId)?.body ?? null;
			const held = body?.caughtUp === false ? readModel(engineCanvasText(d, path) ?? "") : null;
			for (const o of held ? [...held.nodes.map((n) => `n:${n.id as string}`), ...held.edges.map((e) => `e:${e.id as string}`)] : []) {
				const r = this.oracle.record(o);
				if (r?.deleted?.how === "record" && r.deleted.dev === d.name && r.deleted.doc === doc) r.deleted = { ...r.deleted, how: "file" };
			}
			for (const text of seen) {
				const m = readModel(text);
				for (const n of m?.nodes ?? []) this.oracle.deleted(`n:${n.id as string}`, { dev: d.name, step, atMs, how: "file", saw: this.fieldsOf(n), doc: docIdOf(d, path) });
				for (const e of m?.edges ?? []) this.oracle.deleted(`e:${e.id as string}`, { dev: d.name, step, atMs, how: "file", saw: this.fieldsOf(e), doc: docIdOf(d, path) });
				// The root goes with the file: its values and the ones they replaced (hot seed 97: a canvas deleted and
				// re-created at its path, the new one merged into the doc; the old root's writes have no holder).
				for (const k of Object.keys(m?.root ?? {})) {
					const v = key(m!.root[k]!);
					this.oracle.discarded.add(`root|${k}|${v}`);
					const w = this.oracle.writes.get(`root|${k}|${v}`);
					if (w) for (const a of this.oracle.ancestors(w)) this.oracle.discarded.add(`root|${k}|${a}`);
				}
				// And the root fields the file lacks because a user removed them in it: the removals go with the file too
				// (hot canvas seed 89: A removed a root field, renamed and deleted the canvas; B's own copy of the vault,
				// never synced before, came back as a new doc of the same lineage still holding the field).
				if (m) {
					const lin = lineageOf(m.root);
					const doc = docIdOf(d, path);
					for (const [k, list] of this.oracle.removals) {
						if (!k.startsWith("root|") || m.root[k.slice(5)] !== undefined) continue;
						for (const r of list) if (r.atMs <= atMs && ((lin !== null && r.lineage === lin) || (doc !== null && r.doc === doc))) this.oracle.discardedRemovals.add(r);
					}
				}
			}
		}
		d.vault.userDelete(path);
		return `${tag} ${path}`;
	}

	// --- broken saves --------------------------------------------------------

	private broken(d: SimDevice, a: Extract<CanvasAction, { t: "cBroken" }>, step: number, tag: string): string {
		const path = pickOf(editableCanvases(d), a.file);
		const cur = path ? d.vault.textOf(path) : null;
		const m = cur !== null ? readModel(cur) : null;
		if (!path || !m) return `skip ${tag}: no readable canvas`;
		if ([...this.fixes.values()].some((f) => f.dev === a.dev && f.path === path)) return `skip ${tag}: ${path} already broken`;
		const r = new SeededRandom(a.seed);
		// The save being made: a move of one node (or nothing on an empty canvas), committed when the save completes.
		const target = m.nodes.length > 0 ? r.pick(m.nodes) : null;
		const intents: (() => void)[] = [];
		if (target) {
			const rec = `n:${target.id as string}`;
			for (const field of ["x", "y"] as const) {
				const v = field === "x" ? this.oracle.uniq() : -this.oracle.uniq();
				const saw = target[field] === undefined ? ABSENT : key(target[field]);
				target[field] = v;
				intents.push(() => this.oracle.write({ rec, field, value: key(v), saw, dev: d.name, step, path, atMs: this.clock.now() }));
			}
		}
		let full = a.by === "user" ? obsidianText(m) : externalText(m, r);
		let brokenText: string;
		const commit = [...intents];
		switch (a.kind) {
			case "truncate":
				// Never empty: an empty file is the valid empty canvas (Obsidian's new canvas), not a broken save.
				brokenText = full.slice(0, 1 + r.int(Math.max(1, full.length - 2)));
				if (canvasProblem(brokenText) === null) brokenText = `${full.slice(0, Math.max(1, Math.floor(full.length / 2)))}\u0000`;
				break;
			case "garbage":
				brokenText = `${full.slice(0, Math.floor(full.length / 3))}\u0000\u0000\u0007garbage`;
				break;
			case "notObject":
				brokenText = r.chance(0.5) ? "[]" : "null";
				break;
			case "dangling": {
				// An external tool removes a node and leaves its edges; Obsidian drops dangling edges when it saves.
				const victim = m.nodes.find((n) => m.edges.some((e) => e.fromNode === n.id || e.toNode === n.id));
				if (!victim) {
					brokenText = `${full}\n}`;
					break;
				}
				const vid = victim.id as string;
				const shown: CanvasModel = { root: m.root, nodes: m.nodes.filter((n) => n.id !== vid), edges: m.edges };
				brokenText = a.by === "user" ? obsidianText(shown) : externalText(shown, r);
				const gone = m.edges.filter((e) => e.fromNode === vid || e.toNode === vid);
				const fixed: CanvasModel = { root: m.root, nodes: shown.nodes, edges: m.edges.filter((e) => !gone.includes(e)) };
				full = a.by === "user" ? obsidianText(fixed) : externalText(fixed, r);
				const atMs = this.clock.now();
				commit.push(() => {
					this.deleteRecords(d, step, atMs, [victim], gone, path);
				});
				break;
			}
			case "dupId": {
				const dup = m.nodes.length > 0 ? { ...r.pick(m.nodes) } : { id: "dup", type: "text", text: "", x: 0, y: 0, width: 1, height: 1 };
				const shown: CanvasModel = { root: m.root, nodes: [...m.nodes, dup, ...(m.nodes.length > 0 ? [] : [dup])], edges: m.edges };
				brokenText = obsidianText(shown);
				break;
			}
			case "badType": {
				const shown: CanvasModel = { root: m.root, nodes: [...m.nodes, { id: `${this.nodeIdOf(d, step, 99)}`, type: "widget", x: 0, y: 0, width: 10, height: 10 }], edges: m.edges };
				brokenText = obsidianText(shown);
				break;
			}
			case "badNumber": {
				const shown: CanvasModel = { root: m.root, nodes: m.nodes.map((n, i) => (i === 0 ? { ...n, x: fieldText(n.x) } : n)), edges: m.edges };
				brokenText = m.nodes.length > 0 ? obsidianText(shown) : "{\"nodes\": [{\"id\": \"q\", \"type\": \"text\", \"text\": \"\", \"x\": \"1\", \"y\": 0, \"width\": 1, \"height\": 1}]}";
				break;
			}
		}
		this.oracle.stats.broken++;
		this.write(d, path, brokenText, a.by);
		const fix: PendingFix = { id: ++this.fixIds, dev: a.dev, path, broken: brokenText, full, before: cur!, by: a.by, commit: () => commit.forEach((c) => c()), timer: null };
		this.fixes.set(fix.id, fix);
		fix.timer = this.clock.setTimer(a.fixMs, () => this.complete(fix), "sim-canvas-fix");
		return `${tag}(${a.by}) ${path} ${a.kind} (${brokenText.length} of ${full.length} chars), fixed in ${a.fixMs}ms`;
	}

	/**
	 * The broken save completes where the broken bytes are now (a rename may have moved them). If they are gone (the
	 * user deleted the broken file) the save is abandoned: its view closed with the file, and writing the old content
	 * back would clobber whatever is at the path now.
	 */
	private complete(fix: PendingFix): void {
		if (!this.fixes.delete(fix.id)) return;
		if (fix.timer !== null) this.clock.clearTimer(fix.timer);
		const d = this.w.devs[fix.dev];
		if (!d) return;
		// The vault decodes text without a BOM (TextDecoder), as Obsidian does.
		const broken = noBom(fix.broken);
		let path: string | null = d.vault.textOf(fix.path) === broken ? fix.path : null;
		if (path === null) for (const [p, text] of d.vault.snapshot()) if (p.endsWith(".canvas") && text === broken) path = p;
		if (path === null) {
			this.oracle.stats.abandoned++;
			this.opts.trace?.(`canvas ${d.name} broken save of ${fix.path} abandoned (file gone)`);
			return;
		}
		this.oracle.stats.fixes++;
		this.opts.trace?.(`canvas ${d.name} broken save of ${fix.path} completed at ${path}`);
		fix.commit();
		this.write(d, path, fix.full, fix.by);
	}

	/** Heal: every broken save completes now. */
	heal(): void {
		for (const fix of [...this.fixes.values()]) this.complete(fix);
	}

	/**
	 * Before the checks: tokens typed into a node some user deleted are exempt from survival. Across devices a
	 * record delete wins over a concurrent edit of the record (DESIGN §j.2), so the text typed into it concurrently
	 * goes with it, as the node's other fields do.
	 */
	finalize(): void {
		for (const r of this.oracle.records.values()) if (r.deleted) for (const t of r.tokens) this.w.ledger.deleted(t);
	}

	private deleteRecords(d: SimDevice, step: number, atMs: number, nodes: readonly Obj[], edges: readonly Obj[], path: string): void {
		for (const n of nodes) {
			const rec = `n:${n.id as string}`;
			for (const t of tokensIn(typeof n.text === "string" ? n.text : "")) this.w.ledger.deleted(t);
			this.oracle.deleted(rec, { dev: d.name, step, atMs, how: "record", saw: this.fieldsOf(n), doc: docIdOf(d, path) });
		}
		for (const e of edges) this.oracle.deleted(`e:${e.id as string}`, { dev: d.name, step, atMs, how: "record", saw: this.fieldsOf(e), doc: docIdOf(d, path) });
	}

	// --- link updates (Obsidian's rename of a note) ----------------------------

	/** Obsidian renamed `from` to `to` on `d` (fileManager.renameFile): file nodes pointing at it follow. */
	/**
	 * Why device `i`'s vault cannot be copied now (clone fault), or null: a broken save still in progress there would
	 * be copied half-written, and only the source's writer completes it (the copy would stay invalid).
	 */
	midSave(i: number): string | null {
		const fix = [...this.fixes.values()].find((f) => f.dev === i);
		return fix ? `${fix.path} half-written on the source` : null;
	}

	/**
	 * The user copies another device's vault over `dst` (clone fault, before the copy): what only dst held, on disk or
	 * in its engine, goes with its disk and its store. Records no other device holds are copied away, dst's field
	 * writes and removals no other device shows are discarded, and its unsent deletes and reorders go as with a wipe.
	 */
	copiedOver(dst: SimDevice, others: readonly SimDevice[]): void {
		const recs = new Set<string>();
		const held = new Set<string>();
		for (const o of others) {
			for (const path of canvasFiles(o)) {
				for (const text of [o.vault.textOf(path) ?? "", engineCanvasText(o, path) ?? ""]) {
					const m = readModel(text);
					if (!m) continue;
					for (const k of Object.keys(m.root)) held.add(`root|${k}|${key(m.root[k]!)}`);
					for (const [kind, list] of [["n", m.nodes], ["e", m.edges]] as const) {
						for (const x of list) {
							const rec = `${kind}:${x.id as string}`;
							recs.add(rec);
							for (const [f, v] of this.fieldsOf(x)) held.add(`${rec}|${f}|${v}`);
							for (const [k, list2] of this.oracle.removals) {
								if (!k.startsWith(`${rec}|`) || x[k.slice(rec.length + 1)] !== undefined) continue;
								for (const r of list2) held.add(`removal|${k}|${r.atMs}|${r.dev}`);
							}
						}
					}
				}
			}
		}
		for (const r of this.oracle.records.values()) if (!r.deleted && !recs.has(r.key)) this.oracle.copiedAway.add(r.key);
		for (const [k, w] of this.oracle.writes) if (w.dev === dst.name && !held.has(k)) this.oracle.discarded.add(k);
		for (const [k, list] of this.oracle.removals) {
			for (const r of list) if (r.dev === dst.name && !held.has(`removal|${k}|${r.atMs}|${r.dev}`)) this.oracle.discardedRemovals.add(r);
		}
		this.oracle.wiped(dst.name, this.clock.now());
	}

	onUserRename(d: SimDevice, from: string, to: string, step: number): void {
		for (const path of editableCanvases(d)) {
			const cur = d.vault.textOf(path);
			const m = cur !== null ? readModel(cur) : null;
			if (!m || !m.nodes.some((n) => n.type === "file" && n.file === from)) continue;
			for (const n of m.nodes) {
				if (n.type !== "file" || n.file !== from) continue;
				this.oracle.write({ rec: `n:${n.id as string}`, field: "file", value: key(to), saw: key(from), dev: d.name, step, path, atMs: this.clock.now() });
				n.file = to;
			}
			this.oracle.stats.linkUpdates++;
			d.vault.userWrite(path, obsidianText(m));
		}
	}

	// --- edits -----------------------------------------------------------------

	private edit(d: SimDevice, a: Exclude<CanvasAction, { t: "cCreate" | "cBig" | "cRename" | "cDelete" | "cBroken" }>, step: number, tag: string): string {
		const path = pickOf(editableCanvases(d), a.file);
		const cur = path ? d.vault.textOf(path) : null;
		const m = cur !== null ? readModel(cur) : null;
		// No canvas yet on this device: the user makes the one they meant to edit.
		if (!path || cur === null) return this.create(d, { t: "cCreate", dev: a.dev, name: Math.floor(a.file * CANVAS_NAME_POOL), nodes: 3, seed: Math.floor(a.file * 0x7fffffff) }, step, `${tag}->cCreate`);
		if (!m) return `skip ${tag}: ${path} does not load`;
		const o = this.oracle;
		const set = (rec: string, obj: Obj, field: string, value: JsonValue | undefined) => {
			const saw = obj[field] === undefined ? ABSENT : key(obj[field]);
			if (value === undefined) delete obj[field];
			else obj[field] = value;
			o.write({ rec, field, value: value === undefined ? ABSENT : key(value), saw, dev: d.name, step, path, atMs: this.clock.now(), ...(rec === "root" ? { lineage: lineageOf(m.root), doc: docIdOf(d, path) } : {}) });
		};
		const node = (pick: number) => pickOf(m.nodes, this.recPick(pick));
		let what: string;
		let by: Writer = "user";
		let text: string | null = null;
		switch (a.t) {
			case "cAddNode": {
				const r = new SeededRandom(a.seed);
				const n = this.newNode(d, step, 0, a.kind, r, this.notes(d), true);
				m.nodes.push(n);
				this.registerNew(`n:${n.id as string}`, n, d, step, path);
				what = `+${a.kind} ${n.id as string}`;
				break;
			}
			case "cMove":
			case "cResize": {
				const n = node(a.node);
				if (!n) return `skip ${tag}: no node`;
				const rec = `n:${n.id as string}`;
				if (a.t === "cMove") {
					set(rec, n, "x", o.uniq());
					set(rec, n, "y", -o.uniq());
				} else {
					set(rec, n, "width", 100 + o.uniq());
					set(rec, n, "height", 40 + o.uniq());
				}
				what = `${n.id as string}`;
				break;
			}
			case "cColor": {
				const n = node(a.node);
				if (!n) return `skip ${tag}: no node`;
				if (a.clear && n.color === undefined) return `skip ${tag}: no color`;
				set(`n:${n.id as string}`, n, "color", a.clear ? undefined : `#${o.uniq().toString(16).padStart(6, "0")}`);
				what = `${n.id as string} ${a.clear ? "cleared" : fieldText(n.color)}`;
				break;
			}
			case "cText": {
				const texts = m.nodes.filter((n) => n.type === "text");
				const n = pickOf(texts, this.recPick(a.node));
				if (!n) return `skip ${tag}: no text node`;
				const rec = `n:${n.id as string}`;
				const t = fieldText(n.text);
				if (a.del) {
					const s = pickOf(tokenSpans(t), a.pos);
					if (!s) return `skip ${tag}: no token in ${n.id as string}`;
					n.text = t.slice(0, s.start) + t.slice(s.end);
					this.w.ledger.deleted(s.token);
					o.record(rec)?.touches.push({ dev: d.name, field: "text", value: `-${s.token}`, step, atMs: this.clock.now() });
					what = `${n.id as string} -${s.token}`;
				} else {
					const token = `[${d.name}.${step}]`;
					const pos = safePosition(t, a.pos);
					n.text = `${t.slice(0, pos)}${token} ${t.slice(pos)}`;
					this.w.ledger.add(token, d.name, step, "canvas-text");
					o.record(rec)?.tokens.add(token);
					o.record(rec)?.touches.push({ dev: d.name, field: "text", value: `+${token}`, step, atMs: this.clock.now() });
					what = `${n.id as string}@${pos} ${token}`;
				}
				break;
			}
			case "cProps": {
				const n = node(a.node);
				if (!n) return `skip ${tag}: no node`;
				const rec = `n:${n.id as string}`;
				const u = o.uniq();
				if (n.type === "group") set(rec, n, "label", `G${u}`);
				else if (n.type === "link") set(rec, n, "url", `https://example.com/${u}`);
				else if (n.type === "file") set(rec, n, "subpath", `#h${u}`);
				else set(rec, n, "color", String((u % 6) + 1) + `-${u}`);
				what = `${n.id as string} ${fieldText(n.type)}`;
				break;
			}
			case "cDeleteNode": {
				const n = node(a.node);
				if (!n) return `skip ${tag}: no node`;
				// Obsidian deletes the node's edges with it.
				const gone = m.edges.filter((e) => e.fromNode === n.id || e.toNode === n.id);
				m.nodes = m.nodes.filter((x) => x !== n);
				m.edges = m.edges.filter((e) => !gone.includes(e));
				this.deleteRecords(d, step, this.clock.now(), [n], gone, path);
				what = `${n.id as string} (+${gone.length} edges)`;
				break;
			}
			case "cAddEdge": {
				const from = node(a.from);
				const to = pickOf(m.nodes, a.to);
				if (!from || !to) return `skip ${tag}: no nodes`;
				const r = new SeededRandom(a.seed);
				const e: Obj = { id: this.edgeIdOf(d, step, 0), fromNode: from.id as string, fromSide: r.pick(SIDES), toNode: to.id as string, toSide: r.pick(SIDES) };
				if (r.chance(0.3)) e.toEnd = "arrow";
				if (r.chance(0.2)) e.label = `E${o.uniq()}`;
				m.edges.push(e);
				this.registerNew(`e:${e.id as string}`, e, d, step, path);
				what = `${e.id as string} ${from.id as string}->${to.id as string}`;
				break;
			}
			case "cDeleteEdge": {
				const e = pickOf(m.edges, this.recPick(a.edge));
				if (!e) return `skip ${tag}: no edge`;
				m.edges = m.edges.filter((x) => x !== e);
				this.deleteRecords(d, step, this.clock.now(), [], [e], path);
				what = `${e.id as string}`;
				break;
			}
			case "cEdge": {
				const e = pickOf(m.edges, this.recPick(a.edge));
				if (!e) return `skip ${tag}: no edge`;
				const rec = `e:${e.id as string}`;
				if (a.what === "rewire") {
					const to = pickOf(m.nodes, a.pick);
					if (!to) return `skip ${tag}: no node`;
					const end = a.pick < 0.5 ? "fromNode" : "toNode";
					set(rec, e, end, to.id as string);
					o.record(rec)?.endpoints.add(to.id as string);
				} else if (a.what === "sides") {
					set(rec, e, "fromSide", SIDES[Math.floor(a.pick * 4) % 4]);
					set(rec, e, "toSide", SIDES[Math.floor(a.pick * 16) % 4]);
				} else if (a.what === "label") set(rec, e, "label", `E${o.uniq()}`);
				else set(rec, e, "color", `#${o.uniq().toString(16).padStart(6, "0")}`);
				what = `${e.id as string} ${a.what}`;
				break;
			}
			case "cReorder": {
				const n = node(a.node);
				if (!n || m.nodes.length < 2) return `skip ${tag}: nothing to reorder`;
				const siblings = m.nodes.filter((x) => x !== n).map((x) => x.id as string);
				m.nodes = a.front ? [...m.nodes.filter((x) => x !== n), n] : [n, ...m.nodes.filter((x) => x !== n)];
				o.reorders.push({ dev: d.name, step, atMs: this.clock.now(), node: n.id as string, front: a.front, siblings, doc: docIdOf(d, path) });
				o.record(`n:${n.id as string}`)?.touches.push({ dev: d.name, field: "rank", value: `z${step}`, step, atMs: this.clock.now() });
				what = `${n.id as string} to ${a.front ? "front" : "back"}`;
				break;
			}
			case "cExtra": {
				const fieldKey = a.target === "root" ? ROOT_KEYS[a.key]! : EXTRA_KEYS[a.key]!;
				const u = o.uniq();
				const value: JsonValue | undefined = a.del ? undefined : a.key % 2 === 0 ? `v${u}` : { v: `u${u}`, nested: { list: [u, true, null], s: "x" } };
				if (a.target === "root") {
					if (a.del && m.root[fieldKey] === undefined) return `skip ${tag}: no ${fieldKey}`;
					set("root", m.root, fieldKey, value);
					what = `root.${fieldKey}${a.del ? " removed" : ""}`;
				} else {
					const list = a.target === "node" ? m.nodes : m.edges;
					const rec = pickOf(list, this.recPick(a.pick));
					if (!rec) return `skip ${tag}: no ${a.target}`;
					if (a.del && rec[fieldKey] === undefined) return `skip ${tag}: no ${fieldKey}`;
					set(`${a.target === "node" ? "n" : "e"}:${rec.id as string}`, rec, fieldKey, value);
					what = `${rec.id as string}.${fieldKey}${a.del ? " removed" : ""}`;
				}
				break;
			}
			case "cFileRef": {
				const files = m.nodes.filter((n) => n.type === "file");
				const n = pickOf(files, this.recPick(a.node));
				const target = pickOf(this.notes(d), a.pick);
				if (!n || !target) return `skip ${tag}: no file node`;
				set(`n:${n.id as string}`, n, "file", target);
				what = `${n.id as string} -> ${target}`;
				break;
			}
			case "cRewrite": {
				const r = new SeededRandom(a.seed);
				by = a.by;
				if (a.move && m.nodes.length > 0) {
					const n = r.pick(m.nodes);
					set(`n:${n.id as string}`, n, "x", o.uniq());
				}
				if (a.sort) {
					m.nodes.sort((x, y) => ((x.id as string) < (y.id as string) ? -1 : 1));
					for (const n of m.nodes) o.sorted.add(n.id as string);
				}
				this.oracle.stats.rewrites++;
				text = by === "user" ? obsidianText(m) : externalText(m, r);
				what = `${a.move ? "edit" : "format"}${a.sort ? " sorted" : ""}`;
				break;
			}
		}
		this.write(d, path, text ?? obsidianText(m), by);
		return `${tag}${a.t === "cRewrite" ? `(${by})` : ""} ${path} ${what}`;
	}
}
