/**
 * Causal-hole re-reads (DESIGN §d.6) count only reads that ran: while the device has no relay session a retry
 * re-arms without counting, so an offline period longer than the re-read window does not freeze the doc for good.
 */

import assert from "node:assert/strict";
import { test } from "node:test";
import * as Y from "yjs";
import type { ClientFrameId, DeviceId, StreamName, VaultId } from "../../core/types";
import type { RelaySession } from "../../ports/relay";
import { createNoopCrypto } from "../adapters/noopCrypto";
import { createWebHash } from "../adapters/webHash";
import { sealFrame } from "../ingest/envelope";
import { SimRelay } from "../../sim/relay";
import { VirtualClock } from "../../sim/clock";
import { drive, sleep, startTestEngine, until, createDoc, docText } from "./testHarness";

const VAULT = "vault-test" as VaultId;
const noop = createNoopCrypto(createWebHash());

test("causal hole while offline: retries without a session do not count; the reconnect's catch-up fills it, no freeze", async () => {
	// Virtual time: "ten re-read intervals offline" is exact, not a sleep the engine may not have run in.
	const tuning = { causalRetryMs: 40, causalRetries: 2, provisionalAdoptMs: 40 };
	const clock = new VirtualClock();
	const run = <T>(p: Promise<T>): Promise<T> => drive(p, clock);
	const relay = new SimRelay({ clock });
	const { engine: a } = await startTestEngine({ relay, deviceId: "dev-a", tuning, clock });
	const r = await run(relay.connect({ vaultId: VAULT, deviceId: "dev-x" as DeviceId }));
	assert.ok(r.ok);
	const x: RelaySession = r.session;
	let n = 0;
	const send = async (stream: StreamName, content: Uint8Array) => {
		const cf = `rawframe${String(n++).padStart(14, "0")}` as ClientFrameId;
		const sealed = await sealFrame(noop, VAULT, { stream, deviceId: "dev-x" as DeviceId, clientFrameId: cf, kind: "bodyUpdate", authorNsSeq: 0, flags: 0, frameNo: 0, content });
		x.append({ stream, clientFrameId: cf, payload: sealed.sealed });
	};
	try {
		await until(() => a.status().phase === "live", 3_000, "live", clock);
		const id = await run(createDoc(a, "hole.md", "doc;"));
		await until(() => a.isIdle(), 3_000, "idle", clock);
		await run(docText(a, id));
		const stream = a.streamOf(id);
		const src = new Y.Doc();
		const u: Uint8Array[] = [];
		src.on("update", (x2: Uint8Array) => u.push(x2));
		src.getText("text").insert(0, "ab");
		src.getText("text").insert(2, "c"); // u[1] depends on u[0]
		await run(send(stream, u[1]!));
		await until(() => a.c.docs.stats.causalReads >= 1, 3_000, "hole seen, one re-read", clock);
		// a goes offline: every retry from here finds no session.
		relay.setConnectFailure("unavailable");
		relay.dropSession("dev-a" as DeviceId);
		await until(() => a.c.session === null, 3_000, "offline", clock);
		const reads = a.c.docs.stats.causalReads;
		const before = relay.rows(stream).length;
		await run(send(stream, u[0]!)); // the missing row commits while a is away
		await sleep(10 * tuning.causalRetryMs, clock); // ten re-read intervals, far past causalRetries
		// The relay's group commit holds a commit >= minIntervalMs (1000 ms) after the last: u[0] may still be
		// buffered. The scenario is a row that is on the relay when a comes back, so wait for its commit.
		await until(() => relay.rows(stream).length > before, 3_000, "u[0] committed while a is away", clock);
		assert.equal(a.c.repo.stream(stream)!.frozen, 0, "not frozen while it could not read");
		assert.equal(a.c.docs.stats.causalReads, reads, "no re-read counted without a session");
		relay.setConnectFailure(null);
		await until(() => !a.c.docs.causalPending(stream) && a.isIdle(), 5_000, "hole filled after reconnect", clock);
		assert.equal(a.c.repo.stream(stream)!.frozen, 0);
		assert.ok((await run(docText(a, id))).includes("abc"));
	} finally {
		x.close(1000, "done");
		await run(a.stop());
	}
});
