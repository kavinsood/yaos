/**
 * §14.3 through the engine, over SimRelay: after a revoke wins at S_rot, frames the revoked device seals under an
 * older epoch and commits past S_rot are ignored (ns/cfg fold them as empty, bodies are not quarantined or
 * frozen); a kept device that has not re-keyed holds them, and settles them once the re-key QR arrives (§14.2
 * step 3), when its unopened rows under r are re-gated too. RAW_DEVICE plays the revoked device (testkit keys).
 */
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import * as Y from "yjs";
import { encodeNsOps } from "../../core/codec/nsOps";
import { KEYRING_STREAM, NS_STREAM, type ContentHash, type DocId, type VaultPath } from "../../core/types";
import { SimRelay } from "../../sim/relay";
import { converged, until } from "../runtime/testHarness";
import { keyMissing, live, oldEpochFrame, rawAppend, start, type Dev } from "./testkit/engines";
import { K, RK_A, genesis } from "./testkit/world";

let ids = 0;
const create = (path: string) => encodeNsOps([{ t: "create", docId: `doc${++ids}`.padEnd(22, "B") as DocId, kind: "markdown", path: path as VaultPath, contentHash: "0".repeat(64) as ContentHash, size: 0 }]);
const paths = (d: Dev) => d.engine.listDocs().map((x) => x.path).sort();
const evilUpdate = () => {
	const d = new Y.Doc();
	d.getText("text").insert(0, "EVIL ");
	return Y.encodeStateAsUpdate(d);
};
const lastK = (relay: SimRelay) => relay.rows(KEYRING_STREAM)[relay.rows(KEYRING_STREAM).length - 1]!.seq;

async function pair(relay: SimRelay, ...ids: string[]): Promise<Dev[]> {
	const g = await genesis();
	await rawAppend(relay, KEYRING_STREAM, g);
	const devs = await Promise.all(ids.map((id) => start(relay, id, { keys: [{ e: 1, k: K(1) }], records: [g] })));
	for (const d of devs) await live(d);
	return devs;
}

describe("stale-epoch rule (§14.3) in the engine", () => {
	it("after a revoke at S_rot, old-epoch ns and body frames past it are ignored; before it they apply", async () => {
		const relay = new SimRelay();
		const [x] = await pair(relay, "dev-x");
		try {
			const id = await x!.engine.createDoc("a.md" as VaultPath, "kept");
			await converged([x!.engine]);
			await oldEpochFrame(relay, NS_STREAM, 1, "nsOps", create("before.md"), 1);
			await until(() => paths(x!).includes("before.md"), 5_000, "pre-revoke frame folded");
			assert.equal(await x!.engine.revokeRekey(RK_A.slice()), "won");
			const sRot = lastK(relay);
			assert.equal(x!.engine.status().e2ee?.sealEpoch, 2);
			const ns = await oldEpochFrame(relay, NS_STREAM, 1, "nsOps", create("evil.md"), 2);
			const body = await oldEpochFrame(relay, x!.engine.streamOf(id), 1, "bodyUpdate", evilUpdate());
			assert.ok(ns > sRot && body > sRot);
			await x!.engine.createDoc("after.md" as VaultPath, "after"); // folds past the stale row
			await converged([x!.engine]);
			assert.deepEqual(paths(x!), ["a.md", "after.md", "before.md"]);
			assert.equal(await x!.engine.docText(id), "kept");
			assert.equal(x!.engine.status().counts.quarantinedRows, 0, "ignored, not quarantined");
			assert.equal(x!.engine.status().counts.frozenDocs, 0);
			assert.equal(keyMissing(x!), null);
		} finally {
			await x!.engine.stop();
		}
	});

	it("a kept device that has not re-keyed holds them past the open revoke, then settles them and opens r rows on the re-key QR", async () => {
		const relay = new SimRelay();
		const [x, y] = await pair(relay, "dev-x", "dev-y");
		try {
			const id = await x!.engine.createDoc("a.md" as VaultPath, "kept");
			await converged([x!.engine, y!.engine]);
			assert.equal(await x!.engine.revokeRekey(RK_A.slice()), "won");
			const k2 = x!.changes.flatMap((c) => c.keys).find((k) => k.e === 2)!.k;
			await oldEpochFrame(relay, NS_STREAM, 1, "nsOps", create("evil.md"), 1);
			await oldEpochFrame(relay, y!.engine.streamOf(id), 1, "bodyUpdate", evilUpdate());
			await x!.engine.createDoc("new.md" as VaultPath, "under r");
			await converged([x!.engine]);
			const head = relay.head();
			await until(() => y!.engine.status().vaultSeq >= head, 5_000, "y read through head");
			assert.deepEqual(paths(y!), ["a.md"], "held: neither the stale row nor the r rows behind it fold");
			assert.deepEqual((await y!.engine.c.repo.quarantineOf(y!.engine.streamOf(id))).map((q) => q.reason), ["keyring-hold"], "the body row waits");
			assert.equal(y!.engine.status().counts.quarantinedRows, 2, "and new.md's body under r: unknown key");
			assert.equal(await y!.engine.docText(id), "kept");
			assert.equal(await y!.engine.installKeyQr(2, k2.slice()), "verified");
			await until(() => paths(y!).includes("new.md"), 5_000, "unopened r rows re-gated");
			await converged([x!.engine, y!.engine]);
			assert.deepEqual(paths(y!), ["a.md", "new.md"]);
			assert.equal(await y!.engine.docText(id), "kept");
			assert.equal(y!.engine.status().counts.quarantinedRows, 0, "the hold settled as stale (dismissed); the r body opened");
			assert.equal(y!.engine.status().counts.frozenDocs, 0);
			assert.equal(await y!.engine.docText(y!.engine.listDocs().find((d) => d.path === "new.md")!.docId), "under r");
			assert.equal(keyMissing(y!), null);
			assert.equal(y!.engine.status().e2ee?.sealEpoch, 2);
		} finally {
			await y!.engine.stop();
			await x!.engine.stop();
		}
	});
});
