/**
 * Relay v2 spike K2 fixtures: edited-history body states that trip the
 * semantic-compaction policy, plus the pathology STRESS trace.
 *
 *   sized-100k / sized-1m / sized-5m — synthetic Markdown (with a frontmatter
 *   block and frontmatter CRDT roots) of ~N UTF-8 bytes, then edited with the
 *   pathology-lab edit distribution (scripts/pathology-lab/trace.ts makeEdit:
 *   58 % short token insert, 24 % delete 1–48 chars, 18 % replace; uniformly
 *   random positions; 3 clients rotating every 17 edits). Editing stops at the
 *   first policy check where `evaluateSemanticCompaction` (unchanged server
 *   policy) recommends a reset — i.e. the state at which a device would
 *   actually fire. Net length drift is compensated by biasing toward inserts
 *   when the text shrinks >2 % below target (documented; keeps "N bytes"
 *   honest).
 *
 *   stress — `generateFrozenTrace` profile `stress` (256k chars / 50,000 edits,
 *   5 clients), seed 165 (same seed as A5's quick trace), replayed in order.
 *
 * Output: <dir>/<name>.update (encoded Yjs v1 state) + <name>.json (meta).
 * Usage: node tests/run-typescript.mjs --test-aliases scripts/relay2/reset/fixtures.ts [--out dir] [names…]
 */
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import * as Y from "yjs";
import { evaluateSemanticCompaction } from "../../../server/src/semanticCompactionPolicy";
import { generateFrozenTrace, PATHOLOGY_PROFILES, readFrozenFrames, readTraceManifest } from "../../pathology-lab/trace";
import { structCensus } from "./builder";

export const FIXTURE_DIR = "/Users/kavin/personal/obsidiansync/experiments/logs/relay2/reset-fixtures";
const INSERTS = ["x", "word ", "\n- item", "**bold**", "[link](target)", " `code` "] as const;

export interface FixtureMeta {
	name: string;
	kind: "sized" | "stress";
	targetBytes: number | null;
	seed: number;
	edits: number;
	liveUtf8Bytes: number;
	encodedStateBytes: number;
	totalStructs: number;
	deletedStructs: number;
	policy: ReturnType<typeof evaluateSemanticCompaction>;
	generationMs: number;
	generatedAt: string;
}

export const SIZED: Record<string, number> = {
	"sized-100k": 100 * 1024,
	"sized-1m": 1024 * 1024,
	"sized-5m": 5 * 1024 * 1024 - 64 * 1024, // stay under MAX_CLIENT_MARKDOWN_BYTES after drift
};

class DeterministicRandom {
	private state: number;
	constructor(seed: number) { this.state = seed >>> 0; }
	next(): number {
		let value = this.state;
		value ^= value << 13; value ^= value >>> 17; value ^= value << 5;
		this.state = value >>> 0;
		return this.state / 0x1_0000_0000;
	}
	integer(maximumExclusive: number): number {
		return maximumExclusive <= 0 ? 0 : Math.floor(this.next() * maximumExclusive);
	}
}

function syntheticMarkdown(target: number): string {
	const paragraph = "The vault remembers every little edit, even after the visible words have moved on. ";
	let text = "---\ntitle: K2 fixture\ntags: [relay, compaction]\n---\n# YAOS K2 fixture\n\n";
	let section = 0;
	const parts: string[] = [text];
	let length = text.length;
	while (length < target) {
		const chunk = `## Section ${section++}\n\n${paragraph.repeat(8)}\n\n`;
		parts.push(chunk);
		length += chunk.length;
	}
	text = parts.join("");
	return text.slice(0, target);
}

function seedFrontmatterRoots(doc: Y.Doc): void {
	doc.getMap<number>("frontmatter:meta").set("format", 1);
	doc.getMap("frontmatter:registers").set("title", { kind: "value", key: "title", value: "K2 fixture" });
}

/** Apply one pathology-distribution edit; the leading frontmatter block (first 80 chars) is never touched. */
function applyEdit(text: Y.Text, random: DeterministicRandom, bias: boolean): void {
	const protectedPrefix = 80;
	const length = text.length;
	const roll = bias ? random.next() * 0.58 : random.next();
	const position = protectedPrefix + random.integer(Math.max(1, length - protectedPrefix + 1));
	if (roll < 0.58 || length < protectedPrefix + 32) {
		text.insert(Math.min(position, length), INSERTS[random.integer(INSERTS.length)]!);
		return;
	}
	const requested = 1 + random.integer(Math.min(48, Math.max(1, length - position)));
	const end = Math.min(length, position + requested);
	if (end <= position) return;
	text.delete(position, end - position);
	if (roll >= 0.82) text.insert(position, INSERTS[random.integer(INSERTS.length)]!);
}

function policyFor(doc: Y.Doc, encoded: number) {
	const { totalStructs, deletedStructs } = structCensus(doc);
	const live = new TextEncoder().encode(doc.getText("body").toJSON()).byteLength;
	// Estimated fresh ≈ live + small overhead (see policy.ts estimateFreshStateBytes).
	return evaluateSemanticCompaction({
		scope: "body", encodedStateBytes: encoded, liveStateBytes: live,
		estimatedFreshStateBytes: live + 400, totalStructs, deletedStructs,
		latencyViolationStreak: 0, memoryPressure: false,
	}, { lastCompactedAt: null, postCompactionEncodedStateBytes: null }, Date.now());
}

export function generateSized(name: string, target: number, seed = 0x5eed_2002, maxEdits = 2_000_000): { state: Uint8Array; meta: FixtureMeta } {
	const started = performance.now();
	const doc = new Y.Doc({ guid: `k2-${name}` });
	doc.clientID = 0x2a00_0001;
	const text = doc.getText("body");
	text.insert(0, syntheticMarkdown(target));
	seedFrontmatterRoots(doc);
	const random = new DeterministicRandom(seed);
	const clients = [0x2a00_1000, 0x2a00_1001, 0x2a00_1002];
	let edits = 0;
	let checkEvery = 1_000;
	for (;;) {
		for (let index = 0; index < checkEvery && edits < maxEdits; index++, edits++) {
			doc.clientID = clients[Math.floor(edits / 17) % clients.length]!;
			const bias = text.length < target * 0.98;
			doc.transact(() => applyEdit(text, random, bias), "k2-generator");
		}
		const encoded = Y.encodeStateAsUpdate(doc).byteLength;
		const decision = policyFor(doc, encoded);
		if (decision.semanticResetRecommended || edits >= maxEdits) break;
		// Coarser steps far from the trigger (the encode for the check dominates on 5 MB).
		checkEvery = Math.min(50_000, Math.max(1_000, Math.floor(edits / 10)));
	}
	const state = Y.encodeStateAsUpdate(doc);
	const census = structCensus(doc);
	const meta: FixtureMeta = {
		name, kind: "sized", targetBytes: target, seed, edits,
		liveUtf8Bytes: new TextEncoder().encode(text.toJSON()).byteLength,
		encodedStateBytes: state.byteLength, ...census,
		policy: policyFor(doc, state.byteLength),
		generationMs: performance.now() - started, generatedAt: new Date().toISOString(),
	};
	doc.destroy();
	return { state, meta };
}

export function generateStress(directory: string, seed = 165): { state: Uint8Array; meta: FixtureMeta } {
	const started = performance.now();
	const traceDirectory = join(directory, "trace-stress");
	if (!existsSync(join(traceDirectory, "manifest.json"))) {
		generateFrozenTrace({ outputDirectory: traceDirectory, profile: PATHOLOGY_PROFILES.stress!, seed });
	}
	const manifest = readTraceManifest(traceDirectory);
	const doc = new Y.Doc({ guid: manifest.bodyId });
	Y.applyUpdate(doc, readFileSync(join(traceDirectory, "base.update")));
	let edits = 0;
	for (const frame of readFrozenFrames(join(traceDirectory, "updates.bin"))) { Y.applyUpdate(doc, frame); edits++; }
	const state = Y.encodeStateAsUpdate(doc);
	const census = structCensus(doc);
	const meta: FixtureMeta = {
		name: "stress", kind: "stress", targetBytes: null, seed, edits,
		liveUtf8Bytes: new TextEncoder().encode(doc.getText("body").toJSON()).byteLength,
		encodedStateBytes: state.byteLength, ...census,
		policy: policyFor(doc, state.byteLength),
		generationMs: performance.now() - started, generatedAt: new Date().toISOString(),
	};
	if (doc.getText("body").toJSON().length !== manifest.final.textCodeUnits) throw new Error("stress replay diverged from manifest");
	doc.destroy();
	return { state, meta };
}

export function loadFixture(name: string, directory = FIXTURE_DIR): { state: Uint8Array; meta: FixtureMeta } {
	return {
		state: new Uint8Array(readFileSync(join(directory, `${name}.update`))),
		meta: JSON.parse(readFileSync(join(directory, `${name}.json`), "utf8")) as FixtureMeta,
	};
}

export const ALL_FIXTURES = ["sized-100k", "sized-1m", "sized-5m", "stress"] as const;

async function main(): Promise<void> {
	const args = process.argv.slice(2);
	let directory = FIXTURE_DIR;
	const outIndex = args.indexOf("--out");
	if (outIndex >= 0) { directory = args[outIndex + 1]!; args.splice(outIndex, 2); }
	const force = args.includes("--force");
	const names = args.filter((arg) => !arg.startsWith("--"));
	mkdirSync(directory, { recursive: true });
	for (const name of names.length > 0 ? names : ALL_FIXTURES) {
		if (!force && existsSync(join(directory, `${name}.json`))) { console.log(`${name}: cached`); continue; }
		const result = name === "stress" ? generateStress(directory) : generateSized(name, SIZED[name]!);
		writeFileSync(join(directory, `${name}.update`), result.state);
		writeFileSync(join(directory, `${name}.json`), `${JSON.stringify(result.meta, null, 2)}\n`);
		console.log(`${name}: edits=${result.meta.edits} live=${result.meta.liveUtf8Bytes} encoded=${result.meta.encodedStateBytes} structs=${result.meta.totalStructs}/${result.meta.deletedStructs} policy=${result.meta.policy.urgency}:${result.meta.policy.reasons.join(",")} gen=${Math.round(result.meta.generationMs)}ms`);
	}
}

if (process.argv[1]?.endsWith("fixtures.ts")) await main();
