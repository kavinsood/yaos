import { createHash } from "node:crypto";
import {
	closeSync,
	fstatSync,
	mkdirSync,
	openSync,
	readFileSync,
	readSync,
	readdirSync,
	renameSync,
	rmSync,
	statSync,
	writeFileSync,
	writeSync,
} from "node:fs";
import { basename, join, resolve } from "node:path";
import * as Y from "yjs";
import { canonicalizeMarkdown } from "../../server/src/shared/markdownCodec";
import { MAX_CLIENT_MARKDOWN_BYTES } from "../../server/src/shared/durableLimits";
import type { FrozenTraceManifest, PathologyProfile, SemanticEdit, YjsCensus } from "./types";

const FRAME_MAGIC = Buffer.from("YAOSPW1\n", "ascii");
const BODY_ID = "pathology-body-0001";
const BASE_CLIENT_ID = 0x1a05_0001;
const EDIT_CLIENT_ID = 0x1a05_1000;
const INSERTS = ["x", "word ", "\n- item", "**bold**", "[link](target)", " `code` "] as const;

export const PATHOLOGY_PROFILES: Record<string, PathologyProfile> = {
	quick: {
		name: "quick",
		baseChars: 64_000,
		edits: 5_000,
		clients: 3,
		clientBurst: 17,
		candidateEvery: 50,
		rootOperations: 5_000,
		activeRootEntries: 250,
	},
	stress: {
		name: "stress",
		baseChars: 256_000,
		edits: 50_000,
		clients: 5,
		clientBurst: 23,
		candidateEvery: 100,
		rootOperations: 50_000,
		activeRootEntries: 1_000,
	},
};

class DeterministicRandom {
	private state: number;

	constructor(seed: number) {
		this.state = seed >>> 0;
	}

	next(): number {
		let value = this.state;
		value ^= value << 13;
		value ^= value >>> 17;
		value ^= value << 5;
		this.state = value >>> 0;
		return this.state / 0x1_0000_0000;
	}

	integer(maximumExclusive: number): number {
		if (maximumExclusive <= 0) return 0;
		return Math.floor(this.next() * maximumExclusive);
	}
}

class FrameWriter {
	private readonly descriptor: number;
	private readonly hash = createHash("sha256");
	private frames = 0;
	private payloadBytes = 0;
	private maximumFrameBytes = 0;

	constructor(private readonly temporaryPath: string, private readonly finalPath: string) {
		this.descriptor = openSync(temporaryPath, "wx", 0o600);
		writeSync(this.descriptor, FRAME_MAGIC);
		this.hash.update(FRAME_MAGIC);
	}

	write(bytes: Uint8Array): void {
		if (bytes.byteLength === 0 || bytes.byteLength > 0xffff_ffff) {
			throw new Error(`invalid frozen frame length ${bytes.byteLength}`);
		}
		const header = Buffer.allocUnsafe(4);
		header.writeUInt32LE(bytes.byteLength);
		writeSync(this.descriptor, header);
		writeSync(this.descriptor, bytes);
		this.hash.update(header);
		this.hash.update(bytes);
		this.frames++;
		this.payloadBytes += bytes.byteLength;
		this.maximumFrameBytes = Math.max(this.maximumFrameBytes, bytes.byteLength);
	}

	finish(): { frames: number; bytes: number; maximumFrameBytes: number; fileBytes: number; sha256: string } {
		closeSync(this.descriptor);
		renameSync(this.temporaryPath, this.finalPath);
		return {
			frames: this.frames,
			bytes: this.payloadBytes,
			maximumFrameBytes: this.maximumFrameBytes,
			fileBytes: statSync(this.finalPath).size,
			sha256: this.hash.digest("hex"),
		};
	}
}

export function sha256(bytes: Uint8Array | string): string {
	return createHash("sha256").update(bytes).digest("hex");
}

/**
 * Reads the semantic half of a frozen trace. These operations are deliberately
 * independent of the captured Yjs identities, so epoch-reset tests can replay
 * the same user intent from genuinely fresh clients.
 */
export function readFrozenSemanticEdits(traceDirectory: string): SemanticEdit[] {
	const manifest = readTraceManifest(traceDirectory);
	const lines = readFileSync(join(traceDirectory, "semantic.jsonl"), "utf8")
		.split("\n")
		.filter((line) => line.length > 0);
	if (lines.length !== manifest.semantic.operations) {
		throw new Error(`semantic operation count changed: ${lines.length} != ${manifest.semantic.operations}`);
	}
	return lines.map((line, index) => {
		const value = JSON.parse(line) as Partial<SemanticEdit>;
		if (value.sequence !== index || !Number.isSafeInteger(value.client) || Number(value.client) < 0
			|| Number(value.client) >= manifest.profile.clients
			|| !["insert", "delete", "replace"].includes(String(value.kind))
			|| !Number.isSafeInteger(value.position) || Number(value.position) < 0
			|| !Number.isSafeInteger(value.deleteCount) || Number(value.deleteCount) < 0
			|| typeof value.insertText !== "string") {
			throw new Error(`invalid semantic operation at line ${index + 1}`);
		}
		return value as SemanticEdit;
	});
}

export function census(doc: Y.Doc): YjsCensus {
	let structs = 0;
	let deletedStructs = 0;
	let gcStructs = 0;
	for (const list of doc.store.clients.values()) {
		structs += list.length;
		for (const struct of list) {
			if (struct.constructor.name === "GC") gcStructs++;
			else if (struct.deleted) deletedStructs++;
		}
	}
	return {
		structs,
		deletedStructs,
		gcStructs,
		clientBuckets: doc.store.clients.size,
		pendingStructBytes: doc.store.pendingStructs?.update.byteLength ?? 0,
		pendingDeleteSetBytes: doc.store.pendingDs?.byteLength ?? 0,
	};
}

function syntheticMarkdown(targetCodeUnits: number): string {
	const paragraph = "The vault remembers every little edit, even after the visible words have moved on. ";
	let text = "# YAOS pathology fixture\n\n";
	let section = 0;
	while (text.length < targetCodeUnits) {
		text += `## Section ${section++}\n\n${paragraph.repeat(8)}\n\n`;
	}
	return text.slice(0, targetCodeUnits);
}

function markdownFiles(root: string, output: string[] = []): string[] {
	for (const entry of readdirSync(root, { withFileTypes: true })) {
		if (entry.name.startsWith(".")) continue;
		const path = join(root, entry.name);
		if (entry.isDirectory()) markdownFiles(path, output);
		else if (entry.isFile() && entry.name.toLowerCase().endsWith(".md")) output.push(path);
	}
	return output;
}

function sourceText(profile: PathologyProfile, corpusRoots: readonly string[]): {
	text: string;
	source: FrozenTraceManifest["source"];
} {
	const candidates: Array<{ path: string; bytes: number }> = [];
	for (const unresolved of corpusRoots) {
		const root = resolve(unresolved.replace(/^~(?=\/)/, process.env.HOME ?? "~"));
		try {
			for (const path of markdownFiles(root)) {
				const bytes = statSync(path).size;
				if (bytes <= MAX_CLIENT_MARKDOWN_BYTES) candidates.push({ path, bytes });
			}
		} catch {
			// An optional corpus root being absent must not make synthetic runs fail.
		}
	}
	const selected = candidates.sort((left, right) => right.bytes - left.bytes)[0];
	if (!selected) {
		const text = syntheticMarkdown(profile.baseChars);
		return { text, source: { kind: "synthetic", path: null, originalUtf8Bytes: Buffer.byteLength(text) } };
	}
	// Y.Text positions are UTF-16 code units. Replacing surrogate units keeps
	// the exact edit-position geometry while ensuring a deterministic random
	// boundary can never split an emoji into invalid UTF-8.
	let text = canonicalizeMarkdown(readFileSync(selected.path, "utf8")).replace(/[\uD800-\uDFFF]/g, "x");
	if (Buffer.byteLength(text) > MAX_CLIENT_MARKDOWN_BYTES) {
		throw new Error("selected corpus file crossed the Markdown limit while decoding");
	}
	return {
		text,
		source: { kind: "corpus", path: selected.path, originalUtf8Bytes: Buffer.byteLength(text) },
	};
}

function makeEdit(sequence: number, client: number, textLength: number, random: DeterministicRandom): SemanticEdit {
	const roll = random.next();
	const position = random.integer(textLength + 1);
	if (roll < 0.58 || textLength < 32) {
		return {
			sequence,
			client,
			kind: "insert",
			position,
			deleteCount: 0,
			insertText: INSERTS[random.integer(INSERTS.length)]!,
		};
	}
	const requested = 1 + random.integer(Math.min(48, Math.max(1, textLength - position)));
	const end = Math.min(textLength, position + requested);
	if (roll < 0.82) {
		return { sequence, client, kind: "delete", position, deleteCount: end - position, insertText: "" };
	}
	return {
		sequence,
		client,
		kind: "replace",
		position,
		deleteCount: end - position,
		insertText: INSERTS[random.integer(INSERTS.length)]!,
	};
}

function applySemanticEdit(text: Y.Text, edit: SemanticEdit): void {
	if (edit.deleteCount > 0) text.delete(edit.position, edit.deleteCount);
	if (edit.insertText.length > 0) text.insert(edit.position, edit.insertText);
}

export function generateFrozenTrace(input: {
	outputDirectory: string;
	profile: PathologyProfile;
	seed: number;
	corpusRoots?: readonly string[];
}): FrozenTraceManifest {
	const directory = resolve(input.outputDirectory);
	mkdirSync(directory, { recursive: true, mode: 0o700 });
	for (const name of ["base.update", "updates.bin", "candidates.bin", "semantic.jsonl", "manifest.json"]) {
		rmSync(join(directory, name), { force: true });
		rmSync(join(directory, `${name}.tmp`), { force: true });
	}

	const { text: initialText, source } = sourceText(input.profile, input.corpusRoots ?? []);
	const baseDoc = new Y.Doc({ guid: BODY_ID });
	baseDoc.clientID = BASE_CLIENT_ID;
	baseDoc.getText("body").insert(0, initialText);
	const baseUpdate = Y.encodeStateAsUpdate(baseDoc);
	writeFileSync(join(directory, "base.update.tmp"), baseUpdate, { mode: 0o600, flag: "wx" });
	renameSync(join(directory, "base.update.tmp"), join(directory, "base.update"));

	const authority = new Y.Doc({ guid: BODY_ID });
	authority.clientID = BASE_CLIENT_ID + 1;
	Y.applyUpdate(authority, baseUpdate);
	const clients = Array.from({ length: input.profile.clients }, (_, index) => {
		const doc = new Y.Doc({ guid: BODY_ID });
		doc.clientID = EDIT_CLIENT_ID + index;
		Y.applyUpdate(doc, baseUpdate);
		return doc;
	});
	const updates = new FrameWriter(join(directory, "updates.bin.tmp"), join(directory, "updates.bin"));
	const candidates = new FrameWriter(join(directory, "candidates.bin.tmp"), join(directory, "candidates.bin"));
	const semanticLines: string[] = [];
	const candidateUpdates: Uint8Array[] = [];
	const random = new DeterministicRandom(input.seed);

	for (let sequence = 0; sequence < input.profile.edits; sequence++) {
		const clientIndex = Math.floor(sequence / input.profile.clientBurst) % clients.length;
		const client = clients[clientIndex]!;
		const body = client.getText("body");
		const edit = makeEdit(sequence, clientIndex, body.length, random);
		const captured: { value: Uint8Array | null } = { value: null };
		const capture = (emitted: Uint8Array, origin: unknown): void => {
			if (origin === "pathology-generator") captured.value = emitted.slice();
		};
		client.on("update", capture);
		client.transact(() => applySemanticEdit(body, edit), "pathology-generator");
		client.off("update", capture);
		const update = captured.value;
		if (!update || update.byteLength === 0) throw new Error(`edit ${sequence} produced an empty Yjs update`);
		updates.write(update);
		candidateUpdates.push(update);
		semanticLines.push(JSON.stringify(edit));
		Y.applyUpdate(authority, update, "pathology-authority");
		for (let peerIndex = 0; peerIndex < clients.length; peerIndex++) {
			if (peerIndex !== clientIndex) Y.applyUpdate(clients[peerIndex]!, update, "pathology-peer");
		}
		if (candidateUpdates.length >= input.profile.candidateEvery) {
			candidates.write(Y.mergeUpdates(candidateUpdates));
			candidateUpdates.length = 0;
		}
	}
	if (candidateUpdates.length > 0) candidates.write(Y.mergeUpdates(candidateUpdates));

	const updatesResult = updates.finish();
	const candidatesResult = candidates.finish();
	const semanticText = `${semanticLines.join("\n")}\n`;
	writeFileSync(join(directory, "semantic.jsonl.tmp"), semanticText, { mode: 0o600, flag: "wx" });
	renameSync(join(directory, "semantic.jsonl.tmp"), join(directory, "semantic.jsonl"));
	const finalText = authority.getText("body").toString();
	for (const client of clients) {
		if (client.getText("body").toString() !== finalText) throw new Error("generated clients did not converge");
	}
	const finalEncoded = Y.encodeStateAsUpdate(authority);
	const manifest: FrozenTraceManifest = {
		format: "yaos-pathology-trace-v1",
		generatedAt: new Date().toISOString(),
		profile: input.profile,
		seed: input.seed,
		bodyId: BODY_ID,
		source,
		base: {
			textCodeUnits: initialText.length,
			utf8Bytes: Buffer.byteLength(initialText),
			updateBytes: baseUpdate.byteLength,
			sha256: sha256(baseUpdate),
		},
		updates: updatesResult,
		candidates: candidatesResult,
		semantic: {
			operations: semanticLines.length,
			fileBytes: Buffer.byteLength(semanticText),
			sha256: sha256(semanticText),
		},
		final: {
			textCodeUnits: finalText.length,
			utf8Bytes: Buffer.byteLength(finalText),
			textSha256: sha256(finalText),
			encodedStateBytes: finalEncoded.byteLength,
			census: census(authority),
		},
	};
	writeFileSync(join(directory, "manifest.json.tmp"), `${JSON.stringify(manifest, null, 2)}\n`, { mode: 0o600, flag: "wx" });
	renameSync(join(directory, "manifest.json.tmp"), join(directory, "manifest.json"));
	baseDoc.destroy();
	authority.destroy();
	for (const client of clients) client.destroy();
	return manifest;
}

export function readTraceManifest(directory: string): FrozenTraceManifest {
	const manifest = JSON.parse(readFileSync(join(directory, "manifest.json"), "utf8")) as FrozenTraceManifest;
	if (manifest.format !== "yaos-pathology-trace-v1") throw new Error("unsupported pathology trace format");
	return manifest;
}

export function* readFrozenFrames(path: string): Generator<Uint8Array, void, void> {
	const descriptor = openSync(path, "r");
	try {
		const fileBytes = fstatSync(descriptor).size;
		const magic = Buffer.alloc(FRAME_MAGIC.byteLength);
		if (readSync(descriptor, magic, 0, magic.byteLength, null) !== magic.byteLength || !magic.equals(FRAME_MAGIC)) {
			throw new Error(`invalid frozen trace magic in ${basename(path)}`);
		}
		let offset = FRAME_MAGIC.byteLength;
		while (offset < fileBytes) {
			const header = Buffer.allocUnsafe(4);
			if (readSync(descriptor, header, 0, 4, null) !== 4) throw new Error("truncated frozen frame header");
			offset += 4;
			const length = header.readUInt32LE(0);
			if (length === 0 || offset + length > fileBytes) throw new Error("invalid frozen frame length");
			const bytes = new Uint8Array(length);
			if (readSync(descriptor, bytes, 0, length, null) !== length) throw new Error("truncated frozen frame");
			offset += length;
			yield bytes;
		}
		if (offset !== fileBytes) throw new Error("frozen frame stream did not end at EOF");
	} finally {
		closeSync(descriptor);
	}
}

export function validateFrozenTrace(directory: string): FrozenTraceManifest {
	const manifest = readTraceManifest(directory);
	const hashFile = (name: string): string => sha256(readFileSync(join(directory, name)));
	if (hashFile("base.update") !== manifest.base.sha256) throw new Error("base update digest mismatch");
	if (hashFile("updates.bin") !== manifest.updates.sha256) throw new Error("update stream digest mismatch");
	if (hashFile("candidates.bin") !== manifest.candidates.sha256) throw new Error("candidate stream digest mismatch");
	if (hashFile("semantic.jsonl") !== manifest.semantic.sha256) throw new Error("semantic stream digest mismatch");
	let updateFrames = 0;
	for (const _update of readFrozenFrames(join(directory, "updates.bin"))) updateFrames++;
	let candidateFrames = 0;
	for (const _update of readFrozenFrames(join(directory, "candidates.bin"))) candidateFrames++;
	if (updateFrames !== manifest.updates.frames || candidateFrames !== manifest.candidates.frames) {
		throw new Error("frozen frame count mismatch");
	}
	return manifest;
}
