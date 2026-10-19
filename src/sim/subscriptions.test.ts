/**
 * Stream subscriptions on the composed sim (host + protocol + engine + SimRelay, DESIGN §d.7): a device is pushed
 * the rows of the notes it has open and is sent skips for the rest, which it reads later and still writes to disk;
 * the deferral of those reads per device class; the set across relay restarts (kept in the attachment, or lost and
 * resent).
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import type { DeviceId, StreamName } from "../core/types";
import { VirtualClock } from "./clock";
import { SimDevice, type SimDeviceOptions } from "./device";
import { SimNet } from "./net";

function world(opts: Record<string, Partial<SimDeviceOptions>> = {}): { clock: VirtualClock; net: SimNet; a: SimDevice; b: SimDevice } {
	const clock = new VirtualClock();
	clock.onError = (e) => {
		throw e;
	};
	const net = new SimNet(clock);
	const a = new SimDevice({ name: "A", clock, net, ...opts.A });
	const b = new SimDevice({ name: "B", clock, net, ...opts.B });
	return { clock, net, a, b };
}

async function boot(clock: VirtualClock, devs: readonly SimDevice[]): Promise<void> {
	for (const d of devs) void d.start();
	await clock.advance(10_000);
}

function streamOf(d: SimDevice, path: string): StreamName {
	const doc = d.vrt!.log.listDocs().find((x) => x.path === path && x.state === "live");
	assert.ok(doc, `${d.name}: ${path} known`);
	return d.vrt!.log.streamOf(doc.docId);
}

/** Types `text` at the end of the open view, one key every `everyMs`. */
async function typeIn(clock: VirtualClock, d: SimDevice, path: string, text: string, everyMs = 150): Promise<void> {
	const v = d.workspace.views_().find((x) => x.path === path);
	assert.ok(v, `${d.name}: ${path} open`);
	for (const ch of text) {
		v.edit(v.getText().length, 0, ch);
		await clock.advance(everyMs);
	}
}

function fanout(net: SimNet, d: SimDevice): { pushedRows: number; skippedRows: number } {
	return net.relay.fanout(d.deviceId as DeviceId);
}

test("a note the peer has not open reaches it as skips, is read and lands on its disk; once open it is pushed", async () => {
	const { clock, net, a, b } = world();
	a.vault.userWrite("n.md", "start ");
	await boot(clock, [a, b]);
	assert.equal(b.vault.textOf("n.md"), "start ");
	const stream = streamOf(a, "n.md");

	assert.ok(a.workspace.openFile("n.md"));
	await clock.advance(2_000);
	assert.ok(net.relay.subscriptionsOf(a.deviceId as DeviceId).every((s) => s?.includes(stream)), "A subscribed to its open note");
	assert.ok(net.relay.subscriptionsOf(b.deviceId as DeviceId).every((s) => s !== null && !s.includes(stream)), "B subscribed, not to it");
	const before = fanout(net, b);
	await typeIn(clock, a, "n.md", "typed while B has it closed");
	await clock.advance(15_000);
	const closed = fanout(net, b);
	assert.ok(closed.skippedRows - before.skippedRows >= 3, `B was sent skips for the closed note: ${JSON.stringify({ before, closed })}`);
	assert.equal(closed.pushedRows, before.pushedRows, "and no payload of it");
	assert.equal(b.vault.textOf("n.md"), "start typed while B has it closed", "B read it and wrote it to disk");
	assert.ok(b.vrt!.log.isIdle(), "B converged");

	assert.ok(b.workspace.openFile("n.md"));
	await clock.advance(2_000);
	await typeIn(clock, a, "n.md", " open");
	await clock.advance(15_000);
	const open = fanout(net, b);
	assert.equal(open.skippedRows, closed.skippedRows, "no skip once B has it open");
	assert.ok(open.pushedRows - closed.pushedRows >= 3, "its rows are pushed");
	assert.equal(b.vault.textOf("n.md"), "start typed while B has it closed open");
	assert.ok(b.vrt!.log.c.subs.stats.skippedRows > 0, "B's engine accounted the skipped rows");
});

test("a phone defers the read of a skipped note until it is quiet for 150 s (isIdle waits, status does not count it)", async () => {
	const real = { skipSettleMs: null, skipMaxDeferMs: null };
	const { clock, a, b } = world({ B: { mobile: true, tuning: real } });
	a.vault.userWrite("n.md", "start ");
	await boot(clock, [a, b]);
	assert.equal(b.vrt!.log.c.deviceClass, "phone");
	assert.ok(a.workspace.openFile("n.md"));
	await clock.advance(2_000);
	await typeIn(clock, a, "n.md", "burst", 1_000);
	await clock.advance(60_000);
	const log = b.vrt!.log;
	assert.equal(b.vault.textOf("n.md"), "start ", "not read yet: deferred");
	assert.equal(log.isIdle(), false, "a deferred stream is not converged");
	assert.equal(log.c.subs.deferredCount, 1);
	assert.equal(log.status().counts.staleStreams, 0, "nothing is being fetched");
	await clock.advance(100_000);
	assert.equal(b.vault.textOf("n.md"), "start burst", "read once quiet for settleMs");
	assert.ok(log.isIdle());

	// Opening a note ends its deferral at once.
	await typeIn(clock, a, "n.md", " more", 1_000);
	await clock.advance(10_000);
	assert.equal(b.vault.textOf("n.md"), "start burst");
	assert.ok(b.workspace.openFile("n.md"));
	await clock.advance(5_000);
	assert.equal(b.vault.textOf("n.md"), "start burst more", "bound: read now");
});

test("a relay restart keeps a small set (attachment); one that loses it is empty until the client resends", async () => {
	const { clock, net, a, b } = world();
	a.vault.userWrite("n.md", "x");
	await boot(clock, [a, b]);
	assert.ok(b.workspace.openFile("n.md"));
	await clock.advance(2_000);
	const stream = streamOf(b, "n.md");
	const subs = () => net.relay.subscriptionsOf(b.deviceId as DeviceId);
	assert.deepEqual(subs(), [[stream]]);

	net.relay.restart();
	assert.deepEqual(subs(), [[stream]], "restored from the attachment");
	await clock.advance(2_000);
	assert.deepEqual(subs(), [[stream]]);

	net.relay.restart(true);
	assert.deepEqual(subs(), [[]], "lost: empty");
	await clock.advance(2_000);
	assert.deepEqual(subs(), [[stream]], "resent on STREAM_RESEND");
	assert.equal(b.vrt!.log.c.sess.stats.sessions, 1, "the same session throughout");
});
