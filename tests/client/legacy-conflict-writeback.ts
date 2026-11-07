import { webcrypto } from "node:crypto";
import { TFile, type App } from "obsidian";
import * as Y from "yjs";
import { DiskMirror } from "../../src/sync/diskMirror";
import { VaultSync } from "../../src/sync/vaultSync";
import type { EditorBindingManager } from "../../src/sync/editorBinding";
import { isMarkdownSyncable } from "../../src/types";
import { partialOf } from "../mocks/productFixture";
import { suite } from "../harness";

const s = suite("legacy-conflict-writeback");
Object.defineProperty(globalThis, "window", { value: { crypto: webcrypto }, configurable: true });

const artifact = "note (YAOS conflict - crdt from Laptop 2026-08-27T11-05-00Z).md";
const paths = [artifact, artifact.replace(/\.md$/, ".MD"), "note.md"];

for (const path of paths) {
	s.test(`writeback respects local-only policy: ${path}`, async () => {
		const doc = new Y.Doc();
		const text = doc.getText("body");
		text.insert(0, "remote content");
		const disk = new Map<string, string>();
		const errors: unknown[] = [];
		const app = partialOf<App>({
			vault: {
				getAbstractFileByPath: (p) => disk.has(p) ? Object.assign(new TFile(), { path: p }) : null,
				read: async (file) => disk.get(file.path)!,
				create: async (p, content) => { disk.set(p, content); return Object.assign(new TFile(), { path: p }); },
				modify: async (file, content) => { disk.set(file.path, content); },
			},
		});
		const mirror = new DiskMirror(app, partialOf<VaultSync>({ getTextForPath: () => text }),
			partialOf<EditorBindingManager>({}), false, undefined, () => false);
		mirror.setFlightEventHandler((event) => { if (event.kind === "disk.write.failed") errors.push(event); });
		try {
			const localOnly = path !== "note.md";
			s.check(isMarkdownSyncable(path, [], ".obsidian") === !localOnly, "admission matches artifact policy");
			await mirror.flushWrite(path);
			s.check(disk.has(path) === !localOnly, "legacy CRDT artifact is not materialized; normal note is");
			disk.delete(path);
			await mirror.flushWrite(path, true);
			s.check(disk.has(path) === !localOnly, "forced write cannot resurrect a deleted local artifact");
			disk.set(path, "local safety copy");
			await mirror.flushWrite(path, true);
			s.check(disk.get(path) === (localOnly ? "local safety copy" : "remote content"), "existing artifact is not overwritten");
			s.check(errors.length === 0, "no hidden write errors");
		} finally { doc.destroy(); }
	});
}

s.test("reconcile does not plan writes for previously synced conflict artifacts", () => {
	const doc = new Y.Doc();
	const sync: VaultSync = Object.assign(Object.create(VaultSync.prototype), {
		_pathIndexesDirty: false,
		_pathIndex: new Map(paths.map((p) => [p, p])),
		_deletedPathIndex: new Set(),
		_eventRing: [],
		sys: doc.getMap("sys"),
		debug: false,
		getTextForPath: () => doc.getText("body"),
	});
	doc.getText("body").insert(0, "remote");
	try {
		const absent = sync.reconcileVault(new Map(), new Set(), "authoritative");
		s.check(JSON.stringify(absent.createdOnDisk) === JSON.stringify(["note.md"]), "only normal missing notes are scheduled for creation");
		const present = sync.reconcileVault(new Map(paths.map((p) => [p, "local"])), new Set(paths), "authoritative");
		s.check(JSON.stringify(present.updatedOnDisk) === JSON.stringify(["note.md"]), "only normal existing notes are scheduled for overwrite");
	} finally { doc.destroy(); }
});

await s.done();
