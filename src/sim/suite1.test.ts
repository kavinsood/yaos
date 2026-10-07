// The sim under suite 1 (e2ee-design §20.3, WP-E7 open question (d)): real WebCrypto under the virtual clock still
// gives "same seed, same trace" (delayedCrypto.ts RealWork), so a failing seed replays and ddmin still works. The
// full suite-1 matrix runs out of band (`npm run test:sim-suite1`, scripts/sim-suite1.mjs); this file keeps the
// tooling honest inside `npm run test:client` with a few seeds. Counts only: no key bytes.
import { test } from "node:test";
import assert from "node:assert/strict";
import { bytesToHex } from "../core/codec/lib0";
import { generatePlan, minimizePlan, runSim, type SimConfig, type SimReport, type Step } from "./run";
import { DEFAULT_FAULTS, E2EE_FAULTS } from "./faults";
import { sha256Sync } from "./hash";
import type { SimNet } from "./net";

/** Every crypto await went through RealWork (a stray would make the run depend on the host's timing). */
function clean(r: SimReport): void {
	assert.deepEqual(r.violations, [], `seed ${r.seed}`);
	assert.equal(r.stats.realWork?.strays, 0, `seed ${r.seed}: RealWork strays`);
	assert.ok((r.stats.realWork?.subtle ?? 0) > 0, `seed ${r.seed}: real WebCrypto ran`);
}

/** SHA-256 over every relay row (stream, seq, author, frame id, sealed payload) at the end of a run. */
function relayHash(net: SimNet): string {
	const parts: string[] = [];
	for (const stream of [...net.relay.streams()].sort()) {
		for (const r of net.relay.rows(stream, { includeGc: true })) parts.push(`${stream} ${r.seq} ${r.deviceId} ${r.clientFrameId} ${bytesToHex(sha256Sync(r.payload))}`);
	}
	return bytesToHex(sha256Sync(new TextEncoder().encode(parts.join("\n"))));
}

async function runHashed(cfg: SimConfig): Promise<{ r: SimReport; relay: string }> {
	let relay = "";
	const r = await runSim({ ...cfg, observe: (label, _devs, net) => void (label === "end" && (relay = relayHash(net))) });
	return { r, relay };
}

test("sim suite 1: same seed, same trace, digest and sealed relay bytes, whatever ran before in the process", async () => {
	const cfg: SimConfig = { seed: 4242, devices: 3, faults: DEFAULT_FAULTS, crypto: "suite1" };
	const a = await runHashed(cfg);
	const other = await runHashed({ ...cfg, seed: 4243 });
	const b = await runHashed(cfg);
	for (const x of [a, other, b]) clean(x.r);
	assert.deepEqual(b.r.trace, a.r.trace);
	assert.equal(b.r.digest, a.r.digest);
	assert.equal(b.relay, a.relay, "every sealed row, nonce and key record byte-identical");
	assert.deepEqual(b.r.stats.realWork, a.r.stats.realWork, "the same crypto calls in the same batches");
	assert.notEqual(other.r.digest, a.r.digest);
	assert.notEqual(other.relay, a.relay);
});

test("sim suite 1: an explicit plan replays the generated run exactly", async () => {
	const cfg: SimConfig = { seed: 77, devices: 2, faults: DEFAULT_FAULTS, crypto: "suite1" };
	const a = await runSim(cfg);
	clean(a);
	const b = await runSim(cfg, a.plan);
	assert.equal(b.digest, a.digest);
	assert.deepEqual(b.trace, a.trace);
});

test("sim suite 1: ddmin reduces a plan, and the reduced plan replays to one digest", async () => {
	const cfg: SimConfig = { seed: 5, devices: 2, faults: null, steps: 30, crypto: "suite1" };
	const plan = generatePlan(cfg);
	const wanted = [plan[7]?.i, plan[21]?.i];
	const has = (p: readonly Step[]) => wanted.every((i) => p.some((s) => s.i === i));
	const m = await minimizePlan(cfg, plan, (r) => has(r.plan) && r.violations.length === 0, 120);
	assert.deepEqual(m.plan.map((s) => s.i), wanted);
	assert.ok(m.runs < 120, `${m.runs} runs`);
	const [x, y] = [await runSim(cfg, m.plan), await runSim(cfg, m.plan)];
	clean(x);
	assert.equal(y.digest, x.digest);
});

test("sim suite 1: E2EE faults (key store loss, rolls, revokes, restores, hostile replay and downgrade), a few seeds", async () => {
	const seen = { rolls: 0, revokes: 0, rekeys: 0, hostile: 0 };
	for (const seed of [1, 2, 3, 4]) {
		const r = await runSim({ seed, devices: 3, faults: E2EE_FAULTS, faultRate: 0.3, crypto: "suite1" });
		clean(r);
		const e = r.stats.e2ee!;
		seen.rolls += e.rolls.won;
		seen.revokes += e.revokes.won;
		seen.rekeys += e.rekeys + e.rkRekeys;
		seen.hostile += e.replayed + e.downgradeRows;
	}
	assert.ok(seen.rolls + seen.revokes > 0 && seen.rekeys > 0 && seen.hostile > 0, JSON.stringify(seen));
});
