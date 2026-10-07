/**
 * §14.2 step 4 through the engine, over SimRelay: no edit is lost to a revoke. Frames a device wrote under K_1
 * while the revoke won elsewhere are re-sealed under r before they are sent (the sender waits for the session's
 * `k` read); own frames that commit past S_rot under K_1 (sent while the revoke was in flight) are copied and sent
 * again under r. The relay's rows are checked by their header epoch.
 */
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { decodeOuter } from "../../core/codec/envelope";
import { KEYRING_STREAM, type VaultPath } from "../../core/types";
import { SimRelay } from "../../sim/relay";
import { converged, until } from "../runtime/testHarness";
import { keyMissing, live, rawAppend, start, stored, type Dev } from "./testkit/engines";
import { K, RK_A, genesis } from "./testkit/world";

const epochOf = (payload: Uint8Array) => {
	const d = decodeOuter(payload);
	return d.ok ? d.header.keyEpoch : -1;
};
/** Rows `deviceId` appended past `seq` outside `k`, by header epoch. */
const rowsPast = (relay: SimRelay, deviceId: string, seq: number) =>
	relay.streams().filter((s) => s !== KEYRING_STREAM).flatMap((s) => relay.rows(s)).filter((r) => r.deviceId === deviceId && r.seq > seq).map((r) => epochOf(r.payload));
const lastK = (relay: SimRelay) => relay.rows(KEYRING_STREAM)[relay.rows(KEYRING_STREAM).length - 1]!.seq;
const k2Of = (d: Dev) => d.changes.flatMap((c) => c.keys).find((k) => k.e === 2)!.k;

async function pair(relay: SimRelay, ...ids: string[]): Promise<Dev[]> {
	const g = await genesis();
	await rawAppend(relay, KEYRING_STREAM, g);
	const devs = await Promise.all(ids.map((id) => start(relay, id, { keys: [{ e: 1, k: K(1) }], records: [g] })));
	for (const d of devs) await live(d);
	return devs;
}

describe("revoke re-seal (§14.2 step 4) in the engine", () => {
	it("frames written under K_1 while a revoke won elsewhere are re-sealed under r before they are sent", async () => {
		const relay = new SimRelay();
		const [x, y0] = await pair(relay, "dev-x", "dev-y");
		let y: Dev | null = null;
		try {
			const id = await x!.engine.createDoc("a.md" as VaultPath, "base");
			await converged([x!.engine, y0!.engine]);
			await y0!.engine.stop();
			relay.setConnectFailure("unavailable");
			y = await start(relay, "dev-y", stored(y0!, { keys: [{ e: 1, k: K(1) }], records: [] }), { storage: y0!.storage, extra: { vaultEpoch: relay.vaultEpoch() } });
			await y.engine.editDoc(id, (t) => t.insert(t.length, " offline"));
			await until(() => y!.engine.c.outbox.all().some((r) => r.keyEpoch === 1), 5_000, "sealed under K_1 offline");
			assert.equal(await x!.engine.revokeRekey(RK_A.slice()), "won");
			const sRot = lastK(relay);
			relay.setConnectFailure(null);
			await until(() => keyMissing(y!) === "revoked-epoch" && y!.engine.status().vaultSeq >= sRot, 8_000, "y read the revoke");
			await new Promise((r) => setTimeout(r, 200));
			assert.deepEqual(rowsPast(relay, "dev-y", sRot), [], "nothing sent under K_1 past S_rot, nothing while key-less");
			assert.equal(await y.engine.installKeyQr(2, k2Of(x!).slice()), "verified");
			await converged([x!.engine, y.engine], 8_000);
			assert.equal(await x!.engine.docText(id), "base offline");
			const ys = rowsPast(relay, "dev-y", sRot);
			assert.ok(ys.length > 0 && ys.every((e) => e === 2), `every y row past S_rot under r: ${ys.join(",")}`);
		} finally {
			await y?.engine.stop();
			await y0!.engine.stop().catch(() => undefined);
			await x!.engine.stop();
		}
	});

	it("own frames that commit past S_rot under K_1 are copied and sent again under r: no edit is lost", async () => {
		const relay = new SimRelay();
		const [x, y] = await pair(relay, "dev-x", "dev-y");
		try {
			const id = await x!.engine.createDoc("a.md" as VaultPath, "base");
			await converged([x!.engine, y!.engine]);
			relay.pauseCommits();
			const won = x!.engine.revokeRekey(RK_A.slice());
			await until(() => relay.pendingCount() === 1, 5_000, "the revoke is in flight");
			await x!.engine.editDoc(id, (t) => t.insert(t.length, " X"));
			await until(() => relay.pendingCount() === 2, 5_000, "x's edit behind it");
			await y!.engine.editDoc(id, (t) => t.insert(0, "Y "));
			await until(() => relay.pendingCount() === 3, 5_000, "y's edit behind it");
			relay.resumeCommits();
			assert.equal(await won, "won");
			const sRot = relay.rows(KEYRING_STREAM)[1]!.seq;
			assert.deepEqual([rowsPast(relay, "dev-x", sRot)[0], rowsPast(relay, "dev-y", sRot)[0]], [1, 1], "both edits committed stale");
			await until(() => rowsPast(relay, "dev-x", sRot).includes(2), 5_000, "x sent its copy under r");
			await until(() => keyMissing(y!) === "revoked-epoch", 5_000, "y read the revoke");
			assert.equal(await y!.engine.installKeyQr(2, k2Of(x!).slice()), "verified");
			await converged([x!.engine, y!.engine], 8_000);
			assert.equal(await x!.engine.docText(id), "Y base X");
			assert.equal(await y!.engine.docText(id), "Y base X");
			assert.ok(rowsPast(relay, "dev-y", sRot).includes(2), "y sent its copy under r");
			assert.equal(x!.engine.status().counts.quarantinedRows + y!.engine.status().counts.quarantinedRows, 0);
		} finally {
			await y!.engine.stop();
			await x!.engine.stop();
		}
	});
});
