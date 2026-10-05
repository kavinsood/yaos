/**
 * Relay v2 spike §5.5 / §7.3 B5 (client side, in-memory): lease + semantic
 * reset CAS races lose no edits.
 *
 * The server is `MockRelayBody` (lease CAS, exact-head reset CAS, epoch fence
 * on append). Devices are `SimDevice`s whose epoch crossing is the real client
 * rebase (`prepareSemanticEpochTransition`, three-way text merge from the
 * durable baseline). Invariant checked everywhere: every unique edit marker
 * typed on any device ends up in the converged text of every device, of a
 * fresh device, and of the server's state — or, for a genuine textual
 * conflict, is preserved in the conflict result's pendingMarkdown (the
 * production client writes that as a conflict copy); never silently dropped.
 */
import * as Y from "yjs";
import { bloatedDoc, mulberry32 } from "../../scripts/relay2/reset/bloat";
import { runCompaction, type CompactionOutcome } from "../../scripts/relay2/reset/leaseClient";
import { prepareSemanticEpochTransition } from "../../legacy-src/sync/semanticEpochTransition";
import { MockRelayBody, SimDevice } from "../../scripts/relay2/reset/mockServer";
import { suite } from "../harness.ts";

const s = suite("relay2-reset-race");
const tick = (ms = 0) => new Promise((resolve) => setTimeout(resolve, ms));

function seedState(guid: string, edits = 14_000, seed = 21): Uint8Array {
	const doc = bloatedDoc({ guid, edits, seed });
	const state = Y.encodeStateAsUpdate(doc);
	doc.destroy();
	return state;
}

async function quiesce(devices: SimDevice[]): Promise<void> {
	for (let round = 0; round < 5; round++) {
		await tick(2);
		for (const device of devices) await device.idle();
	}
}

function structs(doc: Y.Doc): { total: number; deleted: number } {
	let total = 0;
	let deleted = 0;
	for (const list of doc.store.clients.values()) for (const item of list) { total++; if (item.deleted) deleted++; }
	return { total, deleted };
}

function checkConverged(label: string, server: MockRelayBody, devices: SimDevice[], markers: string[]) {
	const serverText = server.text();
	for (const device of devices) {
		s.check(device.epoch() === server.epoch, `${label}: ${device.deviceId} on server epoch ${server.epoch} (is ${device.epoch()})`);
		s.check(!device.hasPendingLocal(), `${label}: ${device.deviceId} has nothing pending`);
		s.check(device.text() === serverText, `${label}: ${device.deviceId} text == server text`);
	}
	const missing = markers.filter((marker) => !serverText.includes(marker));
	s.check(missing.length === 0, `${label}: all ${markers.length} markers present${missing.length ? ` (missing ${missing.join(",")})` : ""}`);
	for (const marker of markers) {
		const count = serverText.split(marker).length - 1;
		if (count !== 1) s.check(false, `${label}: marker ${marker} appears ${count}×`);
	}
}

s.test("two devices race for the lease while a third holds offline edits (B5 shape)", async () => {
	const server = new MockRelayBody("race-body", seedState("race-body"));
	const A = new SimDevice("A", server, { latency: { lease: 3, reset: 5 } });
	const B = new SimDevice("B", server, { latency: { lease: 3, reset: 5 } });
	const C = new SimDevice("C", server);
	A.insertAt(40, "[A0]");
	B.insertAt(200, "[B0]");
	C.goOffline();
	C.insertAt(60, "[C1]");
	C.append("[C2]");
	C.insertAt(500, "[C3]");
	await quiesce([A, B]);
	const before = structs(A.doc());

	const [ra, rb] = await Promise.all([runCompaction(A, A.transport), runCompaction(B, B.transport)]);
	await quiesce([A, B]);
	const statuses = [ra.status, rb.status].sort();
	s.check(statuses[0] === "installed" && statuses[1] === "lease-denied", `exactly one installs: ${ra.status} / ${rb.status}`);
	s.check(server.resets.length === 1 && server.epoch === 2, `one reset, epoch 2 (${server.resets.length}, ${server.epoch})`);
	const loser = ra.status === "installed" ? B : A;
	s.check(loser.rebases.length === 1 && loser.rebases[0]!.status === "rebased", `loser rebased via fence (${loser.log.join(" | ")})`);
	const after = structs(A.doc());
	s.check(after.total < before.total / 20 && after.deleted === 0, `structs ${before.total}/${before.deleted} → ${after.total}/${after.deleted}`);

	A.insertAt(10, "[A1]");
	B.insertAt(300, "[B1]");
	await quiesce([A, B]);
	C.goOnline();
	await quiesce([A, B, C]);
	s.check(C.rebases.at(-1)?.status === "rebased", `offline C rebased on reconnect (${C.log.join(" | ")})`);
	s.check(server.rejectedAppends.length === 0, "C never sent an old-epoch update (rebased before flushing)");
	const D = new SimDevice("D", server);
	checkConverged("B5", server, [A, B, C, D], ["[A0]", "[B0]", "[C1]", "[C2]", "[C3]", "[A1]", "[B1]"]);
	for (const device of [A, B, C, D]) device.destroy();
});

s.test("edit appended to the old epoch after the lease → head_advanced → rebuild", async () => {
	const server = new MockRelayBody("head-body", seedState("head-body", 6_000, 3));
	const A = new SimDevice("A", server);
	const B = new SimDevice("B", server);
	let injected = false;
	const result = await runCompaction(A, A.transport, {
		force: true,
		beforeUpload: () => { if (!injected) { injected = true; B.insertAt(100, "[B-race]"); } },
	});
	await quiesce([A, B]);
	s.check(result.status === "installed", `installed after retry (${result.status})`);
	s.check(server.resetAttempts.map((a) => a.reason ?? "ok").join(",") === "head_advanced,ok", `attempts ${server.resetAttempts.map((a) => a.reason ?? "ok").join(",")}`);
	checkConverged("head_advanced", server, [A, B, new SimDevice("D", server)], ["[B-race]"]);
});

s.test("holder edits between snapshot and install → rebased onto its own snapshot", async () => {
	const server = new MockRelayBody("self-body", seedState("self-body", 6_000, 4));
	const A = new SimDevice("A", server);
	const B = new SimDevice("B", server);
	const result = await runCompaction(A, A.transport, {
		force: true,
		beforeUpload: () => { A.holdOutgoing = true; A.insertAt(50, "[A-late]"); },
	});
	s.check(result.status === "installed", `installed (${result.status})`);
	s.check(A.epoch() === 2 && A.hasPendingLocal(), "A on epoch 2 with the rebased edit pending");
	A.release();
	await quiesce([A, B]);
	checkConverged("self-rebase", server, [A, B, new SimDevice("D", server)], ["[A-late]"]);
});

s.test("state vector is not a currency proof; server-sourced snapshot needs none", async () => {
	const server = new MockRelayBody("sv-body", seedState("sv-body", 6_000, 8));
	const A = new SimDevice("A", server);
	const B = new SimDevice("B", server);
	B.insertAt(120, "[GONE]");
	await quiesce([A, B]);
	A.goOffline();
	const svOf = (state: Uint8Array) => Buffer.from(Y.encodeStateVectorFromUpdate(state));
	const svBefore = svOf(server.encodedState());
	B.edit((text) => { const at = text.toString().indexOf("[GONE]"); text.delete(at, "[GONE]".length); });
	await quiesce([B]);
	s.check(svOf(server.encodedState()).equals(svBefore), "a delete-only append leaves the server state vector unchanged");
	s.check(Buffer.from(Y.encodeStateVector(A.doc())).equals(svBefore) && A.text().includes("[GONE]"),
		"stale A has the same state vector as the server yet still shows the deleted text");
	A.insertAt(30, "[A-off]");
	const local = await runCompaction(A, A.transport, { force: true, currencyWaitMs: 20 });
	s.check(local.status === "not-current", `local snapshot refused by the sequence gate (${local.status})`);
	const remote = await runCompaction(A, A.transport, { force: true, snapshotSource: "server" });
	s.check(remote.status === "installed" && (remote.timings.fetchBytes ?? 0) > 0,
		`server-sourced snapshot installs from a stale, dirty holder (${remote.status}, fetched ${remote.status === "installed" ? remote.timings.fetchBytes : 0} B)`);
	A.goOnline();
	await quiesce([A, B]);
	checkConverged("server-sourced", server, [A, B, new SimDevice("D", server)], ["[A-off]"]);
	s.check(!server.text().includes("[GONE]") && !A.text().includes("[GONE]"), "B's delete survives the reset");
});

s.test("server-sourced snapshot: head_advanced → same-holder re-grant → refetch → install", async () => {
	const server = new MockRelayBody("sv-head", seedState("sv-head", 6_000, 9));
	const A = new SimDevice("A", server);
	const B = new SimDevice("B", server);
	let injected = false;
	const result = await runCompaction(A, A.transport, {
		force: true, snapshotSource: "server",
		beforeUpload: () => { if (!injected) { injected = true; B.insertAt(90, "[B-race]"); } },
	});
	await quiesce([A, B]);
	s.check(result.status === "installed", `installed (${result.status})`);
	s.check(server.resetAttempts.map((a) => a.reason ?? "ok").join(",") === "head_advanced,ok", `attempts ${server.resetAttempts.map((a) => a.reason ?? "ok").join(",")}`);
	s.check(server.leaseAttempts.filter((a) => a.from === "A" && a.granted).length === 2, "re-granted to the same holder");
	checkConverged("server head_advanced", server, [A, B, new SimDevice("D", server)], ["[B-race]"]);
});

s.test("device that missed the fence is rejected on append (4409) and rebases", async () => {
	const server = new MockRelayBody("fence-body", seedState("fence-body", 6_000, 5));
	const A = new SimDevice("A", server);
	const B = new SimDevice("B", server);
	B.holdOutgoing = true;
	B.insertAt(120, "[B-inflight]");
	server.unsubscribe("B"); // B's socket silently missed the fence
	const result = await runCompaction(A, A.transport, { force: true });
	s.check(result.status === "installed", "A installed without B's unsent edit");
	B.release();
	await quiesce([A, B]);
	s.check(server.rejectedAppends.some((r) => r.from === "B" && r.expectedEpoch === 1), "B's old-epoch append was fenced");
	server.subscribe("B", () => {});
	B.goOnline();
	await quiesce([A, B]);
	checkConverged("fenced-append", server, [A, B, new SimDevice("D", server)], ["[B-inflight]"]);
});

s.test("expired lease: second device takes over, first loses the CAS and rebases", async () => {
	let now = 1_000_000;
	const server = new MockRelayBody("ttl-body", seedState("ttl-body", 6_000, 6), () => now);
	const A = new SimDevice("A", server);
	const B = new SimDevice("B", server);
	let bResult: CompactionOutcome | null = null;
	const aResult = await runCompaction(A, A.transport, {
		force: true, ttlMs: 1_000, now: () => now,
		beforeUpload: async () => {
			now += 5_000; // A stalls past its TTL (backgrounded / suspended)
			A.holdOutgoing = true;
			A.insertAt(80, "[A-stalled]");
			bResult = await runCompaction(B, B.transport, { force: true, now: () => now });
		},
	});
	A.release();
	await quiesce([A, B]);
	s.check(bResult !== null && (bResult as CompactionOutcome).status === "installed", "B installs on the expired lease");
	s.check(aResult.status === "lost" && aResult.reason === "lease_invalid", `A loses: ${aResult.status} ${"reason" in aResult ? aResult.reason : ""}`);
	s.check(server.resets.length === 1, "exactly one reset");
	checkConverged("lease-expiry", server, [A, B, new SimDevice("D", server)], ["[A-stalled]"]);
});

s.test("stale-epoch lease request and server-enforced cooldown are refused", async () => {
	const server = new MockRelayBody("cool-body", seedState("cool-body", 6_000, 7), Date.now, { enforceCooldown: true });
	const A = new SimDevice("A", server);
	const C = new SimDevice("C", server);
	C.goOffline();
	s.check((await runCompaction(A, A.transport, { force: true })).status === "installed", "first reset installs");
	const stale = await runCompaction(C, C.transport, { force: true });
	s.check(stale.status === "lease-denied" && stale.reason === "epoch_mismatch", `stale device refused (${stale.status})`);
	const again = await runCompaction(A, A.transport, { force: true });
	s.check(again.status === "lease-denied" && again.reason === "cooldown", `cooldown refused (${again.status})`);
	C.goOnline();
	await quiesce([A, C]);
	checkConverged("cooldown", server, [A, C], []);
});

s.test("true textual conflict is surfaced with the local intent preserved (never dropped)", async () => {
	const server = new MockRelayBody("conflict-body", seedState("conflict-body", 3_000, 8));
	const A = new SimDevice("A", server);
	const C = new SimDevice("C", server);
	C.goOffline();
	// Same region replaced differently on both sides of the fence.
	C.edit((text) => { text.delete(40, 10); text.insert(40, "[C-mine]"); });
	A.edit((text) => { text.delete(40, 10); text.insert(40, "[A-mine]"); });
	await runCompaction(A, A.transport, { force: true });
	C.goOnline();
	await quiesce([A, C]);
	const last = C.rebases.at(-1);
	s.check(last?.status === "conflict" && last.installed, `C reports conflict, then installs authoritative (${last?.status})`);
	s.check(C.conflictCopies.length === 1 && C.conflictCopies[0]!.pendingMarkdown.includes("[C-mine]"), "C's intent preserved as a conflict copy");
	s.check(C.text().includes("[A-mine]") && C.epoch() === 2 && C.text() === server.text(), "C converged on the authoritative epoch");
	s.check(server.rejectedAppends.length === 0, "no old-epoch bytes reached the server");
	C.destroy();
	A.destroy();
});

s.test(">2M-char body: production rebase refuses even with no local intent; spike fast path crosses", async () => {
	const big = "0123456789 abcdefghij\n".repeat(100_000); // 2.2M chars
	const producer = new Y.Doc({ guid: "big-body" });
	producer.getText("body").insert(0, big);
	const server = new MockRelayBody("big-body", Y.encodeStateAsUpdate(producer));
	producer.destroy();
	const A = new SimDevice("A", server);
	const B = new SimDevice("B", server);
	const C = new SimDevice("C", server);
	C.goOffline();
	C.insertAt(100, "[C-big]");
	const production = prepareSemanticEpochTransition({
		bodyId: "big-body", previousBodyEpoch: 1, nextBodyEpoch: 2,
		previousBaseline: B.text(), pendingMarkdown: B.text(), authoritativeEncodedState: server.encodedState(),
	});
	s.check(production.kind === "too-large", `production prepareSemanticEpochTransition with zero intent → ${production.kind}`);
	const result = await runCompaction(A, A.transport, { force: true });
	await quiesce([A, B]);
	s.check(result.status === "installed", "A installs the reset of a 2.2 MB note");
	s.check(B.rebases.at(-1)?.status === "rebased" && B.epoch() === 2, "B (no intent) crosses via the no-intent fast path");
	C.goOnline();
	await quiesce([A, B, C]);
	const last = C.rebases.at(-1);
	s.check(last?.status === "too-large" && last.installed && C.conflictCopies.some((c) => c.pendingMarkdown.includes("[C-big]")),
		`C (offline intent on a >2M-char note) → ${last?.status}: preserved only as a conflict copy`);
	s.check(C.text() === server.text() && !server.text().includes("[C-big]"), "C converged; its edit lives in the conflict copy, not the note");
	for (const device of [A, B, C]) device.destroy();
});

s.test("fuzz: random offline windows, edits and racing leases lose nothing", async () => {
	let conflicts = 0;
	let resets = 0;
	for (let seed = 1; seed <= 25; seed++) {
		const random = mulberry32(seed * 7919);
		const server = new MockRelayBody(`fuzz-${seed}`, seedState(`fuzz-${seed}`, 3_000, seed));
		const devices = ["A", "B", "C"].map((id) => new SimDevice(id, server, { latency: { lease: Math.floor(random() * 4), reset: Math.floor(random() * 4) } }));
		const markers: string[] = [];
		const preserved = new Set<string>();
		let counter = 0;
		for (let round = 0; round < 8; round++) {
			for (const device of devices) {
				if (random() < 0.3) { if (device.online()) device.goOffline(); else device.goOnline(); }
				if (random() < 0.7) {
					const marker = `<${device.deviceId}${counter++}>`;
					markers.push(marker);
					// Insert-only at a separator so edits from different devices rarely touch.
					const text = device.text();
					const spaces = [...text.matchAll(/ /g)].map((m) => m.index!).filter((i) => i > 40);
					const at = spaces.length ? spaces[Math.floor(random() * spaces.length)]! : text.length;
					device.insertAt(at, marker);
				}
			}
			if (random() < 0.5) {
				const racers = devices.filter(() => random() < 0.6);
				await Promise.all(racers.map((device) => runCompaction(device, device.transport, { force: true, currencyWaitMs: 50 })));
			}
			await quiesce(devices);
		}
		for (const device of devices) if (!device.online()) device.goOnline();
		await quiesce(devices);
		for (const device of devices) {
			for (const copy of device.conflictCopies) {
				conflicts++;
				for (const marker of markers) if (copy.pendingMarkdown.includes(marker)) preserved.add(marker);
			}
		}
		resets += server.resets.length;
		const serverText = server.text();
		const lost = markers.filter((marker) => !serverText.includes(marker) && !preserved.has(marker));
		if (lost.length > 0) s.check(false, `seed ${seed}: lost ${lost.join(",")} (conflict copies preserve ${preserved.size})`);
		{
			const fresh = new SimDevice("D", server);
			const ok = devices.every((d) => d.text() === serverText && d.epoch() === server.epoch && !d.hasPendingLocal())
				&& fresh.text() === serverText;
			if (!ok) s.check(false, `seed ${seed}: devices diverged (${devices.map((d) => `${d.deviceId}@${d.epoch()} ${d.log.slice(-2).join(";")}`).join(" | ")})`);
			const dupes = markers.filter((marker) => serverText.split(marker).length > 2);
			if (dupes.length) s.check(false, `seed ${seed}: duplicated ${dupes.join(",")}`);
			fresh.destroy();
		}
		for (const device of devices) device.destroy();
	}
	s.check(resets > 10, `fuzz exercised ${resets} resets across 25 seeds (${conflicts} conflict copies; every marker in the converged text or a conflict copy)`);
});

await s.done();
