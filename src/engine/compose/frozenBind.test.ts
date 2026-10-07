/**
 * A view on a frozen doc binds once the doc is released (DESIGN §d.6). openDoc answers a frozen doc with
 * `bind{frozen}`; the host closes it and waits for a `bindable` (host/binding.ts). Found by the E7 suite-1 sim: a
 * conflict copy frozen by forged rows stayed unbound after releaseQuarantine, as nothing told the host it thawed.
 * Both entries: a view opened on an already frozen doc, and a bound view whose doc froze under it (docRetarget).
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import type { StreamName } from "../../core/types";
import { VirtualClock } from "../../sim/clock";
import { SimDevice } from "../../sim/device";
import { lastStatus } from "../../sim/e2ee";
import { SimNet } from "../../sim/net";

function world(): { clock: VirtualClock; net: SimNet; a: SimDevice; b: SimDevice } {
	const clock = new VirtualClock();
	clock.onError = (e) => {
		throw e;
	};
	const net = new SimNet(clock);
	return { clock, net, a: new SimDevice({ name: "A", clock, net }), b: new SimDevice({ name: "B", clock, net }) };
}

/** A row no reader can open (not an envelope): a deterministic gate failure, so the doc freezes. */
function freeze(net: SimNet, stream: StreamName): void {
	const payload = new Uint8Array(64).fill(0x5a);
	net.relay.forge([{ stream, deviceId: "dev-forger" as never, clientFrameId: "f".repeat(32) as never, payload }]);
}

const frozenDocs = (d: SimDevice): number => lastStatus(d)?.counts.frozenDocs ?? -1;

for (const when of ["opened while frozen", "bound when it froze"] as const) {
	test(`a view ${when} binds after releaseQuarantine`, async () => {
		const { clock, net, a, b } = world();
		a.vault.userWrite("n.md", "one\n");
		void a.start();
		void b.start();
		await clock.advance(5_000);
		assert.equal(b.vault.textOf("n.md"), "one\n");
		const stream = net.relay.streams().find((s) => s.startsWith("b:"))!;
		assert.ok(stream);
		let v = when === "bound when it froze" ? b.workspace.openFile("n.md")! : null;
		if (v) {
			await clock.advance(2_000);
			assert.ok(v.isBound(), "bound before the freeze");
		}
		freeze(net, stream);
		await clock.advance(3_000);
		assert.equal(frozenDocs(b), 1);
		v ??= b.workspace.openFile("n.md")!;
		await clock.advance(2_000);
		assert.equal(v.isBound(), false, "a frozen doc does not bind");
		// The forged row reached A too: both release (commands run on the virtual clock).
		const released = Promise.all([a, b].map((d) => d.runtime.command({ t: "releaseQuarantine", stream })));
		await clock.advance(5_000);
		assert.deepEqual((await released).map((r) => r.t), ["ok", "ok"]);
		assert.equal(frozenDocs(a), 0);
		assert.equal(frozenDocs(b), 0);
		assert.ok(v.isBound(), "the view binds once the doc is released");
		v.edit(v.getText().length, 0, "two\n");
		await clock.advance(5_000);
		assert.equal(a.vault.textOf("n.md"), "one\ntwo\n");
	});
}
