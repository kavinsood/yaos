import { strict as assert } from "node:assert";
import { mkdir, open, readFile, rename } from "node:fs/promises";
import { dirname, join } from "node:path";
import { canonicalMarkdownHash, exactMarkdownDiskFingerprint } from "@shared/markdownCodec";
import { ConflictEpisodes, type ConflictEpisodeState } from "../../src/sync/conflictEpisodes";
import { installDomCrypto } from "../client/helpers/installDomCrypto.ts";

installDomCrypto();
const [directory, mode, haltAt = ""] = process.argv.slice(2);
assert.ok(directory);
assert.ok(mode === "start" || mode === "prepare" || mode === "recover" || mode === "resolve");
const statePath = join(directory, "state.json");
const metadataPath = join(directory, "metadata.json");
const input = { bodyId: "process-body", path: "Note.md", body: "body text", base: "base text", device: "process" };
const texts = ["first unique disk ".repeat(35_000), "second unique disk ".repeat(35_000), input.body, input.base, "next unique input"];
const foreign = Buffer.from([0xff, 0x00, 0xfe, 0x0d, 0x0a, 0x61]);
let active = false;
let sequence = 0;
let saved: ConflictEpisodeState = { episodes: {}, artifacts: {} };
let selectedAtStart: string | undefined;

async function syncDirectory(path: string): Promise<void> {
	const handle = await open(path, "r");
	try { await handle.sync(); } finally { await handle.close(); }
}

async function durableWrite(path: string, content: string | Buffer, createOnly = false): Promise<void> {
	await mkdir(dirname(path), { recursive: true });
	const temporary = createOnly ? path : `${path}.${process.pid}.${++sequence}.tmp`;
	const handle = await open(temporary, "wx");
	try { await handle.writeFile(content); await handle.sync(); } finally { await handle.close(); }
	if (!createOnly) await rename(temporary, path);
	await syncDirectory(dirname(path));
}

async function checkpoint(name: string): Promise<void> {
	if (!active || name !== haltAt) return;
	process.send?.({ kind: "checkpoint", name });
	setInterval(() => {}, 1000);
	await new Promise<void>(() => {});
}

async function readArtifact(path: string): Promise<string | null> {
	try { return await readFile(join(directory!, "vault", path), "utf8"); }
	catch (error) {
		if (error instanceof Error && "code" in error && error.code === "ENOENT") return null;
		throw error;
	}
}

if (mode !== "start" && mode !== "prepare") {
	saved = JSON.parse(await readFile(statePath, "utf8")) as ConflictEpisodeState;
	selectedAtStart = saved.episodes[input.bodyId]?.parts[0];
}
const episodes = new ConflictEpisodes(saved, {
	read: readArtifact,
	write: async (path, content, expected) => {
		assert.equal(await readArtifact(path), expected);
		const pending = saved.episodes[input.bodyId]?.pendingAppend;
		assert.ok(pending, "write requires fsynced intent");
		assert.ok(saved.episodes[input.bodyId]!.parts.includes(path), "remap must be fsynced before write");
		await checkpoint("before-write");
		await durableWrite(join(directory!, "vault", path), content, expected === null);
		await checkpoint("after-write");
	},
	persist: async (state) => {
		await durableWrite(statePath, JSON.stringify(state));
		saved = structuredClone(state);
		const episode = state.episodes[input.bodyId];
		if (episode?.parts[0] !== selectedAtStart && episode?.pendingAppend?.relocation && episode.pendingAppend.relocation.attempts > 0) await checkpoint("selected");
		if (episode && !episode.pendingAppend && episode.parts.some((part) => part.includes("(YAOS conflict relocation"))) await checkpoint("committed");
	},
	changed: () => {}, notify: () => {},
});

try {
	if (mode === "start" || mode === "prepare") {
		await episodes.preserve({ ...input, disk: texts[0]! });
		await episodes.preserve({ ...input, disk: texts[1]! });
		const initial = structuredClone(episodes.get(input.bodyId)!);
		selectedAtStart = initial.parts[0];
		assert.equal(initial.parts.length, 2);
		await durableWrite(metadataPath, JSON.stringify({ initial, texts }));
		const part = initial.parts[0]!;
		const expected = (await readArtifact(part))!;
		const text = texts[4]!;
		const hash = await canonicalMarkdownHash(text);
		const label = `\n\n## disk version\nSHA-256: ${hash}\n\n`;
		const content = expected + label + text;
		episodes.get(input.bodyId)!.pendingAppend = { version: { hash, part, offset: expected.length + label.length,
			length: text.length, device: input.device, at: new Date().toISOString(), source: "disk" }, expected, content,
			artifactHash: (await exactMarkdownDiskFingerprint(content)).hash };
		saved = episodes.snapshot();
		await durableWrite(statePath, JSON.stringify(saved));
		await durableWrite(join(directory, "vault", initial.parts[0]!), foreign);
	}
	if (mode === "prepare") {
		console.log(JSON.stringify({ directory, statePath, metadataPath, bodyId: input.bodyId,
			obstructedPath: episodes.get(input.bodyId)!.parts[0], pendingVersionHash: episodes.get(input.bodyId)!.pendingAppend!.version.hash }));
	} else {
	active = true;
	await episodes.preserve({ ...input, path: "Renamed.md", disk: texts[4]! });
	const episode = structuredClone(episodes.get(input.bodyId)!);
	assert.equal(episode.versions.length, texts.length);
	assert.equal(new Set(episode.versions.map((version) => version.hash)).size, texts.length);
	for (const text of texts) assert.equal(await episodes.readVersion(input.bodyId, await canonicalMarkdownHash(text)), text);
	const initial = JSON.parse(await readFile(metadataPath, "utf8")) as { initial: { parts: string[] } };
	for (const part of episode.parts.slice(1)) assert.ok((await readArtifact(part))!.includes(`[[${initial.initial.parts[0]}]]`));
	assert.equal(episode.relocations?.[initial.initial.parts[0]!], episode.parts[0]);
	if (mode === "resolve") {
		await episodes.close(input.bodyId);
		for (const part of episode.parts) assert.equal(await episodes.isArtifact(part, (await readArtifact(part))!), true);
	}
	process.send?.({ kind: "result", state: episodes.snapshot(), episode });
	}
} finally { episodes.dispose(); }
