/**
 * An outdated client meets a newer one (DESIGN §c.10, ns fold pre-scan): a device on a newer build appends
 * upgradeRules(FOLD_RULES_VERSION + 1). Every device on this build halts its ns fold at that row (phase
 * upgrade-required, ns.ignored.rules-version, diagnostics upgrade-required) and folds nothing past it, while its own
 * edits stay on its disk and in its outbox. Updated to a build that knows the version, each device folds through
 * and the vault converges with every edit made during the halt.
 *
 * No client build writes upgradeRules yet (rules v1), so the newer device is a raw relay session sealing the frame
 * (the hostile device's path, hostile.ts); the run cannot quiesce while devices halt, hence a test of its own rather
 * than a sim fault.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { newClientFrameId } from "../core/codec/ids";
import { encodeNsOps } from "../core/codec/nsOps";
import { FOLD_RULES_VERSION } from "../core/limits";
import { NS_STREAM, type DeviceId } from "../core/types";
import { createNoopCrypto } from "../engine/adapters/noopCrypto";
import { sealFrame } from "../engine/ingest/envelope";
import { KNOWN_RULES } from "../engine/ingest/gate";
import { VirtualClock } from "./clock";
import { collectCoverage } from "./coverage";
import { SimDevice } from "./device";
import { lastStatus, settleOn } from "./e2ee";
import { simHashPort } from "./hash";
import { SIM_VAULT_ID, SimNet } from "./net";
import { SeededRandom } from "./random";

const NEWER = "dev-newer-build-000000000" as DeviceId;

test("an outdated client halts at a newer device's upgradeRules, keeps its edits, and converges once updated", async () => {
	const clock = new VirtualClock();
	clock.onError = (e) => {
		throw e;
	};
	const net = new SimNet(clock);
	const [a, b] = ["A", "B"].map((name) => new SimDevice({ name, clock, net }));
	if (!a || !b) throw new Error("two devices");
	a.vault.externalWrite("notes/one.md", "one [A.1]\n");
	for (const d of [a, b]) void d.start();
	await clock.advance(15_000);
	assert.equal(b.vault.textOf("notes/one.md"), "one [A.1]\n", "B synced before the halt");

	// The newer build's frame.
	const c = await settleOn(clock, net.port("newer-machine").connect({ vaultId: SIM_VAULT_ID, deviceId: NEWER }));
	assert.ok(c.ok && c.value.ok);
	const r = c.value;
	const cfid = newClientFrameId(new SeededRandom(7));
	const sealed = await sealFrame(createNoopCrypto(simHashPort()), SIM_VAULT_ID, {
		stream: NS_STREAM, deviceId: NEWER, clientFrameId: cfid, kind: "nsOps", authorNsSeq: 0, flags: 0, frameNo: 1,
		content: encodeNsOps([{ t: "upgradeRules", version: FOLD_RULES_VERSION + 1 }]),
	});
	r.session.append({ stream: NS_STREAM, clientFrameId: cfid, payload: sealed.sealed });
	await clock.advance(10_000);
	const haltSeq = net.relay.rows(NS_STREAM).find((x) => x.deviceId === NEWER)?.seq;
	assert.ok(haltSeq !== undefined, "the frame committed");

	for (const d of [a, b]) {
		assert.equal(lastStatus(d)?.phase, "upgrade-required", `${d.name} halted`);
		assert.ok((d.diagCounts["upgrade-required:ns"] ?? 0) > 0, `${d.name} diagnosed it`);
		assert.ok(collectCoverage([d])["diag.upgrade-required"]! > 0, `${d.name} counted the halt (coverage)`);
		assert.ok(d.vrt!.log.c.ns.coversSeq < haltSeq, `${d.name} folded nothing past it`);
	}

	// Edits during the halt: a new note on B, an edit on A. Nothing past the halt folds, nothing is lost.
	b.vault.userWrite("notes/two.md", "two [B.2]\n");
	a.vault.userWrite("notes/one.md", "one [A.1] [A.3]\n");
	await clock.advance(30_000);
	assert.equal(a.vault.textOf("notes/two.md"), null, "B's create does not reach A during the halt");
	assert.equal(b.vault.textOf("notes/two.md"), "two [B.2]\n", "B keeps its note");
	assert.equal(a.vault.textOf("notes/one.md"), "one [A.1] [A.3]\n", "A keeps its edit");
	for (const d of [a, b]) assert.equal(lastStatus(d)?.phase, "upgrade-required", `${d.name} still halted`);

	// The user updates both apps to a build that knows the new rules.
	for (const d of [a, b]) {
		d.updatedTuning = { knownRules: { ...KNOWN_RULES, ns: FOLD_RULES_VERSION + 1 } };
		d.crashApp();
	}
	for (const d of [a, b]) void d.restartApp();
	await clock.advance(60_000);
	for (const d of [a, b]) {
		assert.equal(lastStatus(d)?.phase, "live", `${d.name} live after the update`);
		assert.ok(d.vrt!.log.c.ns.coversSeq >= haltSeq, `${d.name} folded through`);
		assert.equal(d.vault.textOf("notes/two.md"), "two [B.2]\n", `${d.name} has B's note`);
		assert.equal(d.vault.textOf("notes/one.md"), "one [A.1] [A.3]\n", `${d.name} has A's edit`);
	}
});
