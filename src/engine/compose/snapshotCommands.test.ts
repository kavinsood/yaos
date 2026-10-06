/**
 * Snapshot and diagnostics user commands through the whole client on the sim (host runtime -> protocol
 * -> composed engine): list, files, restore result, delete, diagnostics export, and errors without a runtime.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import type { EngineResultValue, UserCommand } from "../../protocol/messages";
import { VirtualClock } from "../../sim/clock";
import { SIM_SETTINGS, SimDevice } from "../../sim/device";
import { SimNet } from "../../sim/net";

function world(): { clock: VirtualClock; a: SimDevice } {
	const clock = new VirtualClock();
	clock.onError = (e) => {
		throw e;
	};
	const net = new SimNet(clock);
	const big = { ...SIM_SETTINGS, syncAttachments: true, maxAttachmentBytes: 8 * 1024 * 1024 };
	return { clock, a: new SimDevice({ name: "A", clock, net, settings: () => big }) };
}

type Settled = { ok: true; value: EngineResultValue } | { ok: false; error: Error };

/** Sends a command and runs the virtual clock until it settles. */
async function send(clock: VirtualClock, dev: SimDevice, command: UserCommand): Promise<Settled> {
	let out: Settled | null = null;
	dev.runtime.command(command).then((value) => { out = { ok: true, value }; }, (error: Error) => { out = { ok: false, error }; });
	for (let i = 0; i < 200 && out === null; i++) await clock.advance(50);
	if (out === null) throw new Error(`${command.t} did not settle`);
	return out;
}

async function ok<T extends EngineResultValue["t"]>(clock: VirtualClock, dev: SimDevice, command: UserCommand, t: T): Promise<Extract<EngineResultValue, { t: T }>> {
	const r = await send(clock, dev, command);
	if (!r.ok) throw r.error;
	assert.equal(r.value.t, t);
	return r.value as Extract<EngineResultValue, { t: T }>;
}

test("snapshot commands: create, list with reason, files, restore result, delete; bad ids are bad requests", async () => {
	const { clock, a } = world();
	a.vault.userWrite("a.md", "original a\n");
	a.vault.userWrite("d/b.md", "original b\n");
	a.vault.externalWrite("img/big.png", new Uint8Array(1024 * 1024 + 1).fill(3));
	void a.start();
	await clock.advance(3_000);
	await ok(clock, a, { t: "createSnapshot" }, "ok");
	const listed = await ok(clock, a, { t: "listSnapshots" }, "snapshots");
	assert.equal(listed.snapshots.length, 1);
	const snap = listed.snapshots[0]!;
	assert.equal(snap.reason, "manual");
	assert.equal(snap.files, 2, "the 1 MiB+ blob is not snapshotted");
	const files = await ok(clock, a, { t: "snapshotFiles", snapshotId: snap.id }, "snapshotFiles");
	assert.equal(files.snapshotId, snap.id);
	assert.deepEqual(files.files.map((f) => [f.path, f.kind, f.size]).sort(), [["a.md", "markdown", 11], ["d/b.md", "markdown", 11]]);
	assert.deepEqual(files.skipped, []);

	a.vault.externalWrite("a.md", "edited a\n");
	a.vault.userDelete("d/b.md");
	await clock.advance(3_000);
	const restored = await ok(clock, a, { t: "restoreSnapshot", snapshotId: snap.id, paths: null }, "restored");
	assert.equal(restored.restored, 2);
	assert.equal(restored.unchanged, 0);
	assert.equal(restored.copies.length, 1);
	assert.deepEqual(restored.failed, []);
	assert.equal(a.vault.textOf("a.md"), "original a\n");
	assert.equal(a.vault.textOf("d/b.md"), "original b\n");
	assert.equal(a.vault.textOf(restored.copies[0]!), "edited a\n");
	const again = await ok(clock, a, { t: "restoreSnapshot", snapshotId: snap.id, paths: ["a.md" as never] }, "restored");
	assert.deepEqual([again.restored, again.unchanged, again.copies.length], [0, 1, 0]);

	const after = await ok(clock, a, { t: "listSnapshots" }, "snapshots");
	assert.deepEqual(after.snapshots.map((s) => s.reason), ["manual", "restore", "restore"]);
	await ok(clock, a, { t: "deleteSnapshot", snapshotId: snap.id }, "ok");
	assert.deepEqual((await ok(clock, a, { t: "listSnapshots" }, "snapshots")).snapshots.map((s) => s.reason), ["restore", "restore"]);
	for (const c of [
		{ t: "deleteSnapshot", snapshotId: snap.id },
		{ t: "snapshotFiles", snapshotId: snap.id },
		{ t: "restoreSnapshot", snapshotId: "../outbox-a.bin", paths: null },
	] satisfies UserCommand[]) {
		const r = await send(clock, a, c);
		assert.equal(r.ok, false, c.t);
		if (!r.ok) assert.match(r.error.message, /^bad-request: (snapshot .* not found|not a snapshot id)$/, c.t);
	}
});

test("without a running vault runtime, snapshot and diagnostics commands fail instead of answering ok", async () => {
	const { clock, a } = world();
	a.setOnline(false); // fresh device, relay unreachable: the engine is protocol-ready but has no runtime
	void a.start();
	await clock.advance(2_000);
	assert.equal(a.vrt, null);
	for (const c of [
		{ t: "createSnapshot" }, { t: "listSnapshots" }, { t: "snapshotFiles", snapshotId: "000000001-manual" },
		{ t: "restoreSnapshot", snapshotId: "000000001-manual", paths: null }, { t: "deleteSnapshot", snapshotId: "000000001-manual" },
		{ t: "exportDiagnostics", includePaths: false },
	] satisfies UserCommand[]) {
		const r = await send(clock, a, c);
		assert.equal(r.ok, false, c.t);
		if (!r.ok) assert.match(r.error.message, /^not-ready: the sync engine is not running$/, c.t);
	}
	assert.deepEqual(await ok(clock, a, { t: "pause" }, "ok"), { t: "ok" });
});

test("exportDiagnostics on a running device: the whole event ring; paths only with opt-in", async () => {
	const { clock, a } = world();
	a.vault.userWrite("Private/a.md", "a\n");
	void a.start();
	await clock.advance(3_000);
	const plain = (await ok(clock, a, { t: "exportDiagnostics", includePaths: false }, "diagnostics")).bundle;
	assert.equal(plain.paths, null);
	assert.ok(plain.recentEvents.length > 0);
	assert.ok(!JSON.stringify(plain).includes("Private/a.md"));
	const withPaths = (await ok(clock, a, { t: "exportDiagnostics", includePaths: true }, "diagnostics")).bundle;
	assert.ok(Array.isArray(withPaths.paths));
	assert.ok(withPaths.recentEvents.length >= plain.recentEvents.length, "not cut to a fixed tail");
});
