/**
 * DESIGN §d.6 "retried on upgrade or new keys" for rows larger than QUARANTINE_ROW_BYTES: a body frame a reader
 * cannot open yet (unknown key after a revoke it has not re-keyed for) is kept whole, so the re-key QR releases it.
 * Found by the E7 suite-1 sim (a ~690 KiB row under keyring-hold stayed frozen forever: truncated to 256 KiB, a
 * re-gate can only fail it). Deterministic failures stay truncated (runtime/quarantine.test.ts). An update above
 * MAX_INLINE_UPDATE_BYTES rides as a small bodyUpdateRef (its bytes in the blob store), never as a large row.
 */
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { QUARANTINE_ROW_BYTES } from "../../core/limits";
import { KEYRING_STREAM, type VaultPath } from "../../core/types";
import { SimRelay } from "../../sim/relay";
import { converged, until } from "../runtime/testHarness";
import { keyMissing, live, rawAppend, start } from "./testkit/engines";
import { K, RK_A, genesis } from "./testkit/world";

/** Incompressible text: base64 of random bytes. */
function noiseText(chars: number): string {
	const raw = new Uint8Array(Math.ceil((chars * 3) / 4));
	for (let i = 0; i < raw.length; i += 65536) globalThis.crypto.getRandomValues(raw.subarray(i, i + 65536));
	return Buffer.from(raw).toString("base64").slice(0, chars);
}

describe("reader-dependent quarantine of a large row (§d.6)", () => {
	it("a body row over QUARANTINE_ROW_BYTES held for an unknown key is released whole by the re-key QR", async () => {
		const relay = new SimRelay();
		const g = await genesis();
		await rawAppend(relay, KEYRING_STREAM, g);
		const [x, y] = await Promise.all(["dev-x", "dev-y"].map((id) => start(relay, id, { keys: [{ e: 1, k: K(1) }], records: [g] })));
		try {
			await live(x!);
			await live(y!);
			assert.equal(await x!.engine.revokeRekey(RK_A.slice()), "won");
			const k2 = x!.changes.flatMap((c) => c.keys).find((k) => k.e === 2)!.k;
			const id = await x!.engine.createDoc("big.md" as VaultPath, "seed;");
			const inline = noiseText(QUARANTINE_ROW_BYTES + 300_000); // one bodyUpdate row, inline
			await x!.engine.editDoc(id, (t) => t.insert(t.length, inline));
			await converged([x!.engine]);
			const text = await x!.engine.docText(id);
			assert.equal(text, "seed;" + inline);
			const head = relay.head();
			await until(() => y!.engine.status().vaultSeq >= head, 10_000, "y read through head");
			const held = (await Promise.all([...y!.engine.c.repo.streams()].map((r) => y!.engine.c.repo.quarantineOf(r.stream)))).flat();
			const big = held.filter((q) => q.originalSize > QUARANTINE_ROW_BYTES);
			assert.ok(big.some((q) => q.stream === x!.engine.streamOf(id)), "the inline body row is held");
			assert.ok(held.every((q) => q.reason === "crypto-unknown-key"), held.map((q) => q.reason).join(","));
			assert.ok(held.every((q) => q.bytes.length === q.originalSize), "reader-dependent rows are kept whole");
			assert.ok(y!.engine.status().counts.frozenDocs > 0);
			assert.equal(await y!.engine.installKeyQr(2, k2.slice()), "verified");
			await until(() => y!.engine.status().counts.frozenDocs === 0, 10_000, "released on the new key");
			await converged([x!.engine, y!.engine]);
			assert.equal(y!.engine.status().counts.quarantinedRows, 0);
			assert.equal(await y!.engine.docText(id), text);
			assert.equal(keyMissing(y!), null);
		} finally {
			await y!.engine.stop();
			await x!.engine.stop();
		}
	});
});
