/**
 * W4 deterministic vault corpus generator (PHASE3-WRITE-BUDGET-SPIKE §3 W4, I1/I2/I3).
 *
 *   node tests/run-typescript.mjs --test-aliases scripts/relay2/wb/corpus.ts --preset 2k|10k|25k|drop
 *        [--seed wb1] [--manifest <json>] [--out-dir <dir>] [--stats] [--hash-content]
 *
 * Same (preset, seed) → byte-identical vault, on any machine (own PRNG, no Math.random, no Date).
 *
 *  - notes: log-normal sizes, median ~2 KB (mu = ln 2048, sigma 1.5), clipped to [120 B, 200 KB], plus a few
 *    "huge" notes > SQLITE_ROW_SAFE_BYTES (1.75 MB) to exercise chunking (2k: 3 notes, 1.8 / 2.6 / 4.1 MB).
 *  - nested folders (depth ≤ 4, ~5% of notes at the vault root), Zipf-ish folder popularity.
 *  - attachments (~5% of the note count: 2k → 100): png-like (real PNG signature + IHDR, random payload) and
 *    pdf-like (%PDF header/trailer, random payload), log-normal sizes (median 120 KB png / 300 KB pdf, ≤ 8 MB).
 *  - preset "drop": the I3 folder drop, 200 notes + 50 png under `Dropped/<name>/`, disjoint from the vault.
 *
 * Content is generated lazily per item (`noteText`, `attachmentBytes`), so a 25k manifest costs no memory.
 */
import { createHash } from "node:crypto";
import { mkdirSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";

export const SQLITE_ROW_SAFE_BYTES = 1_750_000; // server/src/shared/durableLimits.ts

// ------------------------------------------------------------------ PRNG
/** 32-bit FNV-1a of a string → seed. */
export function hashSeed(s: string): number {
	let h = 0x811c9dc5;
	for (let i = 0; i < s.length; i++) { h ^= s.charCodeAt(i); h = Math.imul(h, 0x01000193) >>> 0; }
	return h >>> 0;
}
/** mulberry32: small, fast, deterministic. */
export function rng(seed: number | string) {
	let a = typeof seed === "string" ? hashSeed(seed) : seed >>> 0;
	const next = () => {
		a = (a + 0x6d2b79f5) >>> 0;
		let t = a;
		t = Math.imul(t ^ (t >>> 15), t | 1);
		t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
		return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
	};
	return {
		next,
		int: (lo: number, hi: number) => lo + Math.floor(next() * (hi - lo + 1)),
		pick: <T>(xs: readonly T[]): T => xs[Math.floor(next() * xs.length)]!,
		/** Standard normal (Box–Muller). */
		normal: () => { const u = Math.max(next(), 1e-12), v = next(); return Math.sqrt(-2 * Math.log(u)) * Math.cos(2 * Math.PI * v); },
	};
}
export type Rng = ReturnType<typeof rng>;

// ------------------------------------------------------------------ presets
export interface CorpusSpec {
	name: string;
	seed: string;
	notes: number;
	attachments: number;
	/** Notes larger than SQLITE_ROW_SAFE_BYTES. */
	hugeNotes: number;
	medianBytes: number;
	sigma: number;
	minBytes: number;
	maxBytes: number;
	/** All paths under this folder (folder drop). */
	rootFolder?: string;
	/** png share of attachments (rest pdf). */
	pngShare: number;
}

export function presetSpec(preset: string, seed = "wb1"): CorpusSpec {
	const base = { seed, medianBytes: 2048, sigma: 1.5, minBytes: 120, maxBytes: 200 * 1024, pngShare: 0.7 };
	switch (preset) {
		case "2k": return { ...base, name: "2k", notes: 2000, attachments: 100, hugeNotes: 3 };
		case "10k": return { ...base, name: "10k", notes: 10_000, attachments: 500, hugeNotes: 15 };
		case "25k": return { ...base, name: "25k", notes: 25_000, attachments: 1250, hugeNotes: 38 };
		case "drop": return { ...base, name: "drop", seed: `${seed}-drop`, notes: 200, attachments: 50, hugeNotes: 0, pngShare: 1,
			rootFolder: "Dropped/Field notes 2026" };
		case "tiny": return { ...base, name: "tiny", notes: 40, attachments: 4, hugeNotes: 1 };
		default: throw new Error(`unknown preset ${preset} (2k|10k|25k|drop|tiny)`);
	}
}

// ------------------------------------------------------------------ manifest
export interface NoteItem { kind: "note"; index: number; path: string; bodyId: string; bytes: number; seed: number; huge: boolean }
export interface AttachmentItem { kind: "attachment"; index: number; path: string; bytes: number; seed: number; mime: string; ext: "png" | "pdf" }
export type CorpusItem = NoteItem | AttachmentItem;
export interface Corpus { spec: CorpusSpec; notes: NoteItem[]; attachments: AttachmentItem[]; folders: string[] }

const WORDS = ("alpha beta gamma delta epsilon zeta theta kappa lambda sigma omega river stone garden lantern harbor "
	+ "meadow orbit cedar quartz falcon ember willow summit canyon prairie glacier compass atlas beacon mosaic "
	+ "journal ledger draft review meeting idea project reading research recipe travel budget weekly daily "
	+ "the of and to in is that for with on as it by this be are from at or an was have not but").split(" ");
const FOLDER_WORDS = ["Projects", "Areas", "Resources", "Archive", "Journal", "Meetings", "Reading", "Research", "People",
	"Recipes", "Travel", "Work", "Personal", "Ideas", "Clients", "Courses", "Drafts", "Reference", "Inbox", "Writing"];

function folderTree(r: Rng, root?: string): string[] {
	if (root) {
		const subs = ["", "Photos", "Interviews", "Interviews/Transcripts", "Sketches"];
		return subs.map((s) => (s ? `${root}/${s}` : root));
	}
	const out: string[] = [""];
	const grow = (prefix: string, depth: number) => {
		const kids = depth === 0 ? 12 : r.int(0, depth >= 3 ? 2 : 5);
		for (let k = 0; k < kids; k++) {
			const name = depth === 0 ? FOLDER_WORDS[k]! : `${r.pick(FOLDER_WORDS)} ${r.pick(WORDS)} ${r.int(1, 99)}`.replace(/\b\w/g, (c) => c.toUpperCase());
			const path = prefix ? `${prefix}/${name}` : name;
			if (out.includes(path)) continue;
			out.push(path);
			if (depth < 4) grow(path, depth + 1);
		}
	};
	grow("", 0);
	return out;
}

function logNormalBytes(r: Rng, median: number, sigma: number, lo: number, hi: number) {
	return Math.round(Math.min(hi, Math.max(lo, Math.exp(Math.log(median) + sigma * r.normal()))));
}

export function buildCorpus(spec: CorpusSpec, idPrefix = `wb-${spec.name}`): Corpus {
	const r = rng(`${spec.seed}/${spec.name}/layout`);
	const folders = folderTree(r, spec.rootFolder);
	// Zipf-ish folder weights; the vault root (index 0) gets ~5% (folder drop: the drop folder itself gets most).
	const weights = folders.map((_f, i) => (i === 0 && !spec.rootFolder ? 0.012 * folders.length : 1 / (1 + (i % 17))));
	const total = weights.reduce((a, b) => a + b, 0);
	const pickFolder = () => {
		let x = r.next() * total;
		for (let i = 0; i < folders.length; i++) { x -= weights[i]!; if (x <= 0) return folders[i]!; }
		return folders.at(-1)!;
	};
	const used = new Set<string>();
	const uniquePath = (folder: string, stem: string, ext: string) => {
		let p = `${folder ? folder + "/" : ""}${stem}.${ext}`;
		for (let k = 2; used.has(p.toLowerCase()); k++) p = `${folder ? folder + "/" : ""}${stem} ${k}.${ext}`;
		used.add(p.toLowerCase());
		return p;
	};
	const hugeSizes = [1_800_000, 2_600_000, 4_100_000];
	const notes: NoteItem[] = [];
	for (let i = 0; i < spec.notes; i++) {
		const huge = i >= spec.notes - spec.hugeNotes;
		const bytes = huge ? hugeSizes[(spec.notes - 1 - i) % hugeSizes.length]! + r.int(0, 50_000)
			: logNormalBytes(r, spec.medianBytes, spec.sigma, spec.minBytes, spec.maxBytes);
		const stem = `${r.pick(WORDS)} ${r.pick(WORDS)} ${r.pick(WORDS)}`.replace(/^\w/, (c) => c.toUpperCase());
		const path = uniquePath(pickFolder(), stem, "md");
		notes.push({ kind: "note", index: i, path, bodyId: `${idPrefix}-n${String(i).padStart(5, "0")}`, bytes, seed: r.int(1, 2 ** 31 - 2), huge });
	}
	const attachments: AttachmentItem[] = [];
	for (let i = 0; i < spec.attachments; i++) {
		const png = r.next() < spec.pngShare;
		const bytes = logNormalBytes(r, png ? 120 * 1024 : 300 * 1024, 1.0, 2 * 1024, 8 * 1024 * 1024);
		const folder = spec.rootFolder ? `${spec.rootFolder}/Photos` : (r.next() < 0.6 ? "Attachments" : pickFolder());
		const path = uniquePath(folder, `${png ? "image" : "document"} ${String(i).padStart(4, "0")}`, png ? "png" : "pdf");
		attachments.push({ kind: "attachment", index: i, path, bytes, seed: r.int(1, 2 ** 31 - 2), ext: png ? "png" : "pdf",
			mime: png ? "image/png" : "application/pdf" });
	}
	return { spec, notes, attachments, folders };
}

// ------------------------------------------------------------------ content
/** Markdown text of exactly `note.bytes` UTF-8 bytes (ASCII only, so chars = bytes). Deterministic per note. */
export function noteText(note: NoteItem, corpus?: Corpus): string {
	const r = rng(note.seed);
	const parts: string[] = [];
	let len = 0;
	const push = (s: string) => { parts.push(s); len += s.length; };
	if (r.next() < 0.3) push(`---\ntags: [${r.pick(WORDS)}, ${r.pick(WORDS)}]\ncreated: 2026-0${r.int(1, 9)}-1${r.int(0, 9)}\n---\n`);
	push(`# ${note.path.split("/").pop()!.replace(/\.md$/, "")}\n\n`);
	while (len < note.bytes) {
		const roll = r.next();
		if (roll < 0.08) push(`\n## ${r.pick(WORDS)} ${r.pick(WORDS)}\n\n`);
		else if (roll < 0.2) push(`- ${r.pick(WORDS)} ${r.pick(WORDS)} ${r.pick(WORDS)}\n`);
		else if (roll < 0.23 && corpus) push(`See [[${r.pick(corpus.notes).path.split("/").pop()!.replace(/\.md$/, "")}]]. `);
		else if (roll < 0.24 && corpus && corpus.attachments.length) push(`\n![[${r.pick(corpus.attachments).path.split("/").pop()}]]\n`);
		else {
			const n = r.int(6, 18);
			const words: string[] = [];
			for (let k = 0; k < n; k++) words.push(r.pick(WORDS));
			push(words.join(" ").replace(/^\w/, (c) => c.toUpperCase()) + (r.next() < 0.2 ? ".\n\n" : ". "));
		}
	}
	const text = parts.join("");
	return text.length > note.bytes ? text.slice(0, note.bytes - 1) + "\n" : text;
}

/** Attachment bytes: a real format header + deterministic pseudo-random payload; exactly `item.bytes` long. */
export function attachmentBytes(item: AttachmentItem): Uint8Array {
	const out = new Uint8Array(item.bytes);
	const r = rng(item.seed);
	for (let i = 0; i < out.length; i += 4) {
		const v = Math.floor(r.next() * 4294967296);
		out[i] = v & 255; if (i + 1 < out.length) out[i + 1] = (v >>> 8) & 255;
		if (i + 2 < out.length) out[i + 2] = (v >>> 16) & 255; if (i + 3 < out.length) out[i + 3] = (v >>> 24) & 255;
	}
	const head = item.ext === "png"
		? [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0, 0, 0, 13, 0x49, 0x48, 0x44, 0x52]
		: [...Buffer.from("%PDF-1.4\n%\xe2\xe3\xcf\xd3\n", "latin1")];
	out.set(head.slice(0, out.length), 0);
	if (item.ext === "pdf" && out.length > 32) out.set(Buffer.from("\n%%EOF\n", "latin1"), out.length - 7);
	return out;
}

export function sha256(data: string | Uint8Array): string { return createHash("sha256").update(data).digest("hex"); }

// ------------------------------------------------------------------ stats / digest
function quantile(sorted: number[], q: number) { return sorted.length ? sorted[Math.min(sorted.length - 1, Math.floor(q * sorted.length))]! : 0; }

export function corpusStats(c: Corpus) {
	const sizes = c.notes.map((n) => n.bytes).sort((a, b) => a - b);
	const att = c.attachments.map((a) => a.bytes).sort((a, b) => a - b);
	const chunks = (b: number) => Math.max(1, Math.ceil(b / SQLITE_ROW_SAFE_BYTES));
	return {
		preset: c.spec.name, seed: c.spec.seed, notes: c.notes.length, attachments: c.attachments.length, folders: c.folders.length,
		noteBytes: { total: sizes.reduce((a, b) => a + b, 0), p50: quantile(sizes, 0.5), p90: quantile(sizes, 0.9), p99: quantile(sizes, 0.99),
			max: sizes.at(-1) ?? 0, over64k: sizes.filter((s) => s > 65_536).length, over200k: sizes.filter((s) => s > 200 * 1024).length },
		hugeNotes: c.notes.filter((n) => n.bytes > SQLITE_ROW_SAFE_BYTES).length,
		/** Body snapshot chunks at SQLITE_ROW_SAFE_BYTES (one row each in a bulk create; feeds costmodel.py). */
		snapshotChunks: c.notes.reduce((s, n) => s + chunks(n.bytes), 0),
		attachmentBytes: { total: att.reduce((a, b) => a + b, 0), p50: quantile(att, 0.5), max: att.at(-1) ?? 0,
			png: c.attachments.filter((a) => a.ext === "png").length, pdf: c.attachments.filter((a) => a.ext === "pdf").length },
		maxDepth: Math.max(...c.notes.map((n) => n.path.split("/").length - 1)),
		rootLevelNotes: c.notes.filter((n) => !n.path.includes("/")).length,
	};
}

/** Digest of the manifest (paths, sizes, seeds); with `content`, also of every generated byte. */
export function corpusDigest(c: Corpus, content = false): string {
	const h = createHash("sha256");
	for (const n of c.notes) { h.update(`${n.path}\0${n.bodyId}\0${n.bytes}\0${n.seed}\n`); if (content) h.update(noteText(n, c)); }
	for (const a of c.attachments) { h.update(`${a.path}\0${a.bytes}\0${a.seed}\n`); if (content) h.update(attachmentBytes(a)); }
	return h.digest("hex");
}

export function manifestJson(c: Corpus, content = false) {
	return { generator: "scripts/relay2/wb/corpus.ts", spec: c.spec, stats: corpusStats(c), digest: corpusDigest(c, false),
		contentDigest: content ? corpusDigest(c, true) : null,
		items: [...c.notes.map((n) => ({ kind: n.kind, path: n.path, bodyId: n.bodyId, bytes: n.bytes, huge: n.huge })),
			...c.attachments.map((a) => ({ kind: a.kind, path: a.path, bytes: a.bytes, mime: a.mime }))] };
}

export function materialize(c: Corpus, dir: string) {
	for (const n of c.notes) { const p = join(dir, n.path); mkdirSync(dirname(p), { recursive: true }); writeFileSync(p, noteText(n, c)); }
	for (const a of c.attachments) { const p = join(dir, a.path); mkdirSync(dirname(p), { recursive: true }); writeFileSync(p, attachmentBytes(a)); }
}

// ------------------------------------------------------------------ CLI
async function main() {
	const { parseArgs, flagStr } = await import("../lib/common");
	const args = parseArgs();
	const preset = flagStr(args, "preset", "2k")!;
	const corpus = buildCorpus(presetSpec(preset, flagStr(args, "seed", "wb1")));
	const content = !!args.flags["hash-content"];
	const manifest = manifestJson(corpus, content);
	const out = flagStr(args, "manifest");
	if (out) { mkdirSync(dirname(out), { recursive: true }); writeFileSync(out, JSON.stringify(manifest, null, 1) + "\n"); console.log(`wrote ${out}`); }
	const dir = flagStr(args, "out-dir");
	if (dir) { materialize(corpus, dir); console.log(`materialized ${corpus.notes.length} notes + ${corpus.attachments.length} attachments under ${dir}`); }
	console.log(JSON.stringify({ stats: manifest.stats, digest: manifest.digest, contentDigest: manifest.contentDigest }, null, 1));
}

if (process.argv[1]?.endsWith("corpus.ts")) main().catch((e) => { console.error(e); process.exit(1); });
