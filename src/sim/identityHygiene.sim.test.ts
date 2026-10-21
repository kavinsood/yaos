// identity-per-store phase 5: inactivity retirement resolves an abandoned create with no console action, end to end on
// the composed sim client in virtual time. A store lost together with its lineage (IndexedDB, the mirrors and
// Obsidian's localStorage all gone) fences nothing, so its registration stays live; a create of it whose body never
// reached the relay waits on it (DESIGN §i.5 "Abandoned creates": a live creator is rechecked, never given up on). Once
// it has not connected for longer than the server's threshold, the lazy sweep a status query runs retires it; every
// device then drops the empty doc and the holder of the file re-creates it. A slow unit (about a virtual day).
import assert from "node:assert/strict";
import { simTest } from "./testkit/simTest";
import { VirtualClock, DEFAULT_WALL_START_MS } from "./clock";
import { SimDevice } from "./device";
import { SimNet } from "./net";

const DAY_MS = 86_400_000;
const HOUR_MS = 3_600_000;

simTest("abandoned create: a store lost with its lineage leaves a body-less doc; inactivity retirement resolves it with no console action", 200, async () => {
	// Five minutes before 00:00 UTC: the lost store is last seen on day D; with a one-day threshold it is stale from
	// day D+2, a virtual day later.
	const clock = new VirtualClock(DEFAULT_WALL_START_MS - 5 * 60_000);
	clock.onError = (e) => {
		throw e;
	};
	const net = new SimNet(clock);
	net.identities.inactivityDays = 1;
	const lines: string[] = [];
	const a = new SimDevice({ name: "A", clock, net, log: (l) => lines.push(`A ${l}`) });
	const b = new SimDevice({ name: "B", clock, net, log: (l) => lines.push(`B ${l}`) });
	const devs = [a, b];
	a.vault.userWrite("note.md", "hello\n");
	for (const d of devs) void d.start();
	await clock.advance(15_000);
	const lost = a.deviceId;
	// A creates a note; its ns frame commits, its body frame is lost in transit, and A drops before it resends.
	net.relay.pauseCommits();
	a.vault.userWrite("new.md", "only on A\n");
	for (let i = 0; i < 20_000 && net.relay.pendingCount() < 2; i++) await clock.advance(1);
	a.setOnline(false);
	assert.equal(net.relay.discardPending(lost, (s) => s.startsWith("b:")), 1, "the body frame is lost");
	net.relay.resumeCommits();
	await clock.advance(10_000);
	assert.equal(net.relay.pendingCount(), 0);
	// The OS evicts IndexedDB, the mirrors and Obsidian's localStorage: the next store has no lineage, fences nothing.
	a.crashApp({ wipe: true, dropMirrors: true });
	a.localStorage.clear();
	await clock.advance(1_000);
	a.setOnline(true);
	void a.restartApp();
	await clock.advance(2 * HOUR_MS);
	assert.notEqual(a.deviceId, lost);
	assert.equal(net.identities.state(lost), "live", "nobody fenced the lost store");
	const stuck = await net.oracle();
	assert.ok(stuck.docs.some((x) => x.path === "new.md"), "the create committed");
	assert.equal(b.vault.hasFile("new.md"), false, "B waits on the body-less doc");
	assert.equal(a.vault.textOf("new.md"), "only on A\n", "A still holds the file");
	assert.equal(net.identities.counts["inactive"] ?? 0, 0);

	// Day D+2: the holders' creator recheck (a status query) runs the server's sweep, which retires the lost store.
	const until = (Math.floor(clock.now() / DAY_MS) + 2) * DAY_MS + 2 * HOUR_MS;
	while (clock.now() < until) await clock.advance(HOUR_MS);
	assert.equal(net.identities.state(lost), "retired", "the sweep retired the abandoned store");
	assert.equal(net.identities.counts["inactive"], 1, "only it: the connected stores are kept");
	for (const d of devs) assert.equal(net.identities.state(d.deviceId), "live", d.name);
	await clock.advance(10 * 60_000);
	for (const d of devs) assert.equal(d.vault.textOf("new.md"), "only on A\n", `${d.name} has the note`);
	const o = await net.oracle();
	assert.deepEqual(o.docs.map((x) => [x.path, x.text]).sort(), [["new.md", "only on A\n"], ["note.md", "hello\n"]],
		lines.filter((l) => /creator|lost|abandon/.test(l)).join("\n"));
	for (const d of devs) assert.equal(d.vault.trashed.length, 0, d.name);
});
