import { strict as assert } from "node:assert";
import { canonicalMarkdownHash } from "@shared/markdownCodec";
import { ConflictEpisodes, type ConflictEpisodeState } from "../../src/sync/conflictEpisodes";
import { suite, until } from "../harness.ts";
import { installDomCrypto } from "./helpers/installDomCrypto.ts";

installDomCrypto();
const tests = suite("conflict-append-recovery");

for (const boundary of ["before-write", "after-write"] as const) {
	tests.test(`restart ${boundary} retains the planned episode, version and artifact path`, async () => {
		const disk = new Map<string, string>();
		let saved: ConflictEpisodeState = { episodes: {}, artifacts: {} };
		let fail = true;
		const port = {
			read: async (path: string) => disk.get(path) ?? null,
			write: async (path: string, content: string, expected: string | null) => {
				assert.equal(disk.get(path) ?? null, expected);
				if (fail && boundary === "before-write") throw new Error("process stopped before write");
				disk.set(path, content);
				if (fail) throw new Error("process stopped after write");
			},
			persist: async (state: ConflictEpisodeState) => { saved = structuredClone(state); },
			changed: () => {}, notify: () => {},
		};
		const first = new ConflictEpisodes(saved, port);
		await assert.rejects(first.preserve({ bodyId: "body", path: "Note.md", body: "remote", disk: "unique disk", device: "test" }), /process stopped/);
		first.dispose();
		const planned = structuredClone(saved.episodes.body!);
		assert.ok(planned.pendingAppend);
		fail = false;
		const restarted = new ConflictEpisodes(structuredClone(saved), port);
		try {
			await restarted.preserve({ bodyId: "body", path: "Renamed.md", body: "remote", disk: "unique disk", device: "test" });
			const episode = restarted.get("body")!;
			assert.equal(episode.id, planned.id);
			assert.deepEqual(episode.parts, planned.parts);
			assert.equal(episode.pendingAppend, undefined);
			assert.equal(disk.size, 1);
			assert.equal(await restarted.readVersion("body", await canonicalMarkdownHash("unique disk")), "unique disk");
			assert.equal(episode.versions.length, 2);
		} finally { restarted.dispose(); }
	});
}

tests.test("a changed artifact relocates durable pending input without overwriting the foreign content", async () => {
	const disk = new Map<string, string>();
	let saved: ConflictEpisodeState = { episodes: {}, artifacts: {} };
	let fail = true;
	const port = {
		read: async (path: string) => disk.get(path) ?? null,
		write: async (path: string, content: string, expected: string | null) => {
			assert.equal(disk.get(path) ?? null, expected);
			if (fail) throw new Error("disk unavailable");
			disk.set(path, content);
		},
		persist: async (state: ConflictEpisodeState) => { saved = structuredClone(state); },
		changed: () => {}, notify: () => {},
	};
	const first = new ConflictEpisodes(saved, port);
	await assert.rejects(first.preserve({ bodyId: "body", path: "Note.md", body: "remote", disk: "disk", device: "test" }));
	first.dispose();
	const path = saved.episodes.body!.parts[0]!;
	disk.set(path, "foreign artifact contents");
	fail = false;
	const restarted = new ConflictEpisodes(structuredClone(saved), port);
	try {
		const replacement = await restarted.preserve({ bodyId: "body", path: "Note.md", body: "remote", disk: "new disk", device: "test" });
		assert.notEqual(replacement, path);
		assert.equal(disk.get(path), "foreign artifact contents");
		assert.equal(saved.episodes.body!.pendingAppend, undefined);
		assert.equal(saved.episodes.body!.error, null);
		assert.equal(saved.artifacts[path], undefined);
		for (const text of ["disk", "new disk", "remote"]) {
			assert.equal(await restarted.readVersion("body", await canonicalMarkdownHash(text)), text);
		}
	} finally { restarted.dispose(); }
});

tests.test("an artifact failure emits one coalesced discovery notice and keeps mobile command attention", async () => {
	const notices: string[][] = [];
	const episodes = new ConflictEpisodes({ episodes: {}, artifacts: {} }, {
		read: async () => null,
		write: async () => { throw new Error("artifact destination unavailable"); },
		persist: async () => {}, changed: () => {},
		notify: (bodyIds) => { notices.push(bodyIds); },
	});
	try {
		await assert.rejects(episodes.preserve({ bodyId: "body", path: "Note.md", disk: "unique input", body: "remote", device: "mobile" }));
		await until(() => notices.length === 1, { message: "failed preservation discovery notice" });
		assert.deepEqual(notices, [["body"]]);
		assert.ok(episodes.get("body")?.error);
		await assert.rejects(episodes.preserve({ bodyId: "body", path: "Note.md", disk: "unique input", body: "remote", device: "mobile" }));
		await new Promise<void>((resolve) => setTimeout(resolve, 300));
		assert.equal(notices.length, 1);
		assert.equal(episodes.list().length, 1);
	} finally { episodes.dispose(); }
});

await tests.done();
