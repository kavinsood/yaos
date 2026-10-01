import { strict as assert } from "node:assert";
import { canonicalMarkdownHash, exactMarkdownDiskFingerprint } from "@shared/markdownCodec";
import { ConflictEpisodes, CONFLICT_RELOCATION_ATTEMPTS, type ConflictEpisodeState } from "../../src/sync/conflictEpisodes";
import { suite } from "../harness.ts";
import { installDomCrypto } from "./helpers/installDomCrypto.ts";

installDomCrypto();
const tests = suite("artifact-relocation");
const input = { bodyId: "stable-body", path: "Note.md", disk: "unique disk", body: "unique body", base: "unique base", device: "test" };

function fixture(initial: ConflictEpisodeState = { episodes: {}, artifacts: {} }, disk = new Map<string, string>()) {
	let saved = structuredClone(initial);
	let failAt = "";
	let failure = false;
	let maxPersistedBytes = 0;
	const writes: string[] = [];
	const port = {
		read: async (path: string) => disk.get(path) ?? null,
		write: async (path: string, content: string, expected: string | null) => {
			assert.equal(disk.get(path) ?? null, expected);
			assert.ok(saved.episodes[input.bodyId]?.pendingAppend, "intent durable before write");
			assert.ok(saved.episodes[input.bodyId]!.parts.includes(path), "mapping durable before write");
			if (failAt === "before-write" && !failure) { failure = true; throw new Error("stopped"); }
			disk.set(path, content);
			writes.push(path);
			if (failAt === "after-write" && !failure) { failure = true; throw new Error("stopped"); }
		},
		persist: async (state: ConflictEpisodeState) => {
			saved = structuredClone(state);
			maxPersistedBytes = Math.max(maxPersistedBytes, Buffer.byteLength(JSON.stringify(state)));
			const pending = state.episodes[input.bodyId]?.pendingAppend;
			if (failAt === "mapped" && !failure && pending?.relocation && pending.relocation.attempts > 0 && pending.version.part !== pending.relocation.root) {
				failure = true; throw new Error("stopped");
			}
		},
		changed: () => {}, notify: () => {},
	};
	return { store: new ConflictEpisodes(structuredClone(initial), port), disk, writes, saved: () => structuredClone(saved),
		fail: (boundary: string) => { failAt = boundary; }, port, maxPersistedBytes: () => maxPersistedBytes };
}

async function planAppend(current: ReturnType<typeof fixture>, text: string, part = current.store.get(input.bodyId)!.parts[0]!) {
	const episode = current.store.get(input.bodyId)!;
	const expected = current.disk.get(part)!;
	const hash = await canonicalMarkdownHash(text);
	const label = `\n\n## disk version\nSHA-256: ${hash}\n\n`;
	const content = expected + label + text;
	episode.pendingAppend = { version: { hash, part, offset: expected.length + label.length, length: text.length,
		device: "test", at: new Date().toISOString(), source: "disk" }, expected, content, artifactHash: (await exactMarkdownDiskFingerprint(content)).hash };
}

tests.test("unfinished append relocates all committed versions without storing permanent fulltext history", async () => {
	const current = fixture();
	try {
		const original = await current.store.preserve(input);
		const previous = structuredClone(current.store.get(input.bodyId)!);
		const oldContent = current.disk.get(original)!;
		await planAppend(current, "next input");
		const foreign = "\uFEFFunrelated occupant\r\n[[keep me]]";
		current.disk.set(original, foreign);
		assert.equal(await current.store.readVersion(input.bodyId, previous.latestDiskHash!), input.disk);
		const relocated = current.store.get(input.bodyId)!;
		assert.equal(relocated.id, previous.id);
		assert.equal(relocated.versions.length, previous.versions.length + 1);
		assert.deepEqual(relocated.versions.slice(0, previous.versions.length).map(({ part, ...version }) => version), previous.versions.map(({ part, ...version }) => version));
		assert.deepEqual(relocated.obstructions, [original]);
		assert.ok(!JSON.stringify(current.saved()).includes(input.disk));
		assert.notEqual(relocated.parts[0], original);
		assert.equal(current.disk.get(original), foreign);
		assert.equal(await current.store.isArtifact(original, oldContent), false);
		assert.equal(await current.store.isArtifact(original, foreign), false);
		const replacements = new Map(relocated.parts.map((part) => [part, current.disk.get(part)!]));
		await current.store.close(input.bodyId);
		assert.equal(current.store.get(input.bodyId), undefined);
		for (const [part, content] of replacements) {
			assert.equal(current.disk.get(part), content);
			assert.equal(await current.store.isArtifact(part, content), true);
		}
	} finally { current.store.dispose(); }
});

for (const boundary of ["mapped", "before-write", "after-write"]) {
	tests.test(`restart after relocation ${boundary} preserves mapping, every unique version and untouched sibling links`, async () => {
		const current = fixture();
		await current.store.preserve({ ...input, disk: "first".repeat(130_000) });
		await current.store.preserve({ ...input, disk: "second".repeat(110_000) });
		const previous = structuredClone(current.store.get(input.bodyId)!);
		const original = previous.parts[0]!;
		await planAppend(current, "next");
		current.disk.set(original, "foreign original");
		current.fail(boundary);
		await assert.rejects(current.store.preserve({ ...input, path: "Renamed.md", disk: "next" }), /stopped/);
		const planned = current.saved();
		const selected = planned.episodes[input.bodyId]!.parts[0]!;
		assert.notEqual(selected, original);
		assert.ok(planned.episodes[input.bodyId]!.pendingAppend);
		current.store.dispose();
		const restarted = fixture(planned, current.disk);
		try {
			await restarted.store.preserve({ ...input, path: "Renamed.md", disk: "next" });
			const episode = restarted.store.get(input.bodyId)!;
			assert.equal(episode.id, previous.id);
			assert.equal(episode.parts[0], selected);
			assert.equal(restarted.disk.get(original), "foreign original");
			assert.equal(episode.pendingAppend, undefined);
			assert.equal(new Set(episode.versions.map((version) => version.hash)).size, episode.versions.length);
			for (const part of episode.parts.slice(1)) assert.ok(restarted.disk.get(part)!.includes(`[[${original}]]`));
			assert.equal(episode.relocations?.[original], selected);
			for (const text of ["first".repeat(130_000), "second".repeat(110_000), input.body, input.base, "next"]) {
				assert.equal(await restarted.store.readVersion(input.bodyId, await canonicalMarkdownHash(text)), text);
			}
		} finally { restarted.store.dispose(); }
	});
}

tests.test("a replacement obstructed after durable selection chooses another stable logical-part destination", async () => {
	const current = fixture();
	const original = await current.store.preserve(input);
	await planAppend(current, "next input");
	current.disk.set(original, "first occupant");
	current.fail("mapped");
	await assert.rejects(current.store.preserve(input), /stopped/);
	const planned = current.saved();
	const selected = planned.episodes[input.bodyId]!.parts[0]!;
	current.disk.set(selected, "second occupant");
	current.store.dispose();
	const restarted = fixture(planned, current.disk);
	try {
		await restarted.store.preserve(input);
		assert.equal(current.disk.get(original), "first occupant");
		assert.equal(current.disk.get(selected), "second occupant");
		assert.deepEqual(restarted.store.get(input.bodyId)!.obstructions, [original, selected]);
		assert.ok(restarted.store.get(input.bodyId)!.parts[0]!.endsWith("part 1 2).md"));
		for (const text of [input.disk, input.body, input.base]) assert.equal(await restarted.store.readVersion(input.bodyId, await canonicalMarkdownHash(text)), text);
	} finally { restarted.store.dispose(); }
});

tests.test("collision attempts are bounded and exhaustion retains actionable pending history across restart", async () => {
	const current = fixture();
	const original = await current.store.preserve(input);
	const episode = current.store.get(input.bodyId)!;
	await planAppend(current, "next input");
	current.disk.set(original, "foreign original");
	for (let attempt = 1; attempt <= CONFLICT_RELOCATION_ATTEMPTS; attempt++) {
		current.disk.set(original.replace(/\.md$/, ` (YAOS conflict relocation ${episode.id} part 1 ${attempt}).md`), `occupant ${attempt}`);
	}
	const occupants = new Map(current.disk);
	await assert.rejects(current.store.preserve(input), /relocation exhausted.*move unrelated occupants/);
	assert.deepEqual(current.disk, occupants);
	assert.ok(current.saved().episodes[input.bodyId]!.error?.includes("move unrelated occupants"));
	assert.ok(current.saved().episodes[input.bodyId]!.pendingAppend?.content.includes(input.disk));
	assert.equal(current.saved().episodes[input.bodyId]!.pendingAppend!.relocation!.attempts, CONFLICT_RELOCATION_ATTEMPTS);
	current.store.dispose();
	const restarted = fixture(current.saved(), current.disk);
	try {
		await assert.rejects(restarted.store.preserve(input), /relocation exhausted/);
		assert.deepEqual(current.disk, occupants);
		const freed = original.replace(/\.md$/, ` (YAOS conflict relocation ${episode.id} part 1 ${CONFLICT_RELOCATION_ATTEMPTS}).md`);
		current.disk.delete(freed);
		assert.equal(await restarted.store.preserve(input), freed);
		assert.equal(restarted.store.get(input.bodyId)!.error, null);
		assert.equal(current.disk.get(original), "foreign original");
	} finally { restarted.store.dispose(); }
});

tests.test("legacy pendingAppend expected bytes migrate old version paths even without retained history", async () => {
	const current = fixture();
	const original = await current.store.preserve(input);
	current.fail("before-write");
	await assert.rejects(current.store.preserve({ ...input, disk: "later" }), /stopped/);
	const legacy = current.saved();
	delete legacy.episodes[input.bodyId]!.pendingAppend!.relocation;
	current.disk.set(original, "foreign legacy occupant");
	current.store.dispose();
	const restarted = fixture(legacy, current.disk);
	try {
		for (const text of [input.disk, input.body, input.base, "later"]) {
			assert.equal(await restarted.store.readVersion(input.bodyId, await canonicalMarkdownHash(text)), text);
		}
		assert.ok(restarted.store.get(input.bodyId)!.versions.every((version) => version.part !== original));
		assert.equal(current.disk.get(original), "foreign legacy occupant");
	} finally { restarted.store.dispose(); }
});

tests.test("completed artifact corruption reports the hash-only limitation and never trusts a matching version slice", async () => {
	const current = fixture();
	const original = await current.store.preserve(input);
	const originalBytes = current.disk.get(original)!;
	const legacy = current.saved();
	delete legacy.episodes[input.bodyId]!.partHashes;
	current.store.dispose();
	const restarted = fixture(legacy, current.disk);
	try {
		assert.equal(await restarted.store.readVersion(input.bodyId, await canonicalMarkdownHash(input.disk)), input.disk);
		assert.ok(!JSON.stringify(restarted.saved()).includes(input.disk));
		current.disk.set(original, `${current.disk.get(original)!}\nforeign extra bytes`);
		await assert.rejects(restarted.store.readVersion(input.bodyId, await canonicalMarkdownHash(input.disk)), /completed history cannot be reconstructed from hashes/);
		assert.equal(restarted.saved().artifacts[original], undefined);
		assert.ok(current.disk.get(original)!.endsWith("foreign extra bytes"));
		assert.ok(restarted.store.get(input.bodyId)!.obstructions?.includes(original));
		current.disk.set(original, originalBytes);
		assert.equal(await restarted.store.readVersion(input.bodyId, await canonicalMarkdownHash(input.disk)), input.disk);
	} finally { restarted.store.dispose(); }
});

tests.test("missing unfinished artifacts recover, and links inside preserved input are not rewritten", async () => {
	const current = fixture();
	try {
		const original = await current.store.preserve(input);
		const linkedText = `user text [[${original}]]`;
		await current.store.preserve({ ...input, disk: linkedText });
		await planAppend(current, "next input");
		current.disk.delete(original);
		assert.equal(await current.store.readVersion(input.bodyId, await canonicalMarkdownHash(linkedText)), linkedText);
		assert.notEqual(current.store.get(input.bodyId)!.parts[0], original);
	} finally { current.store.dispose(); }
});

tests.test("an unrelated completed sibling reports the limitation after safe pending recovery, without copying foreign contents", async () => {
	const current = fixture();
	await current.store.preserve({ ...input, disk: "first".repeat(130_000) });
	await current.store.preserve({ ...input, disk: "second".repeat(110_000) });
	const original = structuredClone(current.store.get(input.bodyId)!);
	await planAppend(current, "next input");
	current.disk.set(original.parts[0]!, "foreign first");
	current.disk.set(original.parts[1]!, "foreign sibling");
	try {
		await assert.rejects(current.store.preserve(input), /completed history cannot be reconstructed from hashes/);
		assert.equal(current.disk.get(original.parts[0]!), "foreign first");
		assert.equal(current.disk.get(original.parts[1]!), "foreign sibling");
		assert.equal(current.saved().episodes[input.bodyId]!.pendingAppend, undefined);
		assert.equal(current.saved().artifacts[original.parts[1]!], undefined);
		assert.ok(!JSON.stringify(current.saved()).includes("foreign sibling"));
	} finally { current.store.dispose(); }
});

tests.test("100 one-MiB siblings do not expand relocation payload or acquire rewritten backlinks", async () => {
	const current = fixture();
	const manyInput = { ...input, disk: "a".repeat(600_000) };
	const original = await current.store.preserve(manyInput);
	const episode = current.store.get(input.bodyId)!;
	const siblings = new Map<string, string>();
	for (let index = 0; index < 100; index++) {
		const part = `Sibling (YAOS conflict part ${index}).md`;
		const text = `${index}:` + "s".repeat(1024 * 1024);
		const header = `First part: [[${original}]]\n`;
		const content = header + text;
		const hash = await canonicalMarkdownHash(text);
		current.disk.set(part, content);
		siblings.set(part, content);
		episode.parts.push(part);
		episode.versions.push({ hash, part, offset: header.length, length: text.length, device: "test", at: "2026-10-01", source: "disk" });
		episode.partHashes![part] = (await exactMarkdownDiskFingerprint(content)).hash;
	}
	await current.port.persist(current.store.snapshot());
	const seeded = current.saved();
	for (const [part] of siblings) seeded.artifacts[part] = seeded.episodes[input.bodyId]!.partHashes![part]!;
	current.store.dispose();
	const staged = fixture(seeded, current.disk);
	await planAppend(staged, "next input");
	current.disk.set(original, "foreign original");
	staged.fail("mapped");
	await assert.rejects(staged.store.preserve(manyInput), /stopped/);
	const planned = staged.saved();
	assert.ok(staged.maxPersistedBytes() < 2 * 1024 * 1024, "every persist is bounded by one unfinished part, not 100 sibling texts");
	assert.equal(Object.keys(planned.episodes[input.bodyId]!.pendingAppend!).length, 5);
	const selected = planned.episodes[input.bodyId]!.parts[0]!;
	staged.store.dispose();
	const recovered = fixture(planned, current.disk);
	try {
		await recovered.store.preserve(manyInput);
		assert.deepEqual(recovered.writes, [selected]);
		assert.equal(recovered.store.get(input.bodyId)!.parts.length, 101);
		assert.equal(recovered.store.get(input.bodyId)!.pendingAppend, undefined);
		assert.ok(Buffer.byteLength(JSON.stringify(recovered.saved())) < 100_000);
		for (const [part, content] of siblings) assert.equal(current.disk.get(part), content);
		assert.equal(recovered.store.get(input.bodyId)!.relocations?.[original], selected);
	} finally { recovered.store.dispose(); }
});

tests.test("a raced destination create relocates instead of overwriting the new occupant", async () => {
	const disk = new Map<string, string>();
	let saved: ConflictEpisodeState = { episodes: {}, artifacts: {} };
	let original = "";
	const store = new ConflictEpisodes(saved, {
		read: async (path) => disk.get(path) ?? null,
		write: async (path, content, expected) => {
			assert.ok(saved.episodes[input.bodyId]!.pendingAppend);
			if (!original) { original = path; disk.set(path, "raced occupant"); throw new Error("CAS rejected"); }
			assert.equal(disk.get(path) ?? null, expected);
			disk.set(path, content);
		},
		persist: async (state) => { saved = structuredClone(state); },
		changed: () => {}, notify: () => {},
	});
	try {
		const selected = await store.preserve(input);
		assert.notEqual(selected, original);
		assert.equal(disk.get(original), "raced occupant");
		assert.equal(await store.readVersion(input.bodyId, await canonicalMarkdownHash(input.disk)), input.disk);
	} finally { store.dispose(); }
});

await tests.done();
