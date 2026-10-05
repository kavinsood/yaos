import { test } from "node:test";
import assert from "node:assert/strict";
import type { VaultPath } from "../../core/types";
import { sha256Hex } from "../../core/hash/sha256";
import { assertConverged, crashPoints, label, runCrashed } from "./testkit/crash";
import { World } from "./testkit/world";

const P = (s: string): VaultPath => s as VaultPath;
const visible = (w: World): Record<string, string> => w.vault.snapshot();

async function everyCrashPoint(make: () => Promise<World>, check: (w: World, where: string) => Promise<void> | void): Promise<number> {
	const { points, dry } = await crashPoints(make);
	await check(dry, "dry");
	await assertConverged(dry, "dry");
	assert.ok(points.length > 0);
	const failures: string[] = [];
	for (const p of points) {
		try {
			const w = await runCrashed(make, p);
			await check(w, label(p));
			await assertConverged(w, label(p));
		} catch (e) {
			failures.push(`${label(p)}: ${(e as Error).message.split("\n").slice(0, 3).join(" | ")}`);
		}
	}
	assert.deepEqual(failures, [], `${failures.length}/${points.length} crash points failed`);
	return points.length;
}

test("crash at every point of a same-line conflict merge: one copy, user text kept, disk == CRDT", async () => {
	const make = async (): Promise<World> => {
		const w = new World();
		await w.boot();
		const id = w.log.remoteCreate(P("c.md"), "title\nshared line\nend\n", "doc-c00000000000000000" as never);
		await w.sync();
		w.log.remoteEdit(id, (t) => {
			const at = t.toString().indexOf("shared line");
			t.delete(at, "shared line".length);
			t.insert(at, "remote version");
		});
		w.vault.userWrite("c.md", "title\nlocal version\nend\n");
		return w;
	};
	const n = await everyCrashPoint(make, (w, where) => {
		const copies = w.conflictCopies();
		assert.equal(copies.length, 1, `${where}: copies ${JSON.stringify(copies)}`);
		assert.equal(w.vault.text(copies[0]!), "title\nlocal version\nend\n", where);
		assert.equal(w.vault.text("c.md"), "title\nremote version\nend\n", where);
	});
	assert.ok(n >= 8, `only ${n} crash points`);
});

test("crash at every point of a mixed sync: remote rename+edit, merge, delete, create, local creates", async () => {
	const pic = new Uint8Array([137, 80, 78, 71, 1, 2]);
	const make = async (): Promise<World> => {
		const w = new World();
		await w.boot();
		const a = w.log.remoteCreate(P("a.md"), "a\n");
		const x = w.log.remoteCreate(P("x.md"), "x1\nx2\n");
		const d = w.log.remoteCreate(P("old/del.md"), "d\n");
		await w.sync();
		w.log.remoteRename(a, P("dir/b.md"));
		w.log.remoteEdit(a, (t) => t.insert(t.length, "a2\n"));
		w.log.remoteEdit(x, (t) => t.insert(0, "x0\n"));
		w.vault.userWrite("x.md", "x1\nx2\nx3\n");
		w.log.remoteDelete(d);
		w.log.remoteCreate(P("new.md"), "n\n");
		w.vault.userWrite("local.md", "l\n");
		w.vault.userWrite("pic.png", pic);
		return w;
	};
	const n = await everyCrashPoint(make, (w, where) => {
		const snap = visible(w);
		assert.deepEqual(Object.keys(snap).sort(), ["dir/b.md", "local.md", "new.md", "pic.png", "x.md"], where);
		assert.equal(snap["dir/b.md"], "a\na2\n", where);
		assert.equal(snap["x.md"], "x0\nx1\nx2\nx3\n", where);
		assert.equal(snap["local.md"], "l\n", where);
		assert.equal(sha256Hex(w.vault.bytesOf("pic.png")!), sha256Hex(pic), where);
		assert.equal(w.vault.trashed.length, 1, `${where}: trashed ${w.vault.trashed.map((t) => t.path).join(",")}`);
		// Gap (recorded): folders emptied before a crash are not remembered, so only the uncrashed run removes them.
		if (where === "dry") assert.equal(w.vault.hasFolder("old"), false, `${where}: emptied folder left behind`);
		assert.equal(w.vault.fileManagerRenames, 0, where);
	});
	assert.ok(n >= 20, `only ${n} crash points`);
});

test("crash at every point of a blob keep-both", async () => {
	const mine = new Uint8Array([2, 2]);
	const theirs = new Uint8Array([3, 3, 3]);
	const make = async (): Promise<World> => {
		const w = new World();
		w.vault.userWrite("k.png", new Uint8Array([1]));
		await w.boot();
		await w.sync();
		const id = w.log.liveByPath(P("k.png"))!;
		w.vault.userWrite("k.png", mine);
		w.blobs!.put(theirs);
		w.log.remoteSetBlob(id, theirs);
		return w;
	};
	await everyCrashPoint(make, (w, where) => {
		assert.deepEqual(w.vault.bytesOf("k.png"), theirs, where);
		const copies = w.conflictCopies();
		assert.equal(copies.length, 1, `${where}: copies ${JSON.stringify(copies)}`);
		assert.deepEqual(w.vault.bytesOf(copies[0]!), mine, where);
		assert.ok(w.blobs!.server.has(sha256Hex(mine)), where);
	});
});

test("crash at every point of a remote path swap (rename cycle through a temp name)", async () => {
	const make = async (): Promise<World> => {
		const w = new World();
		await w.boot();
		const a = w.log.remoteCreate(P("a.md"), "A\n");
		const b = w.log.remoteCreate(P("b.md"), "B\n");
		await w.sync();
		w.log.remoteRename(a, P("tmp-x.md"));
		w.log.remoteRename(b, P("a.md"));
		w.log.remoteRename(a, P("b.md"));
		return w;
	};
	await everyCrashPoint(make, (w, where) => {
		assert.deepEqual(visible(w), { "a.md": "B\n", "b.md": "A\n" }, where);
	});
});

test("crash at every point of a local import (md + blob + empty md)", async () => {
	const make = async (): Promise<World> => {
		const w = new World();
		w.vault.userWrite("n/one.md", "one\n");
		w.vault.userWrite("empty.md", "");
		w.vault.userWrite("b.bin", new Uint8Array([4, 4]));
		await w.boot();
		return w;
	};
	await everyCrashPoint(make, (w, where) => {
		assert.deepEqual(Object.keys(visible(w)).sort(), ["b.bin", "empty.md", "n/one.md"], where);
		assert.equal(w.vault.text("n/one.md"), "one\n", where);
		assert.equal(w.vault.text("empty.md"), "", where);
	});
});

test("crash at every point of local rename + local delete + remote edit of the renamed doc", async () => {
	const make = async (): Promise<World> => {
		const w = new World();
		await w.boot();
		const a = w.log.remoteCreate(P("r/a.md"), "a\n");
		w.log.remoteCreate(P("gone.md"), "g\n");
		await w.sync();
		w.vault.userRename("r/a.md", "s/a2.md");
		w.vault.userDelete("gone.md");
		w.log.remoteEdit(a, (t) => t.insert(t.length, "remote\n"));
		return w;
	};
	await everyCrashPoint(make, (w, where) => {
		assert.deepEqual(visible(w), { "s/a2.md": "a\nremote\n" }, where);
		assert.equal(w.vault.trashed.length, 0, where);
	});
});
