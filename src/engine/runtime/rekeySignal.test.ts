import { test } from "node:test";
import assert from "node:assert/strict";
import type { RelaySession } from "../../ports/relay";
import { RekeySignalState } from "./rekeySignal";

/** A session that only records its acks (the one member RekeySignalState uses). */
type AckSession = Pick<RelaySession, "ackRekey">;
function fakeSession(acks: number[], throws = false): AckSession {
	return {
		ackRekey: (n: number) => {
			if (throws) throw new Error("read-only");
			acks.push(n);
		},
	};
}

function harness() {
	const acks: number[] = [];
	let session: AckSession | null = fakeSession(acks);
	let changes = 0;
	const state = new RekeySignalState(() => session, () => { changes++; });
	return { state, acks, changes: () => changes, setSession: (s: AckSession | null) => { session = s; } };
}

test("RekeySignalState: keeps the latest signal; a status change only when it changed", () => {
	const h = harness();
	assert.equal(h.state.signal, null);
	h.state.note({ removals: 0, rekeyed: 0 });
	h.state.note({ removals: 0, rekeyed: 0 });
	assert.equal(h.changes(), 1, "the same signal on a new session is not a change");
	h.state.note({ removals: 1, rekeyed: 0 });
	assert.deepEqual(h.state.signal, { removals: 1, rekeyed: 0 });
	assert.equal(h.changes(), 2);
	assert.deepEqual(h.acks, [], "nothing owed, nothing sent");
});

test("RekeySignalState: a won revoke owes the count seen at its start, sent at once and on every session until acknowledged", () => {
	const h = harness();
	h.state.note({ removals: 2, rekeyed: 0 });
	h.state.covered(2);
	assert.deepEqual(h.acks, [2]);
	assert.equal(h.state.pendingAck, 2);
	// The socket dropped before the relay took it: no session, nothing sent; the next VAULT_READY sends it again.
	h.setSession(null);
	h.state.covered(2);
	assert.deepEqual(h.acks, [2], "no duplicate debt, no session");
	h.setSession(fakeSession(h.acks));
	h.state.note({ removals: 2, rekeyed: 0 });
	assert.deepEqual(h.acks, [2, 2]);
	// The relay took it: the broadcast clears the debt, and later sessions send nothing.
	h.state.note({ removals: 2, rekeyed: 2 });
	assert.equal(h.state.pendingAck, 0);
	h.state.note({ removals: 3, rekeyed: 2 });
	assert.deepEqual(h.acks, [2, 2], "a later removal is not covered by the earlier roll");
});

test("RekeySignalState: a count already covered, or a lower one than owed, owes nothing new", () => {
	const h = harness();
	h.state.note({ removals: 3, rekeyed: 2 });
	h.state.covered(2);
	h.state.covered(0);
	assert.deepEqual(h.acks, []);
	h.state.covered(3);
	h.state.covered(1);
	assert.deepEqual(h.acks, [3]);
	assert.equal(h.state.pendingAck, 3);
	// Another device covered more meanwhile: the debt is settled by its broadcast too.
	h.state.note({ removals: 4, rekeyed: 4 });
	assert.equal(h.state.pendingAck, 0);
});

test("RekeySignalState: a session that refuses the ack (read-only) does not throw", () => {
	const acks: number[] = [];
	const state = new RekeySignalState(() => fakeSession(acks, true), () => undefined);
	state.note({ removals: 1, rekeyed: 0 });
	assert.doesNotThrow(() => state.covered(1));
	assert.equal(state.pendingAck, 1);
});
