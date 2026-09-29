import { strict as assert } from "node:assert";
import { ConflictEpisodes, type ConflictEpisodeState } from "../../src/sync/conflictEpisodes";
import { canonicalMarkdownHash } from "../../server/src/shared/markdownCodec";
import { MAX_CLIENT_MARKDOWN_BYTES } from "../../server/src/shared/durableLimits";
import { suite } from "../harness.ts";

const tests = suite("conflict-episodes");

function fixture(initial: ConflictEpisodeState = { episodes: {}, artifacts: {} }, files = new Map<string, string>()) {
	let saved = structuredClone(initial);
	const notices: string[][] = [];
	const store = new ConflictEpisodes(initial, {
		read: async (path) => files.get(path) ?? null,
		write: async (path, content, expected) => {
			assert.equal(files.get(path) ?? null, expected);
			files.set(path, content);
		},
		persist: async (state) => { saved = structuredClone(state); },
		changed: () => {}, notify: (ids) => notices.push(ids),
	});
	return { store, files, saved: () => saved, notices };
}

const input = { bodyId: "body-1", path: "Note.md", epoch: 1, disk: "disk edit", body: "remote edit", base: "common base", device: "B" };

tests.test("G5: artifact exemption requires both the recorded path and exact content", async () => {
	const { store, files } = fixture();
	const path = await store.preserve(input);
	const content = files.get(path)!;
	assert.equal(await store.isArtifact(path, content), true);
	assert.equal(await store.isArtifact(path, `${content}\nuser edit`), false);
	assert.equal(await store.isArtifact("Unrecorded (YAOS conflict).md", content), false);
	await store.close(input.bodyId);
	assert.equal(await store.isArtifact(path, content), true);
	store.dispose();
});

tests.test("G4: a single version above the soft cap gets its own bounded part", async () => {
	const { store, files } = fixture();
	const disk = "x".repeat(2 * 1024 * 1024);
	await store.preserve({ ...input, disk });
	const episode = store.get(input.bodyId)!;
	assert.equal(await store.readVersion(input.bodyId, episode.latestDiskHash!), disk);
	assert.equal(episode.parts.length, 2);
	for (const content of files.values()) assert.ok(Buffer.byteLength(content) < MAX_CLIENT_MARKDOWN_BYTES);
	store.dispose();
});

tests.test("G1/G3: body identity and all versions survive restart, rename and semantic reset", async () => {
	const first = fixture();
	await first.store.preserve(input);
	const original = first.store.get(input.bodyId)!;
	first.store.dispose();
	const restarted = fixture(first.saved(), first.files);
	await restarted.store.rename(input.bodyId, "Renamed.md");
	await restarted.store.preserve({ ...input, path: "Renamed.md", epoch: 9, disk: "next disk edit", body: "next remote edit" });
	const episode = restarted.store.get(input.bodyId)!;
	assert.equal(episode.id, original.id);
	assert.equal(episode.path, "Renamed.md");
	assert.equal(episode.epoch, 9);
	assert.deepEqual(episode.parts, original.parts);
	for (const text of [input.base, input.disk, input.body, "next disk edit", "next remote edit"]) {
		assert.equal(await restarted.store.readVersion(input.bodyId, await canonicalMarkdownHash(text)), text);
	}
	restarted.store.dispose();
});

tests.test("G4: distinct autosaves append once; identical text and current-body text are deduplicated", async () => {
	const current = fixture();
	await current.store.preserve(input);
	for (const disk of ["save 1", "save 2", "save 3", "save 3", input.body]) await current.store.preserve({ ...input, disk });
	assert.equal(current.files.size, 1);
	assert.equal(current.store.get(input.bodyId)!.versions.length, 6);
	for (const disk of ["save 1", "save 2", "save 3"]) assert.equal(await current.store.readVersion(input.bodyId, await canonicalMarkdownHash(disk)), disk);
	current.store.dispose();
});

tests.test("G4: rollover retains every version, linking sibling parts to the first", async () => {
	const current = fixture();
	for (const disk of ["a".repeat(600_000), "b".repeat(600_000), "c".repeat(1_500_000)]) await current.store.preserve({ ...input, disk });
	const episode = current.store.get(input.bodyId)!;
	assert.equal(episode.parts.length, 3);
	for (const part of episode.parts.slice(1)) assert.ok(current.files.get(part)!.includes(`[[${episode.parts[0]}]]`));
	assert.equal((await current.store.readVersion(input.bodyId, episode.latestDiskHash!)).length, 1_500_000);
	current.store.dispose();
});

tests.test("G4: an impossible oversized single version leaves an actionable durable error", async () => {
	const current = fixture();
	await assert.rejects(current.store.preserve({ ...input, disk: "x".repeat(MAX_CLIENT_MARKDOWN_BYTES) }), /size limit/);
	assert.ok(current.saved().episodes[input.bodyId]!.error?.includes("keep the original file"));
	for (const content of current.files.values()) assert.ok(new TextEncoder().encode(content).length <= MAX_CLIENT_MARKDOWN_BYTES);
	current.store.dispose();
});

tests.test("G3: resolution/deletion keeps artifacts; a later conflict starts a new episode", async () => {
	const current = fixture();
	await current.store.preserve(input);
	const previousId = current.store.get(input.bodyId)!.id;
	const previousPath = current.store.get(input.bodyId)!.parts[0]!;
	assert.equal(await current.store.isArtifact(previousPath, current.files.get(previousPath)!), true);
	assert.equal(await current.store.isArtifact(previousPath, "user replaced the artifact"), false);
	await current.store.close(input.bodyId);
	assert.equal(current.store.list().length, 0);
	assert.ok(current.files.has(previousPath));
	await current.store.preserve(input);
	assert.notEqual(current.store.get(input.bodyId)!.id, previousId);
	assert.equal(current.files.size, 2);
	current.store.dispose();
});

tests.test("G1/G5: a startup burst emits one notice, never another for autosaves or remote edits", async () => {
	const current = fixture();
	for (const bodyId of ["a", "b", "c"]) await current.store.preserve({ ...input, bodyId });
	await new Promise((resolve) => setTimeout(resolve, 350));
	assert.equal(current.notices.length, 1);
	assert.equal(current.notices[0]!.length, 3);
	await current.store.preserve({ ...input, bodyId: "a", disk: "new edit" });
	await new Promise((resolve) => setTimeout(resolve, 350));
	assert.equal(current.notices.length, 1);
	current.store.dispose();
});

await tests.done();
