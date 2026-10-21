/**
 * Clones (identity-per-store §4 "Clone"): two installs started from one copied vault run as two store identities.
 * Before stores had identities, a copied data.json made them twins under one deviceId: their concurrent ns and cfg
 * frames collided on (deviceId, frameNo) and one's creates were dropped as replays (the clone-check repro). With an
 * identity per store, the twins' concurrent frames all commit and every engine, an observer included, folds the
 * same vault.
 */
import assert from "node:assert/strict";
import { test } from "node:test";
import { CFG_STREAM, type ConfigRelPath, type VaultPath } from "../../core/types";
import { SimRelay } from "../../sim/relay";
import type { LogEngine } from "./engine";
import { createDoc, startTestEngine, until } from "./testHarness";

const APP = "app.json" as ConfigRelPath;

async function settle(...es: LogEngine[]): Promise<void> {
	for (const e of es) await until(() => e.status().phase === "live" && e.isIdle() && e.c.outbox.size === 0, 5_000, "idle");
}
const live = (e: LogEngine) => e.listDocs().filter((d) => d.state === "live").map((d) => d.path).sort();
const k = (e: LogEngine) => e.c.cfg.state.json.get(`${APP}\u0000k`)?.value ?? null;

test("clone: twins with their own store identities write concurrently (ns + cfg); all three engines converge", async () => {
	const relay = new SimRelay();
	const { engine: a } = await startTestEngine({ relay, deviceId: "dev-twin-a-0000000000" });
	const { engine: b } = await startTestEngine({ relay, deviceId: "dev-twin-b-0000000000" });
	const { engine: c } = await startTestEngine({ relay, deviceId: "dev-obsv-000000000000" });
	try {
		await settle(a, b, c);
		// Round 1: both twins write at the same moment (commits held until both are queued).
		relay.pauseCommits();
		await createDoc(a, "from-a.md" as VaultPath, "A");
		await createDoc(b, "from-b.md" as VaultPath, "B");
		void a.submitCfg([{ t: "jsonSet", file: APP, key: "k", valueJson: '"A"' }]);
		void b.submitCfg([{ t: "jsonSet", file: APP, key: "k", valueJson: '"B"' }]);
		await until(() => a.c.outbox.ofStream(CFG_STREAM).length > 0 && b.c.outbox.ofStream(CFG_STREAM).length > 0, 3_000, "cfg queued");
		relay.resumeCommits();
		await settle(a, b, c);
		await until(() => [a, b, c].every((e) => live(e).length === 2), 5_000, "round 1 docs");
		assert.deepEqual(live(a), ["from-a.md", "from-b.md"]);
		assert.deepEqual(live(b), live(a));
		assert.deepEqual(live(c), live(a));
		await until(() => k(a) !== null && k(a) === k(b) && k(b) === k(c), 5_000, "cfg converged");

		// Round 2: alternating, each after seeing the other.
		await createDoc(b, "b2.md" as VaultPath, "B2");
		await settle(b);
		await until(() => live(a).includes("b2.md"), 5_000, "a sees b2");
		await createDoc(a, "a2.md" as VaultPath, "A2");
		await settle(a);
		// Round 3: concurrent again, B's commit first.
		relay.pauseCommits();
		await createDoc(b, "b3.md" as VaultPath, "B3");
		await createDoc(a, "a3.md" as VaultPath, "A3");
		relay.resumeCommits();
		await settle(a, b, c);
		const want = ["a2.md", "a3.md", "b2.md", "b3.md", "from-a.md", "from-b.md"];
		await until(() => [a, b, c].every((e) => live(e).length === want.length), 5_000, "round 3 docs");
		for (const e of [a, b, c]) assert.deepEqual(live(e), want);
	} finally {
		await a.stop();
		await b.stop();
		await c.stop();
	}
});
