/** cloneNotice.ts and ObsidianSideFiles.storeDirs (identity-per-store §8): the optional clone notice. */
import { test } from "node:test";
import assert from "node:assert/strict";
import { CLONE_NOTICE_WINDOW_MS, cloneNoticeDue, cloneNoticeText } from "./cloneNotice";
import type { AdapterApi, AdapterStatLike } from "./obsidianApi";
import { MAX_SCANNED_STORE_DIRS, ObsidianSideFiles } from "./sideFiles";

const OWN = "dev-own0000000000000";
const B = "dev-B000000000000000";
const NOW = 1_800_000_000_000;

test("cloneNoticeDue: another store's mirror within a day; never the own store, no mirror, old or malformed dirs", () => {
	assert.equal(cloneNoticeDue(OWN, [], NOW), false);
	assert.equal(cloneNoticeDue(OWN, [{ deviceId: B, newestMirrorMs: NOW - 1000 }], NOW), true);
	assert.equal(cloneNoticeDue(OWN, [{ deviceId: B, newestMirrorMs: NOW - CLONE_NOTICE_WINDOW_MS }], NOW), true, "the edge counts");
	assert.equal(cloneNoticeDue(OWN, [{ deviceId: B, newestMirrorMs: NOW - CLONE_NOTICE_WINDOW_MS - 1 }], NOW), false);
	assert.equal(cloneNoticeDue(OWN, [{ deviceId: B, newestMirrorMs: NOW + 60_000 }], NOW), true, "a skewed clock's future mtime");
	assert.equal(cloneNoticeDue(OWN, [{ deviceId: B, newestMirrorMs: NOW + 2 * CLONE_NOTICE_WINDOW_MS }], NOW), false);
	assert.equal(cloneNoticeDue(OWN, [{ deviceId: B, newestMirrorMs: null }], NOW), false);
	assert.equal(cloneNoticeDue(OWN, [{ deviceId: OWN, newestMirrorMs: NOW }], NOW), false);
	assert.equal(cloneNoticeDue(OWN, [{ deviceId: "short", newestMirrorMs: NOW }, { deviceId: "../x/y000000000000000", newestMirrorMs: NOW }], NOW), false);
	assert.equal(cloneNoticeDue(OWN, [{ deviceId: OWN, newestMirrorMs: NOW }, { deviceId: B, newestMirrorMs: NOW - 5 }], NOW), true);
});

test("cloneNoticeText names the plugin dir under the vault's configDir", () => {
	assert.equal(cloneNoticeText(".obsidian/plugins/yaos"), "YAOS: this vault folder looks synced by another tool as well. YAOS works, but two sync tools on one folder produce conflicting copies; exclude `.obsidian/plugins/yaos/` from the other tool.");
	assert.match(cloneNoticeText(".config/plugins/yaos/"), /exclude `\.config\/plugins\/yaos\/` from/);
});

/** A read-only view of a tree of files with mtimes; every call is recorded. */
function treeAdapter(files: Record<string, number>): AdapterApi & { calls: string[] } {
	const calls: string[] = [];
	const deny = (op: string) => async (p: string): Promise<never> => {
		calls.push(`${op} ${p}`);
		throw new Error(`${op} not allowed`);
	};
	const under = (p: string) => Object.keys(files).filter((f) => f.startsWith(`${p}/`));
	return {
		calls,
		exists: async (p) => (calls.push(`exists ${p}`), p in files || under(p).length > 0),
		stat: async (p): Promise<AdapterStatLike | null> => {
			calls.push(`stat ${p}`);
			const m = files[p];
			return m === undefined ? (under(p).length > 0 ? { type: "folder", size: 0, mtime: 0, ctime: 0 } : null) : { type: "file", size: 1, mtime: m, ctime: m };
		},
		list: async (p) => {
			calls.push(`list ${p}`);
			const rest = under(p).map((f) => f.slice(p.length + 1));
			return {
				files: rest.filter((r) => !r.includes("/")).map((r) => `${p}/${r}`),
				folders: [...new Set(rest.filter((r) => r.includes("/")).map((r) => `${p}/${r.slice(0, r.indexOf("/"))}`))],
			};
		},
		read: deny("read"), readBinary: deny("readBinary"), write: deny("write"), writeBinary: deny("writeBinary"),
		mkdir: deny("mkdir"), remove: deny("remove"), rename: deny("rename"),
	};
}

test("storeDirs: each well-formed store dir with its newest mirror mtime; read-only", async () => {
	const S = ".obsidian/plugins/yaos/state";
	const a = treeAdapter({
		[`${S}/${OWN}/outbox-a.bin`]: 5,
		[`${S}/${B}/outbox-a.bin`]: 10,
		[`${S}/${B}/synced-b.bin`]: 30,
		[`${S}/${B}/snapshots/x.snap`]: 99,
		[`${S}/${B}/other.bin`]: 77,
		[`${S}/dev-C000000000000000/snapshots/y.snap`]: 1,
		[`${S}/bad name/outbox-a.bin`]: 50,
		[`${S}/outbox-a.bin`]: 60,
	});
	const dirs = await new ObsidianSideFiles(a, ".obsidian/plugins/yaos").storeDirs();
	assert.deepEqual([...dirs].sort((x, y) => x.deviceId.localeCompare(y.deviceId)), [
		{ deviceId: B, newestMirrorMs: 30 },
		{ deviceId: "dev-C000000000000000", newestMirrorMs: null },
		{ deviceId: OWN, newestMirrorMs: 5 },
	]);
	assert.deepEqual(a.calls.filter((c) => !/^(exists|stat|list) /.test(c)), [], "nothing but exists, list and stat");
	assert.deepEqual(await new ObsidianSideFiles(treeAdapter({}), ".obsidian/plugins/yaos").storeDirs(), [], "no state dir");
});

test("storeDirs: bounded", async () => {
	const files: Record<string, number> = {};
	for (let i = 0; i < MAX_SCANNED_STORE_DIRS + 10; i++) files[`p/state/dev-${String(i).padStart(16, "0")}/outbox-a.bin`] = i;
	assert.equal((await new ObsidianSideFiles(treeAdapter(files), "p").storeDirs()).length, MAX_SCANNED_STORE_DIRS);
});
